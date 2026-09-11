import { ASSISTANT_ATTACHMENT_INSTRUCTIONS } from "../src/assistantAttachments.ts";
import fs from "node:fs";
import path from "node:path";

import {
  ApprovalRequestId,
  CommandId,
  ContextHandoffActivityPayload,
  defaultInstanceIdForDriver,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  ModelSelection,
  type OrchestrationThread,
  ProviderInstanceId,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

import type {
  TestProviderAdapterHarness,
  TestTurnResponse,
} from "./TestProviderAdapter.integration.ts";
import {
  gitRefExists,
  gitShowFileAtRef,
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";
import { checkpointRefForThreadTurn } from "../src/checkpointing/Utils.ts";
import type {
  CheckpointDiffFinalizedReceipt,
  TurnProcessingQuiescedReceipt,
} from "../src/orchestration/Services/RuntimeReceiptBus.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const asMessageId = (value: string): MessageId => MessageId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asApprovalRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);

const PROJECT_ID = asProjectId("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const FIXTURE_TURN_ID = "fixture-turn";
const APPROVAL_REQUEST_ID = asApprovalRequestId("req-approval-1");
type IntegrationProvider = ProviderDriverKind;
const CODEX_PROVIDER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_PROVIDER = ProviderDriverKind.make("claudeAgent");

function nowIso() {
  return new Date().toISOString();
}

class IntegrationWaitTimeoutError extends Schema.TaggedError<IntegrationWaitTimeoutError>()(
  "IntegrationWaitTimeoutError",
  {
    description: Schema.String,
  },
) {}

function waitForSync<A>(
  read: () => A,
  predicate: (value: A) => boolean,
  description: string,
  timeoutMs = 10_000,
): Effect.Effect<A, never> {
  return Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const value = read();
      if (predicate(value)) {
        return value;
      }
      if (Date.now() >= deadline) {
        return yield* Effect.die(new IntegrationWaitTimeoutError({ description }));
      }
      yield* Effect.sleep(10);
    }
  });
}

function runtimeBase(
  eventId: string,
  createdAt: string,
  provider: IntegrationProvider = CODEX_PROVIDER,
) {
  return {
    eventId: asEventId(eventId),
    provider,
    createdAt,
  };
}

function withHarness<A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>,
  provider: IntegrationProvider = CODEX_PROVIDER,
) {
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider }),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));
}

function withRealCodexHarness<A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>,
) {
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider: CODEX_PROVIDER, realCodex: true }),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));
}

function withContextHandoffHarness<A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>,
) {
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({
      providers: [CODEX_PROVIDER, CLAUDE_AGENT_PROVIDER, ProviderDriverKind.make("grok")],
    }),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));
}

function completedContextHandoffs(thread: OrchestrationThread) {
  const decode = Schema.decodeUnknownOption(ContextHandoffActivityPayload);
  return thread.activities.flatMap((activity) => {
    if (activity.kind !== "context-handoff") return [];
    return Option.match(decode(activity.payload), {
      onNone: () => [],
      onSome: (payload) => (payload.status === "consumed" ? [payload] : []),
    });
  });
}

const seedProjectAndThread = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const createdAt = nowIso();
    const provider = harness.adapterHarness?.provider ?? CODEX_PROVIDER;
    const defaultModel = DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
    const instanceId = defaultInstanceIdForDriver(provider);

    yield* harness.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-project-create"),
      projectId: PROJECT_ID,
      title: "Integration Project",
      workspaceRoot: harness.workspaceDir,
      defaultModelSelection: {
        instanceId,
        model: defaultModel,
      },
      createdAt,
    });

    yield* harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread-create"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Integration Thread",
      modelSelection: {
        instanceId,
        model: defaultModel,
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: harness.workspaceDir,
      createdAt,
    });
  });

const startTurn = (input: {
  readonly harness: OrchestrationIntegrationHarness;
  readonly commandId: string;
  readonly messageId: string;
  readonly text: string;
  readonly modelSelection?: ModelSelection;
}) =>
  input.harness.engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(input.commandId),
    threadId: THREAD_ID,
    message: {
      messageId: asMessageId(input.messageId),
      role: "user",
      text: input.text,
      attachments: [],
    },
    ...(input.modelSelection !== undefined
      ? {
          modelSelection: input.modelSelection,
        }
      : {}),
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    createdAt: nowIso(),
  });

