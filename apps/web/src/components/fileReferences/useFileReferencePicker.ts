import type { FileReference } from "@ryco/client-runtime/state/composer";
import type { ScopedThreadRef } from "@ryco/contracts";
import { useCallback, useMemo, useRef, useState } from "react";

import {
  composerContextIntake,
  useComposerContextIntakeAvailable,
} from "../../composerContextIntake";
import type { FileLineSelection } from "./fileReferenceSelection";

/** Lines picked in one rendered file (`fileKey`), waiting for their note. */
export interface FileReferencePick {
  readonly fileKey: string;
  readonly selection: FileLineSelection;
}

export interface FileReferencePicker {
  /** A composer takes context for this thread: offer the gutter `+`. */
  readonly available: boolean;
  /** The open pick; at most one per panel. */
  readonly pick: FileReferencePick | null;
  open(fileKey: string, selection: FileLineSelection): void;
  cancel(): void;
  /**
   * Hands the reference to the thread's composer and closes the pick; false
   * (the pick stays open) when there is none or the composer refused it.
   */
  add(reference: FileReference | null): boolean;
  restoreComment(): string;
  rememberComment(comment: string): void;
}

/**
 * The "Add to chat" pick of a panel that shows `thread`'s files (the Review
 * diff, the Files view). Nothing is offered until that thread's composer
 * listens on the context intake, and a pick never outlives its thread.
 */
export function useFileReferencePicker(thread: ScopedThreadRef | null): FileReferencePicker {
  const available = useComposerContextIntakeAvailable(thread);
  const environmentId = thread?.environmentId ?? null;
  const threadId = thread?.threadId ?? null;
  const threadKey = thread ? `${thread.environmentId}\u0000${thread.threadId}` : null;
  const [state, setState] = useState<{
    readonly threadKey: string | null;
    readonly pick: FileReferencePick;
  } | null>(null);
  const commentRef = useRef("");
  const pick = available && state?.threadKey === threadKey ? state.pick : null;

  const open = useCallback(
    (fileKey: string, selection: FileLineSelection) => {
      commentRef.current = "";
      setState({ threadKey, pick: { fileKey, selection } });
    },
    [threadKey],
  );
  const cancel = useCallback(() => setState(null), []);
  const add = useCallback(
    (reference: FileReference | null) => {
      if (environmentId === null || threadId === null || !reference) return false;
      const delivered = composerContextIntake.deliver(
        { environmentId, threadId },
        { kind: "file-reference", reference },
      );
      if (delivered) setState(null);
      return delivered;
    },
    [environmentId, threadId],
  );
  const restoreComment = useCallback(() => commentRef.current, []);
  const rememberComment = useCallback((comment: string) => {
    commentRef.current = comment;
  }, []);

  return useMemo(
    () => ({ available, pick, open, cancel, add, restoreComment, rememberComment }),
    [add, available, cancel, open, pick, rememberComment, restoreComment],
  );
}
