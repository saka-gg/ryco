import { usePaneFocus, usePaneFocusRef } from "./PaneFocus";
import { useLayoutEffect, useMemo, useState } from "react";
import type { ScopedThreadRef } from "@ryco/contracts";
import {
  collectThreadImages,
  threadImagesPage,
  type ChatMessage,
  type ThreadImage,
} from "@ryco/client-runtime/state/threads";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { attachmentDownloadUrl } from "./AttachmentVideo";
import { ExpandedImageContent } from "./ExpandedImageContent";
import { formatAttachmentBytes } from "./attachmentPreview";
import { useAttachmentSource } from "./useAttachmentSource";
import { useThreadImageReadScope } from "./useThreadImageReadScope";

export interface ThreadImageGalleryProps {
  scope: ScopedThreadRef;
  messages: readonly ChatMessage[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasMoreBefore: boolean;
  isLoadingOlder: boolean;
  loadOlderError?: string | null | undefined;
  onLoadOlder: () => void;
}

/** Keep mounted beside the header action; closed dialogs collect no metadata or media. */
export function ThreadImageGallery(props: ThreadImageGalleryProps) {
  const paneFocused = usePaneFocus();
  const paneFocusedRef = usePaneFocusRef();
  const { open: requestedOpen, onOpenChange } = props;
  const open = paneFocused && requestedOpen;
  useLayoutEffect(() => {
    if (!paneFocused && requestedOpen) onOpenChange(false);
  }, [paneFocused, requestedOpen, onOpenChange]);
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogPopup
        className="h-[80dvh] max-w-4xl overflow-hidden"
        bottomStickOnMobile={false}
        finalFocus={() => paneFocusedRef.current}
      >
        <DialogHeader className="shrink-0 border-b pr-12">
          <DialogTitle>Thread images</DialogTitle>
          <DialogDescription>Images in loaded history · Newest messages first</DialogDescription>
        </DialogHeader>
        {open && <GalleryConnection key={JSON.stringify(props.scope)} {...props} />}
      </DialogPopup>
    </Dialog>
  );
}

function GalleryConnection(props: ThreadImageGalleryProps) {
  const { available, lifetime, isCurrent } = useThreadImageReadScope(props.scope.environmentId);
  // Reset synchronously during render so stale sources never survive a paint.
  const [epoch, setEpoch] = useState({ lifetime, value: 0 });
  if (epoch.lifetime !== lifetime) setEpoch({ lifetime, value: epoch.value + 1 });
  return available ? (
    <GalleryContent key={epoch.value} {...props} isCurrent={isCurrent} />
  ) : (
    <p role="status" className="p-6 text-sm text-muted-foreground">
      Images are unavailable while this connection recovers. Reopen an image when connected.
    </p>
  );
}

