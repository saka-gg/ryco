import {
  type CommandId,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  type ProjectId,
  type ThreadTurnStartBootstrap,
} from "@ryco/contracts";
import { isChatProject } from "@ryco/shared/projectKind";
import { Effect, Option, Schema } from "effect";

import { type ChatFoldersShape, chatProjectTitle } from "../../project/chatFolders.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionProjectRepositoryShape } from "../../persistence/Services/ProjectionProjects.ts";

type BootstrapCreateChatProject = NonNullable<ThreadTurnStartBootstrap["createChatProject"]>;
type BootstrapCreateThread = NonNullable<ThreadTurnStartBootstrap["createThread"]>;

export interface ChatBootstrapDependencies {
  /** Absent on nodes without chat support; every chat first send is then refused. */
  readonly chatFolders:
    | Pick<ChatFoldersShape, "allocateChatFolder" | "ensureChatFolder" | "removeEmptyChatFolder">
    | undefined;
  readonly projects: Pick<
    ProjectionSnapshotQueryShape,
    "getProjectShellById" | "getActiveProjectByWorkspaceRoot" | "getFirstActiveThreadIdByProjectId"
  >;
  /**
   * Project records including deleted ones, to recognize a retired chat id. Provided wherever
   * `chatFolders` is (both need persistence); without it a retired id fails as a plain duplicate.
   */
  readonly projectRecords: Pick<ProjectionProjectRepositoryShape, "getById"> | undefined;
  /** Server-internal dispatch: chat projects are never created through client normalization. */
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => ReturnType<OrchestrationEngineShape["dispatch"]>;
  readonly serverCommandId: (tag: string) => CommandId;
}

export interface PreparedChatProject {
  readonly projectId: ProjectId;
  readonly folder: string;
  /** This attempt created the folder, so a later failure may remove it again. */
  readonly createdFolder: boolean;
}

const dispatchError = (message: string, cause?: unknown) =>
  new OrchestrationDispatchCommandError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const toDispatchError = (cause: unknown, fallback: string) =>
  Schema.is(OrchestrationDispatchCommandError)(cause)
    ? cause
    : dispatchError(cause instanceof Error ? cause.message : fallback, cause);

/**
 * The chat id names a project this node already deleted: an unused chat that startup cleanup
 * removed (`project/orphanChatProjects.ts`), or a chat whose last conversation was deleted. The
 * decider never re-creates a project id, so a stale draft must start over with a fresh one.
 */
const chatProjectRetiredError = (cause?: unknown) =>
  new OrchestrationDispatchCommandError({
    message:
      "This chat was cleaned up before its first message was sent. Start a new chat to send this message.",
    reason: "chat-project-retired",
    ...(cause === undefined ? {} : { cause }),
  });

/** Whether `projectId` belongs to a deleted project record. A failed read counts as not retired. */
const isRetiredProject = (deps: ChatBootstrapDependencies, projectId: ProjectId) =>
  deps.projectRecords === undefined
    ? Effect.succeed(false)
    : deps.projectRecords.getById({ projectId }).pipe(
        Effect.map(Option.match({ onNone: () => false, onSome: (row) => row.deletedAt !== null })),
        Effect.orElseSucceed(() => false),
      );

/**
 * Report a failed chat first send as {@link chatProjectRetiredError} when its chat was retired
 * meanwhile (startup cleanup runs concurrently with the first sends after a restart), so the client
 * starts over with a fresh id instead of retrying one that can never work. Otherwise `error` as is.
 */
export const classifyChatBootstrapFailure = (
  deps: ChatBootstrapDependencies,
  projectId: ProjectId,
  error: OrchestrationDispatchCommandError,
): Effect.Effect<OrchestrationDispatchCommandError> =>
  error.reason === "chat-project-retired"
    ? Effect.succeed(error)
    : isRetiredProject(deps, projectId).pipe(
        Effect.map((retired) => (retired ? chatProjectRetiredError(error) : error)),
      );

