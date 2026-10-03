import type {
  ChangeRequestActor,
  ChangeRequestReviewThread,
  ChangeRequestTimelineItem,
  SourceControlLabel,
} from "@ryco/contracts";
import type { DateTime } from "effect";

import { epochMillis } from "./internal.ts";

type TimelineOf<K extends ChangeRequestTimelineItem["kind"]> = Extract<
  ChangeRequestTimelineItem,
  { readonly kind: K }
>;

export type ChangeRequestTimelineCommitItem = TimelineOf<"commit">;
export type ChangeRequestTimelineReviewItem = TimelineOf<"review">;

const MINOR_KINDS = [
  "labeled",
  "unlabeled",
  "assigned",
  "unassigned",
  "review-requested",
  "review-request-removed",
] as const;
type MinorKind = (typeof MINOR_KINDS)[number];
export type ChangeRequestTimelineMinorItem = TimelineOf<MinorKind>;
export type ChangeRequestTimelineOtherItem = Exclude<
  ChangeRequestTimelineItem,
  ChangeRequestTimelineCommitItem | ChangeRequestTimelineReviewItem | ChangeRequestTimelineMinorItem
>;

export interface ChangeRequestReviewerChange {
  readonly reviewer: string;
  readonly reviewerKind: "user" | "team" | "bot";
}

/** Net effect of a run of minor events: an add undone within the run cancels out. */
export interface ChangeRequestTimelineEventSummary {
  readonly labelsAdded: ReadonlyArray<SourceControlLabel>;
  readonly labelsRemoved: ReadonlyArray<SourceControlLabel>;
  readonly assigned: ReadonlyArray<string>;
  readonly unassigned: ReadonlyArray<string>;
  readonly reviewRequested: ReadonlyArray<ChangeRequestReviewerChange>;
  readonly reviewRequestRemoved: ReadonlyArray<ChangeRequestReviewerChange>;
  /** Every change in the run was undone again within it. */
  readonly isEmpty: boolean;
}

export type ChangeRequestTimelineGroup =
  | {
      readonly kind: "commits";
      readonly id: string;
      readonly actor: ChangeRequestActor | null;
      /** Chronological; one or more. Render as "pushed N commits". */
      readonly commits: ReadonlyArray<ChangeRequestTimelineCommitItem>;
      readonly createdAt: DateTime.Utc;
      readonly lastAt: DateTime.Utc;
    }
  | {
      readonly kind: "events";
      readonly id: string;
      readonly actor: ChangeRequestActor | null;
      /** Labels, assignment, and review-request changes by one actor in a short window. */
      readonly events: ReadonlyArray<ChangeRequestTimelineMinorItem>;
      readonly summary: ChangeRequestTimelineEventSummary;
      readonly createdAt: DateTime.Utc;
      readonly lastAt: DateTime.Utc;
    }
  | {
      readonly kind: "review";
      readonly id: string;
      readonly review: ChangeRequestTimelineReviewItem;
      /** Threads this review opened, in the order the review lists them. */
      readonly threads: ReadonlyArray<ChangeRequestReviewThread>;
      readonly createdAt: DateTime.Utc;
    }
  | {
      readonly kind: "item";
      readonly id: string;
      readonly item: ChangeRequestTimelineOtherItem;
      readonly createdAt: DateTime.Utc;
    };

export interface ChangeRequestTimelineCounts {
  /** Conversation comments plus every comment inside review threads. */
  readonly comments: number;
  readonly reviews: number;
  readonly approvals: number;
  readonly changesRequested: number;
  readonly commits: number;
  readonly forcePushes: number;
  readonly threads: number;
  readonly unresolvedThreads: number;
  /** Unique actors in order of first appearance. */
  readonly participants: ReadonlyArray<ChangeRequestActor>;
}

export interface ChangeRequestTimelineDisplay {
  /** Chronological (oldest first), like the input. */
  readonly groups: ReadonlyArray<ChangeRequestTimelineGroup>;
  /** Threads no timeline review claims (e.g. their review fell outside a truncated timeline). */
  readonly unattachedThreads: ReadonlyArray<ChangeRequestReviewThread>;
  readonly counts: ChangeRequestTimelineCounts;
}

