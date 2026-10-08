/**
 * Plain-text conventions of a note body (prototype `stripTodo` / `inline`):
 * a leading `[ ]` / `[x]` makes the note a todo, and backtick spans render as
 * inline code. Bodies are stored verbatim; these helpers only read them.
 */

// The todo convention is shared with every client; this module adds the inline-code split.
export {
  noteSummaryText,
  parseNoteTodo,
  toggleNoteTodo,
  type NoteTodoState,
  type ParsedNoteTodo,
} from "@ryco/client-runtime/state/notes";

export interface NoteTextSegment {
  readonly kind: "text" | "code";
  readonly text: string;
}

/** Splits text into plain runs and `code` spans (an unpaired backtick stays literal). */
export function splitInlineCode(text: string): ReadonlyArray<NoteTextSegment> {
  const segments: NoteTextSegment[] = [];
  const pattern = /`([^`]+)`/g;
  let cursor = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > cursor)
      segments.push({ kind: "text", text: text.slice(cursor, match.index) });
    segments.push({ kind: "code", text: match[1]! });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}

/**
 * A note's age (prototype `ago`): "now" under 45 seconds (clock skew lands
 * there too), then the nearest whole minute, hour or day.
 */
export function formatNoteAge(isoDate: string, nowMs: number = Date.now()): string {
  const seconds = (nowMs - Date.parse(isoDate)) / 1000;
  if (!(seconds >= 45)) return "now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}