it.live("runs a single turn end-to-end and persists checkpoint state in sqlite + git", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      const turnResponse: TestTurnResponse = {
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-single-1", "2026-02-24T10:00:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-single-2", "2026-02-24T10:00:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Single turn response.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-single-3", "2026-02-24T10:00:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
      };

      yield* harness.adapterHarness!.queueTurnResponseForNextSession(turnResponse);
      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-single",
        messageId: "msg-user-single",
        text: "Say hello",
      });
      const finalizedReceipt = yield* harness.waitForReceipt(
        (receipt): receipt is CheckpointDiffFinalizedReceipt =>
          receipt.type === "checkpoint.diff.finalized" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 1,
      );
      if (finalizedReceipt.type !== "checkpoint.diff.finalized") {
        throw new Error("Expected checkpoint.diff.finalized receipt.");
      }
      assert.equal(finalizedReceipt.status, "ready");
      yield* harness.waitForReceipt(
        (receipt): receipt is TurnProcessingQuiescedReceipt =>
          receipt.type === "turn.processing.quiesced" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 1,
      );

      const thread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.session?.status === "ready" &&
          entry.messages.some(
            (message) => message.role === "assistant" && message.streaming === false,
          ) &&
          entry.checkpoints.length === 1,
      );
      assert.equal(thread.checkpoints[0]?.status, "ready");
      assert.equal(thread.checkpoints[0]?.checkpointTurnCount, 1);

      const checkpointRows = yield* harness.checkpointRepository.listByThreadId({
        threadId: THREAD_ID,
      });
      assert.equal(checkpointRows.length, 1);
      assert.equal(checkpointRows[0]?.checkpointTurnCount, 1);
      assert.equal(checkpointRows[0]?.status, "ready");
      assert.deepEqual(checkpointRows[0]?.files, []);

      const ref0 = checkpointRefForThreadTurn(THREAD_ID, 0);
      const ref1 = checkpointRefForThreadTurn(THREAD_ID, 1);
      assert.equal(gitRefExists(harness.workspaceDir, ref0), true);
      assert.equal(gitRefExists(harness.workspaceDir, ref1), true);
      assert.equal(gitShowFileAtRef(harness.workspaceDir, ref0, "README.md"), "v1\n");
      assert.equal(gitShowFileAtRef(harness.workspaceDir, ref1, "README.md"), "v1\n");
    }),
  ),
);

