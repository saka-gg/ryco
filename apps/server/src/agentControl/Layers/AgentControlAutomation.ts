import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_AUTOMATION_MAX_ACTIVE_PER_PROJECT,
  AGENT_CONTROL_AUTOMATION_MAX_HORIZON_MS,
  AGENT_CONTROL_AUTOMATION_MIN_INTERVAL_MS,
  AGENT_CONTROL_AUTOMATION_PROPOSAL_TTL_MS,
  AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX,
  AGENT_CONTROL_RISK_TAGS,
  AgentControlRequestId,
  type AgentControlAutomation,
  type AgentControlAutomationDefinition,
  type AgentControlAutomationRun,
  type AgentControlAutomationRunStatus,
  type AgentControlProposal,
} from "@ryco/contracts";
import { Duration, Effect, Layer, Option, Schedule, Stream } from "effect";

import { AgentControlAutomationRepository } from "../../persistence/Services/AgentControlAutomations.ts";
import { AgentControlPlanValidationError } from "../Errors.ts";
import {
  AgentControlAutomationService,
  type AgentControlAutomationShape,
  type AgentControlAutomationServiceError,
} from "../Services/AgentControlAutomation.ts";
import { AgentControlPolicy } from "../Services/AgentControlPolicy.ts";
import { AgentControlProposalEvents } from "../Services/AgentControlProposalEvents.ts";
import { AgentControlProposalStore } from "../Services/AgentControlProposalStore.ts";
import { AgentControlExternalIntegrationService } from "../Services/AgentControlExternalIntegration.ts";

const SCHEDULER_INTERVAL_MS = 30_000;
const SCHEDULER_BATCH_LIMIT = 25;
const RECOVERY_BATCH_LIMIT = 100;

const invalid = (
  reason: ConstructorParameters<typeof AgentControlPlanValidationError>[0]["reason"],
  detail: string,
) => Effect.fail(new AgentControlPlanValidationError({ reason, detail }));

const revisionState = (automation: AgentControlAutomation) => ({
  revision: automation.revision,
  definition: automation.definition,
  cancelled: automation.cancelled,
  updatedAt: automation.updatedAt,
});

const nextRunAt = (definition: AgentControlAutomationDefinition): string | null => {
  if (!definition.enabled) return null;
  return definition.schedule.kind === "once"
    ? definition.schedule.runAt
    : definition.schedule.startsAt;
};

const exactState = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const runStatusForProposal = (
  proposal: AgentControlProposal,
): { readonly status: AgentControlAutomationRunStatus; readonly terminal: boolean } | null => {
  switch (proposal.status) {
    case "pending-user-approval":
      return { status: "pending-approval", terminal: false };
    case "approved":
      return { status: "approved", terminal: false };
    case "executing":
      return { status: "executing", terminal: false };
    case "completed":
      return { status: "completed", terminal: true };
    case "failed":
      return { status: "failed", terminal: true };
    case "rejected":
      return { status: "rejected", terminal: true };
    case "expired":
      return { status: "expired", terminal: true };
    case "cancelled":
      return { status: "cancelled", terminal: true };
  }
};

export interface AgentControlAutomationLiveOptions {
  readonly disableBackground?: boolean;
  readonly schedulerIntervalMs?: number;
}

