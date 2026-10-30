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
import { isTransportConnectionErrorMessage } from "@ryco/client-runtime/errors";
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
 * A step whose command threw. A lost connection may still have delivered it,
 * so that failure is uncertain and keeps the step's own text; a refusal the
 * node answered created nothing, and its reason is shown as it came.
 */
function refused(
  attempt: NewTaskAttempt,
  step: NewTaskFailureStep,
  error: unknown,
): NewTaskRunResult {
  const message = errorMessage(error);
  const uncertain = message === null || isTransportConnectionErrorMessage(message);
  return failed(attempt, step, uncertain, uncertain ? null : message);
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

export async function runNewTaskAttempt(
  attempt: NewTaskAttempt,
  deps: NewTaskControllerDeps,
): Promise<NewTaskRunResult> {
  let next = attempt;

  if (!next.projectReady) {
    try {
      if (!next.projectCommandAccepted) {
        const workspaceRoot = validateNodeWorkspacePath(next.project.workspaceRoot);
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
  if (next.worktree.kind === "new") {
    if (!next.turnStarted) {
      const branch = next.worktree.branch.trim();
      if (!branch) return failed(next, "worktree", false);
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
              projectCwd: validateNodeWorkspacePath(next.project.workspaceRoot),
              baseBranch: next.worktree.baseBranch,
              branch,
              fetchOrigin: next.worktree.fetchOrigin,
            },
          }),
        );
      } catch (error) {
        return refused(next, "worktree", error);
      }
      next = {
        ...next,
        threadCommandAccepted: true,
        threadReady: true,
        worktreeReady: true,
        worktreeAttached: true,
        turnStarted: true,
      };
    }
    return { ok: true, attempt: next };
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

  if (next.worktree.kind === "existing" && !next.worktreeAttached) {
    try {
      await deps.dispatch({
        type: "thread.attach-to-worktree",
        commandId: next.ids.attachCommandId,
        threadId: next.threadId,
        worktreeId: next.worktree.worktreeId,
        attachedAt: next.createdAt,
      });
      await deps.waitForThread({
        threadId: next.threadId,
        worktreeId: next.worktree.worktreeId,
      });
      next = { ...next, worktreeAttached: true };
    } catch {
      return failed(next, "thread", false);
    }
  }

  if (!next.turnStarted) {
    try {
      await deps.dispatch(turnStartCommand(next));
      next = { ...next, turnStarted: true };
    } catch {
      return failed(next, "turn", true);
    }
  }

  return { ok: true, attempt: next };
}
