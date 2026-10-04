// @effect-diagnostics nodeBuiltinImport:off
import * as path from "node:path";
import * as os from "node:os";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  GrokSettings,
  ProviderDriverKind,
  ThreadId,
  ProviderInstanceId,
  RuntimeSessionId,
  type ProviderRuntimeEvent,
} from "@ryco/contracts";

import { ServerConfig } from "../../config.ts";
import { makeGrokAdapter } from "./GrokAdapter.ts";
const decodeGrokSettings = Schema.decodeSync(GrokSettings);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockGrokWrapper(extraEnv?: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grok-acp-mock-"));
  const wrapperPath = path.join(dir, "fake-grok.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await writeFile(wrapperPath, script, "utf8");
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function waitForFileContent(filePath: string, attempts = 40): Promise<string> {
  const readAttempt = async (remainingAttempts: number): Promise<string> => {
    if (remainingAttempts <= 0) {
      throw new Error(`Timed out waiting for file content at ${filePath}`);
    }
    try {
      const raw = await readFile(filePath, "utf8");
      if (raw.trim().length > 0) {
        return raw;
      }
    } catch {}
    await Effect.runPromise(Effect.sleep("25 millis"));
    return readAttempt(remainingAttempts - 1);
  };
  return readAttempt(attempts);
}

async function readJsonLines(filePath: string) {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const grokAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "ryco-grok-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeGrokAdapter>[1]) =>
  makeGrokAdapter(decodeGrokSettings({ binaryPath }), options).pipe(Effect.orDie);

it.layer(grokAdapterTestLayer)("GrokAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-mock-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ RYCO_ACP_EMIT_USAGE_UPDATE: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-grokadapter-1"),
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-mock-alt" },
      });

      assert.equal(session.provider, "grok");
      assert.equal(session.model, "grok-mock-alt");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello grok",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      assert.equal(
        runtimeEvents.every(
          (event) =>
            event.providerInstanceId === ProviderInstanceId.make("grok") &&
            event.runtimeSessionId === session.runtimeSessionId,
        ),
        true,
      );
      const types = runtimeEvents.map((e) => e.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "thread.token-usage.updated",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      const usage = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.isDefined(usage);
      if (usage?.type === "thread.token-usage.updated") {
        assert.equal(usage.payload.usage.usedTokens, 321);
        assert.equal(usage.payload.usage.maxTokens, 128_000);
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        mkdtemp(path.join(os.tmpdir(), "grok-adapter-exit-log-")),
      );
      const exitLogPath = path.join(tempDir, "exit.log");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          RYCO_ACP_EXIT_LOG_PATH: exitLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-grokadapter-2"),
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      yield* adapter.stopSession(threadId);

      const exitLog = yield* Effect.promise(() => waitForFileContent(exitLogPath));
      assert.include(exitLog, "SIGTERM");
    }),
  );

  it.effect("rejects startSession when provider mismatches", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("grok-provider-mismatch");

      const error = yield* Effect.flip(
        adapter.startSession({
          runtimeSessionId: RuntimeSessionId.make("test-grokadapter-3"),
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
    }),
  );

  it.effect("rejects malformed resume cursors without replacing the active session", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("grok-invalid-resume-cursor");

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-grokadapter-4"),
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const invalidResumeCursors: ReadonlyArray<unknown> = [
        null,
        "mock-session-1",
        {},
        { schemaVersion: 2, sessionId: "mock-session-1" },
        { schemaVersion: 1 },
        { schemaVersion: 1, sessionId: "   " },
      ];

      for (const resumeCursor of invalidResumeCursors) {
        const error = yield* Effect.flip(
          adapter.startSession({
            runtimeSessionId: RuntimeSessionId.make("test-grokadapter-5"),
            threadId,
            provider: ProviderDriverKind.make("grok"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
            resumeCursor,
          }),
        );

        assert.equal(error._tag, "ProviderAdapterValidationError");
        if (error._tag === "ProviderAdapterValidationError") {
          assert.equal(
            error.issue,
            "resumeCursor must use schema version 1 and contain a non-empty sessionId.",
          );
        }
        assert.isTrue(yield* adapter.hasSession(threadId));
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects sendTurn with empty input and no attachments", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-empty-turn");

      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-grokadapter-6"),
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "   ",
          attachments: [],
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("degrades file attachments to on-disk path lines in the prompt text", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-file-attachment");
      const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "grok-acp-")));
      const requestLogPath = path.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ RYCO_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const { attachmentsDir } = yield* ServerConfig;
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-grokadapter-file-attachment"),
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const fileAttachment = {
        type: "file" as const,
        id: "grok-file-attachment-12345678-1234-1234-1234-123456789abc",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 123456,
      };
      yield* adapter.sendTurn({
        threadId,
        input: "review the file",
        attachments: [fileAttachment],
      });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const promptRequest = requests.find((entry) => entry.method === "session/prompt");
      assert.isDefined(promptRequest);
      const prompt = (promptRequest?.params as { prompt: Array<Record<string, unknown>> }).prompt;
      const textBlock = prompt.find((block) => block.type === "text") as
        | { text: string }
        | undefined;
      assert.isDefined(textBlock);
      assert.ok(textBlock.text.includes("review the file"));
      assert.ok(
        textBlock.text.includes(
          `[Attached file] report.pdf (application/pdf, 123456 bytes) saved at: ${path.join(
            attachmentsDir,
            `${fileAttachment.id}.bin`,
          )}`,
        ),
      );
      assert.equal(
        prompt.some((block) => block.type === "image"),
        false,
      );
    }),
  );

  it.effect("applies a model change to the live session without restarting", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-in-session-model-switch");
      const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "grok-acp-")));
      const requestLogPath = path.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ RYCO_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      assert.equal(adapter.capabilities.sessionModelSwitch, "in-session");

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-grokadapter-model-switch"),
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });
      yield* adapter.sendTurn({
        threadId,
        input: "continue on the other model",
        attachments: [],
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-mock-alt" },
      });

      const [live] = yield* adapter.listSessions();
      assert.equal(live?.model, "grok-mock-alt");
      assert.deepStrictEqual(live?.resumeCursor, session.resumeCursor);
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const methods = requests.map((entry) => entry.method);
      assert.equal(methods.filter((method) => method === "session/new").length, 1);
      assert.equal(methods.includes("session/load"), false);
      const setModel = requests.find((entry) => entry.method === "session/set_model");
      assert.equal(
        (setModel?.params as { readonly modelId?: string } | undefined)?.modelId,
        "grok-mock-alt",
      );
    }),
  );

  it.effect("responds to ACP approvals using provider-supplied option ids", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-custom-approval-option-id");
      const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "grok-acp-")));
      const requestLogPath = path.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          RYCO_ACP_REQUEST_LOG_PATH: requestLogPath,
          RYCO_ACP_EMIT_TOOL_CALLS: "1",
          RYCO_ACP_ALLOW_ONCE_OPTION_ID: "agent-defined-approval-id",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "accept",
            )
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-grokadapter-7"),
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "approve this", attachments: [] });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(
        requests.some(
          (entry) =>
            !("method" in entry) &&
            typeof entry.result === "object" &&
            entry.result !== null &&
            "outcome" in entry.result &&
            typeof entry.result.outcome === "object" &&
            entry.result.outcome !== null &&
            "optionId" in entry.result.outcome &&
            entry.result.outcome.optionId === "agent-defined-approval-id",
        ),
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("handles xAI ask_user_question extension requests", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-xai-ask-user-question");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ RYCO_ACP_EMIT_XAI_ASK_USER_QUESTION: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-grokadapter-8"),
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask before continuing", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      assert.equal(requestedEvent.payload.questions.length, 1);
      assert.equal(requestedEvent.payload.questions[0]?.id, "Which scope should Grok use?");
      assert.equal(requestedEvent.payload.questions[0]?.question, "Which scope should Grok use?");
      assert.equal(requestedEvent.raw?.method, "_x.ai/ask_user_question");

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requestedEvent.requestId)),
        {
          "Which scope should Grok use?": "Workspace",
        },
      );

      const resolvedEvent = yield* Deferred.await(resolved);
      assert.deepEqual(resolvedEvent.payload.answers, {
        "Which scope should Grok use?": "Workspace",
      });
      yield* Fiber.join(sendTurnFiber);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("continues streaming events when native notification logging fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-native-log-failure");
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath, {
        nativeEventLogger: {
          filePath: "memory://grok-native-events",
          write: (record: unknown) =>
            typeof record === "object" &&
            record !== null &&
            "event" in record &&
            typeof record.event === "object" &&
            record.event !== null &&
            "kind" in record.event &&
            record.event.kind === "notification"
              ? Effect.die(new Error("native log write failed"))
              : Effect.void,
          close: () => Effect.void,
        },
      });
      const contentDelta = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "content.delta" ? Deferred.succeed(contentDelta, undefined) : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-grokadapter-9"),
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "keep streaming", attachments: [] });
      yield* Deferred.await(contentDelta);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );
});
