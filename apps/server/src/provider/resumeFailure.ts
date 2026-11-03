/**
 * Recognizes provider errors that mean "the native conversation I was asked to
 * resume does not exist", e.g. Codex `thread/resume` on a missing rollout ("no
 * rollout found for thread id …") or Claude's "No conversation found with
 * session ID". Such a resume can be replaced by a fresh session without losing
 * anything the provider still had.
 *
 * A match abandons a native conversation, so the missing phrase must name the
 * noun itself ("thread not found", "no such session"). A text that only
 * mentions a thread next to some other missing thing ("for thread t-1: codex
 * binary not found", "thread/resume failed: model not found") does not count,
 * and neither does one where the noun qualifies another word ("Unknown session
 * mode: plan", "missing thread parameter").
 *
 * Pure module: no services, no I/O.
 *
 * @module resumeFailure
 */

/** Codex stores a thread's history as a "rollout"; a missing one is a missing conversation. */
const DEFAULT_CONVERSATION_NOUNS = ["thread", "conversation", "session", "rollout"] as const;

/** Nested `cause` levels inspected; typed errors usually wrap the native error once or twice. */
const MAX_CAUSE_DEPTH = 4;

/**
 * One id: quoted, a single word with a digit ("019a", "abc-123", "ses_01"), or a uuid
 * (8-4-4-4-12 hex digits) without one. A plain word of hex letters is not an id: "decade" and
 * "facade" are English. It stops at a colon, so a wrapper's "for thread t-1: <detail>" never joins
 * the thread to a missing thing named in the detail.
 */
const ID_TOKEN =
  "(?:['\"`][^'\"`\\s]+['\"`]|[\\w.-]*\\d[\\w.-]*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";

/** An id after the noun: "session abc-123", "session ID abc-123", "Session ID: 0f3c". */
const NOUN_ID = `(?:\\s+id)?(?:\\s*:\\s*|\\s+)${ID_TOKEN}(?![\\w-])`;

/** What may follow the bare noun of a prefix form: the end of the text or punctuation. */
const NOUN_END = "\\s*(?:$|[.,;:!?)\\]'\"`])";

/** The alternatives that name a missing `noun` itself, as one source for a case-insensitive RegExp. */
function missingNounSource(noun: string): string {
  const escaped = noun.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A whole word: "thread", not "threads", "thread-id" or "sub-thread".
  const word = `(?<![\\w-])${escaped}(?![\\w-])`;
  return [
    // "no rollout found for thread id …", "No conversation found with session ID: …"
    `\\bno\\s+${word}\\s+found\\b`,
    // "no such thread", "No such session exists", "Unknown session: abc", "Unknown session ID
    // abc-123", "missing rollout". The noun names the missing thing only when nothing but an id or
    // the end follows it (after "no such", also "exists"): "Unknown session mode", "missing thread
    // parameter" and "missing session id" name others.
    `\\b(?:no\\s+such\\s+${word}(?:\\s+exists?)?|(?:unknown|missing)\\s+${word})(?:${NOUN_ID}|${NOUN_END})`,
    // "thread not found: 019a", "Session ID: 0f3c not found", "session abc-123 does not exist"
    `${word}(?:\\s+id)?(?:(?:\\s*:\\s*|\\s+)${ID_TOKEN})?\\s+(?:(?:was\\s+)?not\\s+found|does\\s+not\\s+exist)\\b`,
  ].join("|");
}

/** One compiled pattern per noun list; callers pass a few constant lists. */
const patternsByNouns = new Map<string, RegExp>();

/** Never matches: an empty noun list names no conversation. */
const NO_NOUNS = /(?!)/;

function missingConversationPattern(nouns: ReadonlyArray<string>): RegExp {
  if (nouns.length === 0) return NO_NOUNS;
  const key = nouns.join("\n");
  let pattern = patternsByNouns.get(key);
  if (pattern === undefined) {
    pattern = new RegExp(nouns.map(missingNounSource).join("|"), "i");
    patternsByNouns.set(key, pattern);
  }
  return pattern;
}

function errorTexts(error: unknown): ReadonlyArray<string> {
  const texts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth += 1) {
    if (typeof current === "string") {
      texts.push(current);
      break;
    }
    if (typeof current !== "object" || current === null) break;
    for (const field of ["detail", "message", "errorMessage"] as const) {
      const value = Reflect.get(current, field);
      if (typeof value === "string" && value.length > 0) texts.push(value);
    }
    current = Reflect.get(current, "cause");
  }
  return texts;
}

/**
 * Whether one text names a missing conversation: a missing-resource phrase
 * that refers to one of `nouns` ("thread not found", "session 019a does not
 * exist", "no such thread", "No conversation found", "unknown session").
 */
export function isMissingConversationText(
  text: string,
  nouns: ReadonlyArray<string> = DEFAULT_CONVERSATION_NOUNS,
): boolean {
  return missingConversationPattern(nouns).test(text);
}

/**
 * Whether an error (its `detail`, `message` or a nested `cause`) says the
 * provider could not find the conversation it was asked to resume.
 */
export function isMissingConversationError(
  error: unknown,
  nouns: ReadonlyArray<string> = DEFAULT_CONVERSATION_NOUNS,
): boolean {
  const pattern = missingConversationPattern(nouns);
  return errorTexts(error).some((text) => pattern.test(text));
}
