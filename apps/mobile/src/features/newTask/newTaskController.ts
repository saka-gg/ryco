import {
  groupWorkspaceLogicalProjects,
  resolveWorkspaceExecutionTarget,
  type WorkspaceExecutionTargetResolution,
  type WorkspacePhysicalProjectVariant,
} from "@ryco/client-runtime/state/workspace";
import {
  buildSendTurnBootstrap,
  buildTurnStartCommand,
  composeOutgoingPrompt,
  isChatProjectRetiredError,
  persistThreadSettingsForNextTurn,
  resolveChatProjectTitleSeed,
  type SendTurnBootstrap,
  type SendTurnDispatchAttachment,
} from "@ryco/client-runtime/state/composer";
import { isDefiniteDispatchFailure } from "@ryco/client-runtime/rpc";
import type { Project, SidebarThreadOrStub } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, MessageId, ProjectId, ThreadId, WorktreeId } from "@ryco/contracts";
import { CommandId } from "@ryco/contracts/base-schemas";
import { DEFAULT_MODEL } from "@ryco/contracts/model";
import {
  DEFAULT_AGENT_TOKEN_MODE,
  type AgentTokenMode,
  type ClientOrchestrationCommand,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@ryco/contracts/orchestration";
import { ProviderInstanceId } from "@ryco/contracts/provider-instance";

import { inferNodeProjectTitle, validateNodeWorkspacePath } from "../projects/projectActions";
import type { ProjectEnvironment } from "../projects/projectsModel";
import { isTaskChatStartError, TaskChatStartError } from "../tasks/taskChatStartError";
import { inferTaskTitle } from "./newTaskModel";

function projectLastUsedAt(
  project: Project,
  threads: ReadonlyArray<SidebarThreadOrStub>,
): number | null {
  const values = threads
    .filter(
      (thread) => thread.environmentId === project.environmentId && thread.projectId === project.id,
    )
    .map((thread) => Date.parse(thread.updatedAt ?? thread.createdAt))
    .filter(Number.isFinite);
  return values.length === 0 ? null : Math.max(...values);
}

/** Build the shared resolver input from Mobile's already trust-gated roster. */
export function resolveMobileNewTaskTarget(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projects: ReadonlyArray<Project>;
  readonly environments: ReadonlyArray<ProjectEnvironment>;
  /** Any thread, archived stubs included: only its project and times are read. */
  readonly threads: ReadonlyArray<SidebarThreadOrStub>;
  readonly overrideEnvironmentId?: EnvironmentId | null;
}): WorkspaceExecutionTargetResolution {
  const environments = new Map(
    input.environments.map((environment) => [environment.environmentId, environment] as const),
  );
  const variants: WorkspacePhysicalProjectVariant[] = input.projects.map((project) => {
    const environment = environments.get(project.environmentId);
    const connected = environment?.connectionState === "connected";
    return {
      environmentId: project.environmentId,
      projectId: project.id,
      physicalKey: `${project.environmentId}:${project.cwd}`,
      name: project.name,
      cwd: project.cwd,
      repositoryIdentity: project.repositoryIdentity ?? null,
      machineLabel: environment?.label ?? "Unknown machine",
      online: connected,
      canMutate: connected,
      nativeTrust:
        environment?.trust === "verified"
          ? "verified"
          : environment?.trust === "account-trusted"
            ? "account-trusted"
            : "not-required",
      effectiveRole:
        environment?.role === "owner" ||
        environment?.role === "operator" ||
        environment?.role === "viewer"
          ? environment.role
          : null,
      lastUsedAt: projectLastUsedAt(project, input.threads),
      lastLiveAt: null,
      localDesktop: false,
    };
  });
  const logical = groupWorkspaceLogicalProjects(variants).find((candidate) =>
    candidate.variants.some(
      (variant) =>
        variant.environmentId === input.environmentId && variant.projectId === input.projectId,
    ),
  );
  if (!logical) {
    return {
      status: "unavailable",
      message: "No verified machine available",
      reason: "no-eligible-variant",
    };
  }
  const overrideEnvironmentId = input.overrideEnvironmentId;
  const overrideVariant =
    overrideEnvironmentId === null || overrideEnvironmentId === undefined
      ? null
      : logical.variants.find((variant) => variant.environmentId === overrideEnvironmentId);
  return resolveWorkspaceExecutionTarget({
    project: logical,
    override:
      overrideVariant === null || overrideVariant === undefined
        ? null
        : {
            environmentId: overrideVariant.environmentId,
            projectId: overrideVariant.projectId,
          },
  });
}

