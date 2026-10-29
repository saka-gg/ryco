import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { NetService } from "@ryco/shared/Net";
import { TurnId } from "@ryco/contracts";
import { ORPHANED_PROVIDER_SESSION_ERROR } from "@ryco/shared/restartContinuation";
import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Layer, Queue, References, Stream } from "effect";
import { Command } from "effect/cli";
import { TestClock, TestConsole } from "effect/testing";

import { AuthControlPlaneRuntimeLive } from "../auth/Layers/AuthControlPlane.ts";
import { AuthControlPlane } from "../auth/Services/AuthControlPlane.ts";
import { cli } from "../cli.ts";
import type { CliRemoteRpcClient } from "../cliRemote/remotes.ts";
import { deriveServerPaths, ServerConfig, type ServerConfigShape } from "../config.ts";
import {
  localProjectPath,
  localThreadTarget,
  readPrompt,
  sendToThread,
  startThread,
  ThreadCliError,
  waitForThread,
  type ThreadCliTarget,
} from "./threadCommands.ts";
import { runExitCode, type RunResult } from "./threadRun.ts";

const AT = "2026-10-28T10:00:00.000Z";
const LATER = "2026-10-28T10:05:00.000Z";
const THREAD = "thread-1";

/** What a dropped socket fails the client's calls with. */
class SocketClosed extends Error {
  readonly _tag = "RpcClientError";
}

type Json = Record<string, unknown>;

const session = (
  status: string,
  activeTurnId: string | null = null,
  extra: { readonly lastError?: string; readonly updatedAt?: string } = {},
) => ({
  threadId: THREAD,
  status,
  providerName: "codex",
  runtimeMode: "auto",
  activeTurnId,
  lastError: extra.lastError ?? null,
  updatedAt: extra.updatedAt ?? AT,
});

const turn = (turnId: string, state: string, userMessageId?: string) => ({
  turnId,
  state,
  requestedAt: AT,
  startedAt: AT,
  completedAt: state === "running" ? null : LATER,
  assistantMessageId: null,
  ...(userMessageId === undefined ? {} : { userMessageId }),
});

const baseShell = (id: string, extra: Json = {}): Json => ({
  id,
  projectId: "project-1",
  title: "Thread",
  modelSelection: { instanceId: "codex", model: "gpt-5.5" },
  runtimeMode: "auto",
  interactionMode: "plan",
  tokenMode: "off",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: AT,
  updatedAt: AT,
  archivedAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...extra,
});

/**
 * One node serving one thread over the fake RPC client: its shell, its message history
 * and its event log. Events published while the node is offline are only logged; a
 * resubscribe that resumes after a sequence replays them.
 */
