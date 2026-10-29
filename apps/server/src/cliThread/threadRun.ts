/**
 * What `ryco thread` decides from what it reads: which turn a command waits for,
 * when that turn has ended and how, the exit code a script sees, and the text it
 * prints. Pure; the reads and the waiting live in `threadCommands.ts`.
 *
 * A command waits for exactly the turn it started. It binds the user message it
 * sent to the turn the node starts for it (the node records the message on that
 * turn), so a turn that was already running, or one another client starts later,
 * never stands in for it.
 *
 * @module cliThread/threadRun
 */
import path from "node:path";

import {
  type AgentControlMcpReadThreadResult,
  DEFAULT_RUNTIME_MODE,
  type MessageId,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  ProviderInstanceId,
  type RuntimeMode,
  type TurnId,
} from "@ryco/contracts";
import { isChatProject } from "@ryco/shared/projectKind";
import { isRestartReleasedSession } from "@ryco/shared/restartContinuation";
import { isRuntimeModeAbove } from "@ryco/shared/runtimeMode";
import { truncate } from "@ryco/shared/String";
import { turnStartEndedMessageId } from "@ryco/shared/turnStart";
import { isThreadTurnRunning } from "@ryco/shared/turnRunning";
import { Option, Schema } from "effect";

// ── Outcomes ──────────────────────────────────────────────────────────

/**
 * How a run ended, as `--json` names it. `started`: the command returned once the
 * turn had started, without `--wait`.
 */
export type RunState =
  | "started"
  | "completed"
  | "failed"
  | "stopped"
  | "needs-approval"
  | "needs-input"
  | "restarted"
  | "timed-out"
  | "unknown";

/** A state the run cannot leave: everything but `started` and the command's own timeout. */
export type EndedRunState = Exclude<RunState, "started" | "timed-out">;

/**
 * The exit code a script sees: 0 a reply (or a started turn without `--wait`), 1 the
 * turn failed or was stopped, 2 it needs a person (an approval or an answer), 3 a node
 * restart cut it off, 4 the command timed out, 5 the turn ended but how is not known (a
 * later turn replaced it before the CLI saw its end; no read tells a past turn's outcome).
 */
export const runExitCode = (state: RunState): number => {
  switch (state) {
    case "started":
    case "completed":
      return 0;
    case "needs-approval":
    case "needs-input":
      return 2;
    case "restarted":
      return 3;
    case "timed-out":
      return 4;
    case "unknown":
      return 5;
    case "failed":
    case "stopped":
      return 1;
  }
};

/** What `--json` prints for `start`, `send` and `wait`. */
export interface RunResult {
  readonly threadId: string;
  readonly turnId: TurnId | null;
  readonly state: RunState;
  readonly reply: string | null;
  readonly error: string | null;
}

// ── Facts from the thread's live events ───────────────────────────────

export interface ReleasedRun {
  readonly state: "completed" | "error" | "interrupted";
  /** A node restart released the session (`isRestartReleasedSession`). */
  readonly restarted: boolean;
  readonly error: string | null;
}

/**
 * What the thread's live events said about the run. Kept for the whole command, across
 * reconnects; the thread's shell stays the authority for everything it records itself.
 */
export interface RunFacts {
  /** The user message this command sent: its turn is the run. */
  readonly messageId: MessageId | null;
  /**
   * `wait` while a turn start is pending: the run is the first turn after this one (null:
   * the thread's first turn). Undefined otherwise.
   */
  readonly nextTurnAfter?: TurnId | null;
  /** The message whose turn start the node holds (`thread.turn-start-requested`). */
  readonly pendingMessageId: MessageId | null;
  /** The run's turn, once known. */
  readonly turnId: TurnId | null;
  /** How the run's turn was released, when a session-set said so. */
  readonly released: ReleasedRun | null;
  /** The node ended the message's turn start before any turn ran. */
  readonly startEnded: { readonly cancelled: boolean; readonly detail: string | null } | null;
}

export const initialRunFacts = (input: {
  readonly messageId?: MessageId | null;
  readonly turnId?: TurnId | null;
  readonly nextTurnAfter?: TurnId | null;
}): RunFacts => ({
  messageId: input.messageId ?? null,
  ...(input.nextTurnAfter === undefined ? {} : { nextTurnAfter: input.nextTurnAfter }),
  pendingMessageId: null,
  turnId: input.turnId ?? null,
  released: null,
  startEnded: null,
});

/**
 * The run `wait` follows when it is given no turn: the turn the thread runs, a turn
 * start the node is about to run, else the latest turn. Null when there is none.
 */
