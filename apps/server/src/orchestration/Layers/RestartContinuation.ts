/**
 * RestartContinuationLive - captures what a server restart cut off, publishes the
 * background-work boundary and notes, and sends the opt-in automatic continuation.
 *
 * Exactly once: rows are keyed by (thread, source turn) and leave `pending` once; the
 * turn start uses a deterministic command id, so the receipt is checked before any
 * re-dispatch; and the decider re-checks the thread against the captured fence.
 *
 * @module RestartContinuationLive
 */
import {
  CommandId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ThreadId,
  type TurnId,
} from "@ryco/contracts";
import { BACKGROUND_WORK_BOUNDARY, deriveBackgroundWork } from "@ryco/shared/backgroundWork";
import { assessClaudeCacheResume } from "@ryco/shared/claudeCacheReview";
import { latestIsoTimestamp } from "@ryco/shared/turnFinalization";
import { applicableUsageLimit } from "@ryco/shared/usageLimit";
import { Cause, Clock, Effect, Exit, Layer, Option, Schedule } from "effect";

import {
  CompletionReturnRepository,
  isPendingCompletionReturn,
} from "../../persistence/Layers/AgentControlCompletionReturns.ts";
import {
  RestartContinuationRepository,
  type RestartBackgroundWorkRecord,
  type RestartContinuationRecord,
  type StoredRestartContinuation,
} from "../../persistence/Layers/RestartContinuations.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProviderEffectIntentRepository } from "../../persistence/Services/ProviderEffectIntents.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  NO_RESTART_SIGNALS,
  RESTART_BACKGROUND_WORK_STOPPED_KIND,
  RESTART_CAPTURE_MAX_THREADS,
  RESTART_CONTINUATION_FAILED_KIND,
  RESTART_CONTINUATION_MAX_AGE_MS,
  RESTART_CONTINUATION_SKIPPED_KIND,
  RESTART_CONTINUATIONS_PER_INSTANCE,
  RESTART_NOTE_MAX_ENTRIES,
  classifyRestartCandidate,
  hasRestartBackgroundWork,
  restartCandidateShape,
  restartContinuationGuardOf,
  restartContinuationIds,
  restartContinuationPrompt,
  restartContinuationTargetBlocker,
  restartFailureNotice,
  restartFenceUserMessageId,
  restartSkipNotice,
  type RestartCandidateShape,
  type RestartFailureReason,
  type RestartNotice,
  type RestartShutdownHint,
  type RestartSkipReason,
} from "../restartContinuationPolicy.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  RestartContinuation,
  type CapturedRestartThread,
  type RestartContinuationShape,
} from "../Services/RestartContinuation.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import { buildRestartContinuationTurnStart } from "../threadContinuation.ts";

/** Settled rows are kept this long for diagnostics, then pruned at capture. */
const SETTLED_RETENTION_MS = 30 * 24 * 3_600_000;
/** Pending rows read per dispatch page, and the page bound of one dispatch pass. */
const DISPATCH_PAGE_SIZE = 100;
const DISPATCH_MAX_PAGES = 50;
const CAPTURE_WINDOW_LIMITS = { messages: 1, activities: 50, proposedPlans: 1, checkpoints: 1 };
const CLAUDE_REVIEW_WINDOW_LIMITS = {
  messages: 1,
  activities: 40,
  proposedPlans: 1,
  checkpoints: 1,
};

const EMPTY_BACKGROUND_WORK: RestartBackgroundWorkRecord = {
  tasks: [],
  omitted: 0,
  detailsOmitted: false,
};

export interface RestartContinuationOptions {
  /**
   * Test seam: dispatch without the pre-check so the decider fence alone decides the
   * race. Never set in production.
   */
  readonly skipDispatchPreCheck?: boolean;
}

/** Logs and swallows everything but interrupts. */
const logFailure =
  (message: string, annotations: Record<string, unknown> = {}) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | undefined, never, R> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.logWarning(message, { ...annotations, cause: Cause.pretty(cause) }).pipe(
              Effect.as(undefined),
            ),
      ),
    );

function isSettledRejection(cause: Cause.Cause<unknown>): boolean {
  const error = Cause.findErrorOption(cause);
  if (Option.isNone(error)) return false;
  const tag =
    typeof error.value === "object" && error.value !== null && "_tag" in error.value
      ? (error.value as { readonly _tag?: unknown })._tag
      : undefined;
  return (
    tag === "OrchestrationCommandInvariantError" ||
    tag === "OrchestrationCommandPreviouslyRejectedError"
  );
}

