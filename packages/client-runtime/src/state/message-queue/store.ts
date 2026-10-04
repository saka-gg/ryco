import { create } from "zustand";

import {
  appendAcknowledgedCauseKeys,
  mergeQueueHold,
  queueHoldsEqual,
  removeQueueHoldCauses,
  type QueueHold,
} from "./hold.ts";
import { moveQueuedMessage, removeQueuedMessage, type QueuedMessage } from "./logic.ts";

function withDeliveryStatus<Composer, Settings>(
  queue: QueuedMessage<Composer, Settings>[],
  id: string,
  status: QueuedMessage["deliveryStatus"],
): QueuedMessage<Composer, Settings>[] {
  const index = queue.findIndex((entry) => entry.id === id);
  if (index === -1) return queue;
  const { deliveryStatus: _previousStatus, ...message } = queue[index]!;
  const next = queue.slice();
  next[index] = status === undefined ? message : { ...message, deliveryStatus: status };
  return next;
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export interface MessageQueueState<Composer = unknown, Settings = unknown> {
  readonly queuesByThreadKey: Record<string, QueuedMessage<Composer, Settings>[]>;
  readonly steeringIdsByThreadKey: Record<string, string[]>;
  /** Recorded, edge-triggered pauses. Present only while the queue is non-empty. */
  readonly holdsByThreadKey: Record<string, QueueHold>;
  /** Failure causes already seen; undefined for a key = no baseline yet. */
  readonly acknowledgedCauseKeysByThreadKey: Record<string, readonly string[]>;
  /** Bumped by `reset`; completions from an older epoch are dropped. */
  readonly epoch: number;
  readonly enqueue: (threadKey: string, message: QueuedMessage<Composer, Settings>) => void;
  readonly remove: (threadKey: string, id: string) => void;
  readonly move: (threadKey: string, id: string, direction: "up" | "down") => void;
  readonly beginSend: (threadKey: string, id: string) => boolean;
  readonly finishSend: (threadKey: string, id: string, accepted: boolean) => void;
  readonly retrySend: (threadKey: string, id: string) => void;
  /** "sending" → no status. A deferred or reviewed send is not a failure. */
  readonly releaseSend: (threadKey: string, id: string) => void;
  readonly dequeue: (threadKey: string) => void;
  readonly clear: (threadKey: string) => void;
  readonly beginSteer: (threadKey: string, id: string) => void;
  readonly endSteer: (threadKey: string, id: string) => void;
  /** Merges into the thread's hold. No-op (false) when the queue is empty or nothing changed. */
  readonly hold: (threadKey: string, hold: QueueHold) => boolean;
  /** Resume: drops the hold and acknowledges the given causes. */
  readonly release: (threadKey: string, acknowledgeCauseKeys: readonly string[]) => void;
  /** Undo without acknowledging (a failed Stop, an auto-released stall). */
  readonly removeHoldCauses: (threadKey: string, causeKeys: readonly string[]) => void;
  /** Also creates the baseline; an empty list is allowed. */
  readonly acknowledgeCauses: (threadKey: string, causeKeys: readonly string[]) => void;
  /** Clears every queue, hold and baseline and bumps `epoch`. */
  readonly reset: () => void;
}

type QueueSlices<Composer, Settings> = Pick<
  MessageQueueState<Composer, Settings>,
  | "queuesByThreadKey"
  | "steeringIdsByThreadKey"
  | "holdsByThreadKey"
  | "acknowledgedCauseKeysByThreadKey"
>;

/**
 * Writes a key's next queue. A queue left empty drops its hold and baseline in
 * the same update, so the next enqueue records a fresh baseline.
 */
function withQueue<Composer, Settings>(
  state: QueueSlices<Composer, Settings>,
  threadKey: string,
  queue: QueuedMessage<Composer, Settings>[],
): Partial<QueueSlices<Composer, Settings>> {
  const queuesByThreadKey = { ...state.queuesByThreadKey, [threadKey]: queue };
  if (queue.length > 0) return { queuesByThreadKey };
  return {
    queuesByThreadKey,
    holdsByThreadKey: withoutKey(state.holdsByThreadKey, threadKey),
    acknowledgedCauseKeysByThreadKey: withoutKey(state.acknowledgedCauseKeysByThreadKey, threadKey),
  };
}

export function createMessageQueueStore<Composer = unknown, Settings = unknown>() {
  return create<MessageQueueState<Composer, Settings>>((set, get) => ({
    queuesByThreadKey: {},
    steeringIdsByThreadKey: {},
    holdsByThreadKey: {},
    acknowledgedCauseKeysByThreadKey: {},
    epoch: 0,
    enqueue: (threadKey, message) =>
      set((state) => ({
        queuesByThreadKey: {
          ...state.queuesByThreadKey,
          [threadKey]: [...(state.queuesByThreadKey[threadKey] ?? []), message],
        },
      })),
    remove: (threadKey, id) =>
      set((state) => {
        const current = state.queuesByThreadKey[threadKey];
        if (!current) return state;
        const steeringIds = state.steeringIdsByThreadKey[threadKey] ?? [];
        return {
          ...withQueue(state, threadKey, removeQueuedMessage(current, id)),
          steeringIdsByThreadKey: {
            ...state.steeringIdsByThreadKey,
            [threadKey]: steeringIds.filter((entry) => entry !== id),
          },
        };
      }),
    move: (threadKey, id, direction) =>
      set((state) => {
        const current = state.queuesByThreadKey[threadKey];
        if (!current) return state;
        return {
          queuesByThreadKey: {
            ...state.queuesByThreadKey,
            [threadKey]: moveQueuedMessage(current, id, direction),
          },
        };
      }),
    beginSend: (threadKey, id) => {
      let claimed = false;
      set((state) => {
        const queue = state.queuesByThreadKey[threadKey];
        const message = queue?.find((entry) => entry.id === id);
        if (
          !message ||
          message.deliveryStatus ||
          queue?.some((entry) => entry.deliveryStatus === "sending") ||
          state.steeringIdsByThreadKey[threadKey]?.includes(id)
        )
          return state;
        claimed = true;
        return {
          queuesByThreadKey: {
            ...state.queuesByThreadKey,
            [threadKey]: withDeliveryStatus(queue!, id, "sending"),
          },
        };
      });
      return claimed;
    },
    finishSend: (threadKey, id, accepted) =>
      set((state) => {
        const queue = state.queuesByThreadKey[threadKey];
        if (!queue?.some((entry) => entry.id === id && entry.deliveryStatus === "sending"))
          return state;
        return accepted
          ? withQueue(state, threadKey, removeQueuedMessage(queue, id))
          : {
              queuesByThreadKey: {
                ...state.queuesByThreadKey,
                [threadKey]: withDeliveryStatus(queue, id, "failed"),
              },
            };
      }),
    retrySend: (threadKey, id) =>
      set((state) => {
        const queue = state.queuesByThreadKey[threadKey];
        if (!queue?.some((entry) => entry.id === id && entry.deliveryStatus === "failed"))
          return state;
        return {
          queuesByThreadKey: {
            ...state.queuesByThreadKey,
            [threadKey]: withDeliveryStatus(queue, id, undefined),
          },
        };
      }),
    releaseSend: (threadKey, id) =>
      set((state) => {
        const queue = state.queuesByThreadKey[threadKey];
        if (!queue?.some((entry) => entry.id === id && entry.deliveryStatus === "sending"))
          return state;
        return {
          queuesByThreadKey: {
            ...state.queuesByThreadKey,
            [threadKey]: withDeliveryStatus(queue, id, undefined),
          },
        };
      }),
    dequeue: (threadKey) =>
      set((state) => {
        const current = state.queuesByThreadKey[threadKey];
        if (!current || current.length === 0) return state;
        return withQueue(state, threadKey, current.slice(1));
      }),
    clear: (threadKey) =>
      set((state) => {
        if (!(threadKey in state.queuesByThreadKey)) return state;
        return {
          queuesByThreadKey: withoutKey(state.queuesByThreadKey, threadKey),
          steeringIdsByThreadKey: withoutKey(state.steeringIdsByThreadKey, threadKey),
          holdsByThreadKey: withoutKey(state.holdsByThreadKey, threadKey),
          acknowledgedCauseKeysByThreadKey: withoutKey(
            state.acknowledgedCauseKeysByThreadKey,
            threadKey,
          ),
        };
      }),
    beginSteer: (threadKey, id) =>
      set((state) => {
        const current = state.steeringIdsByThreadKey[threadKey] ?? [];
        if (current.includes(id)) return state;
        return {
          steeringIdsByThreadKey: {
            ...state.steeringIdsByThreadKey,
            [threadKey]: [...current, id],
          },
        };
      }),
    endSteer: (threadKey, id) =>
      set((state) => {
        const current = state.steeringIdsByThreadKey[threadKey];
        if (!current?.includes(id)) return state;
        return {
          steeringIdsByThreadKey: {
            ...state.steeringIdsByThreadKey,
            [threadKey]: current.filter((entry) => entry !== id),
          },
        };
      }),
    hold: (threadKey, hold) => {
      const before = get().holdsByThreadKey[threadKey];
      set((state) => {
        if ((state.queuesByThreadKey[threadKey]?.length ?? 0) === 0) return state;
        const existing = state.holdsByThreadKey[threadKey] ?? null;
        const next = mergeQueueHold(existing, hold, hold.heldAt);
        // An identical merge must not notify, or the coordinator could loop.
        if (queueHoldsEqual(existing, next)) return state;
        return { holdsByThreadKey: { ...state.holdsByThreadKey, [threadKey]: next } };
      });
      return get().holdsByThreadKey[threadKey] !== before;
    },
    release: (threadKey, acknowledgeCauseKeys) =>
      set((state) => {
        if ((state.queuesByThreadKey[threadKey]?.length ?? 0) === 0) return state;
        const acknowledged = state.acknowledgedCauseKeysByThreadKey[threadKey];
        const nextAcknowledged = appendAcknowledgedCauseKeys(acknowledged, acknowledgeCauseKeys);
        const hasHold = threadKey in state.holdsByThreadKey;
        if (!hasHold && acknowledged !== undefined && nextAcknowledged === acknowledged) {
          return state;
        }
        return {
          holdsByThreadKey: withoutKey(state.holdsByThreadKey, threadKey),
          acknowledgedCauseKeysByThreadKey: {
            ...state.acknowledgedCauseKeysByThreadKey,
            [threadKey]: nextAcknowledged,
          },
        };
      }),
    removeHoldCauses: (threadKey, causeKeys) =>
      set((state) => {
        const hold = state.holdsByThreadKey[threadKey];
        if (!hold) return state;
        const next = removeQueueHoldCauses(hold, causeKeys);
        if (next === hold) return state;
        return {
          holdsByThreadKey:
            next === null
              ? withoutKey(state.holdsByThreadKey, threadKey)
              : { ...state.holdsByThreadKey, [threadKey]: next },
        };
      }),
    acknowledgeCauses: (threadKey, causeKeys) =>
      set((state) => {
        // Baselines live only while a queue is non-empty.
        if ((state.queuesByThreadKey[threadKey]?.length ?? 0) === 0) return state;
        const acknowledged = state.acknowledgedCauseKeysByThreadKey[threadKey];
        const next = appendAcknowledgedCauseKeys(acknowledged, causeKeys);
        if (acknowledged !== undefined && next === acknowledged) return state;
        return {
          acknowledgedCauseKeysByThreadKey: {
            ...state.acknowledgedCauseKeysByThreadKey,
            [threadKey]: next,
          },
        };
      }),
    reset: () =>
      set((state) => ({
        queuesByThreadKey: {},
        steeringIdsByThreadKey: {},
        holdsByThreadKey: {},
        acknowledgedCauseKeysByThreadKey: {},
        epoch: state.epoch + 1,
      })),
  }));
}
