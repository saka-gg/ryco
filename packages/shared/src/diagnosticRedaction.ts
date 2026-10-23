export const DIAGNOSTIC_SECRET_KEY_PATTERN =
  /token|secret|password|passwd|credential|authorization|bearer|api[-_]?key|cookie|session|private[-_]?key|pairing[-_]?code|access[-_]?key|signature|email|proof|ticket/iu;

const REDACTED = "[redacted]";

/**
 * The start of a `key=value`, `key: value` or `key => value` assignment, the key optionally quoted
 * (`"apiKey":`, `\"apiKey\":`, Markdown code). A key begins after a non-key character, so no key
 * run is rescanned, and `==`, `:=` and `::` are not assignments. The spacing never crosses a line.
 */
const ASSIGNMENT_START = /(^|[^\w-])([\w-]+)(\\?["'`])?[^\S\r\n]*(?:=>|[=:](?![=:]))[^\S\r\n]*/gu;
/**
 * Credential words that end a key in any naming style: `token`, `ANTHROPIC_AUTH_TOKEN`,
 * `clientSecret`, `x-api-key`. Plurals such as `input_tokens` are counts, not credentials.
 */
const CREDENTIAL_KEY =
  /(?:token|secret|passw(?:or)?d|passphrase|credentials?|authorization|cookie|api_?key|access_?key|private_?key|secret_?key|pairing_?code|(?:^|_)(?:auth|proof|ticket))$/u;
/** `STRIPE_KEY`, `SMTP_PASS`, `MYSQL_PWD`: credentials by convention in environment names only. */
const ENVIRONMENT_CREDENTIAL_KEY = /^[A-Z\d_]+_(?:KEY|PASS|PWD)$/u;
/** Header values hold more than one word (`Basic <credential>`, `a=1; b=2`). */
const HEADER_CREDENTIAL_KEY = /(?:authorization|cookie)$/u;
/** A character after a quote that shows the quote closed a string rather than opened one. */
const QUOTE_CLOSER = /[\s,;:.&|<>)\]}]/u;
/** A character that ends an unquoted value outside brackets. */
const VALUE_TERMINATOR = /[\s,;&|<>]/u;
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const WHITESPACE = /\s/u;
/** `NAME=value`, unlike a base64 value whose padding ends it (`YWJjZA==`). */
const ENVIRONMENT_ASSIGNMENT = /[A-Za-z_][\w-]*=[^\s=]/uy;
/** Markers an earlier rule or an earlier pass left; a value that starts with one may have a tail. */
const REDACTION_MARKERS = [REDACTED, "[redacted URL]"] as const;

interface RedactedValue {
  readonly end: number;
  readonly replacement: string;
}

/** `clientSecret`, `client-secret` and `CLIENT_SECRET` all read `client_secret`. */
export function normalizeCredentialKey(key: string): string {
  return key
    .replace(/([a-z\d])([A-Z])/gu, "$1_$2")
    .replace(/-/gu, "_")
    .toLowerCase();
}

/**
 * Whether a key or variable name ends in a credential word in any naming style:
 * `ANTHROPIC_AUTH_TOKEN`, `clientSecret`, `X-Api-Key`, `STRIPE_KEY`.
 */
export function isCredentialKeyName(
  key: string,
  normalizedKey: string = normalizeCredentialKey(key),
): boolean {
  return (
    CREDENTIAL_KEY.test(normalizedKey) ||
    // `passWord`, `PassWd`: splitting camelCase must not break a credential word apart.
    CREDENTIAL_KEY.test(key.toLowerCase()) ||
    ENVIRONMENT_CREDENTIAL_KEY.test(key)
  );
}

/** Quotes, and backticks: a shell command substitution or a Markdown code span. */
function isQuote(char: string | undefined): char is string {
  return char === '"' || char === "'" || char === "`";
}

function isLineEnd(char: string | undefined): boolean {
  return char === "\n" || char === "\r";
}

function endOfLine(text: string, from: number): number {
  let index = from;
  while (index < text.length && !isLineEnd(text[index])) index += 1;
  return index;
}

function closesString(char: string | undefined): boolean {
  return char === undefined || QUOTE_CLOSER.test(char);
}

/**
 * The index of the quote that closes a string opened just before `from`, or -1. With `withinLine`
 * the search stops at the end of the line.
 */
function closingQuote(text: string, from: number, quote: string, withinLine = false): number {
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") index += 1;
    else if (char === quote) return index;
    else if (withinLine && isLineEnd(char)) return -1;
  }
  return -1;
}

function isWordCharacter(char: string | undefined): boolean {
  return char !== undefined && WORD_CHARACTER.test(char);
}