it.live("hands one canonical thread from Codex to Claude to Grok and back to fresh Codex", () =>
  withContextHandoffHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      const adapterFor = (provider: ProviderDriverKind) => {
        const adapter = harness.adapterHarnesses.find((entry) => entry.provider === provider);
        if (!adapter) throw new Error(`Missing integration adapter for ${provider}`);
        return adapter;
      };
      const codex = adapterFor(CODEX_PROVIDER);
      const claude = adapterFor(CLAUDE_AGENT_PROVIDER);
      const grokProvider = ProviderDriverKind.make("grok");
      const grok = adapterFor(grokProvider);
      const selectionFor = (provider: ProviderDriverKind): ModelSelection => ({
        instanceId: defaultInstanceIdForDriver(provider),
        model: DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL,
      });
      const completedResponse: TestTurnResponse = {
        events: [
          {
            type: "turn.started",
            ...runtimeBase("context-turn-started", nowIso()),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "turn.completed",
            ...runtimeBase("context-turn-completed", nowIso()),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
      };
      const waitForIdleTurn = (
        phase: string,
        userMessageCount: number,
        handoffCount: number,
        adapter: TestProviderAdapterHarness,
        sentTurnCount: number,
      ) =>
        harness
          .waitForThread(
            THREAD_ID,
            (thread) =>
              thread.session?.status === "ready" &&
              thread.latestTurn?.state === "completed" &&
              thread.messages.filter((message) => message.role === "user").length ===
                userMessageCount &&
              completedContextHandoffs(thread).length === handoffCount &&
              adapter.getSentTurns().length === sentTurnCount &&
              thread.checkpoints.some(
                (checkpoint) => checkpoint.checkpointTurnCount === userMessageCount,
              ),
            5_000,
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                const snapshot = yield* harness.snapshotQuery.getSnapshot();
                const thread = snapshot.threads.find((entry) => entry.id === THREAD_ID);
                const records = yield* harness.contextHandoffRepository.listByThread({
                  threadId: THREAD_ID,
                });
                yield* Effect.logError("context handoff integration wait failed", {
                  phase,
                  sessionStatus: thread?.session?.status,
                  sessionProvider: thread?.session?.providerName,
                  latestTurnState: thread?.latestTurn?.state,
                  handoffStatuses: records.map((record) => ({
                    status: record.status,
                    error: record.error,
                  })),
                  grokStarts: grok.getStartCount(),
                  grokSends: grok.getSentTurns().length,
                });
                return yield* Effect.failCause(cause);
              }),
            ),
          );

      yield* codex.queueTurnResponseForNextSession(completedResponse);
      yield* startTurn({
        harness,
        commandId: "cmd-context-a1-first",
        messageId: "msg-context-a1-first",
        text: "A1 first turn",
      });
      yield* waitForIdleTurn("a1-first", 1, 0, codex, 1);

      yield* codex.queueTurnResponse(THREAD_ID, completedResponse);
      yield* startTurn({
        harness,
        commandId: "cmd-context-a1-second",
        messageId: "msg-context-a1-second",
        text: "A1 ordinary second turn",
      });
      yield* waitForIdleTurn("a1-second", 2, 0, codex, 2);

      const bMessage = "  Claude handoff message 👩🏽‍💻  ";
      yield* claude.queueTurnResponseForNextSession(completedResponse);
      yield* startTurn({
        harness,
        commandId: "cmd-context-b1-first",
        messageId: "msg-context-b1-first",
        text: bMessage,
        modelSelection: selectionFor(CLAUDE_AGENT_PROVIDER),
      });
      yield* waitForIdleTurn("b1-first", 3, 1, claude, 1);

      yield* claude.queueTurnResponse(THREAD_ID, completedResponse);
      yield* startTurn({
        harness,
        commandId: "cmd-context-b1-second",
        messageId: "msg-context-b1-second",
        text: "B1 ordinary second turn",
      });
      yield* waitForIdleTurn("b1-second", 4, 1, claude, 2);

      const cMessage = "Grok handoff message";
      yield* grok.queueTurnResponseForNextSession(completedResponse);
      yield* startTurn({
        harness,
        commandId: "cmd-context-c1-first",
        messageId: "msg-context-c1-first",
        text: cMessage,
        modelSelection: selectionFor(grokProvider),
      });
      yield* waitForIdleTurn("c1-first", 5, 2, grok, 1);

      yield* grok.queueTurnResponse(THREAD_ID, completedResponse);
      yield* startTurn({
        harness,
        commandId: "cmd-context-c1-second",
        messageId: "msg-context-c1-second",
        text: "C1 ordinary second turn",
      });
      yield* waitForIdleTurn("c1-second", 6, 2, grok, 2);

      const a2Message = "Codex fresh-epoch return";
      yield* codex.queueTurnResponseForNextSession(completedResponse);
      yield* startTurn({
        harness,
        commandId: "cmd-context-a2-first",
        messageId: "msg-context-a2-first",
        text: a2Message,
        modelSelection: selectionFor(CODEX_PROVIDER),
      });
      const finalHandoffThread = yield* waitForIdleTurn("a2-first", 7, 3, codex, 3);

      yield* codex.queueTurnResponse(THREAD_ID, completedResponse);
      yield* startTurn({
        harness,
        commandId: "cmd-context-a2-second",
        messageId: "msg-context-a2-second",
        text: "A2 ordinary second turn",
      });
      yield* waitForIdleTurn("a2-second", 8, 3, codex, 4);

      const startedRuntimeSessionIds = [
        ...codex.getStartedRuntimeSessionIds(),
        ...claude.getStartedRuntimeSessionIds(),
        ...grok.getStartedRuntimeSessionIds(),
      ];
      assert.equal(startedRuntimeSessionIds.length, 4);
      assert.equal(new Set(startedRuntimeSessionIds).size, 4);

      const records = yield* harness.contextHandoffRepository.listByThread({
        threadId: THREAD_ID,
      });
      assert.equal(records.length, 3);
      assert.equal(
        records.every((record) => record.status === "consumed"),
        true,
      );
      assert.equal(
        records.every((record) => record.structuredContext !== null),
        true,
      );
      assert.equal(completedContextHandoffs(finalHandoffThread).length, 3);

      const claudeTurns = claude.getSentTurns();
      const grokTurns = grok.getSentTurns();
      const codexTurns = codex.getSentTurns();
      const assertHandoffInput = (input: string, exactMessage: string) => {
        assert.equal((input.match(/<context_handoff /g) ?? []).length, 1);
        assert.equal(
          input.endsWith(`<current_user_message>\n${exactMessage}\n</current_user_message>`),
          true,
        );
      };
      assertHandoffInput(claudeTurns[0]!.input ?? "", bMessage);
      assertHandoffInput(grokTurns[0]!.input ?? "", cMessage);
      assertHandoffInput(codexTurns[2]!.input ?? "", a2Message);
      assert.equal(
        claudeTurns[1]!.input,
        `${ASSISTANT_ATTACHMENT_INSTRUCTIONS}\n\nB1 ordinary second turn`,
      );
      assert.equal(
        grokTurns[1]!.input,
        `${ASSISTANT_ATTACHMENT_INSTRUCTIONS}\n\nC1 ordinary second turn`,
      );
      assert.equal(
        codexTurns[1]!.input,
        `${ASSISTANT_ATTACHMENT_INSTRUCTIONS}\n\nA1 ordinary second turn`,
      );
      assert.equal(
        codexTurns[3]!.input,
        `${ASSISTANT_ATTACHMENT_INSTRUCTIONS}\n\nA2 ordinary second turn`,
      );
    }),
  ),
);

