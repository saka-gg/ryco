// FILE: workChapters.logic.ts
// Purpose: Presentation model for the transcript's "chapters" view of a turn:
//          every commentary paragraph the agent writes opens a chapter, and the
//          tool calls and reasoning that follow it are that chapter's steps.
//          Finished chapters fold to one line (title, per-kind tallies,
//          duration); the live chapter shows its paragraph and a short ticker.
// Layer: Web chat presentation helpers
// Exports: step classification/labels, tallies, ticker windowing, titles, and
//          the shared work-entry label helpers the row renderers use.

import { formatDuration, type WorkLogEntry } from "../../session-logic";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { basenameOfPath, deriveReadableCommandDisplay } from "../../lib/toolCallLabel";
import { classifyToolCallSummaryCategory } from "./toolCallGroup.logic";
import { resolveWorkEntryStatus, type WorkEntryStatus } from "./workEntryActivity";

/** Rows the live chapter keeps on screen; older steps scroll out the top. */
export const CHAPTER_TICKER_WINDOW = 3;

export type ChapterStepKind =
  | "think"
  | "read"
  | "search"
  | "edit"
  | "run"
  | "web"
  | "agent"
  | "tool"
  /** A runtime notice (warning, info) — not a tool call, never "running". */
  | "note";

/** Tally order in a chapter's footer / folded line. */
export const CHAPTER_TALLY_KINDS = [
  "read",
  "search",
  "edit",
  "run",
  "web",
  "agent",
  "tool",
] as const;
export type ChapterTallyKind = (typeof CHAPTER_TALLY_KINDS)[number];

export type ChapterStepMeta =
  | { readonly type: "diff"; readonly additions: number; readonly deletions: number }
  | { readonly type: "text"; readonly text: string; readonly failed: boolean }
  /** Live elapsed counter, ticking from `startedAt`. */
  | { readonly type: "live"; readonly startedAt: string };

export interface ChapterStepDisplay {
  readonly kind: ChapterStepKind;
  readonly status: WorkEntryStatus;
  /** Tense follows status: "Reading" while running, "Read" once settled. */
  readonly verb: string;
  readonly target: string | null;
  /** Paths and commands render in the mono face. */
  readonly targetIsCode: boolean;
  readonly meta: ChapterStepMeta | null;
}

export interface ChapterTallies {
  readonly counts: Readonly<Record<ChapterTallyKind, number>>;
  readonly failed: number;
  readonly additions: number;
  readonly deletions: number;
  readonly hasDiff: boolean;
}

// ---------------------------------------------------------------------------
// Shared work-entry label helpers (also used by the expandable tool rows).
// ---------------------------------------------------------------------------

/**
 * Pulls a file path out of a detail string that may be a JSON argument blob,
 * so a `Read {"file_path":"/a/b.ts"}` row can show just `b.ts`.
 */
export function extractFilePathFromDetail(detail: string): string | null {
  const plainPathMatch = /^(.+?\.[A-Za-z0-9][A-Za-z0-9._-]*)(?::\d+)?(?::\d+)?$/u.exec(
    detail.trim(),
  );
  if (plainPathMatch?.[1]?.includes("/")) {
    return plainPathMatch[1].trim();
  }
  const jsonMatch = /"(?:file_path|filePath|path|filename)"\s*:\s*"([^"]+)"/u.exec(detail);
  return jsonMatch?.[1]?.trim() ?? null;
}

export function workEntryRawCommand(
  workEntry: Pick<WorkLogEntry, "command" | "rawCommand">,
): string | null {
  return workEntry.rawCommand?.trim() || workEntry.command?.trim() || null;
}

/**
 * Provider read tools (e.g. Claude's `Read`) arrive as generic dynamic tool
 * calls without a `file-read` requestKind, so the tool name decides.
 */
/**
 * The provider tool's own name. Claude's tools arrive as generic dynamic tool
 * calls whose detail reads `Read: {"file_path": …}`, so fall back to that
 * prefix when the title is the generic one.
 */
