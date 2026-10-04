import type { EnvironmentId, ScopedThreadRef } from "@ryco/contracts";
import type { StoreApi } from "zustand";

import { parseScopedThreadKey } from "../../scoped.ts";
import {
  captureQueuedDispatchSnapshot,
  type QueuedDispatchSnapshot,
} from "../session/dispatchAck.ts";
import type { AppState } from "../threads/store.ts";
import { resolveQueueDrainStep, type QueueDrainStep } from "./drain.ts";
import { deriveQueueFailureCauses, releaseQueueHoldKeys, type QueueHold } from "./hold.ts";
import type { QueuedMessage } from "./logic.ts";
import type { MessageQueueState } from "./store.ts";
import {
  queueThreadViewInputs,
  queueThreadViewInputsEqual,
  readQueueThreadView,
  type QueueThreadView,
} from "./threadView.ts";

export interface QueueSendHooks {
  /** Call immediately before the final `thread.turn.start`. */
  readonly onBeforeTurnStart: () => void;
}

export type QueueSendResult =
  | { readonly kind: "accepted" }
  | { readonly kind: "failed" }
  /** Not now: the claim is released and retried shortly. */
  | { readonly kind: "deferred" }
  /** A Claude resume needs an interactive review; the queue holds. */
  | { readonly kind: "needs-review"; readonly detail: string };

export interface MessageQueueSender<C, S> {
  send(entry: QueuedMessage<C, S>, hooks: QueueSendHooks): Promise<QueueSendResult>;
}

export interface QueueEnvironmentReadiness {
  /** A live shell snapshot is applied (not bootstrapping, not cache-provenance). */
  readonly shellLive: boolean;
  /** Mutations may be sent to this environment now. */
  readonly mutationReady: boolean;
}