it.live.skipIf(!process.env.CODEX_BINARY_PATH)(
  "keeps the same Codex provider thread across runtime mode switches",
  () =>
    withRealCodexHarness((harness) =>
      Effect.gen(function* () {
        const createdAt = nowIso();

        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project-create-real-codex"),
          projectId: PROJECT_ID,
          title: "Integration Project",
          workspaceRoot: harness.workspaceDir,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
          },
          createdAt,
        });

        yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create-real-codex"),
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Integration Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: harness.workspaceDir,
          createdAt,
        });

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-real-codex-1"),
          threadId: THREAD_ID,
          message: {
            messageId: asMessageId("msg-real-codex-1"),
            role: "user",
            text: "Reply with exactly ALPHA.",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt: nowIso(),
        });

        const firstThread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.session?.status === "ready" &&
            entry.session.providerName === "codex" &&
            entry.messages.some(
              (message) => message.role === "assistant" && message.streaming === false,
            ),
          180_000,
        );
        assert.equal(firstThread.session?.threadId, "thread-1");

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-real-codex-2"),
          threadId: THREAD_ID,
          message: {
            messageId: asMessageId("msg-real-codex-2"),
            role: "user",
            text: "Reply with exactly BETA.",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: nowIso(),
        });

        const secondThread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.session?.status === "ready" &&
            entry.session.providerName === "codex" &&
            entry.session.runtimeMode === "approval-required" &&
            entry.messages.some(
              (message) => message.role === "assistant" && message.text.includes("BETA"),
            ),
          180_000,
        );
        assert.equal(secondThread.session?.threadId, "thread-1");
      }),
    ),
);

