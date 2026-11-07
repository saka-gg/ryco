// A new task's attachments: photos go inline with the first message like in a
// thread, and other files stream to the node ahead of it. The upload is scoped
// to the thread the task will create, so the draft picks that thread's id up
// front (`NewTaskRouteScreen`) and the attempt reuses it.
import {
  deriveChatFileUploadSendBlock,
  isFileUploadTokenUsable,
  type ChatFileUploadRecord,
  type SendTurnDispatchAttachment,
} from "@ryco/client-runtime/state/composer";

import type { DraftComposerAttachment, DraftComposerFileAttachment } from "../../lib/composerFiles";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";

export const NEW_TASK_QUEUED_FILES_BLOCK =
  "Files can only go with a task its machine takes now. Remove them, or start the task once the machine is back.";

/**
 * Why the task cannot start yet because of its attachments, or null. A task
 * that waits in the outbox for its machine cannot carry streamed files: their
 * upload needs the machine, and a token would expire while it waits.
 */
export function newTaskAttachmentSendBlock(input: {
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly getRecord: (attachmentId: string) => ChatFileUploadRecord | null;
  readonly queueing: boolean;
  readonly nowMs: number;
}): string | null {
  const files = input.attachments.filter(
    (attachment): attachment is DraftComposerFileAttachment => attachment.type === "file",
  );
  if (files.length === 0) return null;
  if (input.queueing) return NEW_TASK_QUEUED_FILES_BLOCK;
  return deriveChatFileUploadSendBlock({
    attachmentIds: files.map((file) => file.id),
    getRecord: input.getRecord,
    nowMs: input.nowMs,
  }).blockReason;
}

/** The attachments the task's first turn sends; throws when a file has no usable upload. */
export function toNewTaskDispatchAttachments(input: {
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly getRecord: (attachmentId: string) => ChatFileUploadRecord | null;
  readonly nowMs: number;
}): SendTurnDispatchAttachment[] {
  return input.attachments.map((attachment) => {
    if (attachment.type === "image") {
      return {
        type: "image",
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        dataUrl: attachment.dataUrl,
      };
    }
    const status = input.getRecord(attachment.id)?.status;
    if (status?.kind !== "uploaded" || !isFileUploadTokenUsable(status.expiresAt, input.nowMs)) {
      throw new Error(`Attach '${attachment.name}' again to start this task.`);
    }
    return {
      type: "file",
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      uploadToken: status.uploadToken,
    };
  });
}

/** The photos an edited task brings back; its streamed files are not kept and are attached again. */
export function newTaskDraftImages(
  attachments: ReadonlyArray<DraftComposerAttachment>,
): DraftComposerImageAttachment[] {
  return attachments.filter(
    (attachment): attachment is DraftComposerImageAttachment => attachment.type === "image",
  );
}
