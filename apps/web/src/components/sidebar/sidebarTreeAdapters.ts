import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@ryco/client-runtime/scoped";
import { WorktreePullRequestLink, type EnvironmentId, type ProjectId } from "@ryco/contracts";
import { Option, Schema } from "effect";
import type { DraftId, DraftThreadState } from "../../composerDraftStore";
import {
  DEFAULT_AGENT_TOKEN_MODE,
  DEFAULT_INTERACTION_MODE,
  type Project,
  type SidebarThreadSummary,
  type SidebarWorktreeSummary,
} from "../../types";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  resolveThreadStatusPill,
  type SidebarStatusBucket,
  type ThreadStatusPill,
} from "../Sidebar.logic";
import type {
  SidebarTreeThread,
  SidebarWorktree,
  SidebarWorktreeOrigin,
} from "./hooks/useSidebarTree";

const STATUS_BUCKETS = new Set<SidebarStatusBucket>(["idle", "in_progress", "review", "done"]);
const WORKTREE_ORIGINS = new Set<SidebarWorktreeOrigin>([
  "main",
  "branch",
  "pr",
  "issue",
  "manual",
]);

export interface SidebarTreeAdapterInput {
  lastVisitedAtByThreadKey?: ReadonlyMap<string, string | null> | undefined;
  project: SidebarProjectSnapshot;
  threads: ReadonlyArray<SidebarThreadSummary>;
  worktrees?: ReadonlyArray<SidebarWorktreeSummary> | undefined;
}

export interface SidebarTreeAdapterOutput {
  project: Project;
  threads: ReadonlyArray<SidebarTreeThread>;
  worktrees: ReadonlyArray<SidebarWorktree>;
}

export function mergeSidebarThreadsWithDrafts(
  threads: ReadonlyArray<SidebarTreeThread>,
  draftThreads: ReadonlyArray<SidebarTreeThread>,
): SidebarTreeThread[] {
  const combined = [...threads];
  const seenKeys = new Set(
    threads.map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
  );
  for (const draft of draftThreads) {
    const draftKey = scopedThreadKey(scopeThreadRef(draft.environmentId, draft.id));
    if (seenKeys.has(draftKey)) {
      continue;
    }
    seenKeys.add(draftKey);
    combined.push(draft);
  }
  return combined;
}

export function adaptProjectForSidebarTree(
  input: SidebarTreeAdapterInput,
): SidebarTreeAdapterOutput {
  const logicalProjectId = input.project.projectKey as ProjectId;
  const memberProjectByKey = new Map(
    input.project.memberProjects.map((member) => [
      scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
      member,
    ]),
  );
  const project: Project = {
    ...input.project,
    id: logicalProjectId,
  };
  const threads = input.threads.map((thread) =>
    adaptThreadForSidebarTree({
      lastVisitedAt:
        input.lastVisitedAtByThreadKey?.get(
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ) ?? null,
      logicalProjectId,
      sourceProjectCwd:
        memberProjectByKey.get(
          scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
        )?.cwd ?? input.project.cwd,
      thread,
    }),
  );
  const explicitWorktrees = readExplicitWorktrees(
    input.project,
    logicalProjectId,
    input.worktrees ?? [],
  );
  const synthesizedWorktrees = synthesizeProjectMainWorktrees({
    logicalProjectId,
    project: input.project,
    threads,
  });

  return {
    project,
    threads,
    worktrees: [...synthesizedWorktrees, ...explicitWorktrees],
  };
}

export function adaptDraftThreadsForSidebarProject(input: {
  draftThreadsByThreadKey: Readonly<Record<string, DraftThreadState>>;
  project: SidebarProjectSnapshot;
}): ReadonlyArray<SidebarTreeThread> {
  const memberProjectKeys = getSidebarProjectMemberKeys(input.project);

  return Object.entries(input.draftThreadsByThreadKey).flatMap(([draftId, draftThread]) => {
    if (!draftThreadBelongsToSidebarProject(draftThread, memberProjectKeys)) {
      return [];
    }
    return [
      adaptDraftThreadForSidebarTree({
        draftId: draftId as DraftId,
        logicalProjectId: input.project.projectKey as ProjectId,
        sourceProjectCwd: resolveSourceProjectCwd(input.project, draftThread),
        draftThread,
      }),
    ];
  });
}

