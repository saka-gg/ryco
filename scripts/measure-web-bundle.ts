import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { isOnDemandWebAssetPath } from "./lib/onDemandWebAssets.ts";
import { isPrecompressedSibling } from "./lib/precompressedSiblings.ts";

interface BundleFileRow {
  readonly group: string;
  readonly file: string;
  readonly rawBytes: number;
  readonly gzipBytes: number;
  readonly brotliBytes: number;
}

interface BundleGroupSummary {
  rawBytes: number;
  gzipBytes: number;
  brotliBytes: number;
  files: number;
}

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function parseArgs(argv: readonly string[]): { distDir: string; top: number } {
  let distDir = path.join(repoRoot, "apps/web/dist");
  let top = 50;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dist") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--dist requires a path.");
      }
      distDir = path.resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--top") {
      const value = argv[index + 1];
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--top requires a positive number.");
      }
      top = Math.floor(parsed);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument '${arg}'.`);
  }
  return { distDir, top };
}

function assertDirectory(dir: string): void {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(
      `Missing web dist directory at ${dir}.\nRun: RYCO_WEB_SOURCEMAP=0 bun --cwd apps/web run build`,
    );
  }
}

function walkFiles(root: string, dir = root): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  return entries
    .flatMap((entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return walkFiles(root, entryPath);
      }
      if (!entry.isFile() || isPrecompressedSibling(entry.name, names)) {
        return [];
      }
      return [path.relative(root, entryPath).split(path.sep).join("/")];
    })
    .toSorted();
}

export function normalizeHtmlAssetRef(rawRef: string): string {
  return rawRef.replace(/^\.\//u, "").replace(/^\//u, "").split(/[?#]/u)[0] ?? "";
}

export function readInitialAssetRefs(distDir: string): Set<string> {
  const htmlPath = path.join(distDir, "index.html");
  if (!fs.existsSync(htmlPath)) {
    return new Set();
  }
  const html = fs.readFileSync(htmlPath, "utf8");
  const refs = new Set<string>();
  for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    const rawRef = match[1];
    if (!rawRef || rawRef.startsWith("http://") || rawRef.startsWith("https://")) {
      continue;
    }
    const normalized = normalizeHtmlAssetRef(rawRef);
    if (normalized && fs.existsSync(path.join(distDir, normalized))) {
      refs.add(normalized);
    }
  }
  return refs;
}

export function classifyFile(file: string, initialAssets: ReadonlySet<string>): string {
  const isInitial = initialAssets.has(file);
  if (file === "index.html") return "html";
  // Fetched one file at a time (the file icon set); reported apart from bundle output.
  if (isOnDemandWebAssetPath(file)) return "on-demand-assets";
  if (file.endsWith(".map")) return "sourcemaps";
  if (isInitial && file.endsWith(".js")) return "initial-js";
  if (isInitial && file.endsWith(".css")) return "initial-css";
  if (file.endsWith(".js")) return "async-js";
  if (file.endsWith(".css")) return "async-css";
  if (/\.(?:woff2?|ttf|otf)$/iu.test(file)) return "fonts";
  if (/\.(?:png|jpe?g|svg|ico|webp|avif)$/iu.test(file)) return "images";
  return "other";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function summarizeRows(rows: readonly BundleFileRow[]): Map<string, BundleGroupSummary> {
  const summaries = new Map<string, BundleGroupSummary>();
  for (const row of rows) {
    const current = summaries.get(row.group) ?? {
      rawBytes: 0,
      gzipBytes: 0,
      brotliBytes: 0,
      files: 0,
    };
    current.rawBytes += row.rawBytes;
    current.gzipBytes += row.gzipBytes;
    current.brotliBytes += row.brotliBytes;
    current.files += 1;
    summaries.set(row.group, current);
  }
  return summaries;
}

function printMarkdownReport(input: {
  readonly distDir: string;
  readonly rows: readonly BundleFileRow[];
  readonly top: number;
}): void {
  const summaries = summarizeRows(input.rows);
  console.log("# Web Bundle Size Measurement");
  console.log("");
  console.log(`Dist: \`${path.relative(repoRoot, input.distDir) || input.distDir}\``);
  console.log("");
  console.log("## Group Summary");
  console.log("");
  console.log("| Group | Files | Raw | Gzip | Brotli |");
  console.log("| --- | ---: | ---: | ---: | ---: |");
  for (const [group, summary] of [...summaries.entries()].toSorted(
    (left, right) => right[1].rawBytes - left[1].rawBytes,
  )) {
    console.log(
      `| ${group} | ${summary.files} | ${formatBytes(summary.rawBytes)} | ${formatBytes(summary.gzipBytes)} | ${formatBytes(summary.brotliBytes)} |`,
    );
  }
  console.log("");
  console.log(`## Largest ${Math.min(input.top, input.rows.length)} Files`);
  console.log("");
  console.log("| Group | Raw | Gzip | Brotli | File |");
  console.log("| --- | ---: | ---: | ---: | --- |");
  for (const row of input.rows
    .toSorted((left, right) => right.rawBytes - left.rawBytes)
    .slice(0, input.top)) {
    console.log(
      `| ${row.group} | ${formatBytes(row.rawBytes)} | ${formatBytes(row.gzipBytes)} | ${formatBytes(row.brotliBytes)} | \`${row.file}\` |`,
    );
  }
}

function main(): void {
  const { distDir, top } = parseArgs(process.argv.slice(2));
  assertDirectory(distDir);
  const initialAssets = readInitialAssetRefs(distDir);
  const rows = walkFiles(distDir).map((file) => {
    const bytes = fs.readFileSync(path.join(distDir, file));
    return {
      group: classifyFile(file, initialAssets),
      file,
      rawBytes: bytes.length,
      gzipBytes: zlib.gzipSync(bytes).length,
      brotliBytes: zlib.brotliCompressSync(bytes).length,
    };
  });
  printMarkdownReport({ distDir, rows, top });
}

function isCliEntrypoint(): boolean {
  const scriptPath = process.argv[1];
  return scriptPath !== undefined && path.resolve(scriptPath) === fileURLToPath(import.meta.url);
}

if (isCliEntrypoint()) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
