import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { attachmentDownloadUrl } from "./AttachmentVideo";
import {
  ATTACHMENT_TEXT_PREVIEW_MAX_BYTES,
  attachmentPreviewKind,
  formatAttachmentBytes,
} from "./attachmentPreview";

const PdfAttachmentPreview = lazy(() => import("./PdfAttachmentPreview"));

export interface PreviewDocumentAttachment {
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl?: string | undefined;
  file?: File | null | undefined;
}

function TextAttachmentPreview({ src }: { src: string }) {
  const [text, setText] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(src, { signal: controller.signal, credentials: "include" });
      if (!response.ok || !response.body) throw new Error("Unavailable");
      const reader = response.body.getReader();
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > ATTACHMENT_TEXT_PREVIEW_MAX_BYTES) throw new Error("Too large");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      const value = new TextDecoder("utf-8", { fatal: true }).decode(
        await new Blob(chunks).arrayBuffer(),
      );
      if (value.includes("\0")) throw new Error("Binary file");
      if (!controller.signal.aborted) setText(value);
    })().catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => controller.abort();
  }, [src]);
  return failed ? (
    <p role="status" className="p-6 text-sm text-muted-foreground">
      This file cannot be previewed as UTF-8 text. Download it to open it.
    </p>
  ) : text === undefined ? (
    <p role="status" className="p-6">
      Loading preview…
    </p>
  ) : (
    <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-6 font-mono text-xs">
      {text}
    </pre>
  );
}

export function AttachmentDocumentPreview({
  attachment,
  open,
  onOpenChange,
}: {
  attachment: PreviewDocumentAttachment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const src = attachment.previewUrl;
  const kind = attachmentPreviewKind(attachment);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="h-[80dvh] max-w-5xl overflow-hidden" bottomStickOnMobile={false}>
        <DialogHeader className="shrink-0 border-b pr-12">
          <DialogTitle className="truncate text-base" title={attachment.name}>
            {attachment.name}
          </DialogTitle>
          <DialogDescription>
            {formatAttachmentBytes(attachment.sizeBytes)}
            {kind === "text" ? " · Text preview" : " · PDF preview"}
          </DialogDescription>
          {src && (
            <a
              className="w-fit text-xs underline underline-offset-4"
              href={attachmentDownloadUrl(src, attachment.name)}
              download={attachment.name}
              aria-label={`Download ${attachment.name}`}
            >
              Download
            </a>
          )}
        </DialogHeader>
        {open &&
          src &&
          (kind === "pdf" ? (
            <Suspense
              fallback={
                <p role="status" className="p-6">
                  Loading PDF viewer…
                </p>
              }
            >
              <PdfAttachmentPreview key={src} src={src} name={attachment.name} />
            </Suspense>
          ) : attachment.sizeBytes > ATTACHMENT_TEXT_PREVIEW_MAX_BYTES ? (
            <p role="status" className="p-6 text-sm">
              Text previews are limited to 512 KB. Download this file to open it.
            </p>
          ) : (
            <TextAttachmentPreview key={src} src={src} />
          ))}
      </DialogPopup>
    </Dialog>
  );
}

export function AttachmentPreviewButton({
  attachment,
  initiallyOpen = false,
}: {
  attachment: PreviewDocumentAttachment;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const localResource = useRef<string | undefined>(undefined);
  const [localSource, setLocalSource] = useState<string>();
  useEffect(
    () => () => {
      if (localResource.current) URL.revokeObjectURL(localResource.current);
    },
    [],
  );
  const changeOpen = (nextOpen: boolean) => {
    if (localResource.current) URL.revokeObjectURL(localResource.current);
    localResource.current =
      nextOpen && attachment.file ? URL.createObjectURL(attachment.file) : undefined;
    setLocalSource(localResource.current);
    setOpen(nextOpen);
  };
  if (!attachmentPreviewKind(attachment) || (!attachment.file && !attachment.previewUrl))
    return null;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Preview ${attachment.name}`}
        onClick={() => changeOpen(true)}
      >
        Preview
      </Button>
      <AttachmentDocumentPreview
        attachment={{ ...attachment, previewUrl: localSource ?? attachment.previewUrl }}
        open={open}
        onOpenChange={changeOpen}
      />
    </>
  );
}