export interface GroupChangeRequestTimelineOptions {
  /** Max gap between two minor events of one actor that still share a line. Default 10 min. */
  readonly minorEventWindowMs?: number;
}

export const DEFAULT_MINOR_EVENT_WINDOW_MS = 10 * 60_000;

function isMinor(item: ChangeRequestTimelineItem): item is ChangeRequestTimelineMinorItem {
  return (MINOR_KINDS as ReadonlyArray<string>).includes(item.kind);
}

function actorKey(actor: ChangeRequestActor | null | undefined): string {
  return actor?.login.toLowerCase() ?? "";
}

/** Bot bookkeeping lives in HTML comments; a body of nothing else reads as empty. */
function hasVisibleBody(body: string): boolean {
  return body.replace(/<!--[\s\S]*?-->/gu, "").trim().length > 0;
}

function netChanges<T>(
  entries: ReadonlyArray<{ readonly key: string; readonly value: T; readonly delta: 1 | -1 }>,
): { readonly added: ReadonlyArray<T>; readonly removed: ReadonlyArray<T> } {
  const net = new Map<string, { value: T; total: number }>();
  for (const entry of entries) {
    const current = net.get(entry.key);
    net.set(entry.key, {
      value: entry.value,
      total: Math.max(-1, Math.min(1, (current?.total ?? 0) + entry.delta)),
    });
  }
  const added: T[] = [];
  const removed: T[] = [];
  for (const { value, total } of net.values()) {
    if (total > 0) added.push(value);
    else if (total < 0) removed.push(value);
  }
  return { added, removed };
}

export function summarizeTimelineEvents(
  events: ReadonlyArray<ChangeRequestTimelineMinorItem>,
): ChangeRequestTimelineEventSummary {
  const labels: Array<{ key: string; value: SourceControlLabel; delta: 1 | -1 }> = [];
  const assignees: Array<{ key: string; value: string; delta: 1 | -1 }> = [];
  const reviewers: Array<{ key: string; value: ChangeRequestReviewerChange; delta: 1 | -1 }> = [];
  for (const event of events) {
    switch (event.kind) {
      case "labeled":
      case "unlabeled":
        labels.push({
          key: event.label.name.toLowerCase(),
          value: event.label,
          delta: event.kind === "labeled" ? 1 : -1,
        });
        break;
      case "assigned":
      case "unassigned":
        assignees.push({
          key: event.assignee.toLowerCase(),
          value: event.assignee,
          delta: event.kind === "assigned" ? 1 : -1,
        });
        break;
      case "review-requested":
      case "review-request-removed":
        reviewers.push({
          key: event.reviewer.toLowerCase(),
          value: { reviewer: event.reviewer, reviewerKind: event.reviewerKind },
          delta: event.kind === "review-requested" ? 1 : -1,
        });
        break;
    }
  }
  const label = netChanges(labels);
  const assignee = netChanges(assignees);
  const reviewer = netChanges(reviewers);
  return {
    labelsAdded: label.added,
    labelsRemoved: label.removed,
    assigned: assignee.added,
    unassigned: assignee.removed,
    reviewRequested: reviewer.added,
    reviewRequestRemoved: reviewer.removed,
    isEmpty:
      label.added.length +
        label.removed.length +
        assignee.added.length +
        assignee.removed.length +
        reviewer.added.length +
        reviewer.removed.length ===
      0,
  };
}

/**
 * Turns the activity timeline into display groups:
 * - consecutive commits by one actor collapse into one "pushed N commits"
 *   group; any other item (a force-push included) ends the run;
 * - runs of label / assignee / review-request changes by one actor, each
 *   within `minorEventWindowMs` of the previous, collapse into one line with a
 *   net summary;
 * - reviews carry the threads they opened (each thread nests once, under the
 *   first review that lists it); a commented review with no visible body and
 *   no threads (a bare thread reply) is dropped;
 * - everything else stays a standalone item.
 */
