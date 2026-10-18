import type { CommitSendTurnDispatchInput, DraftId } from "@ryco/client-runtime/state/composer";
import {
  buildTaskStartPrompt,
  refreshLocalTasks,
  selectLocalTasksEnvironment,
  selectTaskView,
  taskBranchSlug,
  taskStartFailed,
  useLocalTasksStore,
  type LocalTaskView,
} from "@ryco/client-runtime/state/tasks";
import type {
  ComposerSourceControlContext,
  EnvironmentApi,
  EnvironmentId,
  LocalTaskLink,
  ScopedProjectRef,
  ThreadId,
} from "@ryco/contracts";

import { useComposerDraftStore } from "~/composerDraftStore";
import { readEnvironmentApi } from "~/environmentApi";
import type { OpenedTaskChatDraft, TaskChatDraftSeed } from "~/hooks/useHandleNewThread";
import { randomUUID } from "~/lib/utils";
import {
  fetchSourceControlChangeRequestDetail,
  fetchSourceControlIssueDetail,
} from "~/rpc/useSourceControl";

import { toastManager } from "../ui/toast";
import {
  localRefNames,
  taskDraftPlacement,
  taskSourceControlContext,
  taskSourceControlLinks,
  taskWorktreeBranch,
  type TaskDraftPlacement,
} from "./taskDraft.logic";
import { whenTaskFilesSent } from "./taskFiles";
import { localTaskWriterFor, retainLocalTasksFor } from "./useLocalTasks";

/**
 * Starting a chat from a task opens a draft prefilled with it, where the
 * user picks the model, modes and worktree and sends. The draft keeps the
 * task (`localTaskId`), so its first message starts the chat as the task's
 * (`taskDraftSend`): the node records it under the task and gives it the
 * task's files.
 */

/** Opens (or reopens) a task's draft: `useNewThreadHandler().handleNewTaskChat`. */
export type OpenTaskDraft = (
  projectRef: ScopedProjectRef,
  seed: TaskChatDraftSeed,
) => Promise<OpenedTaskChatDraft | null>;

/** How long a linked pull request's or issue's detail, or the branch check, may take. */
const BACKGROUND_READ_TIMEOUT_MS = 5_000;

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

const readTask = (environmentId: EnvironmentId, taskId: string) =>
  selectTaskView(useLocalTasksStore.getState(), environmentId, taskId);

/** The draft, while it is still unsent and still the task's. */
function unsentTaskDraft(draftId: DraftId, taskId: string) {
  const draft = useComposerDraftStore.getState().getDraftSession(draftId);
  return draft && !draft.promotedTo && draft.localTaskId === taskId ? draft : null;
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
  repository: string | null,
): Promise<ComposerSourceControlContext[]> {
  const contexts = await Promise.all(
    taskSourceControlLinks(links, repository).map(async ({ kind, reference }) => {
      const detail = await settleWithin<ComposerSourceControlContext["detail"]>(
        () =>
          kind === "change-request"
            ? fetchSourceControlChangeRequestDetail({ environmentId, cwd, reference })
            : fetchSourceControlIssueDetail({ environmentId, cwd, reference }),
        BACKGROUND_READ_TIMEOUT_MS,
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
    BACKGROUND_READ_TIMEOUT_MS,
  );
  return result ? localRefNames(result.refs) : [];
}

/**
 * What a fresh task draft gains once it is open, without holding it up: the
 * linked pull requests' and issues' detail as attached context, and a branch
 * name moved past one that exists already. Each lands only while the draft
 * is unsent, and the branch name only while it is still the one seeded.
 */
async function completeTaskDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly draftId: DraftId;
  readonly taskId: string;
  readonly cwd: string;
  /** The project's repository (`projectRepositoryKey`): only its own items are attached. */
  readonly repository: string | null;
  readonly title: string;
  readonly links: ReadonlyArray<LocalTaskLink>;
  readonly startBranches: ReadonlyArray<string>;
  readonly placement: TaskDraftPlacement;
}): Promise<void> {
  const { environmentId, draftId, taskId, placement } = input;
  const api = readEnvironmentApi(environmentId);
  const seededBranch = placement.worktreeBranchName;
  await Promise.all([
    readSourceControlContexts(environmentId, input.cwd, input.links, input.repository).then(
      (contexts) => {
        if (contexts.length === 0 || !unsentTaskDraft(draftId, taskId)) return;
        const store = useComposerDraftStore.getState();
        const attached = new Set(
          (store.getComposerDraft(draftId)?.sourceControlContexts ?? []).map(
            (context) => context.reference,
          ),
        );
        for (const context of contexts)
          if (!attached.has(context.reference)) store.addSourceControlContext(draftId, context);
      },
    ),
    seededBranch && api
      ? readTaskRefNames(api, input.cwd, input.title).then((refNames) => {
          const next = taskWorktreeBranch({
            title: input.title,
            startBranches: input.startBranches,
            existingRefNames: refNames,
          });
          const draft = unsentTaskDraft(draftId, taskId);
          if (next === seededBranch || draft?.worktreeBranchName !== seededBranch) return;
          useComposerDraftStore
            .getState()
            .setDraftThreadContext(draftId, { worktreeBranchName: next });
        })
      : undefined,
  ]);
}

/**
 * Opens a task's draft: its unsent draft when it has one, else a new draft
 * in the task's project with the task as the message (title, notes, links)
 * and its worktree set from its links (`taskDraftPlacement`).
 */
export async function openTaskDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly taskId: string;
  readonly project: {
    readonly projectRef: ScopedProjectRef;
    readonly cwd: string;
    /** The project's repository (`projectRepositoryKey`). */
    readonly repository: string | null;
  };
  /** The node can create a worktree for a pull request, issue or Jira item. */
  readonly sourceWorktrees: boolean;
  /** Words written after a linked chat's mention in the message (its title). */
  readonly describeThread: (threadId: ThreadId) => string | null;
  readonly open: OpenTaskDraft;
}): Promise<void> {
  const { environmentId, taskId, project } = input;
  const task = readTask(environmentId, taskId);
  if (!task) {
    toastManager.add({ type: "info", title: "The task was deleted." });
    return;
  }
  // Starts still on their way count too: the hint beside Start already names the next branch.
  const startBranches = [...task.delegations, ...task.optimisticStarts].flatMap((start) =>
    start.branch ? [start.branch] : [],
  );
  const placement = taskDraftPlacement({
    title: task.title,
    links: task.links,
    projectRepository: project.repository,
    startBranches,
    sourceWorktrees: input.sourceWorktrees,
  });
  const opened = await input.open(project.projectRef, {
    taskId,
    prompt: buildTaskStartPrompt({
      title: task.title,
      notes: task.notes,
      links: task.links,
      describeThread: input.describeThread,
    }),
    ...placement,
  });
  if (!opened?.created) return;
  void completeTaskDraft({
    environmentId,
    draftId: opened.draftId,
    taskId,
    cwd: project.cwd,
    repository: project.repository,
    title: task.title,
    links: task.links,
    startBranches,
    placement,
  });
}

