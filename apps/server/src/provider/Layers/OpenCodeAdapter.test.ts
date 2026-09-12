import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  Context,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Schema,
  Scope,
  Stream,
} from "effect";
import { beforeEach } from "vite-plus/test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import {
  ApprovalRequestId,
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
} from "@ryco/contracts";
import { createModelSelection } from "@ryco/shared/model";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { agentControlHostContext } from "../../agentControl/ProviderInjection.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  isOpenCodeNativeAttachment,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
  OPENCODE_NATIVE_ATTACHMENT_MAX_BYTES,
} from "../opencodeRuntime.ts";
import {
  appendOpenCodeAssistantTextDelta,
  makeOpenCodeAdapter,
  mergeOpenCodeAssistantText,
} from "./OpenCodeAdapter.ts";

// Test-local service tag so the rest of the file can keep using `yield* OpenCodeAdapter`.
class OpenCodeAdapter extends Context.Service<OpenCodeAdapter, OpenCodeAdapterShape>()(
  "test/OpenCodeAdapter",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);

type MessageEntry = {
  info: {
    id: string;
    role: "user" | "assistant";
  };
  parts: Array<unknown>;
};

const runtimeMock = {
  state: {
    startCalls: [] as string[],
    sessionCreateUrls: [] as string[],
    sessionGetCalls: [] as string[],
    sessionUpdateCalls: [] as string[],
    resumableSession: null as { id: string; directory?: string } | null,
    authHeaders: [] as Array<string | null>,
    abortCalls: [] as string[],
    abortErrorSessionIds: new Set<string>(),
    permissionRespondCalls: [] as Array<{
      sessionID: string;
      permissionID: string;
      response?: "once" | "always" | "reject";
    }>,
    pendingPermissions: [] as Array<{
      id: string;
      sessionID: string;
      permission: string;
      patterns: string[];
      metadata: Record<string, unknown>;
      always: string[];
    }>,
    pendingQuestions: [] as Array<{
      id: string;
      sessionID: string;
      questions: Array<{
        header: string;
        question: string;
        options: Array<{ label: string; description: string }>;
        multiple?: boolean;
      }>;
    }>,
    questionReplyCalls: [] as Array<{ requestID: string; answers: Array<Array<string>> }>,
    closeCalls: [] as string[],
    revertCalls: [] as Array<{ sessionID: string; messageID?: string }>,
    promptCalls: [] as Array<unknown>,
    promptAsyncError: null as Error | null,
    promptAsyncHandler: null as
      | ((input: unknown, signal: AbortSignal | undefined) => Promise<void>)
      | null,
    closeError: null as Error | null,
    messages: [] as MessageEntry[],
    children: [] as Array<unknown>,
    subscribedEvents: [] as unknown[],
    subscribeError: null as Error | null,
    streamReadError: null as Error | null,
    startupOrder: [] as string[],
  },
  reset() {
    this.state.startCalls.length = 0;
    this.state.sessionCreateUrls.length = 0;
    this.state.sessionGetCalls.length = 0;
    this.state.sessionUpdateCalls.length = 0;
    this.state.resumableSession = null;
    this.state.authHeaders.length = 0;
    this.state.abortCalls.length = 0;
    this.state.abortErrorSessionIds.clear();
    this.state.permissionRespondCalls.length = 0;
    this.state.pendingPermissions = [];
    this.state.pendingQuestions = [];
    this.state.questionReplyCalls.length = 0;
    this.state.closeCalls.length = 0;
    this.state.revertCalls.length = 0;
    this.state.promptCalls.length = 0;
    this.state.promptAsyncError = null;
    this.state.promptAsyncHandler = null;
    this.state.closeError = null;
    this.state.messages = [];
    this.state.children = [];
    this.state.subscribedEvents = [];
    this.state.subscribeError = null;
    this.state.streamReadError = null;
    this.state.startupOrder = [];
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: ({ binaryPath }) =>
    Effect.gen(function* () {
      runtimeMock.state.startCalls.push(binaryPath);
      const url = "http://127.0.0.1:4301";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
          if (runtimeMock.state.closeError) {
            throw runtimeMock.state.closeError;
          }
        }),
      );
      return {
        url,
        exitCode: Effect.never,
      };
    }),
  connectToOpenCodeServer: ({ serverUrl, serverPassword }) =>
    Effect.gen(function* () {
      const url = serverUrl ?? "http://127.0.0.1:4301";
      // Unconditionally register a scope finalizer for test observability —
      // preserves the `closeCalls` / `closeError` probes that the existing
      // suites rely on. Production code never attaches a finalizer to an
      // external server (it simply returns `Effect.succeed(...)`).
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
          if (runtimeMock.state.closeError) {
            throw runtimeMock.state.closeError;
          }
        }),
      );
      return {
        url,
        ...(serverPassword ? { serverPassword } : {}),
        exitCode: null,
        external: Boolean(serverUrl),
      };
    }),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: ({ baseUrl, serverPassword }) =>
    Effect.succeed({
      global: {
        health: async () => ({ data: { healthy: true, version: "1.18.18" } }),
      },
      session: {
        create: async () => {
          runtimeMock.state.sessionCreateUrls.push(baseUrl);
          runtimeMock.state.authHeaders.push(
            serverPassword ? `Basic ${btoa(`opencode:${serverPassword}`)}` : null,
          );
          return { data: { id: `${baseUrl}/session` } };
        },
        get: async ({ sessionID }: { sessionID: string }) => {
          runtimeMock.state.sessionGetCalls.push(sessionID);
          if (runtimeMock.state.resumableSession?.id === sessionID) {
            return { data: runtimeMock.state.resumableSession };
          }
          throw { response: { status: 404 } };
        },
        update: async ({ sessionID }: { sessionID: string }) => {
          runtimeMock.state.sessionUpdateCalls.push(sessionID);
          return { data: runtimeMock.state.resumableSession };
        },
        abort: async ({ sessionID }: { sessionID: string }) => {
          runtimeMock.state.abortCalls.push(sessionID);
          if (runtimeMock.state.abortErrorSessionIds.has(sessionID)) {
            throw new Error(`abort failed for ${sessionID}`);
          }
        },
        promptAsync: async (input: unknown, options?: { signal?: AbortSignal }) => {
          runtimeMock.state.promptCalls.push(input);
          if (runtimeMock.state.promptAsyncHandler) {
            return runtimeMock.state.promptAsyncHandler(input, options?.signal);
          }
          if (runtimeMock.state.promptAsyncError) {
            throw runtimeMock.state.promptAsyncError;
          }
        },
        messages: async () => {
          runtimeMock.state.startupOrder.push("history");
          return { data: runtimeMock.state.messages };
        },
        children: async () => ({ data: runtimeMock.state.children }),
        revert: async ({ sessionID, messageID }: { sessionID: string; messageID?: string }) => {
          runtimeMock.state.revertCalls.push({
            sessionID,
            ...(messageID ? { messageID } : {}),
          });
          if (!messageID) {
            runtimeMock.state.messages = [];
            return;
          }

          const targetIndex = runtimeMock.state.messages.findIndex(
            (entry) => entry.info.id === messageID,
          );
          runtimeMock.state.messages =
            targetIndex >= 0
              ? runtimeMock.state.messages.slice(0, targetIndex + 1)
              : runtimeMock.state.messages;
        },
      },
      event: {
        subscribe: async () => {
          if (runtimeMock.state.subscribeError) throw runtimeMock.state.subscribeError;
          return {
            stream: (async function* () {
              runtimeMock.state.startupOrder.push("stream");
              if (runtimeMock.state.streamReadError) throw runtimeMock.state.streamReadError;
              for (const event of runtimeMock.state.subscribedEvents) {
                yield event;
              }
            })(),
          };
        },
      },
      permission: {
        list: async () => ({ data: runtimeMock.state.pendingPermissions }),
        respond: async (input: {
          sessionID: string;
          permissionID: string;
          response?: "once" | "always" | "reject";
        }) => {
          runtimeMock.state.permissionRespondCalls.push(input);
        },
      },
      question: {
        list: async () => ({ data: runtimeMock.state.pendingQuestions }),
        reply: async (input: { requestID: string; answers: Array<Array<string>> }) => {
          runtimeMock.state.questionReplyCalls.push(input);
        },
      },
    } as unknown as OpencodeClient),
  loadOpenCodeInventory: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "loadOpenCodeInventory",
        detail: "OpenCodeRuntimeTestDouble.loadOpenCodeInventory not used in this test",
        cause: null,
      }),
    ),
};

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

