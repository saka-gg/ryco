import { useMemo } from "react";
import type { DraftId } from "../../../composerDraftStore";
import { normalizeProjectPathForComparison } from "../../../lib/projectPaths";
import type { Project, SidebarThreadSummary } from "../../../types";
import {
  aggregateWorktreeStatus,
  deriveStatusBucket,
  resolveThreadStatusPill,
  shouldSuggestArchive,
  type SidebarStatusBucket,
  type ThreadStatusPill,
} from "../../Sidebar.logic";
import type { WorktreePullRequestLink } from "@ryco/shared/worktreePullRequests";

export type SidebarWorktreeOrigin = "main" | "branch" | "pr" | "issue" | "manual";
export type SidebarWorkItemState = "open" | "in_progress" | "done" | "closed" | "unknown";

export interface SidebarWorktree {
  worktreeId: string;
  projectId: Project["id"] | string;
  environmentId?: string | undefined;
  sourceProjectId?: Project["id"] | string | undefined;
  sourceProjectCwd?: string | undefined;
  title?: string | null | undefined;
  branch: string;
  worktreePath: string | null;
  origin: SidebarWorktreeOrigin;
  prNumber?: number | null | undefined;
  issueNumber?: number | null | undefined;
  prState?: "open" | "closed" | "merged" | null | undefined;
  prIsDraft?: boolean | null | undefined;
  /** Every pull request the workspace carried; absent from older servers. */
  pullRequests?: ReadonlyArray<WorktreePullRequestLink> | undefined;
  issueState?: "open" | "closed" | null | undefined;
  workItemProvider?: "jira" | null | undefined;
  workItemKey?: string | null | undefined;
  workItemTitle?: string | null | undefined;
  workItemState?: SidebarWorkItemState | null | undefined;
  workItemStateName?: string | null | undefined;
  workItemUrl?: string | null | undefined;
  archivedAt?: string | null | undefined;
  /** The physical checkout is gone; the record keeps its branch and path as provenance. */
  checkoutRemovedAt?: string | null | undefined;
  manualPosition?: number | null | undefined;
  updatedAt?: string | undefined;
}

export interface SidebarWorktreeDiffStats {
  added: number;
  removed: number;
}

export type SidebarTreeThread = SidebarThreadSummary & {
  draftId?: DraftId | undefined;
  manualStatusBucket?: SidebarStatusBucket | null | undefined;
  sourceProjectId?: Project["id"] | undefined;
  sourceProjectCwd?: string | undefined;
  statusPill?: ThreadStatusPill | null | undefined;
  worktreeId?: string | null | undefined;
};

export interface SidebarTreeWorktree {
  aggregateStatus: SidebarStatusBucket;
  archivedSessions: ReadonlyArray<SidebarTreeThread>;
  buckets: Record<SidebarStatusBucket, ReadonlyArray<SidebarTreeThread>>;
  diffStats: SidebarWorktreeDiffStats | null;
  sessions: ReadonlyArray<SidebarTreeThread>;
  shouldSuggestArchive: boolean;
  worktree: SidebarWorktree;
}

export interface SidebarTreeProject {
  archivedSessions: ReadonlyArray<SidebarTreeThread>;
  archivedWorktrees: ReadonlyArray<SidebarTreeWorktree>;
  draftSessions: ReadonlyArray<SidebarTreeThread>;
  flatSessions: ReadonlyArray<SidebarTreeThread>;
  isGitRepo: boolean;
  project: Project;
  worktrees: ReadonlyArray<SidebarTreeWorktree>;
}

export interface SidebarTree {
  projects: ReadonlyArray<SidebarTreeProject>;
}

export type SidebarProjectGitRepoFlags =
  | ReadonlyMap<Project["id"] | string, boolean>
  | Record<string, boolean>;

