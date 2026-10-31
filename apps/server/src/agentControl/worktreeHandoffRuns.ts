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
 * archived or moved meanwhile, or the turn that asked stopped) removes it. Just before the move the
 * operation gives it up and records it as the handoff's (`handoffWorktree`), so no rollback ever
 * removes a checkout the chat may already work in: a restart in between finishes the move when the
 * chat points at the worktree, or takes the worktree back and removes it. Changes in the shared
 * checkout are never carried over.
 *
 * Loaded by the executor on the first handoff; it imports no boot values (the executor passes its
 * own in), so the server's boot path carries none of it.
 *
 * @module agentControl/worktreeHandoffRuns
 */
import {
  DEFAULT_SERVER_SETTINGS,
  type AgentControlHandoffWorktree,
  type AgentControlOperation,
  type AgentControlOperationId,
  type AgentControlOperationState,
  type AgentControlPrincipal,
  type AgentControlWorktreeHandoffOutcome,
  type AgentControlWorktreeHandoffPlan,
  type ClientOrchestrationCommand,
  type CommandId,
  type FollowUpQueueHoldInput,
  type MessageId,
  type OrchestrationProjectShell,
  type OrchestrationReadModel,
  type OrchestrationThreadShell,
  type ServerSettings,
  type ThreadId,
  type ThreadQueueAddCommand,
  type TurnId,
  type WorktreeId,
} from "@ryco/contracts";
import path from "node:path";

import { Cause, Effect, Option } from "effect";

import type { ProjectSetupScriptRunnerResult } from "../project/Services/ProjectSetupScriptRunner.ts";
import type { resolveProjectPreferences } from "../project/projectPreferences.ts";
import { isAdoptableBranchName } from "../orchestration/threadGitMetadata.ts";

/** The step that records the chat's move; executor recovery reads it (as a literal). */
export const HANDOFF_MOVED_STEP = "handoff-thread-moved";
/** The step that records the operation gave the worktree up for the move. */
export const HANDOFF_BIND_STARTED_STEP = "handoff-bind-started";
const ATTACHED_STEP = "handoff-attached";
const CONTINUATION_STEP = "handoff-continuation-queued";
const SETUP_STEP = "setup-launched:0";

/** The commands a handoff applies; the continuation goes as `{ queued }` (the agent's entry). */
export type WorktreeHandoffCommand = Extract<
  ClientOrchestrationCommand,
  { type: "thread.meta.update" | "thread.attach-to-worktree" }
>;

/** The Git reads of the branch-name fence (the node's Git driver). */
export interface WorktreeHandoffGitDriver {
  readonly readConfigSnapshot: (
    cwd: string,
  ) => Effect.Effect<{ readonly remoteNames: ReadonlyArray<string> }, Error>;
  readonly execute: (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly allowNonZeroExit?: boolean;
    readonly readOnly?: boolean;
    readonly maxOutputBytes?: number;
    readonly timeoutMs?: number;
  }) => Effect.Effect<{ readonly exitCode: number; readonly stdout: string }, Error>;
}

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
  /** Refuses branch names that would shadow a remote's branches or an existing ref. */
  readonly gitDriver: Option.Option<WorktreeHandoffGitDriver>;
  /** The node's read model, where a queue's hold is decided (absent in some test doubles). */
  readonly readModel: (() => Effect.Effect<OrchestrationReadModel>) | undefined;
  /** The executor's deterministic ids of an operation's steps. */
  readonly ids: {
    readonly commandIdFor: (operationId: AgentControlOperationId, step: string) => CommandId;
    readonly messageIdFor: (operationId: AgentControlOperationId, step: string) => MessageId;
    readonly worktreeIdFor: (operationId: AgentControlOperationId, index: number) => WorktreeId;
  };
  /** The operation as last checkpointed. */
  readonly operation: () => Pick<AgentControlOperation, "operationId" | "state">;
  readonly checkpoint: (state: AgentControlOperationState) => Effect.Effect<unknown, Error>;
  /** The executor's own: records `step` as completed (once). */
  readonly appendStep: (
    state: AgentControlOperationState,
    step: string,
  ) => AgentControlOperationState;
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