const makeNode = Effect.sync(() => {
  const node = {
    shell: null as Json | null,
    messages: [] as Json[],
    log: [] as Json[],
    sequence: 100,
    online: true,
    subscribers: new Set<Queue.Queue<unknown, SocketClosed | Cause.Done>>(),
    resumes: [] as Array<number | undefined>,
    dispatched: [] as Json[],
    connects: 0,
    projects: [
      { id: "project-1", title: "App", workspaceRoot: "/work/app", scripts: [] },
    ] as Json[],
    /** Answers a turn start; defaults to accepting it. */
    onDispatch: (_command: Json): Error | null => null,
  };
  const publish = (type: string, payload: Json) => {
    node.sequence += 1;
    const event = {
      sequence: node.sequence,
      eventId: `event-${node.sequence}`,
      aggregateKind: "thread",
      aggregateId: THREAD,
      occurredAt: AT,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type,
      payload,
    };
    node.log.push(event);
    if (node.online) {
      for (const queue of node.subscribers) Queue.offerUnsafe(queue, { kind: "event", event });
    }
  };
  const drop = Effect.gen(function* () {
    node.online = false;
    for (const queue of node.subscribers) yield* Queue.fail(queue, new SocketClosed("closed"));
    node.subscribers.clear();
  });
  /** A quick restart under a reconnecting socket: the feeds end, reads keep working. */
  const endFeeds = Effect.gen(function* () {
    for (const queue of node.subscribers) yield* Queue.end(queue);
    node.subscribers.clear();
  });
  const offline = <A>(value: () => A) =>
    Effect.suspend(() =>
      node.online ? Effect.succeed(value()) : Effect.fail(new SocketClosed("closed")),
    );
  const client = {
    "orchestration.getThreadShells": () =>
      offline(() => ({
        snapshotSequence: node.sequence,
        threads: node.shell === null ? [] : [node.shell],
        remainingThreadIds: [],
      })),
    "orchestration.subscribeThreadWindow": (input: { readonly resumeFromSequence?: number }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (!node.online) return Stream.fail(new SocketClosed("closed"));
          const queue = yield* Queue.unbounded<unknown, SocketClosed | Cause.Done>();
          node.resumes.push(input.resumeFromSequence);
          if (input.resumeFromSequence === undefined) {
            Queue.offerUnsafe(queue, {
              kind: "snapshot",
              snapshot: {
                snapshotSequence: node.sequence,
                thread: { ...node.shell, messages: [], activities: [] },
                history: {},
              },
            });
          } else {
            Queue.offerUnsafe(queue, { kind: "resumed", fromSequence: input.resumeFromSequence });
            for (const event of node.log) {
              if ((event.sequence as number) > input.resumeFromSequence) {
                Queue.offerUnsafe(queue, { kind: "event", event });
              }
            }
          }
          node.subscribers.add(queue);
          return Stream.fromQueue(queue);
        }),
      ),
    "orchestration.dispatchCommand": (command: Json) =>
      Effect.suspend(() => {
        if (!node.online) return Effect.fail(new SocketClosed("closed"));
        node.dispatched.push(command);
        const refusal = node.onDispatch(command);
        if (refusal !== null) return Effect.fail(refusal);
        const message = command.message as Json;
        publish("thread.turn-start-requested", {
          threadId: command.threadId,
          messageId: message.messageId,
          createdAt: AT,
        });
        return Effect.succeed({ sequence: node.sequence });
      }),
    "orchestration.getThreadWindow": () =>
      offline(() => ({
        snapshotSequence: node.sequence,
        thread: { ...node.shell, messages: node.messages, activities: [] },
        history: {
          messages: { oldestCursor: null, newestCursor: null, hasMoreBefore: false },
        },
      })),
    "orchestration.subscribeShell": () =>
      Stream.make({
        kind: "snapshot-begin",
        snapshotSequence: node.sequence,
        updatedAt: AT,
        projects: node.projects,
        threadCount: 0,
        archivedThreadCount: 0,
      }),
    "server.getSettings": () => offline(() => ({ defaultAgentTokenMode: "balanced" })),
    "server.getProjectPreferences": () =>
      offline(() => ({
        initialModelSelection: {
          value: { instanceId: "claudeAgent", model: "claude-opus", options: [] },
          source: "project",
        },
        defaultThreadEnvMode: { value: "worktree", source: "project" },
        worktreeBranchPrefix: { value: "ryco", source: "node" },
        runSetupScript: { value: true, source: "node" },
        worktreeRoot: { value: "", source: "builtin" },
        overrides: {},
      })),
  } as unknown as CliRemoteRpcClient;
  const target: ThreadCliTarget = {
    connect: Effect.suspend(() => {
      // A restarting node has no runtime state file yet: this machine's target says so.
      if (!node.online) {
        return Effect.fail(new ThreadCliError({ message: "The Ryco server is not running." }));
      }
      node.connects += 1;
      return Effect.succeed(client);
    }),
    local: false,
  };
  return { node, publish, drop, endFeeds, target };
});

