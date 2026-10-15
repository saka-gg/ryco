import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
} from "@ryco/contracts";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { makeCopilotAdapter } from "./CopilotAdapter.ts";
import { COPILOT_CLIENT_STOP_TIMEOUT_MS, stopCopilotClient } from "./CopilotAdapter.clientStop.ts";

const never = () => new Promise<never>(() => undefined);

function makeFakeClient(options: { readonly stop?: () => Promise<Array<Error>> } = {}) {
  const calls = { stop: 0, forceStop: 0 };
  return {
    calls,
    client: {
      stop: async () => {
        calls.stop += 1;
        return options.stop ? options.stop() : [];
      },
      forceStop: async () => {
        calls.forceStop += 1;
      },
    },
  };
}

it.live("stops a Copilot client gracefully when it finishes within the budget", () =>
  Effect.gen(function* () {
    const fake = makeFakeClient();
    let disconnected = 0;
    const outcome = yield* Effect.promise(() =>
      stopCopilotClient({
        client: fake.client,
        session: {
          disconnect: async () => {
            disconnected += 1;
          },
        },
        timeoutMs: 1_000,
      }),
    );
    assert.deepStrictEqual(outcome, { forced: false });
    assert.strictEqual(disconnected, 1);
    assert.deepStrictEqual(fake.calls, { stop: 1, forceStop: 0 });
  }),
);

it.live("force-stops a Copilot client whose graceful stop hangs past the budget", () =>
  Effect.gen(function* () {
    const fake = makeFakeClient({ stop: never });
    const startedAt = Date.now();
    const outcome = yield* Effect.promise(() =>
      stopCopilotClient({ client: fake.client, timeoutMs: 50 }),
    );
    const elapsedMs = Date.now() - startedAt;
    assert.deepStrictEqual(outcome, { forced: true });
    assert.deepStrictEqual(fake.calls, { stop: 1, forceStop: 1 });
    assert.isBelow(elapsedMs, 1_000);
  }),
);

it.live("force-stops when detaching the session hangs, without waiting for stop()", () =>
  Effect.gen(function* () {
    const fake = makeFakeClient();
    const outcome = yield* Effect.promise(() =>
      stopCopilotClient({ client: fake.client, session: { disconnect: never }, timeoutMs: 50 }),
    );
    assert.deepStrictEqual(outcome, { forced: true });
    assert.deepStrictEqual(fake.calls, { stop: 0, forceStop: 1 });
  }),
);

it.live("still stops the client when detaching fails, and reports the detach error", () =>
  Effect.gen(function* () {
    const fake = makeFakeClient();
    const detachError = new Error("detach failed");
    const outcome = yield* Effect.promise(() =>
      stopCopilotClient({
        client: fake.client,
        session: {
          disconnect: async () => {
            throw detachError;
          },
        },
        timeoutMs: 1_000,
      }),
    );
    assert.deepStrictEqual(outcome, { forced: false, disconnectError: detachError });
    assert.deepStrictEqual(fake.calls, { stop: 1, forceStop: 0 });
  }),
);

it.live("never rejects when stop() throws", () =>
  Effect.gen(function* () {
    const fake = makeFakeClient({
      stop: async () => {
        throw new Error("stop exploded");
      },
    });
    const outcome = yield* Effect.promise(() =>
      stopCopilotClient({ client: fake.client, timeoutMs: 1_000 }),
    );
    assert.deepStrictEqual(outcome, { forced: false });
  }),
);

