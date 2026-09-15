import { createHash } from "node:crypto";
import { Effect, Layer, Option, Schema } from "effect";
import {
  AGENT_CONTROL_AUTOMATION_PROPOSAL_TTL_MS,
  AGENT_CONTROL_RISK_TAGS,
  AgentControlAutomationRunId,
  AgentControlRpcError,
  type AgentControlActionPlan,
  type AgentControlProposal,
  type AutomationCentreRun,
} from "@ryco/contracts";
import { AutomationCentre, type AutomationCentreShape } from "../Services/AutomationCentre.ts";
import { AgentControlAutomationService } from "../Services/AgentControlAutomation.ts";
import { AgentControlActionValidator } from "../Services/AgentControlActionValidator.ts";
import { AgentControlPolicy } from "../Services/AgentControlPolicy.ts";
import { AgentControlProposalService } from "../Services/AgentControlProposalService.ts";
import { AgentControlProposalStore } from "../Services/AgentControlProposalStore.ts";
import { AgentControlAutomationRepository } from "../../persistence/Services/AgentControlAutomations.ts";
import { AgentControlProposalRepository } from "../../persistence/Services/AgentControlProposals.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { computeAgentControlPlanDigest } from "../planDigest.ts";
import { agentControlPrincipalScope } from "../principal.ts";

const conflict = (message: string) =>
  Effect.fail(new AgentControlRpcError({ code: "conflict", message }));
const toError = (error: unknown): AgentControlRpcError => {
  if (Schema.is(AgentControlRpcError)(error)) return error;
  if (typeof error === "object" && error !== null && "_tag" in error) {
    if (error._tag === "AgentControlDisabledError")
      return new AgentControlRpcError({ code: "disabled", message: "Agent Control is disabled." });
    if (
      error._tag === "AgentControlPlanValidationError" &&
      "detail" in error &&
      typeof error.detail === "string"
    )
      return new AgentControlRpcError({ code: "conflict", message: error.detail });
  }
  return new AgentControlRpcError({
    code: "storage",
    message: "Automation data is unavailable. Refresh and try again.",
  });
};

