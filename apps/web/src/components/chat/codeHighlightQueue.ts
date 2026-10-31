import type {
  DiffsHighlighter,
  DiffsStreamTokenizer,
  SupportedLanguages,
  ThemedToken,
  tokensToHtml,
  TokensResult,
} from "@pierre/diffs";

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
 * Loading a highlighter costs a long task (compiling the Highlights WASM
 * module, or Shiki's regexes for each grammar on its first tokenization, 50-80
 * ms per language with the JS engine), and a large block still costs one to
 * highlight. Doing that inside render put long tasks into the thread-open
 * commit and into every Suspense retry. Blocks now render as plain text, queue
 * a job here, and swap in the highlighted HTML once an idle slot has produced
 * it; blocks on screen go first. The highlighter itself is loaded on the first
 * job, not with the chat route. A large block is highlighted a slice of lines
 * per step through a stream tokenizer, which carries the lexer state across
 * slices, so one block is never one long task.
 */

const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;
/** An idle slot keeps highlighting until it has used this much time. */
const HIGHLIGHT_SLOT_BUDGET_MS = 8;
/** Upper bound for how long a queued job waits for an idle slot. */
const HIGHLIGHT_IDLE_TIMEOUT_MS = 500;
/**
 * Most lines and characters one highlight step tokenizes. Shiki's JS engine,
 * the fallback where WebAssembly cannot compile, costs about 10 ms per 100
 * warm TSX lines, so a step stays near the slot budget with either highlighter.
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

/** The shared main-thread highlighter and the renderer for tokens it produced. */
interface LoadedHighlighter {
  readonly highlighter: DiffsHighlighter;
  readonly tokensToHtml: typeof tokensToHtml;
}

