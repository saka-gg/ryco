import {
  AGENT_CONTROL_MESSAGE_ID_PREFIX,
  AGENT_SENT_MESSAGE_ID_SUFFIX,
  DELEGATION_RESULT_MESSAGE_ID_PREFIX,
  GOAL_CONTINUATION_MESSAGE_ID_PREFIX,
  PULL_REQUEST_WATCH_WAKE_MESSAGE_PREFIX,
} from "@ryco/contracts/orchestration";

import {
  BROWSER_CONTEXT_CLOSE_TAG,
  BROWSER_CONTEXT_DESCRIPTION,
  type BrowserElementReference,
  buildBrowserElementEntryLines,
  createBrowserElementReference,
} from "./browserElementReference.ts";
import {
  createFileReference,
  FILE_CONTEXT_CLOSE_TAG,
  FILE_REFERENCE_TRUNCATION_MARKER,
  type FileReference,
  type FileReferenceSide,
} from "./fileReference.ts";
import {
  type DisplayedUserMessageState,
  type ExtractedTerminalContexts,
  extractTrailingTerminalContexts,
  removeInlineTerminalContextLabels,
} from "./terminalContext.ts";

/**
 * Where a sent prompt's context blocks are read back, the inverse of the send
 * engine's `composeOutgoingPrompt`: the user's text, then the
 * `<browser_context>` block, then the `<file_context>` block, then the
 * `<terminal_context>` block, which stays last as it always has. Apart from
 * the writer because only lazily loaded views read: a module the web shell
 * shares with them is split into a chunk of its own.
 */

const TERMINAL_CONTEXT_CLOSE_TAG = "</terminal_context>";
/** Terminal block lines are indented too, so this only matches a block's own tag. */
const TERMINAL_CONTEXT_OPEN_LINE_PATTERN = /(?:^|\n)<terminal_context>\n/gu;
const ENTRY_HEADER_PATTERN =
  /^- (.+) (?:line (\d+)|lines (\d+)-(\d+))(?: \((old|new) version\))?:$/u;
const COMMENT_LINE_PATTERN = /^ {2}comment:(?: (.*))?$/u;
const SNIPPET_LINE_PATTERN = /^ {2}(\d+) \|(?: (.*))?$/u;
const FILE_CONTEXT_OPEN_LINE_PATTERN = /(?:^|\n)<file_context>\n/gu;
const BROWSER_CONTEXT_OPEN_LINE_PATTERN = /(?:^|\n)<browser_context>\n/gu;
const BROWSER_ENTRY_HEADER_PATTERN = /^- .+:$/u;
const BROWSER_FIELD_LINE_PATTERN = /^ {2}([a-z]+): (.+)$/u;
const BROWSER_BOX_PATTERN = /^(\d+)x(\d+) at (-?\d+),(-?\d+)$/u;
/** An entry's field names, in the order the writer puts them (the note's lines follow). */
const BROWSER_FIELD_ORDER = ["url", "page", "selector", "tag", "role", "name", "text", "box"];

export interface ExtractedFileReferences {
  readonly promptText: string;
  readonly references: ReadonlyArray<FileReference>;
}

function parseEntry(lines: ReadonlyArray<string>): FileReference | null {
  const header = ENTRY_HEADER_PATTERN.exec(lines[0] ?? "");
  if (!header) return null;
  const path = header[1]!;
  const lineStart = Number(header[2] ?? header[3]);
  const lineEnd = Number(header[2] ?? header[4]);
  const side = header[5] as FileReferenceSide | undefined;
  if (lineEnd < lineStart) return null;
  const comment: string[] = [];
  const snippet: string[] = [];
  let truncated = false;
  for (const line of lines.slice(1)) {
    if (truncated) return null;
    const commentLine = snippet.length === 0 ? COMMENT_LINE_PATTERN.exec(line) : null;
    if (commentLine) {
      comment.push(commentLine[1] ?? "");
      continue;
    }
    const snippetLine = SNIPPET_LINE_PATTERN.exec(line);
    if (snippetLine) {
      if (Number(snippetLine[1]) !== lineStart + snippet.length) return null;
      snippet.push(snippetLine[2] ?? "");
      continue;
    }
    if (line === `  ${FILE_REFERENCE_TRUNCATION_MARKER}`) {
      truncated = true;
      continue;
    }
    return null;
  }
  if (snippet.length > lineEnd - lineStart + 1 || (snippet.length === 0 && !truncated)) {
    return null;
  }
  const reference = createFileReference({
    path,
    lineStart,
    lineEnd,
    side,
    lines: snippet,
    comment: comment.length > 0 ? comment.join("\n") : undefined,
  });
  // Only the canonical form round-trips: anything else was not written by us.
  if (!reference || reference.path !== path) return null;
  return truncated && !reference.truncated ? { ...reference, truncated } : reference;
}

