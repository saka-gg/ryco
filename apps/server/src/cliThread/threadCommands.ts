/**
 * `ryco thread start|send|wait|read`: shell scripts start agent threads, queue
 * follow-ups, wait for a specific run and read the result.
 *
 * The CLI is one more client of a node: it speaks the WebSocket RPC the apps
 * use, to this machine's node or to a paired remote (`--remote`), and builds
 * its commands with the apps' own builders (`buildTurnStartCommand`,
 * `buildSendTurnBootstrap`, `buildFollowUpQueueAddCommand`). A `send` to a node
 * that keeps follow-up queues (`serverFollowUpQueue`) goes to the end of the
 * thread's queue, as the apps' busy send does, so it never goes ahead of what a
 * person queued; an older node gets a turn start once the thread is idle. On this
 * machine it signs in as a short-lived owner
 * session, issued like `ryco auth session issue` issues one and revoked when the
 * command ends (Ctrl-C included); the token is never printed or written down.
 *
 * Waits decide from fresh reads of the thread's shell and wake on its live
 * events, re-checking every few seconds otherwise (`waitUntil`). A lost
 * connection (a node restart) reconnects and resumes the thread's events from
 * the last one seen, so the release of the run's turn is not missed.
 *
 * Loaded only when a `ryco thread` command runs.
 *
 * @module cliThread/threadCommands
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { isUnsupportedRpcError } from "@ryco/client-runtime/errors";
import {
  buildSendTurnBootstrap,
  buildTurnStartCommand,
  composeOutgoingPrompt,
  outgoingPromptOverflow,
} from "@ryco/client-runtime/state/composer/sendEngine";
import {
  buildFollowUpQueueAddCommand,
  selectServerFollowUpQueueSupported,
} from "@ryco/client-runtime/state/message-queue/serverQueue";
import {
  CommandId,
  type EffectiveProjectPreferences,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type OrchestrationThreadWindowStreamItem,
  type RuntimeMode,
  type ServerSettings,
  ThreadId,
  TurnId,
  WS_METHODS,
} from "@ryco/contracts";
import { isUnknownUnionMember } from "@ryco/contracts/base-schemas";
import { isChatProject } from "@ryco/shared/projectKind";
import { selectTurnReplyMessage } from "@ryco/shared/turnReply";
import {
  Cause,
  Clock,
  Console,
  Data,
  Duration,
  Effect,
  Exit,
  type Layer,
  Option,
  type Scope,
  Stream,
} from "effect";

import { wakeOnStream, waitUntil, type WaitWakeSource } from "../agentControl/eventDrivenWait.ts";
import type {
  readThreadMessageLimit,
  toReadThreadResult,
} from "../agentControl/Mcp/threadTranscript.ts";
import {
  AuthControlPlane,
  type AuthControlPlaneError,
  type AuthControlPlaneShape,
} from "../auth/Services/AuthControlPlane.ts";
import {
  CliRemoteError,
  connectCliRemote,
  type CliRemote,
  type CliRemoteRpcClient,
} from "../cliRemote/remotes.ts";
import { loadRemoteShell } from "../cliRemote/threads.ts";
import { heldOnlyForDelegationSlot } from "../orchestration/delegationSlotHold.ts";
import { resolveProjectPreferences } from "../project/projectPreferences.ts";
import {
  describeRunResult,
  evaluateRun,
  findProject,
  followUpQueueBlocker,
  formatRunResult,
  formatTranscript,
  initialRunFacts,
  isBusyTurnStartRejection,
  latestRunFacts,
  observeQueuedRunWindow,
  observeRunActivity,
  observeRunEvent,
  queueGate,
  queuedMessageBlocker,
  queuedRunLeftUnseen,
  resolveStartModel,
  resolveStartRuntimeMode,
  type RunEvaluation,
  type RunFacts,
  type RunResult,
  runExitCode,
  threadTitleFromPrompt,
  waitsInFollowUpQueue,
  wakesRun,
} from "./threadRun.ts";

/** A failure the command reports in one line (exit 1). */
export class ThreadCliError extends Data.TaggedError("ThreadCliError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const fail = (message: string) => Effect.fail(new ThreadCliError({ message }));

// ── Where the command runs ────────────────────────────────────────────

/** The node a command talks to. */
export interface ThreadCliTarget {
  /** Opens an RPC client in the caller's scope; run again after a lost connection. */
  readonly connect: Effect.Effect<CliRemoteRpcClient, CliRemoteError | ThreadCliError, Scope.Scope>;
  /** `--project` paths are this machine's: relative ones resolve, all compare as real paths. */
  readonly local: boolean;
}

export const remoteThreadTarget = (remote: CliRemote): ThreadCliTarget => ({
  connect: connectCliRemote(remote),
  local: false,
});

/** Long enough for a long run; bounds a session a killed command could not revoke. */
const LOCAL_SESSION_TTL = Duration.hours(24);

/*
 * The server code below is handed in by `cli.ts`, which already loads it, rather than
 * imported: an import would split it out of the boot chunks into chunks of its own.
 */

/** What reaching this machine's node takes. */
export interface ThreadCliLocal<EA, RA> {
  /** The node's address from its runtime state file; null when it is not running. */
  readonly readOrigin: Effect.Effect<string | null>;
  /**
   * The node's auth control plane, as the auth commands build it. It opens the node's
   * database, so it is built for the issue and the revoke only.
   */
  readonly authControlPlane: Layer.Layer<AuthControlPlane, EA, RA>;
}

/** The bounded transcript page `ryco_read_thread` returns. */
export interface ThreadCliTranscript {
  readonly toReadThreadResult: typeof toReadThreadResult;
  readonly readThreadMessageLimit: typeof readThreadMessageLimit;
}

/**
 * This machine's running node, signed in as a short-lived owner session that is revoked
 * when the caller's scope closes. The node's address is read again on every connect: a
 * restarted node can listen on another port.
 */
export const localThreadTarget = <EA, RA>(input: {
  readonly local: ThreadCliLocal<EA, RA>;
  readonly timeout: Duration.Duration | null;
  /**
   * The session's lifetime when the default does not fit. `ryco update` keeps it short: after
   * the node migrated its database, this older CLI cannot open it to revoke the session.
   */
  readonly sessionTtl?: Duration.Duration;
  /** The session's label in the node's session list. */
  readonly sessionLabel?: string;
}): Effect.Effect<ThreadCliTarget, ThreadCliError | AuthControlPlaneError | EA, RA | Scope.Scope> =>
  Effect.gen(function* () {
    const readOrigin = Effect.flatMap(input.local.readOrigin, (origin) =>
      origin === null
        ? fail("The Ryco server is not running. Start it with `ryco` or `ryco service start`.")
        : Effect.succeed(origin),
    );
    yield* readOrigin;
    const withAuth = <A, E>(run: (auth: AuthControlPlaneShape) => Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        return yield* run(yield* AuthControlPlane);
      }).pipe(Effect.provide(input.local.authControlPlane));
    const ttl =
      input.sessionTtl ??
      (input.timeout === null
        ? LOCAL_SESSION_TTL
        : Duration.max(LOCAL_SESSION_TTL, Duration.sum(input.timeout, Duration.minutes(10))));
    const issued = yield* Effect.acquireRelease(
      withAuth((auth) =>
        auth.issueSession({ role: "owner", label: input.sessionLabel ?? "ryco thread cli", ttl }),
      ),
      (session) =>
        withAuth((auth) => auth.revokeSession(session.sessionId)).pipe(
          Effect.ignore({ log: true }),
        ),
    );
    return {
      connect: Effect.flatMap(readOrigin, (origin) =>
        connectCliRemote({
          httpBaseUrl: origin,
          wsBaseUrl: origin.replace(/^http/u, "ws"),
          token: issued.token,
        }),
      ),
      local: true,
    } satisfies ThreadCliTarget;
  });

