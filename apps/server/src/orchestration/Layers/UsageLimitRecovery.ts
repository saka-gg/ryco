import {
  isProviderAvailable,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  type OrchestrationDispatchCommandError,
  type OrchestrationThreadShell,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
  type ServerSettingsError,
  type ThreadId,
  type ThreadUsageLimit,
} from "@ryco/contracts";
import {
  USAGE_LIMIT_RESUME_MESSAGE,
  applicableUsageLimit,
  usageLimitAutoResumeBlocker,
  usageLimitResetFillCommandId,
  usageLimitResumeIds,
  usageLimitSnoozeCommandId,
} from "@ryco/shared/usageLimit";
import { Cause, Clock, Duration, Effect, Exit, Layer, Option, Schedule } from "effect";

import type { PersistenceSqlError, ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { CompletionReturnRepository } from "../../persistence/Layers/AgentControlCompletionReturns.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { usageLimitStateFromServerRateLimits } from "../../provider/usageLimitReset.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerRuntimeStartup } from "../../serverRuntimeStartup.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { OrchestrationCommandApplication } from "../Services/OrchestrationCommandApplication.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  UsageLimitRecovery,
  type UsageLimitRecoveryShape,
} from "../Services/UsageLimitRecovery.ts";
import { buildThreadContinuationTurnStart } from "../threadContinuation.ts";

/** A reset is only looked up while the limit is recent; later, Resume now is the path. */
const RESET_FILL_WINDOW_MS = 6 * 3_600_000;
/** Snoozing for less than this is not worth hiding the thread. */
const MIN_SNOOZE_MS = 60_000;
/** Transient dispatch failures are retried this often per command id, then given up. */
const MAX_TRANSIENT_ATTEMPTS = 5;
const SWEEP_INTERVAL = Duration.seconds(30);
/** Delegated-return states in which the child's result can still be delivered. */
const OPEN_DELEGATED_RETURN_STATUSES: ReadonlySet<string> = new Set([
  "waiting",
  "ready",
  "dispatching",
]);

export type UsageLimitRecoveryAction =
  | {
      readonly kind: "fill-reset";
      readonly threadId: ThreadId;
      readonly limit: ThreadUsageLimit;
    }
  | {
      readonly kind: "snooze";
      readonly threadId: ThreadId;
      readonly command: Extract<ClientOrchestrationCommand, { type: "thread.snooze" }>;
    }
  | {
      readonly kind: "resume";
      readonly threadId: ThreadId;
      readonly command: Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;
    };

export interface UsageLimitRecoveryCandidate {
  readonly thread: OrchestrationThreadShell;
  /** The thread is a delegated child whose return can no longer be delivered. */
  readonly delegatedReturnTerminal: boolean;
}

/** Pure planner: which fills, snoozes and resumes one sweep should attempt. */
export function planUsageLimitRecovery(input: {
  readonly candidates: ReadonlyArray<UsageLimitRecoveryCandidate>;
  readonly settings: Pick<ServerSettings, "autoResumeLimitedThreads" | "snoozeLimitedThreads">;
  readonly enabledInstanceIds: ReadonlySet<ProviderInstanceId>;
  /** Command ids already settled in this process. */
  readonly attempted: ReadonlySet<string>;
  readonly nowMs: number;
}): ReadonlyArray<UsageLimitRecoveryAction> {
  const actions: UsageLimitRecoveryAction[] = [];
  const filledInstances = new Set<string>();
  const resumedInstances = new Set<string>();
  const limited = input.candidates.flatMap((candidate) => {
    const limit = applicableUsageLimit(candidate.thread);
    return limit === null ? [] : [{ ...candidate, limit }];
  });
  limited.sort(
    (left, right) => Date.parse(left.limit.limitedAt) - Date.parse(right.limit.limitedAt),
  );

  for (const { thread, limit, delegatedReturnTerminal } of limited) {
    const instanceId = limit.providerInstanceId;
    if (limit.resetAt === null) {
      if (
        input.nowMs - Date.parse(limit.limitedAt) < RESET_FILL_WINDOW_MS &&
        !input.attempted.has(usageLimitResetFillCommandId(limit.limitId)) &&
        !filledInstances.has(instanceId)
      ) {
        filledInstances.add(instanceId);
        actions.push({ kind: "fill-reset", threadId: thread.id, limit });
      }
      continue;
    }

    const resetMs = Date.parse(limit.resetAt);
    const snoozeCommandId = usageLimitSnoozeCommandId(limit.limitId, limit.resetAt);
    const snoozedUntilMs = thread.snoozedUntil ? Date.parse(thread.snoozedUntil) : Number.NaN;
    if (
      input.settings.snoozeLimitedThreads &&
      resetMs > input.nowMs + MIN_SNOOZE_MS &&
      !(snoozedUntilMs > input.nowMs) &&
      thread.archivedAt === null &&
      thread.settledOverride !== "settled" &&
      !input.attempted.has(snoozeCommandId)
    ) {
      actions.push({
        kind: "snooze",
        threadId: thread.id,
        command: {
          type: "thread.snooze",
          commandId: snoozeCommandId,
          threadId: thread.id,
          snoozedUntil: limit.resetAt,
        },
      });
    }

    const resumeIds = usageLimitResumeIds(limit.limitId);
    if (
      usageLimitAutoResumeBlocker({
        thread,
        nodeSetting: input.settings.autoResumeLimitedThreads,
        nowMs: input.nowMs,
      }) === null &&
      !delegatedReturnTerminal &&
      input.enabledInstanceIds.has(instanceId) &&
      !input.attempted.has(resumeIds.commandId) &&
      // Limits are account-wide: resume one thread per instance per sweep.
      !resumedInstances.has(instanceId)
    ) {
      resumedInstances.add(instanceId);
      actions.push({
        kind: "resume",
        threadId: thread.id,
        command: buildThreadContinuationTurnStart(thread, {
          ...resumeIds,
          text: USAGE_LIMIT_RESUME_MESSAGE,
          createdAt: new Date(input.nowMs).toISOString(),
          guards: { usageLimitResumeGuard: { limitId: limit.limitId, origin: "auto" } },
        }),
      });
    }
  }
  return actions;
}

