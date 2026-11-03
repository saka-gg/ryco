import {
  buildBrowserElementBlock,
  deriveDisplayedUserMessage,
  deriveDisplayedUserMessageContext,
  type DisplayedUserMessage,
} from "@ryco/client-runtime/state/composer";

import type { PresentationTier } from "./presentationTier";

/**
 * What a sent user message shows on `tier`, for its bubble, search and the
 * minimap alike. The frozen phone tier gets nothing new: its quotes and
 * picked page elements stay the text as sent.
 */
export function deriveDisplayedUserMessageForTier(
  text: string,
  tier: PresentationTier,
): DisplayedUserMessage {
  if (tier !== "phone") return deriveDisplayedUserMessage(text);
  const context = deriveDisplayedUserMessageContext(text);
  if (context.browserElements.length === 0) return { ...context, quotes: [] };
  // The reader takes only the block the writer makes of its elements, so
  // writing them again gives back the text as sent.
  const visibleText = [context.visibleText, buildBrowserElementBlock(context.browserElements)]
    .filter((part) => part.length > 0)
    .join("\n\n");
  return { ...context, visibleText, browserElements: [], quotes: [] };
}