// ── Connections ───────────────────────────────────────────────────────

/** How long the command keeps reconnecting before it gives up. */
const RECONNECT_WINDOW_MS = 10 * 60_000;

/** The connection dropped under a call, as opposed to an answer the node gave. */
const isConnectionLoss = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error._tag === "RpcClientError" || error._tag === "CliRemoteError");

/**
 * Runs `step` on a connected client. A connection lost after the first connect (a node
 * restart, a network drop) reconnects and runs `step` again, which picks up from the
 * state it keeps outside; a reconnect that fails (the node is still restarting) tries
 * again. The first connect fails at once: nothing is running there.
 */
export const withThreadConnection = <A, E, R>(
  target: ThreadCliTarget,
  step: (client: CliRemoteRpcClient) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    let connectedOnce = false;
    let connecting = false;
    let lostSinceMs: number | null = null;
    let attempt = 0;
    while (true) {
      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            connecting = true;
            const client = yield* target.connect;
            connecting = false;
            connectedOnce = true;
            lostSinceMs = null;
            attempt = 0;
            return yield* step(client);
          }),
        ),
      );
      if (Exit.isSuccess(exit)) return exit.value;
      const error = Cause.findErrorOption(exit.cause);
      const lost = connecting
        ? connectedOnce
        : Option.isSome(error) && isConnectionLoss(error.value);
      if (!lost || Cause.hasInterrupts(exit.cause)) return yield* Effect.failCause(exit.cause);
      const nowMs = yield* Clock.currentTimeMillis;
      lostSinceMs ??= nowMs;
      if (nowMs - lostSinceMs > RECONNECT_WINDOW_MS) {
        return yield* fail("Lost the connection to the node.");
      }
      if (attempt === 0) yield* Console.error("Lost the connection to the node; reconnecting…");
      yield* Effect.sleep(Duration.millis(Math.min(1_000 * 2 ** attempt, 5_000)));
      attempt += 1;
    }
  });

/** An RPC an older node does not have answers "Unknown request tag" as a defect. */
const orUnsupported = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchCause((cause) =>
      isUnsupportedRpcError(Cause.squash(cause))
        ? Effect.succeed(Option.none<A>())
        : Effect.failCause(cause),
    ),
  );

/** What the command remembers across reconnects. */
interface RunTracker {
  facts: RunFacts;
  /** The last orchestration sequence seen for the thread; a resubscribe resumes after it. */
  lastSequence: number | undefined;
  /** When the current subscription's first item arrived; null until it has. */
  streamReadyAtMs: number | null;
  /** The current subscription ended: the node or the connection dropped it. */
  feedEnded: boolean;
  /** The node predates `getThreadShells`: shells come from a shell snapshot. */
  legacyShellReads: boolean;
}

