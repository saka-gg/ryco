/**
 * What a crash record keeps of an error message or stack. Where the app is installed and whose
 * folders a path runs through say nothing about the crash, and a URL's query can hold a
 * credential (the client sends `?wsToken=` and `?token=`). So, in one pass:
 *
 * - absolute paths (POSIX, `~/`, `file://`, `C:\`, `\\server\share`) keep only their last
 *   part, including folders whose names hold spaces;
 * - URLs lose their user info, query string and fragment, and keep a stack frame's
 *   `:line:column`;
 * - a query string on anything else (`ws?wsToken=…`) is dropped too.
 *
 * Applying it twice changes nothing. React-free; it runs while the app is crashing, so it is
 * one regular expression pass and allocates little.
 */

/** Ends a path or URL: whitespace, a quote or a bracket. */
const STOP = "\\s\"'`<>()";
/** One folder name: no separator, colon, query, list mark or stop; single inner spaces allowed. */
const WORD = String.raw`[^/\\:?#,;${STOP}]+`;
const SEGMENT = `${WORD}(?: ${WORD})*`;
/** Where a path may start: not inside a word, a number, another path or a URL. */
const PATH_START = String.raw`(?<![\p{L}\p{N}_.%+\-~/\\:])`;
const TOKEN_END = `(?=[${STOP}]|$)`;
const TOKEN_CHAR = `[^${STOP}]`;

const CRASH_TEXT = new RegExp(
  [
    // A URL: the scheme (1) and the host and path (2) stay, a frame's position (3) too.
    String.raw`\b(?!file:)([a-z][a-z\d+.-]*:\/\/)(?:[^/?#@${STOP}]*@)?([^?#${STOP}]*)(?:[?#]${TOKEN_CHAR}*?)?((?::\d+)+)?${TOKEN_END}`,
    // The folders of a path, removed so its last part stays.
    String.raw`file:\/\/[^\s/]*\/(?:[a-z]:\/)?(?:${SEGMENT}\/)*`,
    String.raw`${PATH_START}~?\/(?:${SEGMENT}\/)+`,
    String.raw`${PATH_START}[a-z]:[\\/](?:${SEGMENT}[\\/])+`,
    String.raw`(?<![\p{L}\p{N}_\\])\\\\(?:${SEGMENT}\\)+`,
    // A query string on a relative path or a bare name; a position (4) after it stays.
    String.raw`(?<=\S)\?[\w.%\-\[\]]+=${TOKEN_CHAR}*?((?::\d+)+)?${TOKEN_END}`,
  ].join("|"),
  "giu",
);

export function redactCrashText(text: string): string {
  return text.replace(
    CRASH_TEXT,
    (
      _match,
      scheme: string | undefined,
      hostAndPath: string | undefined,
      urlPosition: string | undefined,
      queryPosition: string | undefined,
    ) =>
      scheme === undefined
        ? (queryPosition ?? "")
        : `${scheme}${hostAndPath ?? ""}${urlPosition ?? ""}`,
  );
}
