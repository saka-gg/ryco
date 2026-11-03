import { getSharedHighlighter } from "@pierre/diffs";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";

import {
  resolveDiffThemeName,
  SYNTAX_TOKENIZE_MAX_LINE_LENGTH,
  type DiffThemeName,
} from "./diffRendering";
import {
  createDiffWorkerPoolOwner,
  resolveDiffWorkerPoolSize,
  type DiffWorkerPoolLease,
} from "./diffWorkerPoolOwner";
import {
  getMainThreadSyntaxHighlighter,
  pageCanCompileWebAssembly,
  resolveSyntaxHighlighter,
} from "./syntaxHighlighterType";

/**
 * App-lifetime owner of the `@pierre/diffs` highlight worker pool.
 *
 * The library's own provider creates the pool when it mounts and terminates
 * it as soon as the last provider unmounts, which threw away compiled grammars
 * and highlight caches on every panel close, tab switch and thread switch. Here
 * consumers lease the pool; once nothing holds it, it survives an idle grace
 * period (shorter while the document is hidden) before its workers stop.
 */

const DIFF_AST_CACHE_SIZE = 120;

// Set once a WASM pool's workers fail to start (a CSP on the worker script
// that the page's own probe could not see): later pools use the JS engine.
let wasmPoolFailed = false;
const wasmPools = new WeakSet<WorkerPoolManager>();

function recordWasmPoolFailure(pool: WorkerPoolManager): void {
  if (wasmPools.has(pool) && pool.getStats().workersFailed) wasmPoolFailed = true;
}

function terminateDiffWorkerPool(pool: WorkerPoolManager): void {
  // The stat broadcast below waits for an animation frame, which a hidden tab
  // never paints, and `terminate()` clears the failure: read it first.
  recordWasmPoolFailure(pool);
  pool.terminate();
}

function createDiffWorkerPool(themeName: DiffThemeName): WorkerPoolManager {
  const preferredHighlighter = resolveSyntaxHighlighter({
    canCompileWebAssembly: pageCanCompileWebAssembly(),
    wasmFailed: wasmPoolFailed,
  });
  // The pool loads the main-thread highlighter too (for its plain-text
  // placeholders), a page-wide singleton shared with chat markdown and fixed by
  // its first caller. Claim it for the main thread's own engine: after a failed
  // WASM pool the workers fall back to the JS engine, the page need not.
  void getSharedHighlighter({
    themes: [themeName],
    langs: ["text"],
    preferredHighlighter: getMainThreadSyntaxHighlighter(),
  }).catch(() => undefined);
  const pool = new WorkerPoolManager(
    {
      workerFactory: () => new DiffsWorker(),
      poolSize: resolveDiffWorkerPoolSize(
        typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency,
      ),
      totalASTLRUCacheSize: DIFF_AST_CACHE_SIZE,
    },
    {
      theme: themeName,
      tokenizeMaxLineLength: SYNTAX_TOKENIZE_MAX_LINE_LENGTH,
      // Word-level highlighting of changed line pairs. While the pool runs, pierre renders
      // every diff with these options instead of the component's, one file at a time as the
      // virtualizer draws it, and caches the result under the file's own content key.
      lineDiffType: "word-alt",
      preferredHighlighter,
    },
  );
  if (preferredHighlighter === "highlights") {
    wasmPools.add(pool);
    const unsubscribe = pool.subscribeToStatChanges((stats) => {
      if (!stats.workersFailed) return;
      wasmPoolFailed = true;
      unsubscribe();
    });
  }
  return pool;
}

const diffWorkerPoolOwner = createDiffWorkerPoolOwner<WorkerPoolManager>({
  create: createDiffWorkerPool,
  terminate: terminateDiffWorkerPool,
  isDocumentHidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
});

let visibilityListenerInstalled = false;
function installVisibilityListener(): void {
  if (visibilityListenerInstalled || typeof document === "undefined") return;
  visibilityListenerInstalled = true;
  document.addEventListener("visibilitychange", diffWorkerPoolOwner.onVisibilityChange);
}

export function getDiffWorkerPool(themeName: DiffThemeName): WorkerPoolManager {
  installVisibilityListener();
  return diffWorkerPoolOwner.get(themeName);
}

export function acquireDiffWorkerPool(
  themeName: DiffThemeName,
): DiffWorkerPoolLease<WorkerPoolManager> {
  installVisibilityListener();
  return diffWorkerPoolOwner.acquire(themeName);
}

/**
 * Starts the workers (and compiles the theme) ahead of a likely review open,
 * for example on hover of the review entry points. An unused prewarm ends with
 * the normal idle grace.
 */
export function prewarmDiffWorkerPool(): void {
  if (typeof window === "undefined" || typeof Worker === "undefined") return;
  // The theme store applies the resolved theme as a root class.
  const dark = document.documentElement.classList.contains("dark");
  getDiffWorkerPool(resolveDiffThemeName(dark ? "dark" : "light"));
}
