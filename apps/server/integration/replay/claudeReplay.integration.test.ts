/**
 * Claude scenarios replayed through the real adapter and orchestrator: the real ClaudeAdapter,
 * ProviderService, ingestion and projections run against recorded Claude Agent SDK query frames,
 * so the lifecycle paths between them (steering, Stop, approvals, resume after a server restart)
 * are covered without a Claude Code CLI.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  ApprovalResponseIdentity,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type RuntimeMode,
  ThreadId,
  type TurnId,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { describe } from "vite-plus/test";

import {
  claudeReplayAdapterFactory,
  type ClaudeReplayAdapterFactory,
} from "../../src/provider/testUtils/replay/claudeReplayAdapterFactory.ts";
import { makeReplayGate, type ReplayGate } from "../../src/provider/testUtils/replay/replayGate.ts";
import { describeReplayEntry } from "../../src/provider/testUtils/replay/replayMatch.ts";
import {
  readReplayFixture,
  type ReplayEntry,
} from "../../src/provider/testUtils/replay/replayTranscript.ts";
import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "../OrchestrationEngineHarness.integration.ts";
import {
  assertActivityKinds,
  assertAssistantTextIncludes,
  assertLatestTurn,
  assertMessageRoles,
  assertNoPendingApprovals,
  assertNoStreamingMessages,
  assertSessionStatus,
} from "./replayAssertions.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");
const CLAUDE_MODEL = "claude-sonnet-4-6";
const PROJECT_ID = ProjectId.make("replay-project");
const THREAD_ID = ThreadId.make("replay-thread");

const nowIso = () => new Date().toISOString();

const CLAUDE_FIXTURES = new URL("./fixtures/claudeAgent/", import.meta.url);
const CLAUDE_SCENARIOS = [
  "simple",
  "queued_turn",
  "message_steering",
  "dropped_steer_next_turn",
  "turn_interrupt",
  "tool_approval",
  "provider_thread_resume",
] as const;
type ClaudeScenario = (typeof CLAUDE_SCENARIOS)[number];

const readClaudeFixture = (scenario: ClaudeScenario) =>
  readReplayFixture(new URL(`${scenario}.ndjson`, CLAUDE_FIXTURES));

interface ClaudeReplayScenario {
  readonly harness: OrchestrationIntegrationHarness;
  readonly factory: ClaudeReplayAdapterFactory;
  readonly gate: ReplayGate;
}

/**
 * Disposes `harness` after `body`, also when it fails. When `body` passed, the frames the adapter
 * wrote while stopping must have matched the transcript too.
 */
const thenDispose =
  (harness: OrchestrationIntegrationHarness) =>
  <A, E>(body: Effect.Effect<A, E>) =>
    body.pipe(
      Effect.ensuring(harness.dispose),
      Effect.tap(() => harness.assertNoLateReplayFrames),
    );

/**
 * Runs `use` against a harness whose Claude adapter replays `scenario`, then requires the
 * transcript to be fully played, every tripwire untouched, and shutdown to write nothing the
 * transcript does not allow.
 */
const withClaudeReplay = <A, E>(
  scenario: ClaudeScenario,
  use: (context: ClaudeReplayScenario) => Effect.Effect<A, E>,
  options?: { readonly gateLabels?: ReadonlyArray<string> },
) =>
  Effect.gen(function* () {
    const gate = yield* makeReplayGate(options?.gateLabels ?? []);
    const factory = claudeReplayAdapterFactory({
      transcript: yield* readClaudeFixture(scenario),
      gate,
    });
    const harness = yield* makeOrchestrationIntegrationHarness({
      provider: CLAUDE,
      adapterFactories: [factory],
    });
    return yield* Effect.gen(function* () {
      const result = yield* use({ harness, factory, gate });
      yield* harness.replays[0]!.assertConsumed;
      return result;
    }).pipe(thenDispose(harness));
  }).pipe(Effect.provide(NodeServices.layer));

