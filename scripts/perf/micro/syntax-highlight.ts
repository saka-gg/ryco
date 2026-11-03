/**
 * Micro-benchmark for the syntax highlighting a diff worker runs per file
 * (`renderFileWithHighlighter` / `renderDiffWithHighlighter` from
 * `@pierre/diffs`); run with Node.
 *
 *   node --expose-gc scripts/perf/micro/syntax-highlight.ts [diffs-entry] [--ref <git-ref>]
 *
 * `diffs-entry` defaults to the web app's `@pierre/diffs` (`dist/index.js`). To
 * compare with another version, install it elsewhere and pass its entry, e.g.
 *   npm install --prefix ~/bench @pierre/diffs@1.4.1
 *   node --expose-gc scripts/perf/micro/syntax-highlight.ts ~/bench/node_modules/@pierre/diffs/dist/index.js
 *
 * Inputs come from this repository at `--ref` (default `HEAD`), so two runs
 * over the same ref highlight the same text: the largest `.ts` file under
 * `apps/`, and the first 156 file diffs of the patches of its last 40 commits.
 * Each highlighter runs in its own process (a thread holds one highlighter
 * type at a time); `setup` is creating the highlighter with every language the
 * inputs use, `first` the first pass (grammar compiles, JIT), the other
 * columns the median of warm passes, and `max RSS` the process peak.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface Highlighter {
  readonly name?: string;
}

interface FileDiff {
  readonly name: string;
  readonly hunks: readonly unknown[];
}

interface Module {
  getSharedHighlighter(options: {
    themes: string[];
    langs: string[];
    preferredHighlighter: string;
  }): Promise<Highlighter>;
  getFiletypeFromFileName(name: string): string;
  parsePatchFiles(patch: string): { files: FileDiff[] }[];
  renderFileWithHighlighter(
    file: { name: string; contents: string },
    highlighter: Highlighter,
    options: unknown,
  ): unknown;
  renderDiffWithHighlighter(diff: FileDiff, highlighter: Highlighter, options: unknown): unknown;
  /** Exported from 1.6.0, which added the `highlights` highlighter. */
  getHighlighterType?: unknown;
}

