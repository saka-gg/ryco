/**
 * Micro-benchmark for find in a diff (`apps/web/src/lib/diffSearch.ts`); run with Node.
 *
 *   node --expose-gc scripts/perf/micro/diff-search.ts [module-path]
 *
 * `module-path` defaults to the current module. To compare with an older
 * version, write it to a file and pass its path, e.g.
 *   git show <sha>:apps/web/src/components/DiffPanel.search.logic.ts > /tmp/diff-search-baseline.ts
 * A module without `searchDiffIndex` (before whole-word and regex search) runs
 * the plain searches only.
 *
 * Every timed index build gets freshly built file objects, so a per-file
 * record cache cannot turn a cold build into a lookup; the warm row reuses a
 * cache on the same objects. Heap is measured on fresh objects after `gc()`.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

interface Hunk {
  readonly hunkContent: readonly (
    | {
        readonly type: "context";
        readonly lines: number;
        readonly additionLineIndex: number;
        readonly deletionLineIndex: number;
      }
    | {
        readonly type: "change";
        readonly deletions: number;
        readonly deletionLineIndex: number;
        readonly additions: number;
        readonly additionLineIndex: number;
      }
  )[];
  readonly splitLineStart: number;
  readonly unifiedLineStart: number;
  readonly additionStart: number;
  readonly deletionStart: number;
}

interface File {
  readonly name: string;
  readonly prevName: string;
  readonly additionLines: string[];
  readonly deletionLines: string[];
  readonly hunks: Hunk[];
}

interface Module {
  buildDiffSearchIndex(files: readonly File[], options?: unknown, cache?: unknown): unknown;
  findDiffSearchMatches(
    index: unknown,
    query: string,
    options?: { caseSensitive?: boolean },
  ): unknown[];
  searchDiffIndex?: (
    index: unknown,
    query: string,
    options: { caseSensitive: boolean; wholeWord: boolean; regex: boolean },
  ) => { matches: readonly unknown[]; truncated: boolean; stopped: boolean };
  createDiffSearchRecordCache?: () => unknown;
}

const FILES = 1_500;
const HUNKS = 4;
const CONTEXT = 10;
const CHANGED = 20;
const RUNS = 20;
const WARMUPS = 5;

const words = [
  "name",
  "value",
  "items",
  "render",
  "state",
  "index",
  "result",
  "config",
  "event",
  "layout",
  "cursor",
  "buffer",
  "socket",
  "parser",
  "worker",
  "handle",
  "stream",
  "filter",
  "bundle",
  "commit",
  "branch",
  "remote",
  "status",
  "editor",
];
const identifier = (seed: number) =>
  `${words[seed % words.length]}${words[(seed * 7) % words.length]!.replace(/^./, (c) => c.toUpperCase())}${seed % 97}`;
/** Built with `join`, so every line is a flat string (as parsed patch lines are), not a rope. */
const lineText = (file: number, line: number, suffix = "") =>
  [
    "  const ",
    identifier(file * 131 + line),
    " = compute(",
    identifier(line * 17 + file),
    ', "',
    words[(file + line) % words.length],
    '");',
    suffix,
  ].join("");

/** Fresh, structurally identical files on every call. */
function buildFiles(): File[] {
  const files: File[] = [];
  for (let file = 0; file < FILES; file += 1) {
    const additionLines: string[] = [];
    const deletionLines: string[] = [];
    const hunks: Hunk[] = [];
    let unified = 0;
    let split = 0;
    for (let hunk = 0; hunk < HUNKS; hunk += 1) {
      const additionIndex = additionLines.length;
      const deletionIndex = deletionLines.length;
      const firstLine = hunk * 200 + 1;
      for (let line = 0; line < CONTEXT; line += 1) {
        const text = lineText(file, firstLine + line);
        additionLines.push(text);
        deletionLines.push(text);
      }
      for (let line = 0; line < CHANGED; line += 1) {
        deletionLines.push(lineText(file, firstLine + CONTEXT + line, " // old"));
        additionLines.push(lineText(file, firstLine + CONTEXT + line, " // new"));
      }
      for (let line = 0; line < CONTEXT; line += 1) {
        const text = lineText(file, firstLine + CONTEXT + CHANGED + line);
        additionLines.push(text);
        deletionLines.push(text);
      }
      hunks.push({
        unifiedLineStart: unified,
        splitLineStart: split,
        additionStart: firstLine,
        deletionStart: firstLine,
        hunkContent: [
          {
            type: "context",
            lines: CONTEXT,
            additionLineIndex: additionIndex,
            deletionLineIndex: deletionIndex,
          },
          {
            type: "change",
            deletions: CHANGED,
            deletionLineIndex: deletionIndex + CONTEXT,
            additions: CHANGED,
            additionLineIndex: additionIndex + CONTEXT,
          },
          {
            type: "context",
            lines: CONTEXT,
            additionLineIndex: additionIndex + CONTEXT + CHANGED,
            deletionLineIndex: deletionIndex + CONTEXT + CHANGED,
          },
        ],
      });
      unified += CONTEXT * 2 + CHANGED * 2;
      split += CONTEXT * 2 + CHANGED;
    }
    files.push({
      name: `src/feature-${file}/module-${file}.ts`,
      prevName: `src/feature-${file}/module-${file}.ts`,
      additionLines,
      deletionLines,
      hunks,
    });
  }
  // One very long line, as minified output in a diff would have.
  files[0]!.additionLines[0] = ['const blob = "', "nameValue ".repeat(2_000), '";'].join("");
  return files;
}

