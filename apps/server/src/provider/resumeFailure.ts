/**
 * Recognizes provider errors that mean "the native conversation I was asked to
 * resume does not exist", e.g. Codex `thread/resume` on a missing rollout ("no
 * rollout found for thread id …") or Claude's "No conversation found with
 * session ID". Such a resume can be replaced by a fresh session without losing
 * anything the provider still had.
 *
 * Pure module: no services, no I/O.
 *
 * @module resumeFailure
 */

/** Codex stores a thread's history as a "rollout"; a missing one is a missing conversation. */
const DEFAULT_CONVERSATION_NOUNS = ["thread", "conversation", "session", "rollout"] as const;

/** Nested `cause` levels inspected; typed errors usually wrap the native error once or twice. */
const MAX_CAUSE_DEPTH = 4;

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

function namesMissingNoun(text: string, noun: string): boolean {
  if (!text.includes(noun)) return false;
  return (
    text.includes("not found") ||
    text.includes("does not exist") ||
    text.includes(`missing ${noun}`) ||
    text.includes(`no such ${noun}`) ||
    text.includes(`unknown ${noun}`) ||
    text.includes(`no ${noun} found`)
  );
}

/**
 * Whether one text names a missing conversation: it mentions one of `nouns`
 * together with a missing-resource phrase ("not found", "does not exist",
 * "no such thread", "No conversation found", ...).
 */
export function isMissingConversationText(
  text: string,
  nouns: ReadonlyArray<string> = DEFAULT_CONVERSATION_NOUNS,
): boolean {
  const normalized = text.toLowerCase();
  return nouns.some((noun) => namesMissingNoun(normalized, noun));
}

/**
 * Whether an error (its `detail`, `message` or a nested `cause`) says the
 * provider could not find the conversation it was asked to resume.
 */
export function isMissingConversationError(
  error: unknown,
  nouns: ReadonlyArray<string> = DEFAULT_CONVERSATION_NOUNS,
): boolean {
  return errorTexts(error).some((text) => isMissingConversationText(text, nouns));
}