const newTracker = (facts: RunFacts): RunTracker => ({
  facts,
  lastSequence: undefined,
  streamReadyAtMs: null,
  feedEnded: false,
  legacyShellReads: false,
});

/**
 * Fails a wait's check once its event feed has ended, as a lost connection does, so the
 * command reconnects and resubscribes after the last event seen. The RPC client can carry
 * on over a reconnected socket after a quick node restart while the subscription is gone,
 * and the replay of what was missed (a restart's release) only comes with a resubscribe.
 */
const requireLiveFeed = (tracker: RunTracker) =>
  tracker.feedEnded
    ? Effect.fail(new CliRemoteError({ message: "The thread's event feed ended." }))
    : Effect.void;

/**
 * How long after a (re)subscription a run that a later turn replaced still counts as
 * possibly told: the events it missed (its release by a node restart) replay right after
 * the subscription opens, and only they can say how it ended.
 */
const REPLAY_GRACE_MS = 2_000;

const readThreadShell = (client: CliRemoteRpcClient, threadId: ThreadId, tracker: RunTracker) => {
  const fromSnapshot = loadRemoteShell(client).pipe(
    Effect.map((snapshot) => snapshot.threads.find((thread) => thread.id === threadId) ?? null),
  );
  if (tracker.legacyShellReads) return fromSnapshot;
  return orUnsupported(
    client[ORCHESTRATION_WS_METHODS.getThreadShells]({ threadIds: [threadId] }),
  ).pipe(
    Effect.flatMap((result) => {
      if (Option.isSome(result)) {
        return Effect.succeed(
          result.value.threads.find((thread) => thread.id === threadId) ?? null,
        );
      }
      tracker.legacyShellReads = true;
      return fromSnapshot;
    }),
  );
};

/** Enough of the thread's window to subscribe: its recent activities hold a failed start. */
const WATCH_LIMITS = { messages: 1, proposedPlans: 1, activities: 20, checkpoints: 1 } as const;

const observeWindowItem = (
  tracker: RunTracker,
  item: OrchestrationThreadWindowStreamItem,
  nowMs: number,
): boolean => {
  tracker.streamReadyAtMs ??= nowMs;
  if (isUnknownUnionMember(item)) return false;
  if (item.kind === "snapshot") {
    tracker.lastSequence = Math.max(tracker.lastSequence ?? 0, item.snapshot.snapshotSequence);
    tracker.facts = observeQueuedRunWindow(
      item.snapshot.thread.activities.reduce<RunFacts>(
        (facts, activity: OrchestrationThreadActivity) => observeRunActivity(facts, activity),
        tracker.facts,
      ),
      item.snapshot.thread.followUpQueue,
    );
    return true;
  }
  if (item.kind !== "event" || isUnknownUnionMember(item.event)) return false;
  const event = item.event as OrchestrationEvent;
  tracker.lastSequence = Math.max(tracker.lastSequence ?? 0, event.sequence);
  tracker.facts = observeRunEvent(tracker.facts, event);
  return wakesRun(event);
};

/**
 * The thread's live events, folded into the tracker; a relevant one wakes the wait. A
 * resubscribe resumes after the last event seen, so events missed while disconnected
 * replay (an older node, or one that no longer holds them, sends a fresh window).
 */
const threadEventSource = (
  client: CliRemoteRpcClient,
  threadId: ThreadId,
  tracker: RunTracker,
): WaitWakeSource =>
  wakeOnStream(
    Effect.sync(() => {
      tracker.streamReadyAtMs = null;
      tracker.feedEnded = false;
      return client[ORCHESTRATION_WS_METHODS.subscribeThreadWindow]({
        threadId,
        limits: WATCH_LIMITS,
        historyRecovery: "passive",
        activityPayloads: "preview",
        ...(tracker.lastSequence === undefined ? {} : { resumeFromSequence: tracker.lastSequence }),
      }).pipe(
        Stream.mapEffect((item) =>
          Effect.map(Clock.currentTimeMillis, (nowMs) => observeWindowItem(tracker, item, nowMs)),
        ),
        // However the feed ends, the wait wakes and its check reconnects (`requireLiveFeed`).
        Stream.catchCause(() => Stream.empty),
        Stream.concat(
          Stream.fromEffect(
            Effect.sync(() => {
              tracker.feedEnded = true;
              return true;
            }),
          ),
        ),
      );
    }),
    (relevant) => relevant,
  );

// ── Waiting for a run ─────────────────────────────────────────────────

const remainingMs = (deadlineMs: number) =>
  Effect.map(Clock.currentTimeMillis, (nowMs) => Math.max(0, deadlineMs - nowMs));

const REPLY_PAGE_MESSAGES = 50;
const REPLY_PAGES_MAX = 4;

