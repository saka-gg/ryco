import {
  groupWorkspaceLogicalProjects,
  resolveWorkspaceExecutionTarget,
  type WorkspaceExecutionTargetResolution,
  type WorkspacePhysicalProjectVariant,
} from "@ryco/client-runtime/state/workspace";
import {
  buildTurnStartCommand,
  composeOutgoingPrompt,
  type SendTurnBootstrap,
} from "@ryco/client-runtime/state/composer";
import { isDefiniteDispatchFailure } from "@ryco/client-runtime/rpc";
import type { Project, SidebarThreadOrStub } from "@ryco/client-runtime/state/threads";
import type {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  WorktreeId,
} from "@ryco/contracts";
import { DEFAULT_MODEL } from "@ryco/contracts/model";
import {
  DEFAULT_AGENT_TOKEN_MODE,
  type AgentTokenMode,
  type ClientOrchestrationCommand,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type UploadChatImageAttachment,
} from "@ryco/contracts/orchestration";
import { ProviderInstanceId } from "@ryco/contracts/provider-instance";

import { inferNodeProjectTitle, validateNodeWorkspacePath } from "../projects/projectActions";
import type { ProjectEnvironment } from "../projects/projectsModel";
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
    };

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
  readonly attachments: ReadonlyArray<UploadChatImageAttachment>;
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
  readonly turnStarted: boolean;
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
  /**
   * Whether the node shows this thread with its first turn under way. A turn
   * start that prepares a worktree is not answered from a command receipt:
   * sent again after it went through, the node would set the worktree up a
   * second time. Its thread alone is no proof (the node creates it before the
   * turn and deletes it when the turn start fails); a started turn is.
   */
  readonly threadStarted?: (threadId: ThreadId) => boolean;
  readonly waitForProject: (projectId: ProjectId) => Promise<void>;
  readonly waitForThread: (input: {
    readonly threadId: ThreadId;
    readonly worktreeId?: WorktreeId | null;
  }) => Promise<void>;
}

export function createNewTaskAttempt(input: {
  readonly environmentId: EnvironmentId;
  readonly prompt: string;
  readonly attachments?: ReadonlyArray<UploadChatImageAttachment>;
  readonly project: NewTaskProjectContext;
  readonly worktree: NewTaskWorktreeContext;
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly tokenMode?: AgentTokenMode;
  readonly createdAt: string;
  readonly ids: NewTaskStableIds;
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

export async function runNewTaskAttempt(
  attempt: NewTaskAttempt,
  deps: NewTaskControllerDeps,
): Promise<NewTaskRunResult> {
  let next = attempt;

  if (!next.projectReady) {
    let workspaceRoot: string;
    try {
      workspaceRoot = validateNodeWorkspacePath(next.project.workspaceRoot);
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
        projectCwd = validateNodeWorkspacePath(next.project.workspaceRoot);
      } catch (error) {
        return invalid(next, "worktree", error);
      }
      try {
        await deps.dispatch(
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

  if (!next.turnStarted) {
    try {
      await deps.dispatch(turnStartCommand(next));
      next = { ...next, turnStarted: true };
    } catch (error) {
      return refused(next, "turn", error);
    }
  }

  return { ok: true, attempt: next };
}
