import { Deferred, Effect, Exit, Option, Schema, Semaphore, Stream } from "effect";
import { readAttachmentChunk } from "../attachmentRead.ts";
import { clamp } from "effect/Number";
import { BACKGROUND_WORK_CHECKPOINT } from "@ryco/shared/backgroundWork";
import {
  AuthRpcError,
  FileAttachmentCreateUploadUrlError,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationThreadHistoryError,
  OrchestrationGetTaskOutputError,
  OrchestrationGetTurnDiffError,
  OrchestrationGetWorkflowScriptError,
  OrchestrationReplayEventsError,
  OrchestrationStopBackgroundTaskError,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  ThreadPriorityRpcError,
  type OrchestrationGetThreadHistoryPageInput,
  type OrchestrationGetThreadShellsInput,
  type OrchestrationGetThreadWindowInput,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadHistoryRecoveryMode,
  type OrchestrationThreadShell,
  type OrchestrationThreadWindowSnapshot,
  type ThreadId,
} from "@ryco/contracts";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import {
  readScopedShellSnapshot,
  readStubbedShellSnapshot,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";

import { normalizeDispatchCommand } from "../orchestration/Normalizer.ts";
import { shellSettlementPolicy } from "../orchestration/threadSettlementInput.ts";
import { loadActivityPayload } from "../orchestration/activityPayloadPreview.ts";
import { encodeThreadHistoryCursor } from "../orchestration/threadHistoryCursor.ts";
import {
  makeThreadHistoryRecoveryRegistry,
  type ThreadStreamItemLike,
  withThreadHistoryRecovery,
} from "../orchestration/historyRecoveryPolicy.ts";
import {
  applyOrchestrationCommand,
  orchestrationCommandFlights,
} from "../orchestration/Layers/OrchestrationCommandApplication.ts";
import { readTaskOutput, taskOutputRootsFromSettings } from "../orchestration/taskOutputQuery.ts";
import {
  readWorkflowScript,
  workflowScriptRootsFromSettings,
} from "../orchestration/workflowScriptQuery.ts";
import { observeRpcEffect, observeRpcStreamEffect } from "../observability/RpcInstrumentation.ts";
import {
  isServerPerfProfileEnabled,
  recordServerPerfPayload,
} from "../observability/PerfInstrumentation.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";
import {
  ORCHESTRATION_LEGACY_REPLAY_MAX_EVENTS,
  ORCHESTRATION_REPLAY_PAGE_MAX_LIMIT,
  ORCHESTRATION_SHELL_SNAPSHOT_PAGE_MAX_BYTES,
} from "./context/constants.ts";
import { observeArrays } from "./streamBatching.ts";

/**
 * Encoded size a thread window may reach. The relay carries 4 MiB per message;
 * a larger window fails with `response-too-large` and costs the client a
 * halved re-subscribe, so the window is trimmed on the server instead.
 */
export const THREAD_WINDOW_MAX_ENCODED_BYTES = 3.5 * 1024 * 1024;

/** Passive thread window loads that may run at once on one connection. */
const PASSIVE_THREAD_WINDOW_LOAD_CONCURRENCY = 2;

const encodedJsonBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * Keeps a window within `maxBytes` of encoded JSON by dropping its oldest
 * messages and activities, oldest first across both, and marks each trimmed
 * collection as having older history so pagination reaches what was dropped.
 * The newest message and the newest activity always stay, so one oversized
 * item still opens. The derived background-work checkpoint rides along
 * untouched: it already accounts for evidence outside the window.
 */
export function fitThreadWindowToByteBudget(
  snapshot: OrchestrationThreadWindowSnapshot,
  maxBytes: number = THREAD_WINDOW_MAX_ENCODED_BYTES,
): OrchestrationThreadWindowSnapshot {
  let bytes = encodedJsonBytes(snapshot);
  if (bytes <= maxBytes) return snapshot;

  const { id: threadId, messages } = snapshot.thread;
  const checkpoint = snapshot.thread.activities.at(-1);
  const derivedCheckpoint =
    checkpoint?.kind === BACKGROUND_WORK_CHECKPOINT ? checkpoint : undefined;
  const activities =
    derivedCheckpoint === undefined
      ? snapshot.thread.activities
      : snapshot.thread.activities.slice(0, -1);

  const withOldestDropped = (droppedMessages: number, droppedActivities: number) => {
    const keptMessages = messages.slice(droppedMessages);
    const keptActivities = activities.slice(droppedActivities);
    const oldestMessage = droppedMessages === 0 ? undefined : keptMessages[0];
    const oldestActivity = droppedActivities === 0 ? undefined : keptActivities[0];
    return {
      ...snapshot,
      thread: {
        ...snapshot.thread,
        messages: keptMessages,
        activities:
          derivedCheckpoint === undefined ? keptActivities : [...keptActivities, derivedCheckpoint],
      },
      history: {
        ...snapshot.history,
        messages:
          oldestMessage === undefined
            ? snapshot.history.messages
            : {
                ...snapshot.history.messages,
                oldestCursor: encodeThreadHistoryCursor({
                  threadId,
                  collection: "messages",
                  order: { createdAt: oldestMessage.createdAt, id: oldestMessage.id },
                }),
                hasMoreBefore: true,
              },
        activities:
          oldestActivity === undefined
            ? snapshot.history.activities
            : {
                ...snapshot.history.activities,
                oldestCursor: encodeThreadHistoryCursor({
                  threadId,
                  collection: "activities",
                  order: {
                    sequence: oldestActivity.sequence ?? null,
                    createdAt: oldestActivity.createdAt,
                    id: oldestActivity.id,
                  },
                }),
                hasMoreBefore: true,
              },
      },
    } satisfies OrchestrationThreadWindowSnapshot;
  };

  let fitted = snapshot;
  let droppedMessages = 0;
  let droppedActivities = 0;
  while (bytes > maxBytes) {
    const droppedBefore = droppedMessages + droppedActivities;
    // Dropping an item saves about its own encoded size. The result is
    // re-measured below, so anything this ignores (separators, the repointed
    // cursors) only costs another short pass.
    let excess = bytes - maxBytes;
    while (excess > 0) {
      const message = droppedMessages < messages.length - 1 ? messages[droppedMessages] : undefined;
      const activity =
        droppedActivities < activities.length - 1 ? activities[droppedActivities] : undefined;
      if (
        message !== undefined &&
        (activity === undefined || message.createdAt < activity.createdAt)
      ) {
        excess -= encodedJsonBytes(message) + 1;
        droppedMessages += 1;
      } else if (activity !== undefined) {
        excess -= encodedJsonBytes(activity) + 1;
        droppedActivities += 1;
      } else {
        break;
      }
    }
    if (droppedMessages + droppedActivities === droppedBefore) break;
    fitted = withOldestDropped(droppedMessages, droppedActivities);
    bytes = encodedJsonBytes(fitted);
  }
  return fitted;
}

/**
 * Orders one connection's thread window loads. A window a view is waiting on
 * (`active`, which is also what an older client gets) starts at once. The
 * windows retained subscriptions reload after a reconnect (`passive`) take
 * turns, a couple at a time in arrival order, and hold back while an active
 * load runs. Served in arrival order instead, the routed thread's window queues
 * behind every retained thread's.
 */
const makeThreadWindowLoadScheduler = () => {
  const passiveSlots = Semaphore.makeUnsafe(PASSIVE_THREAD_WINDOW_LOAD_CONCURRENCY);
  let activeLoads = 0;
  let activeLoadsSettled: Deferred.Deferred<void> | undefined;

  const awaitNoActiveLoad: Effect.Effect<void> = Effect.suspend(() =>
    activeLoadsSettled === undefined
      ? Effect.void
      : Deferred.await(activeLoadsSettled).pipe(Effect.andThen(awaitNoActiveLoad)),
  );
  const enterActiveLoad = Effect.sync(() => {
    if (activeLoads === 0) activeLoadsSettled = Deferred.makeUnsafe<void>();
    activeLoads += 1;
  });
  const leaveActiveLoad = Effect.sync(() => {
    activeLoads -= 1;
    if (activeLoads === 0 && activeLoadsSettled !== undefined) {
      Deferred.doneUnsafe(activeLoadsSettled, Exit.void);
      activeLoadsSettled = undefined;
    }
  });

  return <A, E, R>(
    mode: OrchestrationThreadHistoryRecoveryMode | undefined,
    load: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    mode === "passive"
      ? passiveSlots.withPermits(1)(awaitNoActiveLoad.pipe(Effect.andThen(load)))
      : Effect.acquireUseRelease(
          enterActiveLoad,
          () => load,
          () => leaveActiveLoad,
        );
};

export const makeOrchestrationHandlers = (ctx: WsRpcContext) => {
  const {
    ownerEffect,
    withAccess,
    projectionSnapshotQuery,
    commandReceipts,
    dispatchNormalizedCommand,
    dispatchWorktreeCommand,
    serverCommandId,
    serverSettings,
    providerService,
    providerRuntimeIngestion,
    threadViewers,
    terminalManager,
    checkpointDiffQuery,
    orchestrationEngine,
    enrichOrchestrationEvents,
    makeReplayableShellStream,
    makeReplayableThreadStream,
    recordThreadSnapshotDurationMs,
    reconcileAllWorktrees,
    threadPriorityCoordinator,
  } = ctx;

  // This connection's thread subscriptions, so a view that attaches to a
  // subscription a prewarm opened can turn its history recovery on (and off
  // again once the view detaches).
  const historyRecoveryRegistry = makeThreadHistoryRecoveryRegistry();

  // Shared by this connection's thread window subscriptions: the routed
  // thread's window must not wait behind the retained threads' reloads.
  const scheduleThreadWindowLoad = makeThreadWindowLoadScheduler();

  // Lifetime follows the authorized thread subscription. Reading history never
  // resumes Codex or grants mutation authority to this connection. A passive
  // subscription (prewarm, retained idle thread) never reads history. Called
  // while the handler builds the stream, so `register` stamps the request's
  // arrival before any mode change that came after it.
  const withHistoryRecovery = <A extends ThreadStreamItemLike, E, R>(
    threadId: ThreadId,
    stream: Stream.Stream<A, E, R>,
    mode: "active" | "passive" | undefined,
  ) => {
    const reconcile = Option.getOrUndefined(providerRuntimeIngestion)?.reconcileThread;
    return reconcile
      ? withThreadHistoryRecovery(threadId, stream, reconcile, {
          mode: mode ?? "active",
          register: historyRecoveryRegistry.register(threadId),
          ...(Option.isSome(threadViewers) ? { viewers: threadViewers.value } : {}),
        })
      : stream;
  };

  /**
   * The file paths a thread's persisted task activities actually reference
   * (workflow `runHandles.scriptPath` and task `outputFile`). Script and
   * task-output reads are authorized against this set, binding each read to
   * the requested thread — global root containment alone would let any
   * caller read any script or output under the Claude projects roots by
   * guessing absolute paths. Failures resolve to empty sets: fail closed.
   *
   * getTaskOutput polls while a task runs, so the narrow payload-only
   * projection is preferred; the full thread detail is only a fallback for
   * query implementations that don't provide it.
   */
  const referencedTaskPaths = (
    threadId: ThreadId,
  ): Effect.Effect<{
    readonly scriptPaths: ReadonlySet<string>;
    readonly outputPaths: ReadonlySet<string>;
  }> => {
    const narrow = projectionSnapshotQuery.listThreadTaskPathRefs;
    const refs = narrow
      ? narrow(threadId).pipe(
          Effect.map((result) => ({
            scriptPaths: new Set(result.scriptPaths),
            outputPaths: new Set(result.outputPaths),
          })),
        )
      : projectionSnapshotQuery.getThreadDetailById(threadId).pipe(
          Effect.map(
            Option.match({
              onNone: () => ({
                scriptPaths: new Set<string>(),
                outputPaths: new Set<string>(),
              }),
              onSome: (thread) => {
                const scriptPaths = new Set<string>();
                const outputPaths = new Set<string>();
                for (const activity of thread.activities) {
                  const payload = activity.payload;
                  if (payload === null || typeof payload !== "object") {
                    continue;
                  }
                  const record = payload as Record<string, unknown>;
                  const runHandles = record.runHandles;
                  if (runHandles !== null && typeof runHandles === "object") {
                    const scriptPath = (runHandles as { scriptPath?: unknown }).scriptPath;
                    if (typeof scriptPath === "string") {
                      scriptPaths.add(scriptPath);
                    }
                  }
                  if (typeof record.outputFile === "string") {
                    outputPaths.add(record.outputFile);
                  }
                }
                return { scriptPaths, outputPaths };
              },
            }),
          ),
        );
    return refs.pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("thread lookup for task-path authorization failed", {
          threadId,
          cause,
        }),
      ),
      Effect.catch(() =>
        Effect.succeed({
          scriptPaths: new Set<string>(),
          outputPaths: new Set<string>(),
        }),
      ),
    );
  };

  const loadThreadWindow = (input: OrchestrationGetThreadWindowInput) => {
    const query = projectionSnapshotQuery.getThreadWindow;
    if (query === undefined) {
      return Effect.fail(
        new OrchestrationGetSnapshotError({
          message: "Bounded thread history is unavailable",
          cause: "ProjectionSnapshotQuery.getThreadWindow is not implemented",
        }),
      );
    }
    return query({
      threadId: input.threadId,
      ...(input.activityPayloads !== undefined ? { activityPayloads: input.activityPayloads } : {}),
      limits: {
        messages: clamp(input.limits.messages, { minimum: 1, maximum: 200 }),
        proposedPlans: clamp(input.limits.proposedPlans, {
          minimum: 1,
          maximum: 50,
        }),
        activities: clamp(input.limits.activities, {
          minimum: 1,
          maximum: 200,
        }),
        checkpoints: clamp(input.limits.checkpoints, {
          minimum: 1,
          maximum: 50,
        }),
      },
    }).pipe(
      Effect.map((window) => fitThreadWindowToByteBudget(window)),
      Effect.mapError((cause) =>
        Schema.is(OrchestrationThreadHistoryError)(cause)
          ? cause
          : new OrchestrationGetSnapshotError({
              message: `Failed to load bounded history for thread ${input.threadId}`,
              cause,
            }),
      ),
    );
  };

  const loadThreadHistoryPage = (input: OrchestrationGetThreadHistoryPageInput) => {
    const query = projectionSnapshotQuery.getThreadHistoryPage;
    if (query === undefined) {
      return Effect.fail(
        new OrchestrationGetSnapshotError({
          message: "Thread history pagination is unavailable",
          cause: "ProjectionSnapshotQuery.getThreadHistoryPage is not implemented",
        }),
      );
    }
    return query({
      ...input,
      limit: clamp(input.limit, {
        minimum: 1,
        maximum: input.collection === "messages" || input.collection === "activities" ? 200 : 50,
      }),
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(OrchestrationThreadHistoryError)(cause)
          ? cause
          : new OrchestrationGetSnapshotError({
              message: `Failed to load ${input.collection} history for thread ${input.threadId}`,
              cause,
            }),
      ),
    );
  };

  // Every shell snapshot carries the node's settlement rule, so a client that later
  // holds only the snapshot still lists this node's threads by it. Reading the
  // settings never fails the snapshot: without them it goes out as before.
  const withSettlementPolicy = <A extends OrchestrationShellSnapshot>(
    load: Effect.Effect<A, ProjectionRepositoryError>,
  ) =>
    Effect.zipWith(
      load,
      serverSettings.getSettings.pipe(Effect.map(shellSettlementPolicy), Effect.option),
      (snapshot, policy): A =>
        Option.isSome(policy) ? { ...snapshot, settlementPolicy: policy.value } : snapshot,
    );

  const shellSnapshotLoad = <A>(load: Effect.Effect<A, ProjectionRepositoryError>) =>
    load.pipe(
      Effect.tapError((cause) =>
        Effect.logError("orchestration shell snapshot load failed", { cause }),
      ),
      Effect.mapError(
        (cause) =>
          new OrchestrationGetSnapshotError({
            message: "Failed to load orchestration shell snapshot",
            cause,
          }),
      ),
    );

  /**
   * Full shells of a few threads (archived stubs' on-demand load), in request
   * order, within one page's byte budget; the rest are named for another ask.
   */
  const loadThreadShells = (input: OrchestrationGetThreadShellsInput) => {
    const threadIds = Array.from(new Set(input.threadIds));
    if (threadIds.length === 0) {
      return projectionSnapshotQuery.getSnapshotSequence().pipe(
        Effect.map(({ snapshotSequence }) => ({
          snapshotSequence,
          threads: [],
          remainingThreadIds: [],
        })),
        Effect.mapError(
          (cause) =>
            new OrchestrationGetSnapshotError({
              message: "Failed to load thread shells",
              cause,
            }),
        ),
      );
    }
    return readScopedShellSnapshot(projectionSnapshotQuery, { threadIds }).pipe(
      Effect.map((snapshot) => {
        const byId = new Map(snapshot.threads.map((thread) => [thread.id, thread] as const));
        const threads: Array<OrchestrationThreadShell> = [];
        const remainingThreadIds: Array<ThreadId> = [];
        let bytes = 0;
        for (const threadId of threadIds) {
          const thread = byId.get(threadId);
          if (thread === undefined) continue;
          const threadBytes = Buffer.byteLength(JSON.stringify(thread), "utf8") + 1;
          // The first shell always travels, so a request always makes progress.
          if (
            remainingThreadIds.length > 0 ||
            (threads.length > 0 &&
              bytes + threadBytes > ORCHESTRATION_SHELL_SNAPSHOT_PAGE_MAX_BYTES)
          ) {
            remainingThreadIds.push(threadId);
            continue;
          }
          threads.push(thread);
          bytes += threadBytes;
        }
        return { snapshotSequence: snapshot.snapshotSequence, threads, remainingThreadIds };
      }),
      Effect.mapError(
        (cause) =>
          new OrchestrationGetSnapshotError({
            message: "Failed to load thread shells",
            cause,
          }),
      ),
    );
  };

  return defineWsHandlers({
    [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        ownerEffect(
          ORCHESTRATION_WS_METHODS.dispatchCommand,
          applyOrchestrationCommand({
            command,
            normalize: normalizeDispatchCommand,
            dispatch: dispatchNormalizedCommand,
            projections: projectionSnapshotQuery,
            terminals: terminalManager,
            // A hosted client replays a command whose response a relay drop
            // lost: join its still-running first attempt, or answer it from
            // its receipt before normalizing it again.
            ...(commandReceipts ? { receipts: commandReceipts } : {}),
            flights: orchestrationCommandFlights,
          }).pipe(
            Effect.mapError((cause) =>
              Schema.is(OrchestrationDispatchCommandError)(cause)
                ? cause
                : new OrchestrationDispatchCommandError({
                    message: "Failed to dispatch orchestration command",
                    cause,
                  }),
            ),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.getWorkflowScript]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getWorkflowScript,
        // ownerEffect enforces the "operator" tier from RPC_ACCESS_POLICY —
        // the policy table alone is advisory; per-handler guards are the
        // only server-side enforcement in this codebase.
        ownerEffect(
          ORCHESTRATION_WS_METHODS.getWorkflowScript,
          Effect.gen(function* () {
            // Thread binding first: the requested thread's persisted
            // activities must reference this exact script path. "not-found"
            // deliberately does not distinguish unknown threads, unreferenced
            // paths, and missing files (anti-probing).
            const referenced = yield* referencedTaskPaths(input.threadId);
            if (!referenced.scriptPaths.has(input.scriptPath)) {
              return yield* new OrchestrationGetWorkflowScriptError({
                reason: "not-found",
                scriptPath: input.scriptPath,
              });
            }
            // Settings only widen the containment roots; a settings failure
            // must not block reads under the default home root.
            const settings = yield* serverSettings.getSettings.pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            );
            return yield* readWorkflowScript({
              scriptPath: input.scriptPath,
              roots: workflowScriptRootsFromSettings(settings),
            });
          }),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.getTaskOutput]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getTaskOutput,
        ownerEffect(
          ORCHESTRATION_WS_METHODS.getTaskOutput,
          Effect.gen(function* () {
            // Same thread binding as getWorkflowScript, against the task
            // `outputFile` handles the thread's activities reference.
            const referenced = yield* referencedTaskPaths(input.threadId);
            if (!referenced.outputPaths.has(input.outputPath)) {
              return yield* new OrchestrationGetTaskOutputError({
                reason: "not-found",
                outputPath: input.outputPath,
              });
            }
            const settings = yield* serverSettings.getSettings.pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            );
            return yield* readTaskOutput({
              outputPath: input.outputPath,
              offset: input.offset,
              roots: taskOutputRootsFromSettings(settings),
            });
          }),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.stopBackgroundTask]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.stopBackgroundTask,
        ownerEffect(
          ORCHESTRATION_WS_METHODS.stopBackgroundTask,
          Option.match(providerService, {
            onNone: () =>
              // No ProviderService in the environment is a wiring gap, not a
              // client mistake — log loudly and fail closed.
              Effect.logError("stopBackgroundTask has no ProviderService in context").pipe(
                Effect.andThen(
                  Effect.fail(
                    new OrchestrationStopBackgroundTaskError({
                      reason: "stop-failed",
                      threadId: input.threadId,
                      taskId: input.taskId,
                    }),
                  ),
                ),
              ),
            onSome: (service) =>
              service
                .stopBackgroundTask({
                  threadId: input.threadId,
                  taskId: input.taskId,
                  ...(input.expected ? { expected: input.expected } : {}),
                })
                .pipe(
                  Effect.tapError((cause) =>
                    Effect.logWarning("stopBackgroundTask failed", {
                      threadId: input.threadId,
                      taskId: input.taskId,
                      cause,
                    }),
                  ),
                  // The raw provider cause stays in server logs; the wire error
                  // carries only the classified reason.
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationStopBackgroundTaskError({
                        reason:
                          cause._tag === "ProviderUnsupportedError"
                            ? "unsupported"
                            : cause._tag === "ProviderSessionNotFoundError" ||
                                cause._tag === "ProviderAdapterSessionNotFoundError" ||
                                cause._tag === "ProviderAdapterSessionClosedError"
                              ? "session-not-found"
                              : "stop-failed",
                        threadId: input.threadId,
                        taskId: input.taskId,
                      }),
                  ),
                ),
          }).pipe(Effect.as({})),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getTurnDiff,
        checkpointDiffQuery.getTurnDiff(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetTurnDiffError({
                message: "Failed to load turn diff",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getFullThreadDiff,
        checkpointDiffQuery.getFullThreadDiff(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetFullThreadDiffError({
                message: "Failed to load full thread diff",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.searchThreadMessages]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.searchThreadMessages,
        projectionSnapshotQuery
          .searchThreadMessages({
            ...input,
            limit: clamp(input.limit, {
              maximum: 50,
              minimum: 1,
            }),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetSnapshotError({
                  message: "Failed to search thread messages",
                  cause,
                }),
            ),
          ),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.getThreadWindow]: (input) =>
      observeRpcEffect(ORCHESTRATION_WS_METHODS.getThreadWindow, loadThreadWindow(input), {
        "rpc.aggregate": "orchestration",
      }),
    [ORCHESTRATION_WS_METHODS.getThreadShells]: (input) =>
      observeRpcEffect(ORCHESTRATION_WS_METHODS.getThreadShells, loadThreadShells(input), {
        "rpc.aggregate": "orchestration",
      }),
    [ORCHESTRATION_WS_METHODS.getActivityPayload]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getActivityPayload,
        loadActivityPayload(projectionSnapshotQuery.getActivityPayload, input),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.getThreadHistoryPage]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getThreadHistoryPage,
        loadThreadHistoryPage(input),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.setThreadHistoryRecovery]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.setThreadHistoryRecovery,
        historyRecoveryRegistry.setMode(input.threadId, input.mode).pipe(Effect.as({})),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.replayEvents]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.replayEvents,
        Stream.runCollect(
          orchestrationEngine.readEvents(
            clamp(input.fromSequenceExclusive, {
              maximum: Number.MAX_SAFE_INTEGER,
              minimum: 0,
            }),
            ORCHESTRATION_LEGACY_REPLAY_MAX_EVENTS,
          ),
        ).pipe(
          Effect.map((events) => Array.from(events)),
          Effect.flatMap(enrichOrchestrationEvents),
          Effect.mapError(
            (cause) =>
              new OrchestrationReplayEventsError({
                message: "Failed to replay orchestration events",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.replayEventsPage]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.replayEventsPage,
        orchestrationEngine
          .readEventsPage(
            clamp(input.fromSequenceExclusive, {
              maximum: Number.MAX_SAFE_INTEGER,
              minimum: 0,
            }),
            clamp(input.limit, {
              maximum: ORCHESTRATION_REPLAY_PAGE_MAX_LIMIT,
              minimum: 1,
            }),
          )
          .pipe(
            Effect.flatMap((page) =>
              enrichOrchestrationEvents(page.events).pipe(
                Effect.map((events) => ({
                  events,
                  nextSequence: page.nextSequence,
                  hasMore: page.hasMore,
                })),
              ),
            ),
            Effect.mapError(
              (cause) =>
                new OrchestrationReplayEventsError({
                  message: "Failed to replay orchestration events page",
                  cause,
                }),
            ),
          ),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.subscribeShell]: (input) =>
      observeRpcStreamEffect(
        ORCHESTRATION_WS_METHODS.subscribeShell,
        // Realign worktree rows with disk while the shell loads. Any correction
        // it dispatches reaches this same subscription as an ordinary event.
        reconcileAllWorktrees.pipe(
          Effect.forkDetach,
          Effect.as(
            makeReplayableShellStream(
              shellSnapshotLoad(withSettlementPolicy(projectionSnapshotQuery.getShellSnapshot())),
              {
                resumeFromSequence: input.resumeFromSequence,
                threadPriorities: input.threadPriorities,
                snapshotDelivery: input.snapshotDelivery,
                ...(input.archivedThreads === "stub"
                  ? {
                      stubbedSnapshot: shellSnapshotLoad(
                        withSettlementPolicy(readStubbedShellSnapshot(projectionSnapshotQuery)),
                      ),
                    }
                  : {}),
              },
            ).pipe(
              observeArrays(isServerPerfProfileEnabled(), (items) =>
                recordServerPerfPayload("server.ws.orchestration.subscribeShell", items),
              ),
            ),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
      observeRpcStreamEffect(
        ORCHESTRATION_WS_METHODS.subscribeThread,
        Effect.succeed(
          makeReplayableThreadStream(
            Effect.gen(function* () {
              const perfEnabled = isServerPerfProfileEnabled();
              const startedAtMs = performance.now();
              const [threadDetail, snapshotSequence] = yield* Effect.all([
                projectionSnapshotQuery.getThreadDetailById(input.threadId).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: `Failed to load thread ${input.threadId}`,
                        cause,
                      }),
                  ),
                ),
                projectionSnapshotQuery.getSnapshotSequence().pipe(
                  Effect.map(({ snapshotSequence }) => snapshotSequence),
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: "Failed to load orchestration snapshot sequence",
                        cause,
                      }),
                  ),
                ),
              ]);

              if (Option.isNone(threadDetail)) {
                return yield* new OrchestrationGetSnapshotError({
                  message: `Thread ${input.threadId} was not found`,
                  cause: input.threadId,
                });
              }

              const snapshot = {
                snapshotSequence,
                thread: threadDetail.value,
              };
              const snapshotDurationMs = Math.max(0, performance.now() - startedAtMs);
              yield* recordThreadSnapshotDurationMs(snapshotDurationMs);
              if (perfEnabled) {
                yield* Effect.sync(() =>
                  recordServerPerfPayload(
                    "server.ws.orchestration.subscribeThread.snapshot",
                    snapshot,
                    { durationMs: snapshotDurationMs },
                  ),
                );
              }
              return snapshot;
            }),
            input.threadId,
            { resumeFromSequence: input.resumeFromSequence },
          ).pipe(
            (stream) => withHistoryRecovery(input.threadId, stream, input.historyRecovery),
            observeArrays(isServerPerfProfileEnabled(), (items) =>
              recordServerPerfPayload("server.ws.orchestration.subscribeThread", items),
            ),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.subscribeThreadWindow]: (input) =>
      observeRpcStreamEffect(
        ORCHESTRATION_WS_METHODS.subscribeThreadWindow,
        Effect.succeed(
          makeReplayableThreadStream(
            scheduleThreadWindowLoad(
              input.historyRecovery,
              Effect.gen(function* () {
                const perfEnabled = isServerPerfProfileEnabled();
                const startedAtMs = performance.now();
                const snapshot = yield* loadThreadWindow(input);
                const snapshotDurationMs = Math.max(0, performance.now() - startedAtMs);
                yield* recordThreadSnapshotDurationMs(snapshotDurationMs);
                if (perfEnabled) {
                  yield* Effect.sync(() =>
                    recordServerPerfPayload(
                      "server.ws.orchestration.subscribeThreadWindow.snapshot",
                      snapshot,
                      { durationMs: snapshotDurationMs },
                    ),
                  );
                }
                return snapshot;
              }),
            ),
            input.threadId,
            { resumeFromSequence: input.resumeFromSequence },
          ).pipe(
            (stream) => withHistoryRecovery(input.threadId, stream, input.historyRecovery),
            observeArrays(isServerPerfProfileEnabled(), (items) =>
              recordServerPerfPayload("server.ws.orchestration.subscribeThreadWindow", items),
            ),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [WS_METHODS.threadsSetManualBucket]: (input) =>
      observeRpcEffect(
        WS_METHODS.threadsSetManualBucket,
        ownerEffect(
          WS_METHODS.threadsSetManualBucket,
          dispatchWorktreeCommand(
            {
              type: "thread.status-bucket.override",
              commandId: serverCommandId("thread-status-bucket-override"),
              threadId: input.threadId,
              bucket: input.bucket,
              changedAt: new Date().toISOString(),
            },
            "threads.setManualBucket",
          ).pipe(Effect.as({})),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [WS_METHODS.threadsSetManualPosition]: (input) =>
      observeRpcEffect(
        WS_METHODS.threadsSetManualPosition,
        ownerEffect(
          WS_METHODS.threadsSetManualPosition,
          dispatchWorktreeCommand(
            {
              type: "thread.manual-position.set",
              commandId: serverCommandId("thread-manual-position-set"),
              threadId: input.threadId,
              position: input.position,
              changedAt: new Date().toISOString(),
            },
            "threads.setManualPosition",
          ).pipe(Effect.as({})),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [WS_METHODS.searchThreadMessages]: (input) =>
      observeRpcEffect(
        WS_METHODS.searchThreadMessages,
        ownerEffect(
          WS_METHODS.searchThreadMessages,
          Effect.gen(function* () {
            const query = input.query.trim();
            if (query.length === 0) {
              return { results: [] };
            }
            const results = yield* projectionSnapshotQuery.searchThreadMessages({
              query,
              ...(input.projectId ? { projectId: input.projectId } : {}),
              limit: clamp(input.limit ?? 20, {
                maximum: 50,
                minimum: 1,
              }),
            });
            return { results };
          }).pipe(
            Effect.mapError(
              () =>
                new AuthRpcError({
                  message: "Failed to search thread messages.",
                  status: 403,
                }),
            ),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [WS_METHODS.threadPriorityEnsureCurrent]: (input) =>
      observeRpcEffect(
        WS_METHODS.threadPriorityEnsureCurrent,
        ownerEffect(
          WS_METHODS.threadPriorityEnsureCurrent,
          Option.match(threadPriorityCoordinator, {
            onNone: () =>
              Effect.fail(
                new ThreadPriorityRpcError({
                  failure: {
                    kind: "unsupported",
                    detail: "Inbox priority ranking is not available on this server.",
                  },
                }),
              ),
            onSome: (coordinator) => coordinator.ensureCurrent(input),
          }),
        ),
        { "rpc.aggregate": "threadPriority" },
      ),
    [WS_METHODS.chatAttachmentsReadChunk]: (input) =>
      observeRpcEffect(
        WS_METHODS.chatAttachmentsReadChunk,
        // Anyone who can read the thread can read its attachments: the read is
        // bound to an attachment of a message in that thread, the same data a
        // viewer already gets from thread windows, diffs and raw payloads. A
        // phone paired as a client relies on it to show images and agent pages.
        withAccess(
          "viewer",
          WS_METHODS.chatAttachmentsReadChunk,
          readAttachmentChunk(input, {
            attachmentsDir: ctx.config.attachmentsDir,
            projections: projectionSnapshotQuery,
          }),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [WS_METHODS.chatAttachmentsCreateFileUpload]: (input) =>
      observeRpcEffect(
        WS_METHODS.chatAttachmentsCreateFileUpload,
        ownerEffect(
          WS_METHODS.chatAttachmentsCreateFileUpload,
          Option.match(ctx.chatAttachmentUploads, {
            onNone: () =>
              Effect.fail(
                new FileAttachmentCreateUploadUrlError({
                  message: "File attachment uploads are not available on this server.",
                }),
              ),
            onSome: (uploads) =>
              uploads
                .create(input)
                .pipe(
                  Effect.mapError(
                    (error) => new FileAttachmentCreateUploadUrlError({ message: error.message }),
                  ),
                ),
          }),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
  });
};
