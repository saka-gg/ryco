/**
 * The follow-up queue drain (port batch 3, design §3.4), loaded by `ServerQueueDrainLive` once
 * commands are admitted.
 *
 * Each thread's queue is drained in its own lane. A pass sends nothing while the queue is held,
 * its head waits for Retry or a steer, or the previous dispatch's start has neither bound a turn
 * nor failed; otherwise the shared wake fence decides (`ServerWakeFence`: usage limit, idle,
 * cold-start budget, pending revert), and the head goes as one `thread.turn.start` with
 * `queueDispatch`, which the decider commits together with the entry's removal. Passes run on
 * the thread's events that can open the fence and on a 30 s sweep of threads with an unheld
 * queue.
 *
 * Holds this module records: `restart` for every queue left by an earlier process (never sent
 * without a Resume), `error` when a sent entry's start failed or the decider kept refusing its
 * head, `stalled` when a sent entry's start neither bound nor failed for a long time, and
 * `review` when sending the head would resume a large Claude conversation whose prompt cache has
 * likely expired (the composer's resume review, `assessClaudeCacheResume`): the person's Resume
 * answers it, and the head goes.
 *
 * It imports no value from a module the server's boot graph loads (only `effect`, which is split
 * already): everything else comes in through `ServerQueueDrainDeps`. Importing one would split
 * that module out of the boot chunk (serverBundleBoundaries.test.ts).
 *
 * @module serverQueueDrainRuntime
 */
import type {
  CommandId,
  DelegationReturnGuard,
  FollowUpQueueHoldInput,
  InternalOrchestrationCommand,
  MessageId,
  ModelSelection,
  OrchestrationDispatchCommandError,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThread,
  OrchestrationThreadHistoryError,
  OrchestrationThreadShell,
  QueuedFollowUp,
  RuntimeMode,
  ThreadId,
  ThreadTurnStartCommand,
} from "@ryco/contracts";
import type { makeKeyedSerialWorker } from "@ryco/shared/KeyedSerialWorker";
import type { losslessBackpressureQueuePolicy } from "@ryco/shared/QueuePolicy";
import { Cause, Clock, Duration, Effect, Exit, Option, Stream } from "effect";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";
import type { ServerWakeFenceShape } from "./Services/ServerWakeFence.ts";

export const QUEUE_DRAIN_SWEEP_INTERVAL = Duration.seconds(30);
/** A head the decider refused this often (at one revision) holds the queue instead. */
export const MAX_QUEUE_DISPATCH_ATTEMPTS = 3;
/** A sent entry whose start neither bound nor failed this long holds the queue (`stalled`). */
export const QUEUE_DISPATCH_STALL_MS = 10 * 60_000;
/** Start outcomes watched at once; the oldest are forgotten past this. */
const MAX_WATCHED_DISPATCHES = 1_000;

export const RESTART_HOLD_DETAIL =
  "Ryco restarted while messages were queued. Resume to send them.";

/**
 * The dispatch's command id: the entry revision it sends, then an id unique to this attempt
 * (`<process start>:<serial>`). The engine keeps a refused command's receipt and replays it for the
 * same id, so an id is never reused, not after a hold and Resume, not after a restart. The
 * decider's head-and-revision check is what keeps an entry from being sent twice.
 */
export const queueDrainCommandId = (
  threadId: ThreadId,
  messageId: MessageId,
  revision: number,
  attemptId: string,
) => `queue-drain:${threadId}:${messageId}:${revision}:${attemptId}` as CommandId;

/**
 * What the drain reads and calls, provided by `ServerQueueDrainLive` on the boot side: services,
 * and the boot modules' own functions as values.
 */