const seedProjectAndThread = (harness: OrchestrationIntegrationHarness, runtimeMode: RuntimeMode) =>
  Effect.gen(function* () {
    const modelSelection = { instanceId: CLAUDE_INSTANCE, model: CLAUDE_MODEL };
    yield* harness.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("replay-project-create"),
      projectId: PROJECT_ID,
      title: "Replay project",
      workspaceRoot: harness.workspaceDir,
      defaultModelSelection: modelSelection,
      createdAt: nowIso(),
    });
    yield* harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("replay-thread-create"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Replay thread",
      modelSelection,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode,
      branch: null,
      worktreePath: harness.workspaceDir,
      createdAt: nowIso(),
    });
  });

const messageId = (key: string) => MessageId.make(`replay-message-${key}`);

const startTurn = (
  harness: OrchestrationIntegrationHarness,
  input: { readonly key: string; readonly text: string; readonly runtimeMode: RuntimeMode },
) =>
  harness.engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(`replay-turn-start-${input.key}`),
    threadId: THREAD_ID,
    message: { messageId: messageId(input.key), role: "user", text: input.text, attachments: [] },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: input.runtimeMode,
    createdAt: nowIso(),
  });

/** Sends `text` into the running turn `expectedTurnId`, as the composer's Steer does. */
const steerTurn = (
  harness: OrchestrationIntegrationHarness,
  input: { readonly key: string; readonly text: string; readonly expectedTurnId: TurnId },
) =>
  harness.engine.dispatch({
    type: "thread.turn.steer",
    commandId: CommandId.make(`replay-turn-steer-${input.key}`),
    threadId: THREAD_ID,
    expectedTurnId: input.expectedTurnId,
    message: { messageId: messageId(input.key), role: "user", text: input.text, attachments: [] },
    createdAt: nowIso(),
    requestedAt: nowIso(),
  });

type SteerResolution = Extract<
  OrchestrationEvent,
  { readonly type: "thread.turn-steer-accepted" | "thread.turn-steer-rejected" }
>;

const isSteerResolutionOf =
  (key: string) =>
  (event: OrchestrationEvent): event is SteerResolution =>
    (event.type === "thread.turn-steer-accepted" || event.type === "thread.turn-steer-rejected") &&
    event.payload.messageId === messageId(key);

/** How the orchestrator resolved the steer of message `key`. */
const steerResolution = (harness: OrchestrationIntegrationHarness, key: string) =>
  harness
    .waitForDomainEvent(isSteerResolutionOf(key))
    .pipe(Effect.map((events) => events.find(isSteerResolutionOf(key))!));

const interruptTurn = (harness: OrchestrationIntegrationHarness, key: string) =>
  Effect.gen(function* () {
    yield* harness.engine.dispatch({
      type: "thread.turn.interrupt",
      commandId: CommandId.make(`replay-turn-interrupt-${key}`),
      threadId: THREAD_ID,
      createdAt: nowIso(),
    });
    yield* harness.waitForDomainEvent((event) => event.type === "thread.turn-interrupt-requested");
  });

/** The running turn once `text` streamed into its answer. */
const waitForStreamedText = (harness: OrchestrationIntegrationHarness, text: string) =>
  harness.waitForThread(
    THREAD_ID,
    (thread) =>
      thread.session?.status === "running" &&
      thread.session.activeTurnId !== null &&
      thread.messages.some(
        (message) => message.role === "assistant" && message.text.includes(text),
      ),
  );

const activeTurnIdOf = (thread: OrchestrationThread): TurnId => {
  const turnId = thread.session?.activeTurnId;
  assert.isString(turnId, "the thread has no running turn");
  return turnId!;
};

/**
 * The thread once the turn of message `key` settled: the session is ready, the turn ended, no
 * message is still streaming, and `answer` is projected.
 */
const waitForSettledTurn = (
  harness: OrchestrationIntegrationHarness,
  key: string,
  answer: string,
) =>
  harness.waitForThread(
    THREAD_ID,
    (thread) =>
      thread.session?.status === "ready" &&
      thread.latestTurn?.userMessageId === messageId(key) &&
      thread.latestTurn.state !== "running" &&
      thread.messages.every((message) => !message.streaming) &&
      thread.messages.some(
        (message) => message.role === "assistant" && message.text.includes(answer),
      ),
  );

const messageWith = (thread: OrchestrationThread, text: string) => {
  const message = thread.messages.find((candidate) => candidate.text.includes(text));
  assert.isDefined(message, `no message includes ${JSON.stringify(text)}`);
  return message!;
};

