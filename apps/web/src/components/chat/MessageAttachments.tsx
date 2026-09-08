import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { readAttachmentBytes } from "@ryco/client-runtime/rpc";
import { readEnvironmentApi } from "../../environmentApi";
import { isChatFileAttachment, isChatImageAttachment, type ChatAttachment } from "../../types";
import {
  attachmentDownloadUrl,
  AttachmentFileRow,
  AttachmentVideo,
  isVideoAttachmentMimeType,
} from "./AttachmentVideo";
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

interface AttachmentContext {
  environmentId?: EnvironmentId | undefined;
  threadId?: ThreadId | undefined;
  messageId?: MessageId | undefined;
}

const LoadableAttachment = memo(function LoadableAttachment(
  props: AttachmentContext & {
    attachment: ChatAttachment;
    children: (attachment: ChatAttachment) => ReactNode;
  },
) {
  const [source, setSource] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const resources = useRef<{ controller?: AbortController; url?: string }>({});
  useEffect(
    () => () => {
      resources.current.controller?.abort();
      if (resources.current.url) URL.revokeObjectURL(resources.current.url);
    },
    [],
  );
  const attachment = props.attachment;
  if (
    attachment.previewUrl ||
    source ||
    !attachment.id ||
    !props.environmentId ||
    !props.threadId ||
    !props.messageId ||
    (!isChatImageAttachment(attachment) && !isChatFileAttachment(attachment))
  ) {
    return props.children(source ? { ...attachment, previewUrl: source } : attachment);
  }
  const load = async () => {
    if (resources.current.controller && !resources.current.controller.signal.aborted) return;
    const controller = new AbortController();
    resources.current.controller = controller;
    setLoading(true);
    setFailed(false);
    try {
      const bytes = await readAttachmentBytes({
        reference: {
          threadId: props.threadId!,
          messageId: props.messageId!,
          attachmentId: attachment.id!,
        },
        sizeBytes: attachment.sizeBytes,
        signal: controller.signal,
        readChunk: (input) => {
          const api = readEnvironmentApi(props.environmentId!)?.attachments;
          if (!api) throw new Error("Attachment connection unavailable.");
          return api.readChunk(input);
        },
      });
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(new Blob([bytes], { type: attachment.mimeType }));
      resources.current.url = url;
      setSource(url);
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      controller.abort();
    }
  };
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
            : `Load file · ${Math.ceil(attachment.sizeBytes / 1024)} KB`}
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
          key={`${props.environmentId}:${props.messageId}:${attachment.id ?? index}`}
          className="max-w-full overflow-hidden rounded-lg border border-border/80 bg-background/70"
        >
          <LoadableAttachment {...props} attachment={attachment}>
            {(attachment) =>
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
                  <AttachmentFileRow attachment={attachment} />
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
