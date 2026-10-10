import { ImageOffIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import type { ExtraProps } from "react-markdown";
import { cn } from "~/lib/utils";
import { ExpandedImageModal } from "../chat/ExpandedImageDialog";
import type { ExpandedImageItem, ExpandedImagePreview } from "../chat/ExpandedImagePreview";

/**
 * Images in rendered Markdown (pull request, issue and comment bodies). Each
 * one sits at its natural aspect ratio within the column, and one that is not
 * part of a link expands on click into the full-window preview, which pages
 * through every expandable image of the same body. A link around an image
 * keeps meaning "follow the link" (badges, linked screenshots). An image that
 * cannot load — a private host's attachment, say — becomes a link to open it
 * in the browser rather than a broken-image icon.
 */

/** Marks the wrapper of an expandable image; the gallery is built from these. */
const EXPANDABLE_IMAGE_ATTRIBUTE = "data-markdown-image-expand";

interface MarkdownImageGallery {
  open(trigger: HTMLElement): void;
}

const MarkdownImageGalleryContext = createContext<MarkdownImageGallery | null>(null);
/** Set inside a rendered link: an image there must not become a second control. */
const InsideLinkContext = createContext(false);
/** Set inside `<picture>`, whose `<img>` must stay its direct child. */
const InsidePictureContext = createContext(false);

function imageName(image: HTMLImageElement): string {
  const alt = image.alt.trim();
  if (alt) return alt;
  try {
    const segment = new URL(image.currentSrc || image.src).pathname.split("/").pop();
    if (segment) return decodeURIComponent(segment);
  } catch {
    // An unparsable source keeps the generic name.
  }
  return "Image";
}

function expandedImageItem(image: HTMLImageElement): ExpandedImageItem {
  return {
    // `currentSrc` is the source a `<picture>` actually chose.
    src: image.currentSrc || image.src,
    name: imageName(image),
    ...(image.naturalWidth > 0 && image.naturalHeight > 0
      ? { width: image.naturalWidth, height: image.naturalHeight }
      : {}),
  };
}

/** Builds the preview for a clicked image from every expandable image in `container`. */
export function buildMarkdownImagePreview(
  container: HTMLElement,
  trigger: HTMLElement,
): ExpandedImagePreview | null {
  const triggers = Array.from(
    container.querySelectorAll<HTMLElement>(`[${EXPANDABLE_IMAGE_ATTRIBUTE}]`),
  );
  const images: ExpandedImageItem[] = [];
  let index = -1;
  for (const candidate of triggers) {
    const image = candidate.querySelector("img");
    if (!image || !(image.currentSrc || image.src)) continue;
    if (candidate === trigger) index = images.length;
    images.push(expandedImageItem(image));
  }
  return index < 0 ? null : { images, index };
}

/** Hosts the expanded preview for the images rendered inside `container`. */
export function MarkdownImageGallery({
  container,
  children,
}: {
  container: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  const gallery = useMemo<MarkdownImageGallery>(
    () => ({
      open(trigger) {
        if (container.current) setPreview(buildMarkdownImagePreview(container.current, trigger));
      },
    }),
    [container],
  );
  const close = useCallback(() => setPreview(null), []);
  return (
    <MarkdownImageGalleryContext value={gallery}>
      {children}
      {preview ? <ExpandedImageModal preview={preview} onClose={close} /> : null}
    </MarkdownImageGalleryContext>
  );
}

/** Floats an aligned image the way GitHub does, with room for the text beside it. */
function alignClass(align: unknown): string | undefined {
  if (align === "left") return "float-left mr-5";
  if (align === "right") return "float-right ml-5";
  return undefined;
}

/** The button around an expandable image (or `<picture>`). */
function ExpandTrigger({
  label,
  className,
  children,
}: {
  label: string;
  className?: string | undefined;
  children: ReactNode;
}) {
  const gallery = useContext(MarkdownImageGalleryContext);
  return (
    <button
      type="button"
      {...{ [EXPANDABLE_IMAGE_ATTRIBUTE]: "" }}
      aria-label={label}
      title="Expand image"
      className={cn(
        "inline-block max-w-full cursor-zoom-in rounded-md align-middle outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        className,
      )}
      onClick={(event) => gallery?.open(event.currentTarget)}
    >
      {children}
    </button>
  );
}

/** An HTML length attribute as CSS: bare numbers are pixels. */
function cssLength(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/u.test(text)) return `${text}px`;
  return /^\d+(?:\.\d+)?%$/u.test(text) ? text : undefined;
}

function expandLabel(alt: string | undefined): string {
  const name = alt?.trim();
  return name ? `Expand image: ${name}` : "Expand image";
}

function ImageUnavailable({ src, alt }: { src: string; alt: string | undefined }) {
  const insideLink = useContext(InsideLinkContext);
  const content = (
    <>
      <ImageOffIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{alt?.trim() || "Image"}</span>
      {insideLink ? null : <span className="shrink-0 text-muted-foreground/70">· Open</span>}
    </>
  );
  const className =
    "inline-flex max-w-full items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 align-middle text-muted-foreground text-xs no-underline";
  // Inside a link the link itself already opens something; never nest anchors.
  return insideLink ? (
    <span className={className} title="This image could not be loaded">
      {content}
    </span>
  ) : (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(className, "hover:border-border hover:text-foreground")}
      title="This image could not be loaded here. Open it in the browser."
    >
      {content}
    </a>
  );
}