/** Lets the command's fibers run, and its waits re-check, for `seconds` of test time. */
const advance = (seconds = 3) =>
  Effect.gen(function* () {
    for (let second = 0; second < seconds * 4; second += 1) {
      for (let turnIndex = 0; turnIndex < 20; turnIndex += 1) yield* Effect.yieldNow;
      yield* TestClock.adjust("250 millis");
    }
  });

const releasedSessionSet = (
  status: string,
  turnId: string,
  state: "completed" | "error" | "interrupted",
  lastError?: string,
) => ({
  threadId: THREAD,
  session: session(status, null, {
    updatedAt: LATER,
    ...(lastError === undefined ? {} : { lastError }),
  }),
  releasedTurn: { turnId, state, completedAt: LATER, reason: "test" },
});

describe("ryco thread send", () => {
  it.effect("queues behind the running turn and waits for its own turn's reply", () =>
    Effect.gen(function* () {
      const { node, publish, target } = yield* makeNode;
      node.shell = baseShell(THREAD, {
        session: session("running", "turn-earlier"),
        latestTurn: turn("turn-earlier", "running"),
      });
      const fiber = yield* Effect.forkChild(
        sendToThread(target, {
          threadId: THREAD,
          prompt: "Then run the tests",
          wait: true,
          deadlineMs: Number.POSITIVE_INFINITY,
        }),
      );
      yield* advance();
      assert.lengthOf(node.dispatched, 0, "nothing is sent while a turn runs");

      node.shell = baseShell(THREAD, {
        session: session("ready", null, { updatedAt: LATER }),
        latestTurn: turn("turn-earlier", "completed"),
      });
      publish("thread.session-set", releasedSessionSet("ready", "turn-earlier", "completed"));
      yield* advance();
      assert.lengthOf(node.dispatched, 1);
      const command = node.dispatched[0]!;
      // A plain turn start with the thread's own model and modes: never a steer.
      assert.deepInclude(command, {
        type: "thread.turn.start",
        threadId: THREAD,
        runtimeMode: "auto",
        interactionMode: "plan",
        tokenMode: "off",
        modelSelection: { instanceId: "codex", model: "gpt-5.5" },
      });
      assert.strictEqual((command.message as Json).text, "Then run the tests");
      // The earlier turn's end did not end this wait.
      assert.isUndefined(fiber.pollUnsafe());

      const messageId = (command.message as Json).messageId as string;
      node.shell = baseShell(THREAD, {
        session: session("running", "turn-ours"),
        latestTurn: turn("turn-ours", "running", messageId),
      });
      publish("thread.session-set", { threadId: THREAD, session: session("running", "turn-ours") });
      yield* advance();
      assert.isUndefined(fiber.pollUnsafe());

      node.messages = [
        {
          id: "assistant-1",
          role: "assistant",
          text: "All tests pass.",
          turnId: "turn-ours",
          streaming: false,
          createdAt: LATER,
          updatedAt: LATER,
        },
      ];
      node.shell = baseShell(THREAD, {
        session: session("ready", null, { updatedAt: LATER }),
        latestTurn: turn("turn-ours", "completed", messageId),
      });
      publish("thread.session-set", releasedSessionSet("ready", "turn-ours", "completed"));
      yield* advance();
      const result = yield* Fiber.join(fiber);
      assert.deepEqual(result, {
        threadId: THREAD,
        turnId: "turn-ours",
        state: "completed",
        reply: "All tests pass.",
        error: null,
      } as RunResult);
    }),
  );

  it.effect("queues again when another turn starts first", () =>
    Effect.gen(function* () {
      const { node, publish, target } = yield* makeNode;
      node.shell = baseShell(THREAD, { session: session("ready"), latestTurn: null });
      let refusals = 0;
      node.onDispatch = () => {
        if (refusals > 0) return null;
        refusals += 1;
        node.shell = baseShell(THREAD, {
          session: session("running", "turn-theirs"),
          latestTurn: turn("turn-theirs", "running"),
        });
        return new Error(
          "Thread 'thread-1' already has active turn 'turn-theirs' and cannot start another turn until it finishes.",
        );
      };
      const fiber = yield* Effect.forkChild(
        sendToThread(target, {
          threadId: THREAD,
          prompt: "Next",
          wait: false,
          deadlineMs: Number.POSITIVE_INFINITY,
        }),
      );
      yield* advance();
      assert.lengthOf(node.dispatched, 1);

      node.shell = baseShell(THREAD, {
        session: session("ready", null, { updatedAt: LATER }),
        latestTurn: turn("turn-theirs", "completed"),
      });
      publish("thread.session-set", releasedSessionSet("ready", "turn-theirs", "completed"));
      yield* advance();
      assert.lengthOf(node.dispatched, 2);
      const [first, second] = node.dispatched as [Json, Json];
      // A refused command id is not reused; the message keeps its id.
      assert.notStrictEqual(first.commandId, second.commandId);
      assert.deepEqual(first.message, second.message);

      const messageId = (second.message as Json).messageId as string;
      node.shell = baseShell(THREAD, {
        session: session("running", "turn-ours"),
        latestTurn: turn("turn-ours", "running", messageId),
      });
      publish("thread.session-set", { threadId: THREAD, session: session("running", "turn-ours") });
      yield* advance();
      const result = yield* Fiber.join(fiber);
      // Without --wait the command returns once its turn has started, with that turn's id.
      assert.deepInclude(result, { state: "started", turnId: TurnId.make("turn-ours") });
    }),
  );
});

