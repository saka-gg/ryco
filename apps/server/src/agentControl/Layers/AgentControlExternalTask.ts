import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_EXTERNAL_PROPOSAL_TTL_MS,
  AGENT_CONTROL_MCP_WAIT_TIMEOUT_MS_DEFAULT,
  AGENT_CONTROL_MCP_WAIT_TIMEOUT_MS_MAX,
  AGENT_CONTROL_RISK_TAGS,
  AGENT_CONTROL_TERMINAL_PROPOSAL_STATUSES,
  AgentControlExternalTaskId,
  type AgentControlExternalTaskResult,
  type AgentControlProposal,
  type AgentControlProposalStatus,
} from "@ryco/contracts";
import { Duration, Effect, Layer, Option, PubSub } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  AgentControlExternalRepository,
  type StoredAgentControlExternalTask,
} from "../../persistence/Services/AgentControlExternal.ts";
import { AgentControlExternalIntegrationError } from "../Errors.ts";
import { computeAgentControlPlanDigest } from "../planDigest.ts";
import { AgentControlActionValidator } from "../Services/AgentControlActionValidator.ts";
import { AgentControlExternalIntegrationService } from "../Services/AgentControlExternalIntegration.ts";
import {
  AgentControlExternalTaskService,
  type AgentControlExternalTaskServiceShape,
} from "../Services/AgentControlExternalTask.ts";
import { AgentControlProposalEvents } from "../Services/AgentControlProposalEvents.ts";
import {
  AgentControlProposalService,
  toAgentControlProposalReceipt,
} from "../Services/AgentControlProposalService.ts";

const fail = (
  reason: ConstructorParameters<typeof AgentControlExternalIntegrationError>[0]["reason"],
) => Effect.fail(new AgentControlExternalIntegrationError({ reason }));

const waitConditionMet = (
  status: AgentControlProposalStatus,
  waitFor: "decided" | "terminal",
): boolean =>
  waitFor === "terminal"
    ? AGENT_CONTROL_TERMINAL_PROPOSAL_STATUSES.includes(status)
    : status !== "pending-user-approval";

const toPublicTask = (task: StoredAgentControlExternalTask) => {
  if (task.proposalId === null) return null;
  return {
    taskId: task.taskId,
    requestId: task.requestId,
    proposalId: task.proposalId,
    projectId: task.projectId,
    providerInstanceId: task.providerInstanceId,
    environment: task.environment,
    runtimeMode: task.runtimeMode,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    releasedAt: task.releasedAt,
  };
};

export interface AgentControlExternalTaskLiveOptions {
  readonly disableBackground?: boolean;
}

