import {
  groupWorkspaceLogicalProjects,
  resolveWorkspaceExecutionTarget,
  type WorkspaceExecutionTargetResolution,
  type WorkspacePhysicalProjectVariant,
} from "@ryco/client-runtime/state/workspace";
import type { Project, SidebarThreadSummary } from "@ryco/client-runtime/state/threads";
import {
  DEFAULT_MODEL,
  ProviderInstanceId,
  type AgentTokenMode,
  type ClientOrchestrationCommand,
  type CommandId,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type WorktreeId,
} from "@ryco/contracts";

import { inferNodeProjectTitle, validateNodeWorkspacePath } from "../projects/projectActions";
import type { ProjectEnvironment } from "../projects/projectsModel";
import { inferTaskTitle } from "./newTaskModel";

function projectLastUsedAt(
  project: Project,
  threads: ReadonlyArray<SidebarThreadSummary>,
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
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
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
  | { readonly kind: "new"; readonly branch: string; readonly baseBranch?: string };

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
  readonly attachments: TurnStartCommand["message"]["attachments"];
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
  readonly createWorktree: (input: {
    readonly projectId: ProjectId;
    readonly branch: string;
    readonly baseBranch?: string;
  }) => Promise<{
    readonly worktreeId: WorktreeId;
    readonly threadId: ThreadId;
  }>;
  readonly waitForProject: (projectId: ProjectId) => Promise<void>;
  readonly waitForWorktree: (worktreeId: WorktreeId) => Promise<void>;
  readonly waitForThread: (input: {
    readonly threadId: ThreadId;
    readonly worktreeId?: WorktreeId | null;
  }) => Promise<void>;
}

export function createNewTaskAttempt(input: {
  readonly environmentId: EnvironmentId;
  readonly prompt: string;
  readonly attachments?: TurnStartCommand["message"]["attachments"];
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
    tokenMode: input.tokenMode ?? "balanced",
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
): NewTaskRunResult {
  return {
    ok: false,
    attempt,
    step,
    message: failureMessage(step),
    deliveryUncertain,
  };
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
    } catch {
      return failed(next, "project", !next.projectCommandAccepted);
    }
  }

  if (next.worktree.kind === "new" && !next.worktreeReady) {
    try {
      let worktreeId = next.worktreeId;
      let threadId = next.threadId;
      if (!worktreeId) {
        const branch = next.worktree.branch.trim();
        if (!branch) throw new Error("branch-required");
        const created = await deps.createWorktree({
          projectId: next.projectId,
          branch,
          ...(next.worktree.baseBranch?.trim()
            ? { baseBranch: next.worktree.baseBranch.trim() }
            : {}),
        });
        worktreeId = created.worktreeId;
        threadId = created.threadId;
        next = { ...next, worktreeId, threadId };
      }
      await deps.waitForWorktree(worktreeId);
      await deps.waitForThread({ threadId, worktreeId });
      next = {
        ...next,
        worktreeReady: true,
        threadReady: true,
        threadCommandAccepted: true,
        worktreeAttached: true,
      };
    } catch {
      return failed(next, "worktree", next.worktreeId === null);
    }
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
    } catch {
      return failed(next, "thread", !next.threadCommandAccepted);
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
      await deps.dispatch({
        type: "thread.turn.start",
        commandId: next.ids.turnCommandId,
        threadId: next.threadId,
        message: {
          messageId: next.ids.messageId,
          role: "user",
          text: next.prompt.trim(),
          attachments: next.attachments,
        },
        modelSelection: next.modelSelection,
        titleSeed: inferTaskTitle(next.prompt),
        runtimeMode: next.runtimeMode,
        interactionMode: next.interactionMode,
        tokenMode: next.tokenMode,
        sourceControlContexts: [],
        createdAt: next.createdAt,
      });
      next = { ...next, turnStarted: true };
    } catch {
      return failed(next, "turn", true);
    }
  }

  return { ok: true, attempt: next };
}