it.live("runs multi-turn file edits and persists checkpoint diffs", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-multi-1", "2026-02-24T10:01:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "tool.started",
            ...runtimeBase("evt-multi-2", "2026-02-24T10:01:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "tool.completed",
            ...runtimeBase("evt-multi-3", "2026-02-24T10:01:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-multi-4", "2026-02-24T10:01:00.300Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Updated README to v2.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-multi-5", "2026-02-24T10:01:00.400Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
        mutateWorkspace: ({ cwd }) =>
          Effect.sync(() => {
            fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8");
          }),
      });

      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-multi-1",
        messageId: "msg-user-multi-1",
        text: "Make first edit",
      });
      yield* harness.waitForReceipt(
        (receipt): receipt is CheckpointDiffFinalizedReceipt =>
          receipt.type === "checkpoint.diff.finalized" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 1,
      );

      yield* harness.waitForThread(
        THREAD_ID,
        (entry) => entry.checkpoints.length === 1 && entry.session?.threadId === "thread-1",
      );

      yield* harness.adapterHarness!.queueTurnResponse(THREAD_ID, {
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-multi-6", "2026-02-24T10:02:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-multi-7", "2026-02-24T10:02:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Updated README to v3.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-multi-8", "2026-02-24T10:02:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
        mutateWorkspace: ({ cwd }) =>
          Effect.sync(() => {
            fs.writeFileSync(path.join(cwd, "README.md"), "v3\n", "utf8");
          }),
      });

      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-multi-2",
        messageId: "msg-user-multi-2",
        text: "Make second edit",
      });
      const secondReceipt = yield* harness.waitForReceipt(
        (receipt): receipt is CheckpointDiffFinalizedReceipt =>
          receipt.type === "checkpoint.diff.finalized" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 2,
      );
      if (secondReceipt.type !== "checkpoint.diff.finalized") {
        throw new Error("Expected checkpoint.diff.finalized receipt.");
      }
      assert.equal(secondReceipt.status, "ready");
      yield* harness.waitForReceipt(
        (receipt): receipt is TurnProcessingQuiescedReceipt =>
          receipt.type === "turn.processing.quiesced" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 2,
      );

      const secondTurnThread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.latestTurn?.turnId === "turn-2" &&
          entry.checkpoints.length === 2 &&
          entry.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 2),
      );
      const secondCheckpoint = secondTurnThread.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === 2,
      );
      assert.equal(
        secondCheckpoint?.files.some((file) => file.path === "README.md"),
        true,
      );

      const checkpointRows = yield* harness.checkpointRepository.listByThreadId({
        threadId: THREAD_ID,
      });
      assert.deepEqual(
        checkpointRows.map((row) => row.checkpointTurnCount),
        [1, 2],
      );

      const incrementalDiff = yield* harness.checkpointStore.diffCheckpoints({
        cwd: harness.workspaceDir,
        fromCheckpointRef: checkpointRefForThreadTurn(THREAD_ID, 1),
        toCheckpointRef: checkpointRefForThreadTurn(THREAD_ID, 2),
        fallbackFromToHead: false,
        ignoreWhitespace: false,
      });
      assert.equal(incrementalDiff.includes("README.md"), true);

      const fullDiff = yield* harness.checkpointStore.diffCheckpoints({
        cwd: harness.workspaceDir,
        fromCheckpointRef: checkpointRefForThreadTurn(THREAD_ID, 0),
        toCheckpointRef: checkpointRefForThreadTurn(THREAD_ID, 2),
        fallbackFromToHead: false,
        ignoreWhitespace: false,
      });
      assert.equal(fullDiff.includes("README.md"), true);

      assert.equal(
        gitShowFileAtRef(
          harness.workspaceDir,
          checkpointRefForThreadTurn(THREAD_ID, 1),
          "README.md",
        ),
        "v2\n",
      );
      assert.equal(
        gitShowFileAtRef(
          harness.workspaceDir,
          checkpointRefForThreadTurn(THREAD_ID, 2),
          "README.md",
        ),
        "v3\n",
      );
    }),
  ),
);

it.live("tracks approval requests and resolves pending approvals on user response", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        completeTurn: false,
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-approval-1", "2026-02-24T10:03:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "approval.requested",
            ...runtimeBase("evt-approval-2", "2026-02-24T10:03:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            requestId: APPROVAL_REQUEST_ID,
            requestKind: "command",
            detail: "Approve command execution",
          },
          // Keep the turn open while awaiting approval. A completed turn clears
          // its pending requests before the user can respond.
        ],
      });

      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-approval",
        messageId: "msg-user-approval",
        text: "Run command needing approval",
      });

      const thread = yield* harness.waitForThread(THREAD_ID, (entry) =>
        entry.activities.some((activity) => activity.kind === "approval.requested"),
      );
      assert.equal(
        thread.activities.some((activity) => activity.kind === "approval.requested"),
        true,
      );

      const pendingRow = yield* harness.waitForPendingApproval(
        "req-approval-1",
        (row) => row.status === "pending" && row.decision === null,
      );
      assert.equal(pendingRow.status, "pending");

      yield* harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond"),
        threadId: THREAD_ID,
        requestId: APPROVAL_REQUEST_ID,
        decision: "accept",
        createdAt: nowIso(),
      });

      const resolvedRow = yield* harness.waitForPendingApproval(
        "req-approval-1",
        (row) => row.status === "resolved" && row.decision === "accept",
      );
      assert.equal(resolvedRow.status, "resolved");
      assert.equal(resolvedRow.decision, "accept");

      const approvalResponses = yield* waitForSync(
        () => harness.adapterHarness!.getApprovalResponses(THREAD_ID),
        (responses) => responses.length === 1,
        "provider approval response",
      );
      assert.equal(approvalResponses.length, 1);
      assert.equal(approvalResponses[0]?.requestId, "req-approval-1");
      assert.equal(approvalResponses[0]?.decision, "accept");
    }),
  ),
);