describe("command input", () => {
  it("reads --project as a path only when it is one", () => {
    const options = { cwd: "/work/app", home: "/home/me", exists: () => false };
    assert.isNull(localProjectPath("projet-typo", options));
    assert.strictEqual(localProjectPath(".", options), "/work/app");
    assert.strictEqual(localProjectPath("..", options), "/work");
    assert.strictEqual(localProjectPath("./web", options), "/work/app/web");
    assert.strictEqual(localProjectPath("../other", options), "/work/other");
    assert.strictEqual(localProjectPath("/srv/site", options), "/srv/site");
    assert.strictEqual(localProjectPath("~/code", options), "/home/me/code");
    assert.strictEqual(
      localProjectPath("web", { ...options, exists: (path) => path === "/work/app/web" }),
      "/work/app/web",
    );
  });

  it.effect("keeps `-` as the message itself for `ryco remote send`", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* readPrompt("-", false), "-");
      assert.strictEqual(yield* readPrompt("  Run the tests \n"), "Run the tests");
    }),
  );
});

describe("ryco thread send binding", () => {
  it.effect("binds to its own turn start, not one the queue wait saw from another client", () =>
    Effect.gen(function* () {
      const { node, publish, target } = yield* makeNode;
      // An older node: its shell does not name a turn's user message.
      node.shell = baseShell(THREAD, {
        session: session("running", "turn-theirs"),
        latestTurn: turn("turn-theirs", "running"),
      });
      const fiber = yield* Effect.forkChild(
        sendToThread(target, {
          threadId: THREAD,
          prompt: "Mine",
          wait: true,
          deadlineMs: 60_000,
        }),
      );
      yield* advance();
      publish("thread.turn-start-requested", {
        threadId: THREAD,
        messageId: "message-theirs",
        createdAt: AT,
      });
      node.shell = baseShell(THREAD, {
        session: session("ready", null, { updatedAt: LATER }),
        latestTurn: turn("turn-theirs", "completed"),
      });
      publish("thread.session-set", releasedSessionSet("ready", "turn-theirs", "completed"));
      yield* advance();
      assert.lengthOf(node.dispatched, 1);
      node.shell = baseShell(THREAD, {
        session: session("running", "turn-ours"),
        latestTurn: turn("turn-ours", "running"),
      });
      publish("thread.session-set", { threadId: THREAD, session: session("running", "turn-ours") });
      yield* advance();
      node.shell = baseShell(THREAD, {
        session: session("ready", null, { updatedAt: LATER }),
        latestTurn: turn("turn-ours", "completed"),
      });
      publish("thread.session-set", releasedSessionSet("ready", "turn-ours", "completed"));
      yield* advance();
      const result = yield* Fiber.join(fiber);
      assert.deepInclude(result, { state: "completed", turnId: TurnId.make("turn-ours") });
    }),
  );
});

