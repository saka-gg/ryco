import { CompletionReturnRepository } from "../../persistence/Layers/AgentControlCompletionReturns.ts";
import { callbackRepositories, pendingCallbackInvalidation } from "../approvalResponses.ts";
import { derivePendingProviderCallbackRequests } from "@ryco/shared/threadActivity";
import { ServerConfig } from "../../config.ts";
import { WorkspaceAccessPolicy } from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import {
  AssistantAttachmentError,
  formatAssistantDeliveryText,
  parseAssistantDelivery,
  persistAssistantAttachment,
} from "../../assistantAttachments.ts";
import {
  type ChatAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES,
  CommandId,
  DEFAULT_AGENT_TOKEN_MODE,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationProposedPlanId,
  CheckpointRef,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationTurnOutcome,
  type ProviderRuntimeEvent,
  type ResponseStreamingMode,
} from "@ryco/contracts";
import { Cache, Cause, Deferred, Duration, Effect, Layer, Option, Semaphore, Stream } from "effect";
import type { ProviderThreadHistory } from "../../provider/Services/ProviderAdapter.ts";
import {
  type HistoryActivityIdentity,
  historyMessagesToRestore,
  historyRepairLookups,
  missingHistoryActivities,
} from "../providerHistoryRecovery.ts";
import { scanAssistantText, splitBufferedAssistantText } from "@ryco/shared/assistantStreaming";
import { makeDrainableWorker } from "@ryco/shared/DrainableWorker";
import { losslessBackpressureQueuePolicy } from "@ryco/shared/QueuePolicy";
import {
  subagentMessageActivityId,
  taskProgressActivityId,
  taskUsageActivityId,
} from "@ryco/shared/latestStateActivities";
import type { ContextWindowActivityPayload } from "@ryco/shared/threadActivityPayloads";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { findThreadSession } from "../../provider/threadSessionLookup.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { findThreadInArray } from "../threadIndex.ts";
import { ThreadBackgroundLivenessService } from "../ThreadBackgroundLiveness.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  type HistoryRecoveryTrigger,
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import { decideHistoryRecovery, type HistoryRecoveryState } from "../historyRecoveryPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { increment, providerRuntimeStaleEventsTotal } from "../../observability/Metrics.ts";
import {
  REASONING_LIVE_FLUSH_INTERVAL_MS,
  ReasoningTracker,
  buildReasoningActivity,
  historyReasoningActivities,
  type ReasoningSegment,
} from "../reasoningActivity.ts";
import { TURN_FINALIZATION_REASON, runtimeTerminalTurnState } from "../turnFinalization.ts";
import {
  expectedRuntimeOf,
  isSupersededRuntimeSessionSet,
  runtimeSessionMismatch,
  type RuntimeSessionMismatch,
} from "../runtimeSessionFence.ts";
import {
  usageLimitIdForTurn,
  usageLimitRecordCommandId,
  usageLimitResetFillCommandId,
} from "@ryco/shared/usageLimit";
import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.activities.ts";
import {
  type ActivityAppendCommand,
  type AssistantSegmentState,
  BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
  BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
  BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
  BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
  type CoalescedActivityGroup,
  type CoalescedActivityWrite,
  HISTORY_RECOVERY_TIMEOUT,
  HISTORY_RECOVERY_TRACKED_THREADS,
  type HeldAssistantDeltaSource,
  type HeldAssistantText,
  LIVE_ASSISTANT_DELTA_FLUSH_INTERVAL,
  LIVE_ASSISTANT_DELTA_FLUSH_THRESHOLD_CHARS,
  type LiveAssistantDeltaBuffer,
  MAX_BUFFERED_ASSISTANT_CHARS,
  MIN_ASSISTANT_RELEASE_INTERVAL_MS,
  NOTHING_HELD,
  PARAGRAPH_SPLIT_OPTIONS,
  type RuntimeIngestionInput,
  STRICT_PROVIDER_LIFECYCLE_GUARD,
  SUBAGENT_MESSAGE_WRITE_INTERVAL_MS,
  TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY,
  TASK_DESCRIPTION_BY_TASK_TTL,
  TASK_PROGRESS_WRITE_INTERVAL_MS,
  TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
  TURN_MESSAGE_IDS_BY_TURN_TTL,
  type TurnStartRequestedDomainEvent,
  assistantSegmentBaseKeyFromEvent,
  assistantSegmentMessageId,
  cappedSubagentMessageText,
  collabReceiverThreadIdsFromRuntimeEvent,
  findMessageById,
  findProposedPlanById,
  findTaskTitleInActivities,
  hasAssistantMessageForTurn,
  hasCheckpointForTurn,
  hasRenderableAssistantText,
  isAssistantTextDeltaEvent,
  isTerminalProjectionTurnState,
  liveAssistantDeltaBufferKey,
  maxCheckpointTurnCount,
  normalizeProposedPlanMarkdown,
  normalizeRuntimeTurnState,
  orchestrationSessionStatusFromRuntimeState,
  proposedPlanIdForTurn,
  proposedPlanIdFromEvent,
  providerCommandId,
  providerTaskKey,
  providerTurnKey,
  rawPayloadThreadId,
  sameId,
  statisticsSpeedField,
  subagentMessageBufferKey,
  taskProgressChangeKey,
  toTurnId,
  truncateActivityText,
  truncateUsageLimitMessage,
} from "./ProviderRuntimeIngestion.helpers.ts";

// scripts/measure-streaming-sqlite.ts loads it from here, at baselines from before the split too.
export { runtimeEventToActivities } from "./ProviderRuntimeIngestion.activities.ts";