/** A block highlighted in slices: what the slices produced so far. */
interface SlicedHighlight {
  readonly lines: ReadonlyArray<string>;
  /** Index of the first line the next slice highlights. */
  nextLine: number;
  /** Carries the lexer state from one slice into the next. */
  readonly tokenizer: DiffsStreamTokenizer;
  /** The block's colors, from tokenizing no code. */
  readonly shell: TokensResult;
  /** The `<pre ...><code>` of the first slice; every slice has the same one. */
  opening: string | null;
  closing: string | null;
  /** Each slice's lines, as `codeToHtml` renders them inside `<code>`. */
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
const highlighterPromiseCache = new Map<string, Promise<LoadedHighlighter>>();
const readyHighlighters = new Map<string, LoadedHighlighter>();
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

function getHighlighterPromise(language: string): Promise<LoadedHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  // The engine choice loads with the highlighter, off the chat route's graph.
  const promise = Promise.all([import("@pierre/diffs"), import("../../lib/syntaxHighlighterType")])
    .then(async ([{ getSharedHighlighter, tokensToHtml }, { getMainThreadSyntaxHighlighter }]) => ({
      highlighter: await getSharedHighlighter({
        themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
        langs: [language as SupportedLanguages],
        preferredHighlighter: getMainThreadSyntaxHighlighter(),
      }),
      tokensToHtml,
    }))
    .catch((error: unknown) => {
      highlighterPromiseCache.delete(language);
      if (language === "text") {
        // "text" itself failed: the highlighter cannot initialize at all.
        throw error;
      }
      // A language Shiki has no grammar for (Highlights renders those as
      // text itself): fall back to "text".
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
      // No highlighter: these blocks stay plain text.
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

/** ANSI escape sequences: CSI (colors, cursor), OSC (titles, links) and two-character escapes. */
const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-_])/gu;

/** `code` without its ANSI escape sequences. */
export function stripAnsiEscapes(code: string): string {
  return code.replace(ANSI_ESCAPE, "");
}

function highlight(highlighter: DiffsHighlighter, job: CodeHighlightJob): string | null {
  try {
    const html = highlighter.codeToHtml(job.code, highlightOptions(job, job.language));
    // Shiki colors ANSI; Highlights has no ANSI language and would show the raw escapes, so the
    // output keeps the text without them.
    return job.language === "ansi" && html.includes("\u001b")
      ? highlighter.codeToHtml(stripAnsiEscapes(job.code), highlightOptions(job, "text"))
      : html;
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

/** Splits `<pre ...><code>LINES</code></pre>` around its lines. */
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

/** The first `count` lines of a stream tokenizer's tokens, split at its `\n` tokens. */
function tokenLines(tokens: ReadonlyArray<ThemedToken>, count: number): ThemedToken[][] {
  const lines: ThemedToken[][] = [[]];
  for (const token of tokens) {
    if (token.content === "\n") lines.push([]);
    else lines.at(-1)!.push(token);
  }
  return lines.slice(0, count);
}

/**
 * Starts highlighting `job` in slices, or returns null when it must take one
 * step: it fits in one, a lone CR (which the tokenizer would take for a line
 * break) is left after splitting, or ANSI (whose escapes carry state from line
 * to line) needs the whole source.
 */
function startSlicedHighlight(
  highlighter: DiffsHighlighter,
  job: PendingHighlightJob,
): SlicedHighlight | null {
  // Split on the same breaks the highlighters do: a "\r" left at a slice end
  // would render as an extra line, and their output joins lines with "\n".
  const lines = job.code.split(/\r?\n/);
  if (sliceEnd(lines, 0) >= lines.length || job.language === "ansi") return null;
  if (lines.some((line) => line.includes("\r"))) return null;
  const options = highlightOptions(job, job.language);
  try {
    // Before the tokenizer, so a language the highlighter lacks throws into
    // the single-step path with nothing to dispose.
    const shell = highlighter.codeToTokens("", options);
    return {
      lines,
      nextLine: 0,
      tokenizer: highlighter.createStreamTokenizer(options),
      shell,
      opening: null,
      closing: null,
      parts: [],
    };
  } catch {
    return null;
  }
}

/** Tokenizes the next slice of `sliced` and renders it inside `<code>`. */
function highlightSlice(
  { highlighter, tokensToHtml }: LoadedHighlighter,
  job: PendingHighlightJob,
  sliced: SlicedHighlight,
  end: number,
): ReturnType<typeof splitCodeElement> {
  const last = end >= sliced.lines.length;
  const source = sliced.lines.slice(sliced.nextLine, end).join("\n");
  // Every slice but the last ends with its line break, so all its lines are
  // final and the tokenizer resumes from an empty line.
  const update = sliced.tokenizer.enqueue(last ? source : `${source}\n`);
  if (update instanceof Promise) {
    void update.catch(() => undefined);
    return null;
  }
  const tokens = last ? [...update.stable, ...sliced.tokenizer.close().stable] : update.stable;
  const html = tokensToHtml(
    source,
    { ...sliced.shell, tokens: tokenLines(tokens, end - sliced.nextLine) },
    highlightOptions(job, job.language),
    // What `codeToHtml` passes, so slices render exactly like one call.
    highlighter.name === "highlights",
  );
  return splitCodeElement(html);
}

/**
 * Highlights the job's next slice. Returns the block's HTML once its last
 * slice is done, `undefined` while slices remain, and `null` on failure.
 */
function highlightStep(
  loaded: LoadedHighlighter,
  job: PendingHighlightJob,
): string | null | undefined {
  if (job.sliced === null) {
    job.sliced = startSlicedHighlight(loaded.highlighter, job);
    if (job.sliced === null) return highlight(loaded.highlighter, job);
  }
  const sliced = job.sliced;
  const end = sliceEnd(sliced.lines, sliced.nextLine);
  let split: ReturnType<typeof splitCodeElement> = null;
  try {
    split = highlightSlice(loaded, job, sliced, end);
  } catch {
    // Fall through: the whole block takes the single-step path and its fallback.
  }
  if (split === null) {
    sliced.tokenizer.dispose();
    job.sliced = null;
    return highlight(loaded.highlighter, job);
  }
  sliced.opening ??= split.opening;
  sliced.closing = split.closing;
  sliced.parts.push(split.inner);
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
  job.sliced?.tokenizer.dispose();
  job.sliced = null;
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