/** The reply the turn ended on (`selectTurnReplyMessage`), searched from the newest page. */
const readTurnReply = (client: CliRemoteRpcClient, threadId: ThreadId, turnId: TurnId) =>
  Effect.gen(function* () {
    const window = yield* client[ORCHESTRATION_WS_METHODS.getThreadWindow]({
      threadId,
      limits: { messages: REPLY_PAGE_MESSAGES, proposedPlans: 1, activities: 1, checkpoints: 1 },
    });
    let messages = window.thread.messages;
    let page = window.history.messages;
    for (let pages = 1; ; pages += 1) {
      const reply = selectTurnReplyMessage(messages, turnId);
      if (reply !== undefined) return reply.text.trim().length > 0 ? reply.text : null;
      if (!page.hasMoreBefore || page.oldestCursor === null || pages >= REPLY_PAGES_MAX) {
        return null;
      }
      const older = yield* client[ORCHESTRATION_WS_METHODS.getThreadHistoryPage]({
        threadId,
        collection: "messages",
        mode: { kind: "before", cursor: page.oldestCursor },
        limit: REPLY_PAGE_MESSAGES,
      });
      if (older.collection !== "messages") return null;
      messages = older.items;
      page = older.page;
    }
  });

/**
 * Why the follow-up queue keeps the message `send` queued from going out by itself, or null.
 * The shell's summary says when the queue is held or its head waits for Retry; the thread's
 * queue then confirms the message still waits in it (the node may have just sent it).
 */
const queuedRunHold = (
  client: CliRemoteRpcClient,
  threadId: ThreadId,
  shell: OrchestrationThreadShell,
  facts: RunFacts,
) =>
  Effect.gen(function* () {
    const summary = shell.followUpQueueSummary;
    if (
      facts.messageId === null ||
      !waitsInFollowUpQueue(facts) ||
      summary === undefined ||
      followUpQueueBlocker(summary, heldOnlyForDelegationSlot) === null
    ) {
      return null;
    }
    const window = yield* client[ORCHESTRATION_WS_METHODS.getThreadWindow]({
      threadId,
      limits: { messages: 1, proposedPlans: 1, activities: 1, checkpoints: 1 },
    });
    return queuedMessageBlocker(
      window.thread.followUpQueue,
      facts.messageId,
      heldOnlyForDelegationSlot,
    );
  });

/** {@link queuedRunLeftUnseen} from the thread's newest page of messages. */
const queuedRunLeftUnseenFromWindow = (
  client: CliRemoteRpcClient,
  threadId: ThreadId,
  shell: OrchestrationThreadShell,
  messageId: MessageId,
) =>
  client[ORCHESTRATION_WS_METHODS.getThreadWindow]({
    threadId,
    limits: { messages: REPLY_PAGE_MESSAGES, proposedPlans: 1, activities: 1, checkpoints: 1 },
  }).pipe(
    Effect.map((window) =>
      queuedRunLeftUnseen(
        shell,
        messageId,
        window.thread.messages,
        !window.history.messages.hasMoreBefore,
      ),
    ),
  );

/**
 * Follows the tracker's run until it ends (`ended`) or, for a command without `--wait`,
 * until its turn has started (`started`), or the deadline passes.
 */
const followRun = (
  client: CliRemoteRpcClient,
  threadId: ThreadId,
  tracker: RunTracker,
  options: { readonly until: "started" | "ended"; readonly deadlineMs: number },
) =>
  Effect.gen(function* () {
    const { value, timedOut } = yield* waitUntil({
      sources: [threadEventSource(client, threadId, tracker)],
      timeoutMs: yield* remainingMs(options.deadlineMs),
      check: Effect.gen(function* () {
        yield* requireLiveFeed(tracker);
        const shell = yield* readThreadShell(client, threadId, tracker);
        let evaluation: RunEvaluation = evaluateRun(shell, tracker.facts);
        if (
          !evaluation.done &&
          evaluation.turnId === null &&
          shell !== null &&
          tracker.facts.queueLeftUnseen === true &&
          tracker.facts.messageId !== null
        ) {
          const left = yield* queuedRunLeftUnseenFromWindow(
            client,
            threadId,
            shell,
            tracker.facts.messageId,
          );
          if (typeof left === "string") {
            tracker.facts = { ...tracker.facts, turnId: left };
            evaluation = evaluateRun(shell, tracker.facts);
          } else if (left !== null) {
            evaluation = left;
          }
        }
        if (!evaluation.done && evaluation.turnId === null && shell !== null) {
          const held = yield* queuedRunHold(client, threadId, shell, tracker.facts);
          if (held !== null) evaluation = { done: true, state: "held", turnId: null, error: held };
        }
        if (evaluation.turnId !== null && tracker.facts.turnId === null) {
          tracker.facts = { ...tracker.facts, turnId: evaluation.turnId };
        }
        const nowMs = yield* Clock.currentTimeMillis;
        const ended =
          evaluation.done &&
          (evaluation.state !== "unknown" ||
            (tracker.streamReadyAtMs !== null &&
              nowMs - tracker.streamReadyAtMs >= REPLAY_GRACE_MS));
        const done = ended || (options.until === "started" && evaluation.turnId !== null);
        return { done, value: { evaluation, ended } };
      }),
    });
    const { evaluation, ended } = value;
    const base = { threadId, turnId: evaluation.turnId, reply: null, error: null };
    if (!ended || !evaluation.done) {
      if (timedOut && waitsInFollowUpQueue(tracker.facts)) {
        return {
          ...base,
          state: "timed-out",
          error: "Timed out; the message is still queued and goes out when the thread is free.",
        } satisfies RunResult;
      }
      return { ...base, state: timedOut ? "timed-out" : "started" } satisfies RunResult;
    }
    const reply =
      evaluation.state === "completed" && evaluation.turnId !== null
        ? yield* readTurnReply(client, threadId, evaluation.turnId)
        : null;
    return { ...base, state: evaluation.state, reply, error: evaluation.error } satisfies RunResult;
  });

