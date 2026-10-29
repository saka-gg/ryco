/**
 * The one normalizer for page elements picked in the Ryco browser: desktop main runs it on every
 * pick, and the client runtime runs it again on every reference it stores, restores or parses. Pure,
 * with no DOM.
 *
 * The redaction rules, the sensitive-text check and the URL path rules are adapted from Synara
 * (https://github.com/Emanuele-web04/synara, MIT; see THIRD_PARTY_NOTICES.md), commit
 * 299fd573b1d6520c323a87c78d30be74e87e53e1: `apps/desktop/src/browserAnnotations/protocol.ts`
 * (`boundedString`, `looksSensitive`, the parse-time redaction) and
 * `packages/shared/src/browserAnnotations.ts` (`decodeForInspection`, `looksPrivate`,
 * `SENSITIVE_PATH_KEYS`, `sanitizePathname`).
 *
 * @module browserElementReference
 */
import {
  BROWSER_ELEMENT_MAX_NAME_LENGTH,
  BROWSER_ELEMENT_MAX_PAGE_TITLE_LENGTH,
  BROWSER_ELEMENT_MAX_ROLE_LENGTH,
  BROWSER_ELEMENT_MAX_SELECTOR_LENGTH,
  BROWSER_ELEMENT_MAX_TAG_LENGTH,
  BROWSER_ELEMENT_MAX_TEXT_LENGTH,
  BROWSER_ELEMENT_MAX_URL_LENGTH,
  type ProjectBrowserElementBox,
  type ProjectBrowserPickedElement,
} from "@ryco/contracts/project-browser";

/** What a private-looking URL path segment becomes. */
export const BROWSER_ELEMENT_REDACTED_SEGMENT = "REDACTED";

/**
 * Raw strings longer than this many times their cap are rejected before any work. The describe
 * script already cuts every field to its cap; this only stops a pathological payload. (Synara
 * rejects anything over the cap; Ryco truncates instead, so a long title or name still picks.)
 */
const RAW_LENGTH_FACTOR = 4;
const BOX_LIMIT = 1_000_000;
/** How far back a cut looks for a space, so it does not split a word. */
const WORD_CUT_LOOKBACK = 64;
/** Form controls whose text is their value. */
const VALUE_TAGS = new Set(["input", "textarea", "select", "option"]);

// Control characters (C0, DEL, C1) and the Unicode line and paragraph separators.
const CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029]/gu;
// Without the `u` flag, so each half of a surrogate pair is seen on its own.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/u;
const SENSITIVE_WORD = /\b(?:bearer|authorization|password|passwd|secret|api[-_ ]?key)\b/iu;
const CARD_LIKE_DIGITS = /\b(?:\d[ -]*?){13,19}\b/u;
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u;

const PRIVATE_PATH_WORD =
  /(?:^|[^A-Za-z0-9])(?:bearer|password|passwd|secret|token|credential)(?:$|[^A-Za-z0-9])/iu;
const JWT_SEGMENT = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/u;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OPAQUE_RUN = /[A-Za-z0-9_-]{32,}/gu;
const MAX_PUBLIC_SEGMENT_LENGTH = 96;
/** Path keys whose next segment names a person, a secret or a one-time link (Synara's list). */
const SENSITIVE_PATH_KEYS = new Set([
  "account",
  "accounts",
  "auth",
  "authorize",
  "callback",
  "client",
  "clients",
  "contact",
  "contacts",
  "credential",
  "credentials",
  "customer",
  "customers",
  "employee",
  "employees",
  "invite",
  "invites",
  "join",
  "magic",
  "member",
  "members",
  "oauth",
  "patient",
  "patients",
  "people",
  "person",
  "profile",
  "profiles",
  "record",
  "records",
  "reset",
  "s",
  "session",
  "sessions",
  "share",
  "shared",
  "shares",
  "staff",
  "token",
  "tokens",
  "user",
  "users",
  "verification",
  "verify",
]);

/**
 * True for text that looks like a credential or personal data: bearer/authorization/password/
 * passwd/secret/API-key words, an email address, a run of 13–19 digits (a card number) or a JWT.
 */
export function looksSensitiveBrowserText(value: string): boolean {
  return (
    SENSITIVE_WORD.test(value) ||
    EMAIL.test(value) ||
    CARD_LIKE_DIGITS.test(value) ||
    JWT_LIKE.test(value)
  );
}

/**
 * The URL a picked element may carry: http(s) only, without username, password, query or hash.
 * Each path segment is checked percent-decoded and becomes `REDACTED` when it looks private (an
 * email, a JWT, a UUID, a token/password/secret/credential word, more than 96 characters, or a run of
 * 32+ letters and digits) or directly follows a sensitive key such as `reset`, `invite` or `users`.
 * Every other segment stays, because the route is the context an agent needs. Idempotent; null for
 * anything that is not an http(s) URL.
 */
export function sanitizeBrowserElementUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = sanitizePath(url.pathname);
  return url.href;
}

/**
 * Bounds, sanitizes and redacts a raw element description (the describe script's result, or a
 * stored or parsed reference). `page` is trusted: in desktop main it is the browser's own URL and
 * title for the tab, never the page script's. Null when the URL, selector or tag is missing or
 * invalid. Idempotent, field by field.
 */
