import { memo, useMemo, useState } from "react";

import { cn } from "../../../lib/utils";
import { Skeleton } from "../../ui/skeleton";
import { useTabScrollMemory } from "../checks/checksUi";
import { usePullRequestSelection, usePullRequestsPage } from "../PullRequestsPageContext";
import { CommitRow, ForcePushMarker } from "./CommitRow";
import { buildCommitDays, formatCommitDay, type CommitDay } from "./commitsModel";

/**
 * The Commits tab: every commit of the change request, newest first and
 * grouped by day, with force-pushes where they happened. Each row scopes
 * Files to its commit. Check glyphs come from the activity timeline (the
 * head's from the live rollup), so rows never poll on their own.
 */
export function CommitsTab() {
  const { model, nav } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  const detail = selection.detail.data;
  const timeline = selection.activity.data?.timeline;
  const days = useMemo(
    () =>
      buildCommitDays({
        commits: detail?.commits,
        timeline,
        headSha: selection.headSha,
        headChecks: selection.checks.overall,
      }),
    [detail?.commits, selection.checks.overall, selection.headSha, timeline],
  );
  const hasRows = days.length > 0;
  const loading =
    !hasRows &&
    ((selection.detail.isLoading && detail === null) ||
      (model.supportsReview && selection.activity.isLoading && !selection.activity.data));
  const failed = !hasRows && !loading && selection.detail.error !== null && detail === null;
  const { ref: scrollRef, onScroll } = useTabScrollMemory("commits", hasRows);
  const scopedCommit = nav.search.commit ?? null;
  const pullRequestUrl =
    model.provider?.kind === "github" ? (detail?.url ?? selection.summary?.url ?? null) : null;
  // Day names ("Today") are read against the time the tab opened.
  const [nowMs] = useState(() => Date.now());

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="h-full min-h-0 overflow-y-auto overscroll-contain"
    >
      <div className="mx-auto w-full max-w-[56rem] px-5 pt-1 pb-20">
        {loading ? (
          <CommitsSkeleton />
        ) : !hasRows ? (
          <p className="flex min-h-12 items-center pl-1 text-[13px] text-muted-foreground">
            {failed ? "Couldn't load the commits of this pull request." : "No commits."}
          </p>
        ) : (
          days.map((day) => (
            <CommitDayGroup
              key={day.key}
              day={day}
              label={formatCommitDay(day.dayMs, nowMs)}
              scopedCommit={scopedCommit}
              pullRequestUrl={pullRequestUrl}
              onScope={nav.scopeToCommit}
            />
          ))
        )}
      </div>
    </div>
  );
}

const CommitDayGroup = memo(function CommitDayGroup(props: {
  readonly day: CommitDay;
  readonly label: string;
  readonly scopedCommit: string | null;
  readonly pullRequestUrl: string | null;
  readonly onScope: (oid: string) => void;
}) {
  return (
    <section aria-label={props.label} className="pt-5 first:pt-3">
      <h3 className="flex h-6 items-center truncate pl-1 text-[11px] text-muted-foreground">
        {props.label}
      </h3>
      <ul className="border-t border-border/60">
        {props.day.items.map((item) =>
          item.kind === "commit" ? (
            <CommitRow
              key={item.key}
              commit={item}
              scoped={props.scopedCommit !== null && item.oid.startsWith(props.scopedCommit)}
              pullRequestUrl={props.pullRequestUrl}
              onScope={props.onScope}
            />
          ) : (
            <ForcePushMarker key={item.key} push={item} />
          ),
        )}
      </ul>
    </section>
  );
});

const SKELETON_ROWS = [
  { key: "a", width: "w-2/5" },
  { key: "b", width: "w-1/2" },
  { key: "c", width: "w-1/3" },
  { key: "d", width: "w-3/5" },
  { key: "e", width: "w-2/5" },
];

function CommitsSkeleton() {
  return (
    <div aria-busy aria-label="Loading commits" className="pt-3">
      <div className="flex h-6 items-center pl-1">
        <Skeleton className="h-2.5 w-14" />
      </div>
      <ul className="border-t border-border/60">
        {SKELETON_ROWS.map(({ key, width }) => (
          <li
            key={key}
            aria-hidden
            className="flex h-10 items-center gap-2.5 border-b border-border/60 pr-1 pl-1"
          >
            <Skeleton className="size-3.5 shrink-0 rounded-full" />
            <Skeleton className={cn("h-3", width)} />
            <span className="flex-1" />
            <Skeleton className="size-4 shrink-0 rounded-full" />
            <Skeleton className="h-2.5 w-12" />
            <Skeleton className="mr-8 h-2.5 w-6" />
          </li>
        ))}
      </ul>
    </div>
  );
}
