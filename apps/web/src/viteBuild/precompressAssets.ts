import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import type { Plugin } from "vite";

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Below this size the encoding headers cost about as much as the bytes saved. */
export const PRECOMPRESS_MIN_BYTES = 1024;
/** A sibling must save at least this fraction, or identity is served instead. */
const PRECOMPRESS_MIN_SAVING = 0.1;
const PRECOMPRESS_CONCURRENCY = 8;

const COMPRESSIBLE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".css",
  ".html",
  ".svg",
  ".json",
  ".wasm",
  ".txt",
  ".ttf",
  ".bcmap",
  ".pfb",
]);

/** Vite's content-hashed asset names: `<name>-<8 base64url chars>.<ext>`. */
const HASHED_ASSET_PATTERN = /-[\w-]{8}\.[a-z0-9]+$/i;

/**
 * Whether `fileName` (relative to the build output directory) gets compressed
 * siblings: content-hashed, compressible files of at least
 * `PRECOMPRESS_MIN_BYTES`. Hashed names are immutable, so a sibling can never
 * be served for different bytes than its source.
 */
export function shouldPrecompressAsset(fileName: string, byteLength: number): boolean {
  if (byteLength < PRECOMPRESS_MIN_BYTES) return false;
  if (fileName.endsWith(".map")) return false;
  if (!HASHED_ASSET_PATTERN.test(path.basename(fileName))) return false;
  return COMPRESSIBLE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

export interface PrecompressedAssetsOptions {
  /**
   * Also write `.br` siblings (quality 11). Off by default: browsers only
   * advertise `br` over HTTPS, while most direct node access is plain HTTP on
   * loopback or a LAN, so the server would almost never pick them. Writing
   * both encodings also doubled what the siblings add to the npm package and
   * the desktop artifact. The server negotiates `br` first whenever a sibling
   * exists, so turning this on needs no server change.
   */
  readonly brotli?: boolean;
}

async function compressSiblings(
  file: string,
  source: Buffer,
  options: PrecompressedAssetsOptions,
): Promise<void> {
  const maxBytes = source.length * (1 - PRECOMPRESS_MIN_SAVING);
  const writeIfSmaller = async (suffix: string, compressed: Promise<Buffer>) => {
    const bytes = await compressed;
    if (bytes.length <= maxBytes) await writeFile(`${file}${suffix}`, bytes);
  };
  await Promise.all([
    writeIfSmaller(".gz", gzipAsync(source, { level: zlibConstants.Z_BEST_COMPRESSION })),
    options.brotli
      ? writeIfSmaller(
          ".br",
          brotliCompressAsync(source, {
            params: {
              [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
              [zlibConstants.BROTLI_PARAM_SIZE_HINT]: source.length,
            },
          }),
        )
      : undefined,
  ]);
}

/**
 * Writes a `.gz` sibling (and a `.br` one with `brotli: true`) next to every
 * hashed build asset, so the Ryco server can answer `Accept-Encoding` from
 * disk instead of shipping the uncompressed bundle (or compressing on the
 * fly). Siblings that would not save at least 10% are skipped, and the server
 * falls back to identity.
 */
export function createPrecompressedAssetsPlugin(options: PrecompressedAssetsOptions = {}): Plugin {
  let outDir = "dist";
  return {
    name: "ryco-precompressed-assets",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async writeBundle(_options, bundle) {
      const files = Object.values(bundle)
        .map((output) => output.fileName)
        .filter((fileName) => HASHED_ASSET_PATTERN.test(path.basename(fileName)));
      let next = 0;
      const worker = async () => {
        while (next < files.length) {
          const fileName = files[next++]!;
          const file = path.join(outDir, fileName);
          const source = await readFile(file);
          if (!shouldPrecompressAsset(fileName, source.length)) continue;
          await compressSiblings(file, source, options);
        }
      };
      await Promise.all(Array.from({ length: PRECOMPRESS_CONCURRENCY }, worker));
    },
  };
}
