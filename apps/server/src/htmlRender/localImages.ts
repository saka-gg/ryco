// @effect-diagnostics nodeBuiltinImport:off - realpath containment and no-follow reads need node:fs.
/**
 * localImages - Inlines the local images an agent's HTML page names by
 * absolute path as data URIs, so the stored page is self-contained.
 *
 * Only images whose real location is inside an allowed root (the thread's
 * workspace, the system temp directory) are read, so a page cannot carry an
 * image the agent's own sandbox withholds. A path outside every root, a
 * symlink escaping one, a hard link, or a file whose bytes are not an image
 * counts as unreadable, and each is reported with why.
 *
 * @module localImages
 */
import { constants } from "node:fs";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import { HTML_RENDER_MAX_IMAGE_BYTES, HTML_RENDER_MAX_PAGE_BYTES } from "@ryco/shared/htmlRender";
import { Effect } from "effect";

import {
  type HtmlRenderImageRefusal,
  HtmlRenderImageTooLargeError,
  type HtmlRenderMissingImage,
  HtmlRenderPageTooLargeError,
} from "./HtmlRender.ts";

const IMAGE_EXTENSIONS = "png|jpg|jpeg|gif|webp|avif|svg|bmp|ico";
// POSIX `/…` (not protocol-relative `//…`) or Windows `C:\…` / `C:/…`.
const ABSOLUTE_PATH = String.raw`(?:/(?!/)|[a-z]:[\\/])`;
/**
 * An absolute image path that is a whole quoted string ("…", '…', `…`) or an
 * unquoted CSS url(…). URLs, data:, blob:, and relative paths never match.
 */
export const LOCAL_IMAGE_PATTERN = new RegExp(
  String.raw`(["'\x60])(${ABSOLUTE_PATH}(?:(?!\1)[^\r\n]){0,2048}?\.(?:${IMAGE_EXTENSIONS}))\1` +
    String.raw`|url\(\s*(${ABSOLUTE_PATH}[^\s"'\x60()]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))\s*\)`,
  "gid",
);

const findLocalImages = (html: string) =>
  Array.from(html.matchAll(LOCAL_IMAGE_PATTERN)).flatMap((match) => {
    const span = match.indices?.[2] ?? match.indices?.[3];
    return span ? [{ start: span[0], end: span[1], path: html.slice(span[0], span[1]) }] : [];
  });

// Inside a JS string literal a Windows path's backslashes are escaped.
const filePathFor = (reference: string) =>
  /^[a-z]:/i.test(reference) ? reference.replaceAll("\\\\", "\\") : reference;

const latin1 = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/**
 * The image type file bytes hold, whatever the file is named, so a symlink or
 * renamed file cannot carry other data, such as a secret, into a page.
 */
