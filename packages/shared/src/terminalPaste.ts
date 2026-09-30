export const MAX_TERMINAL_SNIPPET_BYTES = 48 * 1024;

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
  return `\x1b[200~${source}\x1b[201~`;
}
