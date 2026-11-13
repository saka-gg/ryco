/**
 * The provider's predicted next prompt (Claude's `prompt_suggestion`, Codex's `thread/sample`),
 * kept as one latest-state activity per thread: the server's runtime ingestion writes it, every
 * client's composer reads it. Adapters normalize the text before it leaves them.
 *
 * Pure and import-free: runtime ingestion reads it on the server boot path.
 *
 * @module promptSuggestion
 */

/** The kind of the one latest-state activity per thread carrying the newest suggestion. */
export const PROMPT_SUGGESTION_ACTIVITY_KIND = "prompt.suggestion";

export interface PromptSuggestionActivityPayload {
  readonly suggestion: string;
}

/**
 * The suggestion as the composer offers it: trimmed, cut to `maxChars` (on a code point
 * boundary), or undefined when nothing is left. Providers reply with nothing when they see no
 * clear next step, and sometimes wrap the message in quotes.
 */
export function normalizePromptSuggestion(
  text: string | null | undefined,
  maxChars: number,
): string | undefined {
  if (typeof text !== "string") return undefined;
  let trimmed = text.trim();
  const quoted = /^(["'“‘])([\s\S]*)(["'”’])$/u.exec(trimmed);
  if (quoted && quoted[2] !== undefined && !/["“”]/u.test(quoted[2])) {
    trimmed = quoted[2].trim();
  }
  if (trimmed.length === 0) return undefined;
  if (trimmed.length <= maxChars) return trimmed;
  let cut = trimmed.slice(0, maxChars);
  // Never end on half a surrogate pair.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd() || undefined;
}

/** The suggestion text of an activity payload, or undefined when it carries none. */
export function readPromptSuggestionPayload(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const suggestion = (payload as { readonly suggestion?: unknown }).suggestion;
  return typeof suggestion === "string" && suggestion.trim().length > 0 ? suggestion : undefined;
}
