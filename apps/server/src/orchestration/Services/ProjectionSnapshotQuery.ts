/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
  CheckpointRevertActivityPayload,
  EventId,
  MessageId,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationSearchThreadMessagesInput,
  OrchestrationThreadMessageSearchResult,
  OrchestrationGetThreadHistoryPageInput,
  OrchestrationGetThreadWindowInput,
  OrchestrationThreadHistoryError,
  OrchestrationThreadHistoryPage,
  OrchestrationThreadActivity,
  OrchestrationThreadPriorityEntry,
  OrchestrationThreadShell,
  OrchestrationThreadWindowSnapshot,
  OrchestrationWorktreeShell,
  ProjectId,
  ThreadGoal,
  ThreadId,
  TurnId,
  WorktreeId,
} from "@ryco/contracts";
import { Context, Effect } from "effect";
import type { Option } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ProjectionSnapshotCounts {
  readonly projectCount: number;
  readonly threadCount: number;
}

export interface ProjectionSnapshotSequence {
  readonly snapshotSequence: number;
}

export interface ProjectionProjectWorkspaceRows {
  readonly worktrees: ReadonlyArray<OrchestrationWorktreeShell>;
  readonly threads: ReadonlyArray<
    Pick<OrchestrationThreadShell, "id" | "projectId" | "branch" | "worktreePath" | "worktreeId">
  >;
}

/**
 * Where every live project, workspace and thread lives on disk: the shell snapshot's projects
 * and workspaces, and a five-column placement of each live thread. For server code that checks
 * paths or ids against current workspaces, it costs three plain reads instead of a whole shell
 * snapshot (thread summaries, sessions, latest turns, priorities).
 */
export interface ProjectionWorkspacePlacement {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  /** Workspaces of live projects, archived ones included, as in the shell snapshot. */
  readonly worktrees: ReadonlyArray<OrchestrationWorktreeShell>;
  readonly threads: ProjectionProjectWorkspaceRows["threads"];
}

/** The same placement derived from a shell snapshot, for callers given a narrow test double. */
export function workspacePlacementOf(
  snapshot: OrchestrationShellSnapshot,
): ProjectionWorkspacePlacement {
  return {
    projects: snapshot.projects,
    worktrees: snapshot.worktrees ?? [],
    threads: snapshot.threads.map((thread) => ({
      id: thread.id,
      projectId: thread.projectId,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      worktreeId: thread.worktreeId ?? null,
    })),
  };
}

export interface ProjectionPendingGoalSyncThreads {
  readonly snapshotSequence: number;
  readonly threads: ReadonlyArray<{ readonly threadId: ThreadId; readonly goal: ThreadGoal }>;
}

/** The same answer derived from a shell snapshot, for callers given a narrow test double. */
export function pendingGoalSyncThreadsOf(
  snapshot: OrchestrationShellSnapshot,
): ProjectionPendingGoalSyncThreads {
  return {
    snapshotSequence: snapshot.snapshotSequence,
    threads: snapshot.threads.flatMap((thread) =>
      thread.goal?.synchronization?.state === "pending"
        ? [{ threadId: thread.id, goal: thread.goal }]
        : [],
    ),
  };
}

/**
 * Narrows a shell snapshot. `projectIds` keeps those live projects, their workspaces and their
 * live threads; `threadIds` keeps those live threads (and their projects and workspaces); both
 * together keep their intersection. Sequence and `updatedAt` stay those of the whole shell.
 */
export interface ProjectionShellScope {
  readonly projectIds?: ReadonlyArray<ProjectId>;
  readonly threadIds?: ReadonlyArray<ThreadId>;
}

