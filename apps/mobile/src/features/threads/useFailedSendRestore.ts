import { useEffect, useRef, type RefObject } from "react";

import type { DraftComposerAttachment } from "../../lib/composerFiles";
import {
  failOptimisticUserMessage,
  mergeRestoredDraft,
  removeOptimisticUserMessage,
  takeFailedOptimisticUserMessages,
  type OptimisticUserMessage,
} from "../../state/optimisticUserMessages";

/**
 * A failed optimistic send gives its draft back: into the composer while the thread screen
 * shows, otherwise kept (`failOptimisticUserMessage`) until it shows again, since the composer's
 * text is the screen's own. Returns the handler `startOptimisticDispatch` calls on failure.
 */
export function useFailedSendRestore(input: {
  readonly threadKey: string;
  readonly composer: RefObject<{
    readonly getText: () => string;
    readonly setText: (text: string) => void;
  } | null>;
  readonly attachments: RefObject<ReadonlyArray<DraftComposerAttachment>>;
  readonly setAttachments: (attachments: ReadonlyArray<DraftComposerAttachment>) => void;
  readonly setSendError: (error: string) => void;
}): (entry: OptimisticUserMessage, error: string) => void {
  const { threadKey, composer, attachments, setAttachments, setSendError } = input;
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const failed = takeFailedOptimisticUserMessages(threadKey);
    if (failed.length > 0) {
      const merged = mergeRestoredDraft(
        failed.map((entry) => entry.draft),
        { prompt: composer.current?.getText() ?? "", attachments: attachments.current },
      );
      composer.current?.setText(merged.prompt);
      setAttachments(merged.attachments);
      setSendError(failed.at(-1)?.error ?? "Failed to send message.");
    }
    return () => {
      mounted.current = false;
    };
  }, [attachments, composer, setAttachments, setSendError, threadKey]);

  return (entry, error) => {
    // After the composer's own clear of the send, which lands a few microtasks after it.
    setTimeout(() => {
      if (!mounted.current) {
        failOptimisticUserMessage(threadKey, entry.message.id, error);
        return;
      }
      removeOptimisticUserMessage(threadKey, entry.message.id);
      const merged = mergeRestoredDraft([entry.draft], {
        prompt: composer.current?.getText() ?? "",
        attachments: attachments.current,
      });
      composer.current?.setText(merged.prompt);
      setAttachments(merged.attachments);
      setSendError(error);
    }, 0);
  };
}
