import { create } from "zustand";

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

export interface MessageQueueState<Composer = unknown, Settings = unknown> {
  readonly queuesByThreadKey: Record<string, QueuedMessage<Composer, Settings>[]>;
  readonly steeringIdsByThreadKey: Record<string, string[]>;
  readonly enqueue: (threadKey: string, message: QueuedMessage<Composer, Settings>) => void;
  readonly remove: (threadKey: string, id: string) => void;
  readonly move: (threadKey: string, id: string, direction: "up" | "down") => void;
  readonly beginSend: (threadKey: string, id: string) => boolean;
  readonly finishSend: (threadKey: string, id: string, accepted: boolean) => void;
  readonly retrySend: (threadKey: string, id: string) => void;
  readonly dequeue: (threadKey: string) => void;
  readonly clear: (threadKey: string) => void;
  readonly beginSteer: (threadKey: string, id: string) => void;
  readonly endSteer: (threadKey: string, id: string) => void;
}

export function createMessageQueueStore<Composer = unknown, Settings = unknown>() {
  return create<MessageQueueState<Composer, Settings>>((set) => ({
    queuesByThreadKey: {},
    steeringIdsByThreadKey: {},
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
          queuesByThreadKey: {
            ...state.queuesByThreadKey,
            [threadKey]: removeQueuedMessage(current, id),
          },
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
        return {
          queuesByThreadKey: {
            ...state.queuesByThreadKey,
            [threadKey]: accepted
              ? removeQueuedMessage(queue, id)
              : withDeliveryStatus(queue, id, "failed"),
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
    dequeue: (threadKey) =>
      set((state) => {
        const current = state.queuesByThreadKey[threadKey];
        if (!current || current.length === 0) return state;
        return { queuesByThreadKey: { ...state.queuesByThreadKey, [threadKey]: current.slice(1) } };
      }),
    clear: (threadKey) =>
      set((state) => {
        if (!(threadKey in state.queuesByThreadKey)) return state;
        const queuesByThreadKey = { ...state.queuesByThreadKey };
        const steeringIdsByThreadKey = { ...state.steeringIdsByThreadKey };
        delete queuesByThreadKey[threadKey];
        delete steeringIdsByThreadKey[threadKey];
        return { queuesByThreadKey, steeringIdsByThreadKey };
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
  }));
}