/** `E` is the union of the storage and dispatch errors the sweep may hit. */
export interface UsageLimitRecoveryDeps<E> {
  readonly listLimitedThreadIds: () => Effect.Effect<ReadonlyArray<ThreadId>, E>;
  readonly getThreadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, E>;
  /** The delegated-return status for a child thread, if it has a return record. */
  readonly getDelegatedReturnStatus: (threadId: ThreadId) => Effect.Effect<string | undefined, E>;
  readonly getSettings: Effect.Effect<
    Pick<ServerSettings, "autoResumeLimitedThreads" | "snoozeLimitedThreads">,
    E
  >;
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>, E>;
  readonly refreshInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>, E>;
  /** Client commands (snooze, resume) go through normal command application. */
  readonly apply: (
    command: ClientOrchestrationCommand,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
  /** The reset fill is internal-only, so it goes to the engine directly. */
  readonly dispatchInternal: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ readonly sequence: number }, E>;
}

/** A rejection the engine will repeat for the same command: never retry it. */
function isSettledRejection(error: unknown): boolean {
  const cause =
    error !== null && typeof error === "object" && "cause" in error
      ? (error as { readonly cause?: unknown }).cause
      : undefined;
  const tag =
    cause !== null && typeof cause === "object" && "_tag" in cause
      ? (cause as { readonly _tag?: unknown })._tag
      : undefined;
  return (
    tag === "OrchestrationCommandInvariantError" ||
    tag === "OrchestrationCommandPreviouslyRejectedError"
  );
}

