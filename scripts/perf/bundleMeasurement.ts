import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { isOnDemandWebAssetPath } from "../lib/onDemandWebAssets.ts";
import { isPrecompressedSibling } from "../lib/precompressedSiblings.ts";
import type { BundleMeasurement } from "./model.ts";

// Node's Brotli default is quality 11, which is intended for maximum offline
// compression and can take minutes for a production asset tree. Quality 5 is
// representative of dynamic/static web delivery while keeping this diagnostic
// fast enough to run for every compared revision.
const BROTLI_OPTIONS = {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
  },
} as const;

function filesBelow(root: string, directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  return entries.flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return isOnDemandWebAssetPath(path.relative(root, entryPath))
        ? []
        : filesBelow(root, entryPath);
    }
    return entry.isFile() && !isPrecompressedSibling(entry.name, names) ? [entryPath] : [];
  });
}

export function measureWebBundle(distDir: string): BundleMeasurement {
  if (!statSync(distDir).isDirectory()) throw new Error(`Web dist is not a directory: ${distDir}`);
  const files = filesBelow(distDir, distDir);
  let rawBytes = 0;
  let gzipBytes = 0;
  let brotliBytes = 0;
  for (const file of files) {
    const bytes = readFileSync(file);
    rawBytes += bytes.byteLength;
    gzipBytes += zlib.gzipSync(bytes).byteLength;
    brotliBytes += zlib.brotliCompressSync(bytes, BROTLI_OPTIONS).byteLength;
  }
  return { files: files.length, rawBytes, gzipBytes, brotliBytes };
}
