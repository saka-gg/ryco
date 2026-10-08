import type { FileDiffMetadata } from "@pierre/diffs";

/** Raster formats the server sniffs from image bytes and browsers can display. */
const RASTER_IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "webp",
]);

export type DiffImageSide = "before" | "after";

/**
 * `blob` reads the exact object named by the patch's `index` line. Unstaged
 * patches hash the working file without storing it, so that side reads the
 * working file; its hash still versions the cache entry.
 */
export type DiffImageSource =
  | { readonly kind: "blob"; readonly oid: string }
  | { readonly kind: "working-tree"; readonly relativePath: string; readonly version: string };

export interface DiffImageTarget {
  readonly side: DiffImageSide;
  readonly label: string;
  readonly path: string;
  readonly source: DiffImageSource;
}

function isRasterImagePath(filePath: string): boolean {
  const basename = filePath.split("/").at(-1) ?? filePath;
  const dotIndex = basename.lastIndexOf(".");
  return dotIndex > 0 && RASTER_IMAGE_EXTENSIONS.has(basename.slice(dotIndex + 1).toLowerCase());
}

function storedObjectId(oid: string | undefined): string | null {
  return oid && /^[0-9a-f]{4,64}$/.test(oid) && !/^0+$/.test(oid) ? oid : null;
}

/**
 * Image previews for a binary image patch (no text hunks). Returns nothing for
 * text diffs, non-images, or patches whose header names no image content.
 */
export function resolveDiffImageTargets(input: {
  readonly fileDiff: Pick<
    FileDiffMetadata,
    "name" | "prevName" | "type" | "hunks" | "prevObjectId" | "newObjectId"
  >;
  /** The patch's new side is the unstaged working tree. */
  readonly afterIsWorkingTree: boolean;
}): DiffImageTarget[] {
  const { fileDiff } = input;
  const beforePath = fileDiff.prevName ?? fileDiff.name;
  if (!isRasterImagePath(fileDiff.name) && !isRasterImagePath(beforePath)) return [];
  if (fileDiff.hunks.length > 0) return [];

  const beforeOid = fileDiff.type === "new" ? null : storedObjectId(fileDiff.prevObjectId);
  const afterOid = fileDiff.type === "deleted" ? null : storedObjectId(fileDiff.newObjectId);
  const before: Omit<DiffImageTarget, "label"> | null = beforeOid
    ? { side: "before", path: beforePath, source: { kind: "blob", oid: beforeOid } }
    : null;
  const after: Omit<DiffImageTarget, "label"> | null = !afterOid
    ? null
    : input.afterIsWorkingTree
      ? {
          side: "after",
          path: fileDiff.name,
          source: { kind: "working-tree", relativePath: fileDiff.name, version: afterOid },
        }
      : { side: "after", path: fileDiff.name, source: { kind: "blob", oid: afterOid } };

  if (before && after) {
    return [
      { ...before, label: "Before" },
      { ...after, label: "After" },
    ];
  }
  if (before) return [{ ...before, label: fileDiff.type === "deleted" ? "Deleted" : "Before" }];
  if (after) return [{ ...after, label: fileDiff.type === "new" ? "Added" : "After" }];
  return [];
}

/** Stable cache identity; blob IDs and working-file hashes both version their content. */
export function diffImageCacheKey(input: {
  readonly environmentId: string;
  readonly cwd: string;
  readonly source: DiffImageSource;
}): string {
  return JSON.stringify(
    input.source.kind === "blob"
      ? [input.environmentId, input.cwd, "blob", input.source.oid]
      : [
          input.environmentId,
          input.cwd,
          "working-tree",
          input.source.relativePath,
          input.source.version,
        ],
  );
}
