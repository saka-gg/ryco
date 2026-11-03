/**
 * Codex scenarios replayed through the real adapter and orchestrator: the real app-server client,
 * session runtime, CodexAdapter, ProviderService, ingestion and projections run against recorded
 * app-server frames, so the lifecycle paths between them (restart on a mode switch, interrupt,
 * approvals, resume after a server restart) are covered without a Codex CLI.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  ApprovalResponseIdentity,
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Result, Schema } from "effect";
import * as CodexRpc from "effect-codex-app-server/rpc";
import { describe } from "vite-plus/test";

import {
  codexReplayAdapterFactory,
  type CodexReplayAdapterFactory,
} from "../../src/provider/testUtils/replay/codexReplayAdapterFactory.ts";
import { makeReplayGate, type ReplayGate } from "../../src/provider/testUtils/replay/replayGate.ts";
import { describeReplayEntry } from "../../src/provider/testUtils/replay/replayMatch.ts";
import { splitReplaySegments } from "../../src/provider/testUtils/replay/replaySpawner.ts";
import {
  materializeWorkspace,
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
  assertProviderThreadStable,
  assertSessionStatus,
} from "./replayAssertions.ts";

const CODEX = ProviderDriverKind.make("codex");
const CODEX_INSTANCE = ProviderInstanceId.make("codex");
const PROJECT_ID = ProjectId.make("replay-project");
const THREAD_ID = ThreadId.make("replay-thread");
/** The provider thread every fixture's `thread/start` answers with. */
const PROVIDER_THREAD_ID = "019fcfd6-17bb-72f0-ae12-a1f2dee6e3e5";

const nowIso = () => new Date().toISOString();

const CODEX_FIXTURES = new URL("./fixtures/codex/", import.meta.url);
const CODEX_SCENARIOS = [
  "simple",
  "multi_turn",
  "runtime_mode_switch",
  "turn_interrupt",
  "command_approval",
  "provider_thread_resume",
] as const;
type CodexScenario = (typeof CODEX_SCENARIOS)[number];

const readCodexFixture = (scenario: CodexScenario) =>
  readReplayFixture(new URL(`${scenario}.ndjson`, CODEX_FIXTURES));

type CodexSchemaMap = Readonly<Record<string, Schema.Top | undefined>>;

/** What in one process's frames does not decode against the generated protocol schema. */
function codexProtocolProblems(entries: ReadonlyArray<ReplayEntry>): ReadonlyArray<string> {
  const problems: Array<string> = [];
  // JSON-RPC ids are per direction: the client numbers its requests, the server its own.
  const clientRequests = new Map<string, string>();
  const serverRequests = new Map<string, string>();
  const check = (
    label: string,
    schemas: CodexSchemaMap,
    method: string | undefined,
    value: unknown,
  ) => {
    if (method === undefined || !Object.hasOwn(schemas, method)) {
      problems.push(`${label}: unknown method ${String(method)}`);
      return;
    }
    const schema = schemas[method];
    if (schema === undefined) {
      if (value !== undefined) problems.push(`${label}: ${method} takes no params`);
      return;
    }
    // Excess keys are allowed: recorded frames carry fields newer than the vendored schema.
    const decoded = Schema.decodeUnknownResult(schema as Schema.Codec<unknown, unknown>)(value);
    if (Result.isFailure(decoded)) problems.push(`${label}: ${decoded.failure.message}`);
  };
  for (const entry of entries) {
    if (entry.type !== "expect_outbound" && entry.type !== "emit_inbound") continue;
    if (entry.type === "emit_inbound" && entry.stream === "stderr") continue;
    const label = describeReplayEntry(entry);
    const frame = entry.frame as {
      readonly id?: unknown;
      readonly method?: string;
      readonly params?: unknown;
      readonly result?: unknown;
    };
    const id = frame.id === undefined ? undefined : JSON.stringify(frame.id);
    const outbound = entry.type === "expect_outbound";
    if (frame.method !== undefined && id !== undefined) {
      (outbound ? clientRequests : serverRequests).set(id, frame.method);
      check(
        label,
        outbound ? CodexRpc.CLIENT_REQUEST_PARAMS : CodexRpc.SERVER_REQUEST_PARAMS,
        frame.method,
        frame.params,
      );
    } else if (frame.method !== undefined) {
      check(
        label,
        outbound ? CodexRpc.CLIENT_NOTIFICATION_PARAMS : CodexRpc.SERVER_NOTIFICATION_PARAMS,
        frame.method,
        frame.params,
      );
    } else if (id !== undefined) {
      // A response answers a request from the other side.
      check(
        label,
        outbound ? CodexRpc.SERVER_REQUEST_RESPONSES : CodexRpc.CLIENT_REQUEST_RESPONSES,
        (outbound ? serverRequests : clientRequests).get(id),
        frame.result,
      );
    } else {
      problems.push(`${label}: not a JSON-RPC frame`);
    }
  }
  return problems;
}

