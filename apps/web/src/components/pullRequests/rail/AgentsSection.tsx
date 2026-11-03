import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import {
  isUnarchivedThreadEntry,
  type PullRequestWatchTone,
  type SidebarThreadOrStub,
  type SidebarThreadSummary,
} from "@ryco/client-runtime/state/threads";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { cn } from "../../../lib/utils";
import {
  selectSidebarThreadsForProjectRef,
  selectSidebarWorktreesForProjectRef,
  useStore,
  type AppState,
} from "../../../store";
import { ThreadLinkList } from "../../threads/ThreadLinkList";
import { Switch } from "../../ui/switch";
import { SectionLabel } from "../primitives";
import { usePullRequestSelection, usePullRequestsPage } from "../PullRequestsPageContext";
import { linkedAgentThreads, pullRequestWatchThread } from "./agentThreads.logic";
import { usePullRequestWatchControl } from "../../../rpc/useSourceControl";

const EMPTY_THREADS: ReadonlyArray<SidebarThreadOrStub> = [];

function usePageProjectRef() {
  const { repository } = usePullRequestsPage();
  return useMemo(
    () => (repository ? scopeProjectRef(repository.environmentId, repository.projectId) : null),
    [repository],
  );
}

/** The sidebar's workspaces of the page's project. */
function useProjectWorktrees() {
  const projectRef = usePageProjectRef();
  return useStore(
    useShallow(
      useMemo(
        () => (state: AppState) =>
          projectRef ? selectSidebarWorktreesForProjectRef(state, projectRef) : [],
        [projectRef],
      ),
    ),
  );
}

/**
 * Agent threads working on this pull request (hand-offs from this page, or
 * any thread on its worktree or, for same-repository heads, its head branch).
 * Rows open the thread. Absent when there are none: agent work never gets an
 * empty placeholder.
 */
export function useLinkedAgentThreads(): ReadonlyArray<SidebarThreadSummary> {
  const selection = usePullRequestSelection();
  const projectRef = usePageProjectRef();
  const threads = useStore(
    useShallow(
      useMemo(
        () => (state: AppState) =>
          projectRef ? selectSidebarThreadsForProjectRef(state, projectRef) : EMPTY_THREADS,
        [projectRef],
      ),
    ),
  );
  const worktrees = useProjectWorktrees();
  const pullRequest = selection.detail.data ?? selection.summary;
  const headRefName = pullRequest?.headRefName ?? null;
  const isCrossRepository = pullRequest?.isCrossRepository;
  return useMemo(
    () =>
      linkedAgentThreads({
        // Only unarchived threads are linked; archived ones may be stubs.
        threads: threads.filter(isUnarchivedThreadEntry),
        worktrees,
        link: { number: selection.number, headRefName, isCrossRepository },
      }),
    [headRefName, isCrossRepository, selection.number, threads, worktrees],
  );
}

export function AgentsSection(props: {
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly layout: "rail" | "band";
}) {
  if (props.threads.length === 0) return null;
  const rows = props.layout === "band" ? props.threads.slice(0, 1) : props.threads;
  return (
    <section
      aria-label="Agents"
      className={cn("flex min-w-0 flex-col", props.layout === "rail" && "gap-1")}
    >
      {props.layout === "rail" ? <SectionLabel className="h-6">Agents</SectionLabel> : null}
      <ThreadLinkList threads={rows} tone={props.layout} />
      {props.layout === "rail" ? <PullRequestWatchRow threads={props.threads} /> : null}
    </section>
  );
}

const TONE_CLASS: Record<PullRequestWatchTone, string> = {
  muted: "text-muted-foreground",
  active: "text-foreground",
  warning: "text-warning-foreground",
};

/**
 * The server-side watch of this pull request, for one linked thread: the
 * Auto-fix CI switch, what the watch is doing, Resume while Auto-fix CI is
 * paused and Stop watching while one is on, or why the last one ended.
 * Nothing on nodes without pull request watches.
 */
function PullRequestWatchRow(props: { readonly threads: ReadonlyArray<SidebarThreadSummary> }) {
  const { repository } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  const worktrees = useProjectWorktrees();
  const pullRequest = selection.detail.data ?? selection.summary;
  const url = pullRequest?.url ?? null;
  const target = useMemo(() => ({ number: selection.number, url }), [selection.number, url]);
  const thread = useMemo(
    () => pullRequestWatchThread({ threads: props.threads, worktrees, target }),
    [props.threads, target, worktrees],
  );
  const control = usePullRequestWatchControl({
    environmentId: repository?.environmentId ?? null,
    threadId: thread?.id ?? null,
    target: thread ? target : null,
    watches: thread?.pullRequestWatches,
    closed: pullRequest?.state === "merged" || pullRequest?.state === "closed",
  });
  if (!control.supported || thread === null) return null;
  // A merged or closed pull request only says why its watch ended, if it had one.
  if (!control.switchOffered && control.endedLabel === null) return null;
  const { view } = control;
  const disabled = !control.ready || control.pending;
  return (
    <div className="mt-2 flex min-w-0 flex-col gap-1" data-slot="pull-request-watch">
      {control.switchOffered ? (
        <div className="flex h-7 min-w-0 items-center gap-2 text-[13px] text-foreground/90">
          <span className="min-w-0 flex-1 truncate" aria-hidden>
            Auto-fix CI
          </span>
          <Switch
            checked={control.autoFixChecked}
            disabled={disabled}
            aria-label="Auto-fix CI"
            title={control.ready ? undefined : "Reconnect to change Auto-fix CI"}
            onCheckedChange={(checked) => control.run(checked ? "auto-fix-on" : "auto-fix-off")}
          />
        </div>
      ) : null}
      {view ? (
        <>
          <p className={cn("text-xs leading-relaxed", TONE_CLASS[view.tone])}>{view.label}</p>
          {view.detail ? (
            <p className="text-xs leading-relaxed text-muted-foreground">{view.detail}</p>
          ) : null}
        </>
      ) : control.endedLabel ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{control.endedLabel}</p>
      ) : null}
      {/* Several linked threads: the switch names the one it acts for, before it is on too. */}
      {props.threads.length > 1 ? (
        <p className="truncate text-[11px] text-muted-foreground">For {thread.title}</p>
      ) : null}
      {view ? (
        <div className="flex min-w-0 items-center gap-3">
          {view.paused ? (
            <WatchTextButton disabled={disabled} onClick={() => control.run("resume")}>
              Resume
            </WatchTextButton>
          ) : null}
          <WatchTextButton disabled={disabled} onClick={() => control.run("stop")}>
            Stop watching
          </WatchTextButton>
        </div>
      ) : null}
    </div>
  );
}

function WatchTextButton(props: {
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: string;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className="self-start rounded-sm text-xs text-muted-foreground underline-offset-2 outline-hidden hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60 disabled:hover:no-underline"
    >
      {props.children}
    </button>
  );
}
