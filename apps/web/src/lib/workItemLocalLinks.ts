import type { AtlassianConnectionSummary, AtlassianProjectLink, VcsRef } from "@ryco/contracts";
import { isWorkspaceDeleted } from "@ryco/client-runtime/state/lifecycle";

import type { SidebarWorktreeSummary } from "../types";

export interface LinkedWorkItemWorktree {
  readonly id: SidebarWorktreeSummary["id"];
  readonly branch: string;
  readonly title: string | null;
  readonly worktreePath: string | null;
  readonly archivedAt: string | null;
}

export interface WorkItemBranchChoice {
  readonly branchName: string;
  readonly label: string;
  readonly description: string;
  readonly hasWorktree: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeWorkItemKey(key: string): string {
  return key.trim().toUpperCase();
}

export function workItemKeyMatchesText(key: string, text: string): boolean {
  const normalizedKey = normalizeWorkItemKey(key);
  if (normalizedKey.length === 0) return false;
  const pattern = new RegExp(`(?:^|[^A-Z0-9])${escapeRegExp(normalizedKey)}(?=$|[^A-Z0-9])`, "i");
  return pattern.test(text);
}

export function findLinkedWorkItemBranches(input: {
  readonly key: string;
  readonly refs: ReadonlyArray<VcsRef>;
}): ReadonlyArray<VcsRef> {
  return input.refs.filter((ref) => workItemKeyMatchesText(input.key, ref.name));
}

export function findLinkedWorkItemWorktrees(input: {
  readonly key: string;
  readonly worktrees: ReadonlyArray<SidebarWorktreeSummary>;
}): ReadonlyArray<LinkedWorkItemWorktree> {
  const normalizedKey = normalizeWorkItemKey(input.key);
  const linked = new Map<SidebarWorktreeSummary["id"], LinkedWorkItemWorktree>();
  for (const worktree of input.worktrees) {
    // A deleted workspace is gone for the reader; only its conversations remain.
    if (isWorkspaceDeleted(worktree)) continue;
    const metadataMatches =
      worktree.workItemProvider === "jira" &&
      worktree.workItemKey !== null &&
      normalizeWorkItemKey(worktree.workItemKey) === normalizedKey;
    if (!metadataMatches && !workItemKeyMatchesText(normalizedKey, worktree.branch)) {
      continue;
    }
    linked.set(worktree.id, {
      id: worktree.id,
      branch: worktree.branch,
      title: worktree.title ?? worktree.workItemTitle ?? null,
      worktreePath: worktree.worktreePath,
      archivedAt: worktree.archivedAt,
    });
  }
  return Array.from(linked.values()).toSorted((a, b) => {
    if (a.archivedAt === null && b.archivedAt !== null) return -1;
    if (a.archivedAt !== null && b.archivedAt === null) return 1;
    return a.branch.localeCompare(b.branch);
  });
}

export function buildWorkItemBranchChoices(input: {
  readonly branches: ReadonlyArray<VcsRef>;
  readonly worktrees: ReadonlyArray<LinkedWorkItemWorktree>;
}): ReadonlyArray<WorkItemBranchChoice> {
  const worktreeByBranch = new Map(input.worktrees.map((worktree) => [worktree.branch, worktree]));
  return input.branches.map((branch) => {
    const linkedWorktree = worktreeByBranch.get(branch.name);
    return {
      branchName: branch.name,
      label: branch.name,
      description: linkedWorktree
        ? (linkedWorktree.worktreePath ?? "Already checked out in a worktree")
        : branch.worktreePath
          ? branch.worktreePath
          : branch.isRemote
            ? (branch.remoteName ?? "Remote branch")
            : "Local branch",
      hasWorktree: linkedWorktree !== undefined || branch.worktreePath !== null,
    };
  });
}

export function resolveJiraProjectOpenUrl(input: {
  readonly link: AtlassianProjectLink | null | undefined;
  readonly connections?: ReadonlyArray<
    Pick<AtlassianConnectionSummary, "baseUrl" | "connectionId">
  >;
}): string | null {
  const link = input.link;
  const projectKey = link?.jiraProjectKeys[0]?.trim().toUpperCase();
  if (!link || !link.jiraConnectionId || !projectKey) {
    return null;
  }
  const connection = input.connections?.find((item) => item.connectionId === link.jiraConnectionId);
  const siteUrl = trimSlash(link.jiraSiteUrl ?? connection?.baseUrl ?? "");
  if (!siteUrl) return null;
  return `${siteUrl}/jira/software/projects/${encodeURIComponent(projectKey)}`;
}

function trimSlash(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}
