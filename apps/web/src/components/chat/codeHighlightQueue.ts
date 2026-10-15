import type { DiffsHighlighter, ShikiTransformer, SupportedLanguages } from "@pierre/diffs";

import {
  fnv1a32,
  resolveDiffThemeName,
  SYNTAX_TOKENIZE_MAX_LINE_LENGTH,
  type DiffThemeName,
} from "../../lib/diffRendering";
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
 * on the first job, not with the chat route. A large block is highlighted a
 * slice of lines per step, carrying the grammar state across slices, so one
 * block is never one long task.
 */

const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;
/** An idle slot keeps highlighting until it has used this much time. */
const HIGHLIGHT_SLOT_BUDGET_MS = 8;
/** Upper bound for how long a queued job waits for an idle slot. */
const HIGHLIGHT_IDLE_TIMEOUT_MS = 500;
/**
 * Most lines and characters one highlight step tokenizes. Warm tokenization
 * costs about 10 ms per 100 TSX lines, so a step stays near the slot budget.
 */
const HIGHLIGHT_SLICE_MAX_LINES = 100;
const HIGHLIGHT_SLICE_MAX_CHARS = 16_000;
const CODE_OPEN_TAG = "<code>";
const CODE_CLOSE_TAG = "</code>";

export interface CodeHighlightJob {
  /** {@link createHighlightCacheKey} of the other fields. */
  readonly key: string;
  readonly code: string;
  readonly language: string;
  readonly themeName: DiffThemeName;
}

type HighlightListener = (html: string) => void;
type HighlightRoot = Parameters<NonNullable<ShikiTransformer["root"]>>[0];
type GrammarState = ReturnType<DiffsHighlighter["getLastGrammarState"]>;

/** A block highlighted in slices: what the slices produced so far. */
interface SlicedHighlight {
  readonly lines: ReadonlyArray<string>;
  /** Index of the first line the next slice highlights. */
  nextLine: number;
  grammarState: GrammarState | undefined;
  /** The `<pre ...><code>` of the first slice; every slice has the same one. */
  opening: string | null;
  closing: string | null;
  /** Each slice's lines, as Shiki renders them inside `<code>`. */
  readonly parts: string[];
}

interface PendingHighlightJob extends CodeHighlightJob {
  readonly listeners: Set<HighlightListener>;
  readonly elements: Set<Element>;
  readonly visibleElements: Set<Element>;
  /** Set for a requester without an observable element. */
  assumedVisible: boolean;
  /** Set once the block turned out too large for one step. */
  sliced: SlicedHighlight | null;
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

function highlightOptions(job: CodeHighlightJob, language: string) {
  return {
    lang: language,
    theme: job.themeName,
    tokenizeMaxLineLength: SYNTAX_TOKENIZE_MAX_LINE_LENGTH,
  };
}

function highlight(highlighter: DiffsHighlighter, job: CodeHighlightJob): string | null {
  try {
    return highlighter.codeToHtml(job.code, highlightOptions(job, job.language));
  } catch (error) {
    console.warn(
      `Code highlighting failed for language "${job.language}", falling back to plain text.`,
      error instanceof Error ? error.message : error,
    );
    try {
      return highlighter.codeToHtml(job.code, highlightOptions(job, "text"));
    } catch {
      return null;
    }
  }
}

/** The index after the last line of the slice that starts at `start`. */
function sliceEnd(lines: ReadonlyArray<string>, start: number): number {
  let end = start;
  let chars = 0;
  while (end < lines.length && end - start < HIGHLIGHT_SLICE_MAX_LINES) {
    chars += lines[end]!.length + 1;
    if (end > start && chars > HIGHLIGHT_SLICE_MAX_CHARS) break;
    end += 1;
  }
  return end;
}

/** Splits Shiki's `<pre ...><code>LINES</code></pre>` around its lines. */
function splitCodeElement(
  html: string,
): { readonly opening: string; readonly inner: string; readonly closing: string } | null {
  const open = html.indexOf(CODE_OPEN_TAG);
  const close = html.lastIndexOf(CODE_CLOSE_TAG);
  if (open < 0 || close < open) return null;
  const innerStart = open + CODE_OPEN_TAG.length;
  return {
    opening: html.slice(0, innerStart),
    inner: html.slice(innerStart, close),
    closing: html.slice(close),
  };
}

/**
 * Highlights the job's next slice. Returns the block's HTML once its last
 * slice is done, `undefined` while slices remain, and `null` on failure.
 */
function highlightStep(
  highlighter: DiffsHighlighter,
  job: PendingHighlightJob,
): string | null | undefined {
  if (job.sliced === null) {
    // Split on the same breaks Shiki does: a "\r" left at a slice end would
    // render as an extra line, and Shiki joins its output lines with "\n".
    const lines = job.code.split(/\r?\n/);
    if (sliceEnd(lines, 0) >= lines.length) return highlight(highlighter, job);
    job.sliced = {
      lines,
      nextLine: 0,
      grammarState: undefined,
      opening: null,
      closing: null,
      parts: [],
    };
  }
  const sliced = job.sliced;
  const end = sliceEnd(sliced.lines, sliced.nextLine);
  let root: HighlightRoot | undefined;
  let split: ReturnType<typeof splitCodeElement> = null;
  try {
    const html = highlighter.codeToHtml(sliced.lines.slice(sliced.nextLine, end).join("\n"), {
      ...highlightOptions(job, job.language),
      ...(sliced.grammarState !== undefined ? { grammarState: sliced.grammarState } : {}),
      transformers: [
        {
          root(node) {
            root = node;
          },
        },
      ],
    });
    split = splitCodeElement(html);
  } catch {
    // Fall through: the whole block takes the single-step path and its fallback.
  }
  if (split === null) {
    job.sliced = null;
    return highlight(highlighter, job);
  }
  sliced.opening ??= split.opening;
  sliced.closing = split.closing;
  sliced.parts.push(split.inner);
  // Shiki records the grammar state at the end of the slice on its root.
  sliced.grammarState = root === undefined ? undefined : highlighter.getLastGrammarState(root);
  sliced.nextLine = end;
  if (end < sliced.lines.length) return undefined;
  return `${sliced.opening}${sliced.parts.join("\n")}${sliced.closing}`;
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
    const html = highlightStep(readyHighlighters.get(job.language)!, job);
    if (html !== undefined) {
      dropJob(job);
      if (html !== null) {
        highlightedCodeCache.set(job.key, html, estimateHighlightedSize(html, job.code));
        for (const listener of job.listeners) listener(html);
      }
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
      sliced: null,
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
