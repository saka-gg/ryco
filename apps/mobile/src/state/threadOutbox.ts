import { scopeThreadRef, scopedThreadKey } from "@ryco/client-runtime/scoped";
import {
  isClaudeResumeReviewError,
  isModelSwitchBackgroundWorkError,
} from "@ryco/client-runtime/state/composer";
import {
  appendAcknowledgedCauseKeys,
  createInterruptQueueHold,
  deriveQueueFailureCauses,
  MAX_ACKNOWLEDGED_CAUSE_KEYS,
  moveDeviceQueueToServer,
  QUEUE_HOLD_RANK,
  queueMigrationFailedHold,
  readQueueThreadView,
  releaseQueueHoldKeys,
  removeQueueHoldCauses,
  resolveQueueDrainStep,
  mergeQueueHold,
  type QueueDrainSteerRejection,
  type QueueEnvironmentReadiness,
  type QueueHold,
  type QueueSendHooks,
  type QueueThreadView,
  type QueuedMessageSteerAttempt,
} from "@ryco/client-runtime/state/message-queue";
import {
  captureQueuedDispatchSnapshot,
  type QueuedDispatchSnapshot,
} from "@ryco/client-runtime/state/session";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@ryco/contracts";
import { usageLimitHoldReleaseAtMs } from "@ryco/shared/usageLimit";
import { mobileKV } from "../platform/kv";
import type { DraftComposerFileAttachment } from "../lib/composerFiles";
import { useMessageQueueStore } from "./messageQueueStore";
// The shared threads store itself, not the `./threadsRuntime` binding: that
// module pulls in the React Native platform, and this one stays node-testable.
// Both name the same singleton.
import { selectEnvironmentShellLive, useStore } from "@ryco/client-runtime/state/threads";
import {
  groupQueuedThreadMessages,
  isQueuedThreadMessageHeld,
  isQueuedThreadMessageMovable,
  normalizePersistedQueuedThreadMessageAttachments,
  resolveThreadOutboxFailureAction,
  type QueuedThreadMessage,
} from "./threadOutboxModel";

// §3-14 (ratified option 2): the PERSISTENT offline outbox. Queued turns for
// existing threads survive an app kill (persisted to the injected mobileKV), are
// mirrored into B1's in-memory useMessageQueueStore for the composer UI, and drain
// through the runtime send path on reconnect. The drain decisions come from the
// shared client-runtime queue policy (`resolveQueueDrainStep`); this module owns
// persistence (messages, queue holds, their acknowledged-cause baselines and the
// causes each thread last showed live) and the drain loop, which sends at most
// one message per thread per pass and waits for that message's own turn to
// start before the next (a bound wrapper, no import-time side effects). On a
// node that keeps follow-up queues itself (`capabilities.serverFollowUpQueue`)
// the outbox is only the offline intake: its messages move to the node's queue
// (`thread.queue.add`, design §3.7) instead of being sent as turns from here.

const OUTBOX_STORAGE_KEY = "ryco.threadOutbox.v1";
const HOLDS_STORAGE_KEY = "ryco.threadOutboxHolds.v1";
/** A queued send whose turn has not started after this long holds the queue. */
const ACK_TIMEOUT_MS = 90_000;
const MODEL_SWITCH_HELD_MESSAGE =
  "Background tasks are still running in this thread, so the model was not switched.";
const MAX_STEPS_PER_THREAD = 8;
const MAX_DISPATCHED_PER_THREAD = 16;
const MAX_SNAPSHOTS = 64;
const MAX_SEEN_LIVE_THREADS = 64;
const EMPTY_DISPATCHED: ReadonlySet<string> = new Set();

let messages: QueuedThreadMessage[] = [];
let holds: Record<string, QueueHold> = {};
let acknowledged: Record<string, readonly string[]> = {};
/**
 * Failure causes each thread last showed on a LIVE row, newest last. Cached and
 * demoted rows (a cold start from the snapshot cache, a hosted demotion) drop
 * every session, so a message composed against them baselines from here: the
 * error the user saw before going offline does not hold their reply to it.
 * Only threads with a cause are kept, bounded.
 */
let seenLive: Record<string, readonly string[]> = {};
let hydrated = false;
let hydrationStarted = false;
const listeners = new Set<() => void>();