const make = Effect.gen(function* () {
  const threadBackgroundLiveness = yield* ThreadBackgroundLivenessService;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const completionReturns = yield* Effect.serviceOption(CompletionReturnRepository);
  const completionObservationEpoch = crypto.randomUUID();
  const serverSettingsService = yield* ServerSettingsService;
  const attachmentConfig = yield* Effect.serviceOption(ServerConfig);
  const attachmentAccess = yield* Effect.serviceOption(WorkspaceAccessPolicy);
  const liveAssistantDeltaBuffers = new Map<string, LiveAssistantDeltaBuffer>();
  const subagentProviderThreadIdsByThread = new Map<string, Set<string>>();
  const subagentMessageTextByKey = new Map<string, string>();
  let nextLiveAssistantDeltaBufferGeneration = 1;
  let enqueueRuntimeInput: ((input: RuntimeIngestionInput) => Effect.Effect<void>) | null = null;

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
  });

  const heldAssistantTextByMessageId = yield* Cache.make<MessageId, HeldAssistantText>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(NOTHING_HELD),
  });

  const assistantSegmentStateByTurnKey = yield* Cache.make<string, AssistantSegmentState>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () =>
      Effect.die(
        new Error("assistant segment state should be read through getOption before initialization"),
      ),
  });

  const bufferedProposedPlanById = yield* Cache.make<string, { text: string; createdAt: string }>({
    capacity: BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });

  const taskDescriptionByTaskKey = yield* Cache.make<string, string>({
    capacity: TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY,
    timeToLive: TASK_DESCRIPTION_BY_TASK_TTL,
    lookup: () => Effect.succeed(""),
  });

  const rememberTaskDescription = (threadId: ThreadId, taskId: string, description: string) =>
    Cache.set(taskDescriptionByTaskKey, providerTaskKey(threadId, taskId), description);

  // Entries are left in place after completion so replayed or duplicate
  // terminal events stay titled; TTL, capacity, and the session-exit sweep
  // bound the cache.
  const lookupTaskDescription = (threadId: ThreadId, taskId: string) =>
    Cache.getOption(taskDescriptionByTaskKey, providerTaskKey(threadId, taskId)).pipe(
      Effect.map((description) =>
        Option.filter(description, (value) => value.length > 0).pipe(Option.getOrUndefined),
      ),
    );

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadShell = Effect.fn("resolveThreadShell")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  /**
   * The thread as the engine holds it in memory. Every raw provider event resolves its thread,
   * and the command model already carries what that takes (session, goal, usage limit, model
   * selection), so the event path needs no SQL read. A deleted thread is not found, as in the
   * projection. Engine doubles without an in-memory model fall back to the SQL shell.
   */
  const resolveLiveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    if (orchestrationEngine.getReadModel === undefined) {
      return yield* resolveThreadShell(threadId);
    }
    const model = yield* orchestrationEngine.getReadModel();
    const thread = findThreadInArray(model.threads, threadId);
    return thread === undefined || thread.deletedAt !== null ? undefined : thread;
  });

  // Narrow projection reads for the event path. Message ends, approvals and turn boundaries need
  // one message, one plan, one turn's assistant state or the request lifecycle rows, never the
  // whole thread; each read happens where the full-thread read used to, so it sees the same rows.
  // Snapshot query doubles without a narrow method fall back to the full thread.
  const loadThreadMessage = (threadId: ThreadId, messageId: MessageId) =>
    projectionSnapshotQuery.getThreadMessageById
      ? projectionSnapshotQuery
          .getThreadMessageById({ threadId, messageId })
          .pipe(Effect.map(Option.getOrUndefined))
      : resolveThreadDetail(threadId).pipe(
          Effect.map((thread) =>
            thread ? findMessageById(thread.messages, messageId) : undefined,
          ),
        );

  const loadTurnHasAssistantMessage = (
    threadId: ThreadId,
    turnId: TurnId,
    options: { readonly streamingOnly: boolean },
  ) =>
    projectionSnapshotQuery.hasThreadAssistantMessageForTurn?.({
      threadId,
      turnId,
      streamingOnly: options.streamingOnly,
    }) ??
    resolveThreadDetail(threadId).pipe(
      Effect.map(
        (thread) =>
          thread !== undefined && hasAssistantMessageForTurn(thread.messages, turnId, options),
      ),
    );

  const loadProposedPlan = (threadId: ThreadId, planId: string) =>
    projectionSnapshotQuery
      .getThreadProposedPlanById?.({ threadId, planId })
      .pipe(Effect.map(Option.getOrUndefined)) ??
    resolveThreadDetail(threadId).pipe(
      Effect.map((thread) =>
        thread ? findProposedPlanById(thread.proposedPlans, planId) : undefined,
      ),
    );

  const loadPendingRequestActivities = (threadId: ThreadId) =>
    projectionSnapshotQuery.listThreadPendingRequestActivities?.(threadId) ??
    resolveThreadDetail(threadId).pipe(Effect.map((thread) => thread?.activities ?? []));

  const loadTaskActivities = (threadId: ThreadId, taskId: string) =>
    projectionSnapshotQuery.listThreadTaskActivities?.({ threadId, taskId }) ??
    resolveThreadDetail(threadId).pipe(Effect.map((thread) => thread?.activities));

  const rememberAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Cache.set(
          turnMessageIdsByTurnKey,
          providerTurnKey(threadId, turnId),
          Option.match(existingIds, {
            onNone: () => new Set([messageId]),
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.add(messageId);
              return nextIds;
            },
          }),
        ),
      ),
    );

  const forgetAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Option.match(existingIds, {
          onNone: () => Effect.void,
          onSome: (ids) => {
            const nextIds = new Set(ids);
            nextIds.delete(messageId);
            if (nextIds.size === 0) {
              return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));
            }
            return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId), nextIds);
          },
        }),
      ),
    );

  const getAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));

  const getAssistantSegmentStateForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId));

  const setAssistantSegmentStateForTurn = (
    threadId: ThreadId,
    turnId: TurnId,
    state: AssistantSegmentState,
  ) => Cache.set(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId), state);

  const clearAssistantSegmentStateForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId));

  const getActiveAssistantMessageIdForTurn = (threadId: ThreadId, turnId: TurnId) =>
    getAssistantSegmentStateForTurn(threadId, turnId).pipe(
      Effect.map((state) =>
        Option.flatMap(state, (entry) =>
          entry.activeMessageId ? Option.some(entry.activeMessageId) : Option.none(),
        ),
      ),
    );

  const startAssistantSegmentForTurn = (input: {
    threadId: ThreadId;
    turnId: TurnId;
    baseKey: string;
  }) =>
    getAssistantSegmentStateForTurn(input.threadId, input.turnId).pipe(
      Effect.flatMap((existingState) =>
        Effect.gen(function* () {
          const nextState = Option.match(existingState, {
            onNone: () => ({
              baseKey: input.baseKey,
              nextSegmentIndex: 1,
              activeMessageId: assistantSegmentMessageId(input.baseKey, 0),
            }),
            onSome: (state) => {
              const segmentIndex = state.baseKey === input.baseKey ? state.nextSegmentIndex : 0;
              const messageId = assistantSegmentMessageId(input.baseKey, segmentIndex);
              return {
                baseKey: input.baseKey,
                nextSegmentIndex: state.baseKey === input.baseKey ? state.nextSegmentIndex + 1 : 1,
                activeMessageId: messageId,
              } satisfies AssistantSegmentState;
            },
          });
          yield* setAssistantSegmentStateForTurn(input.threadId, input.turnId, nextState);
          return nextState.activeMessageId!;
        }),
      ),
    );

  const getOrCreateAssistantMessageId = (input: {
    threadId: ThreadId;
    event: ProviderRuntimeEvent;
    turnId?: TurnId;
  }) =>
    Effect.gen(function* () {
      if (!input.turnId) {
        return assistantSegmentMessageId(assistantSegmentBaseKeyFromEvent(input.event), 0);
      }

      const activeMessageId = yield* getActiveAssistantMessageIdForTurn(
        input.threadId,
        input.turnId,
      );
      if (Option.isSome(activeMessageId)) {
        return activeMessageId.value;
      }

      return yield* startAssistantSegmentForTurn({
        threadId: input.threadId,
        turnId: input.turnId,
        baseKey: assistantSegmentBaseKeyFromEvent(input.event),
      });
    });

  const flushLiveAssistantDeltaBuffer = (input: {
    key: string;
    commandTag: string;
    generation?: number;
  }) =>
    Effect.gen(function* () {
      const buffer = liveAssistantDeltaBuffers.get(input.key);
      if (!buffer || (input.generation !== undefined && buffer.generation !== input.generation)) {
        return false;
      }

      if (buffer.text.length === 0) {
        liveAssistantDeltaBuffers.delete(input.key);
        return false;
      }

      yield* orchestrationEngine
        .dispatch({
          type: "thread.message.assistant.delta",
          commandId: providerCommandId(buffer.event, input.commandTag, String(buffer.messageId)),
          threadId: buffer.threadId,
          messageId: buffer.messageId,
          delta: buffer.text,
          ...(buffer.turnId ? { turnId: buffer.turnId } : {}),
          createdAt: buffer.createdAt,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              const current = liveAssistantDeltaBuffers.get(input.key);
              if (!current || current.generation === buffer.generation) {
                liveAssistantDeltaBuffers.set(input.key, buffer);
              }
            }).pipe(Effect.andThen(Effect.failCause(cause))),
          ),
        );
      // A later switch to paragraph mode continues the Markdown from here.
      yield* noteSentAssistantText(buffer.messageId, buffer.text);
      if (liveAssistantDeltaBuffers.get(input.key) === buffer) {
        liveAssistantDeltaBuffers.delete(input.key);
      }
      return true;
    });

  const flushLiveAssistantDeltaBuffers = (input: { commandTag: string; exceptKey?: string }) =>
    Effect.forEach(
      Array.from(liveAssistantDeltaBuffers.keys()).filter((key) => key !== input.exceptKey),
      (key) => flushLiveAssistantDeltaBuffer({ key, commandTag: input.commandTag }),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);

  const flushLiveAssistantDeltaBuffersSafely = (input: {
    commandTag: string;
    exceptKey?: string;
  }) =>
    flushLiveAssistantDeltaBuffers(input).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider runtime ingestion failed to flush live assistant deltas", {
          commandTag: input.commandTag,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const clearLiveAssistantDeltaBuffersForThread = (threadId: ThreadId) =>
    Effect.sync(() => {
      for (const [key, buffer] of liveAssistantDeltaBuffers) {
        if (buffer.threadId === threadId) {
          liveAssistantDeltaBuffers.delete(key);
        }
      }
    });

  const scheduleLiveAssistantDeltaFlush = (key: string, generation: number) =>
    Effect.gen(function* () {
      const enqueue = enqueueRuntimeInput;
      if (!enqueue) {
        return;
      }
      yield* Effect.forkScoped(
        Effect.sleep(LIVE_ASSISTANT_DELTA_FLUSH_INTERVAL).pipe(
          Effect.andThen(
            enqueue({
              source: "liveAssistantFlush",
              key,
              generation,
            }),
          ),
        ),
      );
    }).pipe(Effect.asVoid);

  const appendLiveAssistantDelta = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    delta: string;
    createdAt: string;
  }) =>
    Effect.gen(function* () {
      const key = liveAssistantDeltaBufferKey(input.threadId, input.messageId);
      yield* flushLiveAssistantDeltaBuffersSafely({
        commandTag: "assistant-delta-flush-before-interleaved-assistant-delta",
        exceptKey: key,
      });

      const existingBuffer = liveAssistantDeltaBuffers.get(key);
      if (existingBuffer) {
        liveAssistantDeltaBuffers.set(key, {
          ...existingBuffer,
          event: input.event,
          text: `${existingBuffer.text}${input.delta}`,
        });
      } else {
        const generation = nextLiveAssistantDeltaBufferGeneration;
        nextLiveAssistantDeltaBufferGeneration += 1;
        liveAssistantDeltaBuffers.set(key, {
          event: input.event,
          threadId: input.threadId,
          messageId: input.messageId,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          text: input.delta,
          createdAt: input.createdAt,
          generation,
        });
        yield* scheduleLiveAssistantDeltaFlush(key, generation);
      }

      const buffer = liveAssistantDeltaBuffers.get(key);
      if (buffer && buffer.text.length >= LIVE_ASSISTANT_DELTA_FLUSH_THRESHOLD_CHARS) {
        yield* flushLiveAssistantDeltaBuffer({
          key,
          commandTag: "assistant-delta-coalesced-threshold",
        });
      }
    });

  const rememberSubagentProviderThreadIds = (threadId: ThreadId, event: ProviderRuntimeEvent) =>
    Effect.sync(() => {
      const receiverThreadIds = collabReceiverThreadIdsFromRuntimeEvent(event);
      if (receiverThreadIds.length === 0) {
        return;
      }
      const key = String(threadId);
      const existing = subagentProviderThreadIdsByThread.get(key) ?? new Set<string>();
      for (const receiverThreadId of receiverThreadIds) {
        existing.add(receiverThreadId);
      }
      subagentProviderThreadIdsByThread.set(key, existing);
    });

  const forgetSubagentProviderThreadIds = (threadId: ThreadId) =>
    Effect.sync(() => {
      subagentProviderThreadIdsByThread.delete(String(threadId));
    });

  const isKnownSubagentProviderThread = (
    threadId: ThreadId,
    providerThreadId: string | undefined,
  ) => {
    if (!providerThreadId) {
      return false;
    }
    return subagentProviderThreadIdsByThread.get(String(threadId))?.has(providerThreadId) ?? false;
  };

  const coalescedActivityWrites = new Map<string, CoalescedActivityWrite>();
  let nextCoalescedActivityGeneration = 1;

  // An interval measured on a clock that stepped backwards counts as elapsed,
  // so a pending write is never held for the size of the step.
  const writeIntervalElapsed = (entry: CoalescedActivityWrite, nowMs: number) => {
    const sinceLastWriteMs = nowMs - entry.writtenAtMs;
    return sinceLastWriteMs < 0 || sinceLastWriteMs >= entry.intervalMs;
  };

  const writeCoalescedActivity = (
    entry: CoalescedActivityWrite,
    command: ActivityAppendCommand,
    changeKey: string,
  ) => {
    entry.pending = null;
    entry.writtenChangeKey = changeKey;
    entry.writtenAtMs = Date.now();
    return orchestrationEngine.dispatch(command).pipe(Effect.asVoid);
  };

  const scheduleCoalescedActivityFlush = (key: string, entry: CoalescedActivityWrite) =>
    Effect.gen(function* () {
      const enqueue = enqueueRuntimeInput;
      if (!enqueue || entry.flushScheduled) {
        return;
      }
      entry.flushScheduled = true;
      const waitMs = Math.min(
        entry.intervalMs,
        Math.max(1, entry.writtenAtMs + entry.intervalMs - Date.now()),
      );
      yield* Effect.forkScoped(
        Effect.sleep(Duration.millis(waitMs)).pipe(
          Effect.andThen(
            enqueue({
              source: "coalescedActivityFlush",
              key,
              generation: entry.generation,
            }),
          ),
        ),
      );
    });

  const flushCoalescedActivity = (input: { key: string; generation: number }) =>
    Effect.gen(function* () {
      const entry = coalescedActivityWrites.get(input.key);
      if (!entry || entry.generation !== input.generation) {
        return;
      }
      entry.flushScheduled = false;
      const pending = entry.pending;
      if (pending === null) {
        return;
      }
      // A write since this timer was set restarted the interval.
      if (!writeIntervalElapsed(entry, Date.now())) {
        yield* scheduleCoalescedActivityFlush(input.key, entry);
        return;
      }
      yield* writeCoalescedActivity(entry, pending, entry.writtenChangeKey);
    });

  /**
   * Persists a latest-state activity (an upsert by activity id) at most once per
   * interval. The first write of an activity, a write whose `changeKey` differs
   * from the last persisted one, and a write after a quiet interval go through
   * at once; the rest replace the pending write, which a timer then persists.
   */
  const offerCoalescedActivity = (input: {
    group: CoalescedActivityGroup;
    threadId: ThreadId;
    intervalMs: number;
    changeKey: string;
    command: ActivityAppendCommand;
  }) =>
    Effect.gen(function* () {
      const key = input.command.activity.id;
      const existing = coalescedActivityWrites.get(key);
      if (existing === undefined) {
        const created: CoalescedActivityWrite = {
          group: input.group,
          threadId: input.threadId,
          intervalMs: input.intervalMs,
          generation: nextCoalescedActivityGeneration++,
          pending: null,
          writtenChangeKey: input.changeKey,
          writtenAtMs: 0,
          flushScheduled: false,
        };
        coalescedActivityWrites.set(key, created);
        yield* writeCoalescedActivity(created, input.command, input.changeKey);
        return;
      }
      if (
        existing.writtenChangeKey !== input.changeKey ||
        writeIntervalElapsed(existing, Date.now())
      ) {
        yield* writeCoalescedActivity(existing, input.command, input.changeKey);
        return;
      }
      existing.pending = input.command;
      yield* scheduleCoalescedActivityFlush(key, existing);
    });

  /** Forgets an activity's write state; returns the write it never persisted. */
  const takePendingCoalescedActivity = (key: string): ActivityAppendCommand | null => {
    const entry = coalescedActivityWrites.get(key);
    if (entry === undefined) {
      return null;
    }
    coalescedActivityWrites.delete(key);
    return entry.pending;
  };

  // A failed flush must not abort the lifecycle handling it runs inside.
  const dispatchPendingCoalescedActivity = (command: ActivityAppendCommand) =>
    orchestrationEngine.dispatch(command).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("provider runtime ingestion failed to flush a coalesced activity", {
              activityId: command.activity.id,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  /** Persists what is still pending for the given activities, then forgets them. */
  const settleCoalescedActivities = (keys: ReadonlyArray<string>) =>
    Effect.suspend(() =>
      Effect.forEach(
        keys.flatMap((key) => {
          const pending = takePendingCoalescedActivity(key);
          return pending === null ? [] : [pending];
        }),
        dispatchPendingCoalescedActivity,
        { discard: true },
      ),
    );

  const settleCoalescedActivitiesForThread = (threadId: ThreadId, group: CoalescedActivityGroup) =>
    Effect.suspend(() =>
      settleCoalescedActivities(
        [...coalescedActivityWrites]
          .filter(([, entry]) => entry.threadId === threadId && entry.group === group)
          .map(([key]) => key),
      ),
    );

  const settleTaskProgressForTask = (threadId: ThreadId, taskId: string) =>
    settleCoalescedActivities([
      taskProgressActivityId(threadId, taskId),
      taskUsageActivityId(threadId, taskId),
    ]);

  /** Persists every pending write without ending its activity's interval tracking. */
  const flushAllCoalescedActivities = Effect.suspend(() =>
    Effect.forEach(
      [...coalescedActivityWrites.values()].flatMap((entry) => {
        const pending = entry.pending;
        if (pending === null) {
          return [];
        }
        entry.pending = null;
        entry.writtenAtMs = Date.now();
        return [pending];
      }),
      dispatchPendingCoalescedActivity,
      { discard: true },
    ),
  );

  const subagentMessageUpsertCommand = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    subagentId?: string | undefined;
    providerThreadId: string;
    providerItemId: string;
    text: string;
    streaming: boolean;
    createdAt: string;
  }): ActivityAppendCommand => {
    const commandKey = `${input.providerThreadId}:${input.providerItemId}`;
    return {
      type: "thread.activity.append",
      commandId: providerCommandId(input.event, "subagent-message-upsert", commandKey),
      threadId: input.threadId,
      activity: {
        id: subagentMessageActivityId({
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          providerItemId: input.providerItemId,
        }),
        createdAt: input.createdAt,
        tone: "info",
        kind: "agent.message",
        summary: input.streaming ? "Agent message streaming" : "Agent message",
        payload: {
          itemType: "assistant_message",
          text: truncateActivityText(input.text),
          streaming: input.streaming,
          providerThreadId: input.providerThreadId,
          providerItemId: input.providerItemId,
          ...(input.subagentId ? { subagentId: input.subagentId } : {}),
          ...(input.event.providerRefs ? { providerRefs: input.event.providerRefs } : {}),
        },
        turnId: toTurnId(input.event.turnId) ?? null,
      },
      createdAt: input.createdAt,
    };
  };

  // The full text keeps accumulating here on every delta; only its persistence
  // is paced, so a completion or flush always writes the whole message.
  const appendSubagentMessageDelta = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    subagentId?: string | undefined;
    providerThreadId: string;
    providerItemId: string;
    delta: string;
    createdAt: string;
  }) =>
    Effect.gen(function* () {
      const key = subagentMessageBufferKey({
        threadId: input.threadId,
        providerThreadId: input.providerThreadId,
        providerItemId: input.providerItemId,
      });
      const text = cappedSubagentMessageText(
        `${subagentMessageTextByKey.get(key) ?? ""}${input.delta}`,
      );
      subagentMessageTextByKey.set(key, text);
      yield* offerCoalescedActivity({
        group: "subagent-message",
        threadId: input.threadId,
        intervalMs: SUBAGENT_MESSAGE_WRITE_INTERVAL_MS,
        changeKey: "streaming",
        command: subagentMessageUpsertCommand({ ...input, text, streaming: true }),
      });
    });

  const completeSubagentMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    subagentId?: string | undefined;
    providerThreadId: string;
    providerItemId: string;
    fallbackText?: string | undefined;
    createdAt: string;
  }) =>
    Effect.gen(function* () {
      const key = subagentMessageBufferKey({
        threadId: input.threadId,
        providerThreadId: input.providerThreadId,
        providerItemId: input.providerItemId,
      });
      const bufferedText = subagentMessageTextByKey.get(key) ?? "";
      subagentMessageTextByKey.delete(key);
      // The completed message below carries everything the pending write would.
      const pendingStreamingWrite = takePendingCoalescedActivity(
        subagentMessageActivityId({
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          providerItemId: input.providerItemId,
        }),
      );
      const fallbackText = input.fallbackText ?? "";
      const text =
        hasRenderableAssistantText(fallbackText) && fallbackText.length >= bufferedText.length
          ? fallbackText
          : bufferedText;
      if (!hasRenderableAssistantText(text)) {
        if (pendingStreamingWrite !== null) {
          yield* dispatchPendingCoalescedActivity(pendingStreamingWrite);
        }
        return;
      }
      yield* orchestrationEngine.dispatch(
        subagentMessageUpsertCommand({
          ...input,
          text,
          streaming: false,
        }),
      );
    });

  const bufferedSubagentProviderItemIds = (input: {
    threadId: ThreadId;
    providerThreadId: string;
  }): ReadonlyArray<string> => {
    const prefix = subagentMessageBufferKey({
      threadId: input.threadId,
      providerThreadId: input.providerThreadId,
      providerItemId: "",
    });
    const providerItemIds = new Set<string>();
    for (const key of subagentMessageTextByKey.keys()) {
      if (key.startsWith(prefix)) {
        providerItemIds.add(key.slice(prefix.length));
      }
    }
    return [...providerItemIds];
  };

  // Drops the thread's unfinished child messages. What was streamed so far is
  // persisted first, so the stored text ends where the stream did.
  const clearSubagentMessageBuffersForThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const prefix = `${threadId}:`;
      for (const key of subagentMessageTextByKey.keys()) {
        if (key.startsWith(prefix)) {
          subagentMessageTextByKey.delete(key);
        }
      }
      yield* settleCoalescedActivitiesForThread(threadId, "subagent-message");
    });

  const readHeldAssistantText = (messageId: MessageId) =>
    Cache.getOption(heldAssistantTextByMessageId, messageId).pipe(
      Effect.map(Option.getOrElse(() => NOTHING_HELD)),
    );

  const setHeldAssistantText = (messageId: MessageId, held: HeldAssistantText) =>
    Cache.set(heldAssistantTextByMessageId, messageId, held);

  /** Records text sent as tokens, so a later switch to paragraphs starts where it ended. */
  const noteSentAssistantText = (messageId: MessageId, text: string) =>
    Effect.gen(function* () {
      const held = yield* readHeldAssistantText(messageId);
      yield* setHeldAssistantText(messageId, { ...held, scan: scanAssistantText(text, held.scan) });
    });

  /** Hands over held text, for a switch to token mode. */
  const takeHeldAssistantText = (messageId: MessageId) =>
    Effect.gen(function* () {
      const held = yield* readHeldAssistantText(messageId);
      if (held.text.length > 0) yield* setHeldAssistantText(messageId, { ...held, text: "" });
      return held.text;
    });

  const dispatchAssistantDelta = (input: {
    messageId: MessageId;
    source: HeldAssistantDeltaSource;
    commandTag: string;
    text: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.message.assistant.delta",
      commandId: providerCommandId(input.source.event, input.commandTag, String(input.messageId)),
      threadId: input.source.threadId,
      messageId: input.messageId,
      delta: input.text,
      ...(input.source.turnId ? { turnId: input.source.turnId } : {}),
      createdAt: input.source.createdAt,
    });

  /** Sends everything held as one delta. The held state moves on only once it is persisted. */
  const sendAllHeldAssistantText = (input: {
    messageId: MessageId;
    held: HeldAssistantText;
    source: HeldAssistantDeltaSource;
    commandTag: string;
    releasedAtMs?: number;
  }) =>
    Effect.gen(function* () {
      yield* dispatchAssistantDelta({
        messageId: input.messageId,
        source: input.source,
        commandTag: input.commandTag,
        text: input.held.text,
      });
      yield* setHeldAssistantText(input.messageId, {
        ...input.held,
        text: "",
        scan: scanAssistantText(input.held.text, input.held.scan),
        ...(input.releasedAtMs !== undefined ? { releasedAtMs: input.releasedAtMs } : {}),
      });
    });

  const scheduleHeldParagraphFlush = (
    messageId: MessageId,
    held: HeldAssistantText,
    waitMs: number,
  ) =>
    Effect.gen(function* () {
      const enqueue = enqueueRuntimeInput;
      if (!enqueue || held.flushScheduled) return held;
      const scheduled: HeldAssistantText = { ...held, flushScheduled: true };
      yield* setHeldAssistantText(messageId, scheduled);
      yield* Effect.forkScoped(
        Effect.sleep(Duration.millis(waitMs)).pipe(
          Effect.andThen(enqueue({ source: "assistantParagraphFlush", messageId })),
        ),
      );
      return scheduled;
    });

  /**
   * Sends the finished blocks of a message's held text, at most once per interval. Within
   * the interval a trailing release is queued instead, so a finished block never waits for
   * a later delta. The held state moves on only once the release is persisted.
   */
  const releaseHeldParagraphs = (
    messageId: MessageId,
    held: HeldAssistantText,
    commandTag: string,
  ) =>
    Effect.gen(function* () {
      if (held.source === undefined || !hasRenderableAssistantText(held.text)) return held;
      // Date.now(), not the event time: some providers stamp every delta of a part with
      // the part's start, so event times cannot measure the gap between releases.
      const nowMs = Date.now();
      const sinceReleaseMs =
        held.releasedAtMs === undefined ? undefined : nowMs - held.releasedAtMs;
      // A clock that stepped backwards counts as elapsed, so a block is never held for it.
      if (
        sinceReleaseMs !== undefined &&
        sinceReleaseMs >= 0 &&
        sinceReleaseMs < MIN_ASSISTANT_RELEASE_INTERVAL_MS
      ) {
        return yield* scheduleHeldParagraphFlush(
          messageId,
          held,
          MIN_ASSISTANT_RELEASE_INTERVAL_MS - sinceReleaseMs,
        );
      }
      const { ready, rest, restScan } = splitBufferedAssistantText(
        held.text,
        held.scan,
        PARAGRAPH_SPLIT_OPTIONS,
      );
      // What stays held must fit the memory cap; otherwise the whole text spills instead.
      if (!hasRenderableAssistantText(ready) || rest.length > MAX_BUFFERED_ASSISTANT_CHARS) {
        return held;
      }
      yield* dispatchAssistantDelta({ messageId, source: held.source, commandTag, text: ready });
      const released: HeldAssistantText = {
        ...held,
        text: rest,
        scan: restScan,
        releasedAtMs: nowMs,
      };
      yield* setHeldAssistantText(messageId, released);
      return released;
    });

  /**
   * Holds a delta in paragraph or turn mode and sends what is due: finished blocks in
   * paragraph mode, and everything held once it outgrows the memory cap.
   */
  const appendHeldAssistantText = (input: {
    messageId: MessageId;
    delta: string;
    mode: Exclude<ResponseStreamingMode, "token">;
    source: HeldAssistantDeltaSource;
  }) =>
    Effect.gen(function* () {
      const previous = yield* readHeldAssistantText(input.messageId);
      let held: HeldAssistantText = {
        ...previous,
        text: `${previous.text}${input.delta}`,
        source: input.source,
      };
      // Kept before any release, so a release that fails to persist loses nothing.
      yield* setHeldAssistantText(input.messageId, held);
      if (input.mode === "paragraph") {
        held = yield* releaseHeldParagraphs(input.messageId, held, "assistant-delta-paragraph");
      }
      if (held.text.length <= MAX_BUFFERED_ASSISTANT_CHARS) return;

      // Safety valve: send everything held to cap memory.
      yield* sendAllHeldAssistantText({
        messageId: input.messageId,
        held,
        source: input.source,
        commandTag: "assistant-delta-buffer-spill",
        ...(input.mode === "paragraph" ? { releasedAtMs: Date.now() } : {}),
      });
    });

  const readResponseStreamingMode = Effect.map(
    serverSettingsService.getSettings,
    (settings) => settings.responseStreamingMode,
  );

  /** Runs a queued paced release, unless the message completed or left paragraph mode. */
  const flushHeldParagraphs = (input: { messageId: MessageId }) =>
    Effect.gen(function* () {
      const current = yield* Cache.getOption(heldAssistantTextByMessageId, input.messageId);
      if (Option.isNone(current) || !current.value.flushScheduled) return;
      const held: HeldAssistantText = { ...current.value, flushScheduled: false };
      yield* setHeldAssistantText(input.messageId, held);
      if ((yield* readResponseStreamingMode) !== "paragraph") return;
      yield* releaseHeldParagraphs(input.messageId, held, "assistant-delta-paragraph-paced");
    });

  const clearHeldAssistantText = (messageId: MessageId) =>
    Cache.invalidate(heldAssistantTextByMessageId, messageId);

  const appendBufferedProposedPlan = (planId: string, delta: string, createdAt: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) => {
        const existing = Option.getOrUndefined(existingEntry);
        return Cache.set(bufferedProposedPlanById, planId, {
          text: `${existing?.text ?? ""}${delta}`,
          createdAt:
            existing?.createdAt && existing.createdAt.length > 0 ? existing.createdAt : createdAt,
        });
      }),
    );

  const takeBufferedProposedPlan = (planId: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) =>
        Cache.invalidate(bufferedProposedPlanById, planId).pipe(
          Effect.as(Option.getOrUndefined(existingEntry)),
        ),
      ),
    );

  const clearBufferedProposedPlan = (planId: string) =>
    Cache.invalidate(bufferedProposedPlanById, planId);

  const clearAssistantMessageState = (messageId: MessageId) => clearHeldAssistantText(messageId);

  const flushBufferedAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const held = yield* readHeldAssistantText(input.messageId);
      if (!hasRenderableAssistantText(held.text)) {
        if (held.text.length > 0)
          yield* setHeldAssistantText(input.messageId, { ...held, text: "" });
        return false;
      }

      yield* sendAllHeldAssistantText({
        messageId: input.messageId,
        held,
        source: input,
        commandTag: input.commandTag,
      });
      return true;
    });

  const flushBufferedAssistantMessagesForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const assistantMessageIds = yield* getAssistantMessageIdsForTurn(
        input.threadId,
        input.turnId,
      );
      const flushedMessageIds = new Set<MessageId>();
      yield* Effect.forEach(
        assistantMessageIds,
        (messageId) =>
          flushBufferedAssistantMessage({
            event: input.event,
            threadId: input.threadId,
            messageId,
            turnId: input.turnId,
            createdAt: input.createdAt,
            commandTag: input.commandTag,
          }).pipe(
            Effect.tap((flushed) =>
              flushed ? Effect.sync(() => flushedMessageIds.add(messageId)) : Effect.void,
            ),
          ),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      return flushedMessageIds;
    });

  const finalizeAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    fallbackText?: string;
    hasProjectedMessage?: boolean;
  }) =>
    Effect.gen(function* () {
      const held = yield* readHeldAssistantText(input.messageId);
      // The provider's fallback text fills only a message with nothing held.
      const text = held.text.length > 0 ? held.text : (input.fallbackText ?? "");
      const hasRenderableText = hasRenderableAssistantText(text);

      if (hasRenderableText) {
        yield* dispatchAssistantDelta({
          messageId: input.messageId,
          source: input,
          commandTag: input.finalDeltaCommandTag,
          text,
        });
        // Sent: a completion retried after the dispatch below fails must not append it again.
        if (held.text.length > 0) {
          yield* setHeldAssistantText(input.messageId, { ...held, text: "" });
        }
      }

      if (input.hasProjectedMessage || hasRenderableText) {
        // Read the complete projection after flushing, so split/streamed manifests work too.
        // Replayed terminal events must not replace an already delivered attachment snapshot.
        let delivery: { text: string; attachments: ReadonlyArray<ChatAttachment> } | undefined;
        if (Option.isSome(attachmentConfig) && Option.isSome(attachmentAccess)) {
          delivery = yield* Effect.gen(function* () {
            const message = yield* loadThreadMessage(input.threadId, input.messageId);
            if (!message?.streaming) return undefined;
            const parsed = parseAssistantDelivery(message.text);
            if (!parsed) return undefined;
            const context = Option.getOrUndefined(
              yield* projectionSnapshotQuery.getThreadCheckpointContext(input.threadId),
            );
            const cwd = context?.worktreePath ?? context?.workspaceRoot;
            const attachments: ChatAttachment[] = [];
            let remainingBytes = PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES;
            for (const [index, file] of parsed.files.entries()) {
              const result = yield* Effect.gen(function* () {
                if (!cwd) return yield* new AssistantAttachmentError();
                const authorizedCwd = yield* attachmentAccess.value.assertExistingPath({
                  path: cwd,
                  operation: "assistant file delivery",
                });
                return yield* Effect.tryPromise({
                  try: (signal) =>
                    persistAssistantAttachment({
                      attachmentsDir: attachmentConfig.value.attachmentsDir,
                      cwd: authorizedCwd,
                      threadId: input.threadId,
                      deliveryId: `${input.messageId}:${index}`,
                      file,
                      remainingBytes,
                      signal,
                    }),
                  catch: () => new AssistantAttachmentError(),
                });
              }).pipe(Effect.option);
              if (Option.isSome(result)) {
                attachments.push(result.value);
                remainingBytes -= result.value.sizeBytes ?? 0;
              } else {
                parsed.errors.push(
                  `Attachment ${index + 1} could not be delivered. Check that the file exists inside this thread's workspace, is not a link, and fits the attachment limits.`,
                );
              }
            }
            return { text: formatAssistantDeliveryText(parsed.text, parsed.errors), attachments };
          }).pipe(Effect.catch(() => Effect.succeed(undefined)));
        }
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: providerCommandId(input.event, input.commandTag, String(input.messageId)),
          threadId: input.threadId,
          messageId: input.messageId,
          ...delivery,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }
      yield* clearAssistantMessageState(input.messageId);
    });

  const finalizeActiveAssistantSegmentForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    hasProjectedMessage: boolean;
    flushedMessageIds?: ReadonlySet<MessageId>;
  }) =>
    Effect.gen(function* () {
      const activeMessageId = yield* getActiveAssistantMessageIdForTurn(
        input.threadId,
        input.turnId,
      );
      if (Option.isNone(activeMessageId)) {
        return;
      }

      yield* finalizeAssistantMessage({
        event: input.event,
        threadId: input.threadId,
        messageId: activeMessageId.value,
        turnId: input.turnId,
        createdAt: input.createdAt,
        commandTag: input.commandTag,
        finalDeltaCommandTag: input.finalDeltaCommandTag,
        hasProjectedMessage:
          input.hasProjectedMessage ||
          (input.flushedMessageIds?.has(activeMessageId.value) ?? false),
      });
      yield* forgetAssistantMessageId(input.threadId, input.turnId, activeMessageId.value);

      const state = yield* getAssistantSegmentStateForTurn(input.threadId, input.turnId);
      if (Option.isSome(state)) {
        yield* setAssistantSegmentStateForTurn(input.threadId, input.turnId, {
          ...state.value,
          activeMessageId: null,
        });
      }
    });

  const upsertProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    planId: string;
    turnId?: TurnId;
    planMarkdown: string | undefined;
    createdAt: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const planMarkdown = normalizeProposedPlanMarkdown(input.planMarkdown);
      if (!planMarkdown) {
        return;
      }

      const existingPlan = yield* loadProposedPlan(input.threadId, input.planId);
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: providerCommandId(input.event, "proposed-plan-upsert", input.planId),
        threadId: input.threadId,
        proposedPlan: {
          id: input.planId,
          turnId: input.turnId ?? null,
          planMarkdown,
          implementedAt: existingPlan?.implementedAt ?? null,
          implementationThreadId: existingPlan?.implementationThreadId ?? null,
          createdAt: existingPlan?.createdAt ?? input.createdAt,
          updatedAt: input.updatedAt,
        },
        createdAt: input.updatedAt,
      });
    });

  const finalizeBufferedProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    planId: string;
    turnId?: TurnId;
    fallbackMarkdown?: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const bufferedPlan = yield* takeBufferedProposedPlan(input.planId);
      const bufferedMarkdown = normalizeProposedPlanMarkdown(bufferedPlan?.text);
      const fallbackMarkdown = normalizeProposedPlanMarkdown(input.fallbackMarkdown);
      const planMarkdown = bufferedMarkdown ?? fallbackMarkdown;
      if (!planMarkdown) {
        return;
      }

      yield* upsertProposedPlan({
        event: input.event,
        threadId: input.threadId,
        planId: input.planId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        planMarkdown,
        createdAt:
          bufferedPlan?.createdAt && bufferedPlan.createdAt.length > 0
            ? bufferedPlan.createdAt
            : input.updatedAt,
        updatedAt: input.updatedAt,
      });
      yield* clearBufferedProposedPlan(input.planId);
    });

  const clearTurnStateForSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const prefix = `${threadId}:`;
      const proposedPlanPrefix = `plan:${threadId}:`;
      const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
      const assistantSegmentKeys = Array.from(yield* Cache.keys(assistantSegmentStateByTurnKey));
      const proposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));
      yield* Effect.forEach(
        turnKeys,
        (key) =>
          Effect.gen(function* () {
            if (!key.startsWith(prefix)) {
              return;
            }

            const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
            if (Option.isSome(messageIds)) {
              yield* Effect.forEach(messageIds.value, clearAssistantMessageState, {
                concurrency: 1,
              }).pipe(Effect.asVoid);
            }

            yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
          }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        assistantSegmentKeys,
        (key) =>
          key.startsWith(prefix)
            ? Cache.invalidate(assistantSegmentStateByTurnKey, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        proposedPlanKeys,
        (key) =>
          key.startsWith(proposedPlanPrefix)
            ? Cache.invalidate(bufferedProposedPlanById, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      const taskDescriptionKeys = Array.from(yield* Cache.keys(taskDescriptionByTaskKey));
      yield* Effect.forEach(
        taskDescriptionKeys,
        (key) =>
          key.startsWith(prefix) ? Cache.invalidate(taskDescriptionByTaskKey, key) : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* clearLiveAssistantDeltaBuffersForThread(threadId);
    });

  const getSourceProposedPlanReferenceForPendingTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForPendingTurnStart",
  )(function* (threadId: ThreadId) {
    const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
      threadId,
    });
    if (Option.isNone(pendingTurnStart)) {
      return null;
    }

    const sourceThreadId = pendingTurnStart.value.sourceProposedPlanThreadId;
    const sourcePlanId = pendingTurnStart.value.sourceProposedPlanId;
    if (sourceThreadId === null || sourcePlanId === null) {
      return null;
    }

    return {
      sourceThreadId,
      sourcePlanId,
    } as const;
  });

  const getExpectedProviderTurnIdForThread = Effect.fn("getExpectedProviderTurnIdForThread")(
    function* (threadId: ThreadId) {
      const session = yield* findThreadSession(providerService, threadId);
      return session?.activeTurnId;
    },
  );

  const getSourceProposedPlanReferenceForAcceptedTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForAcceptedTurnStart",
  )(function* (threadId: ThreadId, eventTurnId: TurnId | undefined) {
    if (eventTurnId === undefined) {
      return null;
    }

    const expectedTurnId = yield* getExpectedProviderTurnIdForThread(threadId);
    if (!sameId(expectedTurnId, eventTurnId)) {
      return null;
    }

    return yield* getSourceProposedPlanReferenceForPendingTurnStart(threadId);
  });

  const markSourceProposedPlanImplemented = Effect.fn("markSourceProposedPlanImplemented")(
    function* (
      event: ProviderRuntimeEvent,
      sourceThreadId: ThreadId,
      sourcePlanId: OrchestrationProposedPlanId,
      implementationThreadId: ThreadId,
      implementedAt: string,
    ) {
      // The live thread (in memory) and its one plan row: never every message and activity.
      const sourceThread = yield* resolveLiveThread(sourceThreadId);
      if (!sourceThread) return;
      const sourcePlan = yield* loadProposedPlan(sourceThreadId, sourcePlanId);
      if (!sourcePlan || sourcePlan.implementedAt !== null) {
        return;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: providerCommandId(
          event,
          "source-proposed-plan-implemented",
          `${sourceThreadId}:${sourcePlanId}:${implementationThreadId}`,
        ),
        threadId: sourceThread.id,
        proposedPlan: {
          ...sourcePlan,
          implementedAt,
          implementationThreadId,
          updatedAt: implementedAt,
        },
        createdAt: implementedAt,
      });
    },
  );

  // Reasoning blocks: one upserted activity per block (see reasoningActivity.ts).
  const reasoningTracker = new ReasoningTracker();

  const writeReasoningActivity = (segment: ReasoningSegment, final: boolean) =>
    Effect.gen(function* () {
      const commandId = providerCommandId(
        segment.lastEvent,
        "reasoning-activity",
        `${segment.activityId}:${segment.flushCount}`,
      );
      const activity = buildReasoningActivity(segment, { final });
      reasoningTracker.markWritten(segment);
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId,
        threadId: segment.threadId,
        activity,
        createdAt: segment.updatedAt,
      });
    });

  const scheduleReasoningFlush = (segment: ReasoningSegment) =>
    Effect.gen(function* () {
      const enqueue = enqueueRuntimeInput;
      if (!enqueue || segment.flushScheduled) {
        return;
      }
      segment.flushScheduled = true;
      yield* Effect.forkScoped(
        Effect.sleep(Duration.millis(REASONING_LIVE_FLUSH_INTERVAL_MS)).pipe(
          Effect.andThen(
            enqueue({ source: "reasoningFlush", key: segment.key, generation: segment.generation }),
          ),
        ),
      );
    }).pipe(Effect.asVoid);

  const flushReasoningSegment = (input: { key: string; generation: number }) =>
    Effect.gen(function* () {
      const segment = reasoningTracker.get(input.key);
      if (!segment || segment.generation !== input.generation || !segment.dirty) {
        if (segment && segment.generation === input.generation) segment.flushScheduled = false;
        return;
      }
      yield* writeReasoningActivity(segment, false);
    });

  const writeClosedReasoning = (segments: ReadonlyArray<ReasoningSegment>) =>
    Effect.forEach(segments, (segment) => writeReasoningActivity(segment, true), {
      discard: true,
    });

  /**
   * Opens, streams and closes reasoning blocks for one runtime event. Runs
   * before assistant text is handled so a block closes ahead of the
   * paragraph it led to.
   */
  const projectReasoningForEvent = (
    event: ProviderRuntimeEvent,
    threadId: ThreadId,
    interruptedTurnId: TurnId | undefined,
  ) =>
    Effect.gen(function* () {
      const turnId = toTurnId(event.turnId) ?? null;
      if (
        event.type === "content.delta" &&
        (event.payload.streamKind === "reasoning_text" ||
          event.payload.streamKind === "reasoning_summary_text")
      ) {
        if (event.payload.delta.length === 0) return;
        const { segment, created } = reasoningTracker.appendDelta({
          event,
          threadId,
          streamKind: event.payload.streamKind,
          delta: event.payload.delta,
          summaryIndex: event.payload.summaryIndex,
        });
        if (created) {
          yield* writeReasoningActivity(segment, false);
        } else {
          yield* scheduleReasoningFlush(segment);
        }
        return;
      }
      if (event.type === "item.started" && event.payload.itemType === "reasoning") {
        const { segment, created } = reasoningTracker.open(threadId, event);
        if (created) yield* writeReasoningActivity(segment, false);
        return;
      }
      if (event.type === "item.completed" && event.payload.itemType === "reasoning") {
        yield* writeReasoningActivity(reasoningTracker.complete(threadId, event), true);
        return;
      }
      if (
        (event.type === "content.delta" && event.payload.streamKind === "assistant_text") ||
        (event.type === "item.started" && event.payload.itemType !== "reasoning") ||
        event.type === "request.opened" ||
        event.type === "user-input.requested"
      ) {
        yield* writeClosedReasoning(reasoningTracker.closeImplicit(threadId, turnId, event));
        return;
      }
      if (event.type === "turn.completed" || event.type === "turn.aborted") {
        yield* writeClosedReasoning(reasoningTracker.closeTurn(threadId, turnId, event));
        return;
      }
      if (interruptedTurnId !== undefined) {
        yield* writeClosedReasoning(reasoningTracker.closeTurn(threadId, interruptedTurnId, event));
      }
      if (event.type === "session.exited") {
        yield* writeClosedReasoning(reasoningTracker.closeThread(threadId, event));
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("provider runtime ingestion failed to project reasoning", {
              eventId: event.eventId,
              eventType: event.type,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const dispatchUsageLimitRecord = (
    command: Omit<Extract<OrchestrationCommand, { type: "thread.usage-limit.record" }>, "type">,
  ) =>
    orchestrationEngine.dispatch({ type: "thread.usage-limit.record", ...command }).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logDebug("provider runtime ingestion skipped usage-limit record", {
              threadId: command.threadId,
              limitId: command.limitId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const reportStaleRuntimeEvent = (
    event: ProviderRuntimeEvent,
    reason: RuntimeSessionMismatch | "runtime-session-superseded",
  ) =>
    Effect.gen(function* () {
      yield* increment(providerRuntimeStaleEventsTotal, {
        provider: event.provider,
        eventType: event.type,
        reason,
      });
      yield* Effect.logDebug("provider.runtime-event.stale-dropped", {
        provider: event.provider,
        eventType: event.type,
        reason,
      });
    });

  /**
   * A session update derived from `event`, fenced to the runtime that emitted it. False when
   * that runtime was replaced or stopped after the stale-event pre-check: the event is then as
   * stale as one the pre-check drops, and nothing more of it may apply.
   */
  const dispatchRuntimeSessionSet = (
    event: ProviderRuntimeEvent,
    command: Omit<
      Extract<OrchestrationCommand, { type: "thread.session.set" }>,
      "type" | "expectedRuntime"
    >,
  ) =>
    orchestrationEngine
      .dispatch({
        type: "thread.session.set",
        ...command,
        expectedRuntime: expectedRuntimeOf(event),
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          isSupersededRuntimeSessionSet(cause)
            ? reportStaleRuntimeEvent(event, "runtime-session-superseded").pipe(Effect.as(false))
            : Effect.failCause(cause),
        ),
      );

  const processRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      if (
        event.turnId &&
        ((event.type === "content.delta" &&
          (event.payload.streamKind === "assistant_text" ||
            event.payload.streamKind === "reasoning_text" ||
            event.payload.streamKind === "reasoning_summary_text")) ||
          ((event.type === "item.started" ||
            event.type === "item.completed" ||
            event.type === "item.updated") &&
            (event.payload.itemType === "assistant_message" ||
              event.payload.itemType === "reasoning"))) &&
        Option.isSome(
          yield* Cache.getOption(
            restoredTurns,
            `${event.threadId}:${event.runtimeSessionId}:${event.turnId}`,
          ),
        )
      )
        return;
      const thread = yield* resolveLiveThread(event.threadId);
      if (!thread) return;

      // A fast pre-check only: lifecycle updates are fenced again atomically by the decider.
      const activeSession = thread.session;
      const mismatch = runtimeSessionMismatch(activeSession, expectedRuntimeOf(event));
      if (mismatch !== null || activeSession === null) {
        return yield* reportStaleRuntimeEvent(event, mismatch ?? "missing-active-session");
      }

      const now = event.createdAt;
      const eventTurnId = toTurnId(event.turnId);
      const activeTurnId = thread.session?.activeTurnId ?? null;

      if (event.type === "thread.goal.updated" || event.type === "thread.goal.cleared") {
        // The mutation response confirms pending requests. Uncorrelated notifications
        // must not acknowledge or undo them, even when ingestion trails the RPC reply.
        if (thread.goal?.synchronization && thread.goal.synchronization.state !== "unsupported")
          return;
        let goal = event.type === "thread.goal.updated" ? event.payload.goal : null;
        const structuralChange =
          goal === null ||
          thread.goal == null ||
          goal.objective !== thread.goal.objective ||
          goal.status !== thread.goal.status ||
          goal.tokenBudget !== thread.goal.tokenBudget;
        if (structuralChange && providerService.getThreadGoal) {
          const current = yield* providerService.getThreadGoal(thread.id);
          if (current !== false) goal = current;
          const latest = yield* resolveLiveThread(thread.id);
          if (
            latest?.session?.runtimeSessionId !== activeSession.runtimeSessionId ||
            latest?.session?.providerInstanceId !== activeSession.providerInstanceId
          )
            return;
        }
        if (goal !== null) {
          yield* orchestrationEngine.dispatch({
            type: "thread.goal.sync",
            commandId: providerCommandId(event, "thread-goal-sync"),
            threadId: thread.id,
            goal,
            createdAt: now,
          });
        } else if (thread.goal != null) {
          yield* orchestrationEngine.dispatch({
            type: "thread.goal.provider-clear",
            commandId: providerCommandId(event, "thread-goal-provider-clear"),
            threadId: thread.id,
            createdAt: now,
          });
        }
      }

      // A recovered provider can become ready after the process that owned the
      // projected turn disappeared. In that case no turn.aborted notification
      // can ever arrive, so the provider's own idle session state is the
      // authoritative recovery signal. Do not apply this to incidental ready
      // notifications (for example sandbox setup) while the provider still
      // reports an active turn.
      const providerActiveTurnId =
        event.type === "session.state.changed" &&
        event.payload.state === "ready" &&
        activeTurnId !== null
          ? yield* getExpectedProviderTurnIdForThread(thread.id)
          : undefined;
      const reconciledInterruptedTurnId =
        activeTurnId !== null &&
        (event.type === "session.exited" ||
          (event.type === "session.state.changed" &&
            (event.payload.state === "stopped" ||
              (event.payload.state === "ready" && providerActiveTurnId === undefined))))
          ? activeTurnId
          : undefined;

      const conflictsWithActiveTurn =
        activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
      const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;
      const existingEventTurn =
        event.type === "turn.started" && eventTurnId !== undefined
          ? yield* projectionTurnRepository.getByTurnId({
              threadId: thread.id,
              turnId: eventTurnId,
            })
          : Option.none();
      const eventTurnAlreadyTerminal =
        Option.isSome(existingEventTurn) &&
        isTerminalProjectionTurnState(existingEventTurn.value.state);
      const eventTurnAlreadyProjectedWithoutActiveSession =
        activeTurnId === null && Option.isSome(existingEventTurn);

      if (!isAssistantTextDeltaEvent(event)) {
        yield* flushLiveAssistantDeltaBuffersSafely({
          commandTag: "assistant-delta-flush-before-runtime-event",
        });
      }

      yield* rememberSubagentProviderThreadIds(thread.id, event);
      const eventProviderThreadId = rawPayloadThreadId(event);
      const isSubagentProviderThread = isKnownSubagentProviderThread(
        thread.id,
        eventProviderThreadId,
      );

      const shouldApplyThreadLifecycle = (() => {
        if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
          return true;
        }
        switch (event.type) {
          case "session.exited":
            return true;
          case "session.started":
          case "thread.started":
            return true;
          case "turn.started":
            return (
              !conflictsWithActiveTurn &&
              !eventTurnAlreadyTerminal &&
              !eventTurnAlreadyProjectedWithoutActiveSession
            );
          case "turn.completed":
          case "turn.aborted":
            if (conflictsWithActiveTurn || missingTurnForActiveTurn) {
              return false;
            }
            // Only the active turn may close the lifecycle state.
            if (activeTurnId !== null && eventTurnId !== undefined) {
              return sameId(activeTurnId, eventTurnId);
            }
            // Without an active turn, only a named completion proves that a
            // real turn existed. Claude's resume handshake is untargeted and
            // must not settle a pending turn that never started.
            return eventTurnId !== undefined;
          default:
            return true;
        }
      })();
      // One mapping for both the release hint and the completion-return observation.
      const runtimeTerminal =
        (event.type === "turn.completed" || event.type === "turn.aborted") &&
        eventTurnId !== undefined
          ? { turnId: eventTurnId, state: runtimeTerminalTurnState(event) }
          : undefined;
      // What this event knows about how the released turn ended. The decider binds it
      // to the turn the session-set actually releases and ignores it for other turns.
      const turnOutcome: OrchestrationTurnOutcome | undefined =
        runtimeTerminal !== undefined
          ? {
              ...runtimeTerminal,
              reason:
                event.type === "turn.aborted"
                  ? TURN_FINALIZATION_REASON.providerTurnAborted
                  : TURN_FINALIZATION_REASON.providerTurnCompleted,
              completedAt: now,
            }
          : reconciledInterruptedTurnId !== undefined
            ? {
                turnId: reconciledInterruptedTurnId,
                state: "interrupted",
                reason:
                  event.type === "session.exited"
                    ? TURN_FINALIZATION_REASON.providerSessionExited
                    : TURN_FINALIZATION_REASON.providerSessionIdle,
                completedAt: now,
              }
            : undefined;
      const acceptedTurnStartedSourcePlan =
        event.type === "turn.started" && shouldApplyThreadLifecycle
          ? yield* getSourceProposedPlanReferenceForAcceptedTurnStart(thread.id, eventTurnId)
          : null;

      if (
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        event.type === "turn.completed" ||
        event.type === "turn.aborted"
      ) {
        const nextActiveTurnId =
          event.type === "turn.started"
            ? (eventTurnId ?? null)
            : event.type === "turn.completed" ||
                event.type === "turn.aborted" ||
                event.type === "session.exited" ||
                reconciledInterruptedTurnId !== undefined
              ? null
              : activeTurnId;
        const status = (() => {
          switch (event.type) {
            case "session.state.changed": {
              const reported = orchestrationSessionStatusFromRuntimeState(event.payload.state);
              if (nextActiveTurnId !== null) return reported === "ready" ? "running" : reported;
              // Only a turn makes a session run. A status report between turns (Claude
              // reports a permission mode change as `running`) would otherwise leave an
              // idle session running with nothing left to end it.
              return reported === "running" ? (thread.session?.status ?? reported) : reported;
            }
            case "turn.started":
              return "running";
            case "session.exited":
              return "stopped";
            case "turn.completed":
              return normalizeRuntimeTurnState(event.payload.state) === "failed"
                ? "error"
                : "ready";
            case "turn.aborted":
              return "ready";
            case "session.started":
            case "thread.started":
              // Provider thread/session start notifications can arrive during an
              // active turn; preserve turn-running state in that case.
              return activeTurnId !== null ? "running" : "ready";
          }
        })();
        const lastError =
          event.type === "session.state.changed" && event.payload.state === "error"
            ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
            : event.type === "turn.completed" &&
                normalizeRuntimeTurnState(event.payload.state) === "failed"
              ? (event.payload.errorMessage ?? thread.session?.lastError ?? "Turn failed")
              : status === "ready"
                ? null
                : (thread.session?.lastError ?? null);

        if (shouldApplyThreadLifecycle) {
          if (event.type === "turn.started" && acceptedTurnStartedSourcePlan !== null) {
            yield* markSourceProposedPlanImplemented(
              event,
              acceptedTurnStartedSourcePlan.sourceThreadId,
              acceptedTurnStartedSourcePlan.sourcePlanId,
              thread.id,
              now,
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "provider runtime ingestion failed to mark source proposed plan",
                  {
                    eventId: event.eventId,
                    eventType: event.type,
                    cause: Cause.pretty(cause),
                  },
                ),
              ),
            );
          }

          const applied = yield* dispatchRuntimeSessionSet(event, {
            commandId: providerCommandId(event, "thread-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status,
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              ...(event.runtimeSessionId !== undefined
                ? { runtimeSessionId: event.runtimeSessionId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              tokenMode: thread.session?.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
              activeTurnId: nextActiveTurnId,
              lastError,
              updatedAt: now,
            },
            // The release carries the turn's terminal state atomically, so aborts and
            // idle reconciles no longer need a follow-up provider interrupt.
            ...(turnOutcome ? { turnOutcome } : {}),
            createdAt: now,
          });
          if (!applied) return;
        }
      }

      if (!isSubagentProviderThread) {
        yield* projectReasoningForEvent(event, thread.id, reconciledInterruptedTurnId);
      }

      const assistantDelta = isAssistantTextDeltaEvent(event) ? event.payload.delta : undefined;
      const subagentDelta =
        event.type === "subagent.message.delta" ? event.payload.delta : undefined;
      const proposedPlanDelta =
        event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

      if (event.type === "subagent.message.delta" && subagentDelta && subagentDelta.length > 0) {
        const subagentPayload = event.payload;
        yield* appendSubagentMessageDelta({
          event,
          threadId: thread.id,
          subagentId: String(subagentPayload.subagentId),
          providerThreadId: subagentPayload.providerThreadId ?? String(subagentPayload.subagentId),
          providerItemId: subagentPayload.providerMessageId ?? String(subagentPayload.subagentId),
          delta: subagentDelta,
          createdAt: now,
        });
      } else if (
        assistantDelta &&
        assistantDelta.length > 0 &&
        isSubagentProviderThread &&
        eventProviderThreadId
      ) {
        yield* appendSubagentMessageDelta({
          event,
          threadId: thread.id,
          providerThreadId: eventProviderThreadId,
          providerItemId: String(event.itemId ?? event.eventId),
          delta: assistantDelta,
          createdAt: now,
        });
      } else if (assistantDelta && assistantDelta.length > 0) {
        const turnId = toTurnId(event.turnId);
        const assistantMessageId = yield* getOrCreateAssistantMessageId({
          threadId: thread.id,
          event,
          ...(turnId ? { turnId } : {}),
        });
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }

        const streamingMode = yield* readResponseStreamingMode;
        if (streamingMode !== "token") {
          // Token text still coalescing from before a mode switch goes out first, in order.
          if (liveAssistantDeltaBuffers.size > 0) {
            yield* flushLiveAssistantDeltaBuffersSafely({
              commandTag: "assistant-delta-flush-before-buffered-delta",
            });
          }
          yield* appendHeldAssistantText({
            messageId: assistantMessageId,
            delta: assistantDelta,
            mode: streamingMode,
            source: { event, threadId: thread.id, ...(turnId ? { turnId } : {}), createdAt: now },
          });
        } else {
          // Text held before a switch to token mode goes out first, in order.
          const heldText = yield* takeHeldAssistantText(assistantMessageId);
          yield* appendLiveAssistantDelta({
            event,
            threadId: thread.id,
            messageId: assistantMessageId,
            delta: `${heldText}${assistantDelta}`,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
          });
        }
      }

      const pauseForUserTurnId =
        event.type === "request.opened" ||
        (event.type === "user-input.requested" && !event.payload.nonBlocking)
          ? toTurnId(event.turnId)
          : undefined;
      if (pauseForUserTurnId) {
        // Read before the flush below projects buffered text, as the decision depends on it.
        const hasStreamingAssistantMessage = yield* loadTurnHasAssistantMessage(
          thread.id,
          pauseForUserTurnId,
          { streamingOnly: true },
        );
        const flushedMessageIds =
          (yield* readResponseStreamingMode) !== "token"
            ? yield* flushBufferedAssistantMessagesForTurn({
                event,
                threadId: thread.id,
                turnId: pauseForUserTurnId,
                createdAt: now,
                commandTag:
                  event.type === "request.opened"
                    ? "assistant-delta-flush-on-request-opened"
                    : "assistant-delta-flush-on-user-input-requested",
              })
            : new Set<MessageId>();
        yield* finalizeActiveAssistantSegmentForTurn({
          event,
          threadId: thread.id,
          turnId: pauseForUserTurnId,
          createdAt: now,
          commandTag:
            event.type === "request.opened"
              ? "assistant-complete-on-request-opened"
              : "assistant-complete-on-user-input-requested",
          finalDeltaCommandTag:
            event.type === "request.opened"
              ? "assistant-delta-finalize-on-request-opened"
              : "assistant-delta-finalize-on-user-input-requested",
          hasProjectedMessage: hasStreamingAssistantMessage,
          flushedMessageIds,
        });
      }

      if (proposedPlanDelta && proposedPlanDelta.length > 0) {
        const planId = proposedPlanIdFromEvent(event, thread.id);
        yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
      }

      const assistantCompletion =
        event.type === "item.completed" &&
        event.payload.itemType === "assistant_message" &&
        !isSubagentProviderThread
          ? {
              messageId: MessageId.make(
                `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
              ),
              fallbackText: event.payload.detail,
            }
          : undefined;
      const subagentMessageCompletion =
        event.type === "item.completed" &&
        event.payload.itemType === "assistant_message" &&
        isSubagentProviderThread &&
        eventProviderThreadId
          ? {
              providerThreadId: eventProviderThreadId,
              providerItemId: String(event.itemId ?? event.eventId),
              fallbackText: event.payload.detail,
            }
          : undefined;
      const proposedPlanCompletion =
        event.type === "turn.proposed.completed"
          ? {
              planId: proposedPlanIdFromEvent(event, thread.id),
              turnId: toTurnId(event.turnId),
              planMarkdown: event.payload.planMarkdown,
            }
          : undefined;

      if (assistantCompletion) {
        const turnId = toTurnId(event.turnId);
        const activeAssistantMessageId = turnId
          ? yield* getActiveAssistantMessageIdForTurn(thread.id, turnId)
          : Option.none<MessageId>();
        const assistantMessageId = Option.getOrElse(
          activeAssistantMessageId,
          () => assistantCompletion.messageId,
        );
        const existingAssistantMessage = yield* loadThreadMessage(thread.id, assistantMessageId);
        const shouldApplyFallbackCompletionText =
          !existingAssistantMessage || existingAssistantMessage.text.length === 0;

        // Asked only when it decides something: no active segment and no completion text.
        const shouldSkipRedundantCompletion =
          Option.isNone(activeAssistantMessageId) &&
          turnId !== undefined &&
          (assistantCompletion.fallbackText?.trim().length ?? 0) === 0 &&
          (yield* loadTurnHasAssistantMessage(thread.id, turnId, { streamingOnly: false }));

        if (!shouldSkipRedundantCompletion) {
          if (turnId && Option.isNone(activeAssistantMessageId)) {
            yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
          }

          yield* finalizeAssistantMessage({
            event,
            threadId: thread.id,
            messageId: assistantMessageId,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
            commandTag: "assistant-complete",
            finalDeltaCommandTag: "assistant-delta-finalize",
            hasProjectedMessage: existingAssistantMessage !== undefined,
            ...(assistantCompletion.fallbackText !== undefined && shouldApplyFallbackCompletionText
              ? { fallbackText: assistantCompletion.fallbackText }
              : {}),
          });

          if (turnId) {
            yield* forgetAssistantMessageId(thread.id, turnId, assistantMessageId);
          }
        }

        if (turnId) {
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId);
        }
      }

      if (subagentMessageCompletion) {
        yield* completeSubagentMessage({
          event,
          threadId: thread.id,
          providerThreadId: subagentMessageCompletion.providerThreadId,
          providerItemId: subagentMessageCompletion.providerItemId,
          ...(subagentMessageCompletion.fallbackText !== undefined
            ? { fallbackText: subagentMessageCompletion.fallbackText }
            : {}),
          createdAt: now,
        });
      }

      if (event.type === "subagent.completed") {
        const subagentId = String(event.payload.subagent.subagentId);
        const providerThreadId = event.payload.subagent.providerThreadId ?? subagentId;
        const providerItemIds = bufferedSubagentProviderItemIds({
          threadId: thread.id,
          providerThreadId,
        });
        yield* Effect.forEach(
          providerItemIds.length > 0 ? providerItemIds : [subagentId],
          (providerItemId) =>
            completeSubagentMessage({
              event,
              threadId: thread.id,
              subagentId,
              providerThreadId,
              providerItemId,
              ...(event.payload.summary !== undefined
                ? { fallbackText: event.payload.summary }
                : {}),
              createdAt: now,
            }),
          { concurrency: 1, discard: true },
        );
      }

      if (proposedPlanCompletion) {
        yield* finalizeBufferedProposedPlan({
          event,
          threadId: thread.id,
          planId: proposedPlanCompletion.planId,
          ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
          fallbackMarkdown: proposedPlanCompletion.planMarkdown,
          updatedAt: now,
        });
      }

      if (
        event.type === "turn.completed" ||
        event.type === "turn.aborted" ||
        reconciledInterruptedTurnId !== undefined
      ) {
        const turnId = toTurnId(event.turnId) ?? reconciledInterruptedTurnId;
        if (turnId) {
          const assistantMessageIds = yield* getAssistantMessageIdsForTurn(thread.id, turnId);
          // Which of the turn's open messages are projected, read before any is finalized.
          const projectedMessageIds = new Set<MessageId>();
          for (const assistantMessageId of assistantMessageIds) {
            if ((yield* loadThreadMessage(thread.id, assistantMessageId)) !== undefined)
              projectedMessageIds.add(assistantMessageId);
          }
          yield* Effect.forEach(
            assistantMessageIds,
            (assistantMessageId) =>
              finalizeAssistantMessage({
                event,
                threadId: thread.id,
                messageId: assistantMessageId,
                turnId,
                createdAt: now,
                commandTag: "assistant-complete-finalize",
                finalDeltaCommandTag: "assistant-delta-finalize-fallback",
                hasProjectedMessage: projectedMessageIds.has(assistantMessageId),
              }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          yield* clearAssistantMessageIdsForTurn(thread.id, turnId);
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId);

          yield* finalizeBufferedProposedPlan({
            event,
            threadId: thread.id,
            planId: proposedPlanIdForTurn(thread.id, turnId),
            turnId,
            updatedAt: now,
          });
        }
        yield* clearSubagentMessageBuffersForThread(thread.id);
        yield* settleCoalescedActivitiesForThread(thread.id, "task-progress");
      }

      if (
        (event.type === "turn.started" && shouldApplyThreadLifecycle) ||
        event.type === "turn.completed" ||
        event.type === "turn.aborted" ||
        event.type === "session.exited"
      ) {
        const requestActivities = yield* loadPendingRequestActivities(thread.id);
        const finishedTurnId = toTurnId(event.turnId);
        for (const request of derivePendingProviderCallbackRequests(requestActivities)) {
          // New turns supersede requests owned by previous turns. Requests for
          // the new turn (or with unknown ownership) remain actionable.
          if (event.type === "turn.started") {
            if (
              finishedTurnId === undefined ||
              request.turnId === null ||
              request.turnId === finishedTurnId
            )
              continue;
          } else if (
            event.type !== "session.exited" &&
            (finishedTurnId === undefined || request.turnId !== finishedTurnId)
          )
            continue;
          const payload = yield* pendingCallbackInvalidation({
            threadId: thread.id,
            ...request,
            source: {
              runtimeSessionId: event.runtimeSessionId,
              activities: requestActivities,
              turnId: request.turnId,
            },
            detail: "the provider turn ended or was superseded",
          });
          if (!payload) continue;
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: providerCommandId(
              event,
              `request-resolved:${request.kind}:${request.requestId}`,
            ),
            threadId: thread.id,
            activity: {
              id: EventId.make(
                `${event.eventId}:request-resolved:${request.kind}:${request.requestId}`,
              ),
              kind: `provider.${request.kind}.respond.failed`,
              tone: "info",
              summary: "Pending request cleared because its provider turn ended or was superseded",
              payload,
              turnId: request.turnId === null ? null : TurnId.make(request.turnId),
              createdAt: now,
            },
            createdAt: now,
          });
        }
      }

      if (event.type === "session.exited") {
        yield* clearTurnStateForSession(thread.id);
        yield* clearSubagentMessageBuffersForThread(thread.id);
        yield* forgetSubagentProviderThreadIds(thread.id);
        yield* settleCoalescedActivitiesForThread(thread.id, "task-progress");
      }

      if (event.type === "runtime.error") {
        const runtimeErrorMessage = event.payload.message;

        const shouldApplyRuntimeError = !STRICT_PROVIDER_LIFECYCLE_GUARD
          ? true
          : activeTurnId === null || eventTurnId === undefined || sameId(activeTurnId, eventTurnId);

        // A usage limit ends its turn: release it here with the limit as the reason, so
        // the turn is finalized even when no terminal turn event follows.
        const usageLimitTurnId = event.payload.class === "usage_limit" ? eventTurnId : undefined;
        if (shouldApplyRuntimeError) {
          const applied = yield* dispatchRuntimeSessionSet(event, {
            commandId: providerCommandId(event, "runtime-error-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "error",
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              ...(event.runtimeSessionId !== undefined
                ? { runtimeSessionId: event.runtimeSessionId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              tokenMode: thread.session?.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
              activeTurnId: usageLimitTurnId !== undefined ? null : (eventTurnId ?? null),
              lastError: runtimeErrorMessage,
              updatedAt: now,
            },
            // Turn-less: it only applies when this session-set actually releases a turn.
            turnOutcome:
              usageLimitTurnId !== undefined
                ? {
                    turnId: usageLimitTurnId,
                    state: "error",
                    reason: TURN_FINALIZATION_REASON.usageLimit,
                    completedAt: now,
                  }
                : {
                    state: "error",
                    reason: TURN_FINALIZATION_REASON.providerRuntimeError,
                    completedAt: now,
                  },
            createdAt: now,
          });
          if (!applied) return;
        }
        yield* clearSubagentMessageBuffersForThread(thread.id);
        // After the session-set and the buffer clear: a failed or duplicate record must
        // never skip them. Duplicates dedupe on the deterministic command id.
        if (shouldApplyRuntimeError && usageLimitTurnId !== undefined) {
          const instanceId = event.providerInstanceId ?? thread.session?.providerInstanceId;
          const limitId = usageLimitIdForTurn(thread.id, usageLimitTurnId);
          if (instanceId !== undefined && thread.usageLimit?.limitId !== limitId) {
            yield* dispatchUsageLimitRecord({
              commandId: usageLimitRecordCommandId(limitId),
              threadId: thread.id,
              limitId,
              provider: event.provider,
              providerInstanceId: instanceId,
              turnId: usageLimitTurnId,
              message: truncateUsageLimitMessage(runtimeErrorMessage),
              resetAt: event.payload.resetAt ?? null,
              createdAt: now,
            });
          }
        }
      }

      // A rate-limit update can name the reset of a limit recorded without one.
      if (event.type === "account.rate-limits.updated") {
        const state = event.payload.usageLimitState;
        const limit = thread.usageLimit ?? null;
        const instanceId = event.providerInstanceId ?? thread.session?.providerInstanceId;
        if (
          state?.exhausted === true &&
          state.resetAt !== null &&
          limit !== null &&
          limit.resetAt === null &&
          limit.providerInstanceId === instanceId &&
          Date.parse(state.resetAt) > Date.parse(limit.limitedAt)
        ) {
          yield* dispatchUsageLimitRecord({
            commandId: usageLimitResetFillCommandId(limit.limitId),
            threadId: thread.id,
            limitId: limit.limitId,
            provider: limit.provider,
            providerInstanceId: limit.providerInstanceId,
            turnId: limit.turnId,
            message: limit.message,
            resetAt: state.resetAt,
            createdAt: now,
          });
        }
      }

      if (event.type === "session.state.changed" && event.payload.state === "error") {
        yield* clearSubagentMessageBuffersForThread(thread.id);
      }

      if (event.type === "thread.metadata.updated" && event.payload.name) {
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: providerCommandId(event, "thread-meta-update"),
          threadId: thread.id,
          title: event.payload.name,
        });
      }

      if (event.type === "turn.diff.updated") {
        const turnId = toTurnId(event.turnId);
        const checkpointContext = turnId
          ? yield* projectionSnapshotQuery
              .getThreadCheckpointContext(thread.id)
              .pipe(Effect.map(Option.getOrUndefined))
          : undefined;
        const workspaceCwd =
          checkpointContext?.worktreePath ?? checkpointContext?.workspaceRoot ?? undefined;
        if (turnId && checkpointContext && workspaceCwd && isGitRepository(workspaceCwd)) {
          // Skip if a checkpoint already exists for this turn. A real
          // (non-placeholder) capture from CheckpointReactor should not
          // be clobbered, and dispatching a duplicate placeholder for the
          // same turnId would produce an unstable checkpointTurnCount.
          if (hasCheckpointForTurn(checkpointContext.checkpoints, turnId)) {
            // Already tracked; no-op.
          } else {
            const assistantMessageId = MessageId.make(
              `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
            );
            yield* orchestrationEngine.dispatch({
              type: "thread.turn.diff.complete",
              commandId: providerCommandId(event, "thread-turn-diff-complete", String(turnId)),
              threadId: thread.id,
              turnId,
              completedAt: now,
              checkpointRef: CheckpointRef.make(`provider-diff:${event.eventId}`),
              status: "missing",
              files: [],
              assistantMessageId,
              checkpointTurnCount: maxCheckpointTurnCount(checkpointContext.checkpoints) + 1,
              createdAt: now,
            });
          }
        }
      }

      if (
        event.type === "task.started" ||
        event.type === "task.progress" ||
        event.type === "task.updated"
      ) {
        const description = event.payload.description?.trim();
        if (description) {
          yield* rememberTaskDescription(thread.id, event.payload.taskId, description);
        }
      }
      const previousBackgroundLiveness = threadBackgroundLiveness.getThreadBackgroundLiveness(
        thread.id,
      );
      // Sidebar background liveness: fed from the same lifecycle stream,
      // read by the shell query at mapping time (no persistence). Tagged with
      // the reporting runtime, which the stale-event check above proved is the
      // thread's current one.
      switch (event.type) {
        case "task.started":
        case "task.progress":
        case "task.updated":
        case "task.completed": {
          const payload = event.payload;
          threadBackgroundLiveness.recordTaskLiveness({
            threadId: thread.id,
            taskId: payload.taskId,
            taskType: payload.taskType,
            status: "status" in payload ? payload.status : undefined,
            agentId: payload.agentId,
            attempt: payload.attempt,
            parentAgentId: payload.parentAgentId,
            runtimeSessionId: event.runtimeSessionId ?? null,
            kind:
              event.type === "task.started"
                ? "started"
                : event.type === "task.progress"
                  ? "progress"
                  : event.type === "task.updated"
                    ? "updated"
                    : "completed",
          });
          break;
        }
        case "subagent.started":
        case "subagent.updated":
        case "subagent.completed": {
          const subagent = event.payload.subagent;
          // Native task events already own liveness when a task id exists.
          if (!subagent.providerTaskId) {
            threadBackgroundLiveness.recordTaskLiveness({
              threadId: thread.id,
              taskId: `subagent:${subagent.subagentId}`,
              taskType: "subagent",
              status: "status" in event.payload ? event.payload.status : undefined,
              runtimeSessionId: event.runtimeSessionId ?? null,
              kind:
                event.type === "subagent.started"
                  ? "started"
                  : event.type === "subagent.completed"
                    ? "completed"
                    : "updated",
            });
          }
          break;
        }
        case "session.exited":
          threadBackgroundLiveness.clearThreadLiveness(thread.id);
          break;
        default:
          break;
      }

      let taskTitle: string | undefined;
      if (event.type === "task.completed") {
        yield* settleTaskProgressForTask(thread.id, event.payload.taskId);
        taskTitle = yield* lookupTaskDescription(thread.id, event.payload.taskId);
        if (!taskTitle) {
          taskTitle = findTaskTitleInActivities(
            yield* loadTaskActivities(thread.id, event.payload.taskId),
            event.payload.taskId,
          );
        }
      }

      const activities = runtimeEventToActivities(event, taskTitle);
      yield* Effect.forEach(activities, (activity) => {
        const command: ActivityAppendCommand = {
          type: "thread.activity.append",
          commandId: providerCommandId(event, "thread-activity-append", String(activity.id)),
          threadId: thread.id,
          activity:
            activity.kind === "context-window.updated"
              ? {
                  ...activity,
                  payload: {
                    // Written by `runtimeEventToActivities` just above.
                    ...(activity.payload as ContextWindowActivityPayload),
                    statisticsModel: thread.modelSelection.model,
                    ...statisticsSpeedField(thread.modelSelection),
                  } satisfies ContextWindowActivityPayload,
                }
              : activity,
          createdAt: activity.createdAt,
        };
        // Task progress is latest state that providers rewrite on every tick.
        return event.type === "task.progress"
          ? offerCoalescedActivity({
              group: "task-progress",
              threadId: thread.id,
              intervalMs: TASK_PROGRESS_WRITE_INTERVAL_MS,
              changeKey: taskProgressChangeKey(activity),
              command,
            })
          : orchestrationEngine.dispatch(command).pipe(Effect.asVoid);
      }).pipe(Effect.asVoid);

      // A completed assistant message is not proof of turn completion. Write
      // the delegation acknowledgement only after accepted lifecycle handling,
      // all buffered output finalization, and background activity projection.
      const completionObservationNeeded =
        event.type === "turn.completed" ||
        event.type === "turn.aborted" ||
        previousBackgroundLiveness !==
          threadBackgroundLiveness.getThreadBackgroundLiveness(thread.id);
      if (
        completionObservationNeeded &&
        Option.isSome(completionReturns) &&
        event.runtimeSessionId
      ) {
        const terminal =
          shouldApplyThreadLifecycle && !isSubagentProviderThread ? runtimeTerminal : undefined;
        yield* completionReturns.value.observe({
          childThreadId: thread.id,
          runtimeSessionId: event.runtimeSessionId,
          observationEpoch: completionObservationEpoch,
          backgroundPending:
            threadBackgroundLiveness.getThreadBackgroundLiveness(thread.id) !== null,
          ...(terminal ? { terminal } : {}),
        });
      }
    });

  const processDomainEvent = (_event: TurnStartRequestedDomainEvent) => Effect.void;

  const restoredTurns = yield* Cache.make<string, true>({
    capacity: 10_000,
    timeToLive: "120 minutes",
    lookup: () => Effect.succeed(true as const),
  });

  /**
   * The slice of a thread provider history recovery compares against. The bounded query when the
   * snapshot query has it; otherwise the full thread, re-checked against the preconditions.
   */
  const loadHistoryRepairContext = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly history: ProviderThreadHistory;
    readonly recovered: ReadonlyArray<OrchestrationThreadActivity>;
    readonly userMessageIdsByTurn: ReadonlyMap<TurnId, MessageId>;
    readonly matchesHistory: (thread: OrchestrationThread) => boolean;
  }) {
    const bounded = projectionSnapshotQuery.getThreadHistoryRepairContext;
    if (bounded === undefined) {
      const thread = yield* resolveThreadDetail(input.threadId);
      if (!thread || !input.matchesHistory(thread)) return undefined;
      return {
        messages: thread.messages,
        activities: thread.activities as ReadonlyArray<HistoryActivityIdentity>,
        requestActivities: thread.activities,
      };
    }
    const context = yield* bounded({
      threadId: input.threadId,
      ...historyRepairLookups(input),
    });
    return {
      messages: context.messages,
      activities: context.activityKeys.map((key): HistoryActivityIdentity => ({
        id: EventId.make(key.id),
        turnId: key.turnId,
        kind: key.kind,
        payload: key.providerItemId === null ? null : { providerItemId: key.providerItemId },
      })),
      requestActivities: context.requestActivities,
    };
  });

  const processHistory = (input: Extract<RuntimeIngestionInput, { source: "history" }>) =>
    Effect.gen(function* () {
      // Nothing to restore, or a thread that moved on: decided without loading
      // every message and activity of the thread.
      if (
        input.history.messages.length === 0 &&
        input.history.items.length === 0 &&
        input.history.completedTurnIds.length === 0
      )
        return;
      const matchesHistory = (thread: {
        readonly updatedAt: string;
        readonly session: {
          readonly runtimeSessionId?: string | undefined;
          readonly providerInstanceId?: string | undefined;
        } | null;
      }) =>
        thread.updatedAt === input.expectedUpdatedAt &&
        input.binding.runtimeSessionId !== undefined &&
        input.binding.providerInstanceId !== undefined &&
        thread.session?.runtimeSessionId === input.binding.runtimeSessionId &&
        thread.session.providerInstanceId === input.binding.providerInstanceId;
      const shell = yield* resolveThreadShell(input.threadId);
      const { providerInstanceId, runtimeSessionId } = input.binding;
      if (
        !shell ||
        !shell.session ||
        !providerInstanceId ||
        !runtimeSessionId ||
        !matchesHistory(shell)
      )
        return;
      const session = shell.session;
      const recovered = input.history.items.flatMap((event) => [
        ...runtimeEventToActivities(event),
        ...historyReasoningActivities(shell.id, event),
      ]);
      // User messages are persisted before the provider assigns a turn ID.
      // The turn projection owns that association; message.turnId stays null.
      const userMessageIdsByTurn = new Map<TurnId, MessageId>();
      if (input.history.messages.some((message) => message.role === "user")) {
        const turns = yield* projectionTurnRepository.listByThreadId({ threadId: shell.id });
        for (const turn of turns) {
          if (turn.turnId !== null && turn.pendingMessageId !== null) {
            userMessageIdsByTurn.set(turn.turnId, turn.pendingMessageId);
          }
        }
      }
      // Only what the transcript can match is read: the messages and activity keys of its
      // turns and ids, and the pending-request lifecycle. The decider re-checks the
      // preconditions against the thread when the restore is dispatched.
      const repair = yield* loadHistoryRepairContext({
        threadId: shell.id,
        history: input.history,
        recovered,
        userMessageIdsByTurn,
        matchesHistory,
      });
      if (!repair) return;
      const thread = {
        id: shell.id,
        createdAt: shell.createdAt,
        updatedAt: shell.updatedAt,
        session,
        messages: repair.messages,
        activities: repair.activities,
      };
      const now = new Date(Math.max(Date.now(), Date.parse(thread.updatedAt) + 1)).toISOString();
      const messages = historyMessagesToRestore(thread, input.history, now, userMessageIdsByTurn);
      const activities = missingHistoryActivities(thread, recovered);
      for (const request of derivePendingProviderCallbackRequests(repair.requestActivities)) {
        if (
          request.turnId === null ||
          !input.history.completedTurnIds.includes(TurnId.make(request.turnId))
        )
          continue;
        const payload = yield* pendingCallbackInvalidation({
          threadId: thread.id,
          ...request,
          detail: "provider history confirms that the turn ended",
        });
        if (!payload) continue;
        activities.push({
          id: EventId.make(`history:${thread.id}:resolved:${request.kind}:${request.requestId}`),
          kind: `provider.${request.kind}.respond.failed`,
          tone: "info",
          summary: "Pending request cleared because its provider turn ended",
          payload,
          turnId: TurnId.make(request.turnId),
          createdAt: now,
        });
      }
      const settlesTurn =
        thread.session.activeTurnId !== null &&
        input.history.completedTurnIds.includes(thread.session.activeTurnId);
      if (messages.length > 0 || activities.length > 0 || settlesTurn)
        yield* orchestrationEngine.dispatch({
          type: "thread.history.restore",
          commandId: CommandId.make(`history:${crypto.randomUUID()}`),
          threadId: thread.id,
          providerInstanceId,
          runtimeSessionId,
          expectedUpdatedAt: thread.updatedAt,
          messages,
          activities,
          completedTurnIds: input.history.completedTurnIds,
          failedTurnIds: input.history.failedTurnIds,
          createdAt: now,
        });
      // This worker also owns live buffers. Retire only confirmed completed
      // turns after the durable repair, so delayed flushes cannot duplicate it.
      for (const turnId of input.history.completedTurnIds) {
        yield* Cache.set(
          restoredTurns,
          `${thread.id}:${input.binding.runtimeSessionId}:${turnId}`,
          true,
        );
        const ids = yield* getAssistantMessageIdsForTurn(thread.id, turnId);
        yield* Effect.forEach(ids, clearAssistantMessageState, { discard: true });
        yield* clearAssistantMessageIdsForTurn(thread.id, turnId);
        yield* clearAssistantSegmentStateForTurn(thread.id, turnId);
        for (const [key, buffer] of liveAssistantDeltaBuffers) {
          if (buffer.threadId === thread.id && buffer.turnId === turnId)
            liveAssistantDeltaBuffers.delete(key);
        }
      }
    }).pipe(Effect.ensuring(Deferred.succeed(input.done, undefined)));

  const processInput = (input: RuntimeIngestionInput) =>
    input.source === "history"
      ? processHistory(input)
      : input.source === "runtime"
        ? processRuntimeEvent(input.event)
        : input.source === "domain"
          ? processDomainEvent(input.event)
          : input.source === "reasoningFlush"
            ? flushReasoningSegment(input)
            : input.source === "coalescedActivityFlush"
              ? flushCoalescedActivity(input)
              : input.source === "assistantParagraphFlush"
                ? flushHeldParagraphs(input)
                : flushLiveAssistantDeltaBuffer({
                    key: input.key,
                    generation: input.generation,
                    commandTag: "assistant-delta-coalesced-interval",
                  }).pipe(Effect.asVoid);

  const processInputSafely = (input: RuntimeIngestionInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          source: input.source,
          ...(input.source === "history"
            ? { threadId: input.threadId }
            : input.source === "assistantParagraphFlush"
              ? { messageId: input.messageId }
              : input.source === "liveAssistantFlush" ||
                  input.source === "reasoningFlush" ||
                  input.source === "coalescedActivityFlush"
                ? { flushKey: input.key, flushGeneration: input.generation }
                : { eventId: input.event.eventId, eventType: input.event.type }),
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker({
    policy: losslessBackpressureQueuePolicy({
      component: "ProviderRuntimeIngestion",
      capacity: 2_048,
    }),
    process: processInputSafely,
  });
  enqueueRuntimeInput = worker.enqueue;

  const historyAdmission = yield* Semaphore.make(2);
  // Trailing reads outlive the trigger's caller (a subscription may close first).
  const historyScope = yield* Effect.scope;
  const historyReads = new Set<ThreadId>();
  const historyTrailingReads = new Set<ThreadId>();
  const historyRecoveryStates = new Map<ThreadId, HistoryRecoveryState>();
  /** Records an attempt. An interrupted read spaces the next one, but is not a failure. */
  const recordHistoryRecovery = (
    threadId: ThreadId,
    startedAt: number,
    outcome: "succeeded" | "failed" | "interrupted",
  ) => {
    const previous = historyRecoveryStates.get(threadId);
    historyRecoveryStates.delete(threadId);
    historyRecoveryStates.set(threadId, {
      attemptedAt: Date.now(),
      startedAt,
      failures:
        outcome === "succeeded"
          ? 0
          : outcome === "failed"
            ? (previous?.failures ?? 0) + 1
            : (previous?.failures ?? 0),
    });
    for (const oldest of historyRecoveryStates.keys()) {
      if (historyRecoveryStates.size <= HISTORY_RECOVERY_TRACKED_THREADS) break;
      historyRecoveryStates.delete(oldest);
    }
    return previous?.failures ?? 0;
  };
  /** One provider history read; the caller has checked that none is in flight. */
  const readHistory = (threadId: ThreadId, trigger: HistoryRecoveryTrigger) => {
    historyReads.add(threadId);
    const startedAt = Date.now();
    let reading = false;
    // A read the provider was already serving still spaces the next one, so reconnect
    // churn cannot re-read a large thread at once. It is not a failure.
    const recordInterrupted = () => {
      if (reading) recordHistoryRecovery(threadId, startedAt, "interrupted");
      reading = false;
    };
    return historyAdmission
      .withPermit(
        Effect.gen(function* () {
          const thread = yield* resolveThreadShell(threadId);
          if (!thread?.session) return;
          // Where the thread runs now: after a move the binding still records the old folder.
          const project =
            thread.worktreePath === null
              ? Option.getOrUndefined(
                  yield* projectionSnapshotQuery.getProjectShellById(thread.projectId),
                )
              : undefined;
          const cwd = resolveThreadWorkspaceCwd({ thread, projects: project ? [project] : [] });
          reading = true;
          const snapshot = yield* providerService.readThreadHistory!(threadId, cwd ? { cwd } : {});
          if (Option.isNone(snapshot)) return;
          const done = yield* Deferred.make<void>();
          yield* worker.enqueue({
            source: "history",
            threadId,
            expectedUpdatedAt: thread.updatedAt,
            ...snapshot.value,
            done,
          });
          yield* Deferred.await(done);
        }),
      )
      .pipe(
        Effect.timeout(HISTORY_RECOVERY_TIMEOUT),
        Effect.matchCauseEffect({
          onSuccess: () =>
            Effect.sync(() => recordHistoryRecovery(threadId, startedAt, "succeeded")).pipe(
              Effect.flatMap((previousFailures) =>
                previousFailures > 0
                  ? Effect.logInfo("Provider history recovery succeeded again", {
                      threadId,
                      previousFailures,
                    })
                  : Effect.void,
              ),
            ),
          onFailure: (cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              recordInterrupted();
              return Effect.interrupt;
            }
            const previousFailures = recordHistoryRecovery(threadId, startedAt, "failed");
            const fields = { threadId, trigger, failures: previousFailures + 1 };
            // The cause once per failure streak; the retries back off quietly.
            return previousFailures === 0
              ? Effect.logWarning("Provider history recovery failed; preserving local thread", {
                  ...fields,
                  cause: Cause.pretty(cause),
                })
              : Effect.logDebug("Provider history recovery failed again", fields);
          },
        }),
        // The caller's interruption (a subscription closing mid-read) skips the match above.
        Effect.onInterrupt(() => Effect.sync(recordInterrupted)),
        Effect.ensuring(Effect.sync(() => historyReads.delete(threadId))),
      );
  };
  /**
   * The deferred read of a settle that a recent read spaced out: one per thread, after the
   * spacing. The policy decides again then: a read since the settle may have covered it.
   */
  const scheduleTrailingHistoryRead = (threadId: ThreadId, afterMs: number) =>
    Effect.suspend(() => {
      if (historyTrailingReads.has(threadId)) return Effect.void;
      historyTrailingReads.add(threadId);
      const trailingSinceMs = Date.now();
      return Effect.sleep(Duration.millis(afterMs)).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            historyTrailingReads.delete(threadId);
            const decision = decideHistoryRecovery({
              state: historyRecoveryStates.get(threadId),
              trigger: "session-settled",
              inFlight: historyReads.has(threadId),
              nowMs: Date.now(),
              trailingSinceMs,
            });
            return decision.kind === "read"
              ? readHistory(threadId, "session-settled")
              : Effect.void;
          }),
        ),
        Effect.ensuring(Effect.sync(() => historyTrailingReads.delete(threadId))),
        Effect.forkIn(historyScope),
        Effect.asVoid,
      );
    });
  const reconcileThread: NonNullable<ProviderRuntimeIngestionShape["reconcileThread"]> = (
    threadId,
    trigger = "subscribe",
  ) =>
    Effect.suspend(() => {
      if (!providerService.readThreadHistory) return Effect.void;
      const decision = decideHistoryRecovery({
        state: historyRecoveryStates.get(threadId),
        trigger,
        inFlight: historyReads.has(threadId),
        nowMs: Date.now(),
      });
      switch (decision.kind) {
        case "read":
          return readHistory(threadId, trigger);
        case "trail":
          return scheduleTrailingHistoryRead(threadId, decision.afterMs);
        case "skip":
          return Effect.void;
      }
    });

  const start: ProviderRuntimeIngestionShape["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Stream.runForEach(providerService.streamEvents, (event) =>
          worker.enqueue({ source: "runtime", event }),
        ),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (event.type !== "thread.turn-start-requested") {
            return Effect.void;
          }
          return worker.enqueue({ source: "domain", event });
        }),
      );
    });

  return {
    reconcileThread,
    start,
    // Drain pending runtime work, flush any remaining live assistant text and
    // coalesced activity writes, then drain again for scheduled flush inputs
    // that landed during shutdown.
    drain: worker.drain.pipe(
      Effect.andThen(
        flushLiveAssistantDeltaBuffersSafely({
          commandTag: "assistant-delta-flush-on-drain",
        }),
      ),
      Effect.andThen(flushAllCoalescedActivities),
      Effect.andThen(worker.drain),
    ),
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make,
).pipe(Layer.provide(ProjectionTurnRepositoryLive), Layer.provide(callbackRepositories));
