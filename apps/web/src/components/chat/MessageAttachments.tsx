import { canHtmlRenderSendFromMessage } from "@ryco/client-runtime/state/session";
import { memo, Suspense, useState, type ReactNode } from "react";
import { preloadableLazy } from "../../lib/preloadableLazy";
import { useAttachmentSource, type AttachmentContext } from "./useAttachmentSource";
import {
  isChatFileAttachment,
  isChatImageAttachment,
  type ChatAttachment,
  type ChatMessage,
} from "../../types";
import {
  attachmentDownloadUrl,
  AttachmentFileRow,
  AttachmentVideo,
  isVideoAttachmentMimeType,
} from "./AttachmentVideo";
import { AttachmentPreviewButton } from "./AttachmentDocumentPreview";
import { attachmentPreviewKind, formatAttachmentBytes } from "./attachmentPreview";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import { useTheme } from "../../hooks/useTheme";
import { HtmlRenderCards } from "./HtmlRenderCards";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import { readHtmlRenderAttachment } from "./htmlRender.logic";

/** Renders an attachment, given a URL to read it from when it has one. */
export type AttachmentRender = (
  attachment: ChatAttachment,
  loaded: boolean,
  /** What shows is a preview read over a connection: reads the original. */
  loadOriginal?: () => Promise<string | undefined>,
) => ReactNode;

const USER_IMAGE_MAX_WIDTH_PX = 360;
const USER_IMAGE_MAX_HEIGHT_PX = 260;

// User images sit in a shrink-to-fit card. Percentage max-widths are ignored
// when the card measures its content, so an intrinsic 1438px-wide image would
// stretch the card to the container while the image itself renders capped —
// leaving an empty tinted strip. Resolve the displayed width in px up front so
// the card hugs the image.
function userImageStyle(width: number | undefined, height: number | undefined) {
  if (width === undefined || height === undefined || width <= 0 || height <= 0) {
    return { maxWidth: `${USER_IMAGE_MAX_WIDTH_PX}px` };
  }
  const displayWidth = Math.min(
    USER_IMAGE_MAX_WIDTH_PX,
    width,
    (width * USER_IMAGE_MAX_HEIGHT_PX) / height,
  );
  return { width: `${Math.round(displayWidth)}px`, maxWidth: "100%" };
}

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

/**
 * A thread image's preview address on its node (`?preview=`): a smaller copy
 * the node makes once, sharp at a thread's image size on a 2x screen. Its own
 * and in-memory URLs (a message still sending) stay as they are; an older node
 * ignores the parameter and sends the original.
 */
function previewSource(url: string): string {
  return /^(?:blob|data):/.test(url) || !url.includes("/attachments/")
    ? url
    : `${url}${url.includes("?") ? "&" : "?"}preview=1024`;
}

/** The click-to-read card of an attachment the thread holds no URL for. */
export type AttachmentLoadButton = (state: {
  loading: boolean | undefined;
  failed: boolean | undefined;
  load: () => void;
}) => ReactNode;

/** Every image read over a connection: its preview, the original once opened, kept for the session. */
const HostedImageAttachment = preloadableLazy(() =>
  import("./HostedImageAttachment").then((module) => module.default),
);