/**
 * Remove a folder this attempt created, once nothing depends on it: never one another project
 * owns, and never while a concurrent send of the same chat already has a live thread there.
 * The chat project itself stays, so retrying the same draft reuses it instead of allocating a
 * second folder. Never fails.
 */
export const releasePreparedChatFolder = (
  deps: ChatBootstrapDependencies,
  prepared: PreparedChatProject,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!prepared.createdFolder || !deps.chatFolders) return;
    const owner = yield* deps.projects.getActiveProjectByWorkspaceRoot(prepared.folder);
    if (Option.isSome(owner)) {
      if (owner.value.id !== prepared.projectId) return;
      const liveThread = yield* deps.projects.getFirstActiveThreadIdByProjectId(prepared.projectId);
      if (Option.isSome(liveThread)) return;
    }
    yield* deps.chatFolders.removeEmptyChatFolder(prepared.folder);
  }).pipe(Effect.ignoreCause({ log: true }));

/**
 * Give a chat first send its project: reuse the chat project of an earlier attempt (recreating
 * its folder if that attempt's cleanup removed it), or allocate a folder and create a `chat`
 * project there. Runs before thread creation; on failure it leaves nothing new behind. An id
 * whose project was deleted fails with reason `chat-project-retired` before anything is created.
 */
export const prepareChatProject = (
  deps: ChatBootstrapDependencies,
  input: {
    readonly chat: BootstrapCreateChatProject;
    readonly createThread: BootstrapCreateThread;
  },
): Effect.Effect<PreparedChatProject, OrchestrationDispatchCommandError> =>
  Effect.gen(function* () {
    const chatFolders = deps.chatFolders;
    if (!chatFolders) {
      return yield* dispatchError("Chats without a project are not available on this server.");
    }
    if (input.createThread.worktreePath !== null) {
      return yield* dispatchError(
        "A chat without a project runs in its own folder and cannot use a worktree.",
      );
    }
    const { projectId, titleSeed } = input.chat;
    const existing = yield* deps.projects
      .getProjectShellById(projectId)
      .pipe(Effect.mapError((cause) => toDispatchError(cause, "Failed to read the chat.")));
    if (Option.isSome(existing)) {
      if (!isChatProject(existing.value)) {
        return yield* dispatchError(`Project '${projectId}' already exists and is not a chat.`);
      }
      const folder = existing.value.workspaceRoot;
      const liveThread = yield* deps.projects
        .getFirstActiveThreadIdByProjectId(projectId)
        .pipe(Effect.mapError((cause) => toDispatchError(cause, "Failed to read the chat.")));
      // A chat already in use keeps its folder as it is; recreating one here could race a move.
      if (Option.isSome(liveThread)) return { projectId, folder, createdFolder: false };
      // A retried first send: the failed attempt kept this chat but removed its empty folder.
      const ensured = yield* chatFolders
        .ensureChatFolder(folder)
        .pipe(Effect.mapError((cause) => dispatchError(cause.detail, cause)));
      return { projectId, folder, createdFolder: ensured.created };
    }
    // Not active: a deleted record would make `project.create` fail as a duplicate, forever.
    if (yield* isRetiredProject(deps, projectId)) return yield* chatProjectRetiredError();

    const folder = yield* chatFolders
      .allocateChatFolder({ createdAt: input.createThread.createdAt, titleSeed, projectId })
      .pipe(Effect.mapError((cause) => dispatchError(cause.detail, cause)));
    const prepared: PreparedChatProject = { projectId, folder, createdFolder: true };
    yield* deps
      .dispatch({
        type: "project.create",
        commandId: deps.serverCommandId("bootstrap-chat-project-create"),
        projectId,
        kind: "chat",
        title: chatProjectTitle(titleSeed),
        workspaceRoot: folder,
        createdAt: input.createThread.createdAt,
      })
      .pipe(
        Effect.mapError((cause) => toDispatchError(cause, "Failed to create the chat.")),
        Effect.onError(() => releasePreparedChatFolder(deps, prepared)),
      );
    return prepared;
  });