const TASK_READ_ERROR = "Couldn’t read the task. Check the connection and try again.";

/**
 * Runs `use` with the node's tasks kept read, reading them first when this
 * client doesn't have the task: a task draft can be sent from a composer
 * where nothing else keeps them (the Task chip may not be on screen).
 */
async function withTask<T>(
  environmentId: EnvironmentId,
  taskId: string,
  use: (task: LocalTaskView) => Promise<T>,
): Promise<T> {
  const release = retainLocalTasksFor(environmentId);
  try {
    if (!readTask(environmentId, taskId)) await refreshLocalTasks(environmentId);
    const task = readTask(environmentId, taskId);
    if (!task) {
      const tasks = selectLocalTasksEnvironment(useLocalTasksStore.getState(), environmentId);
      throw new Error(
        tasks.readAt === null
          ? TASK_READ_ERROR
          : "The task was deleted. Unlink it to send this as a plain chat.",
      );
    }
    if (task.state === "done")
      throw new Error("The task is done. Reopen it, or unlink it to send this as a plain chat.");
    return await use(task);
  } finally {
    release();
  }
}

/**
 * How a task draft's first message goes out: as the task's chat, through the
 * task writer, so it shows as starting on the task at once and waits for the
 * task's files still on their way (the node gives the chat the files the
 * task holds). `preflight` checks the task before anything is created for the
 * send (a pull request's or issue's worktree is made before the message goes
 * out), so a deleted or done task leaves nothing behind.
 */
export function taskDraftSend(
  environmentId: EnvironmentId,
  taskId: string,
): NonNullable<CommitSendTurnDispatchInput["localTask"]> & {
  readonly preflight: () => Promise<void>;
} {
  return {
    preflight: () => withTask(environmentId, taskId, async () => undefined),
    delegate: (command) =>
      withTask(environmentId, taskId, async () => {
        await whenTaskFilesSent(taskId);
        const task = await localTaskWriterFor(environmentId).delegate(taskId, command, {
          branch: command.bootstrap?.prepareWorktree?.branch ?? null,
        });
        // The node answers a start it recorded as failed with an error; its word decides.
        if (taskStartFailed(task, command.commandId)) {
          const start = task.delegations.find(
            (delegation) => delegation.commandId === command.commandId,
          );
          throw new Error(start?.error ?? "The node didn’t start the chat.");
        }
      }),
  };
}