export const makeAgentControlExternalTask = (options?: AgentControlExternalTaskLiveOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* AgentControlExternalRepository;
    const integrations = yield* AgentControlExternalIntegrationService;
    const validator = yield* AgentControlActionValidator;
    const proposals = yield* AgentControlProposalService;
    const proposalEvents = yield* AgentControlProposalEvents;

    const releaseIfTerminal = (
      task: StoredAgentControlExternalTask,
      proposal: AgentControlProposal,
    ) =>
      AGENT_CONTROL_TERMINAL_PROPOSAL_STATUSES.includes(proposal.status)
        ? repository
            .releaseTask({
              taskId: task.taskId,
              integrationId: task.integrationId,
              releasedAt: proposal.updatedAt,
            })
            .pipe(
              Effect.flatMap((released) =>
                released
                  ? integrations
                      .appendAudit({
                        integrationId: task.integrationId,
                        tool: "ryco_create_task",
                        requestId: task.requestId,
                        projectId: task.projectId,
                        runtimeMode: task.runtimeMode,
                        environment: task.environment,
                        proposalId: proposal.proposalId,
                        operationId: proposal.result?.execution?.operationId ?? null,
                        threadId: proposal.result?.execution?.affectedThreadIds[0] ?? null,
                        outcome: `terminal:${proposal.status}`,
                      })
                      .pipe(
                        Effect.catch((error) =>
                          Effect.logWarning("External Agent Control terminal audit failed", {
                            error,
                          }),
                        ),
                      )
                  : Effect.void,
              ),
            )
        : Effect.void;

    const readOwned = (
      integrationId: StoredAgentControlExternalTask["integrationId"],
      taskId: StoredAgentControlExternalTask["taskId"],
    ) =>
      repository.getTask(taskId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => fail("task-not-found"),
            onSome: (task) =>
              task.integrationId === integrationId && task.proposalId !== null
                ? Effect.succeed(task)
                : fail("task-not-found"),
          }),
        ),
      );

    const resultFor = (task: StoredAgentControlExternalTask, replayed?: boolean) =>
      Effect.gen(function* () {
        if (task.proposalId === null) return yield* fail("task-not-found");
        const found = yield* proposals.getProposal(task.proposalId);
        if (Option.isNone(found)) return yield* fail("task-not-found");
        yield* releaseIfTerminal(task, found.value);
        const refreshed = yield* repository.getTask(task.taskId);
        const publicTask = toPublicTask(Option.getOrElse(refreshed, () => task));
        if (publicTask === null) return yield* fail("task-not-found");
        return {
          task: publicTask,
          receipt: toAgentControlProposalReceipt(found.value),
          ...(replayed === undefined ? {} : { replayed }),
        } satisfies AgentControlExternalTaskResult;
      });

    const auditTask = (input: {
      readonly task: StoredAgentControlExternalTask;
      readonly proposal: AgentControlProposal;
      readonly outcome: string;
    }) =>
      integrations.appendAudit({
        integrationId: input.task.integrationId,
        tool: "ryco_create_task",
        requestId: input.task.requestId,
        projectId: input.task.projectId,
        runtimeMode: input.task.runtimeMode,
        environment: input.task.environment,
        proposalId: input.proposal.proposalId,
        operationId: input.proposal.result?.execution?.operationId ?? null,
        threadId: input.proposal.result?.execution?.affectedThreadIds[0] ?? null,
        outcome: input.outcome,
      });

    const create: AgentControlExternalTaskServiceShape["create"] = (input) =>
      Effect.gen(function* () {
        const request = input.request;
        const integration = yield* integrations.authorizeTool({
          integrationId: input.integrationId,
          tool: "ryco_create_task",
          requiredCapability: AGENT_CONTROL_CAPABILITIES.externalCreateTask,
          projectId: request.projectId,
        });
        const environment = request.environment ?? "worktree";
        const runtimeMode = request.runtimeMode ?? "approval-required";
        if (
          environment === "local" &&
          !integration.capabilities.includes(AGENT_CONTROL_CAPABILITIES.externalSharedCheckout)
        ) {
          return yield* fail("capability-denied");
        }
        if (
          runtimeMode === "full-access" &&
          !integration.capabilities.includes(AGENT_CONTROL_CAPABILITIES.externalFullAccess)
        ) {
          return yield* fail("capability-denied");
        }
        const plan = {
          kind: "createThreads" as const,
          entries: [
            {
              projectId: request.projectId,
              title: request.title ?? "External task",
              prompt: request.prompt,
              modelSelection: {
                instanceId: request.providerInstanceId,
                model: request.model,
                options: request.options,
              },
              runtimeMode,
              ...(request.tokenMode === undefined ? {} : { tokenMode: request.tokenMode }),
              envMode: environment,
            },
          ],
        };
        const planDigest = computeAgentControlPlanDigest(plan);

        const existing = yield* repository.findTaskByRequest({
          integrationId: input.integrationId,
          requestId: request.requestId,
        });
        if (Option.isSome(existing)) {
          if (existing.value.planDigest !== planDigest) return yield* fail("task-conflict");
          return yield* resultFor(existing.value, true);
        }

        const principal = yield* validator.validateExternalSubmission({ integration, plan });
        const now = new Date();
        const taskId = AgentControlExternalTaskId.make(crypto.randomUUID());
        const task: StoredAgentControlExternalTask = {
          taskId,
          integrationId: input.integrationId,
          requestId: request.requestId,
          planDigest,
          proposalId: null,
          projectId: request.projectId,
          providerInstanceId: request.providerInstanceId,
          environment,
          runtimeMode,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          releasedAt: null,
        };

        const created = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              // Recheck under the write transaction. An idempotent concurrent retry
              // returns the winner and never consumes a second slot.
              const raced = yield* repository.findTaskByRequest({
                integrationId: input.integrationId,
                requestId: request.requestId,
              });
              if (Option.isSome(raced)) {
                if (raced.value.planDigest !== planDigest) return yield* fail("task-conflict");
                return {
                  task: raced.value,
                  proposal: null as AgentControlProposal | null,
                  replayed: true,
                };
              }
              // Credential/scope may have changed while plan validation read provider state.
              const current = yield* integrations.revalidate(input.integrationId);
              const stillInScope =
                current.projectScope.kind === "all" ||
                current.projectScope.projectIds.includes(request.projectId);
              if (
                !stillInScope ||
                !current.capabilities.includes(AGENT_CONTROL_CAPABILITIES.externalCreateTask) ||
                (environment === "local" &&
                  !current.capabilities.includes(
                    AGENT_CONTROL_CAPABILITIES.externalSharedCheckout,
                  )) ||
                (runtimeMode === "full-access" &&
                  !current.capabilities.includes(AGENT_CONTROL_CAPABILITIES.externalFullAccess))
              ) {
                return yield* fail("capability-denied");
              }
              const reserved = yield* repository.reserveCapacity(input.integrationId);
              if (!reserved) return yield* fail("capacity-exhausted");
              const inserted = yield* repository.insertTask(task);
              if (!inserted) return yield* fail("task-conflict");
              const submitted = yield* proposals.submit({
                principal,
                requestId: request.requestId,
                plan,
                riskTags: [
                  AGENT_CONTROL_RISK_TAGS.createsThreads,
                  AGENT_CONTROL_RISK_TAGS.startsProviderTurn,
                  ...(environment === "local" ? [AGENT_CONTROL_RISK_TAGS.sharedLocalCheckout] : []),
                  ...(runtimeMode === "full-access"
                    ? [AGENT_CONTROL_RISK_TAGS.elevatedRuntimeMode]
                    : []),
                ],
                promptSummary: `External integration ${integration.displayName} requested one task`,
                now: now.toISOString(),
                expiresAt: new Date(
                  now.getTime() + AGENT_CONTROL_EXTERNAL_PROPOSAL_TTL_MS,
                ).toISOString(),
              });
              const attached = yield* repository.attachTaskProposal({
                taskId,
                proposalId: submitted.proposal.proposalId,
                updatedAt: now.toISOString(),
              });
              if (!attached) return yield* fail("storage");
              return {
                task: { ...task, proposalId: submitted.proposal.proposalId },
                proposal: submitted.proposal,
                replayed: submitted.replayed,
              };
            }),
          )
          .pipe(Effect.catchTag("SqlError", () => fail("storage")));
        if (created.proposal === null) return yield* resultFor(created.task, true);
        yield* auditTask({
          task: created.task,
          proposal: created.proposal,
          outcome: "pending-approval",
        });
        return yield* resultFor(created.task, created.replayed);
      });

    const read: AgentControlExternalTaskServiceShape["read"] = (input) =>
      Effect.gen(function* () {
        yield* integrations.authorizeTool({
          integrationId: input.integrationId,
          tool: "ryco_read_task",
          requiredCapability: AGENT_CONTROL_CAPABILITIES.externalReadTask,
        });
        const task = yield* readOwned(input.integrationId, input.taskId);
        return yield* resultFor(task);
      });

    const wait: AgentControlExternalTaskServiceShape["wait"] = (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* integrations.authorizeTool({
            integrationId: input.integrationId,
            tool: "ryco_wait_for_task",
            requiredCapability: AGENT_CONTROL_CAPABILITIES.externalReadTask,
          });
          const task = yield* readOwned(input.integrationId, input.request.taskId);
          const waitFor = input.request.waitFor ?? "terminal";
          const requestedTimeout =
            input.request.timeoutMs ?? AGENT_CONTROL_MCP_WAIT_TIMEOUT_MS_DEFAULT;
          const timeoutMs = Math.min(
            Math.max(1, requestedTimeout),
            AGENT_CONTROL_MCP_WAIT_TIMEOUT_MS_MAX,
          );
          const deadline = Date.now() + timeoutMs;
          while (true) {
            // Revalidation every bounded wait slice makes revocation and expiry
            // interrupt a long wait without relying on another proposal event.
            yield* integrations.revalidate(input.integrationId);
            const current = yield* resultFor(task);
            if (waitConditionMet(current.receipt.status, waitFor)) {
              return { ...current, timedOut: false };
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) return { ...current, timedOut: true };
            yield* Effect.sleep(Duration.millis(Math.min(250, remaining)));
          }
        }),
      );

    const recoverCapacity: AgentControlExternalTaskServiceShape["recoverCapacity"] = Effect.gen(
      function* () {
        yield* repository.reconcileCapacity();
        const tasks = yield* repository.listUnreleasedTasks();
        for (const task of tasks) {
          if (task.proposalId === null) {
            yield* repository.releaseTask({
              taskId: task.taskId,
              integrationId: task.integrationId,
              releasedAt: new Date().toISOString(),
            });
            continue;
          }
          const proposal = yield* proposals.getProposal(task.proposalId);
          if (Option.isSome(proposal)) {
            yield* releaseIfTerminal(task, proposal.value);
          } else {
            yield* repository.releaseTask({
              taskId: task.taskId,
              integrationId: task.integrationId,
              releasedAt: new Date().toISOString(),
            });
          }
        }
      },
    );

    yield* recoverCapacity.pipe(
      Effect.catch((error) =>
        Effect.logWarning("External Agent Control capacity recovery failed", { error }),
      ),
    );
    if (options?.disableBackground !== true) {
      const eventSubscription = yield* proposalEvents.subscribe;
      yield* Effect.forkScoped(
        Effect.forever(
          PubSub.take(eventSubscription).pipe(
            Effect.flatMap((event) =>
              repository.findTaskByProposal(event.proposal.proposalId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.void,
                    onSome: (task) => releaseIfTerminal(task, event.proposal),
                  }),
                ),
              ),
            ),
            Effect.catch((error) =>
              Effect.logWarning("External Agent Control task accounting update failed", { error }),
            ),
          ),
        ),
      );
    }

    return { create, read, wait, recoverCapacity } satisfies AgentControlExternalTaskServiceShape;
  });

export const AgentControlExternalTaskServiceLive = Layer.effect(
  AgentControlExternalTaskService,
  makeAgentControlExternalTask(),
);
