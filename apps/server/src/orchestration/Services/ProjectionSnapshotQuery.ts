/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
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
  OrchestrationThreadShell,
  OrchestrationThreadWindowSnapshot,
  OrchestrationWorktreeShell,
  ProjectId,
  ThreadId,
  TurnId,
  WorktreeId,
} from "@ryco/contracts";
import { Context } from "effect";
import type { Option } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ProjectionSnapshotCounts {
  readonly projectCount: number;
  readonly threadCount: number;
}

export interface ProjectionSnapshotSequence {
  readonly snapshotSequence: number;
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
   * Read a single worktree shell row by id.
   */
  readonly getWorktreeShellById?: (
    worktreeId: WorktreeId,
  ) => Effect.Effect<Option.Option<OrchestrationWorktreeShell>, ProjectionRepositoryError>;

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
   * Search active projected user/assistant messages across threads.
   */
  readonly searchThreadMessages: (
    input: OrchestrationSearchThreadMessagesInput,
  ) => Effect.Effect<
    ReadonlyArray<OrchestrationThreadMessageSearchResult>,
    ProjectionRepositoryError
  >;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("ryco/orchestration/Services/ProjectionSnapshotQuery") {}