/** Retarget only physical context; all authored/model fields remain byte-for-byte intact. */
export function retargetNewTaskDraft<
  T extends {
    readonly prompt: string;
    readonly attachments: readonly unknown[];
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
    readonly tokenMode: AgentTokenMode;
  },
>(
  draft: T,
  environmentId: EnvironmentId,
  projectId: ProjectId,
): T & {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
} {
  return { ...draft, environmentId, projectId };
}

type CommandOf<Type extends ClientOrchestrationCommand["type"]> = Extract<
  ClientOrchestrationCommand,
  { readonly type: Type }
>;
type TurnStartCommand = CommandOf<"thread.turn.start">;

export type NewTaskProjectContext =
  | {
      readonly kind: "existing";
      readonly projectId: ProjectId;
      readonly workspaceRoot: string;
    }
  | {
      readonly kind: "new";
      readonly workspaceRoot: string;
      readonly title?: string;
    }
  /**
   * A chat without a project: the node creates its folder (a "chat project") in the first
   * turn start, together with the thread, as web's first chat send does. It never uses a
   * worktree or a branch.
   */
  | { readonly kind: "chat" };

export type NewTaskWorktreeContext =
  | { readonly kind: "local" }
  | {
      readonly kind: "existing";
      readonly worktreeId: WorktreeId;
      readonly branch: string;
      readonly worktreePath: string | null;
    }
  | {
      readonly kind: "new";
      readonly branch: string;
      /** The ref the worktree branches from, as sent (`newWorktreeBaseBranch`). */
      readonly baseBranch: string;
      readonly fetchOrigin: boolean;
    };

export interface NewTaskStableIds {
  readonly projectId: ProjectId;
  readonly projectCommandId: CommandId;
  readonly threadId: ThreadId;
  readonly threadCommandId: CommandId;
  readonly attachCommandId: CommandId;
  readonly turnCommandId: CommandId;
  readonly messageId: MessageId;
}

export interface NewTaskAttempt {
  readonly environmentId: EnvironmentId;
  readonly prompt: string;
  /** Photos inline, files by the token of their upload for this task's thread. */
  readonly attachments: ReadonlyArray<SendTurnDispatchAttachment>;
  readonly project: NewTaskProjectContext;
  readonly worktree: NewTaskWorktreeContext;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly tokenMode: AgentTokenMode;
  readonly createdAt: string;
  readonly ids: NewTaskStableIds;
  readonly projectId: ProjectId;
  readonly projectCommandAccepted: boolean;
  readonly projectReady: boolean;
  readonly worktreeId: WorktreeId | null;
  readonly worktreeReady: boolean;
  readonly threadId: ThreadId;
  readonly threadCommandAccepted: boolean;
  readonly threadReady: boolean;
  readonly worktreeAttached: boolean;
  /** The attach command was answered; only its confirmation may still be missing. */
  readonly attachCommandAccepted?: boolean;
  /**
   * The node created the thread in its own defaults (a task started from a pull request, issue
   * or Jira item: `git.createWorktreeForProject`), and the turn runs in the thread's modes, so
   * the chosen runtime, interaction and token modes are written to it before the first turn.
   */
  readonly threadSettingsPending?: boolean;
  readonly turnStarted: boolean;
  /**
   * The task (the user's to-do list) this chat is started for: its first turn
   * goes out as the task's (`delegate`), so the machine records the chat under
   * the task and hands it the task's files. Absent for a plain chat.
   */
  readonly localTaskId?: string;
}

export type NewTaskFailureStep = "project" | "worktree" | "thread" | "turn";

export type NewTaskRunResult =
  | { readonly ok: true; readonly attempt: NewTaskAttempt }
  | {
      readonly ok: false;
      readonly attempt: NewTaskAttempt;
      readonly step: NewTaskFailureStep;
      readonly message: string;
      readonly deliveryUncertain: boolean;
    };

