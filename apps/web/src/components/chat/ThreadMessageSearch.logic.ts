import type { MessageId } from "@ryco/contracts";
import type { TimelineEntry } from "../../session-logic";
import { deriveDisplayedUserMessage } from "../../lib/userMessageDisplay";

export interface ThreadMessageSearchOccurrence {
  id: string;
  messageId: MessageId;
  occurrenceIndex: number;
  messageOccurrenceIndex: number;
  start: number;
  end: number;
  text: string;
}

export type ThreadMessageSearchDirection = "next" | "previous";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createThreadMessageSearchMatcher(query: string): RegExp | null {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) {
    return null;
  }

  const source = trimmedQuery
    .split(/(\s+)/)
    .map((part) => (/\s+/.test(part) ? "\\s+" : escapeRegExp(part)))
    .join("");
  return new RegExp(source, "gi");
}

function searchableMessageText(entry: Extract<TimelineEntry, { kind: "message" }>): string {
  if (entry.message.role === "user") {
    return deriveDisplayedUserMessage(entry.message.text).visibleText;
  }
  return entry.message.text;
}

export function buildThreadMessageSearchOccurrences(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  query: string;
}): ThreadMessageSearchOccurrence[] {
  const matcher = createThreadMessageSearchMatcher(input.query);
  if (!matcher) {
    return [];
  }

  const occurrences: ThreadMessageSearchOccurrence[] = [];
  for (const entry of input.timelineEntries) {
    if (entry.kind !== "message") {
      continue;
    }
    if (entry.message.role !== "user" && entry.message.role !== "assistant") {
      continue;
    }
    const text = searchableMessageText(entry);
    let messageOccurrenceIndex = 0;
    matcher.lastIndex = 0;
    for (const match of text.matchAll(matcher)) {
      const start = match.index ?? 0;
      const value = match[0] ?? "";
      if (value.length === 0) {
        continue;
      }
      const end = start + value.length;
      const id = `${entry.message.id}:${start}:${end}:${messageOccurrenceIndex}`;
      occurrences.push({
        id,
        messageId: entry.message.id,
        occurrenceIndex: occurrences.length,
        messageOccurrenceIndex,
        start,
        end,
        text: value,
      });
      messageOccurrenceIndex += 1;
    }
  }
  return occurrences;
}

export function clampThreadMessageSearchIndex(index: number, matchCount: number): number {
  if (matchCount <= 0) {
    return 0;
  }
  return Math.min(Math.max(0, index), matchCount - 1);
}

export function moveThreadMessageSearchIndex(input: {
  currentIndex: number;
  matchCount: number;
  direction: ThreadMessageSearchDirection;
}): number {
  if (input.matchCount <= 0) {
    return 0;
  }
  if (input.direction === "previous") {
    return (input.currentIndex - 1 + input.matchCount) % input.matchCount;
  }
  return (input.currentIndex + 1) % input.matchCount;
}
