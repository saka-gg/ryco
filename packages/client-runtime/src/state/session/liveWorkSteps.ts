/**
 * What a working turn is doing now, read from its work log entries: each
 * step's status, which steps are still running, and the agent's latest
 * thought (Claude thinking, Codex reasoning summaries, ACP thoughts). Shared
 * by web's transcript chapters and the phone's gray latest-thought line above
 * the running tool. Pure and client-neutral: no wire data beyond the work log
 * every client already derives.
 */
import type { WorkLogEntry } from "./session-logic.ts";

export type WorkEntryStatus = "running" | "completed" | "failed";

type WorkEntryStatusInput = Pick<WorkLogEntry, "completed" | "exitCode" | "tone">;

/**
 * A row is failed when the activity reported an error tone or a non-zero exit,
 * completed once its lifecycle settled, and running until then.
 */
export function resolveWorkEntryStatus(entry: WorkEntryStatusInput): WorkEntryStatus {
  if (entry.tone === "error" || (entry.exitCode !== undefined && entry.exitCode !== 0)) {
    return "failed";
  }
  return entry.completed ? "completed" : "running";
}

/** Info/error rows that carry no tool lifecycle (runtime warnings, notices). */
export function isWorkNoticeEntry(entry: WorkLogEntry): boolean {
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

/**
 * A step of the agent's own work that has not settled: a tool call, command,
 * subagent or reasoning block still running. Notices happen in an instant and
 * approval rows belong to the approval card, so neither ever runs. Only a
 * working turn's steps can be live: a settled turn's unsettled step was cut off.
 */
export function isLiveWorkStep(entry: WorkLogEntry): boolean {
  return (
    resolveWorkEntryStatus(entry) === "running" &&
    entry.approvalLifecycle !== true &&
    !isWorkNoticeEntry(entry)
  );
}

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

/** Longest thought line; a longer first sentence ends in an ellipsis at a word. */
const THOUGHT_LINE_MAX_CHARS = 140;

/** Where a sentence may end: a line break, or terminal punctuation and any closing quotes after it. */
const SENTENCE_BOUNDARY = /\n|[.!?…]["'”’)\]]*/gu;

/** The whitespace after a boundary and the character that follows it ("" at the text's end). */
const AFTER_BOUNDARY = /\s+(\S?)/uy;

/** Abbreviations whose period ends no sentence ("Use e.g. GitHub's retry"). */
const NON_TERMINAL_ABBREVIATION = /(?:^|[^\p{L}])(?:e\.g|i\.e|cf|vs)\.$/iu;

/**
 * Where each sentence of `text` ends: the index after its punctuation, or a
 * line break's own index. Punctuation ends a sentence only before whitespace
 * and a word that does not carry on in lowercase, and never after an
 * abbreviation. A whole text also ends a sentence where it stops; a streaming
 * one does not, since its next words may still carry the sentence on.
 */
function sentenceEnds(text: string, whole: boolean): number[] {
  const ends: number[] = [];
  for (const match of text.matchAll(SENTENCE_BOUNDARY)) {
    const at = match.index;
    if (match[0] === "\n") {
      ends.push(at);
      continue;
    }
    const after = at + match[0].length;
    if (after === text.length) {
      if (whole) ends.push(after);
      continue;
    }
    AFTER_BOUNDARY.lastIndex = after;
    const following = AFTER_BOUNDARY.exec(text);
    // "ws.ts", "3.5": punctuation inside a word ends nothing.
    if (following === null) continue;
    const next = following[1] ?? "";
    if (/\p{Ll}/u.test(next)) continue;
    if (NON_TERMINAL_ABBREVIATION.test(text.slice(Math.max(0, at - 5), at + 1))) continue;
    ends.push(after);
  }
  if (whole && (ends.at(-1) ?? 0) < text.length) ends.push(text.length);
  return ends;
}

/** Peels the markdown a thought may carry so the line reads as plain prose. */
function plainThoughtText(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/`([^`\n]+)`/g, "$1");
}

function capThoughtLine(line: string): string {
  if (line.length <= THOUGHT_LINE_MAX_CHARS) return line;
  const cut = line.slice(0, THOUGHT_LINE_MAX_CHARS - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > THOUGHT_LINE_MAX_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The first whole sentence of a reasoning text, on one line. A streaming
 * block's text is unfinished: only sentences it already closed count, and one
 * it is still writing never shows. Its text may also be just the end of the
 * block, cut mid-sentence behind a leading "…": that fragment is skipped for
 * the first whole sentence after it. A streaming text without a whole
 * sentence yet has none (null), so the reader falls back to an earlier thought.
 */
export function firstThoughtSentence(
  text: string,
  options?: { readonly streaming?: boolean },
): string | null {
  const streaming = options?.streaming === true;
  const body = plainThoughtText(text).trim();
  const ends = sentenceEnds(body, !streaming);
  let first = 0;
  if (body.startsWith("…")) {
    // A whole text that only is that fragment still says it; a streaming one waits for more.
    if (ends.length > 1) first = 1;
    else if (streaming) return null;
  }
  let start = first === 0 ? 0 : ends[0]!;
  for (const end of ends.slice(first)) {
    const sentence = body.slice(start, end).replace(/\s+/g, " ").trim();
    if (sentence.length > 0) return capThoughtLine(sentence);
    start = end;
  }
  return null;
}

/** The agent's latest thought while it works, for a line above the step it is on. */
export interface LiveThought {
  /** One line: the provider's headline, else the first sentence of the newest reasoning. */
  readonly text: string;
  /** The reasoning entry the line reads. */
  readonly reasoningEntryId: string;
  /**
   * The newest still-running step after that reasoning (a tool call, command
   * or subagent), which the line sits above; null when none runs after it, so
   * the line closes the list.
   */
  readonly runningStepId: string | null;
}

function thoughtLineOf(entry: WorkLogEntry): string | null {
  const headline = reasoningEntryHeadline(entry);
  return headline === null
    ? firstThoughtSentence(reasoningEntryText(entry), { streaming: entry.completed !== true })
    : capThoughtLine(headline.replace(/\s+/g, " "));
}

/**
 * The latest thought among a working turn's steps, in their order: the newest
 * reasoning block that says anything whole (a block that just opened, or is
 * still writing its first sentence, has none yet, so the thought before it
 * still stands), and the running step it leads to. Null when the steps hold no
 * readable reasoning.
 */
export function deriveLiveThought(entries: ReadonlyArray<WorkLogEntry>): LiveThought | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (!isReasoningWorkEntry(entry)) continue;
    const text = thoughtLineOf(entry);
    if (text === null) continue;
    const runningStep = entries
      .slice(index + 1)
      .findLast((step) => !isReasoningWorkEntry(step) && isLiveWorkStep(step));
    return { text, reasoningEntryId: entry.id, runningStepId: runningStep?.id ?? null };
  }
  return null;
}