export const latestRunFacts = (shell: OrchestrationThreadShell): RunFacts | null => {
  const session = shell.session;
  if (session?.activeTurnId) return initialRunFacts({ turnId: session.activeTurnId });
  const latest = shell.latestTurn;
  if (session?.status === "starting" && latest?.state !== "running") {
    return initialRunFacts({ nextTurnAfter: latest?.turnId ?? null });
  }
  return latest === null ? null : initialRunFacts({ turnId: latest.turnId });
};

const activityDetail = (activity: OrchestrationThreadActivity): string | null => {
  const payload = activity.payload;
  if (typeof payload !== "object" || payload === null || !("detail" in payload)) return null;
  return typeof payload.detail === "string" && payload.detail.trim().length > 0
    ? payload.detail
    : null;
};

/** The node gave up the message's turn start (`provider.turn.start.failed|cancelled`). */
export const observeRunActivity = (
  facts: RunFacts,
  activity: OrchestrationThreadActivity,
): RunFacts => {
  if (facts.messageId === null || facts.turnId !== null || facts.startEnded !== null) return facts;
  if (turnStartEndedMessageId(activity) !== facts.messageId) return facts;
  return {
    ...facts,
    startEnded: {
      cancelled: activity.kind === "provider.turn.start.cancelled",
      detail: activityDetail(activity),
    },
  };
};

/** The turn a running session-set starts is the run's, by the facts' binding rule. */
const bindsRun = (facts: RunFacts, activeTurnId: TurnId): boolean =>
  facts.turnId === null &&
  (facts.messageId !== null
    ? // As the projection binds it: the running turn takes the message whose start is held.
      facts.pendingMessageId === facts.messageId
    : facts.nextTurnAfter !== undefined && activeTurnId !== facts.nextTurnAfter);

/** Folds one live event of the run's thread into the facts. */
export const observeRunEvent = (facts: RunFacts, event: OrchestrationEvent): RunFacts => {
  switch (event.type) {
    case "thread.turn-start-requested":
      return { ...facts, pendingMessageId: event.payload.messageId };
    case "thread.session-set": {
      const { session, releasedTurn } = event.payload;
      let next = facts;
      if (
        session.status === "running" &&
        session.activeTurnId !== null &&
        bindsRun(next, session.activeTurnId)
      ) {
        next = { ...next, turnId: session.activeTurnId };
      }
      if (
        releasedTurn !== undefined &&
        next.released === null &&
        releasedTurn.turnId === next.turnId
      ) {
        next = {
          ...next,
          released: {
            state: releasedTurn.state,
            restarted: isRestartReleasedSession(session),
            error: session.lastError,
          },
        };
      }
      return next;
    }
    case "thread.activity-appended":
      return observeRunActivity(facts, event.payload.activity);
    default:
      return facts;
  }
};

/**
 * Whether an event of the run's thread can move the run, so the wait re-reads the thread:
 * any but the streaming text of a reply. A burst of other events costs a few reads at most
 * (the wait spaces them).
 */
export const wakesRun = (event: OrchestrationEvent): boolean =>
  event.type !== "thread.message-sent";

// ── Deciding the run's state ──────────────────────────────────────────

export type RunEvaluation =
  | { readonly done: false; readonly turnId: TurnId | null }
  | {
      readonly done: true;
      readonly state: EndedRunState;
      readonly turnId: TurnId | null;
      readonly error: string | null;
    };

const ended = (
  state: EndedRunState,
  turnId: TurnId | null,
  error: string | null = null,
): RunEvaluation => ({ done: true, state, turnId, error });

const releasedEvaluation = (released: ReleasedRun, turnId: TurnId): RunEvaluation => {
  if (released.restarted) return ended("restarted", turnId, released.error);
  if (released.state === "completed") return ended("completed", turnId);
  return released.state === "interrupted"
    ? ended("stopped", turnId, released.error ?? "The turn was stopped.")
    : ended("failed", turnId, released.error ?? "The turn failed.");
};

/** The run's turn as the shell shows it, when the events have not bound it yet. */
const shellRunTurn = (shell: OrchestrationThreadShell, facts: RunFacts): TurnId | null => {
  if (facts.turnId !== null) return facts.turnId;
  const latest = shell.latestTurn;
  if (facts.messageId !== null) {
    return latest?.userMessageId === facts.messageId ? latest.turnId : null;
  }
  if (facts.nextTurnAfter === undefined) return null;
  const active = shell.session?.activeTurnId ?? null;
  if (active !== null && active !== facts.nextTurnAfter) return active;
  return latest !== null && latest.turnId !== facts.nextTurnAfter ? latest.turnId : null;
};