export interface ServerQueueDrainDeps {
  /** The command read model as the engine holds it now (`currentCommandReadModel`). */
  readonly readModel: Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;
  /** `findThreadInArray`. */
  readonly findThread: (
    threads: OrchestrationReadModel["threads"],
    threadId: string,
  ) => OrchestrationThread | undefined;
  readonly subscribeDomainEvents: OrchestrationEngineShape["subscribeDomainEvents"];
  readonly getThreadShellById: ProjectionSnapshotQueryShape["getThreadShellById"];
  readonly fence: ServerWakeFenceShape;
  readonly serverWakeGuard: (
    shell: OrchestrationThreadShell,
    latestUserMessageId: MessageId | null,
    source: "follow-up-queue",
  ) => DelegationReturnGuard;
  readonly makeKeyedSerialWorker: typeof makeKeyedSerialWorker;
  readonly losslessBackpressureQueuePolicy: typeof losslessBackpressureQueuePolicy;
  readonly dispatch: (
    command: InternalOrchestrationCommand | ThreadTurnStartCommand,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
  /** `runtimeModePrivilegeRank`: an entry the person did not queue never raises the thread. */
  readonly runtimeModePrivilegeRank: Readonly<Record<RuntimeMode, number>>;
  /** Threads whose queue held entries when this process started. */
  readonly queuedAtBoot: ReadonlyArray<ThreadId>;
  /**
   * Unique to this process start (never shared by two): names its restart hold's cause and
   * prefixes every command id it mints.
   */
  readonly bootId: string;
  /**
   * The composer's Claude resume review for a send to `target` now, or null when it needs none
   * (`assessClaudeCacheResume` over the thread's newest activities).
   */
  readonly claudeResumeReview?: (
    threadId: ThreadId,
    target: ModelSelection,
    nowMs: number,
  ) => Effect.Effect<
    ClaudeResumeReview | null,
    ProjectionRepositoryError | OrchestrationThreadHistoryError
  >;
}

/** What a review hold tells the person (`ClaudeCacheReview`). */
export interface ClaudeResumeReview {
  readonly reason: string;
  readonly promptTokens: number;
}

/** The review hold's detail: why, and what Resume costs. */
export const claudeReviewHoldDetail = (review: ClaudeResumeReview) =>
  `${review.reason} Resume sends it anyway: Claude reads the whole conversation again (about ${Math.max(1, Math.round(review.promptTokens / 1000))}k tokens) without its cache.`;

/** How a sent entry's start ended without a turn (`provider.turn.start.*` activities). */
export interface QueueStartEnded {
  readonly messageId: MessageId;
  readonly activityId: string;
  /** A Stop cancelled it (no hold: the Stop records its own). */
  readonly cancelled: boolean;
  readonly detail: string | null;
}

const isoAt = (ms: number) => new Date(ms).toISOString();

/**
 * The runtime mode `head` is sent with: the mode it was queued with when the person queued it
 * (as a client's send applies the composer's), else never more than the thread's current mode,
 * so an agent's or an automation's entry cannot raise a mode the person lowered since.
 */
export function queueDispatchRuntimeMode(
  head: Pick<QueuedFollowUp, "author" | "runtimeMode">,
  threadRuntimeMode: RuntimeMode,
  rank: Readonly<Record<RuntimeMode, number>>,
): RuntimeMode {
  if (head.author === "user") return head.runtimeMode;
  return rank[threadRuntimeMode] < rank[head.runtimeMode] ? threadRuntimeMode : head.runtimeMode;
}

/** The model and modes a head is sent with (`queueDispatchModes`). */
export interface QueueDispatchModes {
  readonly modelSelection: QueuedFollowUp["modelSelection"];
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: QueuedFollowUp["interactionMode"];
  readonly tokenMode?: QueuedFollowUp["tokenMode"];
}

/**
 * A person's entry keeps the model and modes it was queued with, as a client's send of a queued
 * message does. An agent's or an automation's entry takes the chat's current model and modes, so
 * it never switches the chat back to what it was when the entry was queued, and never runs above
 * the runtime mode it was queued with.
 */
export function queueDispatchModes(
  head: QueuedFollowUp,
  thread: Pick<
    OrchestrationThreadShell,
    "modelSelection" | "runtimeMode" | "interactionMode" | "tokenMode"
  >,
  rank: Readonly<Record<RuntimeMode, number>>,
): QueueDispatchModes {
  if (head.author === "user") {
    return {
      modelSelection: head.modelSelection,
      runtimeMode: head.runtimeMode,
      interactionMode: head.interactionMode,
      ...(head.tokenMode === undefined ? {} : { tokenMode: head.tokenMode }),
    };
  }
  return {
    modelSelection: thread.modelSelection,
    runtimeMode: queueDispatchRuntimeMode(head, thread.runtimeMode, rank),
    interactionMode: thread.interactionMode,
    ...(thread.tokenMode === undefined ? {} : { tokenMode: thread.tokenMode }),
  };
}

/** The turn start that sends `head` with `modes` (`queueDispatchModes`). */
export function queueDispatchCommand(input: {
  readonly threadId: ThreadId;
  readonly head: QueuedFollowUp;
  readonly modes: QueueDispatchModes;
  readonly guard: ThreadTurnStartCommand["delegationReturnGuard"];
  readonly attemptId: string;
  readonly createdAt: string;
}): ThreadTurnStartCommand {
  const { head } = input;
  return {
    type: "thread.turn.start",
    commandId: queueDrainCommandId(input.threadId, head.messageId, head.revision, input.attemptId),
    threadId: input.threadId,
    message: {
      messageId: head.messageId,
      role: "user",
      text: head.text,
      attachments: head.attachments,
    },
    modelSelection: input.modes.modelSelection,
    runtimeMode: input.modes.runtimeMode,
    interactionMode: input.modes.interactionMode,
    ...(input.modes.tokenMode === undefined ? {} : { tokenMode: input.modes.tokenMode }),
    ...(head.threadReferences === undefined ? {} : { threadReferences: head.threadReferences }),
    ...(input.guard === undefined ? {} : { delegationReturnGuard: input.guard }),
    queueDispatch: { messageId: head.messageId, revision: head.revision },
    // Nobody is there to confirm stopping background tasks for a model switch: the node
    // refuses instead, and the refusals end in a hold the user sees.
    keepBackgroundWork: true,
    createdAt: input.createdAt,
  };
}

export const makeServerQueueDrain = (deps: ServerQueueDrainDeps) =>
  Effect.sync(() => {
    const { fence } = deps;
    /** The sent head whose start has not bound or ended yet, per thread, and since when. */
    const awaiting = new Map<
      ThreadId,
      { readonly messageId: MessageId; readonly sinceMs: number }
    >();
    /** Sent entries whose failed start holds their queue (insertion order: oldest first). */
    const watched = new Map<MessageId, ThreadId>();
    /** Refused attempts at the head, per thread (only the head is ever attempted). */
    const refusals = new Map<ThreadId, { readonly key: string; readonly count: number }>();
    let serial = 0;
    /** An id unique in this process start and across starts; never reused. */
    const nextAttemptId = () => `${deps.bootId}:${(serial += 1)}`;

    const watch = (messageId: MessageId, threadId: ThreadId) => {
      watched.set(messageId, threadId);
      while (watched.size > MAX_WATCHED_DISPATCHES) watched.delete(watched.keys().next().value!);
    };

    /** Records a hold; false when it could not be (logged). */
    const recordHold = (threadId: ThreadId, commandId: string, hold: FollowUpQueueHoldInput) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        yield* deps.dispatch({
          type: "thread.queue.hold.record",
          commandId: commandId as CommandId,
          threadId,
          hold,
          createdAt: isoAt(nowMs),
        });
        return true;
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("follow-up queue hold was not recorded", {
            threadId,
            commandId,
            error: error.message,
          }).pipe(Effect.as(false)),
        ),
      );

