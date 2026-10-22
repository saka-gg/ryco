import type { MessageId } from "@ryco/contracts";
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { quoteCitationSourceKey, type QuoteCitation } from "@ryco/shared/quoteCitations";
import type { TextQuoteSelector } from "@ryco/shared/textQuoteSelector";
import { create } from "zustand";

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
  readonly jump: (citation: QuoteCitation) => QuoteSourceJump;
  /** Ends the jump, unless a newer one replaced it. */
  readonly finish: (id: number, outcome: QuoteSourceJumpOutcome) => void;
  /** Records a passage as unavailable without jumping (its thread is gone). */
  readonly markUnavailable: (citation: QuoteCitation) => void;
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
  jump: (citation) => {
    const threadKey = scopedThreadKey(scopeThreadRef(citation.environmentId, citation.threadId));
    useTimelineRevealStore.getState().reveal(threadKey, citation.messageId);
    nextJumpId += 1;
    const jump: QuoteSourceJump = {
      id: nextJumpId,
      threadKey,
      messageId: citation.messageId,
      selector: citation.selector,
      sourceKey: quoteCitationSourceKey(citation),
      revealRequestId:
        useTimelineRevealStore.getState().requestsByThreadKey[threadKey]?.requestId ?? null,
      startedAt: Date.now(),
    };
    set({ active: jump });
    return jump;
  },
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
  markUnavailable: (citation) =>
    set((state) => ({
      unavailableSourceKeys: withSourceKey(
        state.unavailableSourceKeys,
        quoteCitationSourceKey(citation),
        true,
      ),
    })),
}));