const LoadableAttachment = memo(function LoadableAttachment(
  props: AttachmentContext & {
    attachment: ChatAttachment;
    children: AttachmentRender;
  },
) {
  const attachment = props.attachment;
  const { source, loading, failed, load } = useAttachmentSource({
    ...props,
    attachmentId: attachment.id,
    sizeBytes: attachment.sizeBytes,
    mimeType: attachment.mimeType,
    image: isChatImageAttachment(attachment),
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
  const button: AttachmentLoadButton = (state) => (
    <button
      type="button"
      disabled={state.loading}
      onClick={state.load}
      className="flex min-h-[72px] w-full flex-col items-start justify-center gap-1 px-3 py-3 text-left text-xs"
    >
      <span className="font-medium">{attachment.name}</span>
      <span className="text-muted-foreground" role={state.failed ? "status" : undefined}>
        {state.loading
          ? "Loading…"
          : state.failed
            ? "Could not load file. Click to retry."
            : `Open file · ${formatAttachmentBytes(attachment.sizeBytes)}`}
      </span>
    </button>
  );
  return isChatImageAttachment(attachment) ? (
    <Suspense fallback={button({ loading, failed, load: () => undefined })}>
      <HostedImageAttachment
        reference={{
          environmentId: props.environmentId,
          threadId: props.threadId,
          messageId: props.messageId,
          attachmentId: attachment.id,
          sizeBytes: attachment.sizeBytes,
          mimeType: attachment.mimeType,
        }}
        attachment={attachment}
        button={button}
      >
        {props.children}
      </HostedImageAttachment>
    </Suspense>
  ) : (
    button({ loading, failed, load: () => void load() })
  );
});

export const MessageAttachments = memo(function MessageAttachments(
  props: AttachmentContext & {
    attachments: ReadonlyArray<ChatAttachment>;
    onImageExpand: (preview: ExpandedImagePreview) => void;
    variant?: "user" | "assistant";
    /**
     * The role of the message these attachments are on, when they are on a
     * message of the thread showing them: its pages may then send the
     * reader's answers (`canHtmlRenderSendFromMessage`, see `HtmlRenderFrame`).
     */
    messageRole?: ChatMessage["role"];
  },
) {
  // An HTML render shows as its page wherever it turns up (beside text, in an
  // older projection), never as an openable .html file. It needs its message
  // to be read; without one it stays a plain download row.
  const canShowRenders = Boolean(props.environmentId && props.threadId && props.messageId);
  const renders = canShowRenders
    ? props.attachments.flatMap((attachment) => {
        const render = readHtmlRenderAttachment(attachment);
        return render === undefined ? [] : [render];
      })
    : [];
  const files =
    renders.length === 0
      ? props.attachments
      : props.attachments.filter(
          (attachment) => readHtmlRenderAttachment(attachment) === undefined,
        );
  const { resolvedTheme } = useTheme();
  const { environmentId, messageId } = props;
  if (props.attachments.length === 0) return null;
  return (
    <>
      {renders.length > 0 && props.variant === "user" && environmentId && messageId ? (
        // On a user message (an artifact handed over from another thread), a
        // page is its card: the bubble is no place for the full page.
        <HtmlRenderCards
          environmentId={environmentId}
          threadId={props.threadId}
          renders={renders.map((render) => ({ ...render, messageId }))}
          appearance={resolvedTheme}
        />
      ) : renders.length > 0 ? (
        <div className="my-2 flex w-full flex-col gap-2">
          {renders.map(({ attachment, htmlRender }) => (
            <HtmlRenderFrame
              key={`${props.environmentId}:${props.threadId}:${props.messageId}:${attachment.id}`}
              environmentId={props.environmentId}
              threadId={props.threadId}
              messageId={props.messageId}
              attachment={attachment}
              htmlRender={htmlRender}
              canSendMessages={
                props.messageRole !== undefined &&
                canHtmlRenderSendFromMessage({ role: props.messageRole }, attachment)
              }
            />
          ))}
        </div>
      ) : null}
      {files.length > 0 && <AttachmentCards {...props} attachments={files} />}
    </>
  );
});

function AttachmentCards(
  props: AttachmentContext & {
    attachments: ReadonlyArray<ChatAttachment>;
    onImageExpand: (preview: ExpandedImagePreview) => void;
    variant?: "user" | "assistant";
  },
) {
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
            {(attachment, loaded, loadOriginal) =>
              isChatImageAttachment(attachment) && attachment.previewUrl ? (
                <div>
                  <button
                    type="button"
                    className="block w-full cursor-zoom-in"
                    aria-label={`Preview ${attachment.name}`}
                    onClick={async () => {
                      // Opened, an image shows its original.
                      const previewUrl = loadOriginal
                        ? await loadOriginal()
                        : attachment.previewUrl;
                      if (!previewUrl) return;
                      const preview = buildExpandedImagePreview(
                        props.attachments
                          .filter(isChatImageAttachment)
                          .map((image) =>
                            image.id === attachment.id ? { ...attachment, previewUrl } : image,
                          ),
                        attachment.id,
                      );
                      if (preview) props.onImageExpand(preview);
                    }}
                  >
                    <img
                      src={previewSource(attachment.previewUrl)}
                      alt={attachment.name}
                      {...(attachment.width !== undefined && attachment.height !== undefined
                        ? { width: attachment.width, height: attachment.height }
                        : {})}
                      style={
                        props.variant === "user"
                          ? userImageStyle(attachment.width, attachment.height)
                          : undefined
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
                      // What shows is a preview: the download is the original.
                      onClick={
                        loadOriginal &&
                        (async (event) => {
                          event.preventDefault();
                          const href = await loadOriginal();
                          if (href)
                            Object.assign(document.createElement("a"), {
                              href,
                              download: attachment.name,
                            }).click();
                        })
                      }
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
                ) : attachmentPreviewKind(attachment) && attachment.previewUrl ? (
                  <AttachmentPreviewButton
                    attachment={attachment}
                    initiallyOpen={loaded}
                    variant="file"
                  />
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
}