/** `it's`, `don't`: an apostrophe inside a word that no quote on its line closes. */
function isApostrophe(text: string, index: number): boolean {
  return (
    text[index] === "'" && isWordCharacter(text[index - 1]) && isWordCharacter(text[index + 1])
  );
}

/** The index of the `\"` closing a JSON string nested in another, or -1 when unclear. */
function escapedClosingQuote(text: string, from: number, quote: string): number {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] !== "\\") continue;
    const next = text[index + 1];
    if (next === quote) return index;
    if (next === "\\") return -1;
    index += 1;
  }
  return -1;
}

/** Whether `text[from, to)` holds a `$(…)` or backtick command substitution. */
function hasSubstitution(text: string, from: number, to: number): boolean {
  for (let index = from; index < to; index += 1) {
    const char = text[index];
    if (char === "`" || (char === "$" && text[index + 1] === "(")) return true;
  }
  return false;
}

/**
 * Where an unquoted, shell-style value ends. Quoted segments join it (`"correct horse"battery`)
 * and brackets nest. The extent of a `$(…)` substitution cannot be known, so it hides the rest of
 * its line; an unclosed quote hides the rest of the text, unless it is an apostrophe in a word.
 * With `angled`, the `<` at `from` opens a bracket that `>` closes (`token=<value>`).
 */
function unquotedValueEnd(
  text: string,
  from: number,
  boundary: string | undefined,
  angled = false,
): number {
  let depth = angled ? 1 : 0;
  let index = angled ? from + 1 : from;
  while (index < text.length) {
    const char = text[index];
    if (char === undefined || isLineEnd(char) || char === boundary) break;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "$" && text[index + 1] === "(") return endOfLine(text, index);
    if (isQuote(char)) {
      // `"… token=abc", …`: the quote closes the string that holds the assignment.
      if (depth === 0 && closesString(text[index + 1])) break;
      // Prose such as `token: it's handled` hides one word, not the rest of the text.
      if (isApostrophe(text, index) && closingQuote(text, index + 1, char, true) === -1) {
        index += 1;
        continue;
      }
      const close = closingQuote(text, index + 1, char);
      if (close === -1) return text.length;
      if (char === '"' && hasSubstitution(text, index + 1, close)) return endOfLine(text, close);
      index = close + 1;
      continue;
    }
    if (depth === 0 && VALUE_TERMINATOR.test(char)) break;
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}" || (angled && char === ">")) {
      if (depth === 0) break;
      depth -= 1;
    }
    index += 1;
  }
  return Math.min(index, text.length);
}

/** A header value runs to the end of its line, or to the quote that encloses it. */
function headerValueEnd(text: string, from: number, boundary: string | undefined): number {
  let end = from;
  while (end < text.length && !isLineEnd(text[end]) && text[end] !== boundary) end += 1;
  while (end > from && (text[end - 1] === " " || text[end - 1] === "\t")) end -= 1;
  return end;
}

/**
 * The credential value starting at `start`, or null when there is none to hide. Quotes and the
 * punctuation around the value are kept. A value that never closes is hidden to the end of the
 * text, since diagnostics are often truncated mid-credential.
 */
function redactedCredentialValue(
  text: string,
  start: number,
  boundary: string | undefined,
  isHeader: boolean,
): RedactedValue | null {
  const first = text[start];
  if (first === undefined || isLineEnd(first)) return null;
  if (first === boundary) {
    // `"TOKEN="abc`: a quote that ends the string without closing it leaves the value after it.
    if (closesString(text[start + 1])) return null;
    const end = unquotedValueEnd(text, start + 1, boundary);
    return end === start + 1 ? null : { end, replacement: `${first}${REDACTED}` };
  }
  const marker = REDACTION_MARKERS.find((candidate) => text.startsWith(candidate, start));
  if (marker !== undefined) {
    // `token=[redacted]-suffix`: an earlier rule hid only the start of the value.
    const tailStart = start + marker.length;
    const end = isHeader
      ? headerValueEnd(text, tailStart, boundary)
      : unquotedValueEnd(text, tailStart, boundary);
    return end === tailStart ? null : { end, replacement: REDACTED };
  }
  if (isQuote(first)) {
    const close = closingQuote(text, start + 1, first);
    if (close === -1) return { end: text.length, replacement: `${first}${REDACTED}` };
    if (first === '"' && hasSubstitution(text, start + 1, close)) {
      return { end: endOfLine(text, close), replacement: REDACTED };
    }
    if (closesString(text[close + 1])) {
      return { end: close + 1, replacement: `${first}${REDACTED}${first}` };
    }
    return { end: unquotedValueEnd(text, close + 1, boundary), replacement: REDACTED };
  }
  const escapedQuote = first === "\\" ? text[start + 1] : undefined;
  if (escapedQuote === '"' || escapedQuote === "'") {
    const close = escapedClosingQuote(text, start + 2, escapedQuote);
    return close === -1
      ? { end: text.length, replacement: `\\${escapedQuote}${REDACTED}` }
      : { end: close + 2, replacement: `\\${escapedQuote}${REDACTED}\\${escapedQuote}` };
  }
  if (isHeader) return { end: headerValueEnd(text, start, boundary), replacement: REDACTED };
  const end = unquotedValueEnd(text, start, boundary, first === "<");
  return end === start ? null : { end, replacement: REDACTED };
}

