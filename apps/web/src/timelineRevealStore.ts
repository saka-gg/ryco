import type { MessageId } from "@ryco/contracts";
import { create } from "zustand";

/**
 * Asks a thread's timeline, from outside the chat view (the workspace panel's
 * artifacts), to bring one message into view and highlight it. Each request
 * has its own id, so asking for the same message again scrolls to it again.
 * The chat view settles a request once it has shown it, so a timeline that
 * keeps streaming is not pulled back to it.
 */
export interface TimelineRevealRequest {
  readonly messageId: MessageId;
  readonly requestId: number;
}

/** How long a shown request stays, so the timeline's highlight runs its course. */
export const TIMELINE_REVEAL_SETTLE_MS = 2_000;

interface TimelineRevealStore {
  readonly requestsByThreadKey: Readonly<Record<string, TimelineRevealRequest>>;
  readonly reveal: (threadKey: string, messageId: MessageId) => void;
  /** Drops the request, unless a newer one replaced it. */
  readonly settle: (threadKey: string, requestId: number) => void;
}

let nextRequestId = 0;

export const useTimelineRevealStore = create<TimelineRevealStore>((set) => ({
  requestsByThreadKey: {},
  reveal: (threadKey, messageId) => {
    nextRequestId += 1;
    const request = { messageId, requestId: nextRequestId };
    set((state) => ({
      requestsByThreadKey: { ...state.requestsByThreadKey, [threadKey]: request },
    }));
  },
  settle: (threadKey, requestId) =>
    set((state) => {
      if (state.requestsByThreadKey[threadKey]?.requestId !== requestId) return state;
      const { [threadKey]: _settled, ...requestsByThreadKey } = state.requestsByThreadKey;
      return { requestsByThreadKey };
    }),
}));