export interface ComposeSidebarTreeInput {
  diffStatsByWorktreeId?: ReadonlyMap<string, SidebarWorktreeDiffStats | null> | undefined;
  diffStatsByWorktreeIdRecord?: Record<string, SidebarWorktreeDiffStats | null> | undefined;
  isGitRepoByProjectId?: SidebarProjectGitRepoFlags | undefined;
  nowMs: number;
  projects: ReadonlyArray<Project>;
  threads: ReadonlyArray<SidebarTreeThread>;
  worktrees?: ReadonlyArray<SidebarWorktree> | undefined;
}

export type UseSidebarTreeInput = Omit<ComposeSidebarTreeInput, "nowMs"> & {
  nowMs?: number | undefined;
};

/** A worktree node and the sessions assigned to it, before status decoration. */
export interface SidebarTreeStructureNode {
  readonly threads: ReadonlyArray<SidebarTreeThread>;
  readonly worktree: SidebarWorktree;
}

/**
 * A project's tree without anything derived from session status: which node
 * each session belongs to and in what order. This is the expensive part of a
 * tree (path normalization, node merging, assignment); `decorateSidebarTree`
 * adds buckets and aggregate status on top, cheaply, so one structure can
 * serve every consumer of a project's tree.
 */
export interface SidebarTreeStructureProject {
  readonly archivedSessions: ReadonlyArray<SidebarTreeThread>;
  readonly archivedWorktrees: ReadonlyArray<SidebarTreeStructureNode>;
  readonly draftSessions: ReadonlyArray<SidebarTreeThread>;
  readonly flatSessions: ReadonlyArray<SidebarTreeThread>;
  readonly isGitRepo: boolean;
  readonly project: Project;
  readonly worktrees: ReadonlyArray<SidebarTreeStructureNode>;
}

export interface SidebarTreeStructure {
  readonly projects: ReadonlyArray<SidebarTreeStructureProject>;
}

export type ComposeSidebarTreeStructureInput = Pick<
  ComposeSidebarTreeInput,
  "isGitRepoByProjectId" | "projects" | "threads" | "worktrees"
>;

export interface DecorateSidebarTreeInput {
  diffStatsByWorktreeId?: ReadonlyMap<string, SidebarWorktreeDiffStats | null> | undefined;
  diffStatsByWorktreeIdRecord?: Record<string, SidebarWorktreeDiffStats | null> | undefined;
  /** For archive suggestions; the current time when absent. */
  nowMs?: number | undefined;
  /**
   * Replaces a session before it is bucketed (e.g. with a status pill that
   * reflects when the user last visited it). Called once per session; must
   * return the same object when nothing changes.
   */
  restatusThread?: ((thread: SidebarTreeThread) => SidebarTreeThread) | undefined;
}

export function composeSidebarTree(input: ComposeSidebarTreeInput): SidebarTree {
  return decorateSidebarTree(composeSidebarTreeStructure(input), input);
}