// In memory only: an app kill loses a pending ack (bounded to one early send).
const pendingDispatchByThreadKey = new Map<string, QueuedDispatchSnapshot>();
const dispatchedByThreadKey = new Map<string, Set<string>>();
const failedSnapshots = new Map<string, QueuedDispatchSnapshot>();
const inFlightThreadKeys = new Set<string>();
/**
 * Per thread, the message whose add to the node's queue is on its way. It must not be edited or
 * steered meanwhile: the add can still land, so an edited copy or a steer would be a second one.
 */
const movingMessageIdByThreadKey = new Map<string, string>();
/** Bumped by the test reset: a move from before it leaves everything alone. */
let outboxEpoch = 0;
/**
 * Messages with a live steer attempt, by message id. In memory only: an app kill ends every
 * attempt, and the message is then sent as a normal turn. The drain never sends one as a turn.
 */
const steeringOutboxAttempts = new Map<string, QueuedMessageSteerAttempt>();

/** Marks a queued message as being steered; the drain stops at it, preserving order. */
export function markThreadOutboxSteering(
  messageId: string,
  attempt: QueuedMessageSteerAttempt,
): void {
  if (steeringOutboxAttempts.has(messageId)) return;
  steeringOutboxAttempts.set(messageId, attempt);
  notifyListeners();
}

/** Ends a steer attempt; with a `commandId`, only that attempt (a stale outcome is ignored). */
export function clearThreadOutboxSteering(messageId: string, commandId?: string): void {
  const attempt = steeringOutboxAttempts.get(messageId);
  if (!attempt || (commandId !== undefined && attempt.commandId !== commandId)) return;
  steeringOutboxAttempts.delete(messageId);
  notifyListeners();
}

/**
 * Ends a steer attempt its own request rejected (stale outcomes are ignored). A rejection the
 * provider may have received holds the message in place for an explicit retry or removal.
 * Both the drain and the thread screen's outcome effect call this, so whichever sees the
 * rejection first applies it and the other finds no attempt.
 */
export function endThreadOutboxSteer(rejection: QueueDrainSteerRejection): void {
  const attempt = steeringOutboxAttempts.get(rejection.messageId);
  if (!attempt || attempt.commandId !== rejection.attempt.commandId) return;
  steeringOutboxAttempts.delete(rejection.messageId);
  if (rejection.deliveryUncertain) {
    updateThreadOutboxMessage(rejection.messageId, (message) => ({
      ...message,
      uncertainSteerError: rejection.error,
    }));
  }
  notifyListeners();
}

function steerAttemptsFor(
  queue: ReadonlyArray<QueuedThreadMessage>,
): Record<string, QueuedMessageSteerAttempt> {
  const attempts: Record<string, QueuedMessageSteerAttempt> = {};
  for (const message of queue) {
    const attempt = steeringOutboxAttempts.get(message.messageId);
    if (attempt) attempts[message.messageId] = attempt;
  }
  return attempts;
}

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

export function subscribeThreadOutbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function threadKeyOf(message: Pick<QueuedThreadMessage, "environmentId" | "threadId">): string {
  return scopedThreadKey(scopeThreadRef(message.environmentId, message.threadId));
}

/** Mirror the persisted queue into the in-memory message-queue store (composer UI). */
function mirrorToQueueStore(): void {
  const store = useMessageQueueStore.getState();
  for (const key of Object.keys(store.queuesByThreadKey)) store.clear(key);
  for (const [threadKey, queue] of Object.entries(groupQueuedThreadMessages(messages))) {
    for (const message of queue) {
      store.enqueue(threadKey, {
        id: message.messageId,
        composer: { text: message.text, attachments: message.attachments },
        settings: {
          modelSelection: message.modelSelection,
          runtimeMode: message.runtimeMode,
          interactionMode: message.interactionMode,
          tokenMode: message.tokenMode,
        },
      });
    }
  }
}

function persist(): void {
  // The local read uri is transient: restored files carry token metadata or a
  // needsReattach marker only, never a byte source.
  void mobileKV
    .setItem(
      OUTBOX_STORAGE_KEY,
      JSON.stringify(
        messages.map((message) => ({
          ...message,
          attachments: message.attachments.map((attachment) =>
            attachment.type === "file" ? stripFileReadUri(attachment) : attachment,
          ),
        })),
      ),
    )
    .catch(() => {
      // Fire-and-forget: the in-memory queue stays authoritative until the next write.
    });
}

function persistHolds(): void {
  void mobileKV
    .setItem(HOLDS_STORAGE_KEY, JSON.stringify({ holds, acknowledged, seenLive }))
    .catch(() => {
      // Fire-and-forget, like `persist`.
    });
}

