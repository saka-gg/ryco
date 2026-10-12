import type { DiffsHighlighter, SupportedLanguages } from "@pierre/diffs";

import { fnv1a32, resolveDiffThemeName, type DiffThemeName } from "../../lib/diffRendering";
import { scheduleIdleTask } from "../../lib/idleTask";
import { LRUCache } from "../../lib/lruCache";

/**
 * Off-render syntax highlighting for settled chat code blocks.
 *
 * Shiki's first tokenization of a grammar compiles its regexes (50-80 ms per
 * language, and again whenever new rules are hit), and warm highlighting still
 * costs ~10 ms per 200 lines. Doing that inside render put long tasks into the
 * thread-open commit and into every Suspense retry. Blocks now render as plain
 * text, queue a job here, and swap in the highlighted HTML once an idle slot
 * has produced it; blocks on screen go first. The Shiki stack itself is loaded
 * on the first job, not with the chat route.
 */

const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;
/** An idle slot keeps highlighting until it has used this much time. */
const HIGHLIGHT_SLOT_BUDGET_MS = 8;
/** Upper bound for how long a queued job waits for an idle slot. */
const HIGHLIGHT_IDLE_TIMEOUT_MS = 500;

export interface CodeHighlightJob {
  /** {@link createHighlightCacheKey} of the other fields. */
  readonly key: string;
  readonly code: string;
  readonly language: string;
  readonly themeName: DiffThemeName;
}

type HighlightListener = (html: string) => void;

interface PendingHighlightJob extends CodeHighlightJob {
  readonly listeners: Set<HighlightListener>;
  readonly elements: Set<Element>;
  readonly visibleElements: Set<Element>;
  /** Set for a requester without an observable element. */
  assumedVisible: boolean;
}

const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);
const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();
const readyHighlighters = new Map<string, DiffsHighlighter>();
const pendingJobs = new Map<string, PendingHighlightJob>();
const jobKeyByElement = new Map<Element, string>();
let visibilityObserver: IntersectionObserver | null | undefined;
let cancelScheduledDrain: (() => void) | null = null;
let queueGeneration = 0;

export function createHighlightCacheKey(
  code: string,
  language: string,
  themeName: DiffThemeName,
): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

/** Highlighted HTML that is already cached, without queueing anything. */
export function readHighlightedCode(key: string): string | null {
  return highlightedCodeCache.get(key);
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

function getHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = import("@pierre/diffs")
    .then(({ getSharedHighlighter }) =>
      getSharedHighlighter({
        themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
        langs: [language as SupportedLanguages],
        preferredHighlighter: "shiki-js",
      }),
    )
    .catch((error: unknown) => {
      highlighterPromiseCache.delete(language);
      if (language === "text") {
        // "text" itself failed: Shiki cannot initialize at all.
        throw error;
      }
      // Language not supported by Shiki: fall back to "text".
      return getHighlighterPromise("text");
    });
  highlighterPromiseCache.set(language, promise);
  return promise;
}

function ensureHighlighter(language: string): void {
  if (readyHighlighters.has(language)) return;
  const generation = queueGeneration;
  getHighlighterPromise(language).then(
    (highlighter) => {
      if (generation !== queueGeneration) return;
      readyHighlighters.set(language, highlighter);
      scheduleDrain();
    },
    () => {
      if (generation !== queueGeneration) return;
      // Shiki is unavailable: these blocks stay plain text.
      for (const job of pendingJobs.values()) {
        if (job.language === language) dropJob(job);
      }
    },
  );
}

function highlight(highlighter: DiffsHighlighter, job: CodeHighlightJob): string | null {
  try {
    return highlighter.codeToHtml(job.code, { lang: job.language, theme: job.themeName });
  } catch (error) {
    console.warn(
      `Code highlighting failed for language "${job.language}", falling back to plain text.`,
      error instanceof Error ? error.message : error,
    );
    try {
      return highlighter.codeToHtml(job.code, { lang: "text", theme: job.themeName });
    } catch {
      return null;
    }
  }
}