it.live("records failed turn runtime state and checkpoint status as error", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-failure-1", "2026-02-24T10:04:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "content.delta",
            ...runtimeBase("evt-failure-2", "2026-02-24T10:04:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            payload: {
              streamKind: "assistant_text",
              delta: "Partial output before failure.\n",
            },
          },
          {
            type: "runtime.error",
            ...runtimeBase("evt-failure-3", "2026-02-24T10:04:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            payload: {
              message: "Sandbox command failed.",
            },
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-failure-4", "2026-02-24T10:04:00.300Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            payload: {
              state: "failed",
              errorMessage: "Sandbox command failed.",
            },
          },
        ],
      });

      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-failure",
        messageId: "msg-user-failure",
        text: "Run risky command",
      });

      const thread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.session?.status === "error" &&
          entry.session?.lastError === "Sandbox command failed." &&
          entry.activities.some((activity) => activity.kind === "runtime.error") &&
          entry.checkpoints.length === 1,
      );
      assert.equal(thread.session?.status, "error");
      assert.equal(thread.checkpoints[0]?.status, "error");

      const checkpointRow = yield* harness.checkpointRepository.getByThreadAndTurnCount({
        threadId: THREAD_ID,
        checkpointTurnCount: 1,
      });
      assert.equal(Option.isSome(checkpointRow), true);
      if (Option.isSome(checkpointRow)) {
        assert.equal(checkpointRow.value.status, "error");
      }
      assert.equal(
        gitRefExists(harness.workspaceDir, checkpointRefForThreadTurn(THREAD_ID, 1)),
        true,
      );
    }),
  ),
);

it.live("reverts to an earlier checkpoint and trims checkpoint projections + git refs", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-revert-1", "2026-02-24T10:05:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "tool.started",
            ...runtimeBase("evt-revert-1-tool-started", "2026-02-24T10:05:00.025Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "tool.completed",
            ...runtimeBase("evt-revert-1-tool-completed", "2026-02-24T10:05:00.035Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-revert-1a", "2026-02-24T10:05:00.050Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Updated README to v2.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-revert-2", "2026-02-24T10:05:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
        mutateWorkspace: ({ cwd }) =>
          Effect.sync(() => {
            fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8");
          }),
      });
      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-revert-1",
        messageId: "msg-user-revert-1",
        text: "First edit",
      });

      yield* harness.waitForThread(
        THREAD_ID,
        (entry) => entry.session?.threadId === "thread-1" && entry.checkpoints.length === 1,
      );

      yield* harness.adapterHarness!.queueTurnResponse(THREAD_ID, {
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-revert-3", "2026-02-24T10:05:01.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "tool.started",
            ...runtimeBase("evt-revert-3-tool-started", "2026-02-24T10:05:01.025Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "tool.completed",
            ...runtimeBase("evt-revert-3-tool-completed", "2026-02-24T10:05:01.035Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-revert-3a", "2026-02-24T10:05:01.050Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Updated README to v3.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-revert-4", "2026-02-24T10:05:01.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
        mutateWorkspace: ({ cwd }) =>
          Effect.sync(() => {
            fs.writeFileSync(path.join(cwd, "README.md"), "v3\n", "utf8");
          }),
      });
      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-revert-2",
        messageId: "msg-user-revert-2",
        text: "Second edit",
      });

      yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.latestTurn?.turnId === "turn-2" &&
          entry.checkpoints.length === 2 &&
          entry.activities.some((activity) => activity.turnId === "turn-2"),
        8000,
      );

      yield* harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-checkpoint-revert"),
        threadId: THREAD_ID,
        turnCount: 1,
        createdAt: nowIso(),
      });

      yield* harness.waitForDomainEvent((event) => event.type === "thread.reverted");
      const revertedThread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.checkpoints.length === 1 && entry.checkpoints[0]?.checkpointTurnCount === 1,
      );
      assert.equal(revertedThread.checkpoints[0]?.checkpointTurnCount, 1);
      assert.deepEqual(
        revertedThread.messages.map((message) => ({ role: message.role, text: message.text })),
        [
          { role: "user", text: "First edit" },
          { role: "assistant", text: "Updated README to v2.\n" },
        ],
      );
      assert.equal(
        revertedThread.activities.some((activity) => activity.turnId === "turn-2"),
        false,
      );
      assert.equal(
        revertedThread.activities.some(
          (activity) => activity.turnId === "turn-1" && activity.kind === "tool.started",
        ),
        true,
      );
      assert.equal(
        revertedThread.activities.some(
          (activity) => activity.turnId === "turn-1" && activity.kind === "tool.completed",
        ),
        true,
      );
      assert.equal(fs.readFileSync(path.join(harness.workspaceDir, "README.md"), "utf8"), "v2\n");
      assert.equal(
        gitRefExists(harness.workspaceDir, checkpointRefForThreadTurn(THREAD_ID, 2)),
        false,
      );
      assert.deepEqual(harness.adapterHarness!.getRollbackCalls(THREAD_ID), [1]);

      const checkpointRows = yield* harness.checkpointRepository.listByThreadId({
        threadId: THREAD_ID,
      });
      assert.equal(checkpointRows.length, 1);
    }),
  ),
);

