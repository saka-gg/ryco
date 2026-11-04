/**
 * The import job's `follow-up` step: an agent thread in the new project that finishes its setup
 * (installs tools, runs special commands), started by the destination so it survives the client
 * closing.
 *
 * The thread runs with exactly the model, runtime mode and env mode the import was started with
 * (Agent Control's validator bounded them before approval). Its thread, message, command and
 * (for `worktree`) worktree ids derive from the importId, so a retried dispatch is answered by
 * its receipt. When the chosen provider instance is not ready on this node the step is skipped:
 * the import never fails for it.
 *
 * @module projectImportFollowUp
 */
import type {
  OrchestrationCommand,
  ServerSettings,
  ServerSettingsError,
  ThreadId,
} from "@ryco/contracts";
import type { ProjectImportFollowUpThread, ProjectImportId } from "@ryco/contracts/project-copy";
import { buildGeneratedWorktreeBranchName } from "@ryco/shared/git";
import { Cause, Effect, Option } from "effect";

import { isAgentControlProviderReady } from "../agentControl/Services/AgentControlActionValidator.ts";
import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import { resolveProjectPreferences } from "../project/projectPreferences.ts";
import type { ProviderRegistryShape } from "../provider/Services/ProviderRegistry.ts";
import {
  createManagedCheckout,
  type ManagedCheckoutDeps,
  type ManagedCheckoutProject,
} from "../ws/context/managedCheckout.ts";
import {
  boundImportText,
  projectImportCommandId,
  projectImportFollowUpPrompt,
  projectImportMessageId,
  projectImportThreadId,
  projectImportWorktreeId,
  type ProjectImportSetupFailure,
} from "./projectImportSnapshot.ts";

export interface ProjectImportFollowUpDeps {
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<unknown, OrchestrationDispatchError>;
  /** Absent: no provider can be checked, so the step is skipped. */
  readonly providers: Option.Option<Pick<ProviderRegistryShape, "getProviders">>;
  /** Absent: a `worktree` thread cannot be prepared, so the step is skipped. */
  readonly worktrees: Option.Option<{
    readonly managedCheckout: ManagedCheckoutDeps;
    readonly settings: Effect.Effect<ServerSettings, ServerSettingsError>;
  }>;
}

export interface ProjectImportFollowUpInput {
  readonly importId: ProjectImportId;
  /** The registered project, rooted at the import's project root. */
  readonly project: ManagedCheckoutProject;
  readonly followUp: ProjectImportFollowUpThread;
  /** The setup command's result when it failed; the thread's first message reports it. */
  readonly setupFailure: ProjectImportSetupFailure | null;
}

export type ProjectImportFollowUpResult =
  | { readonly status: "started"; readonly threadId: ThreadId }
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

const describe = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.squash(cause);
  return failure instanceof Error && failure.message.trim().length > 0
    ? failure.message
    : "The thread could not be started.";
};

/** Starts the follow-up thread; never fails (a failure is a result the job warns about). */
export const startProjectImportFollowUp = (
  deps: ProjectImportFollowUpDeps,
  input: ProjectImportFollowUpInput,
): Effect.Effect<ProjectImportFollowUpResult> =>
  Effect.gen(function* () {
    const { followUp, importId, project } = input;
    const selection = followUp.modelSelection;
    if (Option.isNone(deps.providers)) {
      return { status: "skipped", reason: "No agent provider is available on this node." } as const;
    }
    const providers = yield* deps.providers.value.getProviders;
    const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
    if (provider === undefined || !isAgentControlProviderReady(provider)) {
      return {
        status: "skipped",
        reason: `The agent provider '${selection.instanceId}' is not ready on this node.`,
      } as const;
    }
    if (!provider.models.some((model) => model.slug === selection.model)) {
      return {
        status: "skipped",
        reason: `The model '${selection.model}' is not available on '${selection.instanceId}' here.`,
      } as const;
    }

    const threadId = projectImportThreadId(importId);
    const createdAt = new Date().toISOString();
    let checkout: { readonly branch: string; readonly worktreePath: string } | null = null;
    if (followUp.envMode === "worktree") {
      if (Option.isNone(deps.worktrees)) {
        return {
          status: "skipped",
          reason: "A new worktree for the setup thread cannot be prepared on this node.",
        } as const;
      }
      const worktrees = deps.worktrees.value;
      const settings = yield* worktrees.settings;
      const preferences = resolveProjectPreferences({
        settings,
        project: { id: project.id, defaultModelSelection: null },
      });
      const branch = buildGeneratedWorktreeBranchName(
        `setup-${importId.slice(0, 8)}`,
        preferences.worktreeBranchPrefix.value,
      );
      const created = yield* createManagedCheckout(worktrees.managedCheckout, {
        operation: "projects.importFollowUp",
        project,
        settings,
        initialName: followUp.title,
        branchName: branch,
        refName: "HEAD",
        newRefName: branch,
      });
      checkout = { branch, worktreePath: created.worktreePath };
      yield* deps.dispatch({
        type: "worktree.create",
        commandId: projectImportCommandId(importId, "follow-up-worktree"),
        worktreeId: projectImportWorktreeId(importId),
        projectId: project.id,
        branch,
        worktreePath: created.worktreePath,
        origin: "manual",
        prNumber: null,
        issueNumber: null,
        prTitle: null,
        issueTitle: null,
        createdAt,
      });
    }

    yield* deps.dispatch({
      type: "thread.create",
      commandId: projectImportCommandId(importId, "follow-up-thread"),
      threadId,
      projectId: project.id,
      title: followUp.title,
      modelSelection: selection,
      runtimeMode: followUp.runtimeMode,
      interactionMode: "default",
      branch: checkout?.branch ?? null,
      worktreePath: checkout?.worktreePath ?? null,
      createdAt,
    });
    if (checkout !== null) {
      yield* deps.dispatch({
        type: "thread.attach-to-worktree",
        commandId: projectImportCommandId(importId, "follow-up-attach"),
        threadId,
        worktreeId: projectImportWorktreeId(importId),
        attachedAt: createdAt,
      });
    }
    yield* deps.dispatch({
      type: "thread.turn.start",
      commandId: projectImportCommandId(importId, "follow-up-turn"),
      threadId,
      message: {
        messageId: projectImportMessageId(importId),
        role: "user",
        text: projectImportFollowUpPrompt(followUp.prompt, input.setupFailure),
        attachments: [],
      },
      modelSelection: selection,
      runtimeMode: followUp.runtimeMode,
      interactionMode: "default",
      createdAt,
    });
    return { status: "started", threadId } as const;
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.succeed({
            status: "failed",
            reason: boundImportText(describe(cause), "The thread could not be started."),
          } as const),
    ),
  );