export const makeUsageLimitRecovery = <E>(deps: UsageLimitRecoveryDeps<E>) =>
  Effect.sync((): UsageLimitRecoveryShape => {
    const attempted = new Set<string>();
    const transientFailures = new Map<string, number>();

    const settleApply = (
      action: Extract<UsageLimitRecoveryAction, { kind: "snooze" | "resume" }>,
    ) =>
      Effect.gen(function* () {
        const commandId = action.command.commandId;
        const exit = yield* Effect.exit(deps.apply(action.command));
        if (Exit.isSuccess(exit)) {
          attempted.add(commandId);
          transientFailures.delete(commandId);
          return;
        }
        if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt;
        const error = Cause.findErrorOption(exit.cause);
        if (Option.isSome(error) && isSettledRejection(error.value)) {
          attempted.add(commandId);
          transientFailures.delete(commandId);
          yield* Effect.logInfo("usage-limit recovery action rejected", {
            kind: action.kind,
            threadId: action.threadId,
            commandId,
            reason: error.value.message,
          });
          return;
        }
        const failures = (transientFailures.get(commandId) ?? 0) + 1;
        if (failures >= MAX_TRANSIENT_ATTEMPTS) {
          attempted.add(commandId);
          transientFailures.delete(commandId);
          yield* Effect.logWarning("usage-limit recovery action gave up", {
            kind: action.kind,
            threadId: action.threadId,
            commandId,
            cause: Cause.pretty(exit.cause),
          });
          return;
        }
        transientFailures.set(commandId, failures);
      });

    const fillReset = (limit: ThreadUsageLimit, threadId: ThreadId, nowMs: number) =>
      Effect.gen(function* () {
        const commandId = usageLimitResetFillCommandId(limit.limitId);
        // One probe per limit per process, whatever it finds.
        attempted.add(commandId);
        const providers = yield* deps.refreshInstance(limit.providerInstanceId);
        const snapshot = providers.find(
          (provider) => provider.instanceId === limit.providerInstanceId,
        );
        const state = usageLimitStateFromServerRateLimits(snapshot?.rateLimits, nowMs);
        if (
          !state.exhausted ||
          state.resetAt === null ||
          Date.parse(state.resetAt) <= Date.parse(limit.limitedAt)
        ) {
          return;
        }
        yield* deps.dispatchInternal({
          type: "thread.usage-limit.record",
          commandId,
          threadId,
          limitId: limit.limitId,
          provider: limit.provider,
          providerInstanceId: limit.providerInstanceId,
          turnId: limit.turnId,
          message: limit.message,
          resetAt: state.resetAt,
          createdAt: new Date(nowMs).toISOString(),
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logDebug("usage-limit reset lookup failed", {
                threadId,
                limitId: limit.limitId,
                cause: Cause.pretty(cause),
              }),
        ),
      );

    const runSweep = Effect.gen(function* () {
      const threadIds = yield* deps.listLimitedThreadIds();
      if (threadIds.length === 0) return;
      const nowMs = yield* Clock.currentTimeMillis;
      const settings = yield* deps.getSettings;
      const providers = yield* deps.getProviders;
      const enabledInstanceIds = new Set(
        providers
          .filter((provider) => provider.enabled && isProviderAvailable(provider))
          .map((provider) => provider.instanceId),
      );
      const candidates: UsageLimitRecoveryCandidate[] = [];
      for (const threadId of threadIds) {
        const shell = yield* deps.getThreadShell(threadId);
        if (Option.isNone(shell)) continue;
        const returnStatus = yield* deps.getDelegatedReturnStatus(threadId);
        candidates.push({
          thread: shell.value,
          delegatedReturnTerminal:
            returnStatus !== undefined && !OPEN_DELEGATED_RETURN_STATUSES.has(returnStatus),
        });
      }
      const actions = planUsageLimitRecovery({
        candidates,
        settings,
        enabledInstanceIds,
        attempted,
        nowMs,
      });
      for (const action of actions) {
        if (action.kind === "fill-reset") {
          yield* fillReset(action.limit, action.threadId, nowMs);
        } else {
          yield* settleApply(action);
        }
      }
    });

    const sweep: UsageLimitRecoveryShape["sweep"] = () =>
      runSweep.pipe(
        // A defect must never end the loop; only interruption stops it.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("usage-limit recovery sweep failed; retrying", {
                cause: Cause.pretty(cause),
              }),
        ),
      );

    return { sweep };
  });

type UsageLimitRecoveryLiveError =
  | ProjectionRepositoryError
  | PersistenceSqlError
  | ServerSettingsError
  | OrchestrationDispatchError;

const makeUsageLimitRecoveryLive = Effect.gen(function* () {
  const threads = yield* ProjectionThreadRepository;
  const snapshots = yield* ProjectionSnapshotQuery;
  const completionReturns = yield* CompletionReturnRepository;
  const settings = yield* ServerSettingsService;
  const registry = yield* ProviderRegistry;
  const application = yield* OrchestrationCommandApplication;
  const engine = yield* OrchestrationEngineService;
  return yield* makeUsageLimitRecovery<UsageLimitRecoveryLiveError>({
    listLimitedThreadIds: () => threads.listUsageLimitedThreadIds(),
    getThreadShell: (threadId) => snapshots.getThreadShellById(threadId),
    getDelegatedReturnStatus: (threadId) =>
      completionReturns.get(threadId).pipe(Effect.map((record) => record?.status)),
    getSettings: settings.getSettings.pipe(
      Effect.map(({ autoResumeLimitedThreads, snoozeLimitedThreads }) => ({
        autoResumeLimitedThreads,
        snoozeLimitedThreads,
      })),
    ),
    getProviders: registry.getProviders,
    refreshInstance: (instanceId) => registry.refreshInstance(instanceId),
    apply: (command) => application.apply(command),
    dispatchInternal: (command) => engine.dispatch(command),
  });
});

export const UsageLimitRecoveryLive = Layer.effect(
  UsageLimitRecovery,
  Effect.gen(function* () {
    const recovery = yield* makeUsageLimitRecoveryLive;
    const startup = yield* ServerRuntimeStartup;
    yield* Effect.forkScoped(
      startup.awaitCommandReady.pipe(
        Effect.andThen(
          Effect.suspend(() => recovery.sweep()).pipe(
            Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
          ),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("usage-limit recovery did not start", {
                cause: Cause.pretty(cause),
              }),
        ),
      ),
    );
    return recovery;
  }),
);
