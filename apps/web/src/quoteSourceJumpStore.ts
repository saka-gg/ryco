import type { MessageId, ScopedThreadRef } from "@ryco/contracts";
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { quoteCitationSourceKey, type QuoteCitation } from "@ryco/shared/quoteCitations";
import type { TextQuoteSelector } from "@ryco/shared/textQuoteSelector";
import { create } from "zustand";

import { selectThreadAvailabilityByRef, useStore } from "./store";
import { useTimelineRevealStore } from "./timelineRevealStore";

/**
 * A jump from a quote chip to the passage it quotes. The timeline reveal
 * request brings the message into view (paging history around it, scrolling,
 * highlighting its row); the thread's timeline then finds the passage, paints
 * it, and finishes the jump, or reports the passage unavailable.
 */
export interface QuoteSourceJump {
  readonly id: number;
  readonly threadKey: string;
  readonly messageId: MessageId;
  readonly selector: TextQuoteSelector;
  readonly sourceKey: string;
  /** The reveal request bringing the message into view, while it lasts. */
  readonly revealRequestId: number | null;
  readonly startedAt: number;
}

/** `abandoned`: the jump outlived its visit; the passage's state is unknown. */
export type QuoteSourceJumpOutcome = "shown" | "unavailable" | "abandoned";

interface QuoteSourceJumpStore {
  readonly active: QuoteSourceJump | null;
  /** Quotes whose passage could not be found, by source key; their chips say so. */
  readonly unavailableSourceKeys: ReadonlySet<string>;
  /** Ends the jump, unless a newer one replaced it. */
  readonly finish: (id: number, outcome: QuoteSourceJumpOutcome) => void;
}

let nextJumpId = 0;

function withSourceKey(keys: ReadonlySet<string>, key: string, unavailable: boolean) {
  if (keys.has(key) === unavailable) return keys;
  const next = new Set(keys);
  if (unavailable) next.add(key);
  else next.delete(key);
  return next;
}

export const useQuoteSourceJumpStore = create<QuoteSourceJumpStore>((set, get) => ({
  active: null,
  unavailableSourceKeys: new Set(),
  finish: (id, outcome) => {
    const active = get().active;
    if (active?.id !== id) return;
    set((state) => ({
      active: null,
      unavailableSourceKeys:
        outcome === "abandoned"
          ? state.unavailableSourceKeys
          : withSourceKey(state.unavailableSourceKeys, active.sourceKey, outcome === "unavailable"),
    }));
  },
}));

/** Where a quote chip sits, and how it opens another thread. */
export interface QuoteSourceTarget {
  /** The thread on screen; a quote from another thread opens its own first. */
  readonly currentThreadKey: string | null;
  /** Opens another thread, or null where none can be opened from here. */
  readonly openThread: ((thread: ScopedThreadRef) => void) | null;
}

/**
 * Brings a quote's passage into view, in the thread on screen or in its own
 * thread after opening it. A source thread that is gone, or that cannot be
 * opened from here, marks the passage unavailable instead. Every quote chip
 * opens its source through this.
 */
export function openQuoteSource(citation: QuoteCitation, target: QuoteSourceTarget): void {
  const threadRef = scopeThreadRef(citation.environmentId, citation.threadId);
  const threadKey = scopedThreadKey(threadRef);
  const sourceKey = quoteCitationSourceKey(citation);
  if (threadKey !== target.currentThreadKey) {
    if (
      target.openThread === null ||
      selectThreadAvailabilityByRef(useStore.getState(), threadRef) === "missing"
    ) {
      useQuoteSourceJumpStore.setState((state) => ({
        unavailableSourceKeys: withSourceKey(state.unavailableSourceKeys, sourceKey, true),
      }));
      return;
    }
    target.openThread(threadRef);
  }
  const reveals = useTimelineRevealStore.getState();
  reveals.reveal(threadKey, citation.messageId);
  nextJumpId += 1;
  useQuoteSourceJumpStore.setState({
    active: {
      id: nextJumpId,
      threadKey,
      messageId: citation.messageId,
      selector: citation.selector,
      sourceKey,
      revealRequestId:
        useTimelineRevealStore.getState().requestsByThreadKey[threadKey]?.requestId ?? null,
      startedAt: Date.now(),
    },
  });
}
