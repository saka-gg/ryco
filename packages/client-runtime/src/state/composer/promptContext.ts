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
 * engine's `composeOutgoingPrompt`: the user's text, then the `<file_context>`
 * block, then the `<terminal_context>` block, which stays last as it always
 * has. Apart from the writer because only lazily loaded views read: a module
 * the web shell shares with them is split into a chunk of its own.
 */

const TERMINAL_CONTEXT_CLOSE_TAG = "</terminal_context>";
/** Terminal block lines are indented too, so this only matches a block's own tag. */
const TERMINAL_CONTEXT_OPEN_LINE_PATTERN = /(?:^|\n)<terminal_context>\n/gu;
const ENTRY_HEADER_PATTERN =
  /^- (.+) (?:line (\d+)|lines (\d+)-(\d+))(?: \((old|new) version\))?:$/u;
const COMMENT_LINE_PATTERN = /^ {2}comment:(?: (.*))?$/u;
const SNIPPET_LINE_PATTERN = /^ {2}(\d+) \|(?: (.*))?$/u;
const FILE_CONTEXT_OPEN_LINE_PATTERN = /(?:^|\n)<file_context>\n/gu;

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

export interface ExtractedPromptContexts extends ExtractedTerminalContexts {
  readonly fileReferences: ReadonlyArray<FileReference>;
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
 * Reads a sent prompt back into its text, file references and terminal
 * contexts: the inverse of `composeOutgoingPrompt`. Blocks that do not parse
 * stay part of the text.
 */
export function extractTrailingPromptContexts(prompt: string): ExtractedPromptContexts {
  const terminal = extractAnchoredTerminalContexts(prompt);
  const files = extractTrailingFileReferences(terminal.promptText);
  return { ...terminal, promptText: files.promptText, fileReferences: files.references };
}

/**
 * The prompt a send started from, without what the send added: both context
 * blocks and the inline labels that stood for its terminal contexts.
 */
export function stripSentPromptContexts(prompt: string): string {
  const extracted = extractTrailingPromptContexts(prompt);
  return removeInlineTerminalContextLabels(extracted.promptText, extracted.contexts);
}

export interface DisplayedUserMessageContext extends DisplayedUserMessageState {
  readonly fileReferences: ReadonlyArray<FileReference>;
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
  };
}