export function createSidebarProjectDraftThreadsSelector(
  project: SidebarProjectSnapshot,
): (state: {
  readonly draftThreadsByThreadKey: Readonly<Record<string, DraftThreadState>>;
}) => ReadonlyArray<SidebarTreeThread> {
  const memberProjectKeys = getSidebarProjectMemberKeys(project);
  const logicalProjectId = project.projectKey as ProjectId;
  let previousMatches: ReadonlyArray<readonly [string, DraftThreadState]> = [];
  let previousRows: ReadonlyArray<SidebarTreeThread> = [];

  return (state) => {
    const matches: Array<readonly [string, DraftThreadState]> = [];
    for (const [draftId, draftThread] of Object.entries(state.draftThreadsByThreadKey)) {
      if (draftThreadBelongsToSidebarProject(draftThread, memberProjectKeys)) {
        matches.push([draftId, draftThread] as const);
      }
    }

    if (
      matches.length === previousMatches.length &&
      matches.every((match, index) => {
        const previous = previousMatches[index];
        return previous?.[0] === match[0] && previous[1] === match[1];
      })
    ) {
      return previousRows;
    }

    previousMatches = matches;
    previousRows = matches.map(([draftId, draftThread]) =>
      adaptDraftThreadForSidebarTree({
        draftId: draftId as DraftId,
        logicalProjectId,
        sourceProjectCwd: resolveSourceProjectCwd(project, draftThread),
        draftThread,
      }),
    );
    return previousRows;
  };
}

function getSidebarProjectMemberKeys(project: SidebarProjectSnapshot): ReadonlySet<string> {
  return new Set(
    project.memberProjects.map((member) =>
      scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
    ),
  );
}

function draftThreadBelongsToSidebarProject(
  draftThread: DraftThreadState,
  memberProjectKeys: ReadonlySet<string>,
): boolean {
  if (draftThread.promotedTo != null) {
    return false;
  }
  return memberProjectKeys.has(
    scopedProjectKey(scopeProjectRef(draftThread.environmentId, draftThread.projectId)),
  );
}

function adaptThreadForSidebarTree(input: {
  lastVisitedAt: string | null;
  logicalProjectId: ProjectId;
  sourceProjectCwd: string;
  thread: SidebarThreadSummary;
}): SidebarTreeThread {
  const extra = input.thread as SidebarThreadSummary & {
    manualBucket?: unknown;
    manualStatusBucket?: unknown;
    statusBucket?: unknown;
    statusPill?: unknown;
    worktreeId?: unknown;
  };
  const statusPill =
    isThreadStatusPill(extra.statusPill) || extra.statusPill === null
      ? extra.statusPill
      : resolveThreadStatusPill({
          thread: {
            ...input.thread,
            ...(input.lastVisitedAt ? { lastVisitedAt: input.lastVisitedAt } : {}),
          },
        });

  return {
    ...input.thread,
    projectId: input.logicalProjectId,
    manualStatusBucket:
      readStatusBucket(extra.manualStatusBucket) ??
      readStatusBucket(extra.manualBucket) ??
      readStatusBucket(extra.statusBucket) ??
      null,
    sourceProjectId: input.thread.projectId,
    sourceProjectCwd: input.sourceProjectCwd,
    statusPill,
    worktreeId: typeof extra.worktreeId === "string" ? extra.worktreeId : null,
  };
}

function adaptDraftThreadForSidebarTree(input: {
  draftId: DraftId;
  logicalProjectId: ProjectId;
  sourceProjectCwd: string;
  draftThread: DraftThreadState;
}): SidebarTreeThread {
  return {
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    branch: input.draftThread.branch,
    createdAt: input.draftThread.createdAt,
    draftId: input.draftId,
    environmentId: input.draftThread.environmentId,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    id: input.draftThread.threadId,
    interactionMode: input.draftThread.interactionMode ?? DEFAULT_INTERACTION_MODE,
    tokenMode: input.draftThread.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
    latestTurn: null,
    latestUserMessageAt: null,
    manualStatusBucket: null,
    projectId: input.logicalProjectId,
    session: null,
    sourceProjectId: input.draftThread.projectId,
    sourceProjectCwd: input.sourceProjectCwd,
    statusPill: null,
    title: "New thread",
    updatedAt: input.draftThread.createdAt,
    worktreePath: input.draftThread.worktreePath,
  };
}