export interface NewTaskControllerDeps {
  readonly dispatch: (command: ClientOrchestrationCommand) => Promise<unknown>;
  /** Sends a task chat's first turn as the task's (`server.delegateLocalTask`). */
  readonly delegate?: (taskId: string, command: TurnStartCommand) => Promise<unknown>;
  /**
   * Checks a task can still take a chat (not deleted, not done), sending
   * nothing, before the project, thread or worktree are created for it.
   */
  readonly preflightTask?: (taskId: string) => Promise<void>;
  /**
   * Whether the node shows this thread with its first turn under way. A turn
   * start that prepares a worktree is not answered from a command receipt:
   * sent again after it went through, the node would set the worktree up a
   * second time. Its thread alone is no proof (the node creates it before the
   * turn and deletes it when the turn start fails); a started turn is.
   */
  readonly threadStarted?: (threadId: ThreadId) => boolean;
  readonly waitForProject: (projectId: ProjectId) => Promise<void>;
  /**
   * Fresh ids for a chat whose draft project id the node retired (`chat-project-retired`):
   * nothing was created under it and it can never be used again, and the refused turn start's
   * command id would only be refused again from its receipt.
   */
  readonly freshChatIds?: () => {
    readonly projectId: ProjectId;
    readonly turnCommandId: CommandId;
  };
  readonly waitForThread: (input: {
    readonly threadId: ThreadId;
    readonly worktreeId?: WorktreeId | null;
  }) => Promise<void>;
}

export function createNewTaskAttempt(input: {
  readonly environmentId: EnvironmentId;
  readonly prompt: string;
  readonly attachments?: ReadonlyArray<SendTurnDispatchAttachment>;
  readonly project: NewTaskProjectContext;
  readonly worktree: NewTaskWorktreeContext;
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly tokenMode?: AgentTokenMode;
  readonly createdAt: string;
  readonly ids: NewTaskStableIds;
  readonly localTaskId?: string | null;
}): NewTaskAttempt {
  const existingProject = input.project.kind === "existing";
  const existingWorktree = input.worktree.kind === "existing";
  return {
    environmentId: input.environmentId,
    prompt: input.prompt,
    attachments: input.attachments ?? [],
    project: input.project,
    worktree: input.worktree,
    modelSelection: input.modelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: DEFAULT_MODEL,
    },
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: input.interactionMode ?? "default",
    tokenMode: input.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
    createdAt: input.createdAt,
    ids: input.ids,
    projectId: existingProject ? input.project.projectId : input.ids.projectId,
    projectCommandAccepted: existingProject,
    projectReady: existingProject,
    worktreeId: existingWorktree ? input.worktree.worktreeId : null,
    worktreeReady: input.worktree.kind !== "new",
    threadId: input.ids.threadId,
    threadCommandAccepted: false,
    threadReady: false,
    worktreeAttached: !existingWorktree,
    turnStarted: false,
    ...(input.localTaskId ? { localTaskId: input.localTaskId } : {}),
  };
}

function failureMessage(step: NewTaskFailureStep): string {
  if (step === "project") {
    return "The project is not ready yet. Check the node connection, then retry this step.";
  }
  if (step === "worktree") {
    return "The worktree is not ready yet. Check the project before retrying this step.";
  }
  if (step === "thread") {
    return "The task could not be confirmed. The project and worktree remain available.";
  }
  return "Turn delivery could not be confirmed. Your draft is still here; check the task before retrying.";
}

function failed(
  attempt: NewTaskAttempt,
  step: NewTaskFailureStep,
  deliveryUncertain: boolean,
  /** The node's own refusal, shown instead of the step's generic text. */
  detail?: string | null,
): NewTaskRunResult {
  return {
    ok: false,
    attempt,
    step,
    message: detail ? detail : failureMessage(step),
    deliveryUncertain,
  };
}

function errorMessage(error: unknown): string | null {
  return error instanceof Error && error.message.trim().length > 0 ? error.message.trim() : null;
}

/**
 * A step whose command threw. Only a definite answer (`isDefiniteDispatchFailure`:
 * this client refused to send it, or the node answered with its typed error)
 * created nothing, and its reason is shown as it came. Anything else (a lost
 * connection, an interrupted call, a relay that could not confirm delivery)
 * may have reached the node: that failure is uncertain and keeps the step's
 * own cautious text.
 */