// ── Commands ──────────────────────────────────────────────────────────

const decodeThreadId = (value: string) => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Effect.succeed(ThreadId.make(trimmed)) : fail("Pass a thread id.");
};

/** The message as it is sent, composed like every app composes one; `-` reads stdin. */
export const readPrompt = (value: string, fromStdin = true) =>
  Effect.gen(function* () {
    const raw =
      fromStdin && value === "-"
        ? yield* Effect.tryPromise({
            try: async () => {
              const chunks: Buffer[] = [];
              for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
              return Buffer.concat(chunks).toString("utf8");
            },
            catch: (cause) => new ThreadCliError({ message: "Could not read stdin.", cause }),
          })
        : value;
    const text = composeOutgoingPrompt({ prompt: raw });
    if (text.length === 0) return yield* fail("The message is empty.");
    const overflow = outgoingPromptOverflow({ prompt: raw });
    if (overflow > 0) return yield* fail(`The message is ${overflow} characters too long.`);
    return text;
  });

/** Every project of the node, from the head of a paged shell snapshot (its threads are not read). */
const loadProjects = (client: CliRemoteRpcClient) =>
  client[ORCHESTRATION_WS_METHODS.subscribeShell]({
    snapshotDelivery: "paged",
    archivedThreads: "stub",
  }).pipe(
    Stream.map((item): ReadonlyArray<OrchestrationProjectShell> | null =>
      isUnknownUnionMember(item)
        ? null
        : item.kind === "snapshot-begin"
          ? item.projects
          : item.kind === "snapshot"
            ? item.snapshot.projects
            : null,
    ),
    Stream.filter((projects) => projects !== null),
    Stream.runHead,
    Effect.flatMap((projects) =>
      Option.isSome(projects)
        ? Effect.succeed(projects.value)
        : fail("The node closed the connection before sending its projects."),
    ),
  );

const realPath = (value: string) => {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
};

/**
 * `--project` as a path on this machine, or null when it is no path: one that exists, or
 * one that is written as a path (`.`, `..`, `/…`, `./…`, `../…`, `~/…`). Anything else is
 * an id, so a mistyped id never falls back to the project around the current directory.
 */
export const localProjectPath = (
  identifier: string,
  options: {
    readonly cwd: string;
    readonly home: string;
    readonly exists: (path: string) => boolean;
  },
): string | null => {
  const expanded =
    identifier === "~" || identifier.startsWith("~/")
      ? path.join(options.home, identifier.slice(1))
      : identifier;
  const resolved = path.resolve(options.cwd, expanded);
  const writtenAsPath =
    expanded !== identifier ||
    identifier === "." ||
    identifier === ".." ||
    path.isAbsolute(identifier) ||
    identifier.startsWith("./") ||
    identifier.startsWith("../");
  return writtenAsPath || options.exists(resolved) ? resolved : null;
};

const resolveProject = (
  projects: ReadonlyArray<OrchestrationProjectShell>,
  identifier: string,
  local: boolean,
) => {
  const localPath = local
    ? localProjectPath(identifier, { cwd: process.cwd(), home: homedir(), exists: existsSync })
    : null;
  // Stored roots keep the path a project was added with, which may pass through a symlink.
  const target = local
    ? localPath === null
      ? null
      : realPath(localPath)
    : path.isAbsolute(identifier)
      ? path.normalize(identifier)
      : null;
  const project = findProject(
    projects,
    identifier,
    target,
    local ? (candidate) => realPath(candidate.workspaceRoot) : undefined,
  );
  return project === null
    ? fail(`No project matches "${identifier}". Pass a project id or a path inside a project.`)
    : Effect.succeed(project);
};

/** The project's effective creation preferences, resolved here for a node that predates the RPC. */
const readProjectPreferences = (
  client: CliRemoteRpcClient,
  project: OrchestrationProjectShell,
  settings: ServerSettings,
) =>
  orUnsupported(client[WS_METHODS.serverGetProjectPreferences]({ projectId: project.id })).pipe(
    Effect.map((preferences) =>
      Option.getOrElse(preferences, (): EffectiveProjectPreferences =>
        resolveProjectPreferences({ settings, project }),
      ),
    ),
  );

/** Messages read to find a new thread's first one. */
const FIRST_MESSAGES = 10;

/** Whether the thread holds the message: a turn start the node accepted records it. */
const threadHoldsMessage = (client: CliRemoteRpcClient, threadId: ThreadId, messageId: MessageId) =>
  client[ORCHESTRATION_WS_METHODS.getThreadWindow]({
    threadId,
    limits: { messages: FIRST_MESSAGES, proposedPlans: 1, activities: 1, checkpoints: 1 },
  }).pipe(
    Effect.map((window) => window.thread.messages.some((message) => message.id === messageId)),
  );

export interface StartThreadInput {
  readonly project: string;
  readonly prompt: string;
  readonly title: string | null;
  readonly model: string | null;
  readonly runtimeMode: RuntimeMode | null;
  readonly wait: boolean;
  readonly deadlineMs: number;
}