/**
 * Where the run stands, from a fresh read of its thread (null: the thread is gone) and
 * the facts. A pending approval or question on the running turn ends the wait: the run
 * cannot go on until a person answers it.
 */
export const evaluateRun = (
  shell: OrchestrationThreadShell | null,
  facts: RunFacts,
): RunEvaluation => {
  if (shell === null) return ended("failed", facts.turnId, "The thread was deleted.");
  const session = shell.session;
  const turnId = shellRunTurn(shell, facts);
  if (turnId === null) {
    if (facts.startEnded !== null) {
      return facts.startEnded.cancelled
        ? ended("stopped", null, facts.startEnded.detail ?? "The turn was stopped before it began.")
        : ended("failed", null, facts.startEnded.detail ?? "The turn could not start.");
    }
    // `wait` saw a turn start pending, and the thread settled without running a turn.
    if (facts.nextTurnAfter !== undefined && !isThreadTurnRunning(session, shell.latestTurn)) {
      return ended("failed", null, "The pending turn did not start.");
    }
    return { done: false, turnId: null };
  }
  if (facts.released !== null && facts.turnId === turnId) {
    return releasedEvaluation(facts.released, turnId);
  }
  const latest = shell.latestTurn;
  if (latest?.turnId === turnId) {
    if (latest.state === "running") {
      // Busy with this turn (not a later one), unless the session already released the row.
      if (isThreadTurnRunning(session, latest) && (session?.activeTurnId ?? turnId) === turnId) {
        if (shell.hasPendingApprovals) return ended("needs-approval", turnId);
        if (shell.hasPendingUserInput) return ended("needs-input", turnId);
        return { done: false, turnId };
      }
      if (session !== null && isRestartReleasedSession(session)) {
        return ended("restarted", turnId, session.lastError);
      }
      return session?.status === "error"
        ? ended("failed", turnId, session.lastError ?? "The turn failed.")
        : ended("completed", turnId);
    }
    if (session !== null && isRestartReleasedSession(session)) {
      return ended("restarted", turnId, session.lastError);
    }
    switch (latest.state) {
      case "completed":
        return ended("completed", turnId);
      case "interrupted":
        return ended("stopped", turnId, session?.lastError ?? "The turn was stopped.");
      case "error":
        return ended("failed", turnId, session?.lastError ?? "The turn failed.");
    }
  }
  // The session runs the turn before the shell's latest-turn row caught up with it.
  if (session?.activeTurnId === turnId) return { done: false, turnId };
  return ended(
    "unknown",
    turnId,
    "A later turn has started on this thread, so how this one ended is not known.",
  );
};

/** Whether `ryco thread send` can start its turn now or must wait. */
export type QueueGate =
  | { readonly kind: "ready"; readonly shell: OrchestrationThreadShell }
  | { readonly kind: "wait" }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * A queued message goes out once the thread's turn is over, as the apps' follow-up queue
 * sends it (`isThreadTurnRunning`), and a pending approval or question holds it until a
 * person answers, as it holds theirs.
 */
export const queueGate = (shell: OrchestrationThreadShell | null): QueueGate => {
  if (shell === null) return { kind: "unavailable", reason: "The thread was not found." };
  if (shell.archivedAt !== null) return { kind: "unavailable", reason: "The thread is archived." };
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return { kind: "wait" };
  return isThreadTurnRunning(shell.session, shell.latestTurn)
    ? { kind: "wait" }
    : { kind: "ready", shell };
};

/** The node refused the turn start because another turn got there first: queue again. */
export const isBusyTurnStartRejection = (error: unknown): boolean =>
  error instanceof Error && /already has active turn/u.test(error.message);

// ── Starting a thread ─────────────────────────────────────────────────

/**
 * The runtime mode a thread started from the CLI gets when none is asked for, and the
 * most it may be given. Ryco keeps no runtime mode per project: a new thread starts at
 * the mode the apps give one, so a script never starts above what the owner would.
 */
export const PROJECT_DEFAULT_RUNTIME_MODE: RuntimeMode = DEFAULT_RUNTIME_MODE;

