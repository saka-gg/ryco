import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { dual } from "effect/Function";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexError from "./errors.ts";
import * as CodexProtocol from "./protocol.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";

const encoder = new TextEncoder();

const encodeJsonl = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`);

/**
 * A `timeoutOrElse` whose deadlines expire only once `fire` completes, as a
 * stall-aware one does while the loop is not free. Records each budget when
 * its deadline starts waiting.
 */
const timeoutOrElseOnSignal = (
  fire: Deferred.Deferred<void>,
  durations: Array<number> = [],
): typeof Effect.timeoutOrElse =>
  dual(
    2,
    <A, E, R, A2, E2, R2>(
      self: Effect.Effect<A, E, R>,
      options: {
        readonly duration: Duration.Input;
        readonly orElse: () => Effect.Effect<A2, E2, R2>;
      },
    ): Effect.Effect<A | A2, E | E2, R | R2> =>
      Effect.raceFirst(
        self,
        Effect.sync(() => durations.push(Duration.toMillis(options.duration))).pipe(
          Effect.andThen(Deferred.await(fire)),
          Effect.andThen(options.orElse),
        ),
      ),
  );

it.layer(NodeServices.layer)("effect-codex-app-server protocol", (it) => {
  it.effect(
    "publishes writer failure and fails outstanding requests even if input stays open",
    () =>
      Effect.gen(function* () {
        const memory = yield* makeInMemoryStdio();
        const terminated = yield* Deferred.make<CodexError.CodexAppServerError>();
        const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
          stdio: Stdio.make({
            args: Effect.succeed([]),
            stdin: memory.stdio.stdin,
            stdout: () => Sink.forEach(() => Effect.die(new Error("broken pipe"))),
            stderr: () => Sink.drain,
          }),
          onTermination: (error) => Deferred.succeed(terminated, error).pipe(Effect.asVoid),
        });
        const pending = yield* transport
          .request("thread/read", {})
          .pipe(Effect.asVoid, Effect.flip, Effect.forkScoped);
        const error = yield* Deferred.await(terminated);
        assert.instanceOf(error, CodexError.CodexAppServerTransportError);
        assert.strictEqual(yield* Fiber.join(pending), error);
        assert.strictEqual(
          yield* transport.request("thread/read", {}).pipe(Effect.asVoid, Effect.flip),
          error,
        );
      }),
  );
  it.effect("keeps notifications and responses flowing while a server request waits", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const release = yield* Deferred.make<{ decision: string }>();
      const seen = yield* Deferred.make<void>();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onRequest: () => Deferred.await(release),
        onNotification: () => Deferred.succeed(seen, undefined).pipe(Effect.asVoid),
      });
      const pending = yield* transport.request("thread/read", {}).pipe(Effect.forkScoped);
      yield* Queue.take(output);
      yield* Queue.offer(input, encodeJsonl({ id: 77, method: "item/tool/requestUserInput" }));
      yield* Queue.offer(
        input,
        encodeJsonl({ method: "item/agentMessage/delta", params: { delta: "ok" } }),
      );
      yield* Queue.offer(input, encodeJsonl({ id: 1, result: { alive: true } }));
      yield* Deferred.await(seen);
      assert.deepEqual(yield* Fiber.join(pending), { alive: true });
      yield* Deferred.succeed(release, { decision: "accept" });
      assert.deepEqual(JSON.parse(yield* Queue.take(output)), {
        id: 77,
        result: { decision: "accept" },
      });
    }),
  );

  it.effect("rejects excess concurrent handlers without blocking later responses", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onRequest: () => Effect.never,
      });
      for (let id = 100; id < 133; id++)
        yield* Queue.offer(input, encodeJsonl({ id, method: "x/approval" }));
      const rejected = JSON.parse(yield* Queue.take(output));
      assert.equal(rejected.id, 132);
      assert.equal(rejected.error.code, -32001);
      const response = yield* transport.request("x/read").pipe(Effect.forkScoped);
      const request = JSON.parse(yield* Queue.take(output));
      yield* Queue.offer(input, encodeJsonl({ id: request.id, result: "ok" }));
      assert.equal(yield* Fiber.join(response), "ok");
    }),
  );

  it.effect("ignores noisy stdout and accepts valid frames larger than 8 MiB", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const seen = yield* Deferred.make<CodexProtocol.CodexAppServerIncomingNotification>();
      yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onNotification: (event) => Deferred.succeed(seen, event).pipe(Effect.asVoid),
      });
      yield* Queue.offer(input, encoder.encode('hook noise\n{"partial":\n{}\n[]\n'));
      const event = { method: "item/completed", params: { output: "x".repeat(9 * 1024 * 1024) } };
      yield* Queue.offer(input, encodeJsonl(event));
      assert.deepEqual(yield* Deferred.await(seen), event);
    }),
  );

  it.effect("hard frame overflow terminates handlers and rejects all subsequent writes", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const terminated = yield* Deferred.make<CodexError.CodexAppServerError>();
      const entered = yield* Deferred.make<void>();
      const cleaned = yield* Deferred.make<void>();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        maxFrameBytes: 128,
        onRequest: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(cleaned, undefined)),
          ),
        onTermination: (error) => Deferred.succeed(terminated, error).pipe(Effect.asVoid),
      });
      yield* Queue.offer(input, encodeJsonl({ id: 77, method: "x/approval" }));
      yield* Deferred.await(entered);
      const pending = yield* transport
        .request("thread/read", {})
        .pipe(Effect.asVoid, Effect.flip, Effect.forkScoped);
      yield* Queue.take(output);
      yield* Queue.offer(input, encoder.encode("x".repeat(129)));
      const error = yield* Deferred.await(terminated);
      assert.instanceOf(error, CodexError.CodexAppServerProtocolOverloadedError);
      assert.strictEqual(yield* Fiber.join(pending), error);
      assert.strictEqual(
        yield* transport.request("thread/read", {}).pipe(Effect.asVoid, Effect.flip),
        error,
      );
      assert.strictEqual(
        yield* transport.notify("initialized").pipe(Effect.asVoid, Effect.flip),
        error,
      );
      yield* Deferred.await(cleaned);
    }),
  );

  it.effect("bounds request waits and ignores late responses without retrying the request", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        requestTimeoutMs: 1_000,
      });
      const pending = yield* transport
        .request("turn/start", {})
        .pipe(Effect.asVoid, Effect.flip, Effect.forkScoped);
      yield* Queue.take(output);
      yield* TestClock.adjust("1 second");
      assert.instanceOf(yield* Fiber.join(pending), CodexError.CodexAppServerTransportError);
      yield* Queue.offer(input, encodeJsonl({ id: 1, result: { ignored: true } }));
      const next = yield* transport.request("thread/read", {}).pipe(Effect.forkScoped);
      const request = JSON.parse(yield* Queue.take(output));
      assert.equal(request.method, "thread/read");
      yield* Queue.offer(input, encodeJsonl({ id: request.id, result: "ok" }));
      assert.equal(yield* Fiber.join(next), "ok");
    }),
  );
  it.effect("runs request deadlines through the injected timeoutOrElse", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const durations: Array<number> = [];
      const fire = yield* Deferred.make<void>();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        requestTimeoutMs: 1_000,
        timeoutOrElse: timeoutOrElseOnSignal(fire, durations),
      });
      const pending = yield* transport.request("turn/start", {}).pipe(Effect.forkScoped);
      const sent = JSON.parse(yield* Queue.take(output));
      assert.deepStrictEqual(durations, [1_000]);
      // A stall-aware deadline that has not fired keeps the request alive past the plain timer.
      yield* TestClock.adjust("1 second");
      assert.isUndefined(pending.pollUnsafe());
      yield* Queue.offer(input, encodeJsonl({ id: sent.id, result: "late" }));
      assert.equal(yield* Fiber.join(pending), "late");

      // When the deadline fires, the request fails exactly as on a plain one.
      const expiring = yield* transport
        .request("thread/read", {})
        .pipe(Effect.asVoid, Effect.flip, Effect.forkScoped);
      yield* Queue.take(output);
      yield* Deferred.succeed(fire, undefined);
      const error = yield* Fiber.join(expiring);
      assert.instanceOf(error, CodexError.CodexAppServerTransportError);
      assert.include(error.message, "thread/read request timed out");
    }),
  );
  it.effect("runs the outgoing enqueue deadline through the injected timeoutOrElse", () =>
    Effect.gen(function* () {
      const memory = yield* makeInMemoryStdio();
      const fire = yield* Deferred.make<void>();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio: Stdio.make({
          args: Effect.succeed([]),
          stdin: memory.stdio.stdin,
          // A writer that never drains: the outgoing queue fills up.
          stdout: () => Sink.forEach(() => Effect.never),
          stderr: () => Sink.drain,
        }),
        timeoutOrElse: timeoutOrElseOnSignal(fire),
      });
      const progress = { sent: 0 };
      const flood = yield* Effect.forEach(
        Array.from({ length: 1_000 }),
        () =>
          transport.notify("initialized").pipe(
            Effect.andThen(
              Effect.sync(() => {
                progress.sent += 1;
              }),
            ),
          ),
        { discard: true },
      ).pipe(Effect.flip, Effect.forkScoped);
      // Let the flood fill the queue (capacity 256) and block on the next offer.
      for (let i = 0; i < 10_000 && progress.sent < 256; i++) yield* Effect.yieldNow;
      assert.isAtLeast(progress.sent, 256);
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
      yield* TestClock.adjust("2 seconds");
      assert.isUndefined(flood.pollUnsafe());
      yield* Deferred.succeed(fire, undefined);
      const error = yield* Fiber.join(flood);
      assert.instanceOf(error, CodexError.CodexAppServerProtocolOverloadedError);
    }),
  );
  it.effect(
    "encodes requests without a jsonrpc field and routes inbound requests and notifications",
    () =>
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

        const notificationDeferred =
          yield* Deferred.make<ReadonlyArray<CodexProtocol.CodexAppServerIncomingNotification>>();
        const requestDeferred =
          yield* Deferred.make<ReadonlyArray<CodexProtocol.CodexAppServerIncomingRequest>>();

        yield* transport.incomingNotifications.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.flatMap((notifications) => Deferred.succeed(notificationDeferred, notifications)),
          Effect.forkScoped,
        );

        yield* transport.incomingRequests.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.flatMap((requests) => Deferred.succeed(requestDeferred, requests)),
          Effect.forkScoped,
        );

        yield* transport.notify("initialized");
        assert.equal(yield* Queue.take(output), '{"method":"initialized"}\n');

        const initializeParams = {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        };

        const pendingInitialize = yield* transport
          .request("initialize", initializeParams)
          .pipe(Effect.forkScoped);
        assert.deepEqual(JSON.parse(yield* Queue.take(output)), {
          id: 1,
          method: "initialize",
          params: initializeParams,
        });

        yield* Queue.offer(
          input,
          encodeJsonl({
            method: "item/agentMessage/delta",
            params: {
              delta: "Hello from the mock peer.",
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          }),
        );
        yield* Queue.offer(
          input,
          encodeJsonl({
            id: 77,
            method: "item/tool/requestUserInput",
            params: {
              itemId: "item-approval-1",
              threadId: "thread-1",
              turnId: "turn-1",
              questions: [
                {
                  id: "approved",
                  header: "Approve",
                  question: "Continue?",
                },
              ],
            },
          }),
        );
        yield* Queue.offer(
          input,
          encodeJsonl({
            id: 1,
            result: {
              userAgent: "mock-codex-app-server",
              codexHome: "/tmp/codex-home",
              platformFamily: "unix",
              platformOs: "macos",
            },
          }),
        );

        assert.deepEqual(yield* Fiber.join(pendingInitialize), {
          userAgent: "mock-codex-app-server",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        });
        assert.deepEqual(yield* Deferred.await(notificationDeferred), [
          {
            method: "item/agentMessage/delta",
            params: {
              delta: "Hello from the mock peer.",
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          },
        ]);
        assert.deepEqual(yield* Deferred.await(requestDeferred), [
          {
            id: 77,
            method: "item/tool/requestUserInput",
            params: {
              itemId: "item-approval-1",
              threadId: "thread-1",
              turnId: "turn-1",
              questions: [
                {
                  id: "approved",
                  header: "Approve",
                  question: "Continue?",
                },
              ],
            },
          },
        ]);

        yield* transport.respond(77, {
          answers: {
            approved: {
              answers: ["yes"],
            },
          },
        });
        assert.deepEqual(JSON.parse(yield* Queue.take(output)), {
          id: 77,
          result: {
            answers: {
              approved: {
                answers: ["yes"],
              },
            },
          },
        });

        yield* transport.respondError(
          78,
          CodexError.CodexAppServerRequestError.methodNotFound("x/test"),
        );
        assert.deepEqual(JSON.parse(yield* Queue.take(output)), {
          id: 78,
          error: {
            code: -32601,
            message: "Method not found: x/test",
          },
        });
      }),
  );

  it.effect("surfaces JSON encoding failures as protocol parse errors", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

      const bigintError = yield* transport.notify("x/test", 1n).pipe(Effect.asVoid, Effect.flip);
      assert.instanceOf(bigintError, CodexError.CodexAppServerProtocolParseError);
      assert.equal(bigintError.detail, "Failed to encode Codex App Server message");

      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const circularError = yield* transport
        .notify("x/test", circular)
        .pipe(Effect.asVoid, Effect.flip);
      assert.instanceOf(circularError, CodexError.CodexAppServerProtocolParseError);
      assert.equal(circularError.detail, "Failed to encode Codex App Server message");
    }),
  );

  it.effect("routes a large notification fragmented across thousands of input chunks", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const received = yield* Deferred.make<CodexProtocol.CodexAppServerIncomingNotification>();
      yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onNotification: (notification) =>
          Deferred.succeed(received, notification).pipe(Effect.asVoid),
      });

      const notification = {
        method: "turn/diff/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          diff: "x".repeat(4 * 1024 * 1024),
        },
      };
      const bytes = encodeJsonl(notification);
      for (let offset = 0; offset < bytes.length; offset += 1024) {
        yield* Queue.offer(input, bytes.subarray(offset, offset + 1024));
      }

      assert.deepEqual(yield* Deferred.await(received), notification);
    }),
  );

  it.effect.each([1, 7, 1024])(
    "preserves UTF-8 and CRLF framing across %i-byte chunks",
    (chunkSize) =>
      Effect.gen(function* () {
        const { stdio, input } = yield* makeInMemoryStdio();
        const notifications: Array<CodexProtocol.CodexAppServerIncomingNotification> = [];
        const complete = yield* Deferred.make<void>();
        yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
          stdio,
          onNotification: (notification) =>
            Effect.sync(() => {
              notifications.push(notification);
              return notifications.length;
            }).pipe(
              Effect.flatMap((count) =>
                count === 3 ? Deferred.succeed(complete, undefined) : Effect.void,
              ),
            ),
        });

        const bytes = encoder.encode(
          '\n \t\r\n{"method":"x/first","params":{"text":"hé🙂"}}\r\n' +
            '{"method":"x/second","params":{"value":2}}\n' +
            '{"method":"x/final","params":{"text":"最後"}}\r\n',
        );
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          yield* Queue.offer(input, bytes.subarray(offset, offset + chunkSize));
        }

        yield* Deferred.await(complete);
        assert.deepEqual(notifications, [
          { method: "x/first", params: { text: "hé🙂" } },
          { method: "x/second", params: { value: 2 } },
          { method: "x/final", params: { text: "最後" } },
        ]);
      }),
  );

  it.effect("reports a malformed fragmented final line before terminating pending requests", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const termination = yield* Deferred.make<CodexError.CodexAppServerError>();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });
      const response = yield* transport.request("thread/read", {}).pipe(Effect.forkScoped);
      yield* Queue.take(output);

      yield* Queue.offer(input, encoder.encode('{"id":1,'));
      yield* Queue.offer(input, encoder.encode('"result":'));
      yield* Queue.end(input);

      const error = yield* Deferred.await(termination);
      assert.instanceOf(error, CodexError.CodexAppServerProtocolParseError);
      const responseError = yield* Fiber.join(response).pipe(
        Effect.match({
          onFailure: (failure) => failure,
          onSuccess: () => assert.fail("Expected the malformed response to fail the request"),
        }),
      );
      assert.strictEqual(responseError, error);
    }),
  );
});