export function composeSidebarTreeStructure(
  input: ComposeSidebarTreeStructureInput,
): SidebarTreeStructure {
  const uniqueThreads = dedupeSidebarThreads(input.threads);
  const threadsByProjectId = groupBy(uniqueThreads, (thread) => thread.projectId);
  const explicitWorktreesByProjectId = groupBy(input.worktrees ?? [], (worktree) =>
    String(worktree.projectId),
  );

  return {
    projects: input.projects.map((project): SidebarTreeStructureProject => {
      const projectThreads = threadsByProjectId.get(project.id) ?? [];
      const draftSessions = projectThreads.filter(
        (thread) => thread.draftId !== undefined && thread.archivedAt === null,
      );
      const materializedThreads = projectThreads.filter((thread) => thread.draftId === undefined);
      const isGitRepo = resolveProjectIsGitRepo(project, input.isGitRepoByProjectId);
      const archivedSessions = materializedThreads.filter((thread) => thread.archivedAt !== null);

      if (!isGitRepo) {
        return {
          archivedSessions,
          archivedWorktrees: [],
          draftSessions,
          flatSessions: projectThreads.filter((thread) => thread.archivedAt === null),
          isGitRepo,
          project,
          worktrees: [],
        };
      }

      const projectWorktrees = ensureProjectWorktrees({
        project,
        // Drafts describe where a future session should run. They do not own a
        // checkout yet, so allowing them into synthesis would make that intent
        // look like a real worktree (and can overwrite the main row's branch).
        threads: materializedThreads,
        worktrees: explicitWorktreesByProjectId.get(project.id) ?? [],
      });
      const mergedNodes = mergeEquivalentWorktrees(project, projectWorktrees);
      const sortedWorktrees = sortWorktrees(mergedNodes.worktrees);
      const threadsByNode = assignThreadsToWorktreeNodes(
        materializedThreads,
        sortedWorktrees,
        project,
        mergedNodes,
      );
      const toNode = (worktree: SidebarWorktree): SidebarTreeStructureNode => ({
        threads: threadsByNode.get(worktree) ?? [],
        worktree,
      });

      return {
        archivedSessions,
        archivedWorktrees: sortedWorktrees
          .filter((worktree) => worktree.archivedAt != null)
          .map(toNode),
        flatSessions: [],
        draftSessions,
        isGitRepo,
        project,
        worktrees: sortedWorktrees.filter((worktree) => worktree.archivedAt == null).map(toNode),
      };
    }),
  };
}

export function decorateSidebarTree(
  structure: SidebarTreeStructure,
  input: DecorateSidebarTreeInput,
): SidebarTree {
  return {
    projects: structure.projects.map((project) => decorateSidebarTreeProject(project, input)),
  };
}

export function decorateSidebarTreeProject(
  project: SidebarTreeStructureProject,
  input: DecorateSidebarTreeInput,
): SidebarTreeProject {
  const nowMs = input.nowMs ?? Date.now();
  const restatus = input.restatusThread;
  const restatused = new Map<SidebarTreeThread, SidebarTreeThread>();
  const restatusOne = (thread: SidebarTreeThread) => {
    if (restatus === undefined) return thread;
    let next = restatused.get(thread);
    if (next === undefined) {
      next = restatus(thread);
      restatused.set(thread, next);
    }
    return next;
  };
  const restatusAll = (threads: ReadonlyArray<SidebarTreeThread>) =>
    restatus === undefined ? threads : threads.map(restatusOne);
  const composeNode = (node: SidebarTreeStructureNode) =>
    composeWorktreeNode({
      diffStats: getDiffStats(input, node.worktree.worktreeId),
      nowMs,
      threads: restatusAll(node.threads),
      worktree: node.worktree,
    });
  return {
    archivedSessions: restatusAll(project.archivedSessions),
    archivedWorktrees: project.archivedWorktrees.map(composeNode),
    draftSessions: restatusAll(project.draftSessions),
    flatSessions: restatusAll(project.flatSessions),
    isGitRepo: project.isGitRepo,
    project: project.project,
    worktrees: project.worktrees.map(composeNode),
  };
}

