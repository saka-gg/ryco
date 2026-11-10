import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_AUTOMATION_UNATTENDED_FAILURES_MAX,
  AGENT_CONTROL_AUTOMATION_MAX_ACTIVE_PER_PROJECT,
  AGENT_CONTROL_AUTOMATION_MAX_HORIZON_MS,
  AGENT_CONTROL_AUTOMATION_MIN_INTERVAL_MS,
  AGENT_CONTROL_AUTOMATION_PROPOSAL_TTL_MS,
  AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX,
  AgentControlAutomationRunId,
  AgentControlRequestId,
  type AgentControlAutomation,
  type AgentControlAutomationDefinition,
  type AgentControlAutomationRun,
  type AgentControlAutomationRunStatus,
  type AgentControlProposal,
} from "@ryco/contracts";
import { Duration, Effect, Layer, Option, Queue, Stream } from "effect";

import { isActiveAutomation } from "../../persistence/Layers/AgentControlAutomations.ts";
import { AgentControlAutomationRepository } from "../../persistence/Services/AgentControlAutomations.ts";
import { AutomationHookStore } from "../../automationHooks/Services/AutomationHookStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AgentControlPlanValidationError } from "../Errors.ts";
import {
  AgentControlAutomationService,
  UNATTENDED_OWNER_ONLY,
  WEBHOOK_OWNER_ONLY,
  planAddsWebhookTrigger,
  type AgentControlAutomationShape,
  type AgentControlAutomationServiceError,
} from "../Services/AgentControlAutomation.ts";
import { AgentControlPolicy } from "../Services/AgentControlPolicy.ts";
import { AgentControlProposalEvents } from "../Services/AgentControlProposalEvents.ts";
import { AgentControlProposalStore } from "../Services/AgentControlProposalStore.ts";
import { AgentControlExternalIntegrationService } from "../Services/AgentControlExternalIntegration.ts";
import { agentControlRiskTagsForPlan } from "../proposalPresentation.ts";

/**
 * The scheduler sleeps until the next schedule is due (`nextSchedulerSleepMs`) and wakes early on
 * a lifecycle change, a run's proposal event or a settings change. This is its longest sleep: the
 * safety net for runs recovery retries, and for anything else that changes what is due.
 */
const SCHEDULER_MAX_SLEEP_MS = 10 * 60_000;
/** A schedule that stays due after a pass that claimed nothing is retried this often. */
const SCHEDULER_RETRY_MS = 30_000;
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

/** Calendar schedule rules, loaded the first time one is checked so they stay off boot. */
const loadCalendarSchedules = Effect.promise(() => import("../calendarSchedules.ts"));

/** The first run: a calendar schedule's first time at or after its start. */
const firstRunAt = (
  schedule: AgentControlAutomationDefinition["schedule"],
): Effect.Effect<string | null> =>
  schedule.kind === "calendar"
    ? loadCalendarSchedules.pipe(Effect.map((calendar) => calendar.firstCalendarRun(schedule)))
    : schedule.kind === "webhook"
      ? // Runs when its webhook is called: never due.
        Effect.succeed(null)
      : Effect.succeed(schedule.kind === "once" ? schedule.runAt : schedule.startsAt);

const nextRunAt = (definition: AgentControlAutomationDefinition) =>
  definition.enabled ? firstRunAt(definition.schedule) : Effect.succeed(null);

const exactState = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * Whether the schedule's runs are approved on its owner's standing decision: the owner
 * set it (an agent-authored definition never runs unattended, whatever it says).
 */
export const runsWithoutAsking = (
  automation: Pick<AgentControlAutomation, "principal" | "definition">,
): boolean =>
  automation.principal.kind === "automation-owner" &&
  automation.definition.runPolicy === "run-without-asking";

const UNATTENDED_PAUSE_DETAIL = `Paused after ${AGENT_CONTROL_AUTOMATION_UNATTENDED_FAILURES_MAX} failed runs in a row. Open the schedule to review it.`;

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

/**
 * How long the scheduler may sleep after a pass at `nowMs`: until `nextDueAt`, at once when the
 * pass claimed a full batch and more is due, `SCHEDULER_RETRY_MS` when something stays due that
 * the pass could not claim (or recovery has a run to retry), at most `maxMs`.
 */
