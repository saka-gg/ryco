import type { ScopedThreadRef } from "@ryco/contracts";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import type { ComposerDraftContent } from "../hooks/executeChatSendTurn";

/** A composer draft's stored content: what a send reads once its view shows another thread. */
export function readComposerDraftContent(
  target: ScopedThreadRef | DraftId,
): ComposerDraftContent | null {
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  return draft
    ? {
        prompt: draft.prompt,
        images: draft.images,
        terminalContexts: draft.terminalContexts,
        fileReferences: draft.fileReferences,
      }
    : null;
}
