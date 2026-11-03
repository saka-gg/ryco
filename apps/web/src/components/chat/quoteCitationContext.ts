import type { NumberedQuoteCitation } from "@ryco/shared/quoteCitations";
import { createContext } from "react";

/**
 * Present around a sent user message: its text then renders quote chips for
 * its `[Quote N]` markers and any draft tokens. Elsewhere (assistant replies,
 * the composer) quote syntax stays text.
 */
export interface QuoteCitationRenderContext {
  /** The quotes the message's block lists. */
  readonly quotes: ReadonlyArray<NumberedQuoteCitation>;
  /** The thread the timeline shows; a quote from another thread opens it. */
  readonly currentThreadKey: string | null;
}

export const QuoteCitationContext = createContext<QuoteCitationRenderContext | null>(null);
