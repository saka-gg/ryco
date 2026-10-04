import { scopeThreadRef, scopedThreadKey } from "@ryco/client-runtime/scoped";
import { isClaudeResumeReviewError } from "@ryco/client-runtime/state/composer";
import {
  appendAcknowledgedCauseKeys,
  createInterruptQueueHold,
  deriveQueueFailureCauses,
  MAX_ACKNOWLEDGED_CAUSE_KEYS,
  QUEUE_HOLD_RANK,
  readQueueThreadView,
  releaseQueueHoldKeys,
  removeQueueHoldCauses,
  resolveQueueDrainStep,
  mergeQueueHold,
  type QueueEnvironmentReadiness,
  type QueueHold,
  type QueueSendHooks,
  type QueueThreadView,
} from "@ryco/client-runtime/state/message-queue";
import {
  captureQueuedDispatchSnapshot,
  type QueuedDispatchSnapshot,
} from "@ryco/client-runtime/state/session";
import type { ScopedThreadRef } from "@ryco/contracts";
import { hasRetiredProjectMemory } from "@ryco/shared/retiredFeatures";
import { mobileKV } from "../platform/kv";
import type { DraftComposerFileAttachment } from "../lib/composerFiles";
import { useMessageQueueStore } from "./messageQueueStore";
// The shared threads store itself, not the `./threadsRuntime` binding: that
// module pulls in the React Native platform, and this one stays node-testable.
// Both name the same singleton.
import { useStore } from "@ryco/client-runtime/state/threads";
import {
  groupQueuedThreadMessages,
  normalizePersistedQueuedThreadMessageAttachments,
  resolveThreadOutboxFailureAction,
  type QueuedThreadMessage,
} from "./threadOutboxModel";

// §3-14 (ratified option 2): the PERSISTENT offline outbox. Queued turns for
// existing threads survive an app kill (persisted to the injected mobileKV), are
// mirrored into B1's in-memory useMessageQueueStore for the composer UI, and drain
// through the runtime send path on reconnect. The drain decisions come from the
// shared client-runtime queue policy (`resolveQueueDrainStep`); this module owns
// persistence (messages, queue holds and their acknowledged-cause baselines) and
// the drain loop, which sends at most one message per thread per pass and waits
// for that message's own turn to start before the next (a bound wrapper, no
// import-time side effects).

const OUTBOX_STORAGE_KEY = "ryco.threadOutbox.v1";
const HOLDS_STORAGE_KEY = "ryco.threadOutboxHolds.v1";
/** A queued send whose turn has not started after this long holds the queue. */
const ACK_TIMEOUT_MS = 90_000;
const MAX_STEPS_PER_THREAD = 8;
const MAX_DISPATCHED_PER_THREAD = 16;
const MAX_SNAPSHOTS = 64;
const EMPTY_DISPATCHED: ReadonlySet<string> = new Set();

let messages: QueuedThreadMessage[] = [];
let holds: Record<string, QueueHold> = {};
let acknowledged: Record<string, readonly string[]> = {};
let hydrated = false;
let hydrationStarted = false;
const listeners = new Set<() => void>();

// In memory only: an app kill loses a pending ack (bounded to one early send).
const pendingDispatchByThreadKey = new Map<string, QueuedDispatchSnapshot>();
const dispatchedByThreadKey = new Map<string, Set<string>>();
const failedSnapshots = new Map<string, QueuedDispatchSnapshot>();
const inFlightThreadKeys = new Set<string>();

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