/**
 * Reads a trailing `<file_context>` block back into references, so a sent or
 * restored prompt can show them as chips again. All or nothing: a block that
 * does not parse exactly (typed by hand, say) stays part of the text. A whole
 * sent prompt, terminal contexts included, is read by
 * `extractTrailingPromptContexts`.
 */
export function extractTrailingFileReferences(prompt: string): ExtractedFileReferences {
  const none = { promptText: prompt, references: [] };
  const text = prompt.replace(/\s+$/u, "");
  if (!text.endsWith(`\n${FILE_CONTEXT_CLOSE_TAG}`)) return none;
  // Entry lines are always indented, so the last opening tag at a line start
  // is the block's own.
  let open: { readonly index: number; readonly length: number } | null = null;
  for (const match of text.matchAll(FILE_CONTEXT_OPEN_LINE_PATTERN)) {
    open = { index: match.index, length: match[0].length };
  }
  if (!open) return none;
  const body = text.slice(
    open.index + open.length,
    text.length - FILE_CONTEXT_CLOSE_TAG.length - 1,
  );
  // Entries are separated by one blank line; no entry line is ever blank.
  const entries: string[][] = [[]];
  for (const line of body.split("\n")) {
    const current = entries.at(-1)!;
    if (line.length > 0) current.push(line);
    else if (current.length > 0) entries.push([]);
    else return none;
  }
  const references: FileReference[] = [];
  for (const entry of entries) {
    const reference = parseEntry(entry);
    if (!reference) return none;
    references.push(reference);
  }
  return {
    promptText: text.slice(0, open.index).replace(/\n+$/u, ""),
    references,
  };
}

export interface ExtractedBrowserElements {
  readonly promptText: string;
  readonly elements: ReadonlyArray<BrowserElementReference>;
}

/**
 * One entry of a `<browser_context>` block, or null. Only what the writer
 * would write for the element it names is accepted: the fields are read in
 * their fixed order, the element is rebuilt through the normalizer every pick
 * goes through, and its entry must come out line for line the same.
 */
function parseBrowserEntry(lines: ReadonlyArray<string>): BrowserElementReference | null {
  if (!BROWSER_ENTRY_HEADER_PATTERN.test(lines[0] ?? "")) return null;
  const fields = new Map<string, string>();
  const comment: string[] = [];
  let order = 0;
  for (const line of lines.slice(1)) {
    const commentLine = COMMENT_LINE_PATTERN.exec(line);
    if (commentLine) {
      comment.push(commentLine[1] ?? "");
      continue;
    }
    // Every field comes before the note, once, in order.
    if (comment.length > 0) return null;
    const field = BROWSER_FIELD_LINE_PATTERN.exec(line);
    const index = field ? BROWSER_FIELD_ORDER.indexOf(field[1]!, order) : -1;
    if (!field || index < 0) return null;
    order = index + 1;
    fields.set(field[1]!, field[2]!);
  }
  const box = fields.has("box") ? BROWSER_BOX_PATTERN.exec(fields.get("box")!) : null;
  if (fields.has("box") && !box) return null;
  const reference = createBrowserElementReference({
    url: fields.get("url") ?? "",
    pageTitle: fields.get("page") ?? "",
    selector: fields.get("selector") ?? "",
    tagName: fields.get("tag") ?? "",
    role: fields.get("role") ?? null,
    name: fields.get("name") ?? null,
    text: fields.get("text") ?? null,
    box: box
      ? { width: Number(box[1]), height: Number(box[2]), x: Number(box[3]), y: Number(box[4]) }
      : null,
    comment: comment.length > 0 ? comment.join("\n") : undefined,
  });
  // Only the canonical form round-trips: anything else was not written by us.
  if (!reference) return null;
  const written = buildBrowserElementEntryLines(reference);
  return written.length === lines.length && written.every((line, index) => line === lines[index])
    ? reference
    : null;
}