function median(values: number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function time(run: () => void, prepare?: () => void): number {
  const samples: number[] = [];
  for (let index = 0; index < WARMUPS + RUNS; index += 1) {
    prepare?.();
    const startedAt = performance.now();
    run();
    const elapsed = performance.now() - startedAt;
    if (index >= WARMUPS) samples.push(elapsed);
  }
  return Math.round(median(samples) * 100) / 100;
}

const gc = (globalThis as { gc?: () => void }).gc;

async function main() {
  const modulePath = resolve(process.argv[2] ?? "apps/web/src/lib/diffSearch.ts");
  const module = (await import(pathToFileURL(modulePath).href)) as Module;

  const lines = buildFiles().reduce(
    (total, file) => total + file.additionLines.length + file.deletionLines.length,
    0,
  );

  let pending: File[] = [];
  const coldBuildMs = time(
    () => {
      module.buildDiffSearchIndex(pending);
    },
    () => {
      pending = buildFiles();
    },
  );

  let warmBuildMs: number | null = null;
  if (module.createDiffSearchRecordCache) {
    const files = buildFiles();
    const cache = module.createDiffSearchRecordCache();
    module.buildDiffSearchIndex(files, undefined, cache);
    warmBuildMs = time(() => {
      module.buildDiffSearchIndex(files, undefined, cache);
    });
  }

  let heapBytes: number | null = null;
  if (gc) {
    const files = buildFiles();
    gc();
    const before = process.memoryUsage().heapUsed;
    const retained = module.buildDiffSearchIndex(files);
    gc();
    heapBytes = process.memoryUsage().heapUsed - before;
    if (!retained) throw new Error("unreachable");
  }

  const index = module.buildDiffSearchIndex(buildFiles());
  const searches: Record<string, { ms: number; matches: number; truncated?: boolean }> = {};
  const plain = (label: string, query: string, caseSensitive: boolean) => {
    let count = 0;
    let truncated: boolean | undefined;
    const ms = time(() => {
      if (module.searchDiffIndex) {
        const result = module.searchDiffIndex(index, query, {
          caseSensitive,
          wholeWord: false,
          regex: false,
        });
        count = result.matches.length;
        truncated = result.truncated;
      } else {
        count = module.findDiffSearchMatches(index, query, { caseSensitive }).length;
      }
    });
    searches[label] = { ms, matches: count, ...(truncated === undefined ? {} : { truncated }) };
  };
  plain('plain "name"', "name", false);
  plain('case-sensitive "Name"', "Name", true);
  plain('one letter "e"', "e", false);
  if (module.searchDiffIndex) {
    const search = module.searchDiffIndex;
    const optioned = (
      label: string,
      query: string,
      options: { caseSensitive: boolean; wholeWord: boolean; regex: boolean },
    ) => {
      let count = 0;
      let stopped = false;
      const ms = time(() => {
        const result = search(index, query, options);
        count = result.matches.length;
        stopped = result.stopped;
      });
      searches[label] = { ms, matches: count, ...(stopped ? { truncated: true } : {}) };
    };
    optioned('whole word "name"', "name", { caseSensitive: false, wholeWord: true, regex: false });
    optioned('regex "na\\w+e"', "na\\w+e", { caseSensitive: false, wholeWord: false, regex: true });
  }

  console.log(
    JSON.stringify(
      {
        module: modulePath,
        node: process.version,
        files: FILES,
        lines,
        runs: RUNS,
        warmups: WARMUPS,
        coldBuildMs,
        warmBuildMs,
        heapMB: heapBytes === null ? null : Math.round((heapBytes / 1024 / 1024) * 10) / 10,
        searches,
      },
      null,
      2,
    ),
  );
}

await main();
