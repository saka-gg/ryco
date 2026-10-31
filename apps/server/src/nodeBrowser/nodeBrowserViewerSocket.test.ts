import { describe, expect, it } from "@effect/vitest";
import { NODE_BROWSER_FRAME_ACK } from "@ryco/shared/nodeBrowserFrame";
import { Deferred, Effect, Fiber, Queue } from "effect";
import { Socket } from "effect/socket";

import {
  MAX_SOCKET_BUFFER_BYTES,
  readViewerClient,
  serveViewerSocket,
  type ViewerOutput,
} from "./nodeBrowserViewerSocket.ts";

const serve = (
  socket: Parameters<typeof serveViewerSocket>[0],
  output: Queue.Dequeue<ViewerOutput>,
) =>
  Effect.flatMap(readViewerClient(socket.pull), (client) =>
    serveViewerSocket(socket, client, output),
  );

/** A socket whose client messages the test sends, recording what the viewer was sent. */
const makeSocket = Effect.gen(function* () {
  const incoming = yield* Queue.unbounded<string | Uint8Array>();
  const written: Array<Uint8Array | Socket.CloseEvent> = [];
  let buffered = 0;
  let cut = false;
  return {
    socket: {
      write: (chunk: Uint8Array | Socket.CloseEvent) =>
        Effect.sync(() => {
          written.push(chunk);
        }),
      pull: Effect.map(Queue.take(incoming), (message) => [message]),
      bufferedBytes: () => buffered,
      cut: Effect.sync(() => {
        cut = true;
      }),
    },
    send: (message: string | Uint8Array) => Queue.offer(incoming, message),
    written,
    setBuffered: (bytes: number) => {
      buffered = bytes;
    },
    wasCut: () => cut,
  };
});

const frame = (id: number, acked: Array<number>, bytes = 4): ViewerOutput => ({
  _tag: "frame",
  data: new Uint8Array(bytes).fill(id),
  ack: Effect.sync(() => {
    acked.push(id);
  }),
});

const firstBytes = (written: ReadonlyArray<Uint8Array | Socket.CloseEvent>) =>
  written.map((chunk) => (chunk instanceof Uint8Array ? chunk[0] : `close ${chunk.code}`));

describe("node browser viewer socket", () => {
  it.live("keeps one frame on the wire and only the newest waiting behind it", () =>
    Effect.gen(function* () {
      const { socket, send, written } = yield* makeSocket;
      const output = yield* Queue.unbounded<ViewerOutput>();
      const acked: Array<number> = [];
      const serving = yield* Effect.forkScoped(serve(socket, output));

      yield* Queue.offer(output, frame(1, acked));
      yield* Queue.offer(output, frame(2, acked));
      yield* Queue.offer(output, frame(3, acked));
      yield* Effect.sleep("20 millis");
      // Frame 2 was replaced before it was sent: never written, but Chromium is released.
      expect(firstBytes(written)).toEqual([1]);
      expect(acked).toEqual([2]);

      yield* send(NODE_BROWSER_FRAME_ACK);
      yield* Effect.sleep("20 millis");
      expect(firstBytes(written)).toEqual([1, 3]);
      expect(acked).toEqual([2, 1]);

      yield* send(NODE_BROWSER_FRAME_ACK);
      yield* Effect.sleep("20 millis");
      expect(acked).toEqual([2, 1, 3]);
      expect(firstBytes(written)).toEqual([1, 3]);
      yield* Fiber.interrupt(serving);
    }).pipe(Effect.scoped),
  );

  it.live("ignores anything the viewer sends but acknowledgements", () =>
    Effect.gen(function* () {
      const { socket, send, written } = yield* makeSocket;
      const output = yield* Queue.unbounded<ViewerOutput>();
      const acked: Array<number> = [];
      yield* Effect.forkScoped(serve(socket, output));
      yield* Queue.offer(output, frame(1, acked));
      yield* Queue.offer(output, frame(2, acked));
      for (const message of [
        '{"type":"mouse","action":"down","x":1,"y":1}',
        '{"type":"navigate","url":"file:///etc/passwd"}',
        `{"type":"ack","padding":"${"x".repeat(80)}"}`,
        '["ack"]',
        "not json",
      ]) {
        yield* send(message);
      }
      yield* Effect.sleep("20 millis");
      expect(firstBytes(written)).toEqual([1]);
      expect(acked).toEqual([]);
      yield* send(new TextEncoder().encode(NODE_BROWSER_FRAME_ACK));
      yield* Effect.sleep("20 millis");
      expect(firstBytes(written)).toEqual([1, 2]);
    }).pipe(Effect.scoped),
  );

  it.live("drops a viewer whose connection holds more than 8 MiB unsent", () =>
    Effect.gen(function* () {
      const { socket, written, setBuffered, wasCut } = yield* makeSocket;
      const output = yield* Queue.unbounded<ViewerOutput>();
      const acked: Array<number> = [];
      setBuffered(MAX_SOCKET_BUFFER_BYTES - 1_000);
      const ended = yield* Deferred.make<void>();
      yield* Effect.forkScoped(
        serve(socket, output).pipe(Effect.onExit(() => Deferred.succeed(ended, undefined))),
      );
      yield* Queue.offer(output, frame(1, acked, 2_000));
      yield* Deferred.await(ended).pipe(Effect.timeout("1 second"));
      expect(wasCut()).toBe(true);
      expect(written).toEqual([]);
      // What never reached the viewer still releases Chromium.
      yield* Effect.sleep("20 millis");
      expect(acked).toEqual([1]);
    }).pipe(Effect.scoped),
  );

  it.live("sends a close with its code and stops", () =>
    Effect.gen(function* () {
      const { socket, written } = yield* makeSocket;
      const output = yield* Queue.unbounded<ViewerOutput>();
      const ended = yield* Deferred.make<void>();
      yield* Effect.forkScoped(
        serve(socket, output).pipe(Effect.onExit(() => Deferred.succeed(ended, undefined))),
      );
      yield* Queue.offer(output, { _tag: "close", code: 1012, reason: "browser restarted" });
      yield* Deferred.await(ended).pipe(Effect.timeout("1 second"));
      expect(firstBytes(written)).toEqual(["close 1012"]);
    }).pipe(Effect.scoped),
  );
});