export function normalizeBrowserElementPick(
  raw: unknown,
  page: { readonly url: string; readonly title: string },
): ProjectBrowserPickedElement | null {
  if (!isRecord(raw)) return null;
  const url = boundedUrl(page.url);
  // A selector is rejected rather than cut: a truncated selector points somewhere else.
  const selector = collapse(raw.selector, BROWSER_ELEMENT_MAX_SELECTOR_LENGTH);
  const tagName = line(raw.tagName, BROWSER_ELEMENT_MAX_TAG_LENGTH, true);
  if (!url || !selector || selector.length > BROWSER_ELEMENT_MAX_SELECTOR_LENGTH || !tagName)
    return null;
  return {
    url,
    pageTitle: publicLine(page.title, BROWSER_ELEMENT_MAX_PAGE_TITLE_LENGTH) ?? "",
    selector,
    tagName,
    role: line(raw.role, BROWSER_ELEMENT_MAX_ROLE_LENGTH),
    name: publicLine(raw.name, BROWSER_ELEMENT_MAX_NAME_LENGTH),
    text: VALUE_TAGS.has(tagName) ? null : publicLine(raw.text, BROWSER_ELEMENT_MAX_TEXT_LENGTH),
    box: elementBox(raw.box),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One line: control characters and lone surrogates replaced, whitespace collapsed, trimmed. Null
 * for a non-string, an empty result, or a raw string over the raw-length bound for `cap`.
 */
function collapse(value: unknown, cap: number, lowercase = false): string | null {
  if (typeof value !== "string" || value.length > cap * RAW_LENGTH_FACTOR) return null;
  const cased = lowercase ? value.toLowerCase() : value;
  return (
    cased
      .replace(CONTROL_CHARACTERS, " ")
      .replace(LONE_SURROGATE, "\uFFFD")
      .replace(/\s+/gu, " ")
      .trim() || null
  );
}

/** A collapsed line cut to at most `cap` UTF-16 units. */
function line(value: unknown, cap: number, lowercase = false): string | null {
  const collapsed = collapse(value, cap, lowercase);
  return collapsed === null ? null : truncate(collapsed, cap);
}

/**
 * A line of page text that may reach a provider: null when it looks sensitive, checked before and
 * after cutting (cutting can both hide and complete a match).
 */
function publicLine(value: unknown, cap: number): string | null {
  const collapsed = collapse(value, cap);
  if (collapsed === null || looksSensitiveBrowserText(collapsed)) return null;
  const cut = truncate(collapsed, cap);
  return cut && !looksSensitiveBrowserText(cut) ? cut : null;
}

/**
 * Cuts a collapsed line to at most `cap` UTF-16 units without splitting a surrogate pair. A word
 * the cut would split is dropped whole when it starts within the last 64 units, so the cut does not
 * leave part of a word (such as half an email address) behind.
 */
function truncate(value: string, cap: number): string | null {
  if (value.length <= cap) return value;
  let end = isHighSurrogate(value.charCodeAt(cap - 1)) ? cap - 1 : cap;
  if (value[end] !== " ") {
    const space = value.lastIndexOf(" ", end - 1);
    if (space > 0 && end - space <= WORD_CUT_LOOKBACK) end = space;
  }
  return value.slice(0, end).trimEnd() || null;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function boundedUrl(value: string): string | null {
  // No raw bound: the URL comes from the browser, and the query a long URL usually carries is
  // dropped anyway.
  const url = sanitizeBrowserElementUrl(value);
  return url && url.length <= BROWSER_ELEMENT_MAX_URL_LENGTH ? url : null;
}

function elementBox(value: unknown): ProjectBrowserElementBox | null {
  if (!isRecord(value)) return null;
  const { x, y, width, height } = value;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    ![x, y, width, height].every(Number.isFinite)
  )
    return null;
  return {
    x: clampCoordinate(x),
    y: clampCoordinate(y),
    width: Math.max(0, clampCoordinate(width)),
    height: Math.max(0, clampCoordinate(height)),
  };
}

function clampCoordinate(value: number): number {
  // `+ 0` turns -0 into 0.
  return Math.min(BOX_LIMIT, Math.max(-BOX_LIMIT, Math.round(value))) + 0;
}

function decodeForInspection(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function looksPrivatePathSegment(decoded: string): boolean {
  return (
    decoded.length > MAX_PUBLIC_SEGMENT_LENGTH ||
    PRIVATE_PATH_WORD.test(decoded) ||
    EMAIL.test(decoded) ||
    JWT_SEGMENT.test(decoded) ||
    UUID_SEGMENT.test(decoded) ||
    (decoded.match(OPAQUE_RUN) ?? []).some((run) => /[A-Za-z]/u.test(run) && /\d/u.test(run))
  );
}

function isSensitivePathKey(decoded: string): boolean {
  return decoded
    .toLowerCase()
    .split(/[-_]/u)
    .some((part) => SENSITIVE_PATH_KEYS.has(part));
}

/** Synara's `redactNext` rule without its static allowlist: keep every segment that looks public. */
function sanitizePath(pathname: string): string {
  let redactNext = false;
  return pathname
    .split("/")
    .map((segment) => {
      if (segment.length === 0) return segment;
      const decoded = decodeForInspection(segment);
      const redact = redactNext || looksPrivatePathSegment(decoded);
      redactNext = isSensitivePathKey(decoded);
      return redact ? BROWSER_ELEMENT_REDACTED_SEGMENT : segment;
    })
    .join("/");
}
