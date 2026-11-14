/** The thread message search's occurrences, merged from loaded messages and the server's results. */
import type { MessageId, OrchestrationThreadMessageSearchResult } from "@ryco/contracts";

import type { ThreadMessageSearchOccurrence } from "./chat/ThreadMessageSearch.logic";

/**
 * The search's occurrences: those in loaded messages, then one per server
 * result whose message is not loaded yet.
 */
export function mergeThreadMessageSearchOccurrences(
  loadedThreadMessageSearchOccurrences: ReadonlyArray<ThreadMessageSearchOccurrence>,
  serverThreadMessageSearchResults: ReadonlyArray<OrchestrationThreadMessageSearchResult>,
  threadMessageSearchQuery: string,
): ThreadMessageSearchOccurrence[] {
  const loadedMessageIds = new Set(
    loadedThreadMessageSearchOccurrences.map((occurrence) => occurrence.messageId),
  );
  const unloadedOccurrences: ThreadMessageSearchOccurrence[] = [];
  for (const result of serverThreadMessageSearchResults) {
    if (loadedMessageIds.has(result.messageId)) continue;
    unloadedOccurrences.push({
      id: `server:${result.messageId}`,
      messageId: result.messageId,
      occurrenceIndex: loadedThreadMessageSearchOccurrences.length + unloadedOccurrences.length,
      messageOccurrenceIndex: 0,
      start: 0,
      end: 0,
      text: threadMessageSearchQuery.trim(),
    });
  }
  return [...loadedThreadMessageSearchOccurrences, ...unloadedOccurrences];
}

/** The open search's occurrences per message; none while the search is closed. */
export function groupThreadMessageSearchOccurrences(
  threadMessageSearchOccurrences: ReadonlyArray<ThreadMessageSearchOccurrence>,
  threadMessageSearchOpen: boolean,
) {
  if (!threadMessageSearchOpen) {
    return new Map<MessageId, ReadonlyArray<ThreadMessageSearchOccurrence>>();
  }

  const byMessageId = new Map<MessageId, ThreadMessageSearchOccurrence[]>();
  for (const occurrence of threadMessageSearchOccurrences) {
    const existing = byMessageId.get(occurrence.messageId);
    if (existing) {
      existing.push(occurrence);
    } else {
      byMessageId.set(occurrence.messageId, [occurrence]);
    }
  }
  return byMessageId;
}