export function MarkdownImage({
  node: _node,
  alt,
  src,
  align,
  className,
  ...props
}: ComponentProps<"img"> &
  ExtraProps & {
    /** Legacy HTML alignment GitHub bodies use to float an image beside text. */
    align?: string | undefined;
  }) {
  const insideLink = useContext(InsideLinkContext);
  const insidePicture = useContext(InsidePictureContext);
  const gallery = useContext(MarkdownImageGalleryContext);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const source = typeof src === "string" && src.length > 0 ? src : undefined;

  if (source !== undefined && failedSource === source) {
    return <ImageUnavailable src={source} alt={alt} />;
  }

  const lonelyHeight = props.width === undefined ? cssLength(props.height) : undefined;
  const expandable = gallery !== null && source !== undefined && !insideLink && !insidePicture;
  const image = (
    <img
      {...props}
      alt={alt ?? ""}
      src={source}
      loading="lazy"
      decoding="async"
      {...(expandable ? {} : { align })}
      onError={() => {
        if (source !== undefined) setFailedSource(source);
      }}
      // Preflight forces `height: auto`, which keeps the aspect ratio when the
      // column narrows a sized image but would drop a lone `height`.
      {...(lonelyHeight !== undefined ? { style: { height: lonelyHeight } } : {})}
      className={cn(
        // Preflight makes images blocks; Markdown images flow with the text
        // (badge rows, icons) the way GitHub renders them.
        "inline max-w-full align-middle",
        // Screenshots get an edge against the page; linked images (badges) stay bare.
        !insideLink && "rounded-md border border-border/50",
        (expandable || (insidePicture && !insideLink)) && "block",
        className,
      )}
    />
  );
  if (!expandable) return image;
  return (
    <ExpandTrigger label={expandLabel(alt)} className={alignClass(align)}>
      {image}
    </ExpandTrigger>
  );
}

export function MarkdownPicture({
  node: _node,
  children,
  ...props
}: ComponentProps<"picture"> & ExtraProps) {
  const insideLink = useContext(InsideLinkContext);
  const gallery = useContext(MarkdownImageGalleryContext);
  const picture = (
    <picture {...props}>
      <InsidePictureContext value>{children}</InsidePictureContext>
    </picture>
  );
  if (insideLink || gallery === null) return picture;
  return <ExpandTrigger label="Expand image">{picture}</ExpandTrigger>;
}

export function MarkdownLink({
  node: _node,
  href,
  children,
  ...props
}: ComponentProps<"a"> & ExtraProps) {
  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer">
      <InsideLinkContext value>{children}</InsideLinkContext>
    </a>
  );
}