/**
 * Printable ASCII only. Anything else may read differently from what Git stores (invisible and
 * text-direction characters, look-alike letters), or name the same ref in another form on a
 * file system that folds case or normalizes Unicode (macOS, Windows).
 */
const NOT_PLAIN_ASCII = /[^\x21-\x7E]/u;
/** Ref namespaces a branch must not start with (in any case): Git reads the name as another ref. */
const SHADOWING_PREFIXES = ["refs/", "heads/", "tags/", "remotes/"];
/**
 * Git's own root refs, in any case: `HEAD`, every `*_HEAD` (`FETCH_HEAD`, `ORIG_HEAD`,
 * `MERGE_HEAD`...) and the others Git keeps beside them.
 */
const PSEUDO_REF =
  /^(?:(?:[a-z_-]*_)?head|auto_merge|bisect_expected_rev|notes_merge_partial|notes_merge_ref|merge_autostash)$/iu;
/** Hex digits only, 4 or more: Git reads the name as an abbreviated commit id first. */
const OBJECT_NAME_LIKE = /^[0-9a-f]{4,}$/iu;
const PLAIN_NAME_HINT = "Choose a plain branch name such as feature/my-change.";

/**
 * Why a handoff refuses this branch name, or null: printable ASCII only, Git's branch-name rules,
 * and names that would shadow other refs (ref namespaces, Git's pseudo-refs, names that read as
 * commit ids). The executor also refuses `<remote>/` names, names of existing refs in any letter
 * case, and names Git already resolves (`worktreeHandoffBranchShadow`). Checked by the tool and
 * again before Git runs.
 */
export const worktreeHandoffBranchProblem = (branch: string): string | null => {
  // Checked first, so the answer never echoes a name that reads differently than it is.
  if (NOT_PLAIN_ASCII.test(branch)) {
    return `The branch name may use only plain ASCII letters, digits and punctuation: no spaces, accents, emoji or invisible characters. ${PLAIN_NAME_HINT}`;
  }
  if (!isAdoptableBranchName(branch)) return `Git does not accept "${branch}" as a branch name.`;
  const folded = branch.toLowerCase();
  if (SHADOWING_PREFIXES.some((prefix) => folded.startsWith(prefix))) {
    return `"${branch}" would shadow another Git ref. ${PLAIN_NAME_HINT}`;
  }
  if (PSEUDO_REF.test(branch)) {
    return `"${branch}" is a name Git keeps for itself (like HEAD or FETCH_HEAD). ${PLAIN_NAME_HINT}`;
  }
  if (OBJECT_NAME_LIKE.test(branch)) {
    return `"${branch}" reads as a commit id. ${PLAIN_NAME_HINT}`;
  }
  return null;
};

/** The ref namespaces Git looks a short name up in, as a branch would shadow them. */
const LOOKUP_NAMESPACES = ["refs/heads/", "refs/tags/", "refs/remotes/"];

/**
 * `<remote>/` names, names of existing refs in any letter case, and names Git already resolves
 * (a tag, a remote branch, a commit).
 */