/** The scoped snapshot derived from a whole one, for callers given a narrow test double. */
export function scopeShellSnapshot(
  snapshot: OrchestrationShellSnapshot,
  scope: ProjectionShellScope,
): OrchestrationShellSnapshot {
  const projectIds = scope.projectIds === undefined ? undefined : new Set<string>(scope.projectIds);
  const threadIds = scope.threadIds === undefined ? undefined : new Set<string>(scope.threadIds);
  const threads = snapshot.threads.filter(
    (thread) =>
      (projectIds === undefined || projectIds.has(thread.projectId)) &&
      (threadIds === undefined || threadIds.has(thread.id)),
  );
  const projectsInScope =
    projectIds ??
    (threadIds === undefined ? undefined : new Set<string>(threads.map((t) => t.projectId)));
  const inScope = (projectId: string) =>
    projectsInScope === undefined || projectsInScope.has(projectId);
  return {
    ...snapshot,
    projects: snapshot.projects.filter((project) => inScope(project.id)),
    worktrees: (snapshot.worktrees ?? []).filter((worktree) => inScope(worktree.projectId)),
    threads,
  };
}

export interface ProjectionThreadCheckpointContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape {
  /**
   * Read the lightweight command snapshot used to bootstrap the in-memory
   * orchestration engine without hydrating message/activity/checkpoint bodies.
   */
  readonly getCommandReadModel: () => Effect.Effect<
    OrchestrationReadModel,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest orchestration projection snapshot.
   *
   * Rehydrates from projection tables and derives snapshot sequence from
   * projector cursor state.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /**
   * The shell snapshot narrowed to some projects or threads (see {@link ProjectionShellScope}),
   * for server code that needs thread summaries of a few threads only. Optional for test
   * doubles; read it through {@link readScopedShellSnapshot}.
   */
  readonly getScopedShellSnapshot?: (
    scope: ProjectionShellScope,
  ) => Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError>;

  /**
   * Read the latest orchestration shell snapshot.
   *
   * Returns only projects and thread shell summaries so clients can bootstrap
   * lightweight navigation state without hydrating every thread body.
   */
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Live projects, as the shell snapshot lists them, from the project table alone. Absent only
   * in narrow test doubles: read through {@link readProjectShells}.
   */
  readonly listProjectShells?: () => Effect.Effect<
    ReadonlyArray<OrchestrationProjectShell>,
    ProjectionRepositoryError
  >;

  /**
   * Live projects, their workspaces and where each live thread works, read in one transaction.
   * Absent only in narrow test doubles: read through {@link readWorkspacePlacement}.
   */
  readonly getWorkspacePlacement?: () => Effect.Effect<
    ProjectionWorkspacePlacement,
    ProjectionRepositoryError
  >;

  /**
   * Live threads whose goal synchronization still awaits its provider, with the projection
   * sequence they were read at. A narrow boot-time read instead of a whole shell snapshot.
   */
  readonly listPendingGoalSyncThreads?: () => Effect.Effect<
    ProjectionPendingGoalSyncThreads,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest projection snapshot sequence without hydrating read-model
   * entities.
   */
  readonly getSnapshotSequence: () => Effect.Effect<
    ProjectionSnapshotSequence,
    ProjectionRepositoryError
  >;

  /**
   * Read aggregate projection counts without hydrating the full read model.
   */
  readonly getCounts: () => Effect.Effect<ProjectionSnapshotCounts, ProjectionRepositoryError>;

  /**
   * Read the active project for an exact workspace root match.
   */
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, ProjectionRepositoryError>;

  /**
   * Read a single active project shell row by id.
   */
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectionRepositoryError>;

  /**
   * Read the earliest active thread for a project.
   */
  readonly getFirstActiveThreadIdByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  /**
   * Read the checkpoint context needed to resolve a single thread diff.
   */
  readonly getThreadCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadCheckpointContext>, ProjectionRepositoryError>;

  /**
   * Read a single active thread shell row by id.
   */
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;

  /**
   * Every thread's current projected priority ranking, for the shell stream's
   * `thread-priorities` item (a ranking replaces them all at once).
   */
  readonly listThreadPriorities?: () => Effect.Effect<
    ReadonlyArray<OrchestrationThreadPriorityEntry>,
    ProjectionRepositoryError
  >;