function refused(
  attempt: NewTaskAttempt,
  step: NewTaskFailureStep,
  error: unknown,
): NewTaskRunResult {
  // A task chat's start says itself whether it went out; the machine's reason is shown either way.
  if (isTaskChatStartError(error)) return failed(attempt, step, error.sent, errorMessage(error));
  if (!isDefiniteDispatchFailure(error)) return failed(attempt, step, true);
  return failed(attempt, step, false, errorMessage(error));
}

/** A check this client makes before sending anything: its failure is certain. */
function invalid(attempt: NewTaskAttempt, step: NewTaskFailureStep, error: unknown) {
  return failed(attempt, step, false, errorMessage(error));
}

/** The turn start every New Task sends, through the shared command builder. */
function turnStartCommand(
  attempt: NewTaskAttempt,
  bootstrap?: NonNullable<SendTurnBootstrap>,
): TurnStartCommand {
  const command = buildTurnStartCommand({
    commandId: attempt.ids.turnCommandId,
    threadId: attempt.threadId,
    messageId: attempt.ids.messageId,
    // The shared composition: a pasted quote token goes out expanded.
    text: composeOutgoingPrompt({ prompt: attempt.prompt }),
    attachments: attempt.attachments,
    modelSelection: attempt.modelSelection,
    titleSeed: inferTaskTitle(attempt.prompt),
    runtimeMode: attempt.runtimeMode,
    interactionMode: attempt.interactionMode,
    tokenMode: attempt.tokenMode,
    ...(bootstrap ? { bootstrap } : {}),
    createdAt: attempt.createdAt,
  });
  return command as TurnStartCommand;
}

/** The turn start goes out as the task's when the attempt is for a task, else as a plain command. */
function sendTurnStart(
  attempt: NewTaskAttempt,
  command: TurnStartCommand,
  deps: NewTaskControllerDeps,
): Promise<unknown> {
  if (attempt.localTaskId === undefined) return deps.dispatch(command);
  if (!deps.delegate)
    return Promise.reject(
      new TaskChatStartError("This chat can’t be started for its task here.", false),
    );
  return deps.delegate(attempt.localTaskId, command);
}

/**
 * The attempt to run again after a failure. The node keeps a receipt for every
 * command id: an accepted one answers as accepted again, a refused one is
 * refused again. So a step the node refused gets a fresh command id, while a
 * step that may have been delivered (a lost connection) keeps its own, and the
 * node answers it from its receipt instead of running it twice.
 */
export function prepareNewTaskRetry(
  attempt: NewTaskAttempt,
  failure: { readonly step: NewTaskFailureStep; readonly deliveryUncertain: boolean },
  newCommandId: () => CommandId,
): NewTaskAttempt {
  if (failure.deliveryUncertain) return attempt;
  const ids = attempt.ids;
  switch (failure.step) {
    case "project":
      return attempt.projectCommandAccepted
        ? attempt
        : { ...attempt, ids: { ...ids, projectCommandId: newCommandId() } };
    case "worktree":
      return attempt.turnStarted
        ? attempt
        : { ...attempt, ids: { ...ids, turnCommandId: newCommandId() } };
    case "thread":
      if (!attempt.threadCommandAccepted) {
        return { ...attempt, ids: { ...ids, threadCommandId: newCommandId() } };
      }
      // The thread is there; a refused attach to its worktree goes again.
      return attempt.worktree.kind === "existing" &&
        !attempt.worktreeAttached &&
        attempt.attachCommandAccepted !== true
        ? { ...attempt, ids: { ...ids, attachCommandId: newCommandId() } }
        : attempt;
    case "turn":
      return attempt.turnStarted
        ? attempt
        : { ...attempt, ids: { ...ids, turnCommandId: newCommandId() } };
  }
}

/** Where an existing or new project lives; a chat has no folder of its own until the node makes it. */
function projectWorkspaceRoot(project: NewTaskProjectContext): string {
  if (project.kind === "chat") throw new Error("A chat without a project has no workspace path.");
  return project.workspaceRoot;
}