export const resolveStartRuntimeMode = (
  requested: RuntimeMode | null,
  ceiling: RuntimeMode = PROJECT_DEFAULT_RUNTIME_MODE,
): { readonly runtimeMode: RuntimeMode } | { readonly error: string } => {
  if (requested === null) return { runtimeMode: ceiling };
  return isRuntimeModeAbove(requested, ceiling)
    ? { error: `--runtime-mode ${requested} is above this project's default (${ceiling}).` }
    : { runtimeMode: requested };
};

const decodeProviderInstanceId = Schema.decodeUnknownOption(ProviderInstanceId);

/**
 * `--model instance/model`; the model slug may itself hold slashes. The project's default
 * keeps its options (effort and the like) when the flag names the same model.
 */
export const resolveStartModel = (
  flag: string | null,
  projectDefault: ModelSelection,
): { readonly modelSelection: ModelSelection } | { readonly error: string } => {
  if (flag === null) return { modelSelection: projectDefault };
  const separator = flag.indexOf("/");
  const instance = separator > 0 ? flag.slice(0, separator).trim() : "";
  const model = separator > 0 ? flag.slice(separator + 1).trim() : "";
  const instanceId = decodeProviderInstanceId(instance);
  if (model.length === 0 || Option.isNone(instanceId)) {
    return { error: `--model takes instance/model, for example codex/gpt-5.5; got "${flag}".` };
  }
  return projectDefault.instanceId === instanceId.value && projectDefault.model === model
    ? { modelSelection: projectDefault }
    : { modelSelection: { instanceId: instanceId.value, model } };
};

/** The thread title a prompt gives: its first line, shortened like the apps shorten it. */
export const threadTitleFromPrompt = (prompt: string): string =>
  truncate(
    prompt
      .split(/\r?\n/u)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "New thread",
  );

/** Whether `target` is `root` or a path inside it. */
const containsPath = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

/**
 * The project `--project` names: an exact id, else the deepest project whose folder holds
 * `target` (a path as the caller compares it; null when the identifier is no path). A chat's
 * folder is no place to start work, so a path never picks a chat.
 */
export const findProject = (
  projects: ReadonlyArray<OrchestrationProjectShell>,
  identifier: string,
  target: string | null,
  rootOf: (project: OrchestrationProjectShell) => string = (project) => project.workspaceRoot,
): OrchestrationProjectShell | null => {
  const byId = projects.find((project) => project.id === identifier);
  if (byId !== undefined) return byId;
  if (target === null) return null;
  return (
    projects
      .filter((project) => !isChatProject(project))
      .map((project) => ({ project, root: rootOf(project) }))
      .filter(({ root }) => containsPath(root, target))
      .toSorted((left, right) => right.root.length - left.root.length)[0]?.project ?? null
  );
};

// ── Output ────────────────────────────────────────────────────────────

/**
 * What stdout gets: the one-line JSON document under `--json`, else the reply (or, for a
 * run that was only started, the id a script passes on: the thread's for `start`, the
 * turn's for `send`).
 */
export const formatRunResult = (
  result: RunResult,
  options: { readonly json: boolean; readonly startedId: "thread" | "turn" },
): string | null => {
  if (options.json) {
    return JSON.stringify({
      threadId: result.threadId,
      turnId: result.turnId,
      state: result.state,
      reply: result.reply,
      error: result.error,
    });
  }
  if (result.state === "started") {
    return options.startedId === "thread" ? result.threadId : result.turnId;
  }
  return result.reply;
};

/** One line on stderr for a person reading along; null when stdout says it all. */
export const describeRunResult = (result: RunResult): string | null => {
  switch (result.state) {
    case "started":
    case "completed":
      return null;
    case "needs-approval":
      return `Thread ${result.threadId} is waiting for an approval. Open it in Ryco to answer.`;
    case "needs-input":
      return `Thread ${result.threadId} is waiting for an answer. Open it in Ryco to reply.`;
    case "restarted":
      return "A node restart cut the turn off. Send a new message to continue.";
    case "timed-out":
      return result.turnId === null
        ? "Timed out before the turn started."
        : "Timed out; the turn is still running.";
    case "failed":
    case "stopped":
    case "unknown":
      return result.error;
  }
};

/** A `ryco thread read` page for a person: the title, then each message under its role. */
export const formatTranscript = (page: typeof AgentControlMcpReadThreadResult.Encoded): string => {
  const lines = [page.thread.title, `${page.thread.threadId}  ${page.thread.status}`];
  if (page.hasMoreBefore) lines.push("(Earlier messages are not shown.)");
  for (const message of page.messages) {
    lines.push("", `[${message.role}]`, message.truncated ? `${message.text} […]` : message.text);
  }
  return lines.join("\n");
};