/** The approval the thread is waiting for, once it is pending. */
const waitForRequestedApproval = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const requested = yield* harness.waitForThread(THREAD_ID, (thread) =>
      thread.activities.some((activity) => activity.kind === "approval.requested"),
    );
    const payload = requested.activities.find((activity) => activity.kind === "approval.requested")
      ?.payload as { readonly requestId: string; readonly approvalIdentity: unknown };
    const pending = yield* harness.waitForPendingApproval(
      THREAD_ID,
      payload.requestId,
      (row) => row.status === "pending",
    );
    assert.equal(pending.decision, null);
    return payload;
  });

const acceptApproval = (
  harness: OrchestrationIntegrationHarness,
  approval: { readonly requestId: string; readonly approvalIdentity: unknown },
) =>
  Effect.gen(function* () {
    yield* harness.engine.dispatch({
      type: "thread.approval.respond",
      commandId: CommandId.make("replay-approval-respond"),
      threadId: THREAD_ID,
      requestId: ApprovalRequestId.make(approval.requestId),
      approvalIdentity: Schema.decodeUnknownSync(ApprovalResponseIdentity)(
        approval.approvalIdentity,
      ),
      decision: "accept",
      createdAt: nowIso(),
    });
    const resolved = yield* harness.waitForPendingApproval(
      THREAD_ID,
      approval.requestId,
      (row) => row.status === "resolved",
    );
    assert.equal(resolved.decision, "accept");
  });