/** The attempt's turn start creating its chat project and thread (`buildSendTurnBootstrap`). */
function chatTurnBootstrap(attempt: NewTaskAttempt): NonNullable<SendTurnBootstrap> {
  const bootstrap = buildSendTurnBootstrap({
    isLocalDraftThread: true,
    baseBranchForWorktree: null,
    shouldMaterializeLegacyBranchWorktree: false,
    projectId: attempt.projectId,
    projectCwd: "",
    title: inferTaskTitle(attempt.prompt),
    threadCreateModelSelection: attempt.modelSelection,
    runtimeMode: attempt.runtimeMode,
    interactionMode: attempt.interactionMode,
    tokenMode: attempt.tokenMode,
    activeThreadBranch: null,
    worktreePath: null,
    threadCreatedAt: attempt.createdAt,
    createChatProject: {
      projectId: attempt.projectId,
      // The chat's name (and folder name) seed; an attachment-only first message has none.
      titleSeed: resolveChatProjectTitleSeed(attempt.prompt) ?? inferTaskTitle(attempt.prompt),
    },
  });
  if (!bootstrap) throw new Error("The chat could not be prepared.");
  return bootstrap;
}

/**
 * A chat without a project: one turn start creates its folder, its thread and its first turn,
 * so there is no project or thread step to confirm on the way. A retired draft id (the node
 * cleaned it up) created nothing: the chat goes again once under a fresh id.
 */
async function runChatAttempt(
  attempt: NewTaskAttempt,
  deps: NewTaskControllerDeps,
): Promise<NewTaskRunResult> {
  let next = attempt;
  if (!next.turnStarted && deps.threadStarted?.(next.threadId) === true) {
    next = { ...next, turnStarted: true };
  }
  if (!next.turnStarted) {
    if (next.worktree.kind !== "local") {
      return invalid(next, "turn", new Error("A chat without a project cannot use a worktree."));
    }
    for (let retiredRetry = 0; ; retiredRetry += 1) {
      try {
        await sendTurnStart(next, turnStartCommand(next, chatTurnBootstrap(next)), deps);
        break;
      } catch (error) {
        if (retiredRetry === 0 && deps.freshChatIds && isChatProjectRetiredError(error)) {
          const fresh = deps.freshChatIds();
          next = {
            ...next,
            projectId: fresh.projectId,
            ids: { ...next.ids, projectId: fresh.projectId, turnCommandId: fresh.turnCommandId },
          };
          continue;
        }
        return refused(next, "turn", error);
      }
    }
    next = { ...next, turnStarted: true };
  }
  return {
    ok: true,
    attempt: {
      ...next,
      projectCommandAccepted: true,
      projectReady: true,
      threadCommandAccepted: true,
      threadReady: true,
      worktreeAttached: true,
    },
  };
}