function compactBackgroundWork(
  work: ReturnType<typeof deriveBackgroundWork>,
): RestartBackgroundWorkRecord {
  return {
    tasks: work.tasks
      .slice(0, RESTART_NOTE_MAX_ENTRIES)
      .map((task) => ({ id: task.id, title: task.title })),
    omitted: Math.max(0, work.tasks.length - RESTART_NOTE_MAX_ENTRIES),
    detailsOmitted: work.detailsOmitted,
  };
}

/** The latest moment the thread's work was observed alive (crash path). */
function observedAt(thread: OrchestrationThread, window: OrchestrationThread | null): string {
  return latestIsoTimestamp(
    thread.session?.updatedAt ?? thread.updatedAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    ...(window?.activities ?? []).map((activity) => activity.createdAt),
    ...(window?.messages ?? []).map((message) => message.updatedAt),
  );
}

export const makeRestartContinuation = (options: RestartContinuationOptions = {}) =>
  Effect.gen(function* () {
    const repository = yield* RestartContinuationRepository;
    const snapshots = yield* ProjectionSnapshotQuery;
    const directory = yield* ProviderSessionDirectory;
    const completionReturns = yield* CompletionReturnRepository;
    const engine = yield* OrchestrationEngineService;
    const receipts = yield* OrchestrationCommandReceiptRepository;
    const serverSettings = yield* ServerSettingsService;
    const liveness = yield* ThreadBackgroundLiveness.ThreadBackgroundLivenessService;
    const intents = yield* ProviderEffectIntentRepository;

    const nowIso = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()));

    /** A failed settings read is treated as the setting being off. */
    const continuationEnabled = serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.continueThreadsAfterRestart),
      logFailure("restart continuation could not read settings; treating it as disabled"),
      Effect.map((enabled) => enabled === true),
    );

    const readWindow = (threadId: ThreadId, limits: typeof CAPTURE_WINDOW_LIMITS) => {
      const getThreadWindow = snapshots.getThreadWindow;
      if (getThreadWindow === undefined) return Effect.succeed(null);
      return getThreadWindow({ threadId, limits }).pipe(Effect.map((window) => window.thread));
    };

    const appendActivity = (input: {
      readonly threadId: ThreadId;
      readonly commandId: CommandId;
      readonly activity: OrchestrationThreadActivity;
    }) =>
      Effect.suspend(() =>
        engine.dispatch({
          type: "thread.activity.append",
          commandId: input.commandId,
          threadId: input.threadId,
          activity: input.activity,
          createdAt: input.activity.createdAt,
        }),
      ).pipe(
        Effect.retry(Schedule.recurs(1)),
        logFailure("restart continuation activity append failed", {
          threadId: input.threadId,
          kind: input.activity.kind,
        }),
        Effect.asVoid,
      );

    const appendNotice = (
      threadId: ThreadId,
      sourceTurnId: TurnId,
      kind: string,
      reason: string,
      notice: RestartNotice | null,
    ) =>
      Effect.gen(function* () {
        if (notice === null) return;
        const ids = restartContinuationIds(threadId, sourceTurnId);
        yield* appendActivity({
          threadId,
          commandId: ids.noticeCommandId,
          activity: {
            id: ids.noticeActivityId,
            kind,
            tone: notice.tone,
            summary: notice.summary,
            payload: { schemaVersion: 1, reason },
            turnId: sourceTurnId,
            createdAt: yield* nowIso,
          },
        });
      });

    // ── capture ────────────────────────────────────────────────────────────

    const captureCandidate = (input: {
      readonly thread: OrchestrationThread;
      readonly shape: RestartCandidateShape;
      readonly hint: RestartShutdownHint | undefined;
      readonly settingEnabled: boolean;
      readonly overCapacity: boolean;
      readonly capturedAt: string;
    }) =>
      Effect.gen(function* () {
        const { thread, shape } = input;
        const session = thread.session!;
        const existing = yield* repository.get({
          threadId: thread.id,
          sourceTurnId: shape.sourceTurnId,
        });
        // An existing row wins: a crash during reconcile must not re-classify the turn.
        if (Option.isSome(existing)) return capturedFromStored(existing.value);

        let window: OrchestrationThread | null = null;
        let backgroundWork = EMPTY_BACKGROUND_WORK;
        if (!input.overCapacity) {
          window = yield* readWindow(thread.id, CAPTURE_WINDOW_LIMITS).pipe(
            logFailure("restart capture could not read the thread window", {
              threadId: thread.id,
            }),
            Effect.map((value) => value ?? null),
          );
          if (window !== null) {
            backgroundWork = compactBackgroundWork(
              deriveBackgroundWork(window.activities, session.runtimeSessionId),
            );
          }
        }
        if (shape.kind === "background-only" && !hasRestartBackgroundWork(backgroundWork)) {
          return null;
        }

        const enabled = input.settingEnabled;
        // A failed check reads as undefined and fails closed in the classifier, so the row
        // (and its background-work boundary and note) is still recorded.
        const check = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            logFailure(`restart capture could not read ${name}`, { threadId: thread.id }),
          );
        const classification = input.overCapacity
          ? ({
              status: "skipped",
              reason: enabled ? "capacity" : "disabled",
            } as const)
          : classifyRestartCandidate({
              thread,
              shape,
              settingEnabled: enabled,
              signals: enabled
                ? yield* check(
                    "the source turn signals",
                    repository.sourceTurnSignals({
                      threadId: thread.id,
                      turnId: shape.sourceTurnId,
                      turnMessageId: thread.latestTurn?.userMessageId ?? null,
                    }),
                  )
                : NO_RESTART_SIGNALS,
              pendingDelegatedReturn: enabled
                ? yield* check(
                    "the delegated return",
                    completionReturns
                      .get(thread.id)
                      .pipe(
                        Effect.map((record) =>
                          record === undefined ? false : isPendingCompletionReturn(record),
                        ),
                      ),
                  )
                : false,
              usageLimited: applicableUsageLimit(thread) !== null,
              resumable: enabled
                ? yield* check(
                    "the provider binding",
                    directory.getBinding(thread.id).pipe(
                      Effect.map((binding) =>
                        Option.match(binding, {
                          onNone: () => false,
                          onSome: (value) =>
                            value.resumeCursor !== undefined &&
                            value.resumeCursor !== null &&
                            value.providerInstanceId === thread.modelSelection.instanceId,
                        }),
                      ),
                    ),
                  )
                : false,
            });

        const record: RestartContinuationRecord = {
          version: 1,
          kind: shape.kind,
          threadId: thread.id,
          sourceTurnId: shape.sourceTurnId,
          latestUserMessageId: restartFenceUserMessageId(thread.messages),
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          worktreePath: thread.worktreePath,
          providerName: session.providerName,
          providerInstanceId: session.providerInstanceId ?? thread.modelSelection.instanceId,
          runtimeSessionId: session.runtimeSessionId ?? null,
          backgroundWork,
          capturedAt: input.capturedAt,
          lastObservedAt: input.hint?.recordedAt ?? observedAt(thread, window),
        };
        const inserted = yield* repository.insertIfAbsent(
          classification.status === "pending"
            ? { record, status: "pending", reason: null, settledAt: null }
            : {
                record,
                status: "skipped",
                reason: classification.reason,
                settledAt: input.capturedAt,
              },
        );
        if (!inserted) {
          const stored = yield* repository.get({
            threadId: thread.id,
            sourceTurnId: shape.sourceTurnId,
          });
          return Option.isSome(stored) ? capturedFromStored(stored.value) : null;
        }
        return {
          threadId: thread.id,
          sourceTurnId: shape.sourceTurnId,
          runtimeSessionId: record.runtimeSessionId,
          backgroundWork,
          status: classification.status,
          reason: classification.status === "pending" ? null : classification.reason,
        } satisfies CapturedRestartThread;
      });

    const capturedFromStored = (stored: StoredRestartContinuation): CapturedRestartThread | null =>
      stored.invalid === true
        ? null
        : {
            threadId: stored.record.threadId,
            sourceTurnId: stored.record.sourceTurnId,
            runtimeSessionId: stored.record.runtimeSessionId,
            backgroundWork: stored.record.backgroundWork,
            status: stored.status,
            reason: stored.reason,
          };

    const capture: RestartContinuationShape["capture"] = ({ snapshot, liveThreadIds }) =>
      Effect.gen(function* () {
        const capturedAt = yield* nowIso;
        const settingEnabled = yield* continuationEnabled;
        // Unread hints stay for the next capture: clearing them would consume them unseen.
        const hints = yield* repository
          .listShutdownHints()
          .pipe(logFailure("restart capture could not read shutdown hints"));
        const hintByThread = new Map((hints ?? []).map((hint) => [hint.threadId as string, hint]));
        const candidates = snapshot.threads
          .flatMap((thread) => {
            const hint = hintByThread.get(thread.id);
            const shape = restartCandidateShape(thread, liveThreadIds, hint);
            return shape === null ? [] : [{ thread, shape, hint }];
          })
          .toSorted((left, right) =>
            (right.thread.session?.updatedAt ?? "").localeCompare(
              left.thread.session?.updatedAt ?? "",
            ),
          );

        const captured: CapturedRestartThread[] = [];
        for (const [index, candidate] of candidates.entries()) {
          const result = yield* captureCandidate({
            ...candidate,
            settingEnabled,
            overCapacity: index >= RESTART_CAPTURE_MAX_THREADS,
            capturedAt,
          }).pipe(
            logFailure("restart capture failed for a thread", {
              threadId: candidate.thread.id,
            }),
          );
          if (result) captured.push(result);
        }

        if (hints !== undefined) {
          yield* repository
            .clearShutdownHints(capturedAt)
            .pipe(logFailure("restart capture could not clear shutdown hints"));
        }
        const pruneBefore = new Date(Date.parse(capturedAt) - SETTLED_RETENTION_MS).toISOString();
        yield* repository
          .pruneSettled(pruneBefore)
          .pipe(logFailure("restart capture could not prune settled rows"));
        if (captured.length > 0) {
          yield* Effect.logInfo("restart continuation captured interrupted threads", {
            captured: captured.length,
            pending: captured.filter((row) => row.status === "pending").length,
            settingEnabled,
          });
        }
        return captured;
      }).pipe(
        logFailure("restart continuation capture failed"),
        Effect.map((captured) => captured ?? []),
      );

    const publishCaptureEffects: RestartContinuationShape["publishCaptureEffects"] = (captured) =>
      Effect.forEach(
        captured,
        (row) =>
          Effect.gen(function* () {
            const ids = restartContinuationIds(row.threadId, row.sourceTurnId);
            const createdAt = yield* nowIso;
            if (hasRestartBackgroundWork(row.backgroundWork) && row.runtimeSessionId !== null) {
              // Same shape ingestion records when a runtime stops: the fold ends the epoch.
              yield* appendActivity({
                threadId: row.threadId,
                commandId: ids.boundaryCommandId,
                activity: {
                  id: ids.boundaryActivityId,
                  kind: BACKGROUND_WORK_BOUNDARY,
                  tone: "info",
                  summary: "Background work session changed",
                  payload: { runtimeSessionId: row.runtimeSessionId, state: "stopped" },
                  turnId: null,
                  createdAt,
                },
              });
              yield* appendActivity({
                threadId: row.threadId,
                commandId: ids.backgroundStoppedCommandId,
                activity: {
                  id: ids.backgroundStoppedActivityId,
                  kind: RESTART_BACKGROUND_WORK_STOPPED_KIND,
                  tone: "info",
                  summary: "Background work stopped by a server restart",
                  payload: {
                    schemaVersion: 1,
                    runtimeSessionId: row.runtimeSessionId,
                    tasks: row.backgroundWork.tasks,
                    omitted: row.backgroundWork.omitted,
                    detailsOmitted: row.backgroundWork.detailsOmitted,
                  },
                  turnId: row.sourceTurnId,
                  createdAt,
                },
              });
            }
            if (row.status === "skipped" && row.reason !== null) {
              yield* appendNotice(
                row.threadId,
                row.sourceTurnId,
                RESTART_CONTINUATION_SKIPPED_KIND,
                row.reason,
                restartSkipNotice(row.reason as RestartSkipReason),
              );
            }
          }),
        { discard: true },
      ).pipe(logFailure("restart continuation capture effects failed"), Effect.asVoid);

    // ── shutdown ───────────────────────────────────────────────────────────

    const recordShutdownHints: RestartContinuationShape["recordShutdownHints"] = ({
      liveThreadIds,
    }) =>
      Effect.gen(function* () {
        yield* repository.recordShutdownHints({
          liveSessionThreadIds: [...liveThreadIds],
          liveBackgroundThreadIds: liveness.listLiveThreadIds(),
          recordedAt: yield* nowIso,
        });
      }).pipe(logFailure("restart continuation could not record shutdown hints"), Effect.asVoid);

    // ── dispatch ───────────────────────────────────────────────────────────

    type RowOutcome = "settled" | "stop";

    const dispatchPending: RestartContinuationShape["dispatchPending"] = (input = {}) =>
      Effect.gen(function* () {
        const enabled = yield* continuationEnabled;
        const cancelledThreads = new Set<string>(
          (input.cancelledTurnStarts ?? []).map((start) => start.threadId),
        );
        const perInstance = new Map<string, number>();

        const settle = (
          threadId: ThreadId,
          sourceTurnId: TurnId,
          status: "dispatched" | "skipped" | "failed",
          reason: string | null,
        ) =>
          Effect.gen(function* () {
            const settled = yield* repository.settle({
              threadId,
              sourceTurnId,
              status,
              reason,
              settledAt: yield* nowIso,
            });
            if (!settled) {
              yield* Effect.logWarning("restart continuation row already left pending", {
                threadId,
                sourceTurnId,
              });
            }
            return settled;
          });

        const skip = (record: RestartContinuationRecord, reason: RestartSkipReason) =>
          Effect.gen(function* () {
            const settled = yield* settle(record.threadId, record.sourceTurnId, "skipped", reason);
            if (settled) {
              yield* appendNotice(
                record.threadId,
                record.sourceTurnId,
                RESTART_CONTINUATION_SKIPPED_KIND,
                reason,
                restartSkipNotice(reason),
              );
            }
            return settled;
          });

        const fail = (record: RestartContinuationRecord, reason: RestartFailureReason) =>
          Effect.gen(function* () {
            const settled = yield* settle(record.threadId, record.sourceTurnId, "failed", reason);
            if (settled) {
              yield* appendNotice(
                record.threadId,
                record.sourceTurnId,
                RESTART_CONTINUATION_FAILED_KIND,
                reason,
                restartFailureNotice(reason),
              );
            }
            return settled;
          });

        /** The continuation was committed earlier; find who still owns its delivery. */
        const handOffAccepted = (record: RestartContinuationRecord) =>
          Effect.gen(function* () {
            const { messageId } = restartContinuationIds(record.threadId, record.sourceTurnId);
            const unbound = yield* repository.pendingTurnStartExists({
              threadId: record.threadId,
              messageId,
            });
            // No unbound start: it reached the provider or ended visibly.
            if (!unbound) {
              return yield* settle(record.threadId, record.sourceTurnId, "dispatched", null);
            }
            // An open intent is re-driven by the live reactor or cancelled visibly by the
            // next boot's recovery; without one, nothing can deliver it.
            const intent = yield* intents.findOpenTurnStart({
              threadId: record.threadId,
              messageId,
            });
            return Option.isSome(intent)
              ? yield* settle(record.threadId, record.sourceTurnId, "dispatched", null)
              : yield* fail(record, "delivery-lost");
          });

        const processRow = (
          row: StoredRestartContinuation,
          threadById: ReadonlyMap<string, OrchestrationThread>,
        ) =>
          Effect.gen(function* () {
            if (row.invalid === true) {
              yield* Effect.logWarning("restart continuation record is invalid", {
                threadId: row.threadId,
                sourceTurnId: row.sourceTurnId,
              });
              return yield* settle(row.threadId, row.sourceTurnId, "failed", "invalid-record");
            }
            const record = row.record;
            const ids = restartContinuationIds(record.threadId, record.sourceTurnId);
            const receipt = yield* receipts.getByCommandId({ commandId: ids.turnStartCommandId });
            if (Option.isSome(receipt)) {
              return receipt.value.status === "accepted"
                ? yield* handOffAccepted(record)
                : yield* skip(record, "thread-changed");
            }
            if (!enabled) return yield* skip(record, "disabled");
            if (cancelledThreads.has(record.threadId)) {
              return yield* skip(record, "turn-start-cancelled");
            }
            const nowMs = yield* Clock.currentTimeMillis;
            if (nowMs - Date.parse(record.lastObservedAt) > RESTART_CONTINUATION_MAX_AGE_MS) {
              return yield* skip(record, "expired");
            }
            const dispatchedOnInstance = perInstance.get(record.providerInstanceId) ?? 0;
            if (dispatchedOnInstance >= RESTART_CONTINUATIONS_PER_INSTANCE) {
              return yield* skip(record, "capacity");
            }
            const thread = threadById.get(record.threadId);
            const guard = restartContinuationGuardOf(record);
            if (options.skipDispatchPreCheck !== true) {
              const blocker = restartContinuationTargetBlocker(thread, guard);
              if (blocker !== null) return yield* skip(record, blocker);
            }
            if (thread === undefined) return yield* skip(record, "thread-closed");
            if (thread.session?.providerName === "claudeAgent") {
              const window = yield* readWindow(thread.id, CLAUDE_REVIEW_WINDOW_LIMITS).pipe(
                Effect.exit,
              );
              if (Exit.isFailure(window)) {
                if (Cause.hasInterruptsOnly(window.cause)) return yield* Effect.interrupt;
                yield* Effect.logWarning("restart continuation could not review the Claude cache", {
                  threadId: thread.id,
                  cause: Cause.pretty(window.cause),
                });
                return yield* fail(record, "dispatch-failed");
              }
              if (
                window.value !== null &&
                assessClaudeCacheResume(window.value, thread.modelSelection, nowMs) !== undefined
              ) {
                return yield* skip(record, "claude-cache-review");
              }
            }
            const command = buildRestartContinuationTurnStart(thread, {
              commandId: ids.turnStartCommandId,
              messageId: ids.messageId,
              text: restartContinuationPrompt(record),
              createdAt: new Date(nowMs).toISOString(),
              guard,
            });
            const exit = yield* Effect.exit(engine.dispatch(command));
            if (Exit.isSuccess(exit)) {
              perInstance.set(record.providerInstanceId, dispatchedOnInstance + 1);
              yield* Effect.logInfo("restart continuation dispatched", {
                threadId: record.threadId,
                sourceTurnId: record.sourceTurnId,
                kind: record.kind,
              });
              return yield* settle(record.threadId, record.sourceTurnId, "dispatched", null);
            }
            if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt;
            if (isSettledRejection(exit.cause)) return yield* skip(record, "thread-changed");
            yield* Effect.logWarning("restart continuation dispatch failed", {
              threadId: record.threadId,
              cause: Cause.pretty(exit.cause),
            });
            return yield* fail(record, "dispatch-failed");
          });

        for (let page = 0; page < DISPATCH_MAX_PAGES; page += 1) {
          const rows = yield* repository.listPending(DISPATCH_PAGE_SIZE);
          if (rows.length === 0) return;
          const model = yield* snapshots.getCommandReadModel();
          const threadById = new Map<string, OrchestrationThread>(
            model.threads.map((thread) => [thread.id, thread]),
          );
          for (const row of rows) {
            const outcome: RowOutcome = yield* processRow(row, threadById).pipe(
              Effect.map((settled): RowOutcome => (settled ? "settled" : "stop")),
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause as Cause.Cause<never>)
                  : Effect.logWarning("restart continuation row could not be processed", {
                      threadId: row.invalid === true ? row.threadId : row.record.threadId,
                      cause: Cause.pretty(cause),
                    }).pipe(Effect.as<RowOutcome>("stop")),
              ),
            );
            // Stop instead of re-reading rows that cannot leave pending in this pass.
            if (outcome === "stop") {
              yield* Effect.logWarning("restart continuation dispatch pass stopped early");
              return;
            }
          }
        }
        yield* Effect.logWarning("restart continuation dispatch pass reached its page bound");
      }).pipe(logFailure("restart continuation dispatch failed"), Effect.asVoid);

    return {
      capture,
      publishCaptureEffects,
      recordShutdownHints,
      dispatchPending,
    } satisfies RestartContinuationShape;
  });

export const makeRestartContinuationLayer = (options: RestartContinuationOptions = {}) =>
  Layer.effect(RestartContinuation, makeRestartContinuation(options));

export const RestartContinuationLive = makeRestartContinuationLayer();