it.live(
  "appends checkpoint.revert.failed activity when revert is requested without an active session",
  () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.make("cmd-checkpoint-revert-no-session"),
          threadId: THREAD_ID,
          turnCount: 0,
          createdAt: nowIso(),
        });

        const thread = yield* harness.waitForThread(THREAD_ID, (entry) =>
          entry.activities.some(
            (activity) =>
              activity.kind === "checkpoint.revert.failed" &&
              typeof activity.payload === "object" &&
              activity.payload !== null,
          ),
        );
        const failureActivity = thread.activities.find(
          (activity) => activity.kind === "checkpoint.revert.failed",
        );
        assert.equal(failureActivity !== undefined, true);
        assert.equal(
          String(
            (failureActivity?.payload as { readonly detail?: string } | undefined)?.detail,
          ).includes("No active provider session"),
          true,
        );
      }),
    ),
);

it.live("starts a claudeAgent session on first turn when provider is requested", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase(
                "evt-claude-start-1",
                "2026-02-24T10:10:00.000Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase(
                "evt-claude-start-2",
                "2026-02-24T10:10:00.050Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "Claude first turn.\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase(
                "evt-claude-start-3",
                "2026-02-24T10:10:00.100Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-initial",
          messageId: "msg-user-claude-initial",
          text: "Use Claude",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
        });

        const thread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.session?.providerName === "claudeAgent" &&
            entry.session.status === "ready" &&
            entry.messages.some(
              (message) => message.role === "assistant" && message.text === "Claude first turn.\n",
            ),
        );
        assert.equal(thread.session?.providerName, "claudeAgent");
      }),
    CLAUDE_AGENT_PROVIDER,
  ),
);

it.live("recovers claudeAgent sessions after provider stopAll using persisted resume state", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase(
                "evt-claude-recover-1",
                "2026-02-24T10:11:00.000Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase(
                "evt-claude-recover-2",
                "2026-02-24T10:11:00.050Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "Turn before restart.\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase(
                "evt-claude-recover-3",
                "2026-02-24T10:11:00.100Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-recover-1",
          messageId: "msg-user-claude-recover-1",
          text: "Before restart",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
        });

        yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.latestTurn?.turnId === "turn-1" && entry.session?.threadId === "thread-1",
        );

        yield* harness.adapterHarness!.adapter.stopAll();
        yield* waitForSync(
          () => harness.adapterHarness!.listActiveSessionIds(),
          (sessionIds) => sessionIds.length === 0,
          "provider stopAll",
        );

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase(
                "evt-claude-recover-4",
                "2026-02-24T10:11:01.000Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase(
                "evt-claude-recover-5",
                "2026-02-24T10:11:01.050Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "Turn after restart.\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase(
                "evt-claude-recover-6",
                "2026-02-24T10:11:01.100Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-recover-2",
          messageId: "msg-user-claude-recover-2",
          text: "After restart",
        });
        yield* waitForSync(
          () => harness.adapterHarness!.getStartCount(),
          (count) => count === 2,
          "claude provider recovery start",
        );

        const recoveredThread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.session?.providerName === "claudeAgent" &&
            entry.messages.some(
              (message) => message.role === "user" && message.text === "After restart",
            ) &&
            !entry.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
        );
        assert.equal(recoveredThread.session?.providerName, "claudeAgent");
        assert.equal(recoveredThread.session?.threadId, "thread-1");
      }),
    CLAUDE_AGENT_PROVIDER,
  ),
);

it.live("forwards claudeAgent approval responses to the provider session", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase(
                "evt-claude-approval-1",
                "2026-02-24T10:12:00.000Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "approval.requested",
              ...runtimeBase(
                "evt-claude-approval-2",
                "2026-02-24T10:12:00.050Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              requestId: APPROVAL_REQUEST_ID,
              requestKind: "command",
              detail: "Approve Claude tool call",
            },
            {
              type: "turn.completed",
              ...runtimeBase(
                "evt-claude-approval-3",
                "2026-02-24T10:12:00.100Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-approval",
          messageId: "msg-user-claude-approval",
          text: "Need approval",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
        });

        const thread = yield* harness.waitForThread(THREAD_ID, (entry) =>
          entry.activities.some((activity) => activity.kind === "approval.requested"),
        );
        assert.equal(thread.session?.threadId, "thread-1");

        yield* harness.engine.dispatch({
          type: "thread.approval.respond",
          commandId: CommandId.make("cmd-claude-approval-respond"),
          threadId: THREAD_ID,
          requestId: APPROVAL_REQUEST_ID,
          decision: "accept",
          createdAt: nowIso(),
        });

        yield* harness.waitForPendingApproval(
          "req-approval-1",
          (row) => row.status === "resolved" && row.decision === "accept",
        );

        const approvalResponses = yield* waitForSync(
          () => harness.adapterHarness!.getApprovalResponses(THREAD_ID),
          (responses) => responses.length === 1,
          "claude provider approval response",
        );
        assert.equal(approvalResponses[0]?.decision, "accept");
      }),
    CLAUDE_AGENT_PROVIDER,
  ),
);

