// What one message may carry, in one place for every way an attachment enters
// a draft (photo pickers, the Files app, the share extension): the count and
// total-size budgets, each kind's size limit, and which images go inline.
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@ryco/contracts/orchestration";

/** Image types every provider reads inline; anything else is sent as a file. */
const INLINE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Whether an image attaches inline (base64 in the message) rather than streaming as a file. */
export function attachesInline(mimeType: string, sizeBytes: number): boolean {
  return (
    INLINE_IMAGE_MIME_TYPES.has(mimeType.toLowerCase()) &&
    sizeBytes > 0 &&
    sizeBytes <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
  );
}

export function formatUploadSizeLimitLabel(maxBytes: number): string {
  const streamingLimit = Math.min(maxBytes, PROVIDER_SEND_TURN_MAX_FILE_BYTES);
  return streamingLimit % (1024 * 1024) === 0
    ? `${Math.round(streamingLimit / (1024 * 1024))}MB`
    : `${Math.round(streamingLimit / 1024)}KB`;
}

export function attachmentCountLimitMessage(): string {
  return `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`;
}

/**
 * Why one more attachment does not fit the draft, or null. A streamed file
 * needs a node that takes files (`fileUploadMaxBytes`, already capped at the
 * provider's file limit by `resolveFileUploadMaxBytes`).
 */
export function composerAttachmentBudgetError(input: {
  readonly kind: "image" | "file";
  readonly name: string;
  readonly sizeBytes: number;
  readonly fileUploadMaxBytes: number | null;
  readonly existingCount: number;
  readonly existingTotalBytes: number;
}): string | null {
  if (input.kind === "file") {
    if (input.fileUploadMaxBytes === null) {
      return `'${input.name}' can't be attached: this machine only takes images in messages. Update Ryco on it to send files.`;
    }
    if (input.sizeBytes <= 0 || input.sizeBytes > input.fileUploadMaxBytes) {
      return `'${input.name}' must be non-empty and no larger than the ${formatUploadSizeLimitLabel(input.fileUploadMaxBytes)} attachment limit.`;
    }
  } else if (input.sizeBytes <= 0 || input.sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    return `'${input.name}' exceeds the 10 MB attachment limit.`;
  }
  if (input.existingCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
    return attachmentCountLimitMessage();
  }
  if (input.existingTotalBytes + input.sizeBytes > PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES) {
    return "Attachments can total at most 50MB per message.";
  }
  return null;
}