describe("ryco thread wait", () => {
  it.effect("returns 2 when the turn needs an approval", () =>
    Effect.gen(function* () {
      const { node, publish, target } = yield* makeNode;
      node.shell = baseShell(THREAD, {
        session: session("running", "turn-ours"),
        latestTurn: turn("turn-ours", "running"),
      });
      const fiber = yield* Effect.forkChild(
        waitForThread(target, {
          threadId: THREAD,
          turnId: null,
          deadlineMs: Number.POSITIVE_INFINITY,
        }),
      );
      yield* advance();
      assert.isUndefined(fiber.pollUnsafe());
      node.shell = { ...node.shell, hasPendingApprovals: true };
      publish("thread.activity-appended", {
        threadId: THREAD,
        activity: {
          id: "activity-1",
          kind: "approval.requested",
          tone: "approval",
          summary: "Run a command",
          payload: {},
          turnId: "turn-ours",
          createdAt: AT,
        },
      });
      yield* advance(1);
      const result = yield* Fiber.join(fiber);
      assert.deepInclude(result, { state: "needs-approval", turnId: TurnId.make("turn-ours") });
      assert.strictEqual(runExitCode(result.state), 2);
    }),
  );

  it.effect("reconnects after a node restart and reports the turn it cut off (3)", () =>
    Effect.gen(function* () {
      const { node, publish, drop, target } = yield* makeNode;
      node.shell = baseShell(THREAD, {
        session: session("running", "turn-ours"),
        latestTurn: turn("turn-ours", "running"),
      });
      const fiber = yield* Effect.forkChild(
        waitForThread(target, {
          threadId: THREAD,
          turnId: "turn-ours",
          deadlineMs: Number.POSITIVE_INFINITY,
        }),
      );
      yield* advance();
      const seen = node.sequence;
      yield* drop;
      // While it is down the node releases the orphaned turn, then continues the thread.
      publish(
        "thread.session-set",
        releasedSessionSet("error", "turn-ours", "interrupted", ORPHANED_PROVIDER_SESSION_ERROR),
      );
      node.shell = baseShell(THREAD, {
        session: session("running", "turn-continuation"),
        latestTurn: turn("turn-continuation", "running"),
      });
      yield* advance(4);
      assert.isUndefined(fiber.pollUnsafe());
      node.online = true;
      yield* advance(8);
      const result = yield* Fiber.join(fiber);
      assert.deepInclude(result, { state: "restarted", turnId: TurnId.make("turn-ours") });
      assert.strictEqual(runExitCode(result.state), 3);
      assert.include(node.resumes, seen, "the resubscribe resumes after the last event seen");
      assert.isAtLeast(node.connects, 2);
    }),
  );

  it.effect("resubscribes when the feed ends although reads still work (a quick restart)", () =>
    Effect.gen(function* () {
      const { node, publish, endFeeds, target } = yield* makeNode;
      node.shell = baseShell(THREAD, {
        session: session("running", "turn-ours"),
        latestTurn: turn("turn-ours", "running"),
      });
      const fiber = yield* Effect.forkChild(
        waitForThread(target, {
          threadId: THREAD,
          turnId: "turn-ours",
          deadlineMs: Number.POSITIVE_INFINITY,
        }),
      );
      yield* advance();
      const seen = node.sequence;
      // The socket came back under the client; the subscription did not. The node released
      // the orphaned turn on its way up and a continuation already runs.
      yield* endFeeds;
      publish(
        "thread.session-set",
        releasedSessionSet("error", "turn-ours", "interrupted", ORPHANED_PROVIDER_SESSION_ERROR),
      );
      node.shell = baseShell(THREAD, {
        session: session("running", "turn-continuation"),
        latestTurn: turn("turn-continuation", "running"),
      });
      yield* advance(8);
      const result = yield* Fiber.join(fiber);
      assert.deepInclude(result, { state: "restarted", turnId: TurnId.make("turn-ours") });
      assert.include(node.resumes, seen);
      assert.isAtLeast(node.connects, 2);
    }),
  );

  it.effect("exits 5 for a turn a later turn replaced before its end was seen", () =>
    Effect.gen(function* () {
      const { node, target } = yield* makeNode;
      node.shell = baseShell(THREAD, {
        session: session("running", "turn-later"),
        latestTurn: turn("turn-later", "running"),
      });
      const fiber = yield* Effect.forkChild(
        waitForThread(target, {
          threadId: THREAD,
          turnId: "turn-earlier",
          deadlineMs: Number.POSITIVE_INFINITY,
        }),
      );
      yield* advance(8);
      const result = yield* Fiber.join(fiber);
      assert.deepInclude(result, { state: "unknown", turnId: TurnId.make("turn-earlier") });
      assert.strictEqual(runExitCode(result.state), 5);
    }),
  );

  it.effect("times out with 4 while the turn still runs", () =>
    Effect.gen(function* () {
      const { node, target } = yield* makeNode;
      node.shell = baseShell(THREAD, {
        session: session("running", "turn-ours"),
        latestTurn: turn("turn-ours", "running"),
      });
      const fiber = yield* Effect.forkChild(
        waitForThread(target, { threadId: THREAD, turnId: "turn-ours", deadlineMs: 10_000 }),
      );
      yield* advance(12);
      const result = yield* Fiber.join(fiber);
      assert.deepInclude(result, { state: "timed-out", turnId: TurnId.make("turn-ours") });
      assert.strictEqual(runExitCode(result.state), 4);
    }),
  );
});