it.live("forwards thread.turn.interrupt to claudeAgent provider sessions", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase(
                "evt-claude-interrupt-1",
                "2026-02-24T10:13:00.000Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase(
                "evt-claude-interrupt-2",
                "2026-02-24T10:13:00.050Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "Long running output.\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase(
                "evt-claude-interrupt-3",
                "2026-02-24T10:13:00.100Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-interrupt",
          messageId: "msg-user-claude-interrupt",
          text: "Start long turn",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
        });

        const thread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) => entry.session?.threadId === "thread-1",
        );
        assert.equal(thread.session?.threadId, "thread-1");

        yield* harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make("cmd-turn-interrupt-claude"),
          threadId: THREAD_ID,
          createdAt: nowIso(),
        });
        yield* harness.waitForDomainEvent(
          (event) => event.type === "thread.turn-interrupt-requested",
        );

        const interruptCalls = yield* waitForSync(
          () => harness.adapterHarness!.getInterruptCalls(THREAD_ID),
          (calls) => calls.length === 1,
          "claude provider interrupt call",
        );
        assert.equal(interruptCalls.length, 1);
      }),
    CLAUDE_AGENT_PROVIDER,
  ),
);

it.live("reverts claudeAgent turns and rolls back provider conversation state", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase(
                "evt-claude-revert-1",
                "2026-02-24T10:14:00.000Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase(
                "evt-claude-revert-2",
                "2026-02-24T10:14:00.050Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "README -> v2\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase(
                "evt-claude-revert-3",
                "2026-02-24T10:14:00.100Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
          mutateWorkspace: ({ cwd }) =>
            Effect.sync(() => {
              fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8");
            }),
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-revert-1",
          messageId: "msg-user-claude-revert-1",
          text: "First Claude edit",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
        });

        yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.latestTurn?.turnId === "turn-1" &&
            entry.latestTurn.state === "completed" &&
            entry.session?.threadId === "thread-1" &&
            entry.session.activeTurnId === null,
        );

        yield* harness.adapterHarness!.queueTurnResponse(THREAD_ID, {
          events: [
            {
              type: "turn.started",
              ...runtimeBase(
                "evt-claude-revert-4",
                "2026-02-24T10:14:01.000Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase(
                "evt-claude-revert-5",
                "2026-02-24T10:14:01.050Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "README -> v3\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase(
                "evt-claude-revert-6",
                "2026-02-24T10:14:01.100Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
          mutateWorkspace: ({ cwd }) =>
            Effect.sync(() => {
              fs.writeFileSync(path.join(cwd, "README.md"), "v3\n", "utf8");
            }),
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-revert-2",
          messageId: "msg-user-claude-revert-2",
          text: "Second Claude edit",
        });

        yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.latestTurn?.turnId === "turn-2" &&
            entry.latestTurn.state === "completed" &&
            entry.checkpoints.length === 2 &&
            entry.session?.providerName === "claudeAgent" &&
            entry.session.activeTurnId === null,
        );

        yield* harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.make("cmd-checkpoint-revert-claude"),
          threadId: THREAD_ID,
          turnCount: 1,
          createdAt: nowIso(),
        });

        const revertedThread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.checkpoints.length === 1 && entry.checkpoints[0]?.checkpointTurnCount === 1,
        );
        assert.equal(revertedThread.checkpoints[0]?.checkpointTurnCount, 1);
        assert.equal(
          gitRefExists(harness.workspaceDir, checkpointRefForThreadTurn(THREAD_ID, 1)),
          true,
        );
        assert.equal(
          gitRefExists(harness.workspaceDir, checkpointRefForThreadTurn(THREAD_ID, 2)),
          false,
        );
        assert.deepEqual(harness.adapterHarness!.getRollbackCalls(THREAD_ID), [1]);
      }),
    CLAUDE_AGENT_PROVIDER,
  ),
);