export const nextSchedulerSleepMs = (input: {
  readonly nowMs: number;
  readonly nextDueAt: string | null;
  readonly claimed: number;
  readonly retry: boolean;
  readonly maxMs: number;
}): number => {
  const retryMs = Math.min(SCHEDULER_RETRY_MS, input.maxMs);
  const dueMs = input.nextDueAt === null ? Number.NaN : Date.parse(input.nextDueAt);
  let sleepMs = input.retry ? retryMs : input.maxMs;
  if (Number.isFinite(dueMs)) {
    sleepMs = Math.min(
      sleepMs,
      dueMs > input.nowMs ? dueMs - input.nowMs : input.claimed > 0 ? 0 : retryMs,
    );
  }
  return Math.max(0, sleepMs);
};

export interface AgentControlAutomationLiveOptions {
  readonly disableBackground?: boolean;
  /** The scheduler's longest sleep (default 10 minutes). */
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
      // Webhook schedules' hooks follow their definitions; optional so tests without hooks run.
      const hookStore = yield* Effect.serviceOption(AutomationHookStore);
      // Optional so tests without settings run; enabling Agent Control wakes the scheduler.
      const serverSettings = yield* Effect.serviceOption(ServerSettingsService);
      const schedulerWake = yield* Queue.sliding<void>(1);
      const wakeScheduler = Queue.offer(schedulerWake, undefined).pipe(Effect.asVoid);
      /**
       * Keeps the automation's hook in step after a lifecycle change. A failure leaves the change
       * applied: the owner's next read of the hook creates a missing one.
       */
      const syncHook = (automation: AgentControlAutomation) =>
        Option.isNone(hookStore)
          ? Effect.void
          : hookStore.value.reconcile(automation).pipe(
              Effect.asVoid,
              Effect.catch((error) =>
                Effect.logWarning("agent-control.automation-hook-sync-failed", {
                  automationId: automation.automationId,
                  error: error.message,
                }),
              ),
            );