export async function runNewTaskAttempt(
  attempt: NewTaskAttempt,
  deps: NewTaskControllerDeps,
): Promise<NewTaskRunResult> {
  let next = attempt;

  // A task's chat checks its task before anything is created for it. Once its
  // turn went out (a retry after a lost reply) the node's receipt decides instead.
  if (next.localTaskId !== undefined && !next.turnStarted && deps.preflightTask) {
    try {
      await deps.preflightTask(next.localTaskId);
    } catch (error) {
      return invalid(next, next.projectReady ? "turn" : "project", error);
    }
  }

  if (next.project.kind === "chat") return runChatAttempt(next, deps);

  if (!next.projectReady) {
    let workspaceRoot: string;
    try {
      workspaceRoot = validateNodeWorkspacePath(projectWorkspaceRoot(next.project));
    } catch (error) {
      return invalid(next, "project", error);
    }
    try {
      if (!next.projectCommandAccepted) {
        await deps.dispatch({
          type: "project.create",
          commandId: next.ids.projectCommandId,
          projectId: next.projectId,
          title:
            next.project.kind === "new" && next.project.title?.trim()
              ? next.project.title.trim()
              : inferNodeProjectTitle(workspaceRoot),
          workspaceRoot,
          projectMetadataDir: ".ryco",
          createWorkspaceRootIfMissing: true,
          createdAt: next.createdAt,
        });
        next = { ...next, projectCommandAccepted: true };
      }
      await deps.waitForProject(next.projectId);
      next = { ...next, projectReady: true };
    } catch (error) {
      // Once the command was accepted only the confirmation is missing.
      if (next.projectCommandAccepted) return failed(next, "project", false);
      return refused(next, "project", error);
    }
  }

  // A new worktree is prepared by the node inside the turn start, like web's
  // first send: the thread id is this attempt's own, so the thread screen can
  // open at once and follow the node's setup feed for it.
  const worktree = next.worktree;
  if (worktree.kind === "new") {
    if (!next.turnStarted && deps.threadStarted?.(next.threadId) === true) {
      next = { ...next, turnStarted: true };
    }
    if (!next.turnStarted) {
      const branch = worktree.branch.trim();
      if (!branch) return failed(next, "worktree", false);
      let projectCwd: string;
      try {
        projectCwd = validateNodeWorkspacePath(projectWorkspaceRoot(next.project));
      } catch (error) {
        return invalid(next, "worktree", error);
      }
      try {
        await sendTurnStart(
          next,
          turnStartCommand(next, {
            createThread: {
              projectId: next.projectId,
              title: inferTaskTitle(next.prompt),
              modelSelection: next.modelSelection,
              runtimeMode: next.runtimeMode,
              interactionMode: next.interactionMode,
              tokenMode: next.tokenMode,
              branch: null,
              worktreePath: null,
              createdAt: next.createdAt,
            },
            prepareWorktree: {
              projectCwd,
              baseBranch: worktree.baseBranch,
              branch,
              fetchOrigin: worktree.fetchOrigin,
            },
          }),
          deps,
        );
      } catch (error) {
        return refused(next, "worktree", error);
      }
      next = { ...next, turnStarted: true };
    }
    return {
      ok: true,
      attempt: {
        ...next,
        threadCommandAccepted: true,
        threadReady: true,
        worktreeReady: true,
        worktreeAttached: true,
      },
    };
  }

  if (!next.threadReady) {
    try {
      if (!next.threadCommandAccepted) {
        const branch = next.worktree.kind === "existing" ? next.worktree.branch : null;
        const worktreePath = next.worktree.kind === "existing" ? next.worktree.worktreePath : null;
        await deps.dispatch({
          type: "thread.create",
          commandId: next.ids.threadCommandId,
          threadId: next.threadId,
          projectId: next.projectId,
          title: inferTaskTitle(next.prompt),
          modelSelection: next.modelSelection,
          runtimeMode: next.runtimeMode,
          interactionMode: next.interactionMode,
          tokenMode: next.tokenMode,
          branch,
          worktreePath,
          createdAt: next.createdAt,
        });
        next = { ...next, threadCommandAccepted: true };
      }
      await deps.waitForThread({ threadId: next.threadId, worktreeId: null });
      next = { ...next, threadReady: true };
    } catch (error) {
      if (next.threadCommandAccepted) return failed(next, "thread", false);
      return refused(next, "thread", error);
    }
  }

  const attachTo = next.worktree;
  if (attachTo.kind === "existing" && !next.worktreeAttached) {
    try {
      if (next.attachCommandAccepted !== true) {
        await deps.dispatch({
          type: "thread.attach-to-worktree",
          commandId: next.ids.attachCommandId,
          threadId: next.threadId,
          worktreeId: attachTo.worktreeId,
          attachedAt: next.createdAt,
        });
        next = { ...next, attachCommandAccepted: true };
      }
      await deps.waitForThread({ threadId: next.threadId, worktreeId: attachTo.worktreeId });
      next = { ...next, worktreeAttached: true };
    } catch (error) {
      if (next.attachCommandAccepted === true) return failed(next, "thread", false);
      return refused(next, "thread", error);
    }
  }

  if (!next.turnStarted && next.threadSettingsPending === true) {
    const turnCommandId = next.ids.turnCommandId;
    try {
      await persistThreadSettingsForNextTurn(
        deps.dispatch,
        null,
        {
          threadId: next.threadId,
          createdAt: next.createdAt,
          runtimeMode: next.runtimeMode,
          interactionMode: next.interactionMode,
          tokenMode: next.tokenMode,
        },
        // Stable per attempt: a retry is answered from the command's receipt.
        (kind) => CommandId.make(`${turnCommandId}:${kind}`),
      );
      next = { ...next, threadSettingsPending: false };
    } catch (error) {
      return refused(next, "turn", error);
    }
  }

  if (!next.turnStarted) {
    try {
      await sendTurnStart(next, turnStartCommand(next), deps);
      next = { ...next, turnStarted: true };
    } catch (error) {
      return refused(next, "turn", error);
    }
  }

  return { ok: true, attempt: next };
}