function GalleryContent(props: ThreadImageGalleryProps & { isCurrent: () => boolean }) {
  const { environmentId, threadId } = props.scope;
  const images = useMemo(
    () => collectThreadImages({ environmentId, threadId }, props.messages),
    [environmentId, threadId, props.messages],
  );
  const [requestedPage, setPage] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedIndex = images.findIndex((image) => image.key === selectedKey);
  const selected = images[selectedIndex];
  const page = threadImagesPage(images, requestedPage);
  const navigate = (direction: -1 | 1) => {
    const next = images[(selectedIndex + direction + images.length) % images.length];
    if (next) setSelectedKey(next.key);
  };
  if (selected)
    return (
      <SelectedImage
        key={selected.key}
        scope={props.scope}
        isCurrent={props.isCurrent}
        image={selected}
        position={`${selectedIndex + 1} of ${images.length}`}
        canNavigate={images.length > 1}
        onNavigate={navigate}
        onBack={() => setSelectedKey(null)}
      />
    );
  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto p-6" key={page.page}>
        {images.length === 0 ? (
          <p className="text-sm text-muted-foreground">No image attachments in loaded history.</p>
        ) : (
          <ul aria-label="Image attachments" className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            {page.images.map((image) => (
              <li key={image.key} className="min-w-0">
                <GalleryTile image={image} onSelect={() => setSelectedKey(image.key)} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t px-6 py-3">
        <Button
          variant="outline"
          size="sm"
          disabled={page.page === 0}
          onClick={() => setPage(page.page - 1)}
        >
          Previous page
        </Button>
        <span className="text-xs text-muted-foreground" role="status">
          Page {page.page + 1} of {page.pageCount} · {images.length} images loaded
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page.page === page.pageCount - 1}
          onClick={() => setPage(page.page + 1)}
        >
          Next page
        </Button>
        {props.hasMoreBefore && (
          <Button
            className="ml-auto"
            variant="ghost"
            size="sm"
            disabled={props.isLoadingOlder}
            onClick={props.onLoadOlder}
          >
            {props.isLoadingOlder ? "Loading older messages…" : "Load older messages"}
          </Button>
        )}
        {props.loadOlderError && (
          <p role="alert" className="w-full text-xs text-destructive">
            Could not load older messages. Try again.
          </p>
        )}
      </div>
    </>
  );
}

function GalleryTile({ image, onSelect }: { image: ThreadImage; onSelect: () => void }) {
  const attachment = image.attachment;
  const [failedUrl, setFailedUrl] = useState<string>();
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Preview ${attachment.name}`}
      className="block w-full overflow-hidden rounded-lg border text-left focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div className="flex aspect-square items-center justify-center overflow-hidden bg-muted/40">
        {attachment.previewUrl && failedUrl !== attachment.previewUrl ? (
          <img
            src={attachment.previewUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-full object-contain"
            onError={() => setFailedUrl(attachment.previewUrl)}
          />
        ) : (
          <span className="p-3 text-center text-xs text-muted-foreground">
            {failedUrl ? "Preview unavailable" : "Open to load image"}
          </span>
        )}
      </div>
      <span className="block truncate px-2 pt-2 text-xs" title={attachment.name}>
        {attachment.name}
      </span>
      <span className="block px-2 pb-2 text-[11px] text-muted-foreground">
        {formatAttachmentBytes(attachment.sizeBytes)}
      </span>
    </button>
  );
}

function SelectedImage(props: {
  scope: ScopedThreadRef;
  isCurrent: () => boolean;
  image: ThreadImage;
  position: string;
  canNavigate: boolean;
  onNavigate: (direction: -1 | 1) => void;
  onBack: () => void;
}) {
  const paneFocusedRef = usePaneFocusRef();
  const attachment = props.image.attachment;
  const { source, loading, failed, load } = useAttachmentSource({
    ...props.scope,
    isCurrent: () => paneFocusedRef.current && props.isCurrent(),
    messageId: props.image.messageId,
    attachmentId: attachment.id,
    sizeBytes: attachment.sizeBytes,
    mimeType: attachment.mimeType,
  });
  const src = attachment.previewUrl ?? source;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          loading ||
          !props.canNavigate
        )
          return;
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        event.stopPropagation();
        props.onNavigate(event.key === "ArrowLeft" ? -1 : 1);
      }}
    >
      <div className="flex shrink-0 items-center gap-3 px-6 py-3">
        <Button autoFocus variant="ghost" size="sm" disabled={loading} onClick={props.onBack}>
          Back to images
        </Button>
        <p className="min-w-0 flex-1 truncate text-sm" title={attachment.name}>
          {attachment.name}
        </p>
        {src && (
          <a
            className="text-sm underline underline-offset-4"
            href={attachmentDownloadUrl(src, attachment.name)}
            download={attachment.name}
            aria-label={`Download ${attachment.name}`}
          >
            Download
          </a>
        )}
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-6 py-2">
        {src ? (
          <ExpandedImageContent
            className="max-h-[60dvh] max-w-full"
            image={{
              src,
              name: attachment.name,
              ...(attachment.width !== undefined ? { width: attachment.width } : {}),
              ...(attachment.height !== undefined ? { height: attachment.height } : {}),
            }}
          />
        ) : (
          <div className="text-center">
            <p role="status" className="mb-3 text-sm text-muted-foreground">
              {loading
                ? "Loading image…"
                : failed
                  ? "Could not load this image. Try again."
                  : `Load original image · ${formatAttachmentBytes(attachment.sizeBytes)}`}
            </p>
            <Button variant="outline" disabled={loading} onClick={() => void load()}>
              {failed ? "Retry image" : "Load image"}
            </Button>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-center gap-3 border-t p-3">
        <Button
          variant="outline"
          size="sm"
          disabled={loading || !props.canNavigate}
          onClick={() => props.onNavigate(-1)}
        >
          Previous image
        </Button>
        <span role="status" className="text-xs text-muted-foreground">
          {props.position}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={loading || !props.canNavigate}
          onClick={() => props.onNavigate(1)}
        >
          Next image
        </Button>
      </div>
    </div>
  );
}
