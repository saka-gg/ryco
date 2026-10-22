import {
  buildFileReferenceBlock,
  extractTrailingFileReferences,
  type FileReference,
} from "./fileReference.ts";
import {
  buildTerminalContextBlock,
  type DisplayedUserMessageState,
  type ExtractedTerminalContexts,
  extractTrailingTerminalContexts,
  materializeInlineTerminalContextPrompt,
  type TerminalContextSelection,
} from "./terminalContext.ts";

/**
 * The one place a sent prompt's context blocks are written and read back. The
 * user's text comes first, then the `<file_context>` block, then the
 * `<terminal_context>` block, which stays last as it always has.
 */

const TERMINAL_CONTEXT_CLOSE_TAG = "</terminal_context>";
/** Terminal block lines are indented too, so this only matches a block's own tag. */
const TERMINAL_CONTEXT_OPEN_LINE_PATTERN = /(?:^|\n)<terminal_context>\n/gu;

export interface OutgoingPromptInput {
  readonly prompt: string;
  readonly fileReferences?: ReadonlyArray<FileReference> | undefined;
  readonly terminalContexts?: ReadonlyArray<TerminalContextSelection> | undefined;
}

/**
 * The text a prompt is sent as, in the ordinary text payload so every
 * provider, the queue and send retries see the same context. Inline terminal
 * placeholders are resolved in the user's own text only: a file excerpt keeps
 * a U+FFFC it contains.
 */
export function composeOutgoingPrompt(input: OutgoingPromptInput): string {
  const terminalContexts = input.terminalContexts ?? [];
  return [
    materializeInlineTerminalContextPrompt(input.prompt, terminalContexts).trim(),
    buildFileReferenceBlock(input.fileReferences ?? []),
    buildTerminalContextBlock(terminalContexts),
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
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
