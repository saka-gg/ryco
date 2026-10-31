export const MAX_TERMINAL_SNIPPET_BYTES = 48 * 1024;

/** The markers a program that turned on bracketed paste mode (DECSET 2004) reads around a paste. */
export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";

export function isTerminalSnippetLanguage(language: string): boolean {
  return /^(shell|bash|sh|zsh)$/i.test(language);
}

/** Reject bytes that can escape bracketed paste or act as terminal controls. */
export function terminalSnippetError(source: string): string | null {
  if (!source.trim()) return "The shell snippet is empty.";
  if (
    source.length > MAX_TERMINAL_SNIPPET_BYTES ||
    new TextEncoder().encode(source).length > MAX_TERMINAL_SNIPPET_BYTES
  )
    return "The shell snippet exceeds the 48 KiB insertion limit.";
  // Terminal controls, especially ESC, must never escape the paste envelope.
  // oxlint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(source) || /[\uD800-\uDFFF]/u.test(source))
    return "The shell snippet contains unsupported terminal control characters.";
  return null;
}

/** No normalization, trimming, or Enter appended outside the paste envelope. */
export function bracketedTerminalSnippet(source: string): string {
  const error = terminalSnippetError(source);
  if (error) throw new Error(error);
  return `${BRACKETED_PASTE_START}${source}${BRACKETED_PASTE_END}`;
}

/**
 * Clipboard text as a terminal sends a paste, the way xterm.js does: line breaks
 * become the carriage return Enter sends. While the program has bracketed paste
 * mode on, the text is wrapped in the paste markers, and markers inside the text
 * are removed first, so pasted bytes cannot end the paste early and run as typed
 * commands. Unlike a snippet, a paste is any text the user chose to paste.
 */
export function encodeTerminalPaste(text: string, bracketed: boolean): string {
  const normalized = text.replace(/\r?\n/g, "\r");
  if (!bracketed) return normalized;
  // Repeated until stable: removing one marker can join the bytes around it into another.
  let contained = normalized;
  for (let previous: string | null = null; previous !== contained;) {
    previous = contained;
    // oxlint-disable-next-line no-control-regex -- ESC[200~ and ESC[201~ are the paste markers it removes
    contained = contained.replace(/\x1b\[20[01]~/g, "");
  }
  return `${BRACKETED_PASTE_START}${contained}${BRACKETED_PASTE_END}`;
}