/** The first character of the next non-blank line. */
function nextLineStart(text: string, lineEnd: number): number {
  let index = lineEnd;
  while (index < text.length && WHITESPACE.test(text[index] ?? "")) index += 1;
  return index;
}

/**
 * Whether a value found on the line after its key stands alone there: `password:\n  hunter2`. A
 * line that holds more (nested YAML's `user: x`, a list item, prose), a key such as `token:`, an
 * assignment such as `NAME=value` in `env` output, or a value that runs onto further lines is left
 * to the scan.
 */
function standsAloneOnLine(text: string, start: number, value: RedactedValue): boolean {
  if (text[value.end - 1] === ":") return false;
  ENVIRONMENT_ASSIGNMENT.lastIndex = start;
  if (ENVIRONMENT_ASSIGNMENT.test(text)) return false;
  let rest = value.end;
  while (text[rest] === " " || text[rest] === "\t") rest += 1;
  return rest === endOfLine(text, start);
}

/**
 * Hides the values of credential-named assignments in environment (`export OPENAI_API_KEY=…`),
 * shell, header, JSON and object-literal forms. Runs in one forward pass.
 */
function redactCredentialAssignments(text: string): string {
  let redacted = "";
  let copiedUntil = 0;
  ASSIGNMENT_START.lastIndex = 0;
  for (
    let match = ASSIGNMENT_START.exec(text);
    match !== null;
    match = ASSIGNMENT_START.exec(text)
  ) {
    const [assignment, prefix = "", key = "", keyQuote] = match;
    const keyEnd = match.index + prefix.length + key.length;
    const normalizedKey = normalizeCredentialKey(key);
    if (!isCredentialKeyName(key, normalizedKey)) {
      // The value may hold an assignment of its own (`url=token=…`).
      ASSIGNMENT_START.lastIndex = keyEnd;
      continue;
    }
    const assignmentEnd = match.index + assignment.length;
    // `"GITHUB_TOKEN=…"`: the assignment sits in a string whose quote ends the value.
    const boundary = keyQuote === undefined && isQuote(prefix) ? prefix : undefined;
    // `password:\n  hunter2`: an assignment that ends its line can take its value from the next.
    const onNextLine = isLineEnd(text[assignmentEnd]);
    const valueStart = onNextLine ? nextLineStart(text, assignmentEnd) : assignmentEnd;
    const value = redactedCredentialValue(
      text,
      valueStart,
      boundary,
      HEADER_CREDENTIAL_KEY.test(normalizedKey),
    );
    if (value === null || (onNextLine && !standsAloneOnLine(text, valueStart, value))) {
      // Not past the line break, so a key on the next line is still found.
      ASSIGNMENT_START.lastIndex = assignmentEnd;
      continue;
    }
    redacted += text.slice(copiedUntil, valueStart) + value.replacement;
    copiedUntil = value.end;
    ASSIGNMENT_START.lastIndex = value.end;
  }
  return redacted + text.slice(copiedUntil);
}

/** Free-text diagnostics can contain credentials even under harmless field names. */
export function redactDiagnosticText(value: string): string {
  const withoutKnownShapes = value
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu,
      "[redacted]",
    )
    .replace(/\bBearer\s+[^\s,;"']+/giu, "Bearer [redacted]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]+)\b/gu,
      "[redacted]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted]")
    .replace(/https?:\/\/[^\s<>"']+/giu, (match) => {
      try {
        const url = new URL(match);
        url.username = "";
        url.password = "";
        url.hash = "";
        for (const key of url.searchParams.keys()) {
          if (
            /token|secret|password|credential|authorization|key|cookie|proof|ticket|signature|code/iu.test(
              key,
            )
          ) {
            url.searchParams.set(key, "[redacted]");
          }
        }
        return url.toString();
      } catch {
        return "[redacted URL]";
      }
    })
    // Other schemes keep their host: `postgres://app:secret@db`, `redis://:secret@cache`.
    .replace(/\b([a-z][a-z\d+.-]{0,31}:\/\/)[^\s/?#"'<>]+@/giu, `$1${REDACTED}@`);
  // Last, so URL userinfo is already gone and `https://x-access-token:…@github.com` keeps its host.
  return redactCredentialAssignments(withoutKnownShapes);
}
