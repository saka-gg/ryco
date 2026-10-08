import type { FileDiffMetadata } from "@pierre/diffs/react";
import type { EnvironmentId } from "@ryco/contracts";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { readEnvironmentApi } from "../environmentApi";
import { errorMessage } from "../lib/errorMessage";
import { LRUCache } from "../lib/lruCache";
import { cn } from "~/lib/utils";
import { formatAttachmentBytes } from "./chat/attachmentPreview";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import { buildExpandedImagePreview } from "./chat/ExpandedImagePreview";
import {
  diffImageCacheKey,
  resolveDiffImageTargets,
  type DiffImageSide,
  type DiffImageSource,
  type DiffImageTarget,
} from "./DiffImagePreview.logic";
import { Skeleton } from "./ui/skeleton";

type SettledDiffImage =
  | { readonly status: "ready"; readonly src: string; readonly sizeBytes: number }
  | { readonly status: "unavailable"; readonly reason: string };
type DiffImageState = SettledDiffImage | { readonly status: "loading" };

const LOADING: DiffImageState = { status: "loading" };
// Every key is content-versioned, so settled reads survive virtualized
// remounts and turn switches. Transport failures are not retained.
const settledImages = new LRUCache<SettledDiffImage>(64, 48 * 1024 * 1024);
const pendingImages = new Map<string, Promise<SettledDiffImage>>();

function readDiffImage(
  environmentId: EnvironmentId,
  cwd: string,
  source: DiffImageSource,
): Promise<SettledDiffImage> {
  const key = diffImageCacheKey({ environmentId, cwd, source });
  const settled = settledImages.get(key);
  if (settled) return Promise.resolve(settled);
  const pending = pendingImages.get(key);
  if (pending) return pending;
  const api = readEnvironmentApi(environmentId);
  if (!api) return Promise.resolve({ status: "unavailable", reason: "Environment is offline." });

  const request = (
    source.kind === "blob"
      ? api.vcs.readImageBlob({ cwd, oid: source.oid })
      : api.projects
          .readFileBinary({ cwd, relativePath: source.relativePath })
          .then((result) => ({ kind: "image" as const, ...result }))
  )
    .then((result): SettledDiffImage => {
      const image: SettledDiffImage =
        result.kind === "image"
          ? {
              status: "ready",
              src: `data:${result.mimeType};base64,${result.dataBase64}`,
              sizeBytes: result.sizeBytes,
            }
          : { status: "unavailable", reason: result.reason };
      settledImages.set(key, image, image.status === "ready" ? image.src.length * 2 : 512);
      return image;
    })
    .catch((error: unknown): SettledDiffImage => ({
      status: "unavailable",
      reason: errorMessage(error, "Couldn’t load this image."),
    }))
    .finally(() => pendingImages.delete(key));
  pendingImages.set(key, request);
  return request;
}