export function subscribeThreadOutbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isThreadOutboxHydrated(): boolean {
  return hydrated;
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
  void mobileKV.setItem(HOLDS_STORAGE_KEY, JSON.stringify({ holds, acknowledged })).catch(() => {
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

function sanitizeHoldState(raw: unknown): {
  holds: Record<string, QueueHold>;
  acknowledged: Record<string, readonly string[]>;
} {
  const nextHolds: Record<string, QueueHold> = {};
  const nextAcknowledged: Record<string, readonly string[]> = {};
  if (!raw || typeof raw !== "object") return { holds: nextHolds, acknowledged: nextAcknowledged };
  const candidate = raw as Record<string, unknown>;
  if (candidate.holds && typeof candidate.holds === "object") {
    for (const [key, value] of Object.entries(candidate.holds)) {
      const hold = sanitizeHold(value);
      if (hold) nextHolds[key] = hold;
    }
  }
  if (candidate.acknowledged && typeof candidate.acknowledged === "object") {
    for (const [key, value] of Object.entries(candidate.acknowledged)) {
      if (!Array.isArray(value)) continue;
      nextAcknowledged[key] = value
        .filter((entry): entry is string => typeof entry === "string")
        .slice(-MAX_ACKNOWLEDGED_CAUSE_KEYS);
    }
  }
  return { holds: nextHolds, acknowledged: nextAcknowledged };
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
  try {
    const raw = await mobileKV.getItem(HOLDS_STORAGE_KEY);
    ({ holds, acknowledged } = sanitizeHoldState(raw ? (JSON.parse(raw) as unknown) : null));
  } catch {
    holds = {};
    acknowledged = {};
  }
  pruneEmptyThreads();
  hydrated = true;
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
    // error is not held by it. Cached or demoted rows carry no session, so a
    // failure that happened while offline is new on reconnect and holds
    // (conservative: one Resume clears an error the user had already seen).
    const view = readQueueThreadView(
      useStore.getState(),
      scopeThreadRef(message.environmentId, message.threadId),
    );
    acknowledged[key] = appendAcknowledgedCauseKeys(
      undefined,
      view ? deriveQueueFailureCauses(view, dispatchedFor(key)).map((cause) => cause.causeKey) : [],
    );
    persistHolds();
  }
  commitMessages([...messages.filter((m) => m.messageId !== message.messageId), message]);
}

export function removeThreadOutboxMessage(messageId: string): void {
  const next = messages.filter((m) => m.messageId !== messageId);
  if (next.length === messages.length) return;
  commitMessages(next);
}

export function listThreadOutboxMessages(): ReadonlyArray<QueuedThreadMessage> {
  return messages;
}

export function getThreadOutboxHold(threadKey: string): QueueHold | null {
  return holds[threadKey] ?? null;
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
      view ? deriveQueueFailureCauses(view, dispatchedFor(threadKey)) : [],
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
  hydrated = false;
  hydrationStarted = false;
  pendingDispatchByThreadKey.clear();
  dispatchedByThreadKey.clear();
  failedSnapshots.clear();
  inFlightThreadKeys.clear();
  notifyListeners();
}

export interface ThreadOutboxDrainState {
  readonly view: QueueThreadView | null;
  readonly environment: QueueEnvironmentReadiness;
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
      const { view, environment } = deps.readThreadDrainState(ref);
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
          message.resumeReviewError || hasRetiredProjectMemory(message)
            ? { id: message.messageId, deliveryStatus: "failed" as const }
            : { id: message.messageId },
        ),
        // Mobile steering ids are screen-local (pre-existing).
        steeringIds: [],
        hold: holds[key] ?? null,
        acknowledgedCauseKeys: acknowledged[key],
        headProviderInstanceId: head.modelSelection?.instanceId ?? null,
        view,
        draft: false,
        environment,
        pendingDispatch: pending,
        dispatchedMessageIds: dispatchedFor(key),
        // The mobile sender reaches any existing server thread.
        sender: view !== null ? "background" : null,
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
        commitMessages(
          messages.filter((message) => !drainStep.removeIds.includes(message.messageId)),
        );
        for (const id of drainStep.removeIds) {
          const failed = failedSnapshots.get(id);
          failedSnapshots.delete(id);
          // A send whose reply was lost is acknowledged by its projection; its
          // turn still has to start before the next head may go.
          if (failed && queueOf(key).length > 0) pendingDispatchByThreadKey.set(key, failed);
        }
        continue;
      }
      // send: one message per thread per pass.
      await sendHead(key, head, view, nowIso, deps);
      break;
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

export function retryThreadOutboxReview(messageId: string): void {
  const message = messages.find((entry) => entry.messageId === messageId);
  if (!message) return;
  const { resumeReviewError: _reason, ...retry } = message;
  enqueueThreadOutboxMessage(retry);
}
