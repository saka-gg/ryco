import { memo, useState, type ReactNode } from "react";
import { useAttachmentSource, type AttachmentContext } from "./useAttachmentSource";
import { isChatFileAttachment, isChatImageAttachment, type ChatAttachment } from "../../types";
import {
  attachmentDownloadUrl,
  AttachmentFileRow,
  AttachmentVideo,
  isVideoAttachmentMimeType,
} from "./AttachmentVideo";
import { AttachmentPreviewButton } from "./AttachmentDocumentPreview";
import { formatAttachmentBytes } from "./attachmentPreview";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";

const AttachmentAudio = memo(function AttachmentAudio({
  attachment,
}: {
  attachment: Extract<ChatAttachment, { type: "file" }>;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <div className="flex flex-col">
      {attachment.previewUrl && failedUrl !== attachment.previewUrl && (
        <audio
          controls
          preload="none"
          src={attachment.previewUrl}
          aria-label={`Play ${attachment.name}`}
          onError={() => setFailedUrl(attachment.previewUrl ?? null)}
          className="mt-3 w-full min-w-0 px-2"
        />
      )}
      <AttachmentFileRow attachment={attachment} />
    </div>
  );
});

const LoadableAttachment = memo(function LoadableAttachment(
  props: AttachmentContext & {
    attachment: ChatAttachment;
    children: (attachment: ChatAttachment, loaded: boolean) => ReactNode;
  },
) {
  const attachment = props.attachment;
  const { source, loading, failed, load } = useAttachmentSource({
    ...props,
    attachmentId: attachment.id,
    sizeBytes: attachment.sizeBytes,
    mimeType: attachment.mimeType,
  });
  if (
    attachment.previewUrl ||
    source ||
    !attachment.id ||
    !props.environmentId ||
    !props.threadId ||
    !props.messageId ||
    (!isChatImageAttachment(attachment) && !isChatFileAttachment(attachment))
  ) {
    return props.children(
      source ? { ...attachment, previewUrl: source } : attachment,
      Boolean(source),
    );
  }
  return (
    <button
      type="button"
      disabled={loading}
      onClick={() => void load()}
      className="flex min-h-[72px] w-full flex-col items-start justify-center gap-1 px-3 py-3 text-left text-xs"
    >
      <span className="font-medium">{attachment.name}</span>
      <span className="text-muted-foreground" role={failed ? "status" : undefined}>
        {loading
          ? "Loading…"
          : failed
            ? "Could not load file. Click to retry."
            : `Open file · ${formatAttachmentBytes(attachment.sizeBytes)}`}
      </span>
    </button>
  );
});

export const MessageAttachments = memo(function MessageAttachments(
  props: AttachmentContext & {
    attachments: ReadonlyArray<ChatAttachment>;
    onImageExpand: (preview: ExpandedImagePreview) => void;
    variant?: "user" | "assistant";
  },
) {
  if (props.attachments.length === 0) return null;
  return (
    <div
      className={
        props.variant === "user"
          ? "mb-2 flex max-w-[520px] flex-wrap items-start gap-2"
          : "my-2 flex w-full max-w-[520px] flex-col gap-2"
      }
    >
      {props.attachments.map((attachment, index) => (
        <div
          key={`${props.environmentId}:${props.threadId}:${props.messageId}:${attachment.id ?? index}`}
          className="max-w-full overflow-hidden rounded-lg border border-border/80 bg-background/70"
        >
          <LoadableAttachment {...props} attachment={attachment}>
            {(attachment, loaded) =>
              isChatImageAttachment(attachment) && attachment.previewUrl ? (
                <div>
                  <button
                    type="button"
                    className="block w-full cursor-zoom-in"
                    aria-label={`Preview ${attachment.name}`}
                    onClick={() => {
                      const preview = buildExpandedImagePreview(
                        props.attachments
                          .filter(isChatImageAttachment)
                          .map((image) => (image.id === attachment.id ? attachment : image)),
                        attachment.id,
                      );
                      if (preview) props.onImageExpand(preview);
                    }}
                  >
                    <img
                      src={attachment.previewUrl}
                      alt={attachment.name}
                      {...(attachment.width !== undefined && attachment.height !== undefined
                        ? { width: attachment.width, height: attachment.height }
                        : {})}
                      style={
                        props.variant === "user" ? { maxWidth: "min(100%, 360px)" } : undefined
                      }
                      loading="lazy"
                      decoding="async"
                      className={
                        props.variant === "user"
                          ? "block h-auto max-h-[260px] w-auto max-w-full object-contain"
                          : "block h-auto max-h-[360px] w-full object-contain"
                      }
                    />
                  </button>
                  {props.variant !== "user" && (
                    <a
                      href={attachmentDownloadUrl(attachment.previewUrl, attachment.name)}
                      download={attachment.name}
                      aria-label={`Download ${attachment.name}`}
                      className="block truncate border-t border-border/60 px-3 py-2 text-xs text-muted-foreground"
                    >
                      {attachment.name}
                    </a>
                  )}
                </div>
              ) : isChatFileAttachment(attachment) ? (
                isVideoAttachmentMimeType(attachment.mimeType) ? (
                  <AttachmentVideo attachment={attachment} />
                ) : attachment.mimeType.toLowerCase().startsWith("audio/") ? (
                  <AttachmentAudio attachment={attachment} />
                ) : (
                  <div>
                    <AttachmentPreviewButton attachment={attachment} initiallyOpen={loaded} />
                    <AttachmentFileRow attachment={attachment} />
                  </div>
                )
              ) : (
                <div className="px-3 py-3 text-xs text-muted-foreground">
                  {attachment.name ?? "Attachment"}
                </div>
              )
            }
          </LoadableAttachment>
        </div>
      ))}
    </div>
  );
});