function stripFileReadUri(attachment: DraftComposerFileAttachment) {
  const { readUri: _readUri, ...persisted } = attachment;
  return persisted;
}

function sanitizeHold(value: unknown): QueueHold | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.reason !== "string" ||
    !Object.hasOwn(QUEUE_HOLD_RANK, candidate.reason) ||
    typeof candidate.heldAt !== "string" ||
    !Array.isArray(candidate.causeKeys)
  ) {
    return null;
  }
  const causeKeys = candidate.causeKeys.filter((key): key is string => typeof key === "string");
  if (causeKeys.length === 0) return null;
  return {
    reason: candidate.reason as QueueHold["reason"],
    detail: typeof candidate.detail === "string" ? candidate.detail : null,
    causeKeys,
    heldAt: candidate.heldAt,
  };
}

function sanitizeCauseKeyRecord(value: unknown): Record<string, readonly string[]> {
  const next: Record<string, readonly string[]> = {};
  if (!value || typeof value !== "object") return next;
  for (const [key, keys] of Object.entries(value)) {
    if (!Array.isArray(keys)) continue;
    next[key] = keys
      .filter((entry): entry is string => typeof entry === "string")
      .slice(-MAX_ACKNOWLEDGED_CAUSE_KEYS);
  }
  return next;
}

function sanitizeHoldState(raw: unknown): {
  holds: Record<string, QueueHold>;
  acknowledged: Record<string, readonly string[]>;
  seenLive: Record<string, readonly string[]>;
} {
  const nextHolds: Record<string, QueueHold> = {};
  if (!raw || typeof raw !== "object") return { holds: nextHolds, acknowledged: {}, seenLive: {} };
  const candidate = raw as Record<string, unknown>;
  if (candidate.holds && typeof candidate.holds === "object") {
    for (const [key, value] of Object.entries(candidate.holds)) {
      const hold = sanitizeHold(value);
      if (hold) nextHolds[key] = hold;
    }
  }
  const nextSeenLive: Record<string, readonly string[]> = {};
  for (const [key, keys] of Object.entries(sanitizeCauseKeyRecord(candidate.seenLive)).slice(
    -MAX_SEEN_LIVE_THREADS,
  )) {
    if (keys.length > 0) nextSeenLive[key] = keys;
  }
  return {
    holds: nextHolds,
    acknowledged: sanitizeCauseKeyRecord(candidate.acknowledged),
    seenLive: nextSeenLive,
  };
}

/** Records a thread's live causes as the newest entry; false when nothing changed. */
function recordSeenLive(threadKey: string, causeKeys: readonly string[]): boolean {
  const previous = seenLive[threadKey];
  if (causeKeys.length === 0) {
    if (previous === undefined) return false;
    delete seenLive[threadKey];
    return true;
  }
  if (
    previous !== undefined &&
    previous.length === causeKeys.length &&
    previous.every((key, index) => causeKeys[index] === key)
  ) {
    return false;
  }
  delete seenLive[threadKey];
  seenLive[threadKey] = causeKeys.slice(-MAX_ACKNOWLEDGED_CAUSE_KEYS);
  const keys = Object.keys(seenLive);
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_SEEN_LIVE_THREADS))) {
    delete seenLive[stale];
  }
  return true;
}

/** The causes a thread shows now, including an interrupt whose turn is still settling. */
function currentCauseKeys(view: QueueThreadView | null, threadKey: string): string[] {
  return view
    ? deriveQueueFailureCauses(view, dispatchedFor(threadKey), { includeUnsettled: true }).map(
        (cause) => cause.causeKey,
      )
    : [];
}

/**
 * Keeps {@link seenLive} current from the live rows of every environment.
 * Only threads whose session, latest turn or shell changed are re-derived. Mounted
 * once next to the drain; returns an unsubscribe.
 */