/**
 * Creates a thread in the project and starts its first turn, with the project's default
 * model, runtime mode and checkout (a new worktree when the project's threads start in
 * one), as a new thread from the apps starts.
 */
export const startThread = (target: ThreadCliTarget, input: StartThreadInput) => {
  const threadId = ThreadId.make(crypto.randomUUID());
  const messageId = MessageId.make(crypto.randomUUID());
  const tracker = newTracker(initialRunFacts({ messageId }));
  let phase: "prepare" | "dispatching" | "dispatched" = "prepare";
  return withThreadConnection(target, (client) =>
    Effect.gen(function* () {
      if (phase === "dispatching") {
        // The connection dropped while the node created the thread and sent its first
        // message. The message is on the thread only once its turn start was accepted.
        const sent =
          (yield* readThreadShell(client, threadId, tracker)) !== null &&
          (yield* threadHoldsMessage(client, threadId, messageId));
        if (!sent) {
          return yield* fail(
            "The connection dropped before the node started the thread's first turn. Nothing was started.",
          );
        }
        phase = "dispatched";
        tracker.facts = { ...tracker.facts, pendingMessageId: messageId };
      }
      if (phase === "prepare") {
        const runtime = resolveStartRuntimeMode(input.runtimeMode);
        if ("error" in runtime) return yield* fail(runtime.error);
        const projects = yield* loadProjects(client);
        const project = yield* resolveProject(projects, input.project, target.local);
        const settings = yield* client[WS_METHODS.serverGetSettings]({});
        const preferences = yield* readProjectPreferences(client, project, settings);
        const model = resolveStartModel(input.model, preferences.initialModelSelection.value);
        if ("error" in model) return yield* fail(model.error);
        const createdAt = new Date().toISOString();
        const titleSeed = threadTitleFromPrompt(input.prompt);
        const title = input.title?.trim() || titleSeed;
        const command = buildTurnStartCommand({
          commandId: CommandId.make(`cli-thread-start:${threadId}`),
          threadId,
          messageId,
          text: input.prompt,
          attachments: [],
          modelSelection: model.modelSelection,
          // Differs from an explicit --title, so the node keeps that title.
          titleSeed,
          runtimeMode: runtime.runtimeMode,
          interactionMode: "default",
          tokenMode: settings.defaultAgentTokenMode,
          bootstrap: buildSendTurnBootstrap({
            isLocalDraftThread: true,
            // The project's checkout as it is now, like an app's new-worktree thread.
            // A chat's folder is a plain directory, never a worktree.
            baseBranchForWorktree:
              preferences.defaultThreadEnvMode.value === "worktree" && !isChatProject(project)
                ? "HEAD"
                : null,
            shouldMaterializeLegacyBranchWorktree: false,
            worktreeBranchPrefix: preferences.worktreeBranchPrefix.value,
            projectId: project.id,
            projectCwd: project.workspaceRoot,
            title,
            threadCreateModelSelection: model.modelSelection,
            runtimeMode: runtime.runtimeMode,
            interactionMode: "default",
            tokenMode: settings.defaultAgentTokenMode,
            activeThreadBranch: null,
            worktreePath: null,
            threadCreatedAt: createdAt,
          }),
          createdAt,
        });
        phase = "dispatching";
        const dispatched = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](command);
        phase = "dispatched";
        // The turn start went out with the command; the events after it bind its turn.
        tracker.lastSequence = dispatched.sequence;
        tracker.facts = { ...tracker.facts, pendingMessageId: messageId };
      }
      return yield* followRun(client, threadId, tracker, {
        until: input.wait ? "ended" : "started",
        deadlineMs: input.deadlineMs,
      });
    }),
  );
};

export interface SendToThreadInput {
  readonly threadId: string;
  readonly prompt: string;
  readonly wait: boolean;
  readonly deadlineMs: number;
}

/** Whether the node keeps follow-up queues itself (`thread.queue.*`), as its descriptor says. */
const readServerFollowUpQueue = (client: CliRemoteRpcClient) =>
  Effect.map(client[WS_METHODS.serverGetConfig]({}), selectServerFollowUpQueueSupported);

/**
 * Queues the message at the end of the thread's follow-up queue on the node, with the thread's
 * own model and modes, as the apps queue a send while the thread is busy: the node sends it at
 * the next idle moment, after the follow-ups queued before it. The add is idempotent on the
 * message id, so sending it again after a lost reply never queues it twice.
 */
const queueOnNode = (
  client: CliRemoteRpcClient,
  threadId: ThreadId,
  messageId: MessageId,
  prompt: string,
  tracker: RunTracker,
) =>
  Effect.gen(function* () {
    const shell = yield* readThreadShell(client, threadId, tracker);
    if (shell === null) return yield* fail("The thread was not found.");
    if (shell.archivedAt !== null) return yield* fail("The thread is archived.");
    const result = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](
      buildFollowUpQueueAddCommand({
        commandId: CommandId.make(`cli-thread-send:${messageId}`),
        threadId,
        messageId,
        content: {
          text: prompt,
          attachments: [],
          modelSelection: shell.modelSelection,
          runtimeMode: shell.runtimeMode,
          interactionMode: shell.interactionMode,
          tokenMode: shell.tokenMode,
        },
        createdAt: new Date().toISOString(),
      }),
    );
    // The node sends it later: the events after the add bind its turn.
    tracker.lastSequence = Math.max(tracker.lastSequence ?? 0, result.sequence);
  });