// The adapter now receives its settings as a plain argument (the old design
// read from `ServerSettingsService` internally). The test-only
// `ServerSettingsService` below is still kept because other dependencies in
// the layer graph reach for it — but the routing values the assertions
// probe (serverUrl, serverPassword) must be threaded directly through the
// decoded `OpenCodeSettings`.
const openCodeAdapterTestSettings = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverUrl: "http://127.0.0.1:9999",
  serverPassword: "secret-password",
});

const OpenCodeAdapterTestLayer = Layer.effect(
  OpenCodeAdapter,
  makeOpenCodeAdapter(openCodeAdapterTestSettings),
).pipe(
  Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(
    ServerSettingsService.layerTest({
      providers: {
        opencode: {
          binaryPath: "fake-opencode",
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        },
      },
    }),
  ),
  Layer.provideMerge(providerSessionDirectoryTestLayer),
  Layer.provideMerge(NodeServices.layer),
);

beforeEach(() => {
  runtimeMock.reset();
});

const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const makeChildSession = (id: string, parentID: string) => ({
  id,
  slug: id,
  projectID: "project-1",
  directory: "/tmp/project",
  parentID,
  title: "Child work",
  version: "test",
  time: {
    created: Date.now(),
    updated: Date.now(),
  },
});

const taskRoot = "http://127.0.0.1:9999/session";
const nativeTaskPart = (status: "running" | "completed" | "error", background = false) => ({
  id: "native-task",
  sessionID: taskRoot,
  messageID: "native-message",
  type: "tool",
  callID: "native-call",
  tool: "task",
  state: {
    status,
    input: { description: "Inspect native lifecycle", subagent_type: "explore" },
    title: "Inspect native lifecycle",
    time: { start: 1, end: 2 },
    ...(status === "error"
      ? { error: "Task failed" }
      : {
          metadata: {
            sessionId: "native-child",
            model: { providerID: "test", modelID: "child-model" },
            background,
          },
          output: "<task_result>Inspection finished</task_result>",
        }),
  },
});
const nativePartEvent = (part: unknown) => ({
  type: "message.part.updated",
  properties: { sessionID: taskRoot, part },
});
const taskSentinel = () =>
  nativePartEvent({
    ...nativeTaskPart("completed"),
    id: "sentinel",
    callID: "sentinel",
    tool: "read",
  });

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect(
    "projects native Task failures without losing tool rows or duplicating child identity",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("native-task-failure");
        const child = makeChildSession("native-child", taskRoot);
        runtimeMock.state.subscribedEvents = [
          { type: "session.created", properties: { info: child } },
          nativePartEvent(nativeTaskPart("running")),
          nativePartEvent(nativeTaskPart("running")),
          { type: "session.idle", properties: { sessionID: child.id } },
          nativePartEvent(nativeTaskPart("error")),
          nativePartEvent(nativeTaskPart("error")),
          taskSentinel(),
        ];
        const fiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.takeUntil((event) => event.itemId === "sentinel"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          runtimeSessionId: RuntimeSessionId.make("native-failure"),
          threadId,
          runtimeMode: "full-access",
        });
        const events = yield* Fiber.join(fiber).pipe(Effect.timeout("2 seconds"));
        const starts = events.filter((event) => event.type === "subagent.started");
        const terminals = events.filter((event) => event.type === "subagent.completed");
        assert.equal(starts.length, 1);
        assert.equal(terminals.length, 1);
        assert.equal(terminals[0]?.payload.status, "failed");
        assert.equal(
          terminals[0]?.payload.subagent.subagentId,
          starts[0]?.payload.subagent.subagentId,
        );
        assert.equal(terminals[0]?.payload.subagent.model, "test/child-model");
        assert.equal(terminals[0]?.payload.subagent.parentProviderItemId, "native-call");
        assert.equal(events.filter((event) => event.itemId === "native-call").length, 4);
        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("keeps background Tasks running until a native completion notification", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("native-task-background");
      const notice = {
        type: "text",
        id: "notice",
        sessionID: taskRoot,
        messageID: "notice-message",
        synthetic: true,
        text: '<task id="native-child" state="completed"><task_result>Background finished</task_result></task>',
      };
      runtimeMock.state.subscribedEvents = [
        nativePartEvent(nativeTaskPart("completed", true)),
        { type: "session.idle", properties: { sessionID: "native-child" } },
        nativePartEvent(notice),
        nativePartEvent(notice),
        taskSentinel(),
      ];
      const fiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.itemId === "sentinel"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("native-background"),
        threadId,
        runtimeMode: "full-access",
      });
      const events = yield* Fiber.join(fiber).pipe(Effect.timeout("2 seconds"));
      const terminals = events.filter((event) => event.type === "subagent.completed");
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0]?.payload.summary, "Background finished");
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("reconstructs Task terminals on resume and deduplicates buffered live replay", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("native-task-history");
      runtimeMock.state.resumableSession = { id: taskRoot };
      runtimeMock.state.messages = [
        { info: { id: "native-message", role: "assistant" }, parts: [nativeTaskPart("completed")] },
      ];
      runtimeMock.state.children = [makeChildSession("native-child", taskRoot)];
      const ids: string[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        runtimeMock.state.subscribedEvents = [
          nativePartEvent(nativeTaskPart("completed")),
          taskSentinel(),
        ];
        const fiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.takeUntil((event) => event.itemId === "sentinel"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          runtimeSessionId: RuntimeSessionId.make(`native-history-${attempt}`),
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: taskRoot },
        });
        const events = yield* Fiber.join(fiber).pipe(Effect.timeout("2 seconds"));
        const terminals = events.filter((event) => event.type === "subagent.completed");
        assert.equal(terminals.length, 1);
        assert.equal(terminals[0]?.payload.subagent.model, "test/child-model");
        ids.push(terminals[0]!.eventId);
        yield* adapter.stopSession(threadId);
      }
      assert.equal(ids[0], ids[1]);
      assert.deepEqual(runtimeMock.state.startupOrder, ["stream", "history", "stream", "history"]);
    }),
  );

  it.effect("interrupts active native Tasks even without child-session discovery", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("native-task-interrupt");
      runtimeMock.state.subscribedEvents = [
        nativePartEvent(nativeTaskPart("running")),
        taskSentinel(),
      ];
      const ready = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.itemId === "sentinel"),
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("native-interrupt"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* Fiber.join(ready).pipe(Effect.timeout("2 seconds"));
      const completed = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) => event.threadId === threadId && event.type === "subagent.completed",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.interruptTurn(threadId);
      const events = yield* Fiber.join(completed).pipe(Effect.timeout("2 seconds"));
      assert.equal(events[0]?.type, "subagent.completed");
      if (events[0]?.type === "subagent.completed")
        assert.equal(events[0].payload.status, "stopped");
      assert.ok(runtimeMock.state.abortCalls.includes("native-child"));
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not publish or abort a reused session when subscription startup fails", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("native-subscribe-failure");
      runtimeMock.state.resumableSession = { id: taskRoot };
      runtimeMock.state.subscribeError = new Error("subscription unavailable");
      const result = yield* adapter
        .startSession({
          runtimeSessionId: RuntimeSessionId.make("native-subscribe-failure"),
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: taskRoot },
        })
        .pipe(Effect.exit);
      assert.equal(result._tag, "Failure");
      assert.deepEqual(runtimeMock.state.abortCalls, []);
      assert.equal(
        (yield* adapter.listSessions()).some((session) => session.threadId === threadId),
        false,
      );
    }),
  );

  it.effect("cleans up when the lazy event stream fails on its first read", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("native-lazy-subscribe-failure");
      runtimeMock.state.streamReadError = new Error("lazy fetch failed");
      const result = yield* adapter
        .startSession({
          runtimeSessionId: RuntimeSessionId.make("native-lazy-failure"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.exit);
      assert.equal(result._tag, "Failure");
      assert.equal(
        (yield* adapter.listSessions()).some((session) => session.threadId === threadId),
        false,
      );
      assert.deepEqual(runtimeMock.state.abortCalls, [taskRoot]);
    }),
  );

  it.effect("reuses a configured OpenCode server URL instead of spawning a local server", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;

      const session = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-1"),
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode"),
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "opencode");
      assert.equal(session.threadId, "thread-opencode");
      assert.deepEqual(runtimeMock.state.startCalls, []);
      assert.deepEqual(runtimeMock.state.sessionCreateUrls, ["http://127.0.0.1:9999"]);
      assert.deepEqual(runtimeMock.state.authHeaders, [
        `Basic ${btoa("opencode:secret-password")}`,
      ]);
    }),
  );

  it.effect("stops a configured-server session without trying to own server lifecycle", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-1"),
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode"),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(asThreadId("thread-opencode"));

      assert.deepEqual(runtimeMock.state.startCalls, []);
      assert.deepEqual(
        runtimeMock.state.abortCalls.includes("http://127.0.0.1:9999/session"),
        true,
      );
    }),
  );

  it.effect("re-adopts the durable native session cursor after an in-memory restart", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const firstThreadId = asThreadId("thread-opencode-resume-first");
      const first = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-resume-first"),
        provider: ProviderDriverKind.make("opencode"),
        threadId: firstThreadId,
        runtimeMode: "full-access",
      });
      const cursor = first.resumeCursor as { schemaVersion: number; sessionId: string };
      runtimeMock.state.resumableSession = {
        id: cursor.sessionId,
        directory: "/tmp/project",
      };
      yield* adapter.stopSession(firstThreadId);

      const resumed = yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-resume-second"),
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode-resume-second"),
        runtimeMode: "approval-required",
        resumeCursor: cursor,
      });

      assert.deepEqual(resumed.resumeCursor, first.resumeCursor);
      assert.deepEqual(runtimeMock.state.sessionGetCalls, [cursor.sessionId]);
      assert.deepEqual(runtimeMock.state.sessionUpdateCalls, [cursor.sessionId]);
      assert.equal(runtimeMock.state.sessionCreateUrls.length, 1);
      yield* adapter.stopSession(asThreadId("thread-opencode-resume-second"));
    }),
  );

  it.effect("stops hydrated child sessions with their parent session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const rootSessionId = "http://127.0.0.1:9999/session";
      runtimeMock.state.children = [makeChildSession("child-session-stop", rootSessionId)];

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-child-stop"),
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode-child-stop"),
        runtimeMode: "full-access",
      });
      yield* sleep(10);
      yield* adapter.stopSession(asThreadId("thread-opencode-child-stop"));

      assert.deepEqual(runtimeMock.state.abortCalls, [rootSessionId, "child-session-stop"]);
    }),
  );

  it.effect("interrupts active child sessions with the parent turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const rootSessionId = "http://127.0.0.1:9999/session";
      runtimeMock.state.children = [makeChildSession("child-session-interrupt", rootSessionId)];
      const threadId = asThreadId("thread-opencode-child-interrupt");

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-child-interrupt"),
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* sleep(10);
      yield* adapter.interruptTurn(threadId);

      assert.deepEqual(runtimeMock.state.abortCalls, [rootSessionId, "child-session-interrupt"]);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("still interrupts children when the parent interrupt fails", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const rootSessionId = "http://127.0.0.1:9999/session";
      runtimeMock.state.children = [makeChildSession("child-session-recovery", rootSessionId)];
      runtimeMock.state.abortErrorSessionIds.add(rootSessionId);
      const threadId = asThreadId("thread-opencode-child-interrupt-recovery");

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-child-interrupt-recovery"),
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* sleep(10);
      const error = yield* adapter.interruptTurn(threadId).pipe(Effect.flip);

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.deepEqual(runtimeMock.state.abortCalls, [rootSessionId, "child-session-recovery"]);
      runtimeMock.state.abortErrorSessionIds.clear();
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("routes child permission responses to the session that owns the request", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const rootSessionId = "http://127.0.0.1:9999/session";
      const childSessionId = "child-session-approval";
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.created",
          properties: {
            sessionID: childSessionId,
            info: makeChildSession(childSessionId, rootSessionId),
          },
        },
        {
          type: "permission.asked",
          properties: {
            id: "permission-child-1",
            sessionID: childSessionId,
            permission: "bash",
            patterns: ["git status"],
            metadata: {},
            always: [],
          },
        },
      ];
      const threadId = asThreadId("thread-opencode-child-approval");

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-child-approval"),
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* sleep(10);
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make("permission-child-1"),
        "accept",
      );

      assert.deepEqual(runtimeMock.state.permissionRespondCalls, [
        {
          sessionID: childSessionId,
          permissionID: "permission-child-1",
          response: "once",
        },
      ]);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("recovers pending approval requests from child sessions", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const rootSessionId = "http://127.0.0.1:9999/session";
      const childSessionId = "child-session-recovered-approval";
      runtimeMock.state.children = [makeChildSession(childSessionId, rootSessionId)];
      runtimeMock.state.pendingPermissions = [
        {
          id: "permission-recovered-child-1",
          sessionID: childSessionId,
          permission: "bash",
          patterns: ["git status"],
          metadata: {},
          always: [],
        },
      ];
      const threadId = asThreadId("thread-opencode-recovered-child-approval");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-recovered-child-approval"),
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });
      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));

      const recoveredRequest = events.find((event) => event.type === "request.opened");
      assert.equal(recoveredRequest?.type, "request.opened");
      if (recoveredRequest?.type === "request.opened") {
        assert.equal(recoveredRequest.requestId, "permission-recovered-child-1");
      }
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make("permission-recovered-child-1"),
        "accept",
      );
      assert.deepEqual(runtimeMock.state.permissionRespondCalls, [
        {
          sessionID: childSessionId,
          permissionID: "permission-recovered-child-1",
          response: "once",
        },
      ]);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("emits one session.exited event when stopping a session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stop-event");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-3"),
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      assert.equal(
        events.every(
          (event) =>
            event.providerInstanceId === ProviderInstanceId.make("opencode") &&
            event.runtimeSessionId === RuntimeSessionId.make("test-opencodeadapter-3"),
        ),
        true,
      );
      assert.deepEqual(
        events.map((event) => event.type),
        ["session.started", "thread.started", "session.exited"],
      );
    }),
  );

  it.effect("clears session state even when cleanup finalizers throw", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-4"),
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-stop-all-a"),
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-5"),
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-stop-all-b"),
        runtimeMode: "full-access",
      });

      runtimeMock.state.closeError = new Error("close failed");
      // `stopAll` relies on `stopOpenCodeContext`, which is typed as
      // never-failing. A throwing finalizer surfaces as a defect — `Effect.exit`
      // captures it so the assertions can still run. The key invariant we're
      // validating is "the sessions map and close-call probes reflect cleanup
      // attempts regardless of finalizer outcome".
      yield* Effect.exit(adapter.stopAll());
      const sessions = yield* adapter.listSessions();

      assert.deepEqual(runtimeMock.state.closeCalls, [
        "http://127.0.0.1:9999",
        "http://127.0.0.1:9999",
      ]);
      assert.deepEqual(sessions, []);
    }),
  );

  it.effect("completes streamEvents when the adapter scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      let scopeClosed = false;

      try {
        const adapterLayer = Layer.effect(
          OpenCodeAdapter,
          makeOpenCodeAdapter(openCodeAdapterTestSettings),
        ).pipe(
          Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
          Layer.provideMerge(ServerSettingsService.layerTest()),
          Layer.provideMerge(providerSessionDirectoryTestLayer),
          Layer.provideMerge(NodeServices.layer),
        );
        const context = yield* Layer.buildWithScope(adapterLayer, scope);
        const adapter = yield* Effect.service(OpenCodeAdapter).pipe(Effect.provide(context));
        const eventsFiber = yield* adapter.streamEvents.pipe(Stream.runCollect, Effect.forkChild);

        yield* Scope.close(scope, Exit.void);
        scopeClosed = true;

        const exit = yield* Fiber.await(eventsFiber).pipe(Effect.timeout("1 second"));
        assert.equal(Exit.hasInterrupts(exit), true);
      } finally {
        if (!scopeClosed) {
          yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
        }
      }
    }),
  );

  it.effect("rolls back session state when sendTurn fails before OpenCode accepts the prompt", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-6"),
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-send-turn-failure"),
        runtimeMode: "full-access",
      });

      runtimeMock.state.promptAsyncError = new Error("prompt failed");
      const error = yield* adapter
        .sendTurn({
          threadId: asThreadId("thread-send-turn-failure"),
          input: "Fix it",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        })
        .pipe(Effect.flip);
      const sessions = yield* adapter.listSessions();

      assert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag !== "ProviderAdapterRequestError") {
        throw new Error("Unexpected error type");
      }
      assert.equal(error.detail, "prompt failed");
      assert.equal(
        error.message,
        "Provider adapter request failed (opencode) for session.promptAsync: prompt failed",
      );
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.status, "ready");
      assert.equal(sessions[0]?.activeTurnId, undefined);
      assert.equal(sessions[0]?.lastError, "prompt failed");
    }),
  );

  it.effect("cancels a pending prompt before stopping its session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-stop-pending-prompt");
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-stop-pending"),
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      let notifyPromptStarted: (() => void) | undefined;
      const promptStarted = new Promise<void>((resolve) => {
        notifyPromptStarted = resolve;
      });
      let completedAfterStop = false;
      runtimeMock.state.promptAsyncHandler = async (_input, signal) => {
        notifyPromptStarted?.();
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
          if (!signal) {
            resolve();
          }
        });
        completedAfterStop = true;
      };

      const sendFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Do not run after stop",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => promptStarted);

      yield* adapter.stopSession(threadId);
      const sendExit = yield* Fiber.await(sendFiber);

      assert.equal(Exit.hasInterrupts(sendExit), true);
      assert.equal(completedAfterStop, false);
      assert.deepEqual(runtimeMock.state.abortCalls, ["http://127.0.0.1:9999/session"]);
    }),
  );

  it.effect("serializes prompt submissions within a session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-serialized-prompts");
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-serialized-prompts"),
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const startedResolvers: Array<(() => void) | undefined> = [];
      const releaseResolvers: Array<(() => void) | undefined> = [];
      const started = [0, 1].map(
        (index) =>
          new Promise<void>((resolve) => {
            startedResolvers[index] = resolve;
          }),
      );
      const releases = [0, 1].map(
        (index) =>
          new Promise<void>((resolve) => {
            releaseResolvers[index] = resolve;
          }),
      );
      let activePrompts = 0;
      let maxActivePrompts = 0;
      runtimeMock.state.promptAsyncHandler = async () => {
        const index = runtimeMock.state.promptCalls.length - 1;
        activePrompts += 1;
        maxActivePrompts = Math.max(maxActivePrompts, activePrompts);
        startedResolvers[index]?.();
        await releases[index];
        activePrompts -= 1;
      };

      const send = (input: string) =>
        adapter.sendTurn({
          threadId,
          input,
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        });
      const first = yield* send("first").pipe(Effect.forkChild);
      yield* Effect.promise(() => started[0]!);
      const second = yield* send("second").pipe(Effect.forkChild);
      yield* sleep(20);
      assert.equal(runtimeMock.state.promptCalls.length, 1);

      releaseResolvers[0]?.();
      yield* Fiber.join(first);
      yield* Effect.promise(() => started[1]!);
      releaseResolvers[1]?.();
      yield* Fiber.join(second);

      assert.equal(runtimeMock.state.promptCalls.length, 2);
      assert.equal(maxActivePrompts, 1);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("routes a validated general file as an inline native file part", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const threadId = asThreadId("thread-general-file");
      const attachment = {
        type: "file" as const,
        id: "thread-general-file-attachment",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
      };
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      const attachmentPath = `${config.attachmentsDir}/${attachmentRelativePath(attachment)}`;
      yield* fileSystem.writeFile(attachmentPath, new TextEncoder().encode("abc"));
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-general-file"),
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter
        .sendTurn({
          threadId,
          input: "Review this",
          attachments: [attachment],
          modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
        })
        .pipe(Effect.ensuring(fileSystem.remove(attachmentPath).pipe(Effect.ignore)));

      assert.deepEqual(runtimeMock.state.promptCalls.at(-1), {
        sessionID: "http://127.0.0.1:9999/session",
        model: { providerID: "openai", modelID: "gpt-5" },
        parts: [
          {
            type: "text",
            text: `<ryco_host_context>${agentControlHostContext(false)}</ryco_host_context>\n\nReview this`,
          },
          {
            type: "file",
            mime: "text/plain",
            filename: "notes.txt",
            url: "data:text/plain;base64,YWJj",
          },
        ],
      });
    }),
  );

  it.effect("gates native file parts and degrades the rest to path lines", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const threadId = asThreadId("thread-gated-attachments");
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });

      const smallPdf = {
        type: "file" as const,
        id: "thread-gated-small-pdf-attachment",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
      };
      const oversizedPdf = {
        type: "file" as const,
        id: "thread-gated-big-pdf-attachment",
        name: "huge.pdf",
        mimeType: "application/pdf",
        sizeBytes: OPENCODE_NATIVE_ATTACHMENT_MAX_BYTES + 1,
      };
      const zip = {
        type: "file" as const,
        id: "thread-gated-zip-attachment",
        name: "bundle.zip",
        mimeType: "application/zip",
        sizeBytes: 10,
      };
      const bitmap = {
        type: "image" as const,
        id: "thread-gated-bmp-attachment",
        name: "diagram.bmp",
        mimeType: "image/bmp",
        sizeBytes: 2,
      };
      for (const [attachment, bytes] of [
        [smallPdf, Uint8Array.from([1, 2, 3, 4])],
        [zip, Uint8Array.from(Array.from({ length: 10 }, (_, index) => index))],
      ] as const) {
        const attachmentPath = `${config.attachmentsDir}/${attachmentRelativePath(attachment)}`;
        yield* fileSystem.writeFile(attachmentPath, bytes);
      }
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-gated-attachments"),
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter
        .sendTurn({
          threadId,
          input: "Review everything",
          attachments: [smallPdf, oversizedPdf, zip, bitmap],
          modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
        })
        .pipe(
          Effect.ensuring(
            Effect.forEach(
              [smallPdf, zip],
              (attachment) =>
                fileSystem
                  .remove(`${config.attachmentsDir}/${attachmentRelativePath(attachment)}`)
                  .pipe(Effect.ignore),
              { discard: true },
            ),
          ),
        );

      assert.equal(isOpenCodeNativeAttachment(smallPdf), true);
      assert.equal(isOpenCodeNativeAttachment(oversizedPdf), false);
      assert.equal(isOpenCodeNativeAttachment(zip), false);
      assert.equal(isOpenCodeNativeAttachment(bitmap), false);
      const lastPrompt = runtimeMock.state.promptCalls.at(-1) as {
        parts: Array<Record<string, unknown>>;
      };
      const fileParts = lastPrompt.parts.filter((part) => part.type === "file");
      assert.deepEqual(fileParts, [
        {
          type: "file",
          mime: "application/pdf",
          filename: "report.pdf",
          url: "data:application/pdf;base64,AQIDBA==",
        },
      ]);
      const textPart = lastPrompt.parts.find((part) => part.type === "text");
      const text = textPart?.text as string;
      assert.equal(typeof text, "string");
      assert.ok(text.includes("Review everything"));
      assert.ok(
        text.includes(
          `[Attached file] huge.pdf (application/pdf, ${OPENCODE_NATIVE_ATTACHMENT_MAX_BYTES + 1} bytes) saved at: ${config.attachmentsDir}/${attachmentRelativePath(oversizedPdf)}`,
        ),
      );
      assert.ok(
        text.includes(
          `[Attached file] bundle.zip (application/zip, 10 bytes) saved at: ${config.attachmentsDir}/${attachmentRelativePath(zip)}`,
        ),
      );
      assert.ok(
        text.includes(
          `[Attached file] diagram.bmp (image/bmp, 2 bytes) saved at: ${config.attachmentsDir}/${attachmentRelativePath(bitmap)}`,
        ),
      );
    }),
  );

  it.effect("passes agent and variant options for the adapter's bound custom instance id", () => {
    const customInstanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, {
        instanceId: customInstanceId,
      }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-7"),
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-custom-instance"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-custom-instance"),
        input: "Fix it",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode_zen"),
          "anthropic/claude-sonnet-4-5",
          [
            { id: "agent", value: "github-copilot" },
            { id: "variant", value: "high" },
          ],
        ),
      });

      assert.deepEqual(runtimeMock.state.promptCalls.at(-1), {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        },
        agent: "github-copilot",
        variant: "high",
        parts: [
          {
            type: "text",
            text: `<ryco_host_context>${agentControlHostContext(false)}</ryco_host_context>\n\nFix it`,
          },
        ],
      });
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("uses the bound custom instance id for fallback sendTurn model selection", () => {
    const customInstanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, {
        instanceId: customInstanceId,
      }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-custom-instance-fallback-model");
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-8"),
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode_zen"),
          "anthropic/claude-sonnet-4-5",
        ),
      });

      yield* adapter.sendTurn({
        threadId,
        input: "Fix it",
      });

      assert.deepEqual(runtimeMock.state.promptCalls.at(-1), {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        },
        parts: [
          {
            type: "text",
            text: `<ryco_host_context>${agentControlHostContext(false)}</ryco_host_context>\n\nFix it`,
          },
        ],
      });
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("rejects sendTurn model selections for another instance id", () => {
    const customInstanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, {
        instanceId: customInstanceId,
      }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-custom-instance-wrong-selection");
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-9"),
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "Fix it",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "anthropic/claude-sonnet-4-5",
          ),
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "ProviderAdapterValidationError");
      if (error._tag !== "ProviderAdapterValidationError") {
        throw new Error("Unexpected error type");
      }
      assert.equal(
        error.issue,
        "OpenCode model selection is bound to instance 'opencode', expected 'opencode_zen'.",
      );
      assert.deepEqual(runtimeMock.state.promptCalls, []);
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("reverts the full thread when rollback removes every assistant turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-rollback-all");
      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-10"),
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      runtimeMock.state.messages = [
        {
          info: { id: "assistant-1", role: "assistant" },
          parts: [],
        },
        {
          info: { id: "assistant-2", role: "assistant" },
          parts: [],
        },
      ];

      const snapshot = yield* adapter.rollbackThread(threadId, 2);

      assert.deepEqual(runtimeMock.state.revertCalls, [
        { sessionID: "http://127.0.0.1:9999/session" },
      ]);
      assert.deepEqual(snapshot.turns, []);
    }),
  );

  it.effect("deduplicates overlapping assistant text deltas after part updates", () =>
    Effect.sync(() => {
      const firstUpdate = mergeOpenCodeAssistantText(undefined, "Hello");
      const overlapDelta = appendOpenCodeAssistantTextDelta(firstUpdate.latestText, "lo world");
      const secondUpdate = mergeOpenCodeAssistantText(overlapDelta.nextText, "Hello world!");

      assert.deepEqual(
        [firstUpdate.deltaToEmit, overlapDelta.deltaToEmit, secondUpdate.deltaToEmit],
        ["Hello", " world", "!"],
      );
      assert.equal(secondUpdate.latestText, "Hello world!");
    }),
  );

  it.effect("correlates OpenCode subtask parts with child session transcript deltas", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-subagent");
      const rootSessionId = "http://127.0.0.1:9999/session";
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.part.updated",
          properties: {
            sessionID: rootSessionId,
            part: {
              id: "subtask-part-1",
              sessionID: rootSessionId,
              messageID: "root-message-1",
              type: "subtask",
              prompt: "Inspect retry handling and report back.",
              description: "Inspect retry handling",
              agent: "code-reviewer",
              model: { providerID: "test-provider", modelID: "test-model" },
            },
            time: Date.now(),
          },
        },
        {
          type: "session.created",
          properties: {
            sessionID: "child-session-1",
            info: {
              id: "child-session-1",
              slug: "child-session-1",
              projectID: "project-1",
              directory: "/tmp/project",
              parentID: rootSessionId,
              title: "Retry review",
              version: "test",
              time: {
                created: Date.now(),
                updated: Date.now(),
              },
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "child-session-1",
            info: {
              id: "child-message-1",
              sessionID: "child-session-1",
              role: "assistant",
              time: {
                created: Date.now(),
              },
              parentID: "parent-message-1",
              modelID: "test-model",
              providerID: "test-provider",
              mode: "build",
              agent: "code-reviewer",
              path: {
                cwd: "/tmp/project",
                root: "/tmp/project",
              },
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: {
                  read: 0,
                  write: 0,
                },
              },
            },
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: "child-session-1",
            part: {
              id: "child-text-1",
              sessionID: "child-session-1",
              messageID: "child-message-1",
              type: "text",
              text: "",
            },
            time: Date.now(),
          },
        },
        {
          type: "message.part.delta",
          properties: {
            sessionID: "child-session-1",
            messageID: "child-message-1",
            partID: "child-text-1",
            field: "text",
            delta: "Retry handling looks stable.",
          },
        },
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(6),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-11"),
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const subagentStarted = events.find((event) => event.type === "subagent.started");
      const boundUpdate = events.find(
        (event) =>
          event.type === "subagent.updated" &&
          event.payload.subagent.providerSessionId === "child-session-1",
      );
      const childDelta = events.find((event) => event.type === "subagent.message.delta");

      assert.equal(subagentStarted?.type, "subagent.started");
      if (subagentStarted?.type === "subagent.started") {
        assert.equal(subagentStarted.payload.subagent.description, "Inspect retry handling");
        assert.equal(subagentStarted.payload.subagent.capability, "summary");
        assert.equal(subagentStarted.payload.subagent.model, "test-provider/test-model");
      }
      assert.equal(boundUpdate?.type, "subagent.updated");
      if (boundUpdate?.type === "subagent.updated") {
        assert.equal(boundUpdate.payload.subagent.capability, "transcript");
        assert.equal(boundUpdate.payload.subagent.providerSessionId, "child-session-1");
        assert.equal(boundUpdate.payload.subagent.model, "test-provider/test-model");
      }
      assert.equal(childDelta?.type, "subagent.message.delta");
      if (childDelta?.type === "subagent.message.delta") {
        assert.equal(childDelta.payload.delta, "Retry handling looks stable.");
        assert.equal(childDelta.payload.providerSessionId, "child-session-1");
        assert.equal(
          childDelta.payload.subagentId,
          boundUpdate?.type === "subagent.updated"
            ? boundUpdate.payload.subagent.subagentId
            : undefined,
        );
      }
    }),
  );

  it.effect("projects root-session todos, token usage, and permission resolutions", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-plan-usage");
      const rootSessionId = "http://127.0.0.1:9999/session";
      runtimeMock.state.subscribedEvents = [
        {
          type: "todo.updated",
          properties: {
            sessionID: rootSessionId,
            todos: [
              { id: "todo-1", content: "Inspect retries", status: "completed", priority: "high" },
              {
                id: "todo-2",
                content: "Patch the dedup key",
                status: "in_progress",
                priority: "high",
              },
              { id: "todo-3", content: "Cancelled work", status: "cancelled", priority: "low" },
            ],
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: rootSessionId,
            info: {
              id: "root-message-1",
              sessionID: rootSessionId,
              role: "assistant",
              time: { created: Date.now() },
              parentID: rootSessionId,
              modelID: "test-model",
              providerID: "test-provider",
              mode: "build",
              path: { cwd: "/tmp/project", root: "/tmp/project" },
              cost: 0,
              tokens: {
                input: 100,
                output: 40,
                reasoning: 10,
                cache: { read: 25, write: 5 },
              },
            },
          },
        },
        {
          type: "permission.asked",
          properties: {
            id: "permission-root-1",
            sessionID: rootSessionId,
            permission: "edit",
            patterns: ["src/app.ts"],
            metadata: {},
            always: [],
          },
        },
        {
          type: "permission.replied",
          properties: {
            requestID: "permission-root-1",
            sessionID: rootSessionId,
            reply: "once",
          },
        },
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(6),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-plan-usage"),
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const types = events.map((event) => event.type);
      assert.deepEqual(types, [
        "session.started",
        "thread.started",
        "turn.plan.updated",
        "thread.token-usage.updated",
        "request.opened",
        "request.resolved",
      ]);

      const planUpdated = events.find((event) => event.type === "turn.plan.updated");
      if (planUpdated?.type === "turn.plan.updated") {
        assert.deepEqual(planUpdated.payload.plan, [
          { step: "Inspect retries", status: "completed" },
          { step: "Patch the dedup key", status: "inProgress" },
        ]);
      }

      const tokenUsage = events.find((event) => event.type === "thread.token-usage.updated");
      if (tokenUsage?.type === "thread.token-usage.updated") {
        assert.equal(tokenUsage.payload.usage.usedTokens, 180);
        assert.equal(tokenUsage.payload.usage.inputTokens, 130);
        assert.equal(tokenUsage.payload.usage.cachedInputTokens, 25);
        assert.equal(tokenUsage.payload.usage.outputTokens, 40);
        assert.equal(tokenUsage.payload.usage.reasoningOutputTokens, 10);
      }

      const resolved = events.find((event) => event.type === "request.resolved");
      if (resolved?.type === "request.resolved") {
        assert.equal(resolved.payload.requestType, "file_change_approval");
        assert.equal(resolved.payload.decision, "accept");
      }
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("suppresses duplicate retry warnings and re-emits on new attempts", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-retry-dedup");
      const rootSessionId = "http://127.0.0.1:9999/session";
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.status",
          properties: {
            sessionID: rootSessionId,
            status: { type: "retry", attempt: 1, message: "rate limited", next: 1 },
          },
        },
        {
          type: "session.status",
          properties: {
            sessionID: rootSessionId,
            status: { type: "retry", attempt: 1, message: "rate limited", next: 2 },
          },
        },
        {
          type: "session.status",
          properties: {
            sessionID: rootSessionId,
            status: { type: "retry", attempt: 2, message: "rate limited", next: 3 },
          },
        },
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "runtime.warning" || event.type === "session.started"),
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-retry-dedup"),
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const warnings = events.filter((event) => event.type === "runtime.warning");
      assert.equal(warnings.length, 2);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("writes provider-native observability records using the session thread id", () =>
    Effect.gen(function* () {
      const nativeEvents: Array<{
        readonly event?: {
          readonly provider?: string;
          readonly threadId?: string;
          readonly providerThreadId?: string;
          readonly type?: string;
        };
      }> = [];
      const nativeThreadIds: Array<string | null> = [];
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-missing-session",
              role: "assistant",
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/other-session",
            info: {
              id: "msg-other-session",
              role: "assistant",
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-native-log",
              role: "assistant",
            },
          },
        },
      ];

      const nativeEventLogger = {
        filePath: "memory://opencode-native-events",
        write: (event: unknown, threadId: ThreadId | null) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          nativeThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      };

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          nativeEventLogger,
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: "fake-opencode",
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      const session = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const started = yield* adapter.startSession({
          runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-12"),
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-native-log"),
          runtimeMode: "full-access",
        });
        yield* sleep(10);
        return started;
      }).pipe(Effect.provide(adapterLayer));

      assert.equal(session.threadId, "thread-native-log");
      assert.equal(nativeEvents.length, 1);
      assert.equal(
        nativeEvents.some((record) => record.event?.provider === "opencode"),
        true,
      );
      assert.equal(
        nativeEvents.some(
          (record) => record.event?.providerThreadId === "http://127.0.0.1:9999/session",
        ),
        true,
      );
      assert.equal(
        nativeEvents.some((record) => record.event?.threadId === "thread-native-log"),
        true,
      );
      assert.equal(
        nativeEvents.some((record) => record.event?.type === "message.updated"),
        true,
      );
      assert.equal(
        nativeThreadIds.every((threadId) => threadId === "thread-native-log"),
        true,
      );
    }),
  );

  it.effect("keeps the event pump alive when native event logging fails", () =>
    Effect.gen(function* () {
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-native-log-failure",
              role: "assistant",
            },
          },
        },
      ];

      const nativeEventLogger = {
        filePath: "memory://opencode-native-events",
        write: () => Effect.die(new Error("native log write failed")),
        close: () => Effect.void,
      };

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          nativeEventLogger,
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: "fake-opencode",
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      // Capture closeCalls *inside* the provided layer scope: the adapter's
      // layer finalizer now tears down any live sessions when the layer
      // closes (which is exactly what we want for leak prevention), so
      // inspecting closeCalls after `Effect.provide` completes would observe
      // the teardown — not the behavior under test. We care that the event
      // pump kept the session alive while logging was failing.
      const { sessions, closeCallsDuringRun } = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          runtimeSessionId: RuntimeSessionId.make("test-opencodeadapter-13"),
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-native-log-failure"),
          runtimeMode: "full-access",
        });
        yield* sleep(10);
        return {
          sessions: yield* adapter.listSessions(),
          closeCallsDuringRun: [...runtimeMock.state.closeCalls],
        };
      }).pipe(Effect.provide(adapterLayer));

      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.threadId, "thread-native-log-failure");
      assert.deepEqual(closeCallsDuringRun, []);
    }),
  );
});