const worktreeHandoffBranchShadow = (
  driver: Option.Option<WorktreeHandoffGitDriver>,
  cwd: string,
  branch: string,
) =>
  Effect.gen(function* () {
    if (Option.isNone(driver)) return null;
    // Compared case-insensitively: a checkout on macOS or Windows stores refs in a file system
    // that ignores case, so `ORIGIN/main` is `origin/main`'s ref file there.
    const folded = branch.toLowerCase();
    const { remoteNames } = yield* driver.value.readConfigSnapshot(cwd);
    const remote = remoteNames.find((name) => folded.startsWith(`${name.toLowerCase()}/`));
    if (remote !== undefined) {
      return `"${branch}" would shadow the branches of the remote ${remote}. Choose a name that does not start with "${remote}/".`;
    }
    // `git worktree add -b MAIN` where `main` is would share `main`'s ref file with the shared
    // checkout, so the agent's commits would move it. Git's own lookup misses case variants of
    // packed refs, so the refs are listed (Git filters them ignoring case) and compared here.
    const candidates = LOOKUP_NAMESPACES.map((namespace) => `${namespace}${branch}`);
    const listed = yield* driver.value.execute({
      operation: "AgentControlExecution.worktreeHandoffBranch",
      cwd,
      args: ["for-each-ref", "--ignore-case", "--format=%(refname)", ...candidates],
      allowNonZeroExit: true,
      readOnly: true,
      maxOutputBytes: 1_048_576,
      timeoutMs: 15_000,
    });
    if (listed.exitCode !== 0) {
      return "Ryco could not read this project's Git refs to check the branch name. Try again.";
    }
    const wanted = new Set(candidates.map((ref) => ref.toLowerCase()));
    const clash = listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .find((ref) => wanted.has(ref.toLowerCase()));
    if (clash !== undefined) {
      return `"${branch}" names the existing Git ref ${clash} (Git treats names that differ only in letter case as one on macOS and Windows). Choose another branch name.`;
    }
    const resolved = yield* driver.value.execute({
      operation: "AgentControlExecution.worktreeHandoffBranch",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", "--end-of-options", branch],
      allowNonZeroExit: true,
      readOnly: true,
      maxOutputBytes: 4_096,
      timeoutMs: 15_000,
    });
    return resolved.exitCode === 0
      ? `"${branch}" already names a Git ref or commit in this project. Choose another branch name.`
      : null;
  });

/**
 * How the turn that asked for the handoff stands: `stopped` (interrupted: the person pressed
 * Stop), `superseded` (a newer turn is the chat's), or null (still running, or ended normally).
 */
export const askingTurnEnd = (
  thread: OrchestrationThreadShell,
  askingTurnId: TurnId | undefined,
): "stopped" | "superseded" | null => {
  if (askingTurnId === undefined) return null;
  const latest = thread.latestTurn;
  if (latest?.turnId === askingTurnId) return latest.state === "interrupted" ? "stopped" : null;
  const active = thread.session?.activeTurnId ?? null;
  if (active === askingTurnId) return null;
  return latest === null && active === null ? null : "superseded";
};

const ASKING_TURN_ENDED: Record<"stopped" | "superseded", string> = {
  stopped:
    "The turn that asked for this handoff was stopped, so the chat stays in the shared checkout.",
  superseded:
    "A newer turn started in this chat before the handoff finished, so the chat stays in the shared checkout.",
};

const withOwnedWorktrees = (
  state: AgentControlOperationState,
  ownedWorktrees: AgentControlOperationState["resources"]["ownedWorktrees"],
): AgentControlOperationState => ({ ...state, resources: { ...state.resources, ownedWorktrees } });

const withoutHandoffWorktree = (state: AgentControlOperationState): AgentControlOperationState => {
  const { handoffWorktree: _handoffWorktree, ...rest } = state;
  return rest;
};

const TERMINAL_CWD_FAILURES = new Map([
  ["notFound", "the worktree folder was not found"],
  ["notDirectory", "the worktree path is not a folder"],
  ["outsideWorkspace", "the worktree is outside the folders Ryco may use"],
  ["cleanupPending", "the worktree is being cleaned up"],
]);
const SETUP_FAILURES = new Map([
  ["TerminalBusyError", "its terminal was busy"],
  ["PtySpawnError", "its terminal could not start"],
  ["TerminalNotRunningError", "its terminal stopped"],
  ["TerminalInputRejectedError", "its terminal refused the command"],
  ["TerminalSessionLookupError", "its terminal could not be opened"],
  ["TerminalHistoryError", "its terminal could not be opened"],
]);

/**
 * Why the setup script did not start, in fixed words by error tag: the stored note keeps no error
 * text, which can carry a path (a `TerminalCwdError` names the folder). The log has the cause.
 */