export const makeAgentControlAutomationLive = (options?: AgentControlAutomationLiveOptions) =>
  Layer.effect(
    AgentControlAutomationService,
    Effect.gen(function* () {
      const repository = yield* AgentControlAutomationRepository;
      const proposals = yield* AgentControlProposalStore;
      const proposalEvents = yield* AgentControlProposalEvents;
      const policy = yield* AgentControlPolicy;
      const externalIntegrations = yield* Effect.serviceOption(
        AgentControlExternalIntegrationService,
      );

      const validateDefinition: AgentControlAutomationShape["validateDefinition"] = (
        definition,
        now,
      ) => {
        const nowMs = Date.parse(now);
        const schedule = definition.schedule;
        const firstMs = Date.parse(schedule.kind === "once" ? schedule.runAt : schedule.startsAt);
        const endMs = Date.parse(schedule.kind === "once" ? schedule.runAt : schedule.endsAt);
        if (!Number.isFinite(firstMs) || firstMs <= nowMs) {
          return invalid("schedule-invalid", "The first scheduled run must be in the future.");
        }
        if (endMs < firstMs || endMs > nowMs + AGENT_CONTROL_AUTOMATION_MAX_HORIZON_MS) {
          return invalid(
            "schedule-invalid",
            "The schedule must end at or before the server scheduling horizon.",
          );
        }
        if (
          schedule.kind === "fixed-interval" &&
          schedule.intervalMs < AGENT_CONTROL_AUTOMATION_MIN_INTERVAL_MS
        ) {
          return invalid(
            "schedule-invalid",
            `Recurring intervals must be at least ${AGENT_CONTROL_AUTOMATION_MIN_INTERVAL_MS}ms.`,
          );
        }
        return Effect.void;
      };

      const get: AgentControlAutomationShape["get"] = (automationId, scope) =>
        repository.getAutomation(automationId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => invalid("automation-unavailable", "Automation is unavailable."),
              onSome: (automation) =>
                automation.projectId === scope.projectId &&
                (scope.providerInstanceId === undefined ||
                  automation.providerInstanceId === scope.providerInstanceId)
                  ? Effect.succeed(automation)
                  : invalid("automation-unavailable", "Automation is unavailable."),
            }),
          ),
        );

      const list: AgentControlAutomationShape["list"] = (scope) =>
        repository.listAutomations({
          projectId: scope.projectId,
          ...(scope.providerInstanceId === undefined
            ? {}
            : { providerInstanceId: scope.providerInstanceId }),
          includeDisabled: scope.includeDisabled,
          limit: Math.min(Math.max(1, Math.floor(scope.limit)), 50),
        });

      const listRuns: AgentControlAutomationShape["listRuns"] = (automationId, scope) =>
        get(automationId, scope).pipe(
          Effect.flatMap(() =>
            repository.listRuns({
              automationId,
              limit: Math.min(
                Math.max(1, Math.floor(scope.limit)),
                AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX,
              ),
            }),
          ),
        );

      const validateLifecyclePlan: AgentControlAutomationShape["validateLifecyclePlan"] = (plan) =>
        Effect.gen(function* () {
          if (plan.kind === "createAutomation") {
            yield* validateDefinition(plan.definition, new Date().toISOString());
            const existing = yield* repository.getAutomation(plan.automationId);
            if (Option.isSome(existing)) {
              return yield* invalid("automation-stale", "Automation ID already exists.");
            }
            const active = yield* repository.countActiveAutomations(
              plan.definition.execution.projectId,
            );
            if (
              plan.definition.enabled &&
              active >= AGENT_CONTROL_AUTOMATION_MAX_ACTIVE_PER_PROJECT
            ) {
              return yield* invalid(
                "automation-limit",
                "The project has reached its active automation limit.",
              );
            }
            return;
          }
          const current = yield* repository.getAutomation(plan.automationId);
          if (Option.isNone(current)) {
            return yield* invalid("automation-unavailable", "Automation is unavailable.");
          }
          const expected = plan.kind === "updateAutomation" ? plan.before : plan.expected;
          if (!exactState(revisionState(current.value), expected)) {
            return yield* invalid("automation-stale", "Automation revision changed.");
          }
          if (plan.kind === "updateAutomation") {
            if (current.value.cancelled) {
              return yield* invalid("automation-stale", "Cancelled automations cannot be updated.");
            }
            if (plan.after.execution.projectId !== current.value.projectId) {
              return yield* invalid("automation-stale", "Automation project scope cannot change.");
            }
            yield* validateDefinition(plan.after, new Date().toISOString());
            const wasActive =
              current.value.enabled && !current.value.cancelled && current.value.nextRunAt !== null;
            if (plan.after.enabled && !wasActive) {
              const active = yield* repository.countActiveAutomations(
                plan.after.execution.projectId,
              );
              if (active >= AGENT_CONTROL_AUTOMATION_MAX_ACTIVE_PER_PROJECT) {
                return yield* invalid(
                  "automation-limit",
                  "The project has reached its active automation limit.",
                );
              }
            }
          }
        });

      const cancelPendingRun = (automation: AgentControlAutomation) =>
        repository
          .listRuns({
            automationId: automation.automationId,
            limit: AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX,
          })
          .pipe(
            Effect.flatMap((runs) =>
              Effect.forEach(
                runs.filter(
                  (run) => run.status === "materializing" || run.status === "pending-approval",
                ),
                (run) =>
                  run.proposalId === null
                    ? repository.transitionRun({
                        runId: run.runId,
                        expectedStatuses: ["materializing"],
                        status: "cancelled",
                        proposalId: null,
                        safeFailureDetail: "Schedule changed before run approval.",
                        updatedAt: new Date().toISOString(),
                        completedAt: new Date().toISOString(),
                      })
                    : proposals
                        .decide({
                          proposalId: run.proposalId,
                          decision: "cancelled",
                          actor: "system",
                          decidedAt: new Date().toISOString(),
                        })
                        .pipe(
                          Effect.as(true),
                          Effect.catch(() => Effect.succeed(false)),
                        ),
                { concurrency: 1, discard: true },
              ),
            ),
          );

      const applyLifecycle: AgentControlAutomationShape["applyLifecycle"] = (proposal) =>
        Effect.gen(function* () {
          const plan = proposal.plan;
          if (
            plan.kind !== "createAutomation" &&
            plan.kind !== "updateAutomation" &&
            plan.kind !== "cancelAutomation"
          ) {
            return yield* invalid("invalid-plan", "This is not an automation lifecycle plan.");
          }
          const alreadyApplied = yield* repository.getAutomation(plan.automationId);
          if (Option.isSome(alreadyApplied)) {
            const current = alreadyApplied.value;
            const samePrincipal = exactState(current.principal, proposal.principal);
            if (
              samePrincipal &&
              ((plan.kind === "createAutomation" &&
                current.revision === 1 &&
                exactState(current.definition, plan.definition)) ||
                (plan.kind === "updateAutomation" &&
                  current.revision === plan.before.revision + 1 &&
                  exactState(current.definition, plan.after)) ||
                (plan.kind === "cancelAutomation" &&
                  current.revision === plan.expected.revision + 1 &&
                  current.cancelled))
            ) {
              return current;
            }
          }
          yield* validateLifecyclePlan(plan);
          const now = new Date().toISOString();
          if (plan.kind === "createAutomation") {
            const automation: AgentControlAutomation = {
              automationId: plan.automationId,
              principal: proposal.principal,
              projectId: plan.definition.execution.projectId,
              providerInstanceId: plan.definition.execution.modelSelection.instanceId,
              definition: plan.definition,
              revision: 1,
              enabled: plan.definition.enabled,
              cancelled: false,
              cancelledAt: null,
              nextRunAt: nextRunAt(plan.definition),
              createdAt: now,
              updatedAt: now,
            };
            if (!(yield* repository.insertAutomation(automation))) {
              return yield* invalid("automation-stale", "Automation ID already exists.");
            }
            return automation;
          }
          const current = yield* repository.getAutomation(plan.automationId);
          if (Option.isNone(current)) {
            return yield* invalid("automation-unavailable", "Automation is unavailable.");
          }
          const updated: AgentControlAutomation =
            plan.kind === "updateAutomation"
              ? {
                  ...current.value,
                  principal: proposal.principal,
                  projectId: plan.after.execution.projectId,
                  providerInstanceId: plan.after.execution.modelSelection.instanceId,
                  definition: plan.after,
                  revision: current.value.revision + 1,
                  enabled: plan.after.enabled,
                  nextRunAt: nextRunAt(plan.after),
                  updatedAt: now,
                }
              : {
                  ...current.value,
                  principal: proposal.principal,
                  revision: current.value.revision + 1,
                  enabled: false,
                  cancelled: true,
                  cancelledAt: now,
                  nextRunAt: null,
                  updatedAt: now,
                };
          if (
            !(yield* repository.replaceAutomation({
              automation: updated,
              expectedRevision: current.value.revision,
              expectedCancelled: current.value.cancelled,
            }))
          ) {
            return yield* invalid("automation-stale", "Automation revision changed.");
          }
          yield* cancelPendingRun(updated);
          return updated;
        });

      const validateRun: AgentControlAutomationShape["validateRun"] = (proposal) =>
        Effect.gen(function* () {
          if (proposal.plan.kind !== "automationRun") {
            return yield* invalid("invalid-plan", "This is not an automation run plan.");
          }
          const run = yield* repository.getRun(proposal.plan.runId);
          if (Option.isNone(run) || run.value.proposalId !== proposal.proposalId) {
            return yield* invalid("automation-unavailable", "Automation run is unavailable.");
          }
          if (
            !["pending-approval", "approved", "executing"].some(
              (status) => status === run.value.status,
            )
          ) {
            return yield* invalid("automation-stale", "Automation run is no longer executable.");
          }
          const automation = yield* repository.getAutomation(proposal.plan.automationId);
          if (Option.isNone(automation)) {
            return yield* invalid("automation-unavailable", "Automation is unavailable.");
          }
          const acceptedBeforeDefinitionChanged =
            proposal.decidedAt !== null && proposal.decidedAt <= automation.value.updatedAt;
          if (
            automation.value.revision !== proposal.plan.automationRevision &&
            !acceptedBeforeDefinitionChanged
          ) {
            return yield* invalid(
              "automation-stale",
              "Automation revision changed before approval.",
            );
          }
          if (automation.value.cancelled && !acceptedBeforeDefinitionChanged) {
            return yield* invalid("automation-stale", "Automation was cancelled before approval.");
          }
        });

      const syncRun = (proposal: AgentControlProposal) =>
        Effect.gen(function* () {
          if (proposal.plan.kind !== "automationRun") return;
          const next = runStatusForProposal(proposal);
          if (next === null) return;
          const current = yield* repository.getRun(proposal.plan.runId);
          if (Option.isNone(current) || current.value.proposalId !== proposal.proposalId) return;
          if (current.value.status === next.status) return;
          const now = new Date().toISOString();
          yield* repository.transitionRun({
            runId: current.value.runId,
            expectedStatuses: [current.value.status],
            status: next.status,
            proposalId: proposal.proposalId,
            safeFailureDetail: proposal.status === "failed" ? "Approved run failed safely." : null,
            updatedAt: now,
            completedAt: next.terminal ? now : null,
          });
          if (next.terminal) {
            yield* repository.pruneRuns({
              automationId: current.value.automationId,
              keepNewest: AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX,
            });
          }
        });

      const materialize = (run: AgentControlAutomationRun) =>
        Effect.gen(function* () {
          const automation = yield* repository.getAutomation(run.automationId);
          if (
            Option.isNone(automation) ||
            automation.value.cancelled ||
            automation.value.revision !== run.automationRevision
          ) {
            yield* repository.transitionRun({
              runId: run.runId,
              expectedStatuses: ["materializing"],
              status: "cancelled",
              proposalId: null,
              safeFailureDetail: "Schedule changed before run proposal materialization.",
              updatedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
            });
            return;
          }
          if (automation.value.principal.kind === "external-integration") {
            const authority = Option.isSome(externalIntegrations)
              ? yield* Effect.option(
                  externalIntegrations.value.revalidate(automation.value.principal.integrationId),
                )
              : Option.none();
            const current = Option.getOrUndefined(authority);
            const definition = automation.value.definition;
            const projectAllowed =
              current?.projectScope.kind === "all" ||
              current?.projectScope.projectIds.includes(definition.execution.projectId);
            const executionAllowed =
              (definition.execution.envMode !== "local" ||
                current?.capabilities.includes(
                  AGENT_CONTROL_CAPABILITIES.externalSharedCheckout,
                )) &&
              (definition.execution.runtimeMode !== "full-access" ||
                current?.capabilities.includes(AGENT_CONTROL_CAPABILITIES.externalFullAccess));
            if (
              current === undefined ||
              !projectAllowed ||
              !executionAllowed ||
              !current.capabilities.includes(
                AGENT_CONTROL_CAPABILITIES.externalManageAutomations,
              ) ||
              !current.capabilities.includes(AGENT_CONTROL_CAPABILITIES.externalCreateTask)
            ) {
              const completedAt = new Date().toISOString();
              yield* repository.transitionRun({
                runId: run.runId,
                expectedStatuses: ["materializing"],
                status: "cancelled",
                proposalId: null,
                safeFailureDetail: "External automation authority is no longer available.",
                updatedAt: completedAt,
                completedAt,
              });
              return;
            }
          }
          const now = new Date();
          const submitted = yield* proposals.submit({
            principal: automation.value.principal,
            requestId: AgentControlRequestId.make(`automation-run:${run.runId}`),
            plan: {
              kind: "automationRun",
              automationId: run.automationId,
              runId: run.runId,
              automationRevision: run.automationRevision,
              scheduledFor: run.scheduledFor,
              coalescedOccurrences: run.coalescedOccurrences,
              execution: automation.value.definition.execution,
            },
            riskTags: [
              AGENT_CONTROL_RISK_TAGS.scheduledRun,
              AGENT_CONTROL_RISK_TAGS.createsThreads,
              AGENT_CONTROL_RISK_TAGS.startsProviderTurn,
            ],
            promptSummary: `Scheduled run for ${automation.value.definition.execution.title}`,
            now: now.toISOString(),
            expiresAt: new Date(
              now.getTime() + AGENT_CONTROL_AUTOMATION_PROPOSAL_TTL_MS,
            ).toISOString(),
          });
          const attached = yield* repository.attachProposal({
            runId: run.runId,
            proposalId: submitted.proposal.proposalId,
            updatedAt: new Date().toISOString(),
          });
          if (!attached) {
            // Cancellation/update won between the immutable proposal insert and
            // run attachment. The proposal is made inert immediately; even if
            // this cancellation loses another race, run revalidation still
            // requires the exact persisted proposal/run link.
            yield* proposals
              .decide({
                proposalId: submitted.proposal.proposalId,
                decision: "cancelled",
                actor: "system",
                decidedAt: new Date().toISOString(),
              })
              .pipe(Effect.ignore);
            return;
          }
          yield* syncRun(submitted.proposal);
        });

      const isolateCorruptRun =
        (run: AgentControlAutomationRun) =>
        (
          error: AgentControlAutomationServiceError,
        ): Effect.Effect<void, AgentControlAutomationServiceError> =>
          error._tag === "PersistenceDecodeError"
            ? repository.quarantineRecord({ kind: "run", id: run.runId, projectId: run.projectId })
            : Effect.fail(error);

      const recover = Effect.gen(function* () {
        const runs = yield* repository.listRecoverableRuns({ limit: RECOVERY_BATCH_LIMIT });
        for (const run of runs) {
          yield* Effect.gen(function* () {
            if (run.status === "materializing") {
              yield* materialize(run);
              return;
            }
            if (run.proposalId === null) return;
            const proposal = yield* proposals.getById(run.proposalId);
            if (Option.isSome(proposal)) yield* syncRun(proposal.value);
          }).pipe(Effect.catch(isolateCorruptRun(run)));
        }
      });

      const materializeDue: AgentControlAutomationShape["materializeDue"] = Effect.gen(
        function* () {
          yield* policy.requireEnabled("AgentControlAutomation.materializeDue");
          yield* recover;
          const claimed = yield* repository.claimDue({
            now: new Date().toISOString(),
            limit: SCHEDULER_BATCH_LIMIT,
          });
          for (const item of claimed)
            yield* materialize(item.run).pipe(Effect.catch(isolateCorruptRun(item.run)));
          return claimed.length;
        },
      );

      if (options?.disableBackground !== true) {
        yield* Effect.forkScoped(
          policy.isEnabled.pipe(
            Effect.flatMap((enabled) => (enabled ? recover : Effect.void)),
            Effect.catch((error) =>
              Effect.logWarning("agent-control.automation-recovery-failed", { error }),
            ),
          ),
        );
        yield* Effect.forkScoped(
          policy.isEnabled.pipe(
            // Disabled Agent Control is an idle scheduler state, not a failed
            // scheduling attempt. Keep the lightweight gate check so enabling
            // the feature at runtime takes effect without a server restart.
            Effect.flatMap((enabled) => (enabled ? materializeDue : Effect.void)),
            Effect.catch((error) =>
              Effect.logWarning("agent-control.automation-scheduler-failed", { error }),
            ),
            Effect.repeat(
              Schedule.spaced(
                Duration.millis(options?.schedulerIntervalMs ?? SCHEDULER_INTERVAL_MS),
              ),
            ),
          ),
        );
        yield* Effect.forkScoped(
          proposalEvents.changes.pipe(
            Stream.runForEach((event) =>
              syncRun(event.proposal).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("agent-control.automation-run-sync-failed", { error }),
                ),
              ),
            ),
          ),
        );
      }

      return {
        list,
        get,
        listRuns,
        validateDefinition,
        validateLifecyclePlan,
        applyLifecycle,
        validateRun,
        materializeDue,
        recover,
        reconcileProposal: syncRun,
      } satisfies AgentControlAutomationShape;
    }),
  );

export const AgentControlAutomationServiceLive = makeAgentControlAutomationLive();