/**
 * Queues a message behind the thread's running turn: it starts as a later turn, with the
 * thread's own model and modes, as the apps' follow-up queue sends it. It never steers the
 * running turn. A node that keeps follow-up queues holds it in the thread's queue, behind the
 * follow-ups queued before it (`queueOnNode`); an older node gets a turn start from here once
 * the thread is idle.
 */
export const sendToThread = (target: ThreadCliTarget, input: SendToThreadInput) =>
  Effect.gen(function* () {
    const threadId = yield* decodeThreadId(input.threadId);
    const messageId = MessageId.make(crypto.randomUUID());
    const tracker = newTracker(initialRunFacts({ messageId }));
    /** Read on the first connect, so a reconnect never changes how the message was sent. */
    let serverQueue: boolean | null = null;
    // A refused start records its command id as rejected: each new try needs its own.
    let attempt = 0;
    let dispatching = false;
    let dispatched = false;
    return yield* withThreadConnection(target, (client) =>
      Effect.gen(function* () {
        if (serverQueue === null) {
          serverQueue = yield* readServerFollowUpQueue(client);
          if (serverQueue) tracker.facts = initialRunFacts({ messageId, queued: true });
        }
        if (serverQueue && !dispatched) {
          yield* queueOnNode(client, threadId, messageId, input.prompt, tracker);
          dispatched = true;
        }
        while (!dispatched) {
          let shell: OrchestrationThreadShell | null = null;
          if (!dispatching) {
            const gate = yield* waitUntil({
              sources: [threadEventSource(client, threadId, tracker)],
              timeoutMs: yield* remainingMs(input.deadlineMs),
              check: Effect.gen(function* () {
                yield* requireLiveFeed(tracker);
                const value = queueGate(yield* readThreadShell(client, threadId, tracker));
                return { done: value.kind !== "wait", value };
              }),
            });
            if (gate.value.kind === "unavailable") return yield* fail(gate.value.reason);
            if (gate.value.kind === "wait") {
              return {
                threadId,
                turnId: null,
                state: "timed-out",
                reply: null,
                error: null,
              } satisfies RunResult;
            }
            shell = gate.value.shell;
          } else {
            // Reconnected mid-dispatch: the same command again is answered from its receipt.
            shell = yield* readThreadShell(client, threadId, tracker);
            if (shell === null) return yield* fail("The thread was not found.");
          }
          const command = buildTurnStartCommand({
            commandId: CommandId.make(`cli-thread-send:${messageId}:${attempt}`),
            threadId,
            messageId,
            text: input.prompt,
            attachments: [],
            modelSelection: shell.modelSelection,
            titleSeed: threadTitleFromPrompt(input.prompt),
            runtimeMode: shell.runtimeMode,
            interactionMode: shell.interactionMode,
            tokenMode: shell.tokenMode,
            createdAt: new Date().toISOString(),
          });
          dispatching = true;
          const result = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](command).pipe(
            Effect.map(Option.some),
            Effect.catchIf(isBusyTurnStartRejection, () => Effect.succeed(Option.none())),
          );
          dispatching = false;
          if (Option.isNone(result)) {
            attempt += 1;
            continue;
          }
          dispatched = true;
          // Its own turn start is the latest one held as of its sequence; anything later
          // replays after it (the next subscription resumes from here).
          tracker.lastSequence = Math.max(tracker.lastSequence ?? 0, result.value.sequence);
          tracker.facts = { ...tracker.facts, pendingMessageId: messageId };
        }
        return yield* followRun(client, threadId, tracker, {
          until: input.wait ? "ended" : "started",
          deadlineMs: input.deadlineMs,
        });
      }),
    );
  });

export interface WaitForThreadInput {
  readonly threadId: string;
  readonly turnId: string | null;
  readonly deadlineMs: number;
}

/** Waits for the given turn, else the thread's running (or latest) turn, to end. */
export const waitForThread = (target: ThreadCliTarget, input: WaitForThreadInput) =>
  Effect.gen(function* () {
    const threadId = yield* decodeThreadId(input.threadId);
    const tracker = newTracker(
      initialRunFacts(input.turnId === null ? {} : { turnId: TurnId.make(input.turnId.trim()) }),
    );
    let resolved = input.turnId !== null;
    return yield* withThreadConnection(target, (client) =>
      Effect.gen(function* () {
        if (!resolved) {
          const shell = yield* readThreadShell(client, threadId, tracker);
          if (shell === null) return yield* fail(`No thread ${threadId}.`);
          const facts = latestRunFacts(shell);
          if (facts === null) return yield* fail(`Thread ${threadId} has not run a turn yet.`);
          tracker.facts = facts;
          resolved = true;
        }
        return yield* followRun(client, threadId, tracker, {
          until: "ended",
          deadlineMs: input.deadlineMs,
        });
      }),
    );
  });

/**
 * The thread's latest messages and its follow-up queue, as `ryco_read_thread` returns its first
 * page. `wholeMessages` prints every message whole instead of cutting a long one with a
 * continuation: the node sends them whole, so there is nothing to read on.
 */
