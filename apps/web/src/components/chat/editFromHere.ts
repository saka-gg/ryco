import {
  appendReturnedComposerPrompt,
  loadReturnedSentMessage,
  type ReturnedSentMessage,
} from "@ryco/client-runtime/state/composer";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { enqueueComposerFileUpload } from "../../composerFileUpload";
import type { ChatMessage } from "../../types";
import { composerAttachmentFromFile } from "./useComposerImageAttachments";
import { readEnvironmentAttachmentBytes } from "./useAttachmentSource";

// "Edit from here" on web and desktop: the sent message's attachments come
// back as files, read before the revert is sent (`loadReturnedSentMessage`),
// because projecting it deletes the node's copies.

/** What one sent message returns to the composer with on web. */
export type ReturnedSentMessageFiles = ReturnedSentMessage<File>;

export function loadSentMessageFiles(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly message: Pick<ChatMessage, "id" | "text" | "attachments">;
  /** What the composer holds now; the returned attachments must fit next to it. */
  readonly composerAttachments: ReadonlyArray<{ readonly sizeBytes: number }>;
  readonly readBytes?: typeof readEnvironmentAttachmentBytes;
}): Promise<ReturnedSentMessageFiles> {
  const readBytes = input.readBytes ?? readEnvironmentAttachmentBytes;
  return loadReturnedSentMessage({
    message: input.message,
    composerAttachments: input.composerAttachments,
    load: async (attachment) => {
      const bytes = await readBytes({
        environmentId: input.environmentId,
        threadId: input.threadId,
        messageId: input.message.id,
        attachmentId: attachment.id,
        sizeBytes: attachment.sizeBytes,
      });
      return new File([bytes], attachment.name, { type: attachment.mimeType });
    },
  });
}

/**
 * The composer content after the message returns: the unsent draft stays
 * first, and each file is attached again like a newly picked one. Files stream
 * through the upload queue when `uploadThreadId` is set.
 */
export function composerContentWithReturnedMessage(input: {
  readonly returned: ReturnedSentMessageFiles;
  readonly draftPrompt: string;
  readonly environmentId: EnvironmentId;
  /** Set when the machine streams file uploads; null keeps files inline. */
  readonly uploadThreadId: ThreadId | null;
}): { readonly prompt: string; readonly attachments: ComposerImageAttachment[] } {
  const attachments = input.returned.attachments.map((file) => {
    const attachment = composerAttachmentFromFile(file, file.name);
    if (attachment.type === "file" && input.uploadThreadId !== null) {
      enqueueComposerFileUpload({
        attachmentId: attachment.id,
        threadId: input.uploadThreadId,
        environmentId: input.environmentId,
        file,
      });
    }
    return attachment;
  });
  return {
    prompt: appendReturnedComposerPrompt(input.draftPrompt, input.returned.prompt),
    attachments,
  };
}
