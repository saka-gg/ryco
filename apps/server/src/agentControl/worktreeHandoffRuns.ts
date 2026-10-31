/**
 * An agent's move of its own chat out of the shared checkout into a new worktree on a new branch
 * (`ryco_worktree_handoff`, T3 Code's `t3_worktree_handoff`), as one durable Agent Control step.
 *
 * The worktree is made the way a delegated worktree is (`planWorktreeCheckout` and
 * `createOwnedWorktree` of the executor: path policy, setup ownership, `.worktreeinclude`, the
 * operation's ownership record), then the chat is re-pointed at it, its continuation prompt is
 * queued as the agent's follow-up, and the project's setup script starts. Order with the turn:
 * the turn that asked keeps running in its session's old directory (its tool call answers, its
 * end-of-turn checkpoint stays there); the follow-up queue sends the continuation only once the
 * chat is idle, and that next turn starts in the worktree (a resume, or the cwd-relocation
 * context handoff where the provider keeps conversations per directory).
 *
 * Ownership: until the chat is re-pointed the worktree is the operation's, so a failure (the chat
 * archived or moved meanwhile) removes it. Just before the move the operation gives it up, so no
 * rollback or restart ever removes a checkout the chat may already work in. Changes in the shared
 * checkout are never carried over.
 *
 * Loaded by the executor on the first handoff; it imports no boot values (the executor passes its
 * own in), so the server's boot path carries none of it.
 *
 * @module agentControl/worktreeHandoffRuns
 */
import {
  DEFAULT_SERVER_SETTINGS,
  type AgentControlOperation,
  type AgentControlOperationId,
  type AgentControlOperationState,
  type AgentControlWorktreeHandoffOutcome,
  type AgentControlWorktreeHandoffPlan,
  type ClientOrchestrationCommand,
  type CommandId,
  type MessageId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ServerSettings,
  type ThreadId,
  type ThreadQueueAddCommand,
  type WorktreeId,
} from "@ryco/contracts";
import path from "node:path";

import { Cause, Effect, Option } from "effect";

import type { ProjectSetupScriptRunnerResult } from "../project/Services/ProjectSetupScriptRunner.ts";
import type { resolveProjectPreferences } from "../project/projectPreferences.ts";
import { isAdoptableBranchName } from "../orchestration/threadGitMetadata.ts";

/** The step that records the chat's move; executor recovery reads it (as a literal). */
export const HANDOFF_MOVED_STEP = "handoff-thread-moved";

/** The commands a handoff applies; the continuation goes as `{ queued }` (the agent's entry). */
export type WorktreeHandoffCommand = Extract<
  ClientOrchestrationCommand,
  { type: "thread.meta.update" | "thread.attach-to-worktree" }
>;

export interface WorktreeHandoffRunDeps {
  /** The node's settings service, when it has one (its defaults otherwise). */
  readonly settings: Option.Option<{ readonly getSettings: Effect.Effect<ServerSettings, Error> }>;
  readonly projects: Effect.Effect<ReadonlyArray<OrchestrationProjectShell>, Error>;
  readonly loadThread: (threadId: ThreadId) => Effect.Effect<OrchestrationThreadShell, Error>;
  readonly git: {
    readonly localStatus: (input: {
      readonly cwd: string;
    }) => Effect.Effect<{ readonly isRepo: boolean; readonly refName: string | null }, Error>;
    readonly listLocalBranchNames: (cwd: string) => Effect.Effect<ReadonlyArray<string>, Error>;
  };
  /** The executor's deterministic ids of an operation's steps. */
  readonly ids: {
    readonly commandIdFor: (operationId: AgentControlOperationId, step: string) => CommandId;
    readonly messageIdFor: (operationId: AgentControlOperationId, step: string) => MessageId;
    readonly worktreeIdFor: (operationId: AgentControlOperationId, index: number) => WorktreeId;
  };
  /** The operation as last checkpointed. */
  readonly operation: () => Pick<AgentControlOperation, "operationId" | "state">;
  readonly checkpoint: (state: AgentControlOperationState) => Effect.Effect<unknown, Error>;
  /** Applies the command and records `step` as completed. */
  readonly dispatch: (
    step: string,
    request: WorktreeHandoffCommand | { readonly queued: ThreadQueueAddCommand },
  ) => Effect.Effect<unknown, Error>;
  readonly planWorktreeCheckout: (input: {
    readonly project: OrchestrationProjectShell;
    readonly settings: ServerSettings;
    readonly branch: string;
    readonly initialName: string;
    readonly baseRef: string;
    readonly runSetupScript: boolean;
  }) => Effect.Effect<string, Error>;
  readonly createOwnedWorktree: (input: {
    readonly index: number;
    readonly settings: ServerSettings;
    readonly project: OrchestrationProjectShell;
    readonly worktreeId: WorktreeId;
    readonly branch: string;
    readonly checkoutPath: string;
    readonly baseRef: string;
    readonly fetchOrigin?: boolean;
  }) => Effect.Effect<string, Error>;
  readonly launchSetupScript: (
    index: number,
    input: {
      readonly threadId: ThreadId;
      readonly projectId: string;
      readonly projectCwd: string;
      readonly worktreePath: string;
    },
  ) => Effect.Effect<ProjectSetupScriptRunnerResult, Error>;
  readonly resolvePreferences: typeof resolveProjectPreferences;
}