export function trackThreadOutboxLiveCauses(): () => void {
  let previous: ReturnType<typeof useStore.getState> | null = null;
  const sync = () => {
    const state = useStore.getState();
    let changed = false;
    for (const [environmentKey, environmentState] of Object.entries(state.environmentStateById)) {
      const environmentId = environmentKey as EnvironmentId;
      if (!environmentState || !selectEnvironmentShellLive(state, environmentId)) continue;
      const before =
        previous !== null && selectEnvironmentShellLive(previous, environmentId)
          ? previous.environmentStateById[environmentId]
          : undefined;
      // The shell carries the usage limit, which can land after the session-set.
      if (
        before !== undefined &&
        before.threadSessionById === environmentState.threadSessionById &&
        before.threadTurnStateById === environmentState.threadTurnStateById &&
        before.threadShellById === environmentState.threadShellById
      ) {
        continue;
      }
      for (const threadId of environmentState.threadIds) {
        if (
          before !== undefined &&
          before.threadSessionById[threadId] === environmentState.threadSessionById[threadId] &&
          before.threadTurnStateById[threadId] === environmentState.threadTurnStateById[threadId] &&
          before.threadShellById[threadId] === environmentState.threadShellById[threadId]
        ) {
          continue;
        }
        const ref = scopeThreadRef(environmentId, threadId as ThreadId);
        const threadKey = scopedThreadKey(ref);
        if (
          recordSeenLive(threadKey, currentCauseKeys(readQueueThreadView(state, ref), threadKey))
        ) {
          changed = true;
        }
      }
    }
    previous = state;
    // Before hydration a write would replace the persisted holds; hydration
    // merges what was recorded meanwhile and persists it.
    if (changed && hydrated) persistHolds();
  };
  sync();
  return useStore.subscribe(sync);
}

/**
 * A thread whose message group became empty drops its hold, baseline and
 * dispatch bookkeeping; the next enqueue records a fresh baseline.
 */
function pruneEmptyThreads(): boolean {
  const active = new Set(messages.map(threadKeyOf));
  let changed = false;
  for (const key of [...Object.keys(holds), ...Object.keys(acknowledged)]) {
    if (active.has(key)) continue;
    if (key in holds || key in acknowledged) changed = true;
    delete holds[key];
    delete acknowledged[key];
  }
  for (const key of [...pendingDispatchByThreadKey.keys(), ...dispatchedByThreadKey.keys()]) {
    if (active.has(key)) continue;
    pendingDispatchByThreadKey.delete(key);
    dispatchedByThreadKey.delete(key);
  }
  return changed;
}

function commitMessages(next: QueuedThreadMessage[]): void {
  messages = next;
  if (pruneEmptyThreads()) persistHolds();
  mirrorToQueueStore();
  persist();
  notifyListeners();
}

