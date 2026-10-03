import type {
  ChangeRequestActor,
  ChangeRequestTimelineItem,
  SourceControlChangeRequestCommit,
} from "@ryco/contracts";
import type { ChangeRequestChecksOverall } from "@ryco/client-runtime/state/pull-request-review";
import { DateTime } from "effect";

/**
 * The Commits tab: the change request's commits newest first, grouped by
 * local day, with force-pushes placed where they happened. The detail's
 * commit list is authoritative (a force-push can drop commits the timeline
 * still mentions); the timeline adds avatars and each commit's check rollup,
 * so rows never poll on their own.
 */

export interface CommitListCommit {
  readonly kind: "commit";
  readonly key: string;
  readonly oid: string;
  readonly shortOid: string;
  readonly headline: string;
  readonly author: string | null;
  readonly avatarUrl: string | null;
  readonly atMs: number | null;
  /** The commit's checks as the page's glyph; null when the host reports none. */
  readonly checks: ChangeRequestChecksOverall | null;
  readonly isHead: boolean;
}

export interface CommitListForcePush {
  readonly kind: "force-push";
  readonly key: string;
  readonly actor: string | null;
  readonly avatarUrl: string | null;
  readonly beforeOid: string | null;
  readonly afterOid: string | null;
  readonly atMs: number;
}

export type CommitListItem = CommitListCommit | CommitListForcePush;

export interface CommitDay {
  /** Local `yyyy-mm-dd`, or `undated`. */
  readonly key: string;
  /** Local midnight of the day; null for commits without a date. */
  readonly dayMs: number | null;
  readonly items: ReadonlyArray<CommitListItem>;
}

type TimelineCommit = Extract<ChangeRequestTimelineItem, { kind: "commit" }>;
type TimelineForcePush = Extract<ChangeRequestTimelineItem, { kind: "force-pushed" }>;

/** A timeline commit's check rollup as the page's checks glyph. */
export function commitChecksGlyph(
  state: TimelineCommit["checkState"],
): ChangeRequestChecksOverall | null {
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

function parseMillis(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function actorAvatar(actor: ChangeRequestActor | undefined, login: string | null): string | null {
  if (!actor?.avatarUrl || login === null) return null;
  return actor.login.toLowerCase() === login.toLowerCase() ? actor.avatarUrl : null;
}

function localDayKey(ms: number): { key: string; dayMs: number } {
  const date = new Date(ms);
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const month = String(day.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(day.getDate()).padStart(2, "0");
  return { key: `${day.getFullYear()}-${month}-${dayOfMonth}`, dayMs: day.getTime() };
}

export function buildCommitDays(input: {
  readonly commits: ReadonlyArray<SourceControlChangeRequestCommit> | null | undefined;
  readonly timeline: ReadonlyArray<ChangeRequestTimelineItem> | null | undefined;
  readonly headSha: string | null;
  readonly headChecks: ChangeRequestChecksOverall | null;
}): ReadonlyArray<CommitDay> {
  const timelineCommits = new Map<string, TimelineCommit>();
  const forcePushes: TimelineForcePush[] = [];
  for (const item of input.timeline ?? []) {
    if (item.kind === "commit") timelineCommits.set(item.oid, item);
    else if (item.kind === "force-pushed") forcePushes.push(item);
  }

  const base: ReadonlyArray<{
    oid: string;
    shortOid: string;
    headline: string;
    author: string | null;
    atMs: number | null;
  }> =
    input.commits && input.commits.length > 0
      ? input.commits.map((commit) => {
          const event = timelineCommits.get(commit.oid);
          return {
            oid: commit.oid,
            shortOid: commit.shortOid,
            headline: commit.messageHeadline,
            author: commit.author ?? event?.actor?.login ?? null,
            atMs:
              parseMillis(commit.committedDate) ??
              (event ? DateTime.toEpochMillis(event.createdAt) : null),
          };
        })
      : [...timelineCommits.values()].map((event) => ({
          oid: event.oid,
          shortOid: event.shortOid,
          headline: event.messageHeadline,
          author: event.actor?.login ?? null,
          atMs: DateTime.toEpochMillis(event.createdAt),
        }));

  const items: Array<{ item: CommitListItem; order: number }> = base.map((commit, index) => {
    const event = timelineCommits.get(commit.oid);
    const isHead = input.headSha !== null && commit.oid === input.headSha;
    return {
      order: index,
      item: {
        kind: "commit",
        key: commit.oid,
        oid: commit.oid,
        shortOid: commit.shortOid,
        headline: commit.headline,
        author: commit.author,
        avatarUrl: actorAvatar(event?.actor, commit.author),
        atMs: commit.atMs,
        // The live rollup speaks for the head; the timeline's snapshot can lag.
        checks:
          isHead && input.headChecks !== null && input.headChecks !== "none"
            ? input.headChecks
            : commitChecksGlyph(event?.checkState),
        isHead,
      },
    };
  });
  for (const push of forcePushes) {
    items.push({
      // Commits that share its timestamp were pushed by it, so they sort above it.
      order: -1,
      item: {
        kind: "force-push",
        key: push.id,
        actor: push.actor?.login ?? null,
        avatarUrl: push.actor?.avatarUrl ?? null,
        beforeOid: push.beforeOid ?? null,
        afterOid: push.afterOid ?? null,
        atMs: DateTime.toEpochMillis(push.createdAt),
      },
    });
  }

  // Newest first; undated commits keep their relative order at the end.
  const sorted = items.toSorted((left, right) => {
    const leftMs = left.item.atMs;
    const rightMs = right.item.atMs;
    if (leftMs === null || rightMs === null) {
      if (leftMs === rightMs) return right.order - left.order;
      return leftMs === null ? 1 : -1;
    }
    return rightMs - leftMs || right.order - left.order;
  });

  const days: Array<{ key: string; dayMs: number | null; items: CommitListItem[] }> = [];
  for (const { item } of sorted) {
    const day = item.atMs === null ? { key: "undated", dayMs: null } : localDayKey(item.atMs);
    const last = days[days.length - 1];
    if (last && last.key === day.key) last.items.push(item);
    else days.push({ key: day.key, dayMs: day.dayMs, items: [item] });
  }
  return days;
}

const WEEKDAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const DATE_WITH_YEAR_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** "Today", "Yesterday", "Mon, Sep 29", or "Sep 29, 2025" outside the current year. */
export function formatCommitDay(
  dayMs: number | null,
  nowMs: number,
  formats: { readonly weekday: Intl.DateTimeFormat; readonly withYear: Intl.DateTimeFormat } = {
    weekday: WEEKDAY_FORMAT,
    withYear: DATE_WITH_YEAR_FORMAT,
  },
): string {
  if (dayMs === null) return "Undated";
  const today = localDayKey(nowMs).dayMs;
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayMs === today) return "Today";
  if (dayMs === yesterday.getTime()) return "Yesterday";
  const sameYear = new Date(dayMs).getFullYear() === new Date(nowMs).getFullYear();
  return (sameYear ? formats.weekday : formats.withYear).format(new Date(dayMs));
}
