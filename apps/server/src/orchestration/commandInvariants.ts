import path from "node:path";

import type {
  OrchestrationCommand,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  OrchestrationWorktreeShell,
  ProjectId,
  ThreadId,
  WorktreeId,
} from "@ryco/contracts";
import { ContextHandoffActivityPayload } from "@ryco/contracts";
import { Effect, Option, Schema } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

function activityRequestId(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const requestId = Reflect.get(payload, "requestId");
  return typeof requestId === "string" && requestId.trim().length > 0 ? requestId : null;
}

function hasOpenActivityRequest(
  thread: OrchestrationThread,
  requestedKind: string,
  resolvedKind: string,
): boolean {
  const open = new Set<string>();
  let hasUncorrelatedRequest = false;
  const ordered = [...thread.activities].toSorted(
    (left, right) =>
      (left.sequence ?? 0) - (right.sequence ?? 0) ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
  for (const activity of ordered) {
    if (activity.kind !== requestedKind && activity.kind !== resolvedKind) {
      continue;
    }
    const requestId = activityRequestId(activity.payload);
    if (activity.kind === requestedKind) {
      if (requestId === null) {
        hasUncorrelatedRequest = true;
      } else {
        open.add(requestId);
      }
    } else if (requestId === null) {
      hasUncorrelatedRequest = false;
    } else {
      open.delete(requestId);
    }
  }
  return hasUncorrelatedRequest || open.size > 0;
}

/**
 * Turn starts that ended before anything was submitted: those that failed
 * visibly, and those a Stop cancelled. Neither will ever dispatch.
 */
const ENDED_TURN_START_KINDS: ReadonlySet<string> = new Set([
  "provider.turn.start.failed",
  "provider.turn.start.cancelled",
]);

/** User messages whose turn start already failed or was cancelled. */
function endedTurnStartMessageIds(thread: OrchestrationThread): ReadonlySet<string> {
  const messageIds = new Set<string>();
  for (const activity of thread.activities) {
    if (!ENDED_TURN_START_KINDS.has(activity.kind)) continue;
    const payload = activity.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
    const messageId = Reflect.get(payload, "messageId");
    if (typeof messageId === "string") messageIds.add(messageId);
  }
  return messageIds;
}

export function hasActionableContextHandoff(thread: OrchestrationThread): boolean {
  const decode = Schema.decodeUnknownOption(ContextHandoffActivityPayload);
  let endedTurnStarts: ReadonlySet<string> | undefined;
  return thread.activities.some((activity) => {
    if (activity.kind !== "context-handoff") {
      return false;
    }
    return Option.match(decode(activity.payload), {
      onNone: () => true,
      onSome: (payload) => {
        if (payload.status === "dispatching") return true;
        if (payload.status !== "requested" && payload.status !== "preparing") return false;
        // Nothing was sent before `dispatching`. A handoff whose target turn
        // start already failed or was cancelled by a Stop (for example,
        // preparation ended before the coordinator created or could finalize
        // its record) never dispatches.
        endedTurnStarts ??= endedTurnStartMessageIds(thread);
        return !endedTurnStarts.has(payload.targetMessageId);
      },
    });
  });
}

export function requireThreadIdleForContextHandoff(input: {
  readonly thread: OrchestrationThread;
  readonly command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const { thread, command } = input;
  const sessionStatus = thread.session?.status;
  if (sessionStatus === "starting" || sessionStatus === "running") {
    return Effect.fail(
      invariantError(
        command.type,
        `Thread '${thread.id}' is ${sessionStatus} and cannot hand off until it is idle.`,
      ),
    );
  }
  if (thread.latestTurn?.state === "running" && thread.latestTurn.completedAt === null) {
    return Effect.fail(
      invariantError(
        command.type,
        `Thread '${thread.id}' has an unsettled turn and cannot hand off until it is idle.`,
      ),
    );
  }
  if (hasOpenActivityRequest(thread, "approval.requested", "approval.resolved")) {
    return Effect.fail(
      invariantError(
        command.type,
        `Thread '${thread.id}' has a pending approval and cannot hand off.`,
      ),
    );
  }
  if (hasOpenActivityRequest(thread, "user-input.requested", "user-input.resolved")) {
    return Effect.fail(
      invariantError(
        command.type,
        `Thread '${thread.id}' has a pending user-input request and cannot hand off.`,
      ),
    );
  }
  if (hasActionableContextHandoff(thread)) {
    return Effect.fail(
      invariantError(
        command.type,
        `Thread '${thread.id}' already has an actionable context handoff.`,
      ),
    );
  }
  if (
    command.bootstrap?.prepareWorktree !== undefined ||
    command.bootstrap?.runSetupScript === true
  ) {
    return Effect.fail(
      invariantError(
        command.type,
        `Thread '${thread.id}' cannot hand off while worktree preparation is requested.`,
      ),
    );
  }
  return Effect.void;
}

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

export function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function findWorktreeById(
  readModel: OrchestrationReadModel,
  worktreeId: WorktreeId,
): OrchestrationWorktreeShell | undefined {
  return readModel.worktrees?.find((worktree) => worktree.worktreeId === worktreeId);
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

/**
 * Compares two recorded workspace paths. Paths reach the projection from
 * several sources (composer input, git output, RPC payloads), so the same
 * directory shows up with trailing separators or unresolved segments. Comparing
 * the raw strings leaves threads stranded on a worktree that was deleted around
 * them. Symlinked spellings need the filesystem to resolve and are handled by
 * the worktree reconciliation sweep instead.
 */
function isSamePathText(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/g, "");
    return process.platform === "win32" || process.platform === "darwin"
      ? resolved.toLowerCase()
      : resolved;
  };
  return normalize(left) === normalize(right);
}

export function listThreadsByWorktree(
  readModel: OrchestrationReadModel,
  worktree: OrchestrationWorktreeShell,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => {
    if (thread.projectId !== worktree.projectId) {
      return false;
    }
    if (thread.worktreeId === worktree.worktreeId) {
      return true;
    }
    return (
      thread.worktreeId == null &&
      worktree.worktreePath !== null &&
      thread.worktreePath !== null &&
      isSamePathText(thread.worktreePath, worktree.worktreePath)
    );
  });
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

/**
 * {@link requireProject}, refusing a removed one. The read model keeps removed projects (with
 * `deletedAt`) so their history resolves, but nothing may change them or add to them: a retired
 * chat's record must not be pointed at another folder, and a thread created in it would be
 * invisible and would run without its folder.
 */
export function requireActiveProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  return requireProject(input).pipe(
    Effect.flatMap((project) =>
      project.deletedAt === null
        ? Effect.succeed(project)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Project '${input.projectId}' was removed and cannot be used by command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireWorktree(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly worktreeId: WorktreeId;
}): Effect.Effect<OrchestrationWorktreeShell, OrchestrationCommandInvariantError> {
  const worktree = findWorktreeById(input.readModel, input.worktreeId);
  if (worktree) {
    return Effect.succeed(worktree);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Worktree '${input.worktreeId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt !== null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is not archived for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt === null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadHasUserMessage(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.messages.some((message) => message.role === "user")
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' cannot be archived before a message has been sent.`,
            ),
          ),
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  // Deletion is soft and a draft keeps its client-generated id across retries.
  // Only a live or trashed incarnation blocks creation; projections reset
  // incarnation-scoped state when a permanently deleted id is created again.
  const existing = findThreadById(input.readModel, input.threadId);
  if (existing === undefined || (existing.deletedAt !== null && existing.trashedAt == null)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireNonNegativeInteger(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}

/** Resolve both ID-backed and historical path-backed thread workspace ownership. */
export function findThreadWorktree(
  readModel: OrchestrationReadModel,
  thread: OrchestrationReadModel["threads"][number],
) {
  if (thread.worktreeId != null) return findWorktreeById(readModel, thread.worktreeId);
  if (thread.worktreePath == null) return undefined;
  return readModel.worktrees?.find(
    (worktree) =>
      worktree.projectId === thread.projectId && worktree.worktreePath === thread.worktreePath,
  );
}

export const isThreadTrashed = (thread: Pick<OrchestrationThread, "trashedAt">): boolean =>
  thread.trashedAt != null;

/** Live = neither in Trash nor permanently deleted. */
export const isThreadLive = (thread: Pick<OrchestrationThread, "deletedAt">): boolean =>
  thread.deletedAt === null;

/**
 * Never-used: no user message and no turn. Only these may be deleted without passing
 * through Trash (internal rollback of a creation that failed before any work).
 */
export const isThreadPristine = (
  thread: Pick<OrchestrationThread, "messages" | "latestTurn">,
): boolean => thread.latestTurn === null && !thread.messages.some((m) => m.role === "user");

/**
 * Why new work cannot start in this thread. A removed checkout is never replaced by
 * the project root: resuming requires recreating the checkout or another workspace.
 */
export function threadLifecycleTurnBlocker(
  readModel: OrchestrationReadModel,
  thread: OrchestrationThread,
): string | null {
  if (isThreadTrashed(thread))
    return "This conversation is in Trash. Restore it before continuing.";
  if (!isThreadLive(thread)) return "This conversation was deleted.";
  const worktree = findThreadWorktree(readModel, thread);
  // Only while the thread still targets that checkout: explicitly choosing another
  // workspace (or the project root) is how a user resumes elsewhere.
  if (
    worktree?.checkoutRemovedAt != null &&
    worktree.worktreePath !== null &&
    thread.worktreePath !== null &&
    isSamePathText(thread.worktreePath, worktree.worktreePath)
  ) {
    return `The checkout for workspace "${worktree.title ?? worktree.branch}" was removed. Recreate the checkout before continuing; history stays readable.`;
  }
  return null;
}