/** Idempotently load the persisted queue once. */
export async function hydrateThreadOutbox(): Promise<void> {
  if (hydrationStarted) return;
  hydrationStarted = true;
  try {
    const raw = await mobileKV.getItem(OUTBOX_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    messages = Array.isArray(parsed)
      ? parsed.flatMap((message) => {
          if (!message || typeof message !== "object") return [];
          const candidate = message as Record<string, unknown>;
          if (
            typeof candidate.messageId !== "string" ||
            typeof candidate.commandId !== "string" ||
            typeof candidate.text !== "string"
          ) {
            return [];
          }
          const queued = message as QueuedThreadMessage;
          return [
            {
              ...queued,
              attachments: normalizePersistedQueuedThreadMessageAttachments(candidate.attachments),
            },
          ];
        })
      : [];
  } catch {
    messages = [];
  }
  // Causes recorded live while the KV read was pending are newer than the
  // persisted ones and win.
  const recordedBeforeHydration = seenLive;
  try {
    const raw = await mobileKV.getItem(HOLDS_STORAGE_KEY);
    let persistedSeenLive: Record<string, readonly string[]>;
    ({
      holds,
      acknowledged,
      seenLive: persistedSeenLive,
    } = sanitizeHoldState(raw ? (JSON.parse(raw) as unknown) : null));
    seenLive = persistedSeenLive;
  } catch {
    holds = {};
    acknowledged = {};
    seenLive = {};
  }
  for (const [key, keys] of Object.entries(recordedBeforeHydration)) recordSeenLive(key, keys);
  pruneEmptyThreads();
  hydrated = true;
  if (Object.keys(recordedBeforeHydration).length > 0) persistHolds();
  mirrorToQueueStore();
  notifyListeners();
}

function dispatchedFor(key: string): ReadonlySet<string> {
  return dispatchedByThreadKey.get(key) ?? EMPTY_DISPATCHED;
}

export function enqueueThreadOutboxMessage(message: QueuedThreadMessage): void {
  const key = threadKeyOf(message);
  const wasEmpty = !messages.some((entry) => threadKeyOf(entry) === key);
  if (wasEmpty && acknowledged[key] === undefined) {
    // The thread as the user saw it while composing: causes current now are
    // already acknowledged, so an offline message composed in response to an
    // error is not held by it. Cached or demoted rows carry no session, so
    // they add the causes the thread last showed live; a failure that happened
    // while offline is still new on reconnect and holds.
    const state = useStore.getState();
    const view = readQueueThreadView(
      state,
      scopeThreadRef(message.environmentId, message.threadId),
    );
    const seenBeforeOffline = selectEnvironmentShellLive(state, message.environmentId)
      ? []
      : (seenLive[key] ?? []);
    acknowledged[key] = appendAcknowledgedCauseKeys(undefined, [
      ...seenBeforeOffline,
      ...currentCauseKeys(view, key),
    ]);
    persistHolds();
  }
  commitMessages([...messages.filter((m) => m.messageId !== message.messageId), message]);
}

export function removeThreadOutboxMessage(messageId: string): void {
  steeringOutboxAttempts.delete(messageId);
  const next = messages.filter((m) => m.messageId !== messageId);
  if (next.length === messages.length) return;
  commitMessages(next);
}

/** Rewrites one message in place, keeping its queue position. */
function updateThreadOutboxMessage(
  messageId: string,
  update: (message: QueuedThreadMessage) => QueuedThreadMessage,
): void {
  if (!messages.some((message) => message.messageId === messageId)) return;
  commitMessages(
    messages.map((message) => (message.messageId === messageId ? update(message) : message)),
  );
}

/** The user's explicit retry of a message held after a delivery-uncertain steer. */
export function retryThreadOutboxMessage(messageId: string): void {
  updateThreadOutboxMessage(messageId, ({ uncertainSteerError: _held, ...message }) => message);
}

export function listThreadOutboxMessages(): ReadonlyArray<QueuedThreadMessage> {
  return messages;
}

export function getThreadOutboxHold(threadKey: string): QueueHold | null {
  return holds[threadKey] ?? null;
}

/**
 * A queued message of the thread is being sent from here, or the turn of the last one sent
 * has not started yet (and the queue is not held): a new message has to queue behind it.
 */
export function isThreadOutboxDispatchPending(threadKey: string): boolean {
  if (inFlightThreadKeys.has(threadKey)) return true;
  return pendingDispatchByThreadKey.has(threadKey) && holds[threadKey] === undefined;
}

/** The thread's message whose add to the node's queue is on its way, if any. */
export function getThreadOutboxMovingMessageId(threadKey: string): string | null {
  return movingMessageIdByThreadKey.get(threadKey) ?? null;
}

function setHold(threadKey: string, hold: QueueHold | null): void {
  if (hold) holds[threadKey] = hold;
  else delete holds[threadKey];
  persistHolds();
}

/** Records the explicit Stop hold; `undo` removes only what this call added. */
export function holdThreadOutboxForInterrupt(
  threadKey: string,
  activeTurnId: string | null,
): { undo(): void } {
  if (!messages.some((message) => threadKeyOf(message) === threadKey)) return { undo: () => {} };
  const stop = createInterruptQueueHold(activeTurnId, new Date().toISOString());
  const existing = holds[threadKey] ?? null;
  const added = stop.causeKeys.filter((key) => !existing?.causeKeys.includes(key));
  if (added.length === 0) return { undo: () => {} };
  holds[threadKey] = mergeQueueHold(existing, stop, stop.heldAt);
  persistHolds();
  notifyListeners();
  return {
    undo: () => {
      const current = holds[threadKey];
      if (!current) return;
      setHold(threadKey, removeQueueHoldCauses(current, added));
      notifyListeners();
    },
  };
}

/** Resume: acknowledges the hold's causes plus every current one and stops waiting on the last send. */
export function releaseThreadOutboxHold(threadKey: string): void {
  const head = messages.find((message) => threadKeyOf(message) === threadKey);
  if (!head) return;
  const view = readQueueThreadView(
    useStore.getState(),
    scopeThreadRef(head.environmentId, head.threadId),
  );
  acknowledged[threadKey] = appendAcknowledgedCauseKeys(
    acknowledged[threadKey],
    releaseQueueHoldKeys(
      holds[threadKey] ?? null,
      view
        ? deriveQueueFailureCauses(view, dispatchedFor(threadKey), { includeUnsettled: true })
        : [],
    ),
  );
  delete holds[threadKey];
  pendingDispatchByThreadKey.delete(threadKey);
  persistHolds();
  notifyListeners();
}

/** Test seam. */
export function resetThreadOutboxForTests(): void {
  messages = [];
  holds = {};
  acknowledged = {};
  seenLive = {};
  hydrated = false;
  hydrationStarted = false;
  pendingDispatchByThreadKey.clear();
  dispatchedByThreadKey.clear();
  failedSnapshots.clear();
  inFlightThreadKeys.clear();
  movingMessageIdByThreadKey.clear();
  steeringOutboxAttempts.clear();
  outboxEpoch += 1;
  notifyListeners();
}

export interface ThreadOutboxDrainState {
  readonly view: QueueThreadView | null;
  readonly environment: QueueEnvironmentReadiness;
  /**
   * The node is about to send its follow-up queue's head, or an add to it is still on its way:
   * a message the node's queue cannot carry waits behind them.
   */
  readonly serverQueueWaiting?: boolean | undefined;
}

// The per-thread context the drain needs from live state, and the send seam.
export interface ThreadOutboxDrainDeps {
  /** Live thread view and environment readiness for one queued thread. */
  readonly readThreadDrainState: (ref: ScopedThreadRef) => ThreadOutboxDrainState;
  /** Dispatch the queued turn through the runtime send path (commitSendTurnDispatch). */
  readonly sendQueuedMessage: (
    message: QueuedThreadMessage,
    hooks: QueueSendHooks,
  ) => Promise<void>;
  readonly onInterrupted?: () => boolean;
  /**
   * Sends one message to the node's follow-up queue (`thread.queue.add` under its own message
   * id, with the thread's hold on this device). Resolves once the node acknowledged it, a
   * no-op for an id it already has included; rejects otherwise. Without it, messages are
   * always sent from here as turns.
   */
  readonly moveQueuedMessageToServer?: (
    message: QueuedThreadMessage,
    context: { readonly hold: QueueHold | null },
  ) => Promise<void>;
  /** Every message queued for the environment moved to its node. */
  readonly onServerQueueMigrated?: (environmentId: EnvironmentId) => void;
  /** Test seam for the ack timeout. */
  readonly now?: () => number;
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

function addDispatched(key: string, messageId: string): void {
  const ids = dispatchedByThreadKey.get(key) ?? new Set<string>();
  ids.delete(messageId);
  ids.add(messageId);
  while (ids.size > MAX_DISPATCHED_PER_THREAD) {
    const oldest = ids.values().next();
    if (oldest.done) break;
    ids.delete(oldest.value);
  }
  dispatchedByThreadKey.set(key, ids);
}

function queueOf(key: string): ReadonlyArray<QueuedThreadMessage> {
  return groupQueuedThreadMessages(messages)[key] ?? [];
}

/**
 * Drain the persisted outbox through the shared queue policy. Per thread it
 * applies bookkeeping steps (baseline, reconcile, ack, hold) in place and
 * sends at most ONE message per pass: the next head waits until that
 * message's own turn starts, so a second `thread.turn.start` can never land in
 * the startSession bind window and be orphaned. Transient failures stay queued
 * for the next drain; permanent failures are discarded. Existing-thread
 * messages only.
 */
export async function drainThreadOutbox(deps: ThreadOutboxDrainDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  for (const key of Object.keys(groupQueuedThreadMessages(messages))) {
    if (inFlightThreadKeys.has(key)) continue;
    for (let step = 0; step < MAX_STEPS_PER_THREAD; step += 1) {
      const queue = queueOf(key);
      const head = queue[0];
      if (!head) break;
      const ref = scopeThreadRef(head.environmentId, head.threadId);
      const { view, environment, serverQueueWaiting } = deps.readThreadDrainState(ref);
      const nowMs = now();
      const nowIso = new Date(nowMs).toISOString();
      const pending = pendingDispatchByThreadKey.get(key) ?? null;
      // Mobile has no timers in the loop: a pass that finds a send still
      // unacknowledged after the timeout holds the queue as stalled.
      if (pending && nowMs - Date.parse(pending.capturedAt) > ACK_TIMEOUT_MS) {
        const stalledKey = `stalled:${pending.messageId}`;
        if (!holds[key]?.causeKeys.includes(stalledKey)) {
          setHold(
            key,
            mergeQueueHold(
              holds[key] ?? null,
              { reason: "stalled", causeKeys: [stalledKey], detail: null },
              nowIso,
            ),
          );
          notifyListeners();
        }
      }
      const drainStep = resolveQueueDrainStep({
        nowIso,
        queue: queue.map((message) =>
          isQueuedThreadMessageHeld(message)
            ? { id: message.messageId, deliveryStatus: "failed" as const }
            : { id: message.messageId },
        ),
        // A message being steered stops the drain: later messages keep their order.
        steerAttempts: steerAttemptsFor(queue),
        hold: holds[key] ?? null,
        acknowledgedCauseKeys: acknowledged[key],
        headProviderInstanceId: head.modelSelection?.instanceId ?? null,
        view,
        draft: false,
        environment: {
          shellLive: environment.shellLive,
          mutationReady: environment.mutationReady,
          serverQueue:
            environment.serverQueue === true && deps.moveQueuedMessageToServer !== undefined,
        },
        headMigratable: isQueuedThreadMessageMovable(head),
        pendingDispatch: pending,
        dispatchedMessageIds: dispatchedFor(key),
        // The mobile sender reaches any existing server thread.
        sender: view !== null ? "background" : null,
        serverQueueWaiting,
      });
      if (drainStep.kind === "idle" || drainStep.kind === "wait") break;
      if (drainStep.kind === "thread-gone") {
        commitMessages(messages.filter((message) => threadKeyOf(message) !== key));
        break;
      }
      if (drainStep.kind === "baseline" || drainStep.kind === "acknowledge") {
        acknowledged[key] = appendAcknowledgedCauseKeys(acknowledged[key], drainStep.causeKeys);
        persistHolds();
        continue;
      }
      if (drainStep.kind === "release") {
        // An ended usage limit: drop its causes and never hold for them again.
        acknowledged[key] = appendAcknowledgedCauseKeys(acknowledged[key], drainStep.causeKeys);
        const hold = holds[key];
        setHold(key, hold ? removeQueueHoldCauses(hold, drainStep.causeKeys) : null);
        notifyListeners();
        continue;
      }
      if (drainStep.kind === "hold" || drainStep.kind === "dispatch-failed") {
        if (drainStep.kind === "dispatch-failed") pendingDispatchByThreadKey.delete(key);
        setHold(key, drainStep.hold);
        notifyListeners();
        continue;
      }
      if (drainStep.kind === "dispatch-started") {
        pendingDispatchByThreadKey.delete(key);
        const stalledKey = `stalled:${drainStep.messageId}`;
        const hold = holds[key];
        if (hold?.causeKeys.includes(stalledKey)) {
          setHold(key, removeQueueHoldCauses(hold, [stalledKey]));
          notifyListeners();
        }
        continue;
      }
      if (drainStep.kind === "reconcile") {
        for (const rejection of drainStep.endSteers) endThreadOutboxSteer(rejection);
        for (const id of drainStep.removeIds) steeringOutboxAttempts.delete(id);
        if (drainStep.removeIds.length > 0) {
          commitMessages(
            messages.filter((message) => !drainStep.removeIds.includes(message.messageId)),
          );
        }
        for (const id of drainStep.removeIds) {
          const failed = failedSnapshots.get(id);
          failedSnapshots.delete(id);
          // A send whose reply was lost is acknowledged by its projection; its
          // turn still has to start before the next head may go.
          if (failed && queueOf(key).length > 0) pendingDispatchByThreadKey.set(key, failed);
        }
        continue;
      }
      if (drainStep.kind === "migrate") {
        await moveThreadOutboxToServer(key, ref, deps);
        break;
      }
      // send: one message per thread per pass.
      await sendHead(key, head, view, nowIso, deps);
      break;
    }
  }
}

/**
 * Moves the thread's outbox messages to the node's follow-up queue, head first, through the
 * shared `moveDeviceQueueToServer`: each leaves the outbox (and its persisted copy) only once the
 * node acknowledged its add, so an interrupted move, even by an app kill, resumes from the
 * message it stopped at, and the node's no-op for a known id keeps a retried add from becoming
 * a second message. A held message moves as failed and waits for Retry there. The thread's hold
 * rides on each add; once its last message has moved, the hold and its baselines are deleted
 * with the thread's empty group. Holds the thread's in-flight slot, so nothing is sent from here
 * meanwhile.
 */
async function moveThreadOutboxToServer(
  key: string,
  ref: ScopedThreadRef,
  deps: ThreadOutboxDrainDeps,
): Promise<void> {
  const move = deps.moveQueuedMessageToServer;
  if (!move || inFlightThreadKeys.has(key)) return;
  const epoch = outboxEpoch;
  const current = () => outboxEpoch === epoch;
  inFlightThreadKeys.add(key);
  try {
    const outcome = await moveDeviceQueueToServer({
      nextEntry: () => {
        const head = queueOf(key)[0];
        return head &&
          isQueuedThreadMessageMovable(head) &&
          !steeringOutboxAttempts.has(head.messageId)
          ? head
          : null;
      },
      move: (message) => move(message, { hold: holds[key] ?? null }),
      isQueued: (message) => messages.some((entry) => entry.messageId === message.messageId),
      drop: (message) => removeThreadOutboxMessage(message.messageId),
      current,
      onMoving: (message) => {
        if (!current()) return;
        if (message === null) movingMessageIdByThreadKey.delete(key);
        else movingMessageIdByThreadKey.set(key, message.messageId);
        notifyListeners();
      },
    });
    if (outcome.kind === "failed") {
      // A connection that went away is not a refusal: the move resumes once it is back.
      if (deps.readThreadDrainState(ref).environment.mutationReady) {
        const nowIso = new Date((deps.now ?? Date.now)()).toISOString();
        setHold(
          key,
          mergeQueueHold(
            holds[key] ?? null,
            queueMigrationFailedHold(outcome.entry.messageId, outcome.error, nowIso),
            nowIso,
          ),
        );
      }
    } else if (
      outcome.kind === "moved" &&
      !messages.some((message) => message.environmentId === ref.environmentId)
    ) {
      deps.onServerQueueMigrated?.(ref.environmentId);
    }
  } finally {
    if (current()) {
      inFlightThreadKeys.delete(key);
      movingMessageIdByThreadKey.delete(key);
      notifyListeners();
    }
  }
}

async function sendHead(
  key: string,
  head: QueuedThreadMessage,
  view: QueueThreadView | null,
  nowIso: string,
  deps: ThreadOutboxDrainDeps,
): Promise<void> {
  const ref = scopeThreadRef(head.environmentId, head.threadId);
  const startSnapshot = captureQueuedDispatchSnapshot(view, head.messageId, nowIso);
  let hookSnapshot: QueuedDispatchSnapshot | null = null;
  inFlightThreadKeys.add(key);
  try {
    await deps.sendQueuedMessage(head, {
      onBeforeTurnStart: () => {
        hookSnapshot = captureQueuedDispatchSnapshot(
          deps.readThreadDrainState(ref).view,
          head.messageId,
          new Date((deps.now ?? Date.now)()).toISOString(),
        );
      },
    });
    addDispatched(key, head.messageId);
    removeThreadOutboxMessage(head.messageId);
    if (queueOf(key).length > 0) {
      pendingDispatchByThreadKey.set(key, hookSnapshot ?? startSnapshot);
    }
  } catch (error) {
    // Background tasks held the model switch back and nothing more was sent (the user
    // cancelled, the connection changed during the choice, or the node's refusal itself): the
    // node recorded nothing, so the message waits for an explicit retry, never dropped.
    if (isModelSwitchBackgroundWorkError(error)) {
      enqueueThreadOutboxMessage({
        ...head,
        resumeReviewError: error instanceof Error ? error.message : MODEL_SWITCH_HELD_MESSAGE,
      });
      return;
    }
    if (hookSnapshot) {
      addDispatched(key, head.messageId);
      setBounded(failedSnapshots, head.messageId, hookSnapshot, MAX_SNAPSHOTS);
    }
    if (isClaudeResumeReviewError(error)) {
      enqueueThreadOutboxMessage({ ...head, resumeReviewError: error.message });
      return;
    }
    const failure = resolveThreadOutboxFailureAction({
      stage: "start-turn",
      error,
      interrupted: deps.onInterrupted?.() ?? false,
    });
    if (failure === "discard") {
      removeThreadOutboxMessage(head.messageId);
    }
    // "retry" leaves the message queued for the next drain.
  } finally {
    inFlightThreadKeys.delete(key);
  }
}

/**
 * The earliest end of a usage-limit hold among queued threads. Nothing else changes at
 * that moment, so the drain must be woken for it.
 */
export function nextThreadOutboxLimitReleaseAtMs(
  readView: (ref: ScopedThreadRef) => QueueThreadView | null,
  nowMs: number,
): number | null {
  let earliest: number | null = null;
  for (const queue of Object.values(groupQueuedThreadMessages(messages))) {
    const head = queue[0];
    if (!head) continue;
    const view = readView(scopeThreadRef(head.environmentId, head.threadId));
    const releaseAtMs = view ? usageLimitHoldReleaseAtMs(view, nowMs) : null;
    if (releaseAtMs !== null && (earliest === null || releaseAtMs < earliest)) {
      earliest = releaseAtMs;
    }
  }
  return earliest;
}

export function retryThreadOutboxReview(messageId: string): void {
  const message = messages.find((entry) => entry.messageId === messageId);
  if (!message) return;
  const { resumeReviewError: _reason, ...retry } = message;
  enqueueThreadOutboxMessage(retry);
}