describe("ryco thread start", () => {
  it.effect("starts a thread with the project's defaults and returns once its turn runs", () =>
    Effect.gen(function* () {
      const { node, publish, target } = yield* makeNode;
      node.onDispatch = (command) => {
        node.shell = baseShell(command.threadId as string, { session: session("starting") });
        return null;
      };
      const fiber = yield* Effect.forkChild(
        startThread(target, {
          project: "project-1",
          prompt: "Add a settings page\nwith tests",
          title: null,
          model: null,
          runtimeMode: null,
          wait: false,
          deadlineMs: Number.POSITIVE_INFINITY,
        }),
      );
      yield* advance();
      assert.lengthOf(node.dispatched, 1);
      const command = node.dispatched[0]!;
      const bootstrap = command.bootstrap as Json;
      const createThread = bootstrap.createThread as Json;
      const prepareWorktree = bootstrap.prepareWorktree as Json;
      const modelSelection = { instanceId: "claudeAgent", model: "claude-opus", options: [] };
      assert.deepInclude(command, {
        type: "thread.turn.start",
        runtimeMode: "full-access",
        interactionMode: "default",
        tokenMode: "balanced",
        titleSeed: "Add a settings page",
        modelSelection,
      });
      assert.deepInclude(createThread, {
        projectId: "project-1",
        title: "Add a settings page",
        modelSelection,
        runtimeMode: "full-access",
      });
      // The project's threads start in a new worktree off its current checkout.
      assert.deepInclude(prepareWorktree, { projectCwd: "/work/app", baseBranch: "HEAD" });
      assert.match(prepareWorktree.branch as string, /^ryco\//u);

      const messageId = (command.message as Json).messageId as string;
      node.shell = baseShell(command.threadId as string, {
        session: session("running", "turn-first"),
        latestTurn: turn("turn-first", "running", messageId),
      });
      publish("thread.session-set", {
        threadId: command.threadId,
        session: session("running", "turn-first"),
      });
      yield* advance();
      const result = yield* Fiber.join(fiber);
      assert.deepEqual(result, {
        threadId: command.threadId as string,
        turnId: "turn-first",
        state: "started",
        reply: null,
        error: null,
      } as RunResult);
    }),
  );

  it.effect("never takes a mistyped id for the project around the current directory", () =>
    Effect.gen(function* () {
      const { node, target } = yield* makeNode;
      node.projects = [
        { id: "project-here", title: "Here", workspaceRoot: process.cwd(), scripts: [] },
      ];
      const start = (project: string) =>
        startThread(
          { ...target, local: true },
          {
            project,
            prompt: "Hello",
            title: null,
            model: null,
            runtimeMode: null,
            wait: false,
            deadlineMs: Number.POSITIVE_INFINITY,
          },
        );
      const exit = yield* Effect.exit(start("projet-here"));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "No project matches");
      assert.lengthOf(node.dispatched, 0);
      // Written as a path, the current directory is the project's.
      node.onDispatch = (command) => {
        node.shell = baseShell(command.threadId as string, {
          session: session("running", "turn-first"),
          latestTurn: turn("turn-first", "running", (command.message as Json).messageId as string),
        });
        return null;
      };
      const fiber = yield* Effect.forkChild(start("."));
      yield* advance();
      assert.deepInclude(yield* Fiber.join(fiber), { state: "started" });
      assert.strictEqual(
        ((node.dispatched[0]!.bootstrap as Json).createThread as Json).projectId,
        "project-here",
      );
    }),
  );

  it.effect("reports nothing started when the connection drops before the first turn", () =>
    Effect.gen(function* () {
      const { node, target } = yield* makeNode;
      // The bootstrap created the thread; the socket dropped before the turn start landed.
      node.onDispatch = (command) => {
        node.shell = baseShell(command.threadId as string, { session: session("idle") });
        return new SocketClosed("closed");
      };
      const fiber = yield* Effect.forkChild(
        Effect.exit(
          startThread(target, {
            project: "project-1",
            prompt: "Hello",
            title: null,
            model: null,
            runtimeMode: null,
            wait: false,
            deadlineMs: Number.POSITIVE_INFINITY,
          }),
        ),
      );
      yield* advance(4);
      const exit = yield* Fiber.join(fiber);
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "Nothing was started");
      assert.lengthOf(node.dispatched, 1, "a bootstrap is never sent twice");
    }),
  );

  it.effect("goes on when the first turn landed before the connection dropped", () =>
    Effect.gen(function* () {
      const { node, publish, target } = yield* makeNode;
      let threadId = "";
      node.onDispatch = (command) => {
        threadId = command.threadId as string;
        const message = command.message as Json;
        node.shell = baseShell(threadId, { session: session("starting") });
        node.messages = [
          {
            id: message.messageId,
            role: "user",
            text: "Hello",
            turnId: null,
            streaming: false,
            createdAt: AT,
            updatedAt: AT,
          },
        ];
        return new SocketClosed("closed");
      };
      const fiber = yield* Effect.forkChild(
        startThread(target, {
          project: "project-1",
          prompt: "Hello",
          title: null,
          model: null,
          runtimeMode: null,
          wait: false,
          deadlineMs: Number.POSITIVE_INFINITY,
        }),
      );
      yield* advance(4);
      node.shell = baseShell(threadId, { session: session("running", "turn-first") });
      publish("thread.session-set", {
        threadId,
        session: session("running", "turn-first"),
      });
      yield* advance();
      const result = yield* Fiber.join(fiber);
      assert.deepInclude(result, { state: "started", turnId: TurnId.make("turn-first") });
      assert.lengthOf(node.dispatched, 1);
    }),
  );

  it.effect("refuses a project it cannot find", () =>
    Effect.gen(function* () {
      const { target } = yield* makeNode;
      const exit = yield* Effect.exit(
        startThread(target, {
          project: "/elsewhere",
          prompt: "Hello",
          title: null,
          model: null,
          runtimeMode: null,
          wait: false,
          deadlineMs: Number.POSITIVE_INFINITY,
        }),
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "No project matches");
    }),
  );
});

