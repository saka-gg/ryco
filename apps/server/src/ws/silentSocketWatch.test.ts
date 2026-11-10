import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Queue } from "effect";
import type { HttpServerRequest } from "effect/http";
import * as Socket from "effect/socket/Socket";
import { TestClock } from "effect/testing";

import { DIRECT_SOCKET_SILENCE_TIMEOUT_MS, makeSilentSocketWatch } from "./silentSocketWatch.ts";

/** A request whose upgrade yields a socket that reads the frames offered to `frames`. */
const makeRequest = Effect.gen(function* () {
  const frames = yield* Queue.unbounded<string>();
  const socket: Socket.Socket = {
    [Socket.TypeId]: Socket.TypeId,
    reader: Effect.succeed({
      pull: Effect.map(Queue.take(frames), (frame) => [frame] as const),
      upgrade: () => Effect.void,
    }),
    writer: Effect.die("unused"),
  };
  const request = {
    url: "/ws",
    upgrade: Effect.succeed(socket),
  } as unknown as HttpServerRequest.HttpServerRequest;
  return { frames, request };
});

describe("makeSilentSocketWatch", () => {
  it.effect("reports a client that sent nothing for the timeout", () =>
    Effect.gen(function* () {
      const { request } = yield* makeRequest;
      const watch = yield* makeSilentSocketWatch(request);
      const silent = yield* Effect.forkChild(watch.silent);
      yield* TestClock.adjust(DIRECT_SOCKET_SILENCE_TIMEOUT_MS - 1);
      assert.isUndefined(silent.pollUnsafe());
      yield* TestClock.adjust(1);
      yield* Fiber.join(silent);
    }),
  );

  it.effect("counts every frame the upgraded socket reads as a sign of life", () =>
    Effect.gen(function* () {
      const { frames, request } = yield* makeRequest;
      const watch = yield* makeSilentSocketWatch(request);
      // Other request fields pass through.
      assert.equal(watch.request.url, "/ws");
      const socket = yield* watch.request.upgrade;
      const reader = yield* Effect.scoped(socket.reader);
      const silent = yield* Effect.forkChild(watch.silent);

      // A ping every minute (a hidden tab) keeps the connection.
      for (let minute = 0; minute < 10; minute += 1) {
        yield* TestClock.adjust(60_000);
        yield* Queue.offer(frames, '{"_tag":"Ping"}');
        yield* reader.pull;
      }
      assert.isUndefined(silent.pollUnsafe());

      yield* TestClock.adjust(DIRECT_SOCKET_SILENCE_TIMEOUT_MS);
      yield* Fiber.join(silent);
    }),
  );
});