const HIGHLIGHTERS = ["highlights", "shiki-wasm", "shiki-js"] as const;
type HighlighterType = (typeof HIGHLIGHTERS)[number];
const THEME = "pierre-dark";
const DIFF_FILES = 156;
const COMMITS = 40;
const RUNS = 5;
// The options the app's diff workers render with.
const RENDER_OPTIONS = {
  theme: THEME,
  useTokenTransformer: false,
  tokenizeMaxLineLength: 1_000,
  lineDiffType: "word-alt",
  maxLineDiffLength: 1_000,
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface Result {
  readonly highlighter: HighlighterType;
  readonly supported: boolean;
  readonly setupMs?: number;
  readonly firstFileMs?: number;
  readonly fileMs?: number;
  readonly firstDiffsMs?: number;
  readonly diffsMs?: number;
  readonly maxRssMiB?: number;
}

function git(args: string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function loadInputs(diffs: Module, ref: string) {
  const largest = git(["ls-tree", "-r", "-l", ref, "--", "apps"])
    .split("\n")
    .map((line) => line.match(/^\S+ blob \S+\s+(\d+)\t(.+\.ts)$/))
    .filter((match) => match !== null)
    .map((match) => ({ size: Number(match[1]), path: match[2]! }))
    .toSorted((left, right) => right.size - left.size || left.path.localeCompare(right.path))[0]!;
  const file = { name: largest.path, contents: git(["show", `${ref}:${largest.path}`]) };
  const patch = git(["log", "-p", "--no-merges", "--format=", `-n${COMMITS}`, ref]);
  const files = diffs
    .parsePatchFiles(patch)
    .flatMap((parsed) => parsed.files)
    .filter((diff) => diff.hunks.length > 0)
    .slice(0, DIFF_FILES);
  return { file, files };
}

function median(values: number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

const round = (value: number) => Math.round(value * 10) / 10;

function elapsed(run: () => void): number {
  const startedAt = performance.now();
  run();
  return performance.now() - startedAt;
}

async function measure(entry: string, type: HighlighterType, ref: string): Promise<Result> {
  const diffs = (await import(pathToFileURL(entry).href)) as Module;
  if (type === "highlights" && diffs.getHighlighterType === undefined) {
    return { highlighter: type, supported: false };
  }
  const { file, files } = loadInputs(diffs, ref);
  const langs = [
    ...new Set([file, ...files].map((input) => diffs.getFiletypeFromFileName(input.name))),
  ];

  const startedAt = performance.now();
  const highlighter = await diffs.getSharedHighlighter({
    themes: [THEME],
    langs,
    preferredHighlighter: type,
  });
  const setupMs = performance.now() - startedAt;
  if (highlighter.name !== undefined && highlighter.name !== type) {
    throw new Error(`Asked for the ${type} highlighter, got ${highlighter.name}`);
  }

  const renderFile = () => diffs.renderFileWithHighlighter(file, highlighter, RENDER_OPTIONS);
  const renderDiffs = () => {
    for (const diff of files) diffs.renderDiffWithHighlighter(diff, highlighter, RENDER_OPTIONS);
  };
  const firstFileMs = elapsed(renderFile);
  const firstDiffsMs = elapsed(renderDiffs);
  const gc = (globalThis as { gc?: () => void }).gc;
  const fileSamples: number[] = [];
  const diffSamples: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    gc?.();
    fileSamples.push(elapsed(renderFile));
    gc?.();
    diffSamples.push(elapsed(renderDiffs));
  }
  return {
    highlighter: type,
    supported: true,
    setupMs: round(setupMs),
    firstFileMs: round(firstFileMs),
    fileMs: round(median(fileSamples)),
    firstDiffsMs: round(firstDiffsMs),
    diffsMs: round(median(diffSamples)),
    maxRssMiB: round(process.resourceUsage().maxRSS / 1024),
  };
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const positional = process.argv
  .slice(2)
  .filter((arg, index, args) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"));
const entry = resolve(
  positional[0] ??
    realpathSync(resolve(repoRoot, "apps/web/node_modules/@pierre/diffs/dist/index.js")),
);
if (!existsSync(entry)) throw new Error(`No @pierre/diffs entry at ${entry}`);
const ref = git(["rev-parse", option("--ref") ?? "HEAD"]).trim();
const child = option("--highlighter") as HighlighterType | undefined;

if (child !== undefined) {
  process.stdout.write(JSON.stringify(await measure(entry, child, ref)));
} else {
  const version = (
    (await import(pathToFileURL(resolve(dirname(entry), "../package.json")).href, {
      with: { type: "json" },
    })) as { default: { version: string } }
  ).default.version;
  const { file, files } = loadInputs((await import(pathToFileURL(entry).href)) as Module, ref);
  console.log(
    `@pierre/diffs ${version}, inputs at ${ref.slice(0, 9)}: ${file.name} (${round(
      file.contents.length / 1024,
    )} KiB) and ${files.length} file diffs; median of ${RUNS} warm runs`,
  );
  console.log(
    "| highlighter | setup ms | first file ms | file ms | first diffs ms | diffs ms | max RSS MiB |",
  );
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const type of HIGHLIGHTERS) {
    const run = spawnSync(
      process.execPath,
      ["--expose-gc", fileURLToPath(import.meta.url), entry, "--ref", ref, "--highlighter", type],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    if (run.status !== 0) throw new Error(`${type} run failed:\n${run.stderr}`);
    const result = JSON.parse(run.stdout) as Result;
    console.log(
      result.supported
        ? `| ${type} | ${result.setupMs} | ${result.firstFileMs} | ${result.fileMs} | ${result.firstDiffsMs} | ${result.diffsMs} | ${result.maxRssMiB} |`
        : `| ${type} | not in this version | | | | | |`,
    );
  }
}