describe.skipIf(process.platform === "win32")("Claude replay through the orchestrator", () => {
  it.live("simple: one streamed turn completes and the session is ready", () =>
    withClaudeReplay("simple", ({ harness, factory }) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness, "full-access");
        yield* startTurn(harness, { key: "1", text: "Say hello.", runtimeMode: "full-access" });

        const thread = yield* waitForSettledTurn(harness, "1", "Hello from replay.");
        assertMessageRoles(thread, ["user", "assistant"]);
        assertLatestTurn(thread, "completed");
        assertSessionStatus(thread, "ready");
        assertNoStreamingMessages(thread);
        assert.equal(factory.queries.length, 1);

        // The adapter would launch only the tripwire, in a home under the harness root, with no
        // credential from the developer's environment.
        const options = factory.queries[0]!.options;
        assert.isTrue(options.pathToClaudeCodeExecutable?.startsWith(harness.rootDir));
        const env = options.env ?? {};
        for (const key of ["HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"]) {
          assert.isTrue(env[key]?.startsWith(harness.rootDir), `${key} is ${env[key]}`);
        }
        assert.deepEqual(
          Object.keys(env).filter((key) => key.startsWith("ANTHROPIC_")),
          [],
        );
      }),
    ),
  );

  it.live("queued_turn: a message Claude cannot take while it waits stays queued", () =>
    withClaudeReplay("queued_turn", ({ harness, factory }) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness, "approval-required");
        yield* startTurn(harness, {
          key: "1",
          text: "List the files.",
          runtimeMode: "approval-required",
        });
        const approval = yield* waitForRequestedApproval(harness);
        const running = yield* harness.waitForThread(
          THREAD_ID,
          (thread) => thread.session?.status === "running",
        );

        // Claude is waiting for the approval: the adapter refuses the steer, so it never reaches
        // the query (the transcript holds no prompt for it) and the message stays queued.
        yield* steerTurn(harness, {
          key: "2",
          text: "Also show its size.",
          expectedTurnId: activeTurnIdOf(running),
        });
        const refused = yield* steerResolution(harness, "2");
        assert.equal(refused.type, "thread.turn-steer-rejected");
        assert.equal(
          refused.type === "thread.turn-steer-rejected" && refused.payload.reason,
          "deferred",
        );

        yield* acceptApproval(harness, approval);
        yield* waitForSettledTurn(harness, "1", "The workspace has README.md.");

        // The client's queue sends it as the next turn, on the same query.
        yield* startTurn(harness, {
          key: "2",
          text: "Also show its size.",
          runtimeMode: "approval-required",
        });
        const thread = yield* waitForSettledTurn(harness, "2", "README.md is 3 bytes.");
        assertMessageRoles(thread, ["user", "assistant", "user", "assistant"]);
        assertLatestTurn(thread, "completed");
        assertSessionStatus(thread, "ready");
        assert.equal(factory.queries.length, 1);
      }),
    ),
  );

  it.live(
    "message_steering: a steer accepted as the turn finishes replies in a background turn",
    () =>
      withClaudeReplay(
        "message_steering",
        ({ harness, gate }) =>
          Effect.gen(function* () {
            yield* seedProjectAndThread(harness, "full-access");
            yield* startTurn(harness, {
              key: "1",
              text: "Summarize the README.",
              runtimeMode: "full-access",
            });
            // The replay parks before the turn's result: the answer is complete, the turn open.
            yield* harness.waitForReplayGate(gate, "result:prompt");
            const running = yield* waitForStreamedText(harness, "The README has one line.");
            const turnId = activeTurnIdOf(running);

            yield* steerTurn(harness, {
              key: "2",
              text: "Also mention the license.",
              expectedTurnId: turnId,
            });
            const accepted = yield* steerResolution(harness, "2");
            assert.equal(accepted.type, "thread.turn-steer-accepted");
            // The steer is written to the CLI, which then reports the turn's result without
            // consuming it: the turn completes as it would without the steer.
            yield* gate.release("result:prompt");
            yield* harness.waitForReplayGate(gate, "steer:system/init");
            const finished = yield* harness.waitForThread(
              THREAD_ID,
              (candidate) =>
                candidate.session?.status === "ready" &&
                candidate.latestTurn?.turnId === turnId &&
                candidate.latestTurn.state !== "running",
            );
            assertLatestTurn(finished, "completed");

            // Then the steer runs as Claude's next request.
            yield* gate.release("steer:system/init");
            const thread = yield* harness.waitForThread(
              THREAD_ID,
              (candidate) =>
                candidate.session?.status === "ready" &&
                candidate.latestTurn?.state === "completed" &&
                candidate.messages.every((message) => !message.streaming) &&
                candidate.messages.some((message) =>
                  message.text.includes("There is no license file."),
                ),
            );
            assertMessageRoles(thread, ["user", "assistant", "user", "assistant"]);
            // Your steer stays in the finished turn; its reply is a background turn of its own.
            assert.equal(messageWith(thread, "Also mention the license.").turnId, turnId);
            assert.equal(messageWith(thread, "The README has one line.").turnId, turnId);
            const steerReply = messageWith(thread, "There is no license file.");
            assert.isNotNull(steerReply.turnId);
            assert.notEqual(steerReply.turnId, turnId);
            assert.equal(thread.latestTurn?.turnId, steerReply.turnId);
            assertNoStreamingMessages(thread);
          }),
        { gateLabels: ["result:prompt", "steer:system/init"] },
      ),
  );

  it.live("dropped_steer_next_turn: a steer dropped by Stop is answered in the next turn", () =>
    withClaudeReplay("dropped_steer_next_turn", ({ harness }) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness, "full-access");
        yield* startTurn(harness, {
          key: "1",
          text: "Count slowly to ten.",
          runtimeMode: "full-access",
        });
        const running = yield* waitForStreamedText(harness, "Counting slowly.");
        const turnId = activeTurnIdOf(running);
        yield* steerTurn(harness, {
          key: "2",
          text: "Count backwards instead.",
          expectedTurnId: turnId,
        });
        assert.equal((yield* steerResolution(harness, "2")).type, "thread.turn-steer-accepted");

        // Without interrupt_cancel_queued_v1, Stop is a plain interrupt; the receipt still
        // lists the steer as queued, so the adapter drops it.
        yield* interruptTurn(harness, "1");
        const stopped = yield* harness.waitForThread(
          THREAD_ID,
          (thread) =>
            thread.session?.status === "ready" &&
            thread.latestTurn?.turnId === turnId &&
            thread.latestTurn.state === "interrupted",
        );
        assertNoStreamingMessages(stopped);

        // Claude Code runs the dropped steer together with the next message: one request that
        // echoes both, answered in the new turn, with no second interrupt.
        yield* startTurn(harness, {
          key: "3",
          text: "Where did you stop?",
          runtimeMode: "full-access",
        });
        const thread = yield* waitForSettledTurn(harness, "3", "Backwards: ten, nine.");
        assertLatestTurn(thread, "completed");
        assertMessageRoles(thread, ["user", "assistant", "user", "user", "assistant"]);
        const reply = messageWith(thread, "Backwards: ten, nine.");
        assert.equal(reply.turnId, thread.latestTurn?.turnId);
        assert.notEqual(reply.turnId, turnId);
        assert.equal(messageWith(thread, "Count backwards instead.").turnId, turnId);
      }),
    ),
  );

  it.live("turn_interrupt: Stop with a pending steer cancels it with the interrupt", () =>
    withClaudeReplay("turn_interrupt", ({ harness }) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness, "full-access");
        yield* startTurn(harness, {
          key: "1",
          text: "Count slowly to ten.",
          runtimeMode: "full-access",
        });
        const running = yield* waitForStreamedText(harness, "Counting slowly.");
        const turnId = activeTurnIdOf(running);
        yield* steerTurn(harness, {
          key: "2",
          text: "Count backwards instead.",
          expectedTurnId: turnId,
        });
        assert.equal((yield* steerResolution(harness, "2")).type, "thread.turn-steer-accepted");

        // The CLI's init advertised interrupt_cancel_queued_v1 and a steer is pending, so the
        // transcript expects interrupt({ cancelQueued: true }); the aborted result arrives
        // before the receipt, which reports the steer cancelled.
        yield* interruptTurn(harness, "1");
        const thread = yield* harness.waitForThread(
          THREAD_ID,
          (candidate) =>
            candidate.session?.status === "ready" &&
            candidate.latestTurn?.turnId === turnId &&
            candidate.latestTurn.state !== "running",
        );
        assertLatestTurn(thread, "interrupted");
        assertSessionStatus(thread, "ready");
        assertNoStreamingMessages(thread);
        assertMessageRoles(thread, ["user", "assistant", "user"]);
        assertAssistantTextIncludes(thread, "One, two, ");
      }),
    ),
  );

  it.live("tool_approval: an accepted approval answers canUseTool and the turn finishes", () =>
    withClaudeReplay("tool_approval", ({ harness }) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness, "approval-required");
        yield* startTurn(harness, {
          key: "1",
          text: "List the files.",
          runtimeMode: "approval-required",
        });

        const approval = yield* waitForRequestedApproval(harness);
        // The SDK's request id: the transcript gives none, so it is the tool use id.
        assert.equal(approval.requestId, "toolu_replay_ls");
        // The transcript expects the answer { behavior: "allow", updatedInput: { command: "ls" } }.
        yield* acceptApproval(harness, approval);

        const thread = yield* waitForSettledTurn(harness, "1", "The workspace has README.md.");
        assertLatestTurn(thread, "completed");
        assertActivityKinds(thread, ["approval.requested", "approval.resolved"]);
        yield* assertNoPendingApprovals(harness, THREAD_ID);
      }),
    ),
  );

  it.live("provider_thread_resume: a restarted server resumes the Claude session", () =>
    Effect.gen(function* () {
      const factory = claudeReplayAdapterFactory({
        transcript: yield* readClaudeFixture("provider_thread_resume"),
      });
      const first = yield* makeOrchestrationIntegrationHarness({
        provider: CLAUDE,
        adapterFactories: [factory],
      });
      yield* Effect.gen(function* () {
        yield* seedProjectAndThread(first, "full-access");
        yield* startTurn(first, {
          key: "1",
          text: "Remember the word KIWI.",
          runtimeMode: "full-access",
        });
        yield* waitForSettledTurn(first, "1", "Noted: KIWI.");
      }).pipe(thenDispose(first));

      // A restart: a second server on the same database. Its first turn opens a new query
      // (segment #2), which resumes the session the first query opened.
      const second = yield* makeOrchestrationIntegrationHarness({
        provider: CLAUDE,
        adapterFactories: [factory],
        databasePath: first.dbPath,
      });
      yield* Effect.gen(function* () {
        yield* startTurn(second, { key: "2", text: "Which word?", runtimeMode: "full-access" });

        const thread = yield* waitForSettledTurn(second, "2", "The word was KIWI.");
        assertMessageRoles(thread, ["user", "assistant", "user", "assistant"]);
        assertAssistantTextIncludes(thread, "Noted: KIWI.");
        assertLatestTurn(thread, "completed");
        assert.equal(factory.queries.length, 2);
        const openedSession = factory.queries[0]!.options.sessionId;
        assert.isString(openedSession);
        assert.equal(factory.queries[1]!.options.resume, openedSession);
        const session = yield* second.providerService.getSession(THREAD_ID).pipe(Effect.orDie);
        const cursor = Option.getOrUndefined(session)?.resumeCursor as
          | { readonly resume?: unknown }
          | undefined;
        assert.equal(cursor?.resume, openedSession);
        yield* second.replays[0]!.assertConsumed;
      }).pipe(thenDispose(second));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

/** Outbound and inbound frame types of the `claude-agent-sdk.query` protocol. */
const CLAUDE_OUTBOUND_TYPES = new Set([
  "query.open",
  "prompt.offer",
  "permission.response",
  "query.interrupt",
  "query.set_model",
  "query.set_permission_mode",
  "query.set_max_thinking_tokens",
  "query.stop_task",
  "query.close",
]);
const CLAUDE_INBOUND_TYPES = new Set(["sdk.message", "permission.request", "interrupt.result"]);
/** SDK message types the adapter routes (`routeSdkMessage`); anything else is a warning. */
const SDK_MESSAGE_TYPES = new Set([
  "stream_event",
  "user",
  "assistant",
  "result",
  "system",
  "tool_progress",
  "tool_use_summary",
  "auth_status",
  "rate_limit_event",
]);

function claudeFrameProblems(entries: ReadonlyArray<ReplayEntry>): ReadonlyArray<string> {
  const problems: Array<string> = [];
  for (const entry of entries) {
    if (entry.type !== "expect_outbound" && entry.type !== "emit_inbound") continue;
    const label = describeReplayEntry(entry);
    const frame = entry.frame as { readonly type?: unknown; readonly message?: unknown };
    const types = entry.type === "expect_outbound" ? CLAUDE_OUTBOUND_TYPES : CLAUDE_INBOUND_TYPES;
    if (typeof frame.type !== "string" || !types.has(frame.type)) {
      problems.push(`${label}: unknown ${entry.type} frame type ${String(frame.type)}`);
      continue;
    }
    if (entry.type === "emit_inbound" && entry.stream === "stderr") {
      problems.push(`${label}: the SDK query has no stderr`);
    }
    if (frame.type !== "sdk.message") continue;
    const message = frame.message as { readonly type?: unknown; readonly session_id?: unknown };
    if (typeof message?.type !== "string" || !SDK_MESSAGE_TYPES.has(message.type)) {
      problems.push(`${label}: unknown SDK message type ${String(message?.type)}`);
    }
    if (typeof message?.session_id !== "string") problems.push(`${label}: no session_id`);
  }
  return problems;
}

/**
 * Every Claude fixture is made of the protocol's frame types and of SDK message types the adapter
 * routes (`replayTranscript.test.ts` checks every fixture is canonical and small). The adapter
 * reports an unknown SDK message only as a warning, so a scenario could pass on a hand-authored
 * frame it never handled.
 */
it.effect("every Claude fixture uses the SDK query protocol", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* path.fromFileUrl(CLAUDE_FIXTURES);
    const files = (yield* fileSystem.readDirectory(directory))
      .filter((file) => file.endsWith(".ndjson"))
      .toSorted();
    assert.sameMembers(
      files,
      CLAUDE_SCENARIOS.map((scenario) => `${scenario}.ndjson`),
    );

    const problems: Array<string> = [];
    for (const file of files) {
      const transcript = yield* readReplayFixture(new URL(file, CLAUDE_FIXTURES));
      if (transcript.header.protocol !== "claude-agent-sdk.query") {
        problems.push(`${file}: protocol ${transcript.header.protocol}`);
      }
      for (const problem of claudeFrameProblems(transcript.entries)) {
        problems.push(`${file} ${problem}`);
      }
    }
    assert.deepEqual(problems, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);
