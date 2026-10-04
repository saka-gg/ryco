import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import type { SidebarThreadSummary } from "@ryco/client-runtime/state/threads";
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
import { SectionLabel } from "../primitives";
import { usePullRequestSelection, usePullRequestsPage } from "../PullRequestsPageContext";
import { linkedAgentThreads } from "./agentThreads.logic";

const EMPTY_THREADS: ReadonlyArray<SidebarThreadSummary> = [];

/**
 * Agent threads working on this pull request (hand-offs from this page, or
 * any thread on its worktree or, for same-repository heads, its head branch).
 * Rows open the thread. Absent when there are none: agent work never gets an
 * empty placeholder.
 */
export function useLinkedAgentThreads(): ReadonlyArray<SidebarThreadSummary> {
  const { repository } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  const projectRef = useMemo(
    () => (repository ? scopeProjectRef(repository.environmentId, repository.projectId) : null),
    [repository],
  );
  const threads = useStore(
    useShallow(
      useMemo(
        () => (state: AppState) =>
          projectRef ? selectSidebarThreadsForProjectRef(state, projectRef) : EMPTY_THREADS,
        [projectRef],
      ),
    ),
  );
  const worktrees = useStore(
    useShallow(
      useMemo(
        () => (state: AppState) =>
          projectRef ? selectSidebarWorktreesForProjectRef(state, projectRef) : [],
        [projectRef],
      ),
    ),
  );
  const pullRequest = selection.detail.data ?? selection.summary;
  const headRefName = pullRequest?.headRefName ?? null;
  const isCrossRepository = pullRequest?.isCrossRepository;
  return useMemo(
    () =>
      linkedAgentThreads({
        threads,
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
    </section>
  );
}