    /** The head each thread's review hold was recorded for, and the head its Resume answered. */
    const reviewHeld = new Map<ThreadId, MessageId>();
    const reviewed = new Map<ThreadId, MessageId>();

    /**
     * Whether the head waits for the person's review of a Claude resume: true once the hold is
     * recorded, or while the review cannot be read (the next pass asks again). Only a native
     * resume of the thread's own Claude session is reviewed; another instance takes a context
     * handoff. A head whose review hold is gone again (the queue is unheld here) was resumed.
     */
    const awaitsClaudeReview = (
      thread: OrchestrationThread,
      head: QueuedFollowUp,
      target: ModelSelection,
      nowMs: number,
    ) =>
      Effect.gen(function* () {
        const session = thread.session;
        if (
          deps.claudeResumeReview === undefined ||
          session?.providerName !== "claudeAgent" ||
          session.providerInstanceId !== target.instanceId ||
          reviewed.get(thread.id) === head.messageId
        ) {
          return false;
        }
        if (reviewHeld.get(thread.id) === head.messageId) {
          reviewHeld.delete(thread.id);
          reviewed.set(thread.id, head.messageId);
          return false;
        }
        const review = yield* deps.claudeResumeReview(thread.id, target, nowMs).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("follow-up queue could not review the Claude resume", {
                  threadId: thread.id,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as(undefined)),
          ),
        );
        if (review === undefined) return true;
        if (review === null) return false;
        const held = yield* recordHold(
          thread.id,
          `queue-review-hold:${thread.id}:${head.messageId}:${nextAttemptId()}`,
          {
            reason: "review",
            // The composer's own review cause for a queued message (`coordinator.ts`).
            causeKeys: [`review:${head.messageId}`],
            detail: claudeReviewHoldDetail(review),
          },
        );
        if (held) reviewHeld.set(thread.id, head.messageId);
        return true;
      });

    /** Every queue an earlier process left: held until the user resumes it (no restart drain). */
    const holdQueuedAtBoot = Effect.forEach(
      deps.queuedAtBoot,
      (threadId) =>
        recordHold(threadId, `queue-restart-hold:${threadId}:${deps.bootId}`, {
          reason: "restart",
          // `restartCauseKey` of `@ryco/shared/queueHold` (the test keeps them equal).
          causeKeys: [`restart:${deps.bootId}`],
          detail: RESTART_HOLD_DETAIL,
        }),
      { discard: true },
    );

    /** Whether the previous dispatch still owns the thread (its start is still pending). */
    const previousDispatchPending = (threadId: ThreadId, nowMs: number) =>
      Effect.gen(function* () {
        const previous = awaiting.get(threadId);
        if (previous === undefined) return false;
        const state = yield* fence.wakeStartState(threadId, previous.messageId);
        if (state === "bound" || state === "absent") {
          awaiting.delete(threadId);
          if (state === "bound") watched.delete(previous.messageId);
          return false;
        }
        // `failed`: the start-ended event records the hold (or a Stop already did) and clears
        // this; until then nothing else is sent.
        if (state === "failed") return true;
        if (nowMs - previous.sinceMs >= QUEUE_DISPATCH_STALL_MS) {
          awaiting.delete(threadId);
          yield* recordHold(threadId, `queue-stalled-hold:${threadId}:${nextAttemptId()}`, {
            reason: "stalled",
            causeKeys: [`stalled:${previous.messageId}`],
            detail: "The last queued message has not started.",
          });
        }
        return true;
      });

    /** One pass over a thread's queue: sends its head when everything lets it. */
    const drainThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const thread = deps.findThread((yield* deps.readModel).threads, threadId);
        if (thread === undefined || thread.deletedAt !== null) {
          awaiting.delete(threadId);
          refusals.delete(threadId);
          return;
        }
        const queue = thread.followUpQueue;
        const head = queue?.entries[0];
        const attemptKey = head === undefined ? null : `${head.messageId}:${head.revision}`;
        // Refusals count for the head as it is now; an edited or removed head starts over.
        if (refusals.get(threadId)?.key !== attemptKey) refusals.delete(threadId);
        if (queue === undefined || head === undefined || attemptKey === null) {
          reviewHeld.delete(threadId);
          reviewed.delete(threadId);
          return;
        }
        // In Trash, or held: sends nothing (Trash also holds the queue).
        if (queue.hold !== null || thread.trashedAt != null) return;
        if (head.status !== "queued") return;
        const nowMs = yield* Clock.currentTimeMillis;
        if (yield* previousDispatchPending(threadId, nowMs)) return;
        const shell = yield* deps.getThreadShellById(threadId);
        if (Option.isNone(shell)) return;
        const modes = queueDispatchModes(head, shell.value, deps.runtimeModePrivilegeRank);
        // The pin first, then the idle check: a person's message accepted after the pin fails the
        // decider's guard, and one accepted before it shows as a pending start here.
        const latestUserMessageId = yield* fence.latestUserMessageId(threadId);
        // The usage limit that matters is the one of the instance the head is sent to.
        const held = yield* fence.holdReason(
          { ...shell.value, modelSelection: modes.modelSelection },
          nowMs,
          "follow-up-queue",
        );
        if (held !== null) return;
        if (yield* awaitsClaudeReview(thread, head, modes.modelSelection, nowMs)) return;
        const { cold, budgetFull } = yield* fence.coldStart(threadId, nowMs);
        if (cold && budgetFull) return;
        let reserved = false;
        return yield* Effect.gen(function* () {
          if (cold) {
            reserved = yield* Effect.uninterruptible(
              fence.reserveColdSlot(threadId, head.messageId, nowMs),
            );
            if (!reserved) return;
          }
          // Last before the dispatch: it reads the revert journal.
          if (yield* fence.reverting(threadId, nowMs)) return;
          const refused = refusals.get(threadId)?.count ?? 0;
          const command = queueDispatchCommand({
            threadId,
            head,
            modes,
            guard: deps.serverWakeGuard(shell.value, latestUserMessageId, "follow-up-queue"),
            attemptId: nextAttemptId(),
            createdAt: isoAt(nowMs),
          });
          const exit = yield* Effect.exit(deps.dispatch(command));
          if (Exit.isSuccess(exit)) {
            refusals.delete(threadId);
            awaiting.set(threadId, { messageId: head.messageId, sinceMs: nowMs });
            watch(head.messageId, threadId);
            if (cold) {
              yield* fence.noteColdWake(threadId, head.messageId, nowMs);
              reserved = false;
            }
            return;
          }
          if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt;
          // Refused (the thread changed meanwhile, say): the entry stays queued and the next
          // pass tries again, until the same revision was refused too often.
          const error = Cause.squash(exit.cause);
          const detail = error instanceof Error ? error.message : "The node refused it.";
          if (refused + 1 < MAX_QUEUE_DISPATCH_ATTEMPTS) {
            refusals.set(threadId, { key: attemptKey, count: refused + 1 });
            return;
          }
          // After a Resume the head gets as many attempts again, under new ids.
          refusals.delete(threadId);
          yield* recordHold(threadId, `queue-refused-hold:${threadId}:${nextAttemptId()}`, {
            reason: "error",
            causeKeys: [`dispatch-refused:${attemptKey}`],
            detail: `The queued message could not be sent: ${detail}`.slice(0, 1_000),
          });
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              reserved ? fence.releaseColdSlot(threadId, head.messageId) : Effect.void,
            ),
          ),
        );
      });

    /** A sent entry's start ended without a turn: a failure holds the rest of the queue. */
    const onStartEnded = (threadId: ThreadId, ended: QueueStartEnded) =>
      Effect.gen(function* () {
        if (watched.get(ended.messageId) !== threadId) return;
        watched.delete(ended.messageId);
        if (awaiting.get(threadId)?.messageId === ended.messageId) awaiting.delete(threadId);
        if (ended.cancelled) return;
        yield* recordHold(threadId, `queue-start-failed-hold:${threadId}:${ended.activityId}`, {
          reason: "error",
          // `turnStartFailedCauseKey` of `@ryco/shared/queueHold` (the test keeps them equal).
          causeKeys: [`start-failed:${ended.activityId}`],
          detail: ended.detail?.slice(0, 1_000) ?? null,
        });
      });

    return {
      holdQueuedAtBoot,
      drainThread,
      onStartEnded,
      /** Threads with refusals counted (tests: the map never outgrows the queues). */
      refusalCount: () => refusals.size,
      /** Threads with a review remembered (tests: the maps never outgrow the queues). */
      reviewCount: () => reviewHeld.size + reviewed.size,
    };
  });

