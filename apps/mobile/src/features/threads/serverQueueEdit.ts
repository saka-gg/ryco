import type { buildFollowUpQueueEditCommand } from "@ryco/client-runtime/state/message-queue";
import type { MessageId, QueuedFollowUp } from "@ryco/contracts";

import type { DraftComposerAttachment } from "../../lib/composerFiles";

// Editing the node's queued entry in the thread screen's composer: the next send saves it in
// place (`thread.queue.edit` at the revision shown). Whether the edit goes on is the shared
// `resolveFollowUpQueueEditState`; this is the screen's own state and composer handling.

/** The node's queued entry the composer is editing. */
export interface ServerQueueEdit {
  readonly threadKey: string;
  readonly messageId: MessageId;
  /** The revision the user edited; a save at it is refused once the entry changed. */
  readonly revision: number;
  /** The entry's stored attachments, kept as they are. */
  readonly keptAttachmentIds: NonNullable<
    Parameters<typeof buildFollowUpQueueEditCommand>[0]["keptAttachmentIds"]
  >;
}

export function serverQueueEditOf(
  threadKey: string,
  entry: Pick<QueuedFollowUp, "messageId" | "revision" | "attachments">,
): ServerQueueEdit {
  return {
    threadKey,
    messageId: entry.messageId,
    revision: entry.revision,
    keptAttachmentIds: entry.attachments.flatMap((attachment) =>
      attachment.id === undefined ? [] : [attachment.id],
    ) as ServerQueueEdit["keptAttachmentIds"],
  };
}

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
