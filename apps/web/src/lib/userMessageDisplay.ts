import {
  deriveDisplayedUserMessage,
  deriveDisplayedUserMessageContext,
  type DisplayedUserMessage,
} from "@ryco/client-runtime/state/composer";

import type { PresentationTier } from "./presentationTier";

/**
 * What a sent user message shows on `tier`, for its bubble, search and the
 * minimap alike. The frozen phone tier gets nothing new: its quotes stay the
 * text as sent.
 */
export function deriveDisplayedUserMessageForTier(
  text: string,
  tier: PresentationTier,
): DisplayedUserMessage {
  return tier === "phone"
    ? { ...deriveDisplayedUserMessageContext(text), quotes: [] }
    : deriveDisplayedUserMessage(text);
}