function dedupeSidebarThreads(
  threads: ReadonlyArray<SidebarTreeThread>,
): ReadonlyArray<SidebarTreeThread> {
  const seen = new Set<string>();
  return threads.filter((thread) => {
    const key = `${thread.environmentId}\u0000${thread.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function useSidebarTree(input: UseSidebarTreeInput): SidebarTree {
  const {
    diffStatsByWorktreeId,
    diffStatsByWorktreeIdRecord,
    isGitRepoByProjectId,
    nowMs,
    projects,
    threads,
    worktrees,
  } = input;

  return useMemo(
    () =>
      composeSidebarTree({
        diffStatsByWorktreeId,
        diffStatsByWorktreeIdRecord,
        isGitRepoByProjectId,
        nowMs: nowMs ?? Date.now(),
        projects,
        threads,
        worktrees,
      }),
    [
      diffStatsByWorktreeId,
      diffStatsByWorktreeIdRecord,
      isGitRepoByProjectId,
      nowMs,
      projects,
      threads,
      worktrees,
    ],
  );
}

function composeWorktreeNode(input: {
  diffStats: SidebarWorktreeDiffStats | null;
  nowMs: number;
  threads: ReadonlyArray<SidebarTreeThread>;
  worktree: SidebarWorktree;
}): SidebarTreeWorktree {
  const buckets: Record<SidebarStatusBucket, SidebarTreeThread[]> = {
    done: [],
    idle: [],
    in_progress: [],
    review: [],
  };
  const activeBuckets: SidebarStatusBucket[] = [];
  const archivedSessions: SidebarTreeThread[] = [];
  const sessions: SidebarTreeThread[] = [];

  for (const thread of input.threads) {
    if (thread.archivedAt !== null) {
      archivedSessions.push(thread);
      continue;
    }

    sessions.push(thread);
    const bucket = getThreadBucket(thread);
    activeBuckets.push(bucket);
    buckets[bucket].push(thread);
  }

  return {
    aggregateStatus: aggregateWorktreeStatus(activeBuckets),
    archivedSessions,
    buckets,
    diffStats: input.diffStats,
    sessions,
    shouldSuggestArchive: shouldSuggestArchive({
      buckets: activeBuckets,
      latestUpdatedAt: getLatestUpdatedAt(input.threads),
      nowMs: input.nowMs,
    }),
    worktree: input.worktree,
  };
}

function getThreadBucket(thread: SidebarTreeThread): SidebarStatusBucket {
  return deriveStatusBucket({
    manualBucket: thread.manualStatusBucket ?? null,
    statusPill: thread.statusPill ?? resolveThreadStatusPill({ thread }),
  });
}

/**
 * Buckets each session into the node(s) it belongs to in one pass:
 * O(threads + nodes) instead of filtering every thread per node, with each
 * directory key computed once. Mirrors the per-pair rules below exactly
 * (including the rare duplicates where several nodes share a key or id).
 */
function assignThreadsToWorktreeNodes(
  threads: ReadonlyArray<SidebarTreeThread>,
  worktrees: ReadonlyArray<SidebarWorktree>,
  project: Project,
  nodes: MergedSidebarWorktrees,
): Map<SidebarWorktree, SidebarTreeThread[]> {
  const nodesByDirectoryKey = new Map<string, SidebarWorktree[]>();
  const nodesById = new Map<string, SidebarWorktree[]>();
  const nodesWithoutDirectory: SidebarWorktree[] = [];
  for (const worktree of worktrees) {
    const directoryKey = worktreeDirectoryGroupKey(worktree, project);
    if (directoryKey === null) nodesWithoutDirectory.push(worktree);
    else pushToGroup(nodesByDirectoryKey, directoryKey, worktree);
    pushToGroup(nodesById, worktree.worktreeId, worktree);
  }

  const threadsByNode = new Map<SidebarWorktree, SidebarTreeThread[]>();
  const assign = (thread: SidebarTreeThread, targets: ReadonlyArray<SidebarWorktree>) => {
    for (const worktree of targets) pushToGroup(threadsByNode, worktree, thread);
  };
  for (const thread of threads) {
    const threadDirectoryKey = threadDirectoryGroupKey(thread, project);
    if (threadDirectoryKey !== null && nodes.directoryKeys.has(threadDirectoryKey)) {
      assign(thread, nodesByDirectoryKey.get(threadDirectoryKey) ?? []);
      continue;
    }
    const linkedNodeId =
      thread.worktreeId == null ? undefined : nodes.nodeIdByWorktreeId.get(thread.worktreeId);
    if (linkedNodeId !== undefined) {
      assign(thread, nodesById.get(linkedNodeId) ?? []);
      continue;
    }
    // A thread with a directory matches no node that has one (its directory
    // is covered by none); only directory-less nodes remain candidates.
    const candidates = threadDirectoryKey === null ? worktrees : nodesWithoutDirectory;
    assign(
      thread,
      candidates.filter((worktree) =>
        belongsToWorktree(thread, threadDirectoryKey, worktree, project, nodes),
      ),
    );
  }
  return threadsByNode;
}

function pushToGroup<K, V>(groups: Map<K, V[]>, key: K, value: V): void {
  const group = groups.get(key);
  if (group) group.push(value);
  else groups.set(key, [value]);
}

function belongsToWorktree(
  thread: SidebarTreeThread,
  threadDirectoryKey: string | null,
  worktree: SidebarWorktree,
  project: Project,
  nodes: MergedSidebarWorktrees,
): boolean {
  const worktreeDirectoryKey = worktreeDirectoryGroupKey(worktree, project);
  if (threadDirectoryKey !== null && nodes.directoryKeys.has(threadDirectoryKey)) {
    // The directory a session ran in outranks a worktree id it may have
    // outgrown, as long as some node actually covers that directory.
    return threadDirectoryKey === worktreeDirectoryKey;
  }

  // Otherwise fall back to the recorded link. The server resolves symlinks when
  // it attaches a thread, so a directory spelled two ways still lands on the
  // node its worktree owns instead of splitting off a duplicate.
  const linkedNodeId =
    thread.worktreeId == null ? undefined : nodes.nodeIdByWorktreeId.get(thread.worktreeId);
  if (linkedNodeId !== undefined) {
    return linkedNodeId === worktree.worktreeId;
  }

  if (threadDirectoryKey !== null && worktreeDirectoryKey !== null) {
    return threadDirectoryKey === worktreeDirectoryKey;
  }

  if (thread.worktreeId != null && thread.worktreeId === worktree.worktreeId) {
    return true;
  }

  if (thread.worktreePath !== null || worktree.worktreePath !== null) {
    return false;
  }

  if (worktree.origin !== "main") {
    return thread.branch === worktree.branch;
  }

  return (
    thread.branch === null || thread.branch === worktree.branch || isLikelyMainBranch(thread.branch)
  );
}

interface MergedSidebarWorktrees {
  /** Directories the merged nodes cover, for deciding if a session's fits one. */
  readonly directoryKeys: ReadonlySet<string>;
  /** Every input worktree id mapped to the id of the node it ended up in. */
  readonly nodeIdByWorktreeId: ReadonlyMap<string, string>;
  readonly worktrees: ReadonlyArray<SidebarWorktree>;
}

function mergeEquivalentWorktrees(
  project: Project,
  worktrees: ReadonlyArray<SidebarWorktree>,
): MergedSidebarWorktrees {
  const mergedByKey = new Map<string, SidebarWorktree>();
  const keyByWorktreeId = new Map<string, string>();
  for (const worktree of worktrees) {
    const key = canonicalWorktreeGroupKey(project, worktree);
    const existing = mergedByKey.get(key);
    keyByWorktreeId.set(worktree.worktreeId, key);
    mergedByKey.set(key, existing ? mergeWorktree(existing, worktree) : worktree);
  }

  const directoryKeys = new Set<string>();
  const nodeIdByWorktreeId = new Map<string, string>();
  for (const [worktreeId, key] of keyByWorktreeId) {
    const node = mergedByKey.get(key);
    if (node) {
      nodeIdByWorktreeId.set(worktreeId, node.worktreeId);
    }
  }
  for (const node of mergedByKey.values()) {
    const directoryKey = worktreeDirectoryGroupKey(node, project);
    if (directoryKey !== null) {
      directoryKeys.add(directoryKey);
    }
  }
  return { directoryKeys, nodeIdByWorktreeId, worktrees: [...mergedByKey.values()] };
}

function canonicalWorktreeGroupKey(project: Project, worktree: SidebarWorktree): string {
  return (
    worktreeDirectoryGroupKey(worktree, project) ??
    `${worktree.projectId}:${worktree.origin}:${worktree.worktreeId}:${worktree.branch}`
  );
}

// Paths repeat across every sidebar pass (one per thread and node); the
// normalization is pure, so memoize it in a bounded map.
const NORMALIZED_WORKTREE_PATH_CACHE_LIMIT = 4096;
const normalizedWorktreePathCache = new Map<string, string>();

export function normalizeWorktreePath(worktreePath: string): string {
  const cached = normalizedWorktreePathCache.get(worktreePath);
  if (cached !== undefined) return cached;
  const normalized = normalizeProjectPathForComparison(worktreePath);
  if (normalizedWorktreePathCache.size >= NORMALIZED_WORKTREE_PATH_CACHE_LIMIT) {
    normalizedWorktreePathCache.clear();
  }
  normalizedWorktreePathCache.set(worktreePath, normalized);
  return normalized;
}

function mergeWorktree(left: SidebarWorktree, right: SidebarWorktree): SidebarWorktree {
  const fresher = preferFresher(left, right);
  const origin = left.origin === "main" || right.origin !== "main" ? left.origin : right.origin;
  return {
    ...left,
    archivedAt: mergeArchivedAt(left.archivedAt, right.archivedAt),
    checkoutRemovedAt: left.checkoutRemovedAt ?? right.checkoutRemovedAt ?? null,
    branch: fresher.branch,
    environmentId: fresher.environmentId ?? left.environmentId ?? right.environmentId,
    manualPosition: minNumber(left.manualPosition, right.manualPosition),
    origin,
    // One record speaks for the pull request: never pair one record's number
    // with the other's state.
    ...pullRequestFieldsOf(
      fresher.prNumber != null ? fresher : left.prNumber != null ? left : right,
    ),
    issueNumber: left.issueNumber ?? right.issueNumber ?? null,
    issueState: fresher.issueState ?? null,
    workItemProvider: left.workItemProvider ?? right.workItemProvider ?? null,
    workItemKey: left.workItemKey ?? right.workItemKey ?? null,
    workItemTitle: left.workItemTitle ?? right.workItemTitle ?? null,
    workItemState: fresher.workItemState ?? null,
    workItemStateName: fresher.workItemStateName ?? null,
    workItemUrl: left.workItemUrl ?? right.workItemUrl ?? null,
    sourceProjectCwd: fresher.sourceProjectCwd ?? left.sourceProjectCwd ?? right.sourceProjectCwd,
    sourceProjectId: fresher.sourceProjectId ?? left.sourceProjectId ?? right.sourceProjectId,
    title: preferWorktreeTitle(left, right),
    updatedAt: maxIso(left.updatedAt, right.updatedAt),
    worktreeId: preferWorktreeId(left, right),
    worktreePath: origin === "main" ? null : (left.worktreePath ?? right.worktreePath),
  };
}

function pullRequestFieldsOf(
  worktree: SidebarWorktree,
): Pick<SidebarWorktree, "prNumber" | "prState" | "prIsDraft" | "pullRequests"> {
  return {
    prNumber: worktree.prNumber ?? null,
    prState: worktree.prState ?? null,
    prIsDraft: worktree.prIsDraft ?? null,
    ...(worktree.pullRequests !== undefined ? { pullRequests: worktree.pullRequests } : {}),
  };
}

function preferFresher(left: SidebarWorktree, right: SidebarWorktree): SidebarWorktree {
  const leftMs = left.updatedAt ? Date.parse(left.updatedAt) : Number.NEGATIVE_INFINITY;
  const rightMs = right.updatedAt ? Date.parse(right.updatedAt) : Number.NEGATIVE_INFINITY;
  if (Number.isNaN(rightMs) || rightMs <= leftMs) return left;
  return right;
}

function preferWorktreeTitle(
  left: SidebarWorktree,
  right: SidebarWorktree,
): string | null | undefined {
  if (left.title == null) return right.title ?? null;
  if (right.title == null) return left.title;
  const leftMs = left.updatedAt ? Date.parse(left.updatedAt) : Number.NEGATIVE_INFINITY;
  const rightMs = right.updatedAt ? Date.parse(right.updatedAt) : Number.NEGATIVE_INFINITY;
  if (Number.isNaN(leftMs)) return right.title;
  if (Number.isNaN(rightMs)) return left.title;
  return rightMs > leftMs ? right.title : left.title;
}

function preferWorktreeId(left: SidebarWorktree, right: SidebarWorktree): string {
  const leftSynthetic = isSyntheticWorktreeId(left.worktreeId);
  const rightSynthetic = isSyntheticWorktreeId(right.worktreeId);
  if (leftSynthetic && !rightSynthetic) {
    return right.worktreeId;
  }
  if (rightSynthetic && !leftSynthetic) {
    return left.worktreeId;
  }
  if (left.origin === "main") {
    return left.worktreeId;
  }
  if (right.origin === "main") {
    return right.worktreeId;
  }
  return left.worktreeId;
}

export function isSyntheticWorktreeId(worktreeId: string): boolean {
  return /^(main|branch|pr|issue|manual):/.test(worktreeId);
}

function mergeArchivedAt(
  left: string | null | undefined,
  right: string | null | undefined,
): string | null | undefined {
  if (left == null || right == null) {
    return null;
  }
  return maxIso(left, right);
}

function minNumber(
  left: number | null | undefined,
  right: number | null | undefined,
): number | null | undefined {
  if (left == null) return right;
  if (right == null) return left;
  return Math.min(left, right);
}

function ensureProjectWorktrees(input: {
  project: Project;
  threads: ReadonlyArray<SidebarTreeThread>;
  worktrees: ReadonlyArray<SidebarWorktree>;
}): ReadonlyArray<SidebarWorktree> {
  const explicitWorktreeIds = new Set(input.worktrees.map((worktree) => worktree.worktreeId));
  return [
    ...input.worktrees,
    // A session already linked to a known worktree belongs to that node. Deriving
    // a second node from its recorded directory would split it off under its
    // branch name — the phantom "main" beside the project root.
    ...input.threads
      .filter((thread) => thread.worktreeId == null || !explicitWorktreeIds.has(thread.worktreeId))
      .map((thread) => synthesizeWorktreeForThread(input.project, thread)),
  ];
}

function synthesizeWorktreeForThread(project: Project, thread: SidebarTreeThread): SidebarWorktree {
  const branch = thread.branch ?? "main";
  const origin: SidebarWorktreeOrigin =
    thread.worktreePath === null && isLikelyMainBranch(thread.branch) ? "main" : "branch";
  return {
    archivedAt: null,
    branch,
    environmentId: thread.environmentId,
    manualPosition: origin === "main" ? 0 : null,
    origin,
    projectId: project.id,
    sourceProjectCwd: thread.sourceProjectCwd ?? project.cwd,
    sourceProjectId: thread.sourceProjectId ?? thread.projectId,
    updatedAt: thread.updatedAt ?? thread.createdAt,
    worktreeId:
      origin === "main"
        ? `main:${project.environmentId}:${project.id}`
        : `branch:${project.environmentId}:${project.id}:${thread.worktreePath ? normalizeWorktreePath(thread.worktreePath) : branch}`,
    worktreePath: thread.worktreePath,
  };
}

function threadDirectoryGroupKey(thread: SidebarTreeThread, project: Project): string | null {
  return sidebarDirectoryGroupKey({
    directory: thread.worktreePath ?? thread.sourceProjectCwd ?? project.cwd,
    environmentId: thread.environmentId,
  });
}

function worktreeDirectoryGroupKey(worktree: SidebarWorktree, project: Project): string | null {
  return sidebarDirectoryGroupKey({
    directory: worktree.worktreePath ?? worktree.sourceProjectCwd ?? project.cwd,
    environmentId: worktree.environmentId ?? project.environmentId,
  });
}

export function sidebarDirectoryGroupKey(input: {
  directory: string;
  environmentId: string;
}): string | null {
  const directory = normalizeWorktreePath(input.directory);
  if (directory.length === 0) {
    return null;
  }
  return JSON.stringify([input.environmentId, directory]);
}

function isLikelyMainBranch(branch: string | null | undefined): boolean {
  return (
    branch === null ||
    branch === undefined ||
    branch === "main" ||
    branch === "master" ||
    branch === "trunk"
  );
}

function sortWorktrees(worktrees: ReadonlyArray<SidebarWorktree>): SidebarWorktree[] {
  return [...worktrees].toSorted((left, right) => {
    if (left.origin === "main" && right.origin !== "main") return -1;
    if (right.origin === "main" && left.origin !== "main") return 1;

    const leftPosition = left.manualPosition ?? Number.MAX_SAFE_INTEGER;
    const rightPosition = right.manualPosition ?? Number.MAX_SAFE_INTEGER;
    if (leftPosition !== rightPosition) {
      return leftPosition - rightPosition;
    }

    const byUpdatedAt = compareOptionalIsoDesc(left.updatedAt, right.updatedAt);
    if (byUpdatedAt !== 0) {
      return byUpdatedAt;
    }

    return (
      left.branch.localeCompare(right.branch) || left.worktreeId.localeCompare(right.worktreeId)
    );
  });
}

function compareOptionalIsoDesc(left: string | undefined, right: string | undefined): number {
  const rightMs = right ? Date.parse(right) : Number.NEGATIVE_INFINITY;
  const leftMs = left ? Date.parse(left) : Number.NEGATIVE_INFINITY;
  const normalizedRightMs = Number.isNaN(rightMs) ? Number.NEGATIVE_INFINITY : rightMs;
  const normalizedLeftMs = Number.isNaN(leftMs) ? Number.NEGATIVE_INFINITY : leftMs;
  return normalizedRightMs - normalizedLeftMs;
}

function maxIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isNaN(leftMs)) return right;
  if (Number.isNaN(rightMs)) return left;
  return rightMs > leftMs ? right : left;
}

function getLatestUpdatedAt(threads: ReadonlyArray<SidebarTreeThread>): string | undefined {
  return threads
    .map((thread) => thread.updatedAt ?? thread.createdAt)
    .filter((timestamp) => timestamp !== undefined)
    .toSorted((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function getDiffStats(
  input: Pick<DecorateSidebarTreeInput, "diffStatsByWorktreeId" | "diffStatsByWorktreeIdRecord">,
  worktreeId: string,
): SidebarWorktreeDiffStats | null {
  if (input.diffStatsByWorktreeId) {
    return input.diffStatsByWorktreeId.get(worktreeId) ?? null;
  }
  return input.diffStatsByWorktreeIdRecord?.[worktreeId] ?? null;
}

function resolveProjectIsGitRepo(
  project: Project,
  flags: SidebarProjectGitRepoFlags | undefined,
): boolean {
  const flagged = getProjectFlag(flags, project.id);
  if (flagged !== undefined) {
    return flagged;
  }

  return true;
}

function getProjectFlag(
  flags: SidebarProjectGitRepoFlags | undefined,
  projectId: Project["id"],
): boolean | undefined {
  if (!flags) {
    return undefined;
  }
  if (isReadonlyMap(flags)) {
    return flags.get(projectId);
  }
  return (flags as Readonly<Record<string, boolean>>)[String(projectId)];
}

function isReadonlyMap<K, V>(value: unknown): value is ReadonlyMap<K, V> {
  return value instanceof Map;
}

function groupBy<TItem, TKey>(
  items: ReadonlyArray<TItem>,
  getKey: (item: TItem) => TKey,
): Map<TKey, TItem[]> {
  const grouped = new Map<TKey, TItem[]>();
  for (const item of items) {
    const key = getKey(item);
    const group = grouped.get(key);
    if (group) {
      group.push(item);
    } else {
      grouped.set(key, [item]);
    }
  }
  return grouped;
}