function useDiffImages(
  environmentId: EnvironmentId,
  cwd: string,
  targets: ReadonlyArray<DiffImageTarget>,
): ReadonlyArray<DiffImageState> {
  const fromCache = useCallback(
    () =>
      targets.map(
        (target) =>
          settledImages.get(diffImageCacheKey({ environmentId, cwd, source: target.source })) ??
          LOADING,
      ),
    [cwd, environmentId, targets],
  );
  const [state, setState] = useState(() => ({ targets, images: fromCache() }));
  // Reset with the targets; cached images render without a loading frame.
  const images = state.targets === targets ? state.images : fromCache();

  useEffect(() => {
    let active = true;
    setState((current) => (current.targets === targets ? current : { targets, images }));
    targets.forEach((target, index) => {
      if (images[index]?.status !== "loading") return;
      void readDiffImage(environmentId, cwd, target.source).then((image) => {
        if (!active) return;
        setState((current) =>
          current.targets === targets
            ? { targets, images: current.images.with(index, image) }
            : current,
        );
      });
    });
    return () => {
      active = false;
    };
    // `images` is derived from these inputs; re-running on its identity would refetch.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, environmentId, targets]);

  return images;
}

interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

const DiffImageTile = memo(function DiffImageTile(props: {
  target: DiffImageTarget;
  image: DiffImageState;
  dimensions: ImageDimensions | undefined;
  onDimensions: (side: DiffImageSide, dimensions: ImageDimensions) => void;
  onOpen: (side: DiffImageSide) => void;
}) {
  const { target, image, dimensions, onDimensions, onOpen } = props;
  const frameClassName = cn(
    "flex h-48 w-full items-center justify-center overflow-hidden rounded-md border bg-background/60 p-1",
    target.side === "before" ? "border-destructive/35" : "border-success/35",
  );
  const details = [
    dimensions ? `${dimensions.width} × ${dimensions.height}` : null,
    image.status === "ready" ? formatAttachmentBytes(image.sizeBytes) : null,
  ].filter((detail) => detail !== null);
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1.5">
      {image.status === "ready" ? (
        <button
          type="button"
          className={cn(
            frameClassName,
            "cursor-zoom-in transition-colors hover:bg-background focus-visible:outline-2 focus-visible:outline-ring",
          )}
          aria-label={`Open ${target.label.toLowerCase()} image of ${target.path}`}
          onClick={() => onOpen(target.side)}
        >
          <img
            src={image.src}
            alt={`${target.label}: ${target.path}`}
            className="max-h-full max-w-full select-none object-contain"
            decoding="async"
            draggable={false}
            onLoad={(event) =>
              onDimensions(target.side, {
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
          />
        </button>
      ) : image.status === "loading" ? (
        <Skeleton className={cn(frameClassName, "border-transparent")} />
      ) : (
        <div
          role="status"
          className={cn(frameClassName, "px-3 text-center text-[11px] text-muted-foreground")}
        >
          {image.reason}
        </div>
      )}
      <figcaption className="truncate text-[11px] text-muted-foreground/80">
        <span
          className={cn(
            "font-medium",
            target.side === "before" ? "text-destructive" : "text-success",
          )}
        >
          {target.label}
        </span>
        {details.length > 0 ? ` · ${details.join(" · ")}` : null}
      </figcaption>
    </figure>
  );
});

/**
 * Before/after previews for a binary image change, opened in the shared image
 * viewer. `afterIsWorkingTree` marks unstaged patches, whose new side exists
 * only as the working file.
 */
export const DiffImagePreview = memo(function DiffImagePreview(props: {
  environmentId: EnvironmentId;
  cwd: string;
  fileDiff: FileDiffMetadata;
  afterIsWorkingTree: boolean;
}) {
  const { environmentId, cwd, fileDiff, afterIsWorkingTree } = props;
  const targets = useMemo(
    () => resolveDiffImageTargets({ fileDiff, afterIsWorkingTree }),
    [afterIsWorkingTree, fileDiff],
  );
  const images = useDiffImages(environmentId, cwd, targets);
  const [dimensions, setDimensions] = useState<Partial<Record<DiffImageSide, ImageDimensions>>>({});
  const [expandedSide, setExpandedSide] = useState<DiffImageSide | null>(null);
  const onDimensions = useCallback((side: DiffImageSide, next: ImageDimensions) => {
    setDimensions((current) => ({ ...current, [side]: next }));
  }, []);
  const expandedPreview = useMemo(
    () =>
      expandedSide === null
        ? null
        : buildExpandedImagePreview(
            targets.map((target, index) => {
              const image = images[index];
              const size = dimensions[target.side];
              return {
                id: target.side,
                name: `${target.label} — ${target.path}`,
                ...(image?.status === "ready" ? { previewUrl: image.src } : {}),
                ...(size ? { width: size.width, height: size.height } : {}),
              };
            }),
            expandedSide,
          ),
    [dimensions, expandedSide, images, targets],
  );
  const closeExpanded = useCallback(() => setExpandedSide(null), []);

  if (targets.length === 0) return null;
  return (
    <div
      className={cn("grid gap-3 p-3", targets.length > 1 && "grid-cols-2")}
      data-diff-image-preview=""
    >
      {targets.map((target, index) => (
        <DiffImageTile
          key={target.side}
          target={target}
          image={images[index] ?? LOADING}
          dimensions={dimensions[target.side]}
          onDimensions={onDimensions}
          onOpen={setExpandedSide}
        />
      ))}
      {expandedPreview
        ? createPortal(
            <ExpandedImageDialog preview={expandedPreview} onClose={closeExpanded} />,
            document.body,
          )
        : null}
    </div>
  );
});
