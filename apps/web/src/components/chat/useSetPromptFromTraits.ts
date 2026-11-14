import type { ScopedThreadRef } from "@ryco/contracts";
import { useCallback } from "react";
import {
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
} from "../../composer-logic";
import { type DraftId } from "../../composerDraftStore";

/**
 * The whole-prompt replacement the provider traits controls call (e.g. the
 * ultrathink toggle). It writes `promptRef`, and the composer hands it to the
 * traits renderers through plain function calls, which the React Compiler
 * cannot prove only forward it to JSX event props; created inline it made the
 * compiler skip the entire composer. As a hook result it is opaque to the
 * render-time ref check, and it is still only invoked from event handlers.
 */
export function useSetPromptFromTraits(input: {
  readonly promptRef: React.MutableRefObject<string>;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly setComposerDraftPrompt: (target: ScopedThreadRef | DraftId, prompt: string) => void;
  readonly setComposerCursor: (cursor: number) => void;
  readonly setComposerTrigger: (trigger: ComposerTrigger | null) => void;
  readonly scheduleComposerFocus: () => void;
}): (nextPrompt: string) => void {
  const {
    promptRef,
    composerDraftTarget,
    setComposerDraftPrompt,
    setComposerCursor,
    setComposerTrigger,
    scheduleComposerFocus,
  } = input;
  return useCallback(
    (nextPrompt: string) => {
      if (nextPrompt === promptRef.current) {
        scheduleComposerFocus();
        return;
      }
      promptRef.current = nextPrompt;
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [
      composerDraftTarget,
      promptRef,
      scheduleComposerFocus,
      setComposerCursor,
      setComposerDraftPrompt,
      setComposerTrigger,
    ],
  );
}