export const setupFailureText = (cause: Cause.Cause<unknown>): string => {
  const failure: unknown = Cause.squash(cause);
  const field = (name: string): unknown =>
    typeof failure === "object" && failure !== null && name in failure
      ? (failure as Record<string, unknown>)[name]
      : undefined;
  const tag = field("_tag");
  if (tag === "TerminalCwdError") {
    const reason = field("reason");
    return (
      (typeof reason === "string" ? TERMINAL_CWD_FAILURES.get(reason) : undefined) ??
      "the worktree folder could not be read"
    );
  }
  return (
    (typeof tag === "string" ? SETUP_FAILURES.get(tag) : undefined) ??
    "an unexpected error (the server log has the details)"
  );
};

const samePath = (left: string | null, right: string) =>
  left !== null && path.resolve(left) === path.resolve(right);

/**
 * What the agent reads once its chat moved. Bounded by the operation's 2,000 characters, and
 * without the checkout path: it is stored with the request (the answer carries the path).
 */
export const worktreeHandoffNote = (input: {
  readonly outcome: AgentControlWorktreeHandoffOutcome;
  readonly setupScriptName?: string | undefined;
  readonly setupFailure?: string | undefined;
  /** Finished by restart recovery. */
  readonly restarted?: boolean;
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
      : outcome.continuation === "held"
        ? "Your continuation prompt is queued, but the queue is held until the person resumes it. End your turn now."
        : outcome.continuation === "failed"
          ? "Your continuation prompt could not be queued: the chat waits in the worktree for the next message. End your turn now."
          : "The chat continues in the worktree with its next message. End your turn now.";
  const link =
    outcome.worktreeAttached === false
      ? " Ryco could not link the chat to the worktree's record, so the app may not list it with the worktree; the chat still works in the worktree."
      : "";
  const note = `${input.restarted === true ? "Ryco restarted during the move and finished it. " : ""}Moved this chat into a new worktree on branch ${outcome.branch}, from ${outcome.baseRef}.${link} Uncommitted changes in the shared checkout stayed there. ${setup} ${next} The rest of this turn still runs in the shared checkout, so make no more changes in it.`;
  return note.length <= 2_000 ? note : `${note.slice(0, 1_999)}…`;
};

/** Whether the chat's follow-up queue is held, as the node's read model has it. */
const queueIsHeld = (deps: WorktreeHandoffRunDeps, threadId: ThreadId) =>
  deps.readModel === undefined
    ? Effect.succeed(false)
    : Effect.map(
        deps.readModel(),
        (model) =>
          (model.threads.find((thread) => thread.id === threadId)?.followUpQueue?.hold ?? null) !==
          null,
      );

/**
 * One handoff per chat at a time on this node: a second one while the first runs is refused
 * (the first one's move would leave it nothing to move anyway).
 */
const inFlight = new Set<string>();

/**
 * Runs a handoff, or finishes one a restart cut off after the operation gave the worktree up
 * (`handoff-bind-started`). `principal` is the request's: its turn is the one that asked.
 */
export const runWorktreeHandoff = (
  deps: WorktreeHandoffRunDeps,
  plan: AgentControlWorktreeHandoffPlan,
  principal: AgentControlPrincipal,
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.suspend(() => {
      const askingTurnId = principal.kind === "provider-session" ? principal.turnId : undefined;
      if (inFlight.has(plan.threadId)) {
        return refuse("A worktree handoff is already in progress for this chat.");
      }
      inFlight.add(plan.threadId);
      const run = deps.operation().state.completedSteps.includes(HANDOFF_BIND_STARTED_STEP)
        ? resumeHandOff(deps, plan)
        : handOff(deps, plan, askingTurnId);
      return restore(run).pipe(Effect.ensuring(Effect.sync(() => inFlight.delete(plan.threadId))));
    }),
  );

const loadSettings = (deps: WorktreeHandoffRunDeps) =>
  Option.isSome(deps.settings)
    ? deps.settings.value.getSettings
    : Effect.succeed(DEFAULT_SERVER_SETTINGS);

const handOff = (
  deps: WorktreeHandoffRunDeps,
  plan: AgentControlWorktreeHandoffPlan,
  askingTurnId: TurnId | undefined,
) =>
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
    const settings = yield* loadSettings(deps);
    const thread = yield* deps.loadThread(plan.threadId);
    const project = (yield* deps.projects).find((candidate) => candidate.id === thread.projectId);
    if (project === undefined) return yield* refuse("This chat's project is unavailable.");
    const blocker = worktreeHandoffBlocker(thread, project);
    if (blocker !== null) return yield* refuse(blocker);
    const ended = askingTurnEnd(thread, askingTurnId);
    if (ended !== null) return yield* refuse(ASKING_TURN_ENDED[ended]);
    const branchProblem = worktreeHandoffBranchProblem(plan.branch);
    if (branchProblem !== null) return yield* refuse(branchProblem);
    const local = yield* deps.git.localStatus({ cwd: project.workspaceRoot });
    if (!local.isRepo) {
      return yield* refuse("This chat's project is not a Git repository, so it has no worktrees.");
    }
    // In any letter case: macOS and Windows checkouts keep `Main` and `main` in one ref file.
    const folded = plan.branch.toLowerCase();
    const existing = (yield* deps.git.listLocalBranchNames(project.workspaceRoot)).find(
      (name) => name.toLowerCase() === folded,
    );
    if (existing !== undefined) {
      return yield* refuse(
        existing === plan.branch
          ? `Branch ${plan.branch} already exists. Choose another name, or delete that branch first.`
          : `Branch ${existing} already exists, and Git treats names that differ only in letter case as one on macOS and Windows. Choose another name.`,
      );
    }
    const shadow = yield* worktreeHandoffBranchShadow(
      deps.gitDriver,
      project.workspaceRoot,
      plan.branch,
    );
    if (shadow !== null) return yield* refuse(shadow);
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

    // The chat may have been archived, moved or deleted, or the turn that asked stopped, while
    // the worktree was made: then the operation still owns the worktree, and its compensation
    // removes it.
    const current = yield* deps.loadThread(plan.threadId);
    const lateEnd = askingTurnEnd(current, askingTurnId);
    const lateBlocker =
      current.projectId !== project.id
        ? "This chat moved to another project."
        : (worktreeHandoffBlocker(current, project) ??
          (lateEnd === null ? null : ASKING_TURN_ENDED[lateEnd]));
    if (lateBlocker !== null) return yield* refuse(`${lateBlocker} The handoff was rolled back.`);

    const bound: AgentControlHandoffWorktree = {
      worktreeId,
      projectId: project.id,
      branch: plan.branch,
      checkoutPath: worktreePath,
      baseRef:
        plan.startFromOrigin && !baseRef.startsWith("origin/") ? `origin/${baseRef}` : baseRef,
    };
    // Uninterruptible: a shutdown never stops between giving the worktree up and recording that
    // the chat holds it.
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const owned = state().resources.ownedWorktrees;
        yield* deps.checkpoint(
          deps.appendStep(
            {
              ...withOwnedWorktrees(
                state(),
                owned.filter((worktree) => worktree.worktreeId !== worktreeId),
              ),
              handoffWorktree: bound,
            },
            HANDOFF_BIND_STARTED_STEP,
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
          // A chat that cannot be read keeps the worktree given up: it may already work there.
          const after = yield* deps
            .loadThread(plan.threadId)
            .pipe(Effect.catch(() => Effect.failCause(moved.cause)));
          if (!samePath(after.worktreePath, worktreePath)) {
            // Not moved: the worktree is the operation's again, so compensation removes it.
            yield* deps.checkpoint(withOwnedWorktrees(withoutHandoffWorktree(state()), owned));
            return yield* Effect.failCause(moved.cause);
          }
          // It moved although its answer was lost: record it like a move that answered.
          yield* deps.checkpoint(deps.appendStep(state(), HANDOFF_MOVED_STEP));
        }
      }),
    );

    yield* finishMove(deps, plan, {
      bound,
      project,
      runSetupScript,
      // A Stop that lands after the read below still holds it: the add decides it again.
      ...(askingTurnId === undefined ? {} : { askingTurnId }),
      // A Stop or a newer turn since the late check holds the continuation instead.
      hold: (moved) => {
        const end = askingTurnEnd(moved, askingTurnId);
        return end === "stopped" && askingTurnId !== undefined
          ? {
              reason: "interrupted",
              detail: null,
              // The cause key a Stop of that turn records (`createInterruptQueueHold`).
              causeKeys: [`interrupt:${askingTurnId}`],
            }
          : end === "superseded"
            ? {
                reason: "paused",
                detail:
                  "A newer turn started while this chat moved into its worktree. Resume to send the agent's next step.",
                causeKeys: [`paused:handoff:${operationId}`],
              }
            : undefined;
      },
    });
  });