  /**
   * Read a single worktree shell row by id.
   */
  readonly getWorktreeShellById?: (
    worktreeId: WorktreeId,
  ) => Effect.Effect<Option.Option<OrchestrationWorktreeShell>, ProjectionRepositoryError>;

  /**
   * One project's workspaces (archived included) and the workspace placement of its live
   * threads: what worktree reconciliation needs, from two indexed reads instead of a whole
   * shell snapshot per project.
   */
  readonly getProjectWorkspaceRows?: (
    projectId: ProjectId,
  ) => Effect.Effect<ProjectionProjectWorkspaceRows, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot by id.
   */
  readonly getThreadDetailById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

  /** Bounded successful-turn context, excluding queued and live primary output. */
  readonly getCompletedSideQuestionContext?: (threadId: ThreadId) => Effect.Effect<
    {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
      readonly activities: ReadonlyArray<{ readonly kind: string; readonly summary: string }>;
    },
    ProjectionRepositoryError
  >;

  /** Read the newest bounded history window for one active thread. */
  readonly getThreadWindow?: (
    input: OrchestrationGetThreadWindowInput,
  ) => Effect.Effect<
    OrchestrationThreadWindowSnapshot,
    ProjectionRepositoryError | OrchestrationThreadHistoryError
  >;

  /** Read an older page or a page around a stable history anchor. */
  readonly getThreadHistoryPage?: (
    input: OrchestrationGetThreadHistoryPageInput,
  ) => Effect.Effect<
    OrchestrationThreadHistoryPage,
    ProjectionRepositoryError | OrchestrationThreadHistoryError
  >;

  /**
   * Read one stored activity payload of an active thread, with its encoded
   * size, for a client expanding a row the window sent as a preview.
   * Optional so existing test doubles stay valid; the RPC reports it
   * unavailable.
   */
  readonly getActivityPayload?: (input: {
    readonly threadId: ThreadId;
    readonly activityId: EventId;
  }) => Effect.Effect<
    Option.Option<{
      readonly kind: string;
      readonly payload: unknown;
      readonly payloadBytes: number;
    }>,
    ProjectionRepositoryError
  >;

  /**
   * Read only the file-path references carried by a thread's task activities
   * (workflow `runHandles.scriptPath` and task `outputFile`). Deliberately
   * narrow: the task-output RPC re-authorizes on every poll of a running
   * task, and that must not materialize the full thread detail each time.
   * Optional so existing test doubles stay valid; callers fall back to
   * `getThreadDetailById`.
   */
  readonly listThreadTaskPathRefs?: (threadId: ThreadId) => Effect.Effect<
    {
      readonly scriptPaths: ReadonlyArray<string>;
      readonly outputPaths: ReadonlyArray<string>;
    },
    ProjectionRepositoryError
  >;

  /**
   * Read a single projected message by id without hydrating the thread.
   * Turn start validates the requested message with this instead of loading
   * every message, part, and activity. Optional so existing test doubles
   * stay valid; callers fall back to `getThreadDetailById`.
   */
  readonly getThreadMessageById?: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<Option.Option<OrchestrationMessage>, ProjectionRepositoryError>;

  /**
   * Read the newest bounded slice of one turn's messages (newest first, up to
   * `limit`). Turn completion and streaming boundaries use this so per-turn
   * finalization never triggers a full-thread read. Optional so existing test
   * doubles stay valid; callers fall back to `getThreadDetailById`.
   */
  readonly listThreadMessagesByTurn?: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<OrchestrationMessage>, ProjectionRepositoryError>;

  /**
   * Count projected user messages for one thread (aggregate only). Turn start
   * uses this to detect the first user message without reading them all.
   * Optional so existing test doubles stay valid; callers fall back to
   * `getThreadDetailById`.
   */
  readonly countThreadUserMessages?: (
    threadId: ThreadId,
  ) => Effect.Effect<number, ProjectionRepositoryError>;