/** Thread events after which a queue may be able to send (the fence may have opened). */
const DRAIN_WAKE_EVENT_TYPES: ReadonlySet<OrchestrationEvent["type"]> = new Set([
  "thread.session-set",
  "thread.turn-diff-completed",
  "thread.reverted",
  "thread.unarchived",
  "thread.usage-limit-cleared",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.queue-entry-added",
  "thread.queue-entry-edited",
  "thread.queue-reordered",
  "thread.queue-entries-removed",
  "thread.queue-released",
]);

const START_ENDED_KINDS = new Set(["provider.turn.start.failed", "provider.turn.start.cancelled"]);

/** A `provider.turn.start.*` activity of a message, or null for any other event. */
export function queueStartEndedOf(event: OrchestrationEvent): QueueStartEnded | null {
  if (event.type !== "thread.activity-appended") return null;
  const activity = event.payload.activity;
  if (!START_ENDED_KINDS.has(activity.kind)) return null;
  const payload = activity.payload as { messageId?: unknown; detail?: unknown } | null;
  if (typeof payload?.messageId !== "string") return null;
  return {
    messageId: payload.messageId as MessageId,
    activityId: activity.id,
    cancelled: activity.kind === "provider.turn.start.cancelled",
    detail: typeof payload.detail === "string" ? payload.detail : activity.summary,
  };
}