/**
 * Reads a trailing `<browser_context>` block back into page elements, so a
 * sent prompt can show them as chips again. All or nothing, like
 * `extractTrailingFileReferences`: the block must open with the exact
 * description line and a blank line, and every entry must be exactly what the
 * writer makes of the element it names. Anything else (typed by hand, or page
 * text dressed up as a block) stays part of the text.
 */
export function extractTrailingBrowserElements(prompt: string): ExtractedBrowserElements {
  const none = { promptText: prompt, elements: [] };
  // `trimEnd` drops what `\s` matches, from the end only: most messages carry no block.
  const text = prompt.trimEnd();
  if (!text.endsWith(`\n${BROWSER_CONTEXT_CLOSE_TAG}`)) return none;
  // Entry lines are always indented or start with "- ", so the last opening
  // tag at a line start is the block's own.
  let open: { readonly index: number; readonly length: number } | null = null;
  for (const match of text.matchAll(BROWSER_CONTEXT_OPEN_LINE_PATTERN)) {
    open = { index: match.index, length: match[0].length };
  }
  if (!open) return none;
  const body = text
    .slice(open.index + open.length, text.length - BROWSER_CONTEXT_CLOSE_TAG.length - 1)
    .split("\n");
  if (body[0] !== BROWSER_CONTEXT_DESCRIPTION || body[1] !== "" || body.length < 3) return none;
  // Entries are separated by one blank line; no entry line is ever blank.
  const entries: string[][] = [[]];
  for (const line of body.slice(2)) {
    const current = entries.at(-1)!;
    if (line.length > 0) current.push(line);
    else if (current.length > 0) entries.push([]);
    else return none;
  }
  const elements: BrowserElementReference[] = [];
  for (const entry of entries) {
    const element = parseBrowserEntry(entry);
    if (!element) return none;
    elements.push(element);
  }
  return {
    promptText: text.slice(0, open.index).replace(/\n+$/u, ""),
    elements,
  };
}

export interface ExtractedPromptContexts extends ExtractedTerminalContexts {
  readonly fileReferences: ReadonlyArray<FileReference>;
  readonly browserElements: ReadonlyArray<BrowserElementReference>;
}

/**
 * The trailing terminal block, found from the last `<terminal_context>` that
 * starts a line. A tag inside an indented file excerpt, or anywhere but a line
 * start, never opens it.
 */
function extractAnchoredTerminalContexts(prompt: string): ExtractedTerminalContexts {
  const none: ExtractedTerminalContexts = {
    promptText: prompt,
    contextCount: 0,
    previewTitle: null,
    contexts: [],
  };
  const text = prompt.replace(/\s+$/u, "");
  if (!text.endsWith(`\n${TERMINAL_CONTEXT_CLOSE_TAG}`)) return none;
  let open = -1;
  for (const match of text.matchAll(TERMINAL_CONTEXT_OPEN_LINE_PATTERN)) open = match.index;
  if (open < 0) return none;
  // The block alone, so the terminal parser cannot start any earlier.
  const extracted = extractTrailingTerminalContexts(text.slice(open));
  if (extracted.promptText.length > 0) return none;
  return { ...extracted, promptText: text.slice(0, open).replace(/\n+$/u, "") };
}

/**
 * Reads a sent prompt back into its text, picked page elements, file
 * references and terminal contexts: the inverse of `composeOutgoingPrompt`,
 * from the last block back. Blocks that do not parse stay part of the text.
 */
export function extractTrailingPromptContexts(prompt: string): ExtractedPromptContexts {
  const terminal = extractAnchoredTerminalContexts(prompt);
  const files = extractTrailingFileReferences(terminal.promptText);
  const browser = extractTrailingBrowserElements(files.promptText);
  return {
    ...terminal,
    promptText: browser.promptText,
    fileReferences: files.references,
    browserElements: browser.elements,
  };
}

/**
 * The prompt a send started from, without what the send added: its context
 * blocks and the inline labels that stood for its terminal contexts.
 */
export function stripSentPromptContexts(prompt: string): string {
  const extracted = extractTrailingPromptContexts(prompt);
  return removeInlineTerminalContextLabels(extracted.promptText, extracted.contexts);
}

export interface DisplayedUserMessageContext extends DisplayedUserMessageState {
  readonly fileReferences: ReadonlyArray<FileReference>;
  readonly browserElements: ReadonlyArray<BrowserElementReference>;
}

/**
 * What every surface shows, searches and restores of a sent user message: its
 * own text without the context blocks, plus the contexts. Web and mobile read
 * it here so the timeline, search and copy all agree.
 */