  /**
   * Read a single projected proposed plan by id. Plan finalization only needs
   * the prior timestamps of the plan it replaces. Optional so existing test
   * doubles stay valid; callers fall back to `getThreadDetailById`.
   */
  readonly getThreadProposedPlanById?: (input: {
    readonly threadId: ThreadId;
    readonly planId: string;
  }) => Effect.Effect<
    Option.Option<{
      readonly id: string;
      readonly createdAt: string;
      readonly implementedAt: string | null;
      readonly implementationThreadId: ThreadId | null;
    }>,
    ProjectionRepositoryError
  >;

  /**
   * Newest `checkpoint.revert` activity per live thread whose status is still
   * pending. Read once at startup so checkpoint revert recovery can finish or
   * terminalize interrupted reverts. Optional so hand-written fakes need no edits.
   */
  readonly listPendingCheckpointReverts?: () => Effect.Effect<
    ReadonlyArray<{
      readonly threadId: ThreadId;
      readonly activity: OrchestrationThreadActivity;
      readonly payload: CheckpointRevertActivityPayload;
    }>,
    ProjectionRepositoryError
  >;

  /**
   * One thread's newest `checkpoint.revert` activity (any status), or null. Reads only
   * that thread's journal through its thread index, so per-delivery callers (the
   * delegated-return worker) never scan every thread's activities. Judge it with
   * `isCheckpointRevertEntryPending`. Optional so hand-written fakes need no edits.
   */
  readonly getLatestCheckpointRevert?: (threadId: ThreadId) => Effect.Effect<
    {
      readonly activity: OrchestrationThreadActivity;
      readonly payload: CheckpointRevertActivityPayload;
    } | null,
    ProjectionRepositoryError
  >;

  /**
   * Search active projected user/assistant messages across threads.
   */
  readonly searchThreadMessages: (
    input: OrchestrationSearchThreadMessagesInput,
  ) => Effect.Effect<
    ReadonlyArray<OrchestrationThreadMessageSearchResult>,
    ProjectionRepositoryError
  >;
}

type ShellSnapshotFallback<Narrow extends keyof ProjectionSnapshotQueryShape> = Pick<
  ProjectionSnapshotQueryShape,
  "getShellSnapshot" | Narrow
>;

/**
 * Live projects. Server code that needs projects only must not build a whole shell snapshot;
 * the architecture test in `ProjectionSnapshotQuery.callers.test.ts` keeps it that way.
 */
export const readProjectShells = (
  query: ShellSnapshotFallback<"listProjectShells">,
): Effect.Effect<ReadonlyArray<OrchestrationProjectShell>, ProjectionRepositoryError> =>
  query.listProjectShells?.() ??
  Effect.map(query.getShellSnapshot(), (snapshot) => snapshot.projects);

/** Live projects, workspaces and thread placement; see {@link readProjectShells}. */
export const readWorkspacePlacement = (
  query: ShellSnapshotFallback<"getWorkspacePlacement">,
): Effect.Effect<ProjectionWorkspacePlacement, ProjectionRepositoryError> =>
  query.getWorkspacePlacement?.() ?? Effect.map(query.getShellSnapshot(), workspacePlacementOf);

/** Thread summaries of some projects or threads; see {@link readProjectShells}. */
export const readScopedShellSnapshot = (
  query: ShellSnapshotFallback<"getScopedShellSnapshot">,
  scope: ProjectionShellScope,
): Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError> =>
  query.getScopedShellSnapshot?.(scope) ??
  Effect.map(query.getShellSnapshot(), (snapshot) => scopeShellSnapshot(snapshot, scope));

/** Threads whose goal synchronization is pending; see {@link readProjectShells}. */
export const readPendingGoalSyncThreads = (
  query: ShellSnapshotFallback<"listPendingGoalSyncThreads">,
): Effect.Effect<ProjectionPendingGoalSyncThreads, ProjectionRepositoryError> =>
  query.listPendingGoalSyncThreads?.() ??
  Effect.map(query.getShellSnapshot(), pendingGoalSyncThreadsOf);

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("ryco/orchestration/Services/ProjectionSnapshotQuery") {}