      const validateDefinition: AgentControlAutomationShape["validateDefinition"] = (
        definition,
        now,
      ) =>
        Effect.gen(function* () {
          const nowMs = Date.parse(now);
          const schedule = definition.schedule;
          // No times to check: it runs when its webhook is called.
          if (schedule.kind === "webhook") return;
          if (schedule.kind === "calendar") {
            const problem = (yield* loadCalendarSchedules).calendarScheduleProblem(schedule);
            if (problem !== null) return yield* invalid("schedule-invalid", problem);
          }
          const firstMs = Date.parse((yield* firstRunAt(schedule)) ?? "");
          const endMs = Date.parse(schedule.kind === "once" ? schedule.runAt : schedule.endsAt);
          if (!Number.isFinite(firstMs) || firstMs <= nowMs) {
            return yield* invalid(
              "schedule-invalid",
              "The first scheduled run must be in the future.",
            );
          }
          if (endMs < firstMs || endMs > nowMs + AGENT_CONTROL_AUTOMATION_MAX_HORIZON_MS) {
            return yield* invalid(
              "schedule-invalid",
              "The schedule must end at or before the server scheduling horizon.",
            );
          }
          if (
            schedule.kind === "fixed-interval" &&
            schedule.intervalMs < AGENT_CONTROL_AUTOMATION_MIN_INTERVAL_MS
          ) {
            return yield* invalid(
              "schedule-invalid",
              `Recurring intervals must be at least ${AGENT_CONTROL_AUTOMATION_MIN_INTERVAL_MS}ms.`,
            );
          }
        });

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
            const wasActive = isActiveAutomation(current.value);
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
              yield* syncHook(current);
              return current;
            }
          }
          yield* validateLifecyclePlan(plan);
          const proposed =
            plan.kind === "createAutomation"
              ? plan.definition
              : plan.kind === "updateAutomation"
                ? plan.after
                : null;
          if (
            proposed?.runPolicy === "run-without-asking" &&
            proposal.principal.kind !== "automation-owner"
          ) {
            return yield* invalid("privilege-escalation", UNATTENDED_OWNER_ONLY);
          }
          if (planAddsWebhookTrigger(plan) && proposal.principal.kind !== "automation-owner") {
            return yield* invalid("privilege-escalation", WEBHOOK_OWNER_ONLY);
          }
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
              nextRunAt: yield* nextRunAt(plan.definition),
              createdAt: now,
              updatedAt: now,
            };
            if (!(yield* repository.insertAutomation(automation))) {
              return yield* invalid("automation-stale", "Automation ID already exists.");
            }
            yield* syncHook(automation);
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
                  nextRunAt: yield* nextRunAt(plan.after),
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
          yield* syncHook(updated);
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
          if (next.status === "failed") yield* pauseAfterFailures(current.value.automationId);
        });

      /**
       * A schedule that runs without asking stops after its last runs all failed: nobody
       * watches it, so it must not keep failing. It is disabled (a new revision; the owner
       * turns it on again), never cancelled. A schedule that asks first needs no pause:
       * every run already waits for a person.
       */
      const pauseAfterFailures = (automationId: AgentControlAutomation["automationId"]) =>
        Effect.gen(function* () {
          const found = yield* repository.getAutomation(automationId);
          if (Option.isNone(found)) return;
          const automation = found.value;
          if (!runsWithoutAsking(automation) || !automation.enabled || automation.cancelled) return;
          const recent = yield* repository.listRuns({
            automationId,
            limit: AGENT_CONTROL_AUTOMATION_UNATTENDED_FAILURES_MAX,
          });
          if (
            recent.length < AGENT_CONTROL_AUTOMATION_UNATTENDED_FAILURES_MAX ||
            recent.some((run) => run.status !== "failed")
          )
            return;
          const now = new Date().toISOString();
          const paused = yield* repository.replaceAutomation({
            automation: {
              ...automation,
              definition: { ...automation.definition, enabled: false },
              revision: automation.revision + 1,
              enabled: false,
              nextRunAt: null,
              updatedAt: now,
            },
            expectedRevision: automation.revision,
            expectedCancelled: false,
          });
          if (!paused) return;
          // A paused webhook schedule leaves the Hub's list.
          if (Option.isSome(hookStore)) hookStore.value.notifyChanged();
          yield* repository.transitionRun({
            runId: recent[0]!.runId,
            expectedStatuses: ["failed"],
            status: "failed",
            proposalId: recent[0]!.proposalId,
            safeFailureDetail: UNATTENDED_PAUSE_DETAIL,
            updatedAt: now,
            completedAt: recent[0]!.completedAt ?? now,
          });
          yield* Effect.logWarning("agent-control.automation-paused-after-failures", {
            automationId,
          });
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
                current?.capabilities.includes(AGENT_CONTROL_CAPABILITIES.externalFullAccess)) &&
              // A heartbeat queues into an existing chat: thread control.
              (definition.execution.target === undefined ||
                current?.capabilities.includes(AGENT_CONTROL_CAPABILITIES.externalControlThreads));
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
          // A run a webhook request started carries the request in its prompt.
          const triggeredPrompt = Option.getOrUndefined(
            yield* repository.getTriggeredPrompt(run.runId),
          );
          const execution =
            triggeredPrompt === undefined
              ? automation.value.definition.execution
              : { ...automation.value.definition.execution, prompt: triggeredPrompt };
          const plan = {
            kind: "automationRun" as const,
            automationId: run.automationId,
            runId: run.runId,
            automationRevision: run.automationRevision,
            scheduledFor: run.scheduledFor,
            coalescedOccurrences: run.coalescedOccurrences,
            execution,
          };
          const submitted = yield* proposals.submit({
            principal: automation.value.principal,
            requestId: AgentControlRequestId.make(`automation-run:${run.runId}`),
            plan,
            // A heartbeat's run queues into its chat and creates none.
            riskTags: agentControlRiskTagsForPlan(plan),
            promptSummary: `${triggeredPrompt === undefined ? "Scheduled" : "Webhook"} run for ${execution.title}${
              execution.target === undefined
                ? ""
                : `, queued in thread ${execution.target.threadId}`
            }`,
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
          if (attached && runsWithoutAsking(automation.value)) {
            // The owner approved this schedule to run without asking: this run is approved
            // on that standing decision. Execution revalidates the run against the current
            // definition, so a schedule changed since runs nothing it did not approve.
            const approved = yield* proposals
              .decide({
                proposalId: submitted.proposal.proposalId,
                decision: "approved",
                actor: "standing-approval",
                decidedAt: new Date().toISOString(),
              })
              .pipe(Effect.option);
            if (Option.isSome(approved)) {
              yield* syncRun(approved.value);
              return;
            }
          }
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

      const triggerWebhookRun: AgentControlAutomationShape["triggerWebhookRun"] = (input) =>
        Effect.gen(function* () {
          if (!(yield* policy.isEnabled)) return "not-accepting" as const;
          const found = yield* repository.getAutomation(input.automationId);
          if (Option.isNone(found)) return "not-accepting" as const;
          const automation = found.value;
          if (
            automation.cancelled ||
            !automation.enabled ||
            automation.definition.schedule.kind !== "webhook"
          ) {
            return "not-accepting" as const;
          }
          const now = new Date().toISOString();
          const run: AgentControlAutomationRun = {
            runId: AgentControlAutomationRunId.make(crypto.randomUUID()),
            automationId: automation.automationId,
            automationRevision: automation.revision,
            projectId: automation.projectId,
            providerInstanceId: automation.providerInstanceId,
            scheduledFor: input.receivedAt,
            coalescedOccurrences: 0,
            status: "materializing",
            proposalId: null,
            safeFailureDetail: null,
            createdAt: now,
            updatedAt: now,
            completedAt: null,
          };
          // One run of a schedule at a time: the runs table holds at most one that is still
          // materializing, waiting for approval, approved or executing.
          const inFlight = (yield* repository.listRuns({
            automationId: automation.automationId,
            limit: AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX,
          })).some((existing) =>
            ["materializing", "pending-approval", "approved", "executing"].includes(
              existing.status,
            ),
          );
          if (inFlight || !(yield* repository.insertTriggeredRun({ run, prompt: input.prompt }))) {
            return "busy" as const;
          }
          // Exactly the timed path: an approval request, or approved at once for a schedule
          // that runs without asking.
          yield* materialize(run).pipe(Effect.catch(isolateCorruptRun(run)));
          const after = yield* repository.getRun(run.runId);
          const status = Option.isSome(after) ? after.value.status : "cancelled";
          return status === "pending-approval"
            ? ("awaiting-approval" as const)
            : status === "materializing" || status === "cancelled"
              ? ("not-accepting" as const)
              : ("started" as const);
        });

      if (options?.disableBackground !== true) {
        yield* Effect.forkScoped(
          policy.isEnabled.pipe(
            Effect.flatMap((enabled) => (enabled ? recover : Effect.void)),
            Effect.catch((error) =>
              Effect.logWarning("agent-control.automation-recovery-failed", { error }),
            ),
          ),
        );
        const maxSleepMs = options?.schedulerIntervalMs ?? SCHEDULER_MAX_SLEEP_MS;
        // One pass, then how long to sleep. Disabled Agent Control is an idle scheduler state,
        // not a failed scheduling attempt: a settings change wakes it.
        const schedulerPass = Effect.gen(function* () {
          if (!(yield* policy.isEnabled)) return maxSleepMs;
          const claimed = yield* materializeDue;
          const nextDueAt =
            repository.nextDueAt === undefined ? null : yield* repository.nextDueAt();
          const retry =
            repository.nextDueAt === undefined ||
            (yield* repository.listRecoverableRuns({ limit: RECOVERY_BATCH_LIMIT })).some(
              (run) => run.status === "materializing",
            );
          return nextSchedulerSleepMs({
            nowMs: Date.now(),
            nextDueAt,
            claimed,
            retry,
            maxMs: maxSleepMs,
          });
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("agent-control.automation-scheduler-failed", { error }).pipe(
              Effect.as(Math.min(SCHEDULER_RETRY_MS, maxSleepMs)),
            ),
          ),
        );
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              const sleepMs = yield* schedulerPass;
              yield* Effect.raceFirst(
                Effect.sleep(Duration.millis(sleepMs)),
                Queue.take(schedulerWake),
              );
            }),
          ),
        );
        if (Option.isSome(serverSettings)) {
          yield* Effect.forkScoped(
            serverSettings.value.streamChanges.pipe(Stream.runForEach(() => wakeScheduler)),
          );
        }
        yield* Effect.forkScoped(
          proposalEvents.changes.pipe(
            Stream.runForEach((event) =>
              syncRun(event.proposal).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("agent-control.automation-run-sync-failed", { error }),
                ),
                // A schedule's definition or its run changed: what is due may have too.
                Effect.andThen(wakeScheduler),
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
        applyLifecycle: (proposal) => applyLifecycle(proposal).pipe(Effect.ensuring(wakeScheduler)),
        validateRun,
        materializeDue,
        recover,
        reconcileProposal: syncRun,
        triggerWebhookRun,
      } satisfies AgentControlAutomationShape;
    }),
  );

export const AgentControlAutomationServiceLive = makeAgentControlAutomationLive();
