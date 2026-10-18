import {
  buildSendTurnBootstrap,
  type SendTurnBootstrap,
} from "@ryco/client-runtime/state/composer";
import {
  buildTaskStartPrompt,
  selectTaskView,
  taskBranchSlug,
  taskStartFailed,
  useLocalTasksStore,
  type LocalTaskWriter,
} from "@ryco/client-runtime/state/tasks";
import {
  DEFAULT_RUNTIME_MODE,
  type ComposerSourceControlContext,
  type EnvironmentApi,
  type EnvironmentId,
  type LocalTaskDelegateInput,
  type LocalTaskLink,
  type ModelSelection,
  type ProjectId,
  type ThreadId,
} from "@ryco/contracts";
import { truncate } from "@ryco/shared/String";

import { isHostedHubMode } from "~/env";
import { readEnvironmentApi } from "~/environmentApi";
import { readNewDraftDefaults } from "~/hooks/newDraftDefaults";
import { resolveNodeConfigSource } from "~/hooks/nodeConfigSource";
import { readLocalGitRefName } from "~/lib/gitStatusState";
import { newMessageId, newThreadId, randomUUID } from "~/lib/utils";
import {
  fetchSourceControlChangeRequestDetail,
  fetchSourceControlIssueDetail,
} from "~/rpc/useSourceControl";

import { newWorktreeBaseBranch } from "../chat/NewThreadWorkLocation.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { notifyWorktreeSubmoduleSetup } from "../worktrees/worktreeCreationNotifications";
import {
  buildTaskTurnStartCommand,
  localRefNames,
  resolveTaskStartDefaults,
  taskSourceControlContext,
  taskSourceControlLinks,
  taskStartCommandId,
  taskStartedMessage,
  taskWorktreeBranch,
  type TaskStartPlace,
} from "./startTaskChat.logic";
import { whenTaskFilesSent } from "./taskFiles";

/** How long a linked pull request's or issue's detail may take before the start goes on without it. */
const SOURCE_CONTROL_READ_TIMEOUT_MS = 3_000;
/** How long the branch check of a new worktree may take before the start trusts the task's own names. */
const REF_READ_TIMEOUT_MS = 3_000;
/** How long the project checkout's branch may take to read. */
const PROJECT_BRANCH_READ_TIMEOUT_MS = 3_000;

/** What `read` resolves with, or `null` once `ms` pass first or it fails (even synchronously). */
function settleWithin<T>(read: () => Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    const settle = (value: T | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    try {
      read().then(settle, () => settle(null));
    } catch {
      settle(null);
    }
  });
}

export interface StartTaskChatInput {
  readonly environmentId: EnvironmentId;
  readonly taskId: string;
  readonly place: TaskStartPlace;
  /** The task's project and its checkout. */
  readonly project: { readonly projectId: ProjectId; readonly cwd: string };
  readonly writer: LocalTaskWriter;
  /** Words written after a linked chat's mention in the first message (its title). */
  readonly describeThread: (threadId: ThreadId) => string | null;
  /** The model the chat starts with, once it is known. */
  readonly onModel?: (threadId: ThreadId, modelSelection: ModelSelection) => void;
}

interface PreparedTaskStart {
  readonly command: LocalTaskDelegateInput["command"];
  /** The new worktree's branch; `null` when the chat runs in a checkout that exists. */
  readonly branch: string | null;
}

/** The model and token mode a new thread in the project would open with. */
async function readStartDefaults(
  api: EnvironmentApi,
  environmentId: EnvironmentId,
  projectId: ProjectId,
) {
  const { config, effective } = await readNewDraftDefaults({
    api,
    environmentId,
    ...resolveNodeConfigSource(environmentId, { currentOnly: isHostedHubMode() }),
    projectId,
  });
  const defaults = resolveTaskStartDefaults({ config, effective });
  if (!defaults) throw new Error("Choose a default model in Settings, then start the chat again.");
  return defaults;
}

/**
 * Each linked pull request and issue, read the way the composer's `#` picker
 * reads it (by URL when the link has one, so another repository's item is
 * read from there). One that is slow or fails is left out: the prompt still
 * names it.
 */