const refuse = (message: string) => Effect.fail(new Error(message));

/** Whether the chat works in a checkout of its own: a worktree record, or another path. */
export const worksInOwnCheckout = (
  thread: OrchestrationThreadShell,
  project: { readonly workspaceRoot: string } | undefined,
): boolean =>
  thread.worktreeId != null ||
  (thread.worktreePath !== null &&
    (project === undefined ||
      path.resolve(thread.worktreePath) !== path.resolve(project.workspaceRoot)));

/**
 * Why this chat cannot move now, or null. Checked by the tool, and by the executor before the
 * worktree is made and again before the chat moves.
 */
export const worktreeHandoffBlocker = (
  thread: OrchestrationThreadShell,
  project: { readonly workspaceRoot: string } | undefined,
): string | null =>
  thread.archivedAt !== null || thread.settledAt !== null
    ? "This chat is archived or settled, so it cannot move into a worktree."
    : worksInOwnCheckout(thread, project)
      ? "This chat already works in its own worktree. Keep working there, or ask for a new chat in another worktree (ryco_create_threads with envMode worktree)."
      : null;

const withStep = (state: AgentControlOperationState, step: string): AgentControlOperationState =>
  state.completedSteps.includes(step)
    ? state
    : { ...state, completedSteps: [...state.completedSteps, step] };

const withOwnedWorktrees = (
  state: AgentControlOperationState,
  ownedWorktrees: AgentControlOperationState["resources"]["ownedWorktrees"],
): AgentControlOperationState => ({ ...state, resources: { ...state.resources, ownedWorktrees } });

const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.squash(cause);
  return failure instanceof Error && failure.message.trim().length > 0
    ? failure.message
    : "unknown error";
};

/** What the agent reads once its chat moved. Bounded by the operation's 2,000 characters. */
export const worktreeHandoffNote = (input: {
  readonly worktreePath: string;
  readonly outcome: AgentControlWorktreeHandoffOutcome;
  readonly setupScriptName?: string | undefined;
  readonly setupFailure?: string | undefined;
}): string => {
  const { outcome } = input;
  const setup =
    outcome.setupScript === "started"
      ? `The setup script${input.setupScriptName ? ` "${input.setupScriptName}"` : ""} started in a terminal there.`
      : outcome.setupScript === "no-script"
        ? "The project has no setup script."
        : outcome.setupScript === "skipped"
          ? "The setup script was skipped."
          : `The setup script failed to start (${input.setupFailure ?? "unknown error"}).`;
  const next =
    outcome.continuation === "queued"
      ? "Your continuation prompt is queued: it starts the next turn in the worktree, with this conversation, once this turn ends. End your turn now."
      : outcome.continuation === "failed"
        ? "Your continuation prompt could not be queued: the chat waits in the worktree for the next message. End your turn now."
        : "The chat continues in the worktree with its next message. End your turn now.";
  const note = `Moved this chat into a new worktree at ${input.worktreePath} on branch ${outcome.branch}, from ${outcome.baseRef}. Uncommitted changes in the shared checkout stayed there. ${setup} ${next} The rest of this turn still runs in the shared checkout, so make no more changes in it.`;
  return note.length <= 2_000 ? note : `${note.slice(0, 1_999)}…`;
};

