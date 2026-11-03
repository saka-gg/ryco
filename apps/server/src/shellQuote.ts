/**
 * shellQuote - quoting a word for a command the user copies into a terminal.
 *
 * POSIX shells get single quotes (an embedded quote closes, escapes and reopens them). Windows
 * terminals default to PowerShell, where single-quoted strings are literal and a quote is doubled
 * (PowerShell also accepts typographic quotes as quotes). Words without special characters stay
 * as they are.
 *
 * @module shellQuote
 */

export function quoteShellWord(word: string, platform: NodeJS.Platform): string {
  const safeWord = platform === "win32" ? /^[\w./:\\@=-]+$/ : /^[\w./:@=-]+$/;
  if (safeWord.test(word)) return word;
  return platform === "win32"
    ? `'${word.replace(/['‘’]/g, "$&$&")}'`
    : `'${word.replaceAll("'", "'\\''")}'`;
}