function readExplicitWorktrees(
  project: SidebarProjectSnapshot,
  logicalProjectId: ProjectId,
  worktrees: ReadonlyArray<SidebarWorktreeSummary>,
): SidebarWorktree[] {
  type Candidate = {
    value: unknown;
    fallbackProject: SidebarProjectSnapshot["memberProjects"][number];
  };
  const representative =
    project.memberProjects.find(
      (member) => member.id === project.id && member.environmentId === project.environmentId,
    ) ?? project.memberProjects[0];
  if (!representative) {
    return [];
  }
  const memberByKey = new Map(
    project.memberProjects.map((member) => [
      scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
      member,
    ]),
  );
  const candidates: Candidate[] = worktrees.map((worktree) => ({
    value: worktree,
    fallbackProject:
      memberByKey.get(
        scopedProjectKey(scopeProjectRef(worktree.environmentId, worktree.projectId)),
      ) ?? representative,
  }));
  const members: ReadonlyArray<
    SidebarProjectSnapshot | SidebarProjectSnapshot["memberProjects"][number]
  > = [project, ...project.memberProjects];
  for (const member of members) {
    const extra = member as Project & {
      sidebarWorktrees?: unknown;
      worktrees?: unknown;
    };
    if (Array.isArray(extra.worktrees)) {
      for (const worktree of extra.worktrees) {
        candidates.push({
          value: worktree,
          fallbackProject: "physicalProjectKey" in member ? member : representative,
        });
      }
    }
    if (Array.isArray(extra.sidebarWorktrees)) {
      for (const worktree of extra.sidebarWorktrees) {
        candidates.push({
          value: worktree,
          fallbackProject: "physicalProjectKey" in member ? member : representative,
        });
      }
    }
  }

  return candidates.flatMap(({ value, fallbackProject }, index) => {
    if (!value || typeof value !== "object") {
      return [];
    }
    const record = value as Record<string, unknown>;
    const branch = readString(record.branch);
    if (!branch) {
      return [];
    }
    const environmentId = readString(record.environmentId) ?? fallbackProject.environmentId;
    const sourceProjectId = readString(record.projectId) ?? fallbackProject.id;
    const sourceProject =
      memberByKey.get(
        scopedProjectKey(
          scopeProjectRef(environmentId as EnvironmentId, sourceProjectId as ProjectId),
        ),
      ) ?? fallbackProject;
    const worktreePath = readNullableString(record.worktreePath);
    const origin = readWorktreeOrigin(record.origin) ?? (worktreePath === null ? "main" : "manual");
    const worktreeId =
      readString(record.worktreeId) ??
      readString(record.id) ??
      buildWorktreeId({
        branch,
        fallbackIndex: index,
        environmentId,
        origin,
        sourceProjectId,
        worktreePath,
      });

    return [
      {
        archivedAt: readNullableString(record.archivedAt),
        checkoutRemovedAt: readNullableString(record.checkoutRemovedAt),
        branch,
        environmentId,
        issueNumber: readNumber(record.issueNumber),
        manualPosition: readNumber(record.manualPosition),
        origin,
        prNumber: readNumber(record.prNumber),
        prState: readPullRequestState(record.prState),
        prIsDraft: readNullableBoolean(record.prIsDraft),
        ...readPullRequestLinks(record.pullRequests),
        issueState: readIssueState(record.issueState),
        workItemProvider: readWorkItemProvider(record.workItemProvider),
        workItemKey: readNullableString(record.workItemKey),
        workItemTitle: readNullableString(record.workItemTitle),
        workItemState: readWorkItemState(record.workItemState),
        workItemStateName: readNullableString(record.workItemStateName),
        workItemUrl: readNullableString(record.workItemUrl),
        projectId: logicalProjectId,
        sourceProjectCwd: sourceProject.cwd,
        sourceProjectId,
        title: readNullableString(record.title),
        updatedAt: readString(record.updatedAt),
        worktreeId,
        worktreePath,
      },
    ];
  });
}

const decodePullRequestLinks = Schema.decodeUnknownOption(Schema.Array(WorktreePullRequestLink));