export interface MessageQueueDrainPlatform<C, S> {
  readonly threads: {
    getState(): AppState;
    subscribe(listener: () => void): () => void;
  };
  readonly readEnvironment: (
    environmentId: EnvironmentId,
    state: AppState,
  ) => QueueEnvironmentReadiness;
  readonly subscribeEnvironmentReadiness?: (listener: () => void) => () => void;
  readonly resolveSender: (
    threadKey: string,
    view: QueueThreadView | null,
  ) => { kind: "foreground" | "background"; sender: MessageQueueSender<C, S> } | null;
  readonly isLocalDraftKey?: (threadKey: string) => boolean;
  readonly headProviderInstanceId: (entry: QueuedMessage<C, S>) => string | null;
  /** Only called while the environment is mutation-ready. */
  readonly retainThreadDetail?: (ref: ScopedThreadRef) => () => void;
  readonly onEntryRemoved?: (
    threadKey: string,
    entry: QueuedMessage<C, S>,
    cause: "accepted" | "projected",
  ) => void;
  readonly now?: () => number;
  readonly timers?: {
    setTimeout: (callback: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
  /** Default 90 s. */
  readonly ackTimeoutMs?: number;
  /** Default 250 ms. */
  readonly deferRetryMs?: number;
  /** Default 5 s. */
  readonly environmentRecheckMs?: number;
}

export interface MessageQueueDrainCoordinator {
  /** Ref-counted start; the last release stops and clears all bookkeeping. */
  retain(): () => void;
  /** Schedules an evaluation (microtask-coalesced). */
  evaluate(threadKey?: string): void;
  resume(threadKey: string): void;
  retry(threadKey: string, messageId: string): void;
  inspect(threadKey: string): {
    pendingDispatch: QueuedDispatchSnapshot | null;
    inFlightMessageId: string | null;
    lastStep: QueueDrainStep | null;
  };
}

const DEFAULT_ACK_TIMEOUT_MS = 90_000;
const DEFAULT_DEFER_RETRY_MS = 250;
const DEFAULT_ENVIRONMENT_RECHECK_MS = 5_000;
const MAX_SNAPSHOTS = 64;
const MAX_DISPATCHED_PER_THREAD = 16;
/** Bookkeeping steps re-evaluate in place; this bounds a misbehaving loop. */
const MAX_STEPS_PER_EVALUATION = 8;

const EMPTY_DISPATCHED: ReadonlySet<string> = new Set();

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/**
 * The single drain loop for every thread with a queue, independent of which
 * thread is on screen. One sender per thread, one queued send in flight per
 * thread, and the next head waits for a message-scoped acknowledgement of the
 * previous one. Plain TypeScript over zustand: no DOM or React Native imports.
 */
export function createMessageQueueDrainCoordinator<C, S>(
  queueStore: StoreApi<MessageQueueState<C, S>>,
  platform: MessageQueueDrainPlatform<C, S>,
): MessageQueueDrainCoordinator {
  const timers = platform.timers ?? {
    // Resolved at call time so fake timers installed after creation apply.
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const now = platform.now ?? Date.now;
  const nowIso = () => new Date(now()).toISOString();
  const ackTimeoutMs = platform.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  const deferRetryMs = platform.deferRetryMs ?? DEFAULT_DEFER_RETRY_MS;
  const environmentRecheckMs = platform.environmentRecheckMs ?? DEFAULT_ENVIRONMENT_RECHECK_MS;

  let retainCount = 0;
  let runId = 0;
  let unsubscribers: Array<() => void> = [];
  const pending = new Map<string, QueuedDispatchSnapshot>();
  const ackTimers = new Map<string, unknown>();
  const inFlight = new Map<string, { messageId: string; runId: number; epoch: number }>();
  const hookSnapshots = new Map<string, QueuedDispatchSnapshot>();
  const failedSnapshots = new Map<string, QueuedDispatchSnapshot>();
  const dispatched = new Map<string, Set<string>>();
  const retains = new Map<string, () => void>();
  const lastInputs = new Map<string, readonly unknown[]>();
  const lastSteps = new Map<string, QueueDrainStep>();
  const deferTimers = new Map<string, unknown>();
  let environmentRecheckTimer: unknown = null;
  const dirty = new Set<string>();
  let flushScheduled = false;

  const queueOf = (key: string) => queueStore.getState().queuesByThreadKey[key] ?? [];
  const activeKeys = () =>
    Object.entries(queueStore.getState().queuesByThreadKey).flatMap(([key, queue]) =>
      queue.length > 0 ? [key] : [],
    );
  const dispatchedFor = (key: string): ReadonlySet<string> =>
    dispatched.get(key) ?? EMPTY_DISPATCHED;

  function addDispatched(key: string, messageId: string): void {
    const ids = dispatched.get(key) ?? new Set<string>();
    ids.delete(messageId);
    ids.add(messageId);
    while (ids.size > MAX_DISPATCHED_PER_THREAD) {
      const oldest = ids.values().next();
      if (oldest.done) break;
      ids.delete(oldest.value);
    }
    dispatched.set(key, ids);
  }

  function clearAckTimer(key: string): void {
    const timer = ackTimers.get(key);
    if (timer === undefined) return;
    timers.clearTimeout(timer);
    ackTimers.delete(key);
  }

  function releaseRetain(key: string): void {
    const release = retains.get(key);
    if (!release) return;
    retains.delete(key);
    release();
  }

  function armPending(key: string, snapshot: QueuedDispatchSnapshot): void {
    pending.set(key, snapshot);
    clearAckTimer(key);
    const messageId = snapshot.messageId;
    ackTimers.set(
      key,
      timers.setTimeout(() => {
        ackTimers.delete(key);
        if (pending.get(key)?.messageId !== messageId) return;
        // Keep `pending`: a late start auto-releases the stall.
        queueStore.getState().hold(key, {
          reason: "stalled",
          causeKeys: [`stalled:${messageId}`],
          detail: null,
          heldAt: nowIso(),
        });
      }, ackTimeoutMs),
    );
  }

  function clearPending(key: string): void {
    pending.delete(key);
    clearAckTimer(key);
  }

  function cleanupKey(key: string): void {
    clearPending(key);
    dispatched.delete(key);
    const deferTimer = deferTimers.get(key);
    if (deferTimer !== undefined) {
      timers.clearTimeout(deferTimer);
      deferTimers.delete(key);
    }
    releaseRetain(key);
    lastInputs.delete(key);
  }

  function clearAllBookkeeping(): void {
    for (const timer of ackTimers.values()) timers.clearTimeout(timer);
    for (const timer of deferTimers.values()) timers.clearTimeout(timer);
    if (environmentRecheckTimer !== null) timers.clearTimeout(environmentRecheckTimer);
    environmentRecheckTimer = null;
    for (const release of retains.values()) release();
    pending.clear();
    ackTimers.clear();
    inFlight.clear();
    hookSnapshots.clear();
    failedSnapshots.clear();
    dispatched.clear();
    retains.clear();
    lastInputs.clear();
    lastSteps.clear();
    deferTimers.clear();
    dirty.clear();
  }

  function markDirty(key: string): void {
    if (retainCount === 0) return;
    dirty.add(key);
    if (flushScheduled) return;
    flushScheduled = true;
    // Never evaluate inside a zustand listener: a re-entrant `set` would
    // notify the other listeners mid-update.
    void Promise.resolve().then(flush);
  }

  function flush(): void {
    flushScheduled = false;
    if (retainCount === 0) {
      dirty.clear();
      return;
    }
    const keys = [...dirty];
    dirty.clear();
    for (const key of keys) evaluateKey(key);
  }

  function armEnvironmentRecheck(): void {
    if (environmentRecheckTimer !== null) return;
    environmentRecheckTimer = timers.setTimeout(() => {
      environmentRecheckTimer = null;
      for (const key of activeKeys()) markDirty(key);
    }, environmentRecheckMs);
  }

  function syncDetailRetention(
    key: string,
    ref: ScopedThreadRef,
    view: QueueThreadView | null,
    mutationReady: boolean,
  ): void {
    if (!platform.retainThreadDetail) return;
    if (view !== null && mutationReady) {
      if (!retains.has(key)) retains.set(key, platform.retainThreadDetail(ref));
    } else {
      releaseRetain(key);
    }
  }

  function evaluateKey(key: string): void {
    const ref = parseScopedThreadKey(key);
    if (!ref) return;
    for (let iteration = 0; iteration < MAX_STEPS_PER_EVALUATION; iteration += 1) {
      const queueState = queueStore.getState();
      const queue = queueState.queuesByThreadKey[key] ?? [];
      if (queue.length === 0) {
        cleanupKey(key);
        lastSteps.set(key, { kind: "idle" });
        return;
      }
      const threadsState = platform.threads.getState();
      lastInputs.set(key, queueThreadViewInputs(threadsState, ref));
      const view = readQueueThreadView(threadsState, ref);
      const sender = platform.resolveSender(key, view);
      const environment = platform.readEnvironment(ref.environmentId, threadsState);
      const draft =
        view === null &&
        (platform.isLocalDraftKey?.(key) ?? false) &&
        sender?.kind === "foreground";
      syncDetailRetention(key, ref, view, environment.mutationReady);
      const hold = queueState.holdsByThreadKey[key] ?? null;
      const step = resolveQueueDrainStep({
        nowIso: nowIso(),
        queue,
        steeringIds: queueState.steeringIdsByThreadKey[key] ?? [],
        hold,
        acknowledgedCauseKeys: queueState.acknowledgedCauseKeysByThreadKey[key],
        headProviderInstanceId: platform.headProviderInstanceId(queue[0]!),
        view,
        draft,
        environment,
        pendingDispatch: pending.get(key) ?? null,
        dispatchedMessageIds: dispatchedFor(key),
        sender: sender?.kind ?? null,
      });
      lastSteps.set(key, step);
      if (!applyStep(key, step, { ref, view, queue, hold, sender })) return;
    }
  }

  /** Applies one step; true when the key must be re-evaluated in place. */
  function applyStep(
    key: string,
    step: QueueDrainStep,
    context: {
      ref: ScopedThreadRef;
      view: QueueThreadView | null;
      queue: ReadonlyArray<QueuedMessage<C, S>>;
      hold: QueueHold | null;
      sender: ReturnType<MessageQueueDrainPlatform<C, S>["resolveSender"]>;
    },
  ): boolean {
    const store = queueStore.getState();
    switch (step.kind) {
      case "idle":
      case "thread-gone":
        return false;
      case "baseline":
      case "acknowledge":
        store.acknowledgeCauses(key, step.causeKeys);
        return true;
      case "reconcile": {
        for (const id of step.removeIds) {
          const entry = queueOf(key).find((candidate) => candidate.id === id);
          if (!entry) continue;
          queueStore.getState().remove(key, id);
          platform.onEntryRemoved?.(key, entry, "projected");
          // A send whose reply was lost is acknowledged by its projection; its
          // turn still has to start before the next head may go.
          const failed = failedSnapshots.get(id);
          if (failed && queueOf(key).length > 0) {
            failedSnapshots.delete(id);
            armPending(key, failed);
          }
        }
        for (const id of step.endSteerIds) queueStore.getState().endSteer(key, id);
        return true;
      }
      case "dispatch-started": {
        clearPending(key);
        const stalledKey = `stalled:${step.messageId}`;
        if (context.hold?.causeKeys.includes(stalledKey)) {
          store.removeHoldCauses(key, [stalledKey]);
        }
        return true;
      }
      case "dispatch-failed":
        clearPending(key);
        store.hold(key, step.hold);
        return true;
      case "hold":
        store.hold(key, step.hold);
        return true;
      case "wait":
        if (step.reason === "environment") armEnvironmentRecheck();
        return false;
      case "send":
        send(key, step.messageId, context);
        return false;
    }
  }

  function send(
    key: string,
    messageId: string,
    context: {
      ref: ScopedThreadRef;
      view: QueueThreadView | null;
      queue: ReadonlyArray<QueuedMessage<C, S>>;
      sender: ReturnType<MessageQueueDrainPlatform<C, S>["resolveSender"]>;
    },
  ): void {
    // One queued send per thread, and a deferred send waits for its retry.
    if (inFlight.has(key) || deferTimers.has(key) || !context.sender) return;
    const entry = context.queue.find((candidate) => candidate.id === messageId);
    if (!entry || !queueStore.getState().beginSend(key, messageId)) return;
    const sendRunId = runId;
    const epoch = queueStore.getState().epoch;
    const startSnapshot = captureQueuedDispatchSnapshot(context.view, messageId, nowIso());
    inFlight.set(key, { messageId, runId: sendRunId, epoch });
    const hooks: QueueSendHooks = {
      onBeforeTurnStart: () => {
        if (runId !== sendRunId) return;
        setBounded(
          hookSnapshots,
          messageId,
          captureQueuedDispatchSnapshot(
            readQueueThreadView(platform.threads.getState(), context.ref),
            messageId,
            nowIso(),
          ),
          MAX_SNAPSHOTS,
        );
      },
    };
    const sender = context.sender.sender;
    void Promise.resolve()
      .then(() => sender.send(entry, hooks))
      .catch((): QueueSendResult => ({ kind: "failed" }))
      .then((result) => complete(key, entry, result, { sendRunId, epoch, startSnapshot }));
  }

  function complete(
    key: string,
    entry: QueuedMessage<C, S>,
    result: QueueSendResult,
    context: { sendRunId: number; epoch: number; startSnapshot: QueuedDispatchSnapshot },
  ): void {
    const messageId = entry.id;
    const current = inFlight.get(key);
    if (current?.messageId === messageId && current.runId === context.sendRunId) {
      inFlight.delete(key);
    }
    const store = queueStore.getState();
    // A reset (account teardown) drops everything from the previous epoch.
    if (store.epoch !== context.epoch) return;
    const sameRun = runId === context.sendRunId;
    const hookSnapshot = hookSnapshots.get(messageId);
    hookSnapshots.delete(messageId);
    switch (result.kind) {
      case "accepted": {
        const stillQueued = queueOf(key).some((candidate) => candidate.id === messageId);
        store.finishSend(key, messageId, true);
        if (stillQueued) platform.onEntryRemoved?.(key, entry, "accepted");
        if (sameRun) {
          addDispatched(key, messageId);
          armPending(key, hookSnapshot ?? context.startSnapshot);
        }
        break;
      }
      case "failed":
        store.finishSend(key, messageId, false);
        // The turn command may have reached the server before the reply was
        // lost; keep enough to recognise its start or failure later.
        if (hookSnapshot && sameRun) {
          addDispatched(key, messageId);
          setBounded(failedSnapshots, messageId, hookSnapshot, MAX_SNAPSHOTS);
        }
        break;
      case "deferred":
        store.releaseSend(key, messageId);
        if (sameRun && !deferTimers.has(key)) {
          deferTimers.set(
            key,
            timers.setTimeout(() => {
              deferTimers.delete(key);
              markDirty(key);
            }, deferRetryMs),
          );
        }
        break;
      case "needs-review":
        store.releaseSend(key, messageId);
        store.hold(key, {
          reason: "review",
          causeKeys: [`review:${messageId}`],
          detail: result.detail,
          heldAt: nowIso(),
        });
        break;
    }
    if (sameRun) markDirty(key);
  }

  function onQueueStoreChange(
    state: MessageQueueState<C, S>,
    previous: MessageQueueState<C, S>,
  ): void {
    if (state.epoch !== previous.epoch) {
      clearAllBookkeeping();
      for (const key of activeKeys()) markDirty(key);
      return;
    }
    for (const [key, queue] of Object.entries(state.queuesByThreadKey)) {
      const before = previous.queuesByThreadKey[key];
      if (queue.length > 0 && (before?.length ?? 0) === 0) {
        // The thread state at this instant is what the user saw while composing:
        // record it as already acknowledged, synchronously.
        if (state.acknowledgedCauseKeysByThreadKey[key] === undefined) {
          const ref = parseScopedThreadKey(key);
          const view = ref ? readQueueThreadView(platform.threads.getState(), ref) : null;
          queueStore
            .getState()
            .acknowledgeCauses(
              key,
              view
                ? deriveQueueFailureCauses(view, dispatchedFor(key)).map((cause) => cause.causeKey)
                : [],
            );
        }
      }
    }
    const keys = new Set([
      ...Object.keys(state.queuesByThreadKey),
      ...Object.keys(previous.queuesByThreadKey),
    ]);
    for (const key of keys) {
      if (
        state.queuesByThreadKey[key] !== previous.queuesByThreadKey[key] ||
        state.holdsByThreadKey[key] !== previous.holdsByThreadKey[key] ||
        state.steeringIdsByThreadKey[key] !== previous.steeringIdsByThreadKey[key] ||
        state.acknowledgedCauseKeysByThreadKey[key] !==
          previous.acknowledgedCauseKeysByThreadKey[key]
      ) {
        markDirty(key);
      }
    }
  }

  function onThreadsStoreChange(): void {
    const threadsState = platform.threads.getState();
    for (const key of activeKeys()) {
      const ref = parseScopedThreadKey(key);
      if (!ref) continue;
      if (
        !queueThreadViewInputsEqual(lastInputs.get(key), queueThreadViewInputs(threadsState, ref))
      ) {
        markDirty(key);
      }
    }
  }

  function start(): void {
    runId += 1;
    unsubscribers = [
      queueStore.subscribe(onQueueStoreChange),
      platform.threads.subscribe(onThreadsStoreChange),
      ...(platform.subscribeEnvironmentReadiness
        ? [
            platform.subscribeEnvironmentReadiness(() => {
              for (const key of activeKeys()) markDirty(key);
            }),
          ]
        : []),
    ];
    for (const key of activeKeys()) markDirty(key);
  }

  function stop(): void {
    for (const unsubscribe of unsubscribers) unsubscribe();
    unsubscribers = [];
    clearAllBookkeeping();
    flushScheduled = false;
    runId += 1;
  }

  function resume(threadKey: string): void {
    const ref = parseScopedThreadKey(threadKey);
    const state = queueStore.getState();
    const view = ref ? readQueueThreadView(platform.threads.getState(), ref) : null;
    state.release(
      threadKey,
      releaseQueueHoldKeys(
        state.holdsByThreadKey[threadKey] ?? null,
        view ? deriveQueueFailureCauses(view, dispatchedFor(threadKey)) : [],
      ),
    );
    // The user chose to proceed: stop waiting on the previous send's ack.
    clearPending(threadKey);
    markDirty(threadKey);
  }

  return {
    retain() {
      retainCount += 1;
      if (retainCount === 1) start();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        retainCount -= 1;
        if (retainCount === 0) stop();
      };
    },
    evaluate(threadKey) {
      if (threadKey !== undefined) {
        markDirty(threadKey);
        return;
      }
      for (const key of activeKeys()) markDirty(key);
    },
    resume,
    retry(threadKey, messageId) {
      queueStore.getState().retrySend(threadKey, messageId);
      // Retry while held must send.
      if (queueStore.getState().holdsByThreadKey[threadKey]) resume(threadKey);
      markDirty(threadKey);
    },
    inspect(threadKey) {
      return {
        pendingDispatch: pending.get(threadKey) ?? null,
        inFlightMessageId: inFlight.get(threadKey)?.messageId ?? null,
        lastStep: lastSteps.get(threadKey) ?? null,
      };
    },
  };
}