describe("Copilot adapter client teardown", () => {
  const testLayer = ServerConfig.layerTest("/tmp", "/tmp").pipe(
    Layer.provideMerge(NodeServices.layer),
  );
  const instanceId = ProviderInstanceId.make("copilot");

  const makeSessionClient = (input: {
    readonly sessionId: string;
    readonly stop: () => Promise<Array<Error>>;
    readonly failCreate?: boolean;
    /** createSession never settles; `onCreate` reports that it was called. */
    readonly hangCreate?: { readonly onCreate: () => void };
  }) => {
    const calls = { stop: 0, forceStop: 0 };
    const session = {
      sessionId: input.sessionId,
      on: () => () => {},
      disconnect: async () => {},
      abort: async () => {},
      send: async () => {},
      setModel: async () => {},
    };
    const createSession = async () => {
      if (input.hangCreate) {
        input.hangCreate.onCreate();
        return never();
      }
      if (input.failCreate) throw new Error("mock session start failure");
      return session;
    };
    return {
      calls,
      client: {
        createSession,
        resumeSession: createSession,
        stop: async () => {
          calls.stop += 1;
          return input.stop();
        },
        forceStop: async () => {
          calls.forceStop += 1;
        },
      },
    };
  };

  const startInput = (threadId: ThreadId, runtimeSessionId: RuntimeSessionId) => ({
    provider: ProviderDriverKind.make("copilot"),
    providerInstanceId: instanceId,
    runtimeSessionId,
    threadId,
    runtimeMode: "approval-required" as const,
  });

  it.live(
    "stopAll stops every session concurrently and force-stops hung clients within the shutdown budget",
    () =>
      Effect.gen(function* () {
        const clients = [
          makeSessionClient({ sessionId: "copilot-session-a", stop: never }),
          makeSessionClient({ sessionId: "copilot-session-b", stop: never }),
          makeSessionClient({ sessionId: "copilot-session-c", stop: async () => [] }),
        ];
        let next = 0;
        const adapter = yield* makeCopilotAdapter(
          { binaryPath: "copilot" },
          { instanceId, clientFactory: () => clients[next++]!.client as never },
        );
        for (const [index] of clients.entries()) {
          yield* adapter.startSession(
            startInput(
              ThreadId.make(`thread-copilot-stop-${index}`),
              RuntimeSessionId.make(`runtime-copilot-stop-${index}`),
            ),
          );
        }

        const startedAt = Date.now();
        yield* adapter.stopAll();
        const elapsedMs = Date.now() - startedAt;

        // Two hung clients stopped in parallel cost one budget, not two.
        assert.isAtLeast(elapsedMs, COPILOT_CLIENT_STOP_TIMEOUT_MS - 50);
        assert.isBelow(elapsedMs, 2 * COPILOT_CLIENT_STOP_TIMEOUT_MS);
        assert.deepStrictEqual(
          clients.map(({ calls }) => calls),
          [
            { stop: 1, forceStop: 1 },
            { stop: 1, forceStop: 1 },
            { stop: 1, forceStop: 0 },
          ],
        );
        assert.deepStrictEqual(yield* adapter.listSessions(), []);
      }).pipe(Effect.provide(testLayer)),
  );

  it.live("stops the client when the session cannot be started", () =>
    Effect.gen(function* () {
      const fake = makeSessionClient({
        sessionId: "copilot-session-failing",
        stop: async () => [],
        failCreate: true,
      });
      const adapter = yield* makeCopilotAdapter(
        { binaryPath: "copilot" },
        { instanceId, clientFactory: () => fake.client as never },
      );
      const exit = yield* Effect.exit(
        adapter.startSession(
          startInput(
            ThreadId.make("thread-copilot-start-failure"),
            RuntimeSessionId.make("runtime-copilot-start-failure"),
          ),
        ),
      );
      assert.strictEqual(exit._tag, "Failure");
      assert.deepStrictEqual(fake.calls, { stop: 1, forceStop: 0 });
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("stops the client when starting the session is interrupted", () =>
    Effect.gen(function* () {
      const createCalled = yield* Deferred.make<void>();
      const fake = makeSessionClient({
        sessionId: "copilot-session-interrupted",
        stop: async () => [],
        hangCreate: { onCreate: () => Deferred.doneUnsafe(createCalled, Exit.void) },
      });
      const adapter = yield* makeCopilotAdapter(
        { binaryPath: "copilot" },
        { instanceId, clientFactory: () => fake.client as never },
      );
      const start = yield* adapter
        .startSession(
          startInput(
            ThreadId.make("thread-copilot-start-interrupted"),
            RuntimeSessionId.make("runtime-copilot-start-interrupted"),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(createCalled);
      // A start deadline, a Stop or shutdown interrupts the start while the CLI is starting.
      yield* Fiber.interrupt(start);
      assert.deepStrictEqual(fake.calls, { stop: 1, forceStop: 0 });
      assert.deepStrictEqual(yield* adapter.listSessions(), []);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("closes the native event logger it built when the adapter is released", () =>
    Effect.gen(function* () {
      const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-copilot-native-log-"));
      let emit: ((event: unknown) => void) | undefined;
      const session = {
        sessionId: "copilot-session-native-log",
        on: (handler: (event: unknown) => void) => {
          emit = handler;
          return () => {
            emit = undefined;
          };
        },
        disconnect: async () => {},
        abort: async () => {},
        send: async () => {},
        setModel: async () => {},
      };
      const client = {
        createSession: async () => session,
        resumeSession: async () => session,
        stop: async () => [],
        forceStop: async () => {},
      };
      try {
        yield* Effect.gen(function* () {
          const adapter = yield* makeCopilotAdapter(
            { binaryPath: "copilot" },
            {
              instanceId,
              nativeEventLogPath: path.join(logDir, "events.log"),
              clientFactory: () => client as never,
            },
          );
          yield* adapter.startSession(
            startInput(
              ThreadId.make("thread-copilot-native-log"),
              RuntimeSessionId.make("runtime-copilot-native-log"),
            ),
          );
          assert.isDefined(emit);
          emit!({
            id: "evt-delta",
            timestamp: new Date().toISOString(),
            parentId: null,
            ephemeral: true,
            type: "assistant.message_delta",
            data: { messageId: "msg-1", deltaContent: "hello" },
          });
          yield* Effect.sleep("10 millis");
          yield* adapter.stopAll();
        }).pipe(Effect.scoped);

        // An open delta run is only written by a flush that closes it: the
        // adapter's release.
        const nativeLog = fs.readdirSync(logDir).find((name) => name.endsWith(".native.log"));
        assert.isDefined(nativeLog);
        assert.include(fs.readFileSync(path.join(logDir, nativeLog!), "utf8"), '"text":"hello"');
      } finally {
        fs.rmSync(logDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(testLayer)),
  );
});