export function groupChangeRequestTimeline(
  items: ReadonlyArray<ChangeRequestTimelineItem>,
  threads: ReadonlyArray<ChangeRequestReviewThread>,
  options?: GroupChangeRequestTimelineOptions,
): ChangeRequestTimelineDisplay {
  const windowMs = options?.minorEventWindowMs ?? DEFAULT_MINOR_EVENT_WINDOW_MS;
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const claimedThreadIds = new Set<string>();
  const groups: ChangeRequestTimelineGroup[] = [];
  const participants = new Map<string, ChangeRequestActor>();
  let comments = 0;
  let reviews = 0;
  let approvals = 0;
  let changesRequested = 0;
  let commits = 0;
  let forcePushes = 0;

  const noteActor = (actor: ChangeRequestActor | undefined) => {
    if (actor && !participants.has(actorKey(actor))) participants.set(actorKey(actor), actor);
  };

  for (const item of items) {
    noteActor(item.actor);
    const previous = groups.at(-1);

    if (item.kind === "commit") {
      commits += 1;
      if (previous?.kind === "commits" && actorKey(previous.actor) === actorKey(item.actor)) {
        groups[groups.length - 1] = {
          ...previous,
          commits: [...previous.commits, item],
          lastAt: item.createdAt,
        };
      } else {
        groups.push({
          kind: "commits",
          id: `commits:${item.id}`,
          actor: item.actor ?? null,
          commits: [item],
          createdAt: item.createdAt,
          lastAt: item.createdAt,
        });
      }
      continue;
    }

    if (isMinor(item)) {
      const previousAt = previous?.kind === "events" ? epochMillis(previous.lastAt) : null;
      const at = epochMillis(item.createdAt);
      if (
        previous?.kind === "events" &&
        actorKey(previous.actor) === actorKey(item.actor) &&
        previousAt !== null &&
        at !== null &&
        at - previousAt <= windowMs
      ) {
        const events = [...previous.events, item];
        groups[groups.length - 1] = {
          ...previous,
          events,
          summary: summarizeTimelineEvents(events),
          lastAt: item.createdAt,
        };
      } else {
        groups.push({
          kind: "events",
          id: `events:${item.id}`,
          actor: item.actor ?? null,
          events: [item],
          summary: summarizeTimelineEvents([item]),
          createdAt: item.createdAt,
          lastAt: item.createdAt,
        });
      }
      continue;
    }

    if (item.kind === "review") {
      const nested: ChangeRequestReviewThread[] = [];
      for (const threadId of item.threadIds) {
        const thread = threadsById.get(threadId);
        if (!thread || claimedThreadIds.has(threadId)) continue;
        claimedThreadIds.add(threadId);
        nested.push(thread);
      }
      if (item.state === "commented" && nested.length === 0 && !hasVisibleBody(item.body)) {
        continue;
      }
      reviews += 1;
      if (item.state === "approved") approvals += 1;
      if (item.state === "changes_requested") changesRequested += 1;
      if (hasVisibleBody(item.body)) comments += 1;
      groups.push({
        kind: "review",
        id: item.id,
        review: item,
        threads: nested,
        createdAt: item.createdAt,
      });
      continue;
    }

    if (item.kind === "comment") comments += 1;
    if (item.kind === "force-pushed") forcePushes += 1;
    groups.push({ kind: "item", id: item.id, item, createdAt: item.createdAt });
  }

  let unresolvedThreads = 0;
  for (const thread of threads) {
    comments += thread.totalComments;
    if (!thread.isResolved) unresolvedThreads += 1;
    for (const comment of thread.comments) noteActor(comment.author);
  }

  return {
    groups,
    unattachedThreads: threads.filter((thread) => !claimedThreadIds.has(thread.id)),
    counts: {
      comments,
      reviews,
      approvals,
      changesRequested,
      commits,
      forcePushes,
      threads: threads.length,
      unresolvedThreads,
      participants: [...participants.values()],
    },
  };
}
