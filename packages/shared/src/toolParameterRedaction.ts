/**
 * Hides credential-named tool parameters (`token`, `apiKey`, an `Authorization` header) in what is
 * projected, persisted and shown of approval and tool activities. Never apply it to the input a
 * provider runs: it returns new values and never mutates its argument.
 */
import { isCredentialKeyName, normalizeCredentialKey } from "./diagnosticRedaction.ts";

const REDACTED = "[redacted]";

/**
 * Credential words that are ordinary tool parameters: a Jira `ticket`, a `proof`, a pagination
 * `pageToken`/`NextToken`. The diagnostic key words count them, since free text cannot tell.
 */
const ORDINARY_PARAMETER_KEY = /(?:^|_)(?:proof|ticket|(?:page|next|continuation|sync)_token)$/u;
/** Parameters that hold several credentials, a bare `bearer`, or a password's confirmation. */
const PARAMETER_CREDENTIAL_KEY =
  /(?:secrets|cookies|api_?keys|(?:^|_)(?:access|private|secret)_?keys|(?:^|_)(?:access|refresh|id|o?auth|bearer)_?tokens|passw(?:or)?ds|passw(?:or)?d_confirm(?:ation)?|(?:^|_)bearer)$/u;
/** Commands stay verbatim so an approval shows exactly what will run. */
const VERBATIM_KEYS = new Set(["command", "cmd"]);
/** Deeper values are hidden whole: no tool parameter nests this far, and the walk stays bounded. */
const MAX_DEPTH = 64;
/** Longer strings are not parsed, so projecting large tool output stays cheap. */
const MAX_STRUCTURED_STRING_CHARS = 64 * 1024;

/**
 * Whether a tool parameter, nested field or header name holds a credential, in any naming style:
 * `token`, `api_key`, `clientSecret`, `Authorization`, `X-Api-Key`, `OPENAI_API_KEY`. Counts such
 * as `max_tokens`, and `session` or `email`, are ordinary parameters.
 */
export function isToolParameterCredentialKey(key: string): boolean {
  const normalizedKey = normalizeCredentialKey(key);
  if (PARAMETER_CREDENTIAL_KEY.test(normalizedKey)) return true;
  return isCredentialKeyName(key, normalizedKey) && !ORDINARY_PARAMETER_KEY.test(normalizedKey);
}

function namesCredential(value: unknown): boolean {
  return typeof value === "string" && isToolParameterCredentialKey(value);
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A flag or an empty value holds no credential, and hiding it would misstate the call. */
function hiddenValue(value: unknown): unknown {
  return value === null || value === undefined || typeof value === "boolean" || value === ""
    ? value
    : REDACTED;
}

/**
 * A string that is a whole JSON object or array (a structured parameter string) with its
 * credentials hidden. Strings without credentials come back unchanged; a redacted one keeps its
 * surrounding whitespace and the indentation of pretty-printed JSON.
 */
function redactStructuredString(value: string, depth: number): string {
  if (value.length > MAX_STRUCTURED_STRING_CHARS) return value;
  const json = value.trim();
  const isContainer =
    (json.startsWith("{") && json.endsWith("}")) || (json.startsWith("[") && json.endsWith("]"));
  if (!isContainer) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return value;
  }
  const redacted = redactValue(parsed, depth + 1);
  if (redacted === parsed) return value;
  // A raw line break in JSON text is always whitespace between tokens.
  const indent = /\n([ \t]+)/u.exec(json)?.[1];
  const leading = value.slice(0, value.length - value.trimStart().length);
  const trailing = value.slice(value.trimEnd().length);
  return `${leading}${JSON.stringify(redacted, null, indent)}${trailing}`;
}

function redactRecord(record: Record<string, unknown>, depth: number): Record<string, unknown> {
  // `{ name: "Authorization", value: "Bearer …" }`: a header or setting given as a pair.
  const namesCredentialValue = namesCredential(record.name) || namesCredential(record.key);
  let changed = false;
  const entries = Object.entries(record).map(([key, entry]): [string, unknown] => {
    const redacted = VERBATIM_KEYS.has(key)
      ? entry
      : isToolParameterCredentialKey(key) || (key === "value" && namesCredentialValue)
        ? hiddenValue(entry)
        : redactValue(entry, depth + 1);
    if (redacted !== entry) changed = true;
    return [key, redacted];
  });
  // `Object.fromEntries` defines a `__proto__` key as data instead of setting the prototype.
  return changed ? Object.fromEntries(entries) : record;
}

function redactArray(array: ReadonlyArray<unknown>, depth: number): ReadonlyArray<unknown> {
  let changed = false;
  const next = array.map((entry) => {
    const redacted = redactValue(entry, depth + 1);
    if (redacted !== entry) changed = true;
    return redacted;
  });
  return changed ? next : array;
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactStructuredString(value, depth);
  if (value === null || typeof value !== "object") return value;
  if (!Array.isArray(value) && !isPlainRecord(value)) return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  return Array.isArray(value) ? redactArray(value, depth) : redactRecord(value, depth);
}

/**
 * `value` with every credential-named parameter hidden, in nested objects, arrays, name/value
 * pairs and strings that hold a whole JSON object or array. Returns `value` itself when nothing
 * was hidden. Other strings, numbers and commands are kept as they are.
 */
export function redactToolParameterCredentials(value: string): string;
export function redactToolParameterCredentials(value: unknown): unknown;
export function redactToolParameterCredentials(value: unknown): unknown {
  return redactValue(value, 0);
}