export function deriveDisplayedUserMessageContext(prompt: string): DisplayedUserMessageContext {
  const extracted = extractTrailingPromptContexts(prompt);
  return {
    visibleText: extracted.promptText,
    copyText: prompt,
    contextCount: extracted.contextCount,
    previewTitle: extracted.previewTitle,
    contexts: extracted.contexts,
    fileReferences: extracted.fileReferences,
    browserElements: extracted.browserElements,
  };
}

/** A user-role message no person typed, shown folded to one line until it is opened. */
export interface AgentMessageFold {
  readonly kind: "delegation-result" | "agent-message" | "goal-continuation" | "pull-request";
  /**
   * "Results from 2 delegated tasks" · "Message from another agent" · "Goal continuation" ·
   * "Pull request update" or "Auto-fix CI".
   */
  readonly label: string;
  /** "2 completed, 1 interrupted" · the message's first line · a fixed line · "#12". */
  readonly summary: string;
}

const FOLD_SUMMARY_MAX_CHARS = 120;
const DELEGATION_TASK_COUNT = /^(\d+) task\(s\) you delegated/m;
const DELEGATION_SECTION_STATE =
  /^Delegated (?:initial-run result|result|task notice) \(([a-z-]+)[,)]/gm;
/** `renderPullRequestAutoFixPrompt`'s first line (`@ryco/shared/pullRequestWatch`). */
const AUTO_FIX_ATTEMPT = /^Auto-fix CI\b.*? PR #(\d+) at [0-9a-f]+, (attempt \d+ of \d+)/;
/** The pull request a watch's update or notice names first (`pull request #12`). */
const PULL_REQUEST_NUMBER = /\bpull request #(\d+)/i;

function firstLine(text: string): string {
  const line =
    text
      .split("\n")
      .find((candidate) => candidate.trim().length > 0)
      ?.trim() ?? "";
  return line.length > FOLD_SUMMARY_MAX_CHARS
    ? `${line.slice(0, FOLD_SUMMARY_MAX_CHARS - 1)}…`
    : line;
}

/**
 * How a server-written user-role message folds, from its id (the server mints those ids
 * and refuses them from clients): a delegated task's result waking its parent, another
 * agent's message to this thread, the next turn toward the thread's goal, or a pull request
 * watch's update. Null for a message a person typed.
 */
export function agentMessageFoldOf(message: {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
}): AgentMessageFold | null {
  const id = message.id;
  if (message.role !== "user" || id === undefined) return null;
  if (id.startsWith(DELEGATION_RESULT_MESSAGE_ID_PREFIX)) {
    const count = Number(DELEGATION_TASK_COUNT.exec(message.text)?.[1] ?? 1);
    const states = new Map<string, number>();
    for (const match of message.text.matchAll(DELEGATION_SECTION_STATE)) {
      const state = match[1]!;
      states.set(state, (states.get(state) ?? 0) + 1);
    }
    return {
      kind: "delegation-result",
      label: count === 1 ? "Result from a delegated task" : `Results from ${count} delegated tasks`,
      summary: [...states].map(([state, n]) => `${n} ${state}`).join(", "),
    };
  }
  if (id.startsWith(AGENT_CONTROL_MESSAGE_ID_PREFIX) && id.endsWith(AGENT_SENT_MESSAGE_ID_SUFFIX)) {
    return {
      kind: "agent-message",
      label: "Message from another agent",
      summary: firstLine(message.text),
    };
  }
  if (id.startsWith(GOAL_CONTINUATION_MESSAGE_ID_PREFIX)) {
    return {
      kind: "goal-continuation",
      label: "Goal continuation",
      summary: "Ryco started the next turn toward the goal",
    };
  }
  if (id.startsWith(PULL_REQUEST_WATCH_WAKE_MESSAGE_PREFIX)) {
    const autoFix = AUTO_FIX_ATTEMPT.exec(message.text);
    if (autoFix !== null) {
      return {
        kind: "pull-request",
        label: "Auto-fix CI",
        summary: `#${autoFix[1]}: checks failed, ${autoFix[2]}`,
      };
    }
    const number = PULL_REQUEST_NUMBER.exec(message.text)?.[1];
    return {
      kind: "pull-request",
      label: "Pull request update",
      summary: number === undefined ? "" : `#${number}`,
    };
  }
  return null;
}
