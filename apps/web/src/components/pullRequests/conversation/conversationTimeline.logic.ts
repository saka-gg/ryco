import type {
  ChangeRequestReviewThread,
  ChangeRequestTimelineItem,
  SourceControlCommentReaction,
  SourceControlCommentReactionContent,
} from "@ryco/contracts";
import type {
  ChangeRequestChecksOverall,
  ChangeRequestTimelineDisplay,
  ChangeRequestTimelineGroup,
} from "@ryco/client-runtime/state/pull-request-review";
import { DateTime } from "effect";

/**
 * Pure helpers behind the Conversation timeline: how grouped activity and
 * stray review threads interleave, how commit check states map onto the
 * page's glyphs, and how a cross-reference resolves to a pull request here.
 */

export type ConversationTimelineEntry =
  | { readonly kind: "group"; readonly id: string; readonly group: ChangeRequestTimelineGroup }
  /** A review thread no timeline review claims (its review fell outside a truncated timeline). */
  | {
      readonly kind: "thread";
      readonly id: string;
      readonly thread: ChangeRequestReviewThread;
    };

function threadStartedAt(thread: ChangeRequestReviewThread): number {
  const first = thread.comments[0];
  return first ? DateTime.toEpochMillis(first.createdAt) : Number.POSITIVE_INFINITY;
}

/**
 * The timeline in display order: grouped activity, oldest first, with each
 * unattached thread placed where its first comment was written. Minor-event
 * runs that net out to nothing are dropped.
 */
export function buildConversationTimeline(
  display: ChangeRequestTimelineDisplay,
): ReadonlyArray<ConversationTimelineEntry> {
  const groups = display.groups.filter(
    (group) => group.kind !== "events" || !group.summary.isEmpty,
  );
  const threads = display.unattachedThreads.toSorted(
    (left, right) => threadStartedAt(left) - threadStartedAt(right),
  );
  const entries: ConversationTimelineEntry[] = [];
  let threadIndex = 0;
  for (const group of groups) {
    const at = DateTime.toEpochMillis(group.createdAt);
    while (threadIndex < threads.length && threadStartedAt(threads[threadIndex]!) < at) {
      const thread = threads[threadIndex]!;
      entries.push({ kind: "thread", id: `thread:${thread.id}`, thread });
      threadIndex += 1;
    }
    entries.push({ kind: "group", id: group.id, group });
  }
  for (const thread of threads.slice(threadIndex)) {
    entries.push({ kind: "thread", id: `thread:${thread.id}`, thread });
  }
  return entries;
}

type CommitCheckState = Extract<ChangeRequestTimelineItem, { kind: "commit" }>["checkState"];

/** A commit's check rollup in the page's glyph vocabulary (`null`: the host reported none). */
export function commitChecksOverall(state: CommitCheckState): ChangeRequestChecksOverall | null {
  switch (state) {
    case "success":
      return "passing";
    case "failure":
      return "failing";
    case "pending":
      return "pending";
    case "neutral":
      return "none";
    case undefined:
      return null;
  }
}

/**
 * The pull request number a cross-reference points at, when it is a pull
 * request in the same repository as `currentUrl` (so it can open in place).
 */
export function sameRepositoryPullNumber(
  sourceUrl: string,
  currentUrl: string | null | undefined,
): number | null {
  if (!currentUrl) return null;
  const base = /^(.*)\/pull\/\d+(?:[/?#].*)?$/u.exec(currentUrl)?.[1];
  if (!base) return null;
  const match = /^(.*)\/pull\/(\d+)(?:[/?#].*)?$/u.exec(sourceUrl);
  if (!match || match[1]?.toLowerCase() !== base.toLowerCase()) return null;
  const number = Number(match[2]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * Reactions after the viewer toggles `content`: adds their reaction, or takes
 * it back (dropping the entry when nobody else reacted that way).
 */
export function toggleCommentReaction(
  reactions: ReadonlyArray<SourceControlCommentReaction> | undefined,
  content: SourceControlCommentReactionContent,
): ReadonlyArray<SourceControlCommentReaction> {
  const current = reactions ?? [];
  const existing = current.find((reaction) => reaction.content === content);
  if (!existing) return [...current, { content, count: 1, viewerHasReacted: true }];
  const reacted = existing.viewerHasReacted === true;
  const count = reacted ? existing.count - 1 : existing.count + 1;
  return count <= 0
    ? current.filter((reaction) => reaction !== existing)
    : current.map((reaction) =>
        reaction === existing
          ? { content: reaction.content, count, viewerHasReacted: !reacted }
          : reaction,
      );
}