async function readSourceControlContexts(
  environmentId: EnvironmentId,
  cwd: string,
  links: ReadonlyArray<LocalTaskLink>,
): Promise<ComposerSourceControlContext[]> {
  const contexts = await Promise.all(
    taskSourceControlLinks(links).map(async ({ kind, reference }) => {
      const detail = await settleWithin<ComposerSourceControlContext["detail"]>(
        () =>
          kind === "change-request"
            ? fetchSourceControlChangeRequestDetail({ environmentId, cwd, reference })
            : fetchSourceControlIssueDetail({ environmentId, cwd, reference }),
        SOURCE_CONTROL_READ_TIMEOUT_MS,
      );
      return detail
        ? taskSourceControlContext({ id: randomUUID(), kind, detail, nowMs: Date.now() })
        : null;
    }),
  );
  return contexts.filter((context) => context !== null);
}

/** Branches that already carry the task's slug; none when the check fails (the node then refuses a clash). */
async function readTaskRefNames(api: EnvironmentApi, cwd: string, title: string) {
  const result = await settleWithin(
    () => api.vcs.listRefs({ cwd, query: `task/${taskBranchSlug(title)}`, limit: 100 }),
    REF_READ_TIMEOUT_MS,
  );
  return result ? localRefNames(result.refs) : [];
}

const readTask = (input: Pick<StartTaskChatInput, "environmentId" | "taskId">) =>
  selectTaskView(useLocalTasksStore.getState(), input.environmentId, input.taskId);

const TASK_DELETED_MESSAGE = "The task was deleted.";

/**
 * Everything a start sends, read and created up front: the defaults, the
 * linked pull requests' and issues' detail, and the chat's thread. A pull
 * request or branch start creates its worktree (and an empty thread on it)
 * here; a new worktree or the project folder is created by the command's
 * bootstrap, together with the thread and the first message. Files still on
 * their way to the task are waited for, since the chat carries what the task
 * holds. `retryOf`, a start that failed, lends its pull request or branch
 * thread, which exists already; a new thread always gets a new id.
 */
async function prepareTaskStart(
  input: StartTaskChatInput,
  retryOf: PreparedTaskStart | null,
): Promise<PreparedTaskStart> {
  const { environmentId, place, project } = input;
  const api = readEnvironmentApi(environmentId);
  if (!api) throw new Error("The node is not connected.");
  const before = readTask(input);
  if (!before) throw new Error(TASK_DELETED_MESSAGE);

  const [defaults, sourceControlContexts, refNames, projectBranch] = await Promise.all([
    readStartDefaults(api, environmentId, project.projectId),
    readSourceControlContexts(environmentId, project.cwd, before.links),
    place.kind === "worktree"
      ? readTaskRefNames(api, project.cwd, before.title)
      : Promise.resolve([]),
    place.kind === "project"
      ? readLocalGitRefName(
          { environmentId, cwd: project.cwd },
          { timeoutMs: PROJECT_BRANCH_READ_TIMEOUT_MS },
        )
      : Promise.resolve(null),
    whenTaskFilesSent(input.taskId),
  ]);
  // Read again: the task may have changed, or gone, while the reads ran. A
  // worktree for a task that is gone would only be left behind.
  const task = readTask(input);
  if (!task) throw new Error(TASK_DELETED_MESSAGE);

  const title = truncate(task.title);
  const createdAt = new Date().toISOString();
  const messageId = newMessageId();
  let threadId: ThreadId;
  let bootstrap: SendTurnBootstrap;
  let branch: string | null = null;
  if ((place.kind === "pr" || place.kind === "branch") && retryOf && !retryOf.command.bootstrap) {
    threadId = retryOf.command.threadId;
    bootstrap = undefined;
  } else if (place.kind === "pr" || place.kind === "branch") {
    const createWorktree = api.git.createWorktreeForProject;
    if (!createWorktree) throw new Error("This node can’t create worktrees for links.");
    // Creates (or, for a pull request, reuses) the worktree and an empty thread on it.
    const created = await createWorktree({
      projectId: project.projectId,
      intent:
        place.kind === "pr"
          ? { kind: "pr", number: place.number }
          : { kind: "branch", branchName: place.name },
      fetchOrigin: true,
    });
    notifyWorktreeSubmoduleSetup(created.submoduleInitialization);
    threadId = created.sessionId;
    bootstrap = undefined;
  } else {
    threadId = newThreadId();
    const worktree = place.kind === "worktree";
    if (worktree) {
      const startBranches = [...task.delegations, ...task.optimisticStarts].flatMap((start) =>
        start.branch ? [start.branch] : [],
      );
      branch = taskWorktreeBranch({
        title: task.title,
        startBranches,
        existingRefNames: refNames,
      });
    }
    bootstrap = buildSendTurnBootstrap({
      requireWorktree: worktree,
      isLocalDraftThread: true,
      fetchOrigin: worktree,
      worktreeBranchName: branch,
      baseBranchForWorktree: worktree ? newWorktreeBaseBranch(null, true) : null,
      shouldMaterializeLegacyBranchWorktree: false,
      // The node resolves the project's setup-script choice itself.
      runSetupScript: undefined,
      projectId: project.projectId,
      projectCwd: project.cwd,
      title,
      threadCreateModelSelection: defaults.modelSelection,
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: "default",
      tokenMode: defaults.tokenMode,
      activeThreadBranch: worktree ? null : (projectBranch ?? null),
      worktreePath: null,
      threadCreatedAt: createdAt,
    });
  }
  input.onModel?.(threadId, defaults.modelSelection);

  const text = buildTaskStartPrompt({
    title: task.title,
    notes: task.notes,
    links: task.links,
    describeThread: input.describeThread,
  });
  return {
    command: buildTaskTurnStartCommand({
      commandId: taskStartCommandId(task.taskId, messageId),
      threadId,
      messageId,
      text,
      title,
      modelSelection: defaults.modelSelection,
      tokenMode: defaults.tokenMode,
      bootstrap,
      sourceControlContexts,
      createdAt,
    }),
    branch,
  };
}