const makeServerConfig = (baseDir: string) =>
  Effect.gen(function* () {
    const derivedPaths = yield* deriveServerPaths(baseDir, undefined);
    return {
      logLevel: "Warn",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "ryco-server",
      mode: "web",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl: undefined,
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    } satisfies ServerConfigShape;
  });

it.layer(NodeServices.layer)("this machine's node", (it) => {
  it.effect("signs in as a short-lived owner session and revokes it when the command ends", () =>
    Effect.gen(function* () {
      const config = yield* makeServerConfig(mkdtempSync(join(tmpdir(), "ryco-thread-cli-")));
      const authControlPlane = AuthControlPlaneRuntimeLive.pipe(
        Layer.provide(Layer.succeed(ServerConfig, config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
      );
      const sessions = Effect.gen(function* () {
        const auth = yield* AuthControlPlane;
        return yield* auth.listSessions();
      }).pipe(Effect.provide(authControlPlane));
      const during = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* localThreadTarget({
            local: { readOrigin: Effect.succeed("http://127.0.0.1:1"), authControlPlane },
            timeout: null,
          });
          return yield* sessions;
        }),
      );
      const cliSessions = during.filter((entry) => entry.client.label === "ryco thread cli");
      assert.lengthOf(cliSessions, 1);
      assert.strictEqual(cliSessions[0]!.role, "owner");
      const after = yield* sessions;
      assert.lengthOf(
        after.filter((entry) => entry.client.label === "ryco thread cli"),
        0,
      );
    }),
  );
});

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)),
  );