/**
 * Finishes a handoff a restart cut off after the operation gave the worktree up: when the chat
 * points at the worktree, the move stands and the rest is done (the continuation held, as every
 * queue a restart leaves is); otherwise the worktree is the operation's again and the failure's
 * compensation removes it.
 */
const resumeHandOff = (deps: WorktreeHandoffRunDeps, plan: AgentControlWorktreeHandoffPlan) =>
  Effect.gen(function* () {
    const { operationId } = deps.operation();
    const state = () => deps.operation().state;
    const bound = state().handoffWorktree;
    if (bound === undefined) {
      return yield* refuse("Ryco restarted during this chat's move into a worktree.");
    }
    // A chat that cannot be read fails the recovery and keeps the worktree given up.
    const moved =
      state().completedSteps.includes(HANDOFF_MOVED_STEP) ||
      samePath((yield* deps.loadThread(plan.threadId)).worktreePath, bound.checkoutPath);
    if (!moved) {
      yield* deps.checkpoint(
        withOwnedWorktrees(withoutHandoffWorktree(state()), [
          ...state().resources.ownedWorktrees.filter(
            (worktree) => worktree.worktreeId !== bound.worktreeId,
          ),
          {
            worktreeId: bound.worktreeId,
            projectId: bound.projectId,
            branch: bound.branch,
            checkoutPath: bound.checkoutPath,
          },
        ]),
      );
      return yield* refuse(
        "Ryco restarted before this chat moved into its new worktree. The handoff was rolled back.",
      );
    }
    if (!state().completedSteps.includes(HANDOFF_MOVED_STEP)) {
      yield* deps.checkpoint(deps.appendStep(state(), HANDOFF_MOVED_STEP));
    }
    const settings = yield* loadSettings(deps);
    const project = (yield* deps.projects).find((candidate) => candidate.id === bound.projectId);
    const runSetupScript =
      project !== undefined &&
      plan.runSetupScript &&
      deps.resolvePreferences({ settings, project }).runSetupScript.value;
    yield* finishMove(deps, plan, {
      bound,
      project,
      runSetupScript,
      restarted: true,
      // Held, as every queue a restart leaves is.
      hold: () => ({
        reason: "restart",
        detail:
          "Ryco restarted while this chat moved into its worktree. Resume to send the agent's next step.",
        causeKeys: [`restart:handoff:${operationId}`],
      }),
    });
  });