/** Threads a sweep passes over: an unheld queue that holds an entry. */
export const sweptThreadIds = (threads: OrchestrationReadModel["threads"]) =>
  threads
    .filter((thread) => {
      const queue = thread.followUpQueue;
      return queue !== undefined && queue.entries.length > 0 && queue.hold === null;
    })
    .map((thread) => thread.id);

type LaneItem =
  | { readonly kind: "drain" }
  | { readonly kind: "start-ended"; readonly ended: QueueStartEnded };

/** Runs the drain until its scope closes. */
export const runServerQueueDrain = (deps: ServerQueueDrainDeps) =>
  Effect.gen(function* () {
    const drain = yield* makeServerQueueDrain(deps);
    // Subscribed before the boot holds, so no event after them is missed.
    const events = yield* deps.subscribeDomainEvents;
    yield* drain.holdQueuedAtBoot;

    // A thread with a pass already queued gets no second one; a pass running now does.
    const passQueued = new Set<ThreadId>();
    const lanes = yield* deps.makeKeyedSerialWorker({
      policy: deps.losslessBackpressureQueuePolicy({
        component: "ServerQueueDrain",
        capacity: 1024,
      }),
      process: (threadId: ThreadId, item: LaneItem) =>
        item.kind === "start-ended"
          ? drain.onStartEnded(threadId, item.ended)
          : Effect.suspend(() => {
              passQueued.delete(threadId);
              return drain.drainThread(threadId);
            }),
    });
    const enqueue = lanes.enqueue;
    const wake = (threadId: ThreadId) =>
      Effect.suspend(() => {
        if (passQueued.has(threadId)) return Effect.void;
        passQueued.add(threadId);
        return enqueue(threadId, { kind: "drain" });
      });

    yield* Effect.forkScoped(
      Stream.runForEach(events, (event) =>
        Effect.gen(function* () {
          if (event.aggregateKind !== "thread") return;
          const threadId = event.aggregateId as ThreadId;
          const ended = queueStartEndedOf(event);
          if (ended !== null) {
            yield* enqueue(threadId, { kind: "start-ended", ended });
            return yield* wake(threadId);
          }
          if (DRAIN_WAKE_EVENT_TYPES.has(event.type)) yield* wake(threadId);
        }),
      ),
    );

    return yield* Effect.forever(
      deps.readModel.pipe(
        Effect.map((model) => sweptThreadIds(model.threads)),
        Effect.flatMap((threadIds) => Effect.forEach(threadIds, wake, { discard: true })),
        Effect.catch(() => Effect.logWarning("follow-up queue sweep will retry")),
        Effect.andThen(Effect.sleep(QUEUE_DRAIN_SWEEP_INTERVAL)),
      ),
    );
  }).pipe(Effect.scoped);