/**
 * One handoff per chat at a time on this node: a second one while the first runs is refused
 * (the first one's move would leave it nothing to move anyway).
 */
const inFlight = new Set<string>();

export const runWorktreeHandoff = (
  deps: WorktreeHandoffRunDeps,
  plan: AgentControlWorktreeHandoffPlan,
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.suspend(() => {
      if (inFlight.has(plan.threadId)) {
        return refuse("A worktree handoff is already in progress for this chat.");
      }
      inFlight.add(plan.threadId);
      return restore(handOff(deps, plan)).pipe(
        Effect.ensuring(Effect.sync(() => inFlight.delete(plan.threadId))),
      );
    }),
  );

const handOff = (deps: WorktreeHandoffRunDeps, plan: AgentControlWorktreeHandoffPlan) =>
  Effect.gen(function* () {
    const { operationId } = deps.operation();
    const state = () => deps.operation().state;
    const commandId = (step: string) => deps.ids.commandIdFor(operationId, step);
    const worktreeId = deps.ids.worktreeIdFor(operationId, 0);
    const started = state();
    if (!started.resources.threadIds.includes(plan.threadId)) {
      yield* deps.checkpoint({
        ...started,
        resources: {
          ...started.resources,
          threadIds: [...started.resources.threadIds, plan.threadId],
        },
      });
    }
    const settings = Option.isSome(deps.settings)
      ? yield* deps.settings.value.getSettings
      : DEFAULT_SERVER_SETTINGS;
    const thread = yield* deps.loadThread(plan.threadId);
    const project = (yield* deps.projects).find((candidate) => candidate.id === thread.projectId);
    if (project === undefined) return yield* refuse("This chat's project is unavailable.");
    const blocker = worktreeHandoffBlocker(thread, project);
    if (blocker !== null) return yield* refuse(blocker);
    if (!isAdoptableBranchName(plan.branch)) {
      return yield* refuse(`Git does not accept "${plan.branch}" as a branch name.`);
    }
    const local = yield* deps.git.localStatus({ cwd: project.workspaceRoot });
    if (!local.isRepo) {
      return yield* refuse("This chat's project is not a Git repository, so it has no worktrees.");
    }
    if ((yield* deps.git.listLocalBranchNames(project.workspaceRoot)).includes(plan.branch)) {
      return yield* refuse(
        `Branch ${plan.branch} already exists. Choose another name, or delete that branch first.`,
      );
    }
    const baseRef = plan.baseRef ?? local.refName;
    if (baseRef === null) {
      return yield* refuse(
        "The project's checkout is not on a branch (detached HEAD). Pass baseRef to choose where the new branch starts.",
      );
    }
    // The agent may skip the setup script; it never runs one the user turned off.
    const runSetupScript =
      plan.runSetupScript && deps.resolvePreferences({ settings, project }).runSetupScript.value;
    const checkoutPath = yield* deps.planWorktreeCheckout({
      project,
      settings,
      branch: plan.branch,
      initialName: thread.title,
      // A base fetched from origin is checked by the fetch itself.
      baseRef: plan.startFromOrigin ? "HEAD" : baseRef,
      runSetupScript,
    });
    const worktreePath = yield* deps.createOwnedWorktree({
      index: 0,
      settings,
      project,
      worktreeId,
      branch: plan.branch,
      checkoutPath,
      baseRef,
      ...(plan.startFromOrigin ? { fetchOrigin: true } : {}),
    });

    // The chat may have been archived, moved or deleted while the worktree was made: then the
    // operation still owns the worktree, and its compensation removes it.
    const current = yield* deps.loadThread(plan.threadId);
    const lateBlocker =
      current.projectId === project.id
        ? worktreeHandoffBlocker(current, project)
        : "This chat moved to another project.";
    if (lateBlocker !== null) return yield* refuse(`${lateBlocker} The handoff was rolled back.`);

    // Uninterruptible: a shutdown never stops between giving the worktree up and recording that
    // the chat holds it.
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const owned = state().resources.ownedWorktrees;
        yield* deps.checkpoint(
          withStep(
            withOwnedWorktrees(
              state(),
              owned.filter((worktree) => worktree.worktreeId !== worktreeId),
            ),
            "handoff-bind-started",
          ),
        );
        const moved = yield* Effect.exit(
          deps.dispatch(HANDOFF_MOVED_STEP, {
            type: "thread.meta.update",
            commandId: commandId("handoff-thread-move"),
            threadId: plan.threadId,
            branch: plan.branch,
            // Fenced: a branch change since the check refuses the move.
            expectedBranch: current.branch,
            worktreePath,
          }),
        );
        if (moved._tag === "Failure") {
          const after = yield* Effect.option(deps.loadThread(plan.threadId));
          if (Option.isNone(after) || after.value.worktreePath !== worktreePath) {
            // Not moved: the worktree is the operation's again, so compensation removes it.
            yield* deps.checkpoint(withOwnedWorktrees(state(), owned));
            return yield* Effect.failCause(moved.cause);
          }
          // It moved although its answer was lost: record it like a move that answered.
          yield* deps.checkpoint(withStep(state(), HANDOFF_MOVED_STEP));
        }
        yield* deps.dispatch("handoff-attached", {
          type: "thread.attach-to-worktree",
          commandId: commandId("handoff-thread-attach"),
          threadId: plan.threadId,
          worktreeId,
          attachedAt: new Date().toISOString(),
        });
      }),
    );

    // Right after the move, so the next turn has its prompt even if setup fails. The queue sends
    // it once the chat is idle, after the person's own follow-ups.
    let continuation: AgentControlWorktreeHandoffOutcome["continuation"] = "skipped";
    if (plan.continuationPrompt !== undefined) {
      const text = plan.continuationPrompt;
      const queued = yield* Effect.exit(
        Effect.flatMap(deps.loadThread(plan.threadId), (moved) =>
          deps.dispatch("handoff-continuation-queued", {
            queued: {
              type: "thread.queue.add",
              commandId: commandId("handoff-continuation"),
              threadId: plan.threadId,
              author: "agent",
              // Its agent may edit or remove it (`ryco_queue_*`).
              queuedBy: plan.threadId,
              entry: {
                messageId: deps.ids.messageIdFor(operationId, "handoff-continuation"),
                text,
                attachments: [],
                modelSelection: moved.modelSelection,
                runtimeMode: moved.runtimeMode,
                interactionMode: moved.interactionMode,
                ...(moved.tokenMode === undefined ? {} : { tokenMode: moved.tokenMode }),
              },
              createdAt: new Date().toISOString(),
            },
          }),
        ),
      );
      continuation = queued._tag === "Success" ? "queued" : "failed";
      if (queued._tag === "Failure") {
        yield* Effect.logWarning("worktree handoff continuation was not queued", {
          threadId: plan.threadId,
          cause: Cause.pretty(queued.cause),
        });
      }
    }

    let setupScript: AgentControlWorktreeHandoffOutcome["setupScript"] = "skipped";
    let setupScriptName: string | undefined;
    let setupFailure: string | undefined;
    if (runSetupScript) {
      const launched = yield* Effect.exit(
        deps.launchSetupScript(0, {
          threadId: plan.threadId,
          projectId: project.id,
          projectCwd: project.workspaceRoot,
          worktreePath,
        }),
      );
      if (launched._tag === "Success") {
        setupScript = launched.value.status;
        if (launched.value.status === "started") setupScriptName = launched.value.scriptName;
      } else {
        setupScript = "failed";
        setupFailure = causeMessage(launched.cause).slice(0, 300);
      }
    }

    const outcome: AgentControlWorktreeHandoffOutcome = {
      branch: plan.branch,
      baseRef:
        plan.startFromOrigin && !baseRef.startsWith("origin/") ? `origin/${baseRef}` : baseRef,
      startedFromOrigin: plan.startFromOrigin,
      setupScript,
      continuation,
    };
    yield* deps.checkpoint({
      ...state(),
      note: worktreeHandoffNote({ worktreePath, outcome, setupScriptName, setupFailure }),
      worktreeHandoff: outcome,
    });
  });
