import type { InboxSection, InboxThreadRow } from "../inbox/inboxModel";
import type { SearchResult } from "./searchModel";

/** Most thread results a scope lists; the nodes' message search asks for twenty too. */
export const THREAD_SEARCH_RESULT_LIMIT = 20;

/** Every row of the inbox's sections, in list order (pinned and active first). */
export function inboxRowsOf(sections: ReadonlyArray<InboxSection>): ReadonlyArray<InboxThreadRow> {
  return sections.flatMap((section) => section.rows);
}

/** Where a thread lives, and the chat that delegated it when it is a delegated task. */
function placeOf(row: InboxThreadRow, extra?: string): string {
  return [row.projectLabel, row.parentTitle ? `from ${row.parentTitle}` : null, extra]
    .filter(Boolean)
    .join(" · ");
}

/** A thread whose title, project or branch matched: a Chats result. */
export function chatSearchResult(input: {
  readonly row: InboxThreadRow;
  readonly age: string;
  readonly open: () => void;
}): SearchResult {
  const { row } = input;
  const detail = placeOf(row, row.statusLabel);
  return {
    key: row.key,
    scope: "chats",
    icon: row.state === "needs-input" ? "exclamationmark.bubble" : "bubble.left",
    title: row.title,
    detail,
    trailing: input.age,
    accessibilityLabel: `${row.title}, ${detail}, ${input.age}`,
    open: input.open,
  };
}

/** A thread with a message that matched: a Messages result, opened at that message. */
export function messageSearchResult(input: {
  readonly row: InboxThreadRow;
  readonly snippet: string;
  readonly age: string;
  readonly open: () => void;
}): SearchResult {
  const { row } = input;
  return {
    key: row.key,
    scope: "messages",
    icon: "text.bubble",
    title: row.title,
    detail: placeOf(row),
    snippet: input.snippet,
    trailing: input.age,
    accessibilityLabel: `${row.title}, message: ${input.snippet}, ${input.age}`,
    open: input.open,
  };
}
