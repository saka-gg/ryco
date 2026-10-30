import type { DraftComposerAttachment } from "../../lib/composerFiles";

// Editing the node's queued entry in the thread screen's composer: the next send saves it in
// place (`thread.queue.edit` at the revision shown). The edit itself is the shared
// `FollowUpQueueEdit`, and whether it goes on is the shared `resolveFollowUpQueueEditState`;
// this is the screen's own composer handling.

/** The composer pieces a cancelled edit clears. */
export interface ServerQueueEditComposer {
  readonly setText: (text: string) => void;
  readonly setAttachments: (attachments: ReadonlyArray<DraftComposerAttachment>) => void;
  readonly setAttachmentError: (error: string | null) => void;
}

/**
 * Cancel: the entry stays on the node as it is, and everything the edit put in the composer
 * goes, attachments added meanwhile included.
 */
export function clearCancelledServerQueueEdit(composer: ServerQueueEditComposer): void {
  composer.setText("");
  composer.setAttachments([]);
  composer.setAttachmentError(null);
}
