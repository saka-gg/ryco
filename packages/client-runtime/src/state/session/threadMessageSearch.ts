/**
 * Find in a chat: how a query matches message text (whitespace runs match any whitespace, the rest
 * literally, case-insensitive) and how next/previous walk the matches. Web's find bar and the
 * phone's share these.
 */

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
