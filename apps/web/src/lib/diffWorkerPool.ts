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

function supportsWasmHighlighter(): boolean {
  return typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function";
}

function createDiffWorkerPool(themeName: DiffThemeName): WorkerPoolManager {
  // Oniguruma (WASM) tokenizes about 25-30% faster than the JS regex engine in
  // these workers (measured warm: 36 -> 27 ms per 200 TSX lines, 270 -> 205 ms
  // per 1,600). Environments without WebAssembly (for example Lockdown Mode)
  // keep the JS engine.
  const preferredHighlighter = supportsWasmHighlighter() ? "shiki-wasm" : "shiki-js";
  if (preferredHighlighter === "shiki-wasm") {
    // The pool passes its engine to the main-thread highlighter too, which is a
    // page-wide singleton shared with chat markdown and fixed by its first
    // caller. That one only renders plain-text placeholders and markdown, so
    // claim it for the JS engine before the pool can load WASM on the main thread.
    void getSharedHighlighter({
      themes: [themeName],
      langs: ["text"],
      preferredHighlighter: "shiki-js",
    }).catch(() => undefined);
  }
  return new WorkerPoolManager(
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
      preferredHighlighter,
    },
  );
}

const diffWorkerPoolOwner = createDiffWorkerPoolOwner<WorkerPoolManager>({
  create: createDiffWorkerPool,
  terminate: (pool) => pool.terminate(),
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
