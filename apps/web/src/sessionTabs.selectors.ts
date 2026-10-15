import { scopeThreadRef, scopedThreadKey } from "@ryco/client-runtime/scoped";
import type { DraftThreadState } from "./composerDraftStore";
import {
  deriveStatusBucket,
  resolveThreadStatusPill,
  type SidebarStatusBucket,
} from "./components/Sidebar.logic";
import {
  DEFAULT_AGENT_TOKEN_MODE,
  isUnarchivedThreadEntry,
  type SidebarThreadOrStub,
  type SidebarThreadSummary,
} from "./types";

export interface SessionTabItem {
  key: string;
  title: string;
  bucket: SidebarStatusBucket;
}

export interface SessionTabsFilter {
  worktreeId: string | null | undefined;
  worktreePath: string | null | undefined;
}

// Adapt a composerDraftStore draft thread into the SidebarThreadSummary
// shape so the session-tabs selector can treat drafts and server threads
// uniformly. Mirrors adaptDraftThreadForSidebarTree in
// components/sidebar/sidebarTreeAdapters.ts.
export function draftThreadToSidebarSummary(draft: DraftThreadState): SidebarThreadSummary {
  return {
    id: draft.threadId,
    environmentId: draft.environmentId,
    projectId: draft.projectId,
    title: "Empty Session",
    interactionMode: draft.interactionMode,
    tokenMode: draft.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
    session: null,
    createdAt: draft.createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    updatedAt: draft.createdAt,
    latestTurn: null,
    branch: draft.branch,
    worktreePath: draft.worktreePath,
    manualStatusBucket: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

interface CachedItem {
  item: SessionTabItem;
  inputs: {
    title: string;
    bucket: SidebarStatusBucket;
  };
}

// Mirrors sidebar/hooks/useSidebarTree.ts's belongsToWorktree: prefer
// worktreeId match, fall back to worktreePath even when worktreeId is
// set but doesn't match the active session, and treat
// "no worktreePath, no worktreeId" as the main worktree (groups threads
// with worktreePath === null together).
function threadBelongsToFilter(thread: SidebarThreadSummary, filter: SessionTabsFilter): boolean {
  if (thread.worktreeId !== undefined && thread.worktreeId !== null && filter.worktreeId) {
    if (thread.worktreeId === filter.worktreeId) return true;
  }
  if (filter.worktreePath && thread.worktreePath === filter.worktreePath) {
    return true;
  }
  if (!filter.worktreeId && !filter.worktreePath) {
    return thread.worktreePath === null;
  }
  return false;
}

export function createSessionTabsSelector(): (
  threads: ReadonlyArray<SidebarThreadOrStub>,
  filter: SessionTabsFilter,
) => ReadonlyArray<SessionTabItem> {
  const cache = new Map<string, CachedItem>();
  let lastResult: ReadonlyArray<SessionTabItem> | null = null;

  return (threads, filter) => {
    const matching: SidebarThreadSummary[] = [];
    for (const thread of threads) {
      if (!isUnarchivedThreadEntry(thread)) continue;
      if (!threadBelongsToFilter(thread, filter)) continue;
      matching.push(thread);
    }
    matching.sort(
      (a, b) =>
        (Date.parse(b.updatedAt ?? b.createdAt ?? "") || 0) -
        (Date.parse(a.updatedAt ?? a.createdAt ?? "") || 0),
    );

    const seenKeys = new Set<string>();
    const items: SessionTabItem[] = [];
    let identical = lastResult !== null && lastResult.length === matching.length;
    for (let i = 0; i < matching.length; i += 1) {
      const thread = matching[i]!;
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      seenKeys.add(key);
      const bucket = deriveStatusBucket({
        manualBucket: thread.manualStatusBucket ?? null,
        statusPill: resolveThreadStatusPill({ thread }),
      });
      const cached = cache.get(key);
      let item: SessionTabItem;
      if (cached && cached.inputs.title === thread.title && cached.inputs.bucket === bucket) {
        item = cached.item;
      } else {
        item = { key, title: thread.title, bucket };
        cache.set(key, { item, inputs: { title: thread.title, bucket } });
      }
      items.push(item);
      if (identical && lastResult![i] !== item) identical = false;
    }

    for (const key of cache.keys()) {
      if (!seenKeys.has(key)) cache.delete(key);
    }

    if (identical && lastResult) return lastResult;
    lastResult = items;
    return items;
  };
}