export const imageMimeType = (bytes: Uint8Array): string | undefined => {
  const head = latin1(bytes, 0, 12);
  if (head.startsWith("\x89PNG")) return "image/png";
  if (head.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (head.startsWith("GIF8")) return "image/gif";
  if (head.startsWith("\0\0\x01\0")) return "image/x-icon";
  if (head.startsWith("BM") && head.slice(6, 10) === "\0\0\0\0") return "image/bmp";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  if (/^ftyp(?:avif|avis|mif1)$/.test(head.slice(4, 12))) return "image/avif";
  return hasSvgRoot(new TextDecoder().decode(bytes.subarray(0, 4096)))
    ? "image/svg+xml"
    : undefined;
};

/** The index just past `token` at or after `from`, or -1 when it never appears. */
const after = (text: string, token: string, from: number) => {
  const at = text.indexOf(token, from);
  return at === -1 ? -1 : at + token.length;
};

/**
 * Whether an XML document's root element is <svg>, after any processing
 * instructions, comments, and a doctype. One forward pass, so no input can
 * make it slow, and quoted text never counts as markup.
 */
const hasSvgRoot = (text: string) => {
  let at = 0;
  while (at !== -1) {
    while (/\s/.test(text.charAt(at))) at += 1;
    if (text.startsWith("<?", at)) at = after(text, "?>", at + 2);
    else if (text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
    else if (text.slice(at, at + 9).toLowerCase() === "<!doctype") at = afterDoctype(text, at + 9);
    // XML names are case-sensitive, and only these characters can end one here.
    else return /^<svg[ \t\r\n/>]/.test(text.slice(at, at + 5));
  }
  return false;
};

/** The index just past a doctype whose body starts at `from`, honoring quotes and its internal subset. */
const afterDoctype = (text: string, from: number) => {
  let inSubset = false;
  let at = from;
  while (at !== -1 && at < text.length) {
    const char = text[at];
    if (char === '"' || char === "'") at = after(text, char, at + 1);
    else if (inSubset && text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
    else if (inSubset && text.startsWith("<?", at)) at = after(text, "?>", at + 2);
    else if (char === ">" && !inSubset) return at + 1;
    else {
      if (char === "[") inSubset = true;
      else if (char === "]") inSubset = false;
      at += 1;
    }
  }
  return -1;
};

const isInside = (root: string, candidate: string) => {
  const relative = NodePath.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
};

/** The real locations of the allowed roots; a file system root never counts. */
const realRoots = async (roots: ReadonlyArray<string>) => {
  const resolved = await Promise.all(
    roots.map((root) =>
      NodePath.isAbsolute(root) ? NodeFs.realpath(root).catch(() => undefined) : undefined,
    ),
  );
  return [
    ...new Set(
      resolved.filter(
        (root): root is string => root !== undefined && NodePath.parse(root).root !== root,
      ),
    ),
  ];
};

interface ImageFile {
  readonly path: string;
  readonly real: string;
  readonly size: number;
  readonly dev: number;
  readonly ino: number;
}

const isNotFound = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

/** Where a path that cannot be resolved would be: its nearest resolvable ancestor's real location. */
const realLocationOfUnresolved = async (file: string) => {
  const rest: Array<string> = [];
  let current = NodePath.resolve(file);
  for (;;) {
    const real = await NodeFs.realpath(current).catch(() => undefined);
    if (real !== undefined) return NodePath.join(real, ...rest.toReversed());
    const parent = NodePath.dirname(current);
    if (parent === current) return NodePath.resolve(file);
    rest.push(NodePath.basename(current));
    current = parent;
  }
};

/**
 * The file an image reference names when its real location is a regular,
 * singly linked file inside a root, else why it is refused. A path outside
 * every root is refused as such whether or not it exists, so refusals never
 * tell whether a file exists outside the roots.
 */
const locate = async (
  reference: string,
  roots: ReadonlyArray<string>,
): Promise<ImageFile | HtmlRenderMissingImage> => {
  const refused = (reason: HtmlRenderImageRefusal) => ({ path: reference, reason });
  const file = filePathFor(reference);
  let real: string;
  try {
    real = await NodeFs.realpath(file);
  } catch (error) {
    const location = await realLocationOfUnresolved(file);
    if (!roots.some((root) => isInside(root, location))) return refused("outside-roots");
    return refused(isNotFound(error) ? "not-found" : "unreadable");
  }
  if (!roots.some((root) => isInside(root, real))) return refused("outside-roots");
  try {
    const info = await NodeFs.lstat(real);
    if (!info.isFile()) return refused("not-a-file");
    // A hard link could name a file outside every root.
    if (info.nlink !== 1) return refused("hard-link");
    return { path: reference, real, size: info.size, dev: info.dev, ino: info.ino };
  } catch {
    return refused("unreadable");
  }
};

const isImageFile = (located: ImageFile | HtmlRenderMissingImage): located is ImageFile =>
  "real" in located;

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Reads at most one byte past the image limit. The open file must be the one
 * located, still at its real path afterwards, so swapping a path component
 * for a symlink mid-read cannot redirect it outside its root.
 */
const readImage = async (
  file: ImageFile,
): Promise<{ readonly bytes: Buffer } | { readonly tooLarge: number } | "missing"> => {
  let handle: NodeFs.FileHandle;
  try {
    handle = await NodeFs.open(
      file.real,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return "missing";
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== file.dev || opened.ino !== file.ino) return "missing";
    const chunks: Array<Buffer> = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(
        Math.min(READ_CHUNK_BYTES, HTML_RENDER_MAX_IMAGE_BYTES + 1 - total),
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > HTML_RENDER_MAX_IMAGE_BYTES) {
        return { tooLarge: Math.max(total, (await handle.stat()).size) };
      }
    }
    const now = await NodeFs.lstat(file.real);
    if (
      (await NodeFs.realpath(file.real)) !== file.real ||
      now.dev !== file.dev ||
      now.ino !== file.ino ||
      now.nlink !== 1
    ) {
      return "missing";
    }
    return { bytes: Buffer.concat(chunks, total) };
  } catch {
    return "missing";
  } finally {
    await handle.close().catch(() => undefined);
  }
};

// The longest `data:<type>;base64,` prefix an image can get.
const MAX_DATA_URI_PREFIX = "data:image/svg+xml;base64,".length;
const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

export interface InlinedImages {
  readonly html: string;
  /** References that could not be read, as written in the page, and why. */
  readonly missing: ReadonlyArray<HtmlRenderMissingImage>;
}

/**
 * Replaces every readable local image reference with a data URI; unreadable
 * ones stay as written and are listed in `missing`. Fails when an image or
 * the inlined page is over its size limit.
 */
export const inlineLocalImages = Effect.fn("HtmlRender.inlineLocalImages")(function* (
  html: string,
  imageRoots: ReadonlyArray<string>,
) {
  const references = findLocalImages(html);
  if (references.length === 0) return { html, missing: [] } satisfies InlinedImages;
  const paths = [...new Set(references.map((reference) => reference.path))];
  const roots = yield* Effect.promise(() => realRoots(imageRoots));
  const located = yield* Effect.forEach(
    paths,
    (path) => Effect.promise(() => locate(path, roots)),
    { concurrency: 8 },
  );
  const files = located.filter(isImageFile);
  const refusals = new Map<string, HtmlRenderImageRefusal>(
    located.flatMap((entry) => (isImageFile(entry) ? [] : [[entry.path, entry.reason] as const])),
  );
  const oversized = files.find((file) => file.size > HTML_RENDER_MAX_IMAGE_BYTES);
  if (oversized !== undefined) {
    return yield* new HtmlRenderImageTooLargeError({
      path: oversized.path,
      sizeBytes: oversized.size,
      limitBytes: HTML_RENDER_MAX_IMAGE_BYTES,
    });
  }
  const sizes = new Map(files.map((file) => [file.path, file.size]));
  const estimated = references.reduce((total, reference) => {
    const size = sizes.get(reference.path);
    return size === undefined
      ? total
      : total + MAX_DATA_URI_PREFIX + base64Length(size) - Buffer.byteLength(reference.path);
  }, Buffer.byteLength(html));
  if (estimated > HTML_RENDER_MAX_PAGE_BYTES) {
    return yield* new HtmlRenderPageTooLargeError({
      sizeBytes: estimated,
      limitBytes: HTML_RENDER_MAX_PAGE_BYTES,
    });
  }
  // Files can grow after `lstat`, so each read stops one byte past the image
  // limit, and reading stops once the images read so far cannot fit the page.
  let encodedBytes = 0;
  const images = yield* Effect.forEach(
    files,
    (file) =>
      Effect.gen(function* () {
        const read = yield* Effect.promise(() => readImage(file));
        if (read === "missing") {
          refusals.set(file.path, "unreadable");
          return [];
        }
        if ("tooLarge" in read) {
          return yield* new HtmlRenderImageTooLargeError({
            path: file.path,
            sizeBytes: read.tooLarge,
            limitBytes: HTML_RENDER_MAX_IMAGE_BYTES,
          });
        }
        const mimeType = imageMimeType(read.bytes);
        if (mimeType === undefined) {
          refusals.set(file.path, "not-an-image");
          return [];
        }
        encodedBytes += base64Length(read.bytes.byteLength);
        if (encodedBytes > HTML_RENDER_MAX_PAGE_BYTES) {
          return yield* new HtmlRenderPageTooLargeError({
            sizeBytes: encodedBytes,
            limitBytes: HTML_RENDER_MAX_PAGE_BYTES,
          });
        }
        // Node's encoder: images run to 10 MiB.
        return [[file.path, `data:${mimeType};base64,${read.bytes.toString("base64")}`] as const];
      }),
    { concurrency: 4 },
  );
  const dataUris = new Map(images.flat());
  const parts: Array<string> = [];
  let cursor = 0;
  for (const reference of references) {
    const dataUri = dataUris.get(reference.path);
    if (dataUri === undefined) continue;
    parts.push(html.slice(cursor, reference.start), dataUri);
    cursor = reference.end;
  }
  parts.push(html.slice(cursor));
  const inlined = parts.join("");
  const inlinedBytes = Buffer.byteLength(inlined);
  if (inlinedBytes > HTML_RENDER_MAX_PAGE_BYTES) {
    return yield* new HtmlRenderPageTooLargeError({
      sizeBytes: inlinedBytes,
      limitBytes: HTML_RENDER_MAX_PAGE_BYTES,
    });
  }
  return {
    html: inlined,
    missing: paths.flatMap((path) =>
      dataUris.has(path) ? [] : [{ path, reason: refusals.get(path) ?? "unreadable" }],
    ),
  } satisfies InlinedImages;
});
