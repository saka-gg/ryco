/**
 * `@` and `#` completion in pull request text fields: which token the cursor
 * is in, which suggestions match it, and the text after one is picked.
 */

export type CompletionTrigger = "@" | "#";

export interface CompletionToken {
  readonly trigger: CompletionTrigger;
  /** What follows the trigger, up to the cursor. */
  readonly query: string;
  /** Index of the trigger character. */
  readonly start: number;
  /** The cursor (end of the token). */
  readonly end: number;
}

const TOKEN = /(^|[\s([{])([@#])([\w.-]*)$/u;
const MAX_QUERY = 40;

/** The token being typed at the cursor, or null outside one. */
export function completionTokenAt(text: string, cursor: number): CompletionToken | null {
  const before = text.slice(0, Math.max(0, Math.min(cursor, text.length)));
  const match = TOKEN.exec(before);
  if (match === null) return null;
  const query = match[3] ?? "";
  if (query.length > MAX_QUERY) return null;
  const trigger = match[2] as CompletionTrigger;
  return { trigger, query, start: before.length - query.length - 1, end: before.length };
}

export interface CompletionSuggestion {
  readonly key: string;
  /** What replaces the token, trigger included: `@octocat`, `#42`. */
  readonly insert: string;
  readonly title: string;
  readonly detail: string | null;
}

/** The text with the token replaced by the suggestion and a space, and the new cursor. */
export function applyCompletion(
  text: string,
  token: CompletionToken,
  suggestion: Pick<CompletionSuggestion, "insert">,
): { readonly text: string; readonly cursor: number } {
  const after = text.slice(token.end);
  const spacer = after.startsWith(" ") ? "" : " ";
  const next = `${text.slice(0, token.start)}${suggestion.insert}${spacer}${after}`;
  return { text: next, cursor: token.start + suggestion.insert.length + 1 };
}

export const COMPLETION_LIMIT = 6;

/** People for `@`: login prefix matches first, then display-name and substring matches. */
export function rankPeople(
  people: ReadonlyArray<{ readonly login: string; readonly displayName?: string | undefined }>,
  query: string,
): ReadonlyArray<CompletionSuggestion> {
  const needle = query.toLowerCase();
  const scored: Array<{ readonly score: number; readonly suggestion: CompletionSuggestion }> = [];
  for (const person of people) {
    const login = person.login.toLowerCase();
    const name = person.displayName?.toLowerCase() ?? "";
    const score =
      needle.length === 0 || login.startsWith(needle)
        ? 0
        : name.split(/\s+/u).some((part) => part.startsWith(needle))
          ? 1
          : login.includes(needle) || name.includes(needle)
            ? 2
            : -1;
    if (score < 0) continue;
    scored.push({
      score,
      suggestion: {
        key: `@${person.login}`,
        insert: `@${person.login}`,
        title: person.login,
        detail: person.displayName ?? null,
      },
    });
  }
  return scored
    .toSorted(
      (left, right) =>
        left.score - right.score || left.suggestion.title.localeCompare(right.suggestion.title),
    )
    .slice(0, COMPLETION_LIMIT)
    .map((entry) => entry.suggestion);
}

/** Issues and pull requests for `#`: a number prefix or words of the title. */
export function rankReferences(
  items: ReadonlyArray<{
    readonly number: number;
    readonly title: string;
    readonly kind: "issue" | "pull request";
  }>,
  query: string,
): ReadonlyArray<CompletionSuggestion> {
  const needle = query.toLowerCase();
  const seen = new Set<number>();
  const matches: CompletionSuggestion[] = [];
  for (const item of items) {
    if (seen.has(item.number)) continue;
    const hit =
      needle.length === 0 ||
      String(item.number).startsWith(needle) ||
      item.title.toLowerCase().includes(needle);
    if (!hit) continue;
    seen.add(item.number);
    matches.push({
      key: `#${item.number}`,
      insert: `#${item.number}`,
      title: item.title,
      detail: `#${item.number} · ${item.kind}`,
    });
    if (matches.length >= COMPLETION_LIMIT) break;
  }
  return matches;
}