const helpOf = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* runCli([...args, "--help"]);
    return (yield* TestConsole.logLines).join("\n");
  }).pipe(Effect.provide(Layer.fresh(TestConsole.layer)));

it.layer(NodeServices.layer)("ryco thread commands", (it) => {
  it.effect("registers start, send, wait and read, each with --remote", () =>
    Effect.gen(function* () {
      const help = yield* helpOf(["thread"]);
      for (const subcommand of ["start", "send", "wait", "read"]) {
        assert.match(help, new RegExp(`^\\s+${subcommand}\\b`, "m"), help);
        assert.include(yield* helpOf(["thread", subcommand]), "--remote");
      }
      const start = yield* helpOf(["thread", "start"]);
      for (const flag of [
        "--project",
        "--runtime-mode",
        "--model",
        "--wait",
        "--timeout",
        "--json",
      ]) {
        assert.include(start, flag);
      }
      assert.include(yield* helpOf(["thread", "wait"]), "--turn");
      assert.include(yield* helpOf(["thread", "read"]), "--limit");
    }),
  );

  it.effect("fails in one line when this machine's node is not running", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "ryco-thread-cli-down-"));
      const error = yield* runCli(["thread", "read", THREAD, "--base-dir", baseDir]).pipe(
        Effect.flip,
      );
      assert.include(String((error as Error).message), "The Ryco server is not running.");
    }),
  );

  it.effect("keeps `ryco remote send` and its flags as an alias of `thread send --remote`", () =>
    Effect.gen(function* () {
      assert.include(yield* helpOf(["remote", "send"]), "ryco thread send --remote");
      const baseDir = mkdtempSync(join(tmpdir(), "ryco-thread-cli-remote-"));
      for (const args of [
        ["remote", "send", "mini", THREAD, "Run", "the", "tests"],
        ["remote", "send", "mini", THREAD, "Run", "--no-wait"],
        ["thread", "send", THREAD, "Run", "--remote", "mini"],
      ]) {
        const error = yield* runCli([...args, "--base-dir", baseDir]).pipe(Effect.flip);
        // Both resolve the paired remote the same way before anything is sent.
        assert.include(String((error as Error).message), 'No remote named "mini"', args.join(" "));
      }
    }),
  );
});