function providerToolName(workEntry: Pick<WorkLogEntry, "toolTitle" | "detail">): string {
  const title = (workEntry.toolTitle ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (title.length > 0 && title !== "toolcall" && title !== "tool") {
    return title;
  }
  const prefix = /^([A-Za-z][\w-]*):\s*[{[]/u.exec(workEntry.detail?.trim() ?? "")?.[1];
  return (prefix ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

export function isFileReadToolEntry(
  workEntry: Pick<WorkLogEntry, "toolTitle" | "detail">,
): boolean {
  const name = providerToolName(workEntry);
  return name === "read" || name === "readfile" || name === "viewfile";
}

function isSearchToolEntry(workEntry: Pick<WorkLogEntry, "toolTitle" | "detail">): boolean {
  const name = providerToolName(workEntry);
  return name === "grep" || name === "glob" || name === "search" || name === "find";
}

function isWebFetchToolEntry(workEntry: Pick<WorkLogEntry, "toolTitle" | "detail">): boolean {
  const name = providerToolName(workEntry);
  return name === "webfetch" || name === "fetch" || name === "websearch";
}

/**
 * The short trailing phrase after a row's verb: the humanized command target,
 * a filename, or a clean detail line. Null when the heading already says it.
 */
export function workEntryPreview(
  workEntry: Pick<
    WorkLogEntry,
    "detail" | "command" | "rawCommand" | "changedFiles" | "requestKind" | "itemType"
  >,
  workspaceRoot: string | undefined,
): string | null {
  const command = workEntry.command ?? workEntry.rawCommand;
  if (command) {
    return deriveReadableCommandDisplay(command).target;
  }

  if ((workEntry.changedFiles?.length ?? 0) > 0) {
    const changedFiles = workEntry.changedFiles!;
    const [firstPath] = changedFiles;
    if (firstPath) {
      return changedFiles.length === 1
        ? basenameOfPath(formatWorkspaceRelativePath(firstPath, workspaceRoot))
        : `${changedFiles.length} files`;
    }
  }

  const detail = workEntry.detail?.trim();
  if (!detail) {
    return null;
  }

  const filePath = extractFilePathFromDetail(detail);
  if (filePath) {
    return basenameOfPath(filePath);
  }

  const isFileRelated =
    workEntry.requestKind === "file-read" ||
    workEntry.requestKind === "file-change" ||
    workEntry.itemType === "file_change";
  // For file rows the heading alone is enough — never surface raw arguments.
  if (isFileRelated) {
    return null;
  }
  if (detail.startsWith("{") || detail.startsWith("[")) {
    return null;
  }
  return detail;
}

// ---------------------------------------------------------------------------
// Reasoning
// ---------------------------------------------------------------------------

/** A projected reasoning block (Claude thinking, Codex reasoning summary, ACP thoughts). */
export function isReasoningWorkEntry(entry: Pick<WorkLogEntry, "itemType" | "tone">): boolean {
  return entry.itemType === "reasoning";
}

export function reasoningEntryText(entry: Pick<WorkLogEntry, "output">): string {
  return (entry.output ?? "").trim();
}

/** Provider headline for the block (Codex summary titles), when one was sent. */
export function reasoningEntryHeadline(entry: Pick<WorkLogEntry, "detail">): string | null {
  return entry.detail?.trim() || null;
}

/** Last few words of streaming reasoning, for the one-line live preview. */
export function reasoningTail(text: string, maxChars = 72): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  const slice = compact.slice(compact.length - maxChars);
  const firstSpace = slice.indexOf(" ");
  return `…${firstSpace > 0 ? slice.slice(firstSpace + 1) : slice}`;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export function entryElapsedMs(
  entry: Pick<WorkLogEntry, "startedAt" | "lastActivityAt" | "createdAt">,
): number | null {
  const start = Date.parse(entry.startedAt ?? entry.createdAt);
  const end = Date.parse(entry.lastActivityAt ?? entry.createdAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return end - start;
}

/** Info/error rows that carry no tool lifecycle (runtime warnings, notices). */
function isNoticeEntry(entry: WorkLogEntry): boolean {
  return (
    (entry.tone === "info" || entry.tone === "error") &&
    entry.itemType === undefined &&
    entry.requestKind === undefined &&
    !entry.command &&
    !entry.rawCommand &&
    !entry.toolTitle &&
    !entry.taskId &&
    (entry.changedFiles?.length ?? 0) === 0
  );
}

export function classifyChapterStep(entry: WorkLogEntry): ChapterStepKind {
  if (isReasoningWorkEntry(entry)) return "think";
  if (isNoticeEntry(entry)) return "note";
  if (entry.itemType === "web_search" || isWebFetchToolEntry(entry)) return "web";
  if (isFileReadToolEntry(entry)) return "read";
  if (isSearchToolEntry(entry)) return "search";
  if (entry.taskId) return "agent";
  switch (classifyToolCallSummaryCategory(entry)) {
    case "command":
      return "run";
    case "edit":
      return "edit";
    case "read":
      return "read";
    case "search":
      return "search";
    case "agent":
      return "agent";
    case "tool":
    case "other":
      return "tool";
  }
}

/** Last two path segments ("relay/client.ts"); the row's tooltip has the rest. */
function compactPath(path: string): string {
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return segments.slice(-2).join("/") || path;
}

function capitalize(value: string): string {
  const trimmed = value.trim();
  return trimmed.length === 0 ? value : `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function sumChangedFileStats(entry: WorkLogEntry): { additions: number; deletions: number } | null {
  const stats = entry.changedFileStats;
  if (
    !stats?.some((file) => typeof file.additions === "number" || typeof file.deletions === "number")
  ) {
    return null;
  }
  return stats.reduce(
    (total, file) => ({
      additions: total.additions + (file.additions ?? 0),
      deletions: total.deletions + (file.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  );
}

function settledMeta(entry: WorkLogEntry, kind: ChapterStepKind, status: WorkEntryStatus) {
  if (status === "failed") {
    const text =
      entry.exitCode !== undefined && entry.exitCode !== 0 ? `exit ${entry.exitCode}` : "failed";
    return { type: "text", text, failed: true } as const;
  }
  if (kind === "edit") {
    const diff = sumChangedFileStats(entry);
    return diff ? ({ type: "diff", ...diff } as const) : null;
  }
  if (kind === "run" || kind === "agent" || kind === "web") {
    const elapsed = entry.startedAt ? entryElapsedMs(entry) : null;
    return elapsed !== null && elapsed >= 1000
      ? ({ type: "text", text: formatDuration(elapsed), failed: false } as const)
      : null;
  }
  return null;
}

/** Verb, target and trailing meta for one step row. */
export function deriveChapterStepDisplay(
  entry: WorkLogEntry,
  workspaceRoot: string | undefined,
): ChapterStepDisplay {
  const kind = classifyChapterStep(entry);
  if (kind === "note") {
    // Notices happen in an instant: no spinner, no tense change.
    const detail = entry.detail?.trim();
    return {
      kind,
      status: entry.tone === "error" ? "failed" : "completed",
      verb: entry.label,
      target: detail && !detail.startsWith("{") ? detail : null,
      targetIsCode: false,
      meta: null,
    };
  }
  const status = resolveWorkEntryStatus(entry);
  const running = status === "running";
  const liveMeta =
    running && entry.startedAt && kind !== "read" && kind !== "search" && kind !== "edit"
      ? ({ type: "live", startedAt: entry.startedAt } as const)
      : null;
  const meta = running ? liveMeta : settledMeta(entry, kind, status);

  if (kind === "think") {
    const elapsed = entryElapsedMs(entry);
    const headline = reasoningEntryHeadline(entry);
    return {
      kind,
      status,
      verb: running
        ? "Thinking"
        : elapsed !== null && elapsed >= 1000
          ? `Thought for ${formatDuration(elapsed)}`
          : "Thought",
      // A headline names the thought; otherwise the live row shows the newest words.
      target: headline ?? (running ? reasoningTail(reasoningEntryText(entry)) || null : null),
      targetIsCode: false,
      meta,
    };
  }

  // The normalized command reads cleanly; the raw one may still carry a
  // `/bin/zsh -lc "…"` wrapper.
  const command = entry.command?.trim() || workEntryRawCommand(entry);
  if (command && (kind === "run" || kind === "read" || kind === "search")) {
    const readable = deriveReadableCommandDisplay(command, running);
    return { kind, status, verb: readable.verb, target: readable.target, targetIsCode: true, meta };
  }

  if (kind === "edit") {
    const files = entry.changedFiles ?? [];
    const [first] = files;
    const target =
      files.length > 1
        ? `${files.length} files`
        : first
          ? compactPath(formatWorkspaceRelativePath(first, workspaceRoot))
          : workEntryPreview(entry, workspaceRoot);
    return {
      kind,
      status,
      verb: running ? "Editing" : "Edited",
      target,
      targetIsCode: files.length === 1,
      meta,
    };
  }

  const preview = workEntryPreview(entry, workspaceRoot);
  switch (kind) {
    case "read":
      return {
        kind,
        status,
        verb: running ? "Reading" : "Read",
        target: preview,
        targetIsCode: true,
        meta,
      };
    case "search":
      return {
        kind,
        status,
        verb: running ? "Searching" : "Searched",
        target: preview,
        targetIsCode: false,
        meta,
      };
    case "web":
      return {
        kind,
        status,
        verb:
          entry.itemType === "web_search" || /search/i.test(entry.toolTitle ?? "")
            ? running
              ? "Searching the web"
              : "Searched the web"
            : running
              ? "Fetching"
              : "Fetched",
        target: preview,
        targetIsCode: false,
        meta,
      };
    case "agent":
      return {
        kind,
        status,
        verb: running ? "Delegating" : "Delegated",
        target: entry.agentRole ?? preview ?? entry.label,
        targetIsCode: false,
        meta,
      };
    case "run":
      return {
        kind,
        status,
        verb: running ? "Running" : "Ran",
        target: preview,
        targetIsCode: true,
        meta,
      };
    default: {
      const heading = capitalize(
        (entry.toolTitle ?? entry.label).replace(/\s+(?:complete|completed)\s*$/i, ""),
      );
      return {
        kind,
        status,
        verb: heading,
        target: preview && preview.toLowerCase() !== heading.toLowerCase() ? preview : null,
        targetIsCode: false,
        meta,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

export function deriveChapterTallies(entries: ReadonlyArray<WorkLogEntry>): ChapterTallies {
  const counts: Record<ChapterTallyKind, number> = {
    read: 0,
    search: 0,
    edit: 0,
    run: 0,
    web: 0,
    agent: 0,
    tool: 0,
  };
  let failed = 0;
  let additions = 0;
  let deletions = 0;
  let hasDiff = false;
  for (const entry of entries) {
    const kind = classifyChapterStep(entry);
    if (kind === "think" || kind === "note") continue;
    counts[kind] += 1;
    if (resolveWorkEntryStatus(entry) === "failed") failed += 1;
    // An edit still streaming may report partial stats; tally settled ones only.
    if (kind === "edit" && resolveWorkEntryStatus(entry) !== "running") {
      const diff = sumChangedFileStats(entry);
      if (diff) {
        hasDiff = true;
        additions += diff.additions;
        deletions += diff.deletions;
      }
    }
  }
  return { counts, failed, additions, deletions, hasDiff };
}

const TALLY_NOUNS: Record<ChapterTallyKind, readonly [string, string]> = {
  read: ["file read", "files read"],
  search: ["search", "searches"],
  edit: ["edit", "edits"],
  run: ["command", "commands"],
  web: ["web lookup", "web lookups"],
  agent: ["subagent", "subagents"],
  tool: ["tool call", "tool calls"],
};

export function describeTally(kind: ChapterTallyKind, count: number): string {
  const [one, many] = TALLY_NOUNS[kind];
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * One-line title for a folded chapter: the paragraph's first block of prose
 * with markdown syntax peeled off (inline code keeps its backticks so the row
 * can still set it in mono).
 */
export function chapterTitleFromMessage(text: string): string {
  const firstBlock =
    text
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .find((block) => block.length > 0 && !block.startsWith("```")) ?? "";
  return firstBlock
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Title for a chapter the agent opened without writing anything first. */
export function chapterFallbackTitle(
  entries: ReadonlyArray<WorkLogEntry>,
  tallies: ChapterTallies,
): string {
  const parts = CHAPTER_TALLY_KINDS.filter((kind) => tallies.counts[kind] > 0).map((kind) => {
    const count = tallies.counts[kind];
    switch (kind) {
      case "read":
        return `Read ${count} ${count === 1 ? "file" : "files"}`;
      case "search":
        return `Searched ${count} ${count === 1 ? "time" : "times"}`;
      case "edit":
        return `Edited ${count} ${count === 1 ? "file" : "files"}`;
      case "run":
        return `Ran ${count} ${count === 1 ? "command" : "commands"}`;
      default:
        return capitalize(describeTally(kind, count));
    }
  });
  if (parts.length > 0) {
    return parts.join(", ");
  }
  const thinking = entries.filter(isReasoningWorkEntry);
  // Name the thought when the provider titled it (Codex summaries do).
  const headline = thinking
    .map(reasoningEntryHeadline)
    .findLast((value): value is string => value !== null);
  if (headline) {
    return headline;
  }
  const stillThinking = thinking.some((entry) => !entry.completed);
  if (stillThinking) {
    return "Thinking";
  }
  const total = thinking.reduce((sum, entry) => sum + (entryElapsedMs(entry) ?? 0), 0);
  return total >= 1000 ? `Thought for ${formatDuration(total)}` : "Thought";
}

/** Splits a live chapter's steps into the ticker window and the scrolled-out count. */
export function selectTickerEntries<T>(
  entries: ReadonlyArray<T>,
  window = CHAPTER_TICKER_WINDOW,
): { readonly hiddenCount: number; readonly visible: ReadonlyArray<T> } {
  if (entries.length <= window) {
    return { hiddenCount: 0, visible: entries };
  }
  return { hiddenCount: entries.length - window, visible: entries.slice(-window) };
}

export function formatChapterDuration(startIso: string, endIso: string | null): string | null {
  if (!endIso) return null;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return formatDuration(end - start);
}
