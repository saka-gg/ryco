export type PreviewFileKind = "image" | "text" | "binary";

const IMAGE_EXTENSIONS = new Set(["gif", "jpeg", "jpg", "png", "svg", "webp"]);
const TEXT_EXTENSIONS = new Set([
  "bash",
  "c",
  "cc",
  "conf",
  "cpp",
  "css",
  "csv",
  "dockerfile",
  "env",
  "gitignore",
  "go",
  "h",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsx",
  "log",
  "md",
  "mdx",
  "py",
  "rs",
  "sh",
  "sql",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  ["css", "css"],
  ["go", "go"],
  ["html", "html"],
  ["js", "js"],
  ["json", "json"],
  ["jsx", "jsx"],
  ["md", "markdown"],
  ["mdx", "markdown"],
  ["py", "python"],
  ["rs", "rust"],
  ["sh", "bash"],
  ["ts", "ts"],
  ["tsx", "tsx"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
]);

const TEXT_MIME_TYPES = new Set([
  "application/javascript",
  "application/json",
  "application/toml",
  "application/typescript",
  "application/xml",
  "application/x-sh",
  "application/yaml",
  "application/xhtml+xml",
  "image/svg+xml",
]);

export interface PreviewProjectEntryFilterInput {
  readonly path: string;
  readonly kind: "file" | "directory";
}

function getPreviewBasename(filePath: string): string {
  const withoutQuery = filePath.split(/[?#]/, 1)[0] ?? filePath;
  return withoutQuery.toLowerCase().split("/").at(-1) ?? withoutQuery.toLowerCase();
}

function getPreviewExtension(filePath: string): string {
  const basename = getPreviewBasename(filePath);
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === basename.length - 1) {
    return basename;
  }
  return basename.slice(dotIndex + 1);
}

export function inferPreviewLanguage(filePath: string): string {
  const basename = getPreviewBasename(filePath);
  if (basename === "dockerfile") return "dockerfile";
  if (basename === ".gitignore") return "ini";
  return LANGUAGE_BY_EXTENSION.get(getPreviewExtension(filePath)) ?? "text";
}

export function detectPreviewFileKind(input: {
  readonly filePath: string;
  readonly mimeType?: string | null;
}): PreviewFileKind {
  const mimeType = input.mimeType?.toLowerCase().split(";", 1)[0]?.trim();
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType && (mimeType.startsWith("text/") || TEXT_MIME_TYPES.has(mimeType))) {
    return "text";
  }

  const extension = getPreviewExtension(input.filePath);
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  return "binary";
}

/**
 * How an image preview gets its bytes. Raster images go through the binary
 * read (magic-byte sniffed, 4 MiB cap); SVG is text, so it renders from the
 * regular text read.
 */
export type PreviewImageSource = "raster" | "svg";

export function resolvePreviewImageSource(filePath: string): PreviewImageSource | null {
  const extension = getPreviewExtension(filePath);
  if (!IMAGE_EXTENSIONS.has(extension)) return null;
  return extension === "svg" ? "svg" : "raster";
}

export function decodeBase64Bytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Whether bytes of this type may back a same-origin `blob:` URL. Opening such a
 * URL in its own tab renders it as a document of the app's origin, so only
 * inert raster types qualify: never SVG (it can run script) or anything that
 * is not an image, whatever a remote node reports.
 */
export function isInertRasterImageMimeType(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return normalized.startsWith("image/") && !normalized.startsWith("image/svg");
}

/**
 * SVG markup renders from a `data:` URL: it has an opaque origin and browsers
 * refuse to open it as a top-level document, so scripts inside the file can
 * never run with the app's origin.
 */
export function previewSvgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function normalizePreviewEntryPath(pathValue: string): string {
  return pathValue.replaceAll("\\", "/").toLowerCase();
}

function getPreviewSearchTokens(query: string): string[] {
  return normalizePreviewEntryPath(query)
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function previewPathMatchesTokens(pathValue: string, tokens: ReadonlyArray<string>): boolean {
  return tokens.every((token) => pathValue.includes(token));
}

function hasMatchingDirectoryAncestor(
  pathValue: string,
  matchingDirectoryPaths: ReadonlySet<string>,
): boolean {
  let slashIndex = pathValue.lastIndexOf("/");
  while (slashIndex > 0) {
    if (matchingDirectoryPaths.has(pathValue.slice(0, slashIndex))) {
      return true;
    }
    slashIndex = pathValue.lastIndexOf("/", slashIndex - 1);
  }
  return false;
}

export function filterPreviewProjectEntries<T extends PreviewProjectEntryFilterInput>(
  entries: ReadonlyArray<T>,
  query: string,
): ReadonlyArray<T> {
  const tokens = getPreviewSearchTokens(query);
  if (tokens.length === 0) {
    return entries;
  }

  const matchingDirectoryPaths = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "directory") {
      continue;
    }
    const normalizedPath = normalizePreviewEntryPath(entry.path);
    if (previewPathMatchesTokens(normalizedPath, tokens)) {
      matchingDirectoryPaths.add(normalizedPath);
    }
  }

  return entries.filter((entry) => {
    const normalizedPath = normalizePreviewEntryPath(entry.path);
    return (
      previewPathMatchesTokens(normalizedPath, tokens) ||
      hasMatchingDirectoryAncestor(normalizedPath, matchingDirectoryPaths)
    );
  });
}
