import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { SidebarThreadSummary } from "@ryco/client-runtime/state/threads";
import { useRouter } from "@tanstack/react-router";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { cn } from "../../../lib/utils";
import {
  selectSidebarThreadsForProjectRef,
  selectSidebarWorktreesForProjectRef,
  useStore,
  type AppState,
} from "../../../store";
import { buildThreadRouteParams } from "../../../threadRoutes";
import { resolveInboxGlyph, inboxGlyphLabel } from "../../inboxSidebar/inboxRowPresentation";
import { resolveInboxThreadStatus } from "../../inboxSidebar/inboxSidebarModel";
import { InboxStatusGlyph } from "../../inboxSidebar/InboxStatusGlyph";
import { RelativeTime, SectionLabel } from "../primitives";
import { usePullRequestSelection, usePullRequestsPage } from "../PullRequestsPageContext";
import { agentThreadActivityAt, linkedAgentThreads } from "./agentThreads.logic";

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
  const router = useRouter({ warn: false });
  if (props.threads.length === 0) return null;
  const open = (thread: SidebarThreadSummary) => {
    if (!router) return;
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
    });
  };
  const rows = props.layout === "band" ? props.threads.slice(0, 1) : props.threads;
  return (
    <section
      aria-label="Agents"
      className={cn("flex min-w-0 flex-col", props.layout === "rail" && "gap-1")}
    >
      {props.layout === "rail" ? <SectionLabel className="h-6">Agents</SectionLabel> : null}
      {rows.map((thread) => {
        const status = resolveInboxThreadStatus(thread);
        const glyph = resolveInboxGlyph(status, false);
        return (
          <button
            key={thread.id}
            type="button"
            disabled={!router}
            onClick={() => open(thread)}
            className={cn(
              "group/agent flex h-7 min-w-0 items-center gap-2 rounded-md text-left outline-hidden transition-colors duration-(--app-motion-duration-chip) focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
              props.layout === "rail"
                ? "-mx-1.5 px-1.5 hover:bg-accent/50"
                : "-mx-1.5 px-1.5 hover:bg-accent/60",
            )}
          >
            <InboxStatusGlyph key={glyph} kind={glyph} label={inboxGlyphLabel(status, false)} />
            <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">
              {thread.title}
            </span>
            <RelativeTime
              value={agentThreadActivityAt(thread)}
              className="text-xs text-muted-foreground"
            />
          </button>
        );
      })}
    </section>
  );
}
