import { memo, useState } from "react";
import { FileIcon } from "lucide-react";
import type { ChatFileAttachment, ChatUnknownAttachment } from "../../types";

export function attachmentDownloadUrl(url: string, name: string | undefined): string {
  if (!name || url.startsWith("blob:") || url.startsWith("data:")) return url;
  const resolved = new URL(url, "http://ryco.invalid");
  resolved.searchParams.set("download", name);
  return /^https?:/.test(url)
    ? resolved.href
    : `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

export function isVideoAttachmentMimeType(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith("video/");
}

export const AttachmentFileRow = memo(function AttachmentFileRow(props: {
  attachment: ChatFileAttachment | ChatUnknownAttachment;
}) {
  const { attachment } = props;
  const sizeLabel =
    attachment.sizeBytes !== undefined ? `${Math.ceil(attachment.sizeBytes / 1024)} KB` : null;
  const body = (
    <>
      <FileIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0">
        <span className="block truncate font-medium">{attachment.name}</span>
        <span className="block text-[10px] text-muted-foreground">
          {[attachment.mimeType, sizeLabel]
            .filter((part): part is string => part !== null)
            .join(" · ")}
        </span>
      </span>
    </>
  );
  const className =
    "flex min-h-[72px] items-center gap-2 px-3 py-3 text-left text-xs text-foreground/80";
  return attachment.previewUrl ? (
    <a
      href={attachmentDownloadUrl(attachment.previewUrl, attachment.name)}
      download={attachment.name}
      className={className}
      aria-label={`Download ${attachment.name}`}
    >
      {body}
    </a>
  ) : (
    <div className={className}>{body}</div>
  );
});

export const AttachmentVideo = memo(function AttachmentVideo(props: {
  attachment: ChatFileAttachment;
}) {
  const { attachment } = props;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const { previewUrl, width, height } = attachment;

  if (!previewUrl || failedUrl === previewUrl) {
    return <AttachmentFileRow attachment={attachment} />;
  }

  return (
    <div className="flex flex-col">
      <video
        controls
        playsInline
        preload="metadata"
        src={previewUrl}
        onError={() => setFailedUrl(previewUrl)}
        {...(width !== undefined && height !== undefined ? { width, height } : {})}
        style={{ aspectRatio: width && height ? `${width} / ${height}` : "16 / 9" }}
        className="block h-auto w-full bg-black"
      />
      <a
        href={attachmentDownloadUrl(previewUrl, attachment.name)}
        download={attachment.name}
        aria-label={`Download ${attachment.name}`}
        className="flex items-center justify-center gap-1.5 border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <FileIcon className="size-3.5 shrink-0" />
        <span className="truncate">{attachment.name}</span>
      </a>
    </div>
  );
});