export const readThread = (
  target: ThreadCliTarget,
  input: {
    readonly threadId: string;
    readonly limit: number | undefined;
    readonly wholeMessages: boolean;
    readonly transcript: ThreadCliTranscript;
  },
) =>
  Effect.gen(function* () {
    const threadId = yield* decodeThreadId(input.threadId);
    const limit = input.transcript.readThreadMessageLimit(
      input.limit === undefined ? undefined : Math.max(1, input.limit),
    );
    return yield* withThreadConnection(target, (client) =>
      client[ORCHESTRATION_WS_METHODS.getThreadWindow]({
        threadId,
        limits: { messages: limit, proposedPlans: 1, activities: 1, checkpoints: 1 },
      }).pipe(
        Effect.flatMap((window) =>
          input.transcript.toReadThreadResult({
            shell: window.thread,
            messages: window.thread.messages,
            pageInfo: window.history.messages,
            followUpQueue: window.thread.followUpQueue,
            wholeMessages: input.wholeMessages,
          }),
        ),
      ),
    );
  });

// ── The CLI entry ─────────────────────────────────────────────────────

export type ThreadCliCommand =
  | {
      readonly kind: "start";
      readonly project: string;
      readonly prompt: string;
      readonly title: Option.Option<string>;
      readonly model: Option.Option<string>;
      readonly runtimeMode: Option.Option<RuntimeMode>;
      readonly wait: boolean;
      readonly timeout: Option.Option<Duration.Duration>;
    }
  | {
      readonly kind: "send";
      readonly threadId: string;
      readonly prompt: string;
      /** `ryco remote send`: `-` is the message itself, as it always was there. */
      readonly literalPrompt?: boolean;
      readonly wait: boolean;
      readonly timeout: Option.Option<Duration.Duration>;
    }
  | {
      readonly kind: "wait";
      readonly threadId: string;
      readonly turnId: Option.Option<string>;
      readonly timeout: Option.Option<Duration.Duration>;
    }
  | {
      readonly kind: "read";
      readonly threadId: string;
      readonly limit: Option.Option<number>;
      /** Under `--json`, every message whole too (the text output always prints them so). */
      readonly full: boolean;
    };

export interface ThreadCliContext<E, R, EL, RL, EA, RA> {
  readonly json: boolean;
  /** `--remote <name>`; this machine's node when none. */
  readonly remote: Option.Option<string>;
  readonly loadRemote: (name: string) => Effect.Effect<CliRemote, E, R>;
  /** This machine's node, found as the other local-node commands find it; run only for it. */
  readonly local: Effect.Effect<ThreadCliLocal<EA, RA>, EL, RL>;
  readonly transcript: ThreadCliTranscript;
}

const deadlineFor = (timeout: Option.Option<Duration.Duration>) =>
  Option.match(timeout, {
    onNone: () => Effect.succeed(Number.POSITIVE_INFINITY),
    onSome: (duration) =>
      Effect.map(Clock.currentTimeMillis, (nowMs) => nowMs + Duration.toMillis(duration)),
  });

/**
 * Runs one `ryco thread` command: prints its result (stdout) and what a person should know
 * (stderr), and sets the exit code a script reads (see `runExitCode`).
 */
export const runThreadCli = <E, R, EL, RL, EA, RA>(
  command: ThreadCliCommand,
  context: ThreadCliContext<E, R, EL, RL, EA, RA>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const target = Option.isSome(context.remote)
        ? remoteThreadTarget(yield* context.loadRemote(context.remote.value))
        : yield* localThreadTarget({
            local: yield* context.local,
            timeout: command.kind === "read" ? null : Option.getOrNull(command.timeout),
          });
      if (command.kind === "read") {
        const page = yield* readThread(target, {
          transcript: context.transcript,
          threadId: command.threadId,
          limit: Option.getOrUndefined(command.limit),
          // `--json` keeps `ryco_read_thread`'s page, a long message cut with its continuation.
          wholeMessages: !context.json || command.full,
        });
        yield* Console.log(context.json ? JSON.stringify(page) : formatTranscript(page));
        return;
      }
      const deadlineMs = yield* deadlineFor(command.timeout);
      const result =
        command.kind === "start"
          ? yield* startThread(target, {
              project: command.project,
              prompt: yield* readPrompt(command.prompt),
              title: Option.getOrNull(command.title),
              model: Option.getOrNull(command.model),
              runtimeMode: Option.getOrNull(command.runtimeMode),
              wait: command.wait,
              deadlineMs,
            })
          : command.kind === "send"
            ? yield* sendToThread(target, {
                threadId: command.threadId,
                prompt: yield* readPrompt(command.prompt, command.literalPrompt !== true),
                wait: command.wait,
                deadlineMs,
              })
            : yield* waitForThread(target, {
                threadId: command.threadId,
                turnId: Option.getOrNull(command.turnId),
                deadlineMs,
              });
      const output = formatRunResult(result, {
        json: context.json,
        startedId: command.kind === "start" ? "thread" : "turn",
      });
      if (output !== null) yield* Console.log(output);
      const note = describeRunResult(result);
      if (note !== null) yield* Console.error(note);
      yield* Effect.sync(() => {
        process.exitCode = runExitCode(result.state);
      });
    }),
  );