interface CodexReplayScenario {
  readonly harness: OrchestrationIntegrationHarness;
  readonly factory: CodexReplayAdapterFactory;
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
 * Runs `use` against a harness whose Codex adapter replays `scenario`, then requires the
 * transcript to be fully played, every tripwire untouched, and shutdown to write nothing the
 * transcript does not allow.
 */
const withCodexReplay = <A, E>(
  scenario: CodexScenario,
  use: (context: CodexReplayScenario) => Effect.Effect<A, E>,
  options?: { readonly gateLabels?: ReadonlyArray<string> },
) =>
  Effect.gen(function* () {
    const gate = yield* makeReplayGate(options?.gateLabels ?? []);
    const factory = codexReplayAdapterFactory({
      transcript: yield* readCodexFixture(scenario),
      gate,
    });
    const harness = yield* makeOrchestrationIntegrationHarness({
      provider: CODEX,
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
    const modelSelection = { instanceId: CODEX_INSTANCE, model: DEFAULT_MODEL };
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

const startTurn = (
  harness: OrchestrationIntegrationHarness,
  input: { readonly key: string; readonly text: string; readonly runtimeMode: RuntimeMode },
) =>
  harness.engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(`replay-turn-start-${input.key}`),
    threadId: THREAD_ID,
    message: {
      messageId: MessageId.make(`replay-message-${input.key}`),
      role: "user",
      text: input.text,
      attachments: [],
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: input.runtimeMode,
    createdAt: nowIso(),
  });

/**
 * The thread once the turn of message `key` settled: the session is ready, the turn ended, no
 * message is still streaming, and its answer is projected.
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
      thread.latestTurn?.userMessageId === MessageId.make(`replay-message-${key}`) &&
      thread.latestTurn.state !== "running" &&
      thread.messages.every((message) => !message.streaming) &&
      // A turn that ends without its answer item (an interrupt) projects the turn's end
      // first and the held answer text right after it.
      thread.messages.some(
        (message) => message.role === "assistant" && message.text.includes(answer),
      ),
  );

describe.skipIf(process.platform === "win32")("Codex replay through the orchestrator", () => {
  it.live("simple: one streamed turn completes and the session is ready", () =>
    withCodexReplay("simple", ({ harness, factory }) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness, "full-access");
        yield* startTurn(harness, { key: "1", text: "Say hello.", runtimeMode: "full-access" });

        const thread = yield* waitForSettledTurn(harness, "1", "Hello from replay.");
        assertMessageRoles(thread, ["user", "assistant"]);
        assertLatestTurn(thread, "completed");
        assertSessionStatus(thread, "ready");
        assertNoStreamingMessages(thread);
        yield* assertProviderThreadStable(harness, THREAD_ID, PROVIDER_THREAD_ID);
        assert.equal(factory.spawned.length, 1);
      }),
    ),
  );

  it.live("multi_turn: two turns share one app-server process and provider thread", () =>
    withCodexReplay("multi_turn", ({ harness, factory }) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness, "full-access");
        yield* startTurn(harness, {
          key: "1",
          text: "First question.",
          runtimeMode: "full-access",
        });
        yield* waitForSettledTurn(harness, "1", "First answer.");
        yield* startTurn(harness, {
          key: "2",
          text: "Second question.",
          runtimeMode: "full-access",
        });

        const thread = yield* waitForSettledTurn(harness, "2", "Second answer.");
        assertMessageRoles(thread, ["user", "assistant", "user", "assistant"]);
        assertAssistantTextIncludes(thread, "First answer.");
        assertLatestTurn(thread, "completed");
        assertSessionStatus(thread, "ready");
        yield* assertProviderThreadStable(harness, THREAD_ID, PROVIDER_THREAD_ID);
        // One thread/start in the transcript, and no second process.
        assert.equal(factory.spawned.length, 1);
      }),
    ),
  );

  // The replay twin of the CODEX_BINARY_PATH-gated live test in orchestrationEngine.integration.test.ts.
  it.live("runtime_mode_switch: a stricter mode resumes the same provider thread", () =>
    withCodexReplay("runtime_mode_switch", ({ harness, factory }) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness, "full-access");
        yield* startTurn(harness, {
          key: "1",
          text: "Reply with exactly ALPHA.",
          runtimeMode: "full-access",
        });
        yield* waitForSettledTurn(harness, "1", "ALPHA");

        // The mode is a thread setting (a turn's own runtimeMode is not applied). Changing it
        // restarts the session: a new app-server resumes the provider thread (spawn #2,
        // thread/resume, never a second thread/start).
        yield* harness.engine.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("replay-runtime-mode-set"),
          threadId: THREAD_ID,
          runtimeMode: "approval-required",
          createdAt: nowIso(),
        });
        yield* harness.waitForThread(
          THREAD_ID,
          (thread) =>
            thread.session?.status === "ready" &&
            thread.session.runtimeMode === "approval-required",
        );
        assert.equal(factory.spawned.length, 2);

        // The resumed runtime runs the turn read-only: turn/start carries
        // sandboxPolicy { type: "readOnly" }.
        yield* startTurn(harness, {
          key: "2",
          text: "Reply with exactly BETA.",
          runtimeMode: "approval-required",
        });
        const thread = yield* waitForSettledTurn(harness, "2", "BETA");
        assert.equal(thread.session?.runtimeMode, "approval-required");
        assert.equal(thread.session?.threadId, THREAD_ID);
        assertMessageRoles(thread, ["user", "assistant", "user", "assistant"]);
        assertLatestTurn(thread, "completed");
        yield* assertProviderThreadStable(harness, THREAD_ID, PROVIDER_THREAD_ID);
        assert.equal(factory.spawned.length, 2);
      }),
    ),
  );

  it.live("turn_interrupt: Stop mid-stream interrupts the provider turn", () =>
    withCodexReplay(
      "turn_interrupt",
      ({ harness, gate }) =>
        Effect.gen(function* () {
          yield* seedProjectAndThread(harness, "full-access");
          yield* startTurn(harness, {
            key: "1",
            text: "Count slowly to ten.",
            runtimeMode: "full-access",
          });
          // The replay parks before the second delta: the answer is mid-stream.
          yield* harness.waitForReplayGate(gate, "delta-2");
          yield* harness.waitForThread(
            THREAD_ID,
            (thread) =>
              thread.session?.status === "running" && thread.session.activeTurnId !== null,
          );
          yield* harness.engine.dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.make("replay-turn-interrupt"),
            threadId: THREAD_ID,
            createdAt: nowIso(),
          });
          yield* harness.waitForDomainEvent(
            (event) => event.type === "thread.turn-interrupt-requested",
          );
          // The delta already in flight still arrives; the transcript then expects
          // turn/interrupt for the running provider turn and answers turn/completed
          // "interrupted".
          yield* gate.release("delta-2");

          // The answer never completed as an item; the interrupted turn still closes it, with
          // the delta that arrived after Stop.
          const thread = yield* waitForSettledTurn(harness, "1", "One, two,");
          assertLatestTurn(thread, "interrupted");
          assertMessageRoles(thread, ["user", "assistant"]);
          assertNoStreamingMessages(thread);
          assertSessionStatus(thread, "ready");
        }),
      { gateLabels: ["delta-2"] },
    ),
  );

  it.live("command_approval: an accepted approval answers the server request", () =>
    withCodexReplay("command_approval", ({ harness }) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness, "approval-required");
        yield* startTurn(harness, {
          key: "1",
          text: "List the files.",
          runtimeMode: "approval-required",
        });

        const requested = yield* harness.waitForThread(THREAD_ID, (thread) =>
          thread.activities.some((activity) => activity.kind === "approval.requested"),
        );
        const payload = requested.activities.find(
          (activity) => activity.kind === "approval.requested",
        )?.payload as { readonly requestId: string; readonly approvalIdentity: unknown };
        const pending = yield* harness.waitForPendingApproval(
          THREAD_ID,
          payload.requestId,
          (row) => row.status === "pending",
        );
        assert.equal(pending.decision, null);

        yield* harness.engine.dispatch({
          type: "thread.approval.respond",
          commandId: CommandId.make("replay-approval-respond"),
          threadId: THREAD_ID,
          requestId: ApprovalRequestId.make(payload.requestId),
          approvalIdentity: Schema.decodeUnknownSync(ApprovalResponseIdentity)(
            payload.approvalIdentity,
          ),
          decision: "accept",
          createdAt: nowIso(),
        });
        // The transcript expects the answer to server request 0: { id: 0, result: { decision:
        // "accept" } }, with the server's id, not a client one.
        const resolved = yield* harness.waitForPendingApproval(
          THREAD_ID,
          payload.requestId,
          (row) => row.status === "resolved",
        );
        assert.equal(resolved.decision, "accept");

        const thread = yield* waitForSettledTurn(harness, "1", "The workspace has README.md.");
        assertLatestTurn(thread, "completed");
        assertActivityKinds(thread, ["approval.requested", "approval.resolved"]);
        yield* assertNoPendingApprovals(harness, THREAD_ID);
      }),
    ),
  );

  it.live("provider_thread_resume: a restarted server resumes the provider thread", () =>
    Effect.gen(function* () {
      const factory = codexReplayAdapterFactory({
        transcript: yield* readCodexFixture("provider_thread_resume"),
      });
      const first = yield* makeOrchestrationIntegrationHarness({
        provider: CODEX,
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

      // A restart: a second server on the same database. Its first turn starts a new
      // app-server process (spawn #2), which resumes the persisted provider thread.
      const second = yield* makeOrchestrationIntegrationHarness({
        provider: CODEX,
        adapterFactories: [factory],
        databasePath: first.dbPath,
      });
      yield* Effect.gen(function* () {
        yield* startTurn(second, { key: "2", text: "Which word?", runtimeMode: "full-access" });

        const thread = yield* waitForSettledTurn(second, "2", "KIWI");
        assertMessageRoles(thread, ["user", "assistant", "user", "assistant"]);
        assertAssistantTextIncludes(thread, "Noted: KIWI.");
        assertLatestTurn(thread, "completed");
        yield* assertProviderThreadStable(second, THREAD_ID, PROVIDER_THREAD_ID);
        assert.equal(factory.spawned.length, 2);
        yield* second.replays[0]!.assertConsumed;
      }).pipe(thenDispose(second));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

/**
 * Every frame of every Codex fixture against the generated app-server schema: client requests,
 * responses (matched to their request by id, per process), server requests and notifications.
 * The client drops a notification it cannot decode with only a log line, so a scenario could
 * pass on a hand-authored frame that never reached the runtime.
 */
it.effect("every Codex fixture frame follows the app-server protocol schema", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* path.fromFileUrl(CODEX_FIXTURES);
    const files = (yield* fileSystem.readDirectory(directory))
      .filter((file) => file.endsWith(".ndjson"))
      .toSorted();
    assert.includeMembers(
      files,
      CODEX_SCENARIOS.map((scenario) => `${scenario}.ndjson`),
    );

    const problems: Array<string> = [];
    for (const file of files) {
      const transcript = materializeWorkspace(
        yield* readReplayFixture(new URL(file, CODEX_FIXTURES)),
        { workspace: "/replay/workspace", home: "/replay/home" },
      );
      splitReplaySegments(transcript).forEach((segment, index) => {
        const where = `${file} spawn #${index + 1}`;
        for (const problem of codexProtocolProblems(segment.entries)) {
          problems.push(`${where} ${problem}`);
        }
      });
    }
    assert.deepEqual(problems, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);