function readVisibilityObserver(): IntersectionObserver | null {
  if (visibilityObserver !== undefined) return visibilityObserver;
  visibilityObserver =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver((entries) => {
          let becameVisible = false;
          for (const entry of entries) {
            const key = jobKeyByElement.get(entry.target);
            const job = key === undefined ? undefined : pendingJobs.get(key);
            if (!job) continue;
            if (entry.isIntersecting) {
              job.visibleElements.add(entry.target);
              becameVisible = true;
            } else {
              job.visibleElements.delete(entry.target);
            }
          }
          if (becameVisible) scheduleDrain();
        });
  return visibilityObserver;
}

function unobserveElement(element: Element): void {
  jobKeyByElement.delete(element);
  visibilityObserver?.unobserve(element);
}

function dropJob(job: PendingHighlightJob): void {
  pendingJobs.delete(job.key);
  for (const element of job.elements) unobserveElement(element);
  job.elements.clear();
  job.visibleElements.clear();
}

function nextRunnableJob(): PendingHighlightJob | null {
  let fallback: PendingHighlightJob | null = null;
  for (const job of pendingJobs.values()) {
    if (!readyHighlighters.has(job.language)) continue;
    if (job.assumedVisible || job.visibleElements.size > 0) return job;
    fallback ??= job;
  }
  return fallback;
}

function drain(): void {
  cancelScheduledDrain = null;
  const startedAt = performance.now();
  for (;;) {
    const job = nextRunnableJob();
    if (!job) return;
    dropJob(job);
    const html = highlight(readyHighlighters.get(job.language)!, job);
    if (html !== null) {
      highlightedCodeCache.set(job.key, html, estimateHighlightedSize(html, job.code));
      for (const listener of job.listeners) listener(html);
    }
    if (performance.now() - startedAt >= HIGHLIGHT_SLOT_BUDGET_MS) break;
  }
  if (nextRunnableJob()) scheduleDrain();
}

function scheduleDrain(): void {
  if (cancelScheduledDrain !== null) return;
  cancelScheduledDrain = scheduleIdleTask(drain, HIGHLIGHT_IDLE_TIMEOUT_MS);
}

/**
 * Queues `job` and calls `onReady` with its HTML once an idle slot produced it
 * (synchronously when it is already cached). `element` is the block's plain
 * rendering; while it is on screen the job runs ahead of off-screen ones.
 * Returns a cancel function; a job nobody waits for any more is dropped.
 */
export function requestCodeHighlight(
  job: CodeHighlightJob,
  onReady: HighlightListener,
  element?: Element | null,
): () => void {
  const cached = highlightedCodeCache.get(job.key);
  if (cached !== null) {
    onReady(cached);
    return () => undefined;
  }

  let pending = pendingJobs.get(job.key);
  if (!pending) {
    pending = {
      ...job,
      listeners: new Set(),
      elements: new Set(),
      visibleElements: new Set(),
      assumedVisible: false,
    };
    pendingJobs.set(job.key, pending);
    ensureHighlighter(job.language);
  }
  const entry = pending;
  entry.listeners.add(onReady);
  const observer = element ? readVisibilityObserver() : null;
  if (element && observer) {
    jobKeyByElement.set(element, job.key);
    entry.elements.add(element);
    observer.observe(element);
  } else {
    // Without visibility information the block counts as on screen.
    entry.assumedVisible = true;
  }
  if (readyHighlighters.has(job.language)) scheduleDrain();

  return () => {
    if (element && entry.elements.delete(element)) {
      entry.visibleElements.delete(element);
      unobserveElement(element);
    }
    entry.listeners.delete(onReady);
    if (entry.listeners.size === 0 && pendingJobs.get(job.key) === entry) dropJob(entry);
  };
}

export function resetCodeHighlightQueueForTests(): void {
  queueGeneration += 1;
  cancelScheduledDrain?.();
  cancelScheduledDrain = null;
  for (const job of pendingJobs.values()) dropJob(job);
  pendingJobs.clear();
  jobKeyByElement.clear();
  visibilityObserver?.disconnect();
  visibilityObserver = undefined;
  readyHighlighters.clear();
  highlighterPromiseCache.clear();
  highlightedCodeCache.clear();
}