/**
 * Links the moved chat to the worktree's record, queues the continuation and starts the setup
 * script, each once (deterministic ids: a resumed handoff repeats none). Nothing here undoes the
 * move: a failure is reported in the outcome.
 */
const finishMove = (
  deps: WorktreeHandoffRunDeps,
  plan: AgentControlWorktreeHandoffPlan,
  input: {
    readonly bound: AgentControlHandoffWorktree;
    readonly project: OrchestrationProjectShell | undefined;
    readonly runSetupScript: boolean;
    readonly restarted?: boolean;
    /** The turn that asked: a Stop of it the hold below did not see still holds the queue. */
    readonly askingTurnId?: TurnId;
    /** The hold the continuation is queued with, as the moved chat stands (none: sent as usual). */
    readonly hold: (thread: OrchestrationThreadShell) => FollowUpQueueHoldInput | undefined;
  },
) =>
  Effect.gen(function* () {
    const { operationId } = deps.operation();
    const state = () => deps.operation().state;
    const done = (step: string) => state().completedSteps.includes(step);
    const commandId = (step: string) => deps.ids.commandIdFor(operationId, step);
    const { bound } = input;
    let worktreeAttached = true;
    if (!done(ATTACHED_STEP)) {
      // The move stands without the link: the chat works in the worktree's folder either way.
      const attached = yield* Effect.exit(
        deps.dispatch(ATTACHED_STEP, {
          type: "thread.attach-to-worktree",
          commandId: commandId("handoff-thread-attach"),
          threadId: plan.threadId,
          worktreeId: bound.worktreeId,
          attachedAt: new Date().toISOString(),
        }),
      );
      if (attached._tag === "Failure") {
        worktreeAttached = false;
        yield* Effect.logWarning("worktree handoff could not link the chat to its worktree", {
          threadId: plan.threadId,
          cause: Cause.pretty(attached.cause),
        });
      }
    }

    // Right after the move, so the next turn has its prompt even if setup fails. The queue sends
    // it once the chat is idle, after the person's own follow-ups.
    let continuation: AgentControlWorktreeHandoffOutcome["continuation"] = "skipped";
    if (plan.continuationPrompt !== undefined && done(CONTINUATION_STEP)) {
      // Queued before a restart, which holds every queue it leaves.
      continuation = "held";
    } else if (plan.continuationPrompt !== undefined) {
      const text = plan.continuationPrompt;
      const queued = yield* Effect.exit(
        Effect.gen(function* () {
          const moved = yield* deps.loadThread(plan.threadId);
          const hold = input.hold(moved);
          yield* deps.dispatch(CONTINUATION_STEP, {
            queued: {
              type: "thread.queue.add",
              commandId: commandId("handoff-continuation"),
              threadId: plan.threadId,
              author: "agent",
              // Its agent may edit or remove it (`ryco_queue_*`).
              queuedBy: plan.threadId,
              ...(hold === undefined ? {} : { hold }),
              ...(input.askingTurnId === undefined
                ? {}
                : { holdIfTurnInterrupted: input.askingTurnId }),
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
          });
          // The add may have held the queue itself, or found it held already.
          const held = hold !== undefined || (yield* queueIsHeld(deps, plan.threadId));
          return held ? ("held" as const) : ("queued" as const);
        }),
      );
      if (queued._tag === "Success") {
        continuation = queued.value;
      } else {
        continuation = "failed";
        yield* Effect.logWarning("worktree handoff continuation was not queued", {
          threadId: plan.threadId,
          cause: Cause.pretty(queued.cause),
        });
      }
    }

    let setupScript: AgentControlWorktreeHandoffOutcome["setupScript"] = "skipped";
    let setupScriptName: string | undefined;
    let setupFailure: string | undefined;
    if (done(SETUP_STEP)) {
      setupScript = "started";
    } else if (input.runSetupScript && input.project !== undefined) {
      const launched = yield* Effect.exit(
        deps.launchSetupScript(0, {
          threadId: plan.threadId,
          projectId: input.project.id,
          projectCwd: input.project.workspaceRoot,
          worktreePath: bound.checkoutPath,
        }),
      );
      if (launched._tag === "Success") {
        setupScript = launched.value.status;
        if (launched.value.status === "started") setupScriptName = launched.value.scriptName;
      } else {
        setupScript = "failed";
        setupFailure = setupFailureText(launched.cause);
        yield* Effect.logWarning("worktree handoff setup script did not start", {
          threadId: plan.threadId,
          cause: Cause.pretty(launched.cause),
        });
      }
    }

    const outcome: AgentControlWorktreeHandoffOutcome = {
      branch: plan.branch,
      baseRef: bound.baseRef,
      startedFromOrigin: plan.startFromOrigin,
      setupScript,
      continuation,
      worktreeAttached,
    };
    yield* deps.checkpoint({
      ...state(),
      note: worktreeHandoffNote({
        outcome,
        setupScriptName,
        setupFailure,
        ...(input.restarted === true ? { restarted: true } : {}),
      }),
      worktreeHandoff: outcome,
    });
  });