function errorText(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : "The node didn’t start it.";
}

/** A failed start's toast; its Retry is offered while the task is still there. */
function reportFailure(input: StartTaskChatInput, cause: unknown, retry: () => void): void {
  const deleted = !readTask(input);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Couldn’t start the chat",
      description: deleted ? TASK_DELETED_MESSAGE : errorText(cause),
      ...(deleted
        ? {}
        : {
            actionProps: {
              children: "Retry",
              onClick: () => {
                if (readTask(input)) retry();
                else toastManager.add({ type: "info", title: TASK_DELETED_MESSAGE });
              },
            },
          }),
    }),
  );
}

/**
 * Sends a prepared start. A resolved send whose start the node recorded as
 * failed is a failure too (the node never answers one as started, but its
 * word decides).
 */
async function sendTaskStart(
  input: StartTaskChatInput,
  prepared: PreparedTaskStart,
): Promise<boolean> {
  try {
    const task = await input.writer.delegate(input.taskId, prepared.command, {
      branch: prepared.branch,
    });
    if (taskStartFailed(task, prepared.command.commandId)) {
      const recorded = task.delegations.find(
        (delegation) => delegation.commandId === prepared.command.commandId,
      );
      throw new Error(recorded?.error ?? "The node didn’t start it.");
    }
  } catch (cause) {
    reportFailure(input, cause, () => void retryTaskStart(input, prepared));
    return false;
  }
  toastManager.add({ type: "success", title: taskStartedMessage(input.place, prepared.branch) });
  return true;
}

/**
 * Retries a start that failed. While the node has no failure on record (the
 * reply was lost, or the start never reached it) the very same command goes
 * again, so one that did reach the node is not started twice. Once the node
 * recorded it as failed, that command can never run: a new start (new
 * command, message and, for a new thread, thread) takes its place.
 */
function retryTaskStart(input: StartTaskChatInput, prepared: PreparedTaskStart): Promise<boolean> {
  const task = readTask(input);
  return task && taskStartFailed(task, prepared.command.commandId)
    ? startTaskChatFrom(input, prepared)
    : sendTaskStart(input, prepared);
}

async function startTaskChatFrom(
  input: StartTaskChatInput,
  retryOf: PreparedTaskStart | null,
): Promise<boolean> {
  let prepared: PreparedTaskStart;
  try {
    prepared = await prepareTaskStart(input, retryOf);
  } catch (cause) {
    reportFailure(input, cause, () => void startTaskChatFrom(input, retryOf));
    return false;
  }
  return sendTaskStart(input, prepared);
}

/**
 * Starts a chat for a task in `place` and sends its first message right
 * away; the chat runs in the background. It shows as starting on the task
 * once the command goes out, and a toast says where it runs. A failure is a
 * toast with Retry. Resolves whether the node took the start.
 */
export function startTaskChat(input: StartTaskChatInput): Promise<boolean> {
  return startTaskChatFrom(input, null);
}