export const AutomationCentreLive = Layer.effect(
  AutomationCentre,
  Effect.gen(function* () {
    const automations = yield* AgentControlAutomationService;
    const repository = yield* AgentControlAutomationRepository;
    const proposals = yield* AgentControlProposalStore;
    const proposalRepository = yield* AgentControlProposalRepository;
    const approvals = yield* AgentControlProposalService;
    const validator = yield* AgentControlActionValidator;
    const policy = yield* AgentControlPolicy;
    const projections = yield* ProjectionSnapshotQuery;

    const checkProject = (
      projectId: Parameters<AutomationCentreShape["snapshot"]>[0]["projectId"],
    ) =>
      Effect.gen(function* () {
        yield* policy.requireEnabled("AutomationCentre");
        const project = yield* projections.getProjectShellById(projectId);
        if (Option.isNone(project)) return yield* conflict("Project is unavailable.");
      });

    const snapshot: AutomationCentreShape["snapshot"] = ({ projectId }) =>
      Effect.gen(function* () {
        yield* checkProject(projectId);
        yield* approvals
          .expireOverdue(new Date().toISOString())
          .pipe(
            Effect.catch((error) =>
              error._tag === "PersistenceDecodeError" ? Effect.void : Effect.fail(error),
            ),
          );
        const definitions = yield* automations.list({
          projectId,
          includeDisabled: true,
          limit: 50,
        });
        const records = yield* repository.listProjectRuns(projectId);
        const runs: AutomationCentreRun[] = [];
        for (const run of records) {
          // A damaged proposal must not hide the other runs. Never return raw decode details.
          const proposal =
            run.proposalId === null
              ? Option.none<AgentControlProposal>()
              : yield* proposals
                  .getById(run.proposalId)
                  .pipe(
                    Effect.catch((error) =>
                      error._tag === "PersistenceDecodeError"
                        ? repository
                            .quarantineRecord({ kind: "proposal", id: run.proposalId!, projectId })
                            .pipe(Effect.as(Option.none<AgentControlProposal>()))
                        : Effect.fail(error),
                    ),
                  );
          const plan =
            Option.isSome(proposal) && proposal.value.plan.kind === "automationRun"
              ? proposal.value.plan
              : null;
          const result = Option.isSome(proposal) ? proposal.value.result : null;
          runs.push({
            run,
            execution: plan?.execution ?? null,
            threadIds: result?.execution?.affectedThreadIds ?? [],
            unread: true,
            retryOfRunId: null,
          });
        }
        const active: AgentControlProposal[] = [];
        for (const proposalId of yield* repository.activeProposalIds()) {
          const proposal = yield* proposals
            .getById(proposalId)
            .pipe(
              Effect.catch((error) =>
                error._tag === "PersistenceDecodeError"
                  ? repository
                      .quarantineRecord({ kind: "proposal", id: proposalId, projectId })
                      .pipe(Effect.as(Option.none<AgentControlProposal>()))
                  : Effect.fail(error),
              ),
            );
          if (Option.isSome(proposal)) active.push(proposal.value);
        }
        const metadata = yield* repository.centreMetadata(projectId);
        const readById = new Map(metadata.runs.map((row) => [row.runId, row]));
        return {
          automations: definitions,
          runs: runs.map((entry) => {
            const state = readById.get(entry.run.runId);
            return {
              ...entry,
              unread: state?.readUpdatedAt !== entry.run.updatedAt,
              retryOfRunId: state?.retryOfRunId
                ? AgentControlAutomationRunId.make(state.retryOfRunId)
                : null,
            };
          }),
          unavailableRecords: metadata.unavailableRecords,
          historyLimit: 50,
          proposals: active.filter((proposal) => {
            const plan = proposal.plan;
            return plan.kind === "createAutomation"
              ? plan.definition.execution.projectId === projectId
              : plan.kind === "updateAutomation"
                ? plan.after.execution.projectId === projectId
                : plan.kind === "cancelAutomation"
                  ? plan.expected.definition.execution.projectId === projectId
                  : plan.kind === "automationRun" && plan.execution.projectId === projectId;
          }),
        };
      }).pipe(Effect.mapError(toError));

    const command: AutomationCentreShape["command"] = (input) =>
      Effect.gen(function* () {
        yield* checkProject(input.projectId);
        if (input.kind === "read" || input.kind === "retry") {
          const source = yield* repository.getRun(input.runId);
          if (Option.isNone(source) || source.value.projectId !== input.projectId)
            return yield* conflict("Run is unavailable.");
          if (input.kind === "read") {
            if (!(yield* repository.markRead(input)))
              return yield* conflict("Run changed. Refresh before marking it read.");
          } else {
            if (!["rejected", "expired", "cancelled"].includes(source.value.status))
              return yield* conflict(
                "Delivery is uncertain for a failed dispatch. Inspect its thread or operation before scheduling new work.",
              );
            if (source.value.proposalId !== null) {
              const original = yield* proposals.getById(source.value.proposalId);
              if (
                Option.isNone(original) ||
                !["rejected", "expired"].includes(original.value.status) ||
                (original.value.result?.execution?.affectedThreadIds.length ?? 0) > 0
              )
                return yield* conflict(
                  "This run may have started work. Open its thread to inspect or stop it before scheduling another task.",
                );
            }
            const current = yield* automations.get(source.value.automationId, {
              projectId: input.projectId,
            });
            if (current.cancelled || current.revision !== source.value.automationRevision)
              return yield* conflict(
                "Schedule changed or was cancelled. Review it before scheduling new work.",
              );
            const runId = AgentControlAutomationRunId.make(
              createHash("sha256")
                .update(JSON.stringify([input.projectId, input.requestId]))
                .digest("hex"),
            );
            if (
              !(yield* repository.retryRun({
                runId,
                source: source.value,
                now: new Date().toISOString(),
              }))
            )
              return yield* conflict(
                "Only an undispatched rejected, expired or cancelled run can be retried, with no active occurrence.",
              );
            // The existing scheduler's recovery materializes this durable occurrence.
            yield* automations.recover;
          }
          return yield* snapshot(input);
        }

        const current =
          input.kind === "save" && input.expectedRevision === null
            ? null
            : yield* automations.get(input.automationId, { projectId: input.projectId });
        const definition = input.kind === "save" ? input.definition : current!.definition;
        if (definition.execution.projectId !== input.projectId)
          return yield* conflict("Project scope cannot change.");
        const principal = {
          kind: "automation-owner" as const,
          projectId: input.projectId,
          runtimeMode: definition.execution.runtimeMode,
          envMode: definition.execution.envMode,
        };
        const replay = yield* proposalRepository.findByRequest({
          principalScope: agentControlPrincipalScope(principal),
          requestId: input.requestId,
        });
        if (Option.isSome(replay)) {
          const old = replay.value.plan;
          const same =
            old.kind === "createAutomation" &&
            input.kind === "save" &&
            input.expectedRevision === null
              ? old.automationId === input.automationId &&
                computeAgentControlPlanDigest({ ...old, definition: input.definition }) ===
                  replay.value.planDigest
              : old.kind === "updateAutomation" && input.kind === "save"
                ? old.automationId === input.automationId &&
                  old.before.revision === input.expectedRevision &&
                  computeAgentControlPlanDigest({ ...old, after: input.definition }) ===
                    replay.value.planDigest
                : old.kind === "cancelAutomation" &&
                  input.kind === "cancel" &&
                  old.automationId === input.automationId &&
                  old.expected.revision === input.expectedRevision;
          if (!same)
            return yield* conflict("Request identity was already used for a different action.");
          return yield* snapshot(input);
        }
        if (current && current.revision !== input.expectedRevision)
          return yield* conflict("Schedule changed. Refresh before saving.");
        const before =
          current === null
            ? null
            : {
                revision: current.revision,
                definition: current.definition,
                cancelled: current.cancelled,
                updatedAt: current.updatedAt,
              };
        const plan: Extract<
          AgentControlActionPlan,
          { kind: "createAutomation" | "updateAutomation" | "cancelAutomation" }
        > =
          input.kind === "cancel"
            ? { kind: "cancelAutomation", automationId: input.automationId, expected: before! }
            : before === null
              ? { kind: "createAutomation", automationId: input.automationId, definition }
              : {
                  kind: "updateAutomation",
                  automationId: input.automationId,
                  before,
                  after: definition,
                };
        yield* validator.validateOwnerAutomation(plan);
        const now = new Date();
        yield* proposals.submit({
          principal,
          requestId: input.requestId,
          plan,
          riskTags: [
            plan.kind === "createAutomation"
              ? AGENT_CONTROL_RISK_TAGS.createsAutomation
              : plan.kind === "cancelAutomation"
                ? AGENT_CONTROL_RISK_TAGS.cancelsAutomation
                : AGENT_CONTROL_RISK_TAGS.modifiesAutomation,
          ],
          promptSummary: definition.execution.title,
          now: now.toISOString(),
          expiresAt: new Date(
            now.getTime() + AGENT_CONTROL_AUTOMATION_PROPOSAL_TTL_MS,
          ).toISOString(),
        });
        return yield* snapshot(input);
      }).pipe(Effect.mapError(toError));
    return { snapshot, command };
  }),
);