/** The record's links when it carries a valid list; absent otherwise (derived from `pr*`). */
function readPullRequestLinks(value: unknown): {
  readonly pullRequests?: ReadonlyArray<WorktreePullRequestLink>;
} {
  if (value === undefined) return {};
  const decoded = decodePullRequestLinks(value);
  return Option.isSome(decoded) ? { pullRequests: decoded.value } : {};
}

function readPullRequestState(value: unknown): "open" | "closed" | "merged" | null {
  return value === "open" || value === "closed" || value === "merged" ? value : null;
}

function readIssueState(value: unknown): "open" | "closed" | null {
  return value === "open" || value === "closed" ? value : null;
}

function readWorkItemProvider(value: unknown): "jira" | null {
  return value === "jira" ? value : null;
}

function readWorkItemState(
  value: unknown,
): "open" | "in_progress" | "done" | "closed" | "unknown" | null {
  return value === "open" ||
    value === "in_progress" ||
    value === "done" ||
    value === "closed" ||
    value === "unknown"
    ? value
    : null;
}

function readNullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function synthesizeProjectMainWorktrees(input: {
  logicalProjectId: ProjectId;
  project: SidebarProjectSnapshot;
  threads: ReadonlyArray<SidebarTreeThread>;
}): SidebarWorktree[] {
  return input.project.memberProjects.map((member, index) => {
    const latestMainThread = input.threads
      .filter(
        (thread) =>
          thread.environmentId === member.environmentId &&
          thread.sourceProjectId === member.id &&
          thread.worktreePath === null,
      )
      .toSorted((left, right) =>
        compareIsoDesc(left.updatedAt ?? left.createdAt, right.updatedAt ?? right.createdAt),
      )[0];
    return {
      archivedAt: null,
      branch: latestMainThread?.branch ?? "main",
      environmentId: member.environmentId,
      manualPosition: index,
      origin: "main",
      projectId: input.logicalProjectId,
      sourceProjectCwd: member.cwd,
      sourceProjectId: member.id,
      title: null,
      updatedAt: latestMainThread?.updatedAt ?? latestMainThread?.createdAt ?? member.updatedAt,
      worktreeId: `main:${member.environmentId}:${member.id}`,
      worktreePath: null,
    };
  });
}

function buildWorktreeId(input: {
  branch: string;
  environmentId: string;
  fallbackIndex: number;
  origin: SidebarWorktreeOrigin;
  sourceProjectId: string;
  worktreePath: string | null;
}): string {
  const location = input.worktreePath ?? input.branch;
  return `${input.origin}:${input.environmentId}:${input.sourceProjectId}:${location || input.fallbackIndex}`;
}

function readStatusBucket(value: unknown): SidebarStatusBucket | null {
  return typeof value === "string" && STATUS_BUCKETS.has(value as SidebarStatusBucket)
    ? (value as SidebarStatusBucket)
    : null;
}

function readWorktreeOrigin(value: unknown): SidebarWorktreeOrigin | null {
  return typeof value === "string" && WORKTREE_ORIGINS.has(value as SidebarWorktreeOrigin)
    ? (value as SidebarWorktreeOrigin)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isThreadStatusPill(value: unknown): value is ThreadStatusPill {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<ThreadStatusPill>;
  return (
    typeof record.label === "string" &&
    typeof record.colorClass === "string" &&
    typeof record.dotClass === "string" &&
    typeof record.pulse === "boolean"
  );
}

function compareIsoDesc(left: string | undefined, right: string | undefined): number {
  const leftMs = left ? Date.parse(left) : Number.NEGATIVE_INFINITY;
  const rightMs = right ? Date.parse(right) : Number.NEGATIVE_INFINITY;
  const normalizedLeft = Number.isNaN(leftMs) ? Number.NEGATIVE_INFINITY : leftMs;
  const normalizedRight = Number.isNaN(rightMs) ? Number.NEGATIVE_INFINITY : rightMs;
  return normalizedRight - normalizedLeft;
}

function resolveSourceProjectCwd(
  project: SidebarProjectSnapshot,
  thread: Pick<DraftThreadState, "environmentId" | "projectId">,
): string {
  return (
    project.memberProjects.find(
      (member) => member.environmentId === thread.environmentId && member.id === thread.projectId,
    )?.cwd ?? project.cwd
  );
}
