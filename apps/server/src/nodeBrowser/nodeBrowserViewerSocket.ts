/**
 * nodeBrowserViewerSocket - Sends one viewer's frames over its socket, one at
 * a time: the next frame goes out only once the viewer has acknowledged the
 * one before it, and only the newest frame waits behind it. A slow link then
 * shows fewer frames instead of older ones, and never builds a backlog.
 *
 * Each frame carries the acknowledgement Chromium waits for before it sends
 * another (`ack`, paced by the caller). It runs once the viewer acknowledged
 * the frame, and also for every frame never sent, so one stalled viewer
 * never stops the screencast.
 *
 * @module nodeBrowserViewerSocket
 */
import { isNodeBrowserFrameAck } from "@ryco/shared/nodeBrowserFrame";
import { Deferred, Effect, Queue, type Scope } from "effect";
import { Socket } from "effect/socket";

/** A viewer whose connection holds more than this unsent is dropped. */
export const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;
// The largest WebSocket frame header.
const WEBSOCKET_HEADER_BYTES = 14;

export type ViewerOutput =
  | {
      readonly _tag: "frame";
      readonly data: Uint8Array;
      /** Releases Chromium for its next frame. */
      readonly ack: Effect.Effect<void>;
    }
  | { readonly _tag: "close"; readonly code: number; readonly reason: string };

type Frame = Extract<ViewerOutput, { readonly _tag: "frame" }>;

export interface ViewerSocket {
  readonly write: (
    chunk: Uint8Array | Socket.CloseEvent,
  ) => Effect.Effect<void, Socket.SocketError>;
  readonly pull: Effect.Effect<ReadonlyArray<string | Uint8Array>, Socket.SocketError>;
  /** Bytes the connection holds and has not sent yet. */
  readonly bufferedBytes: () => number;
  /** Drops the connection at once. */
  readonly cut: Effect.Effect<void>;
}

// More acknowledgements than frames on the wire are meaningless; extras are dropped.
const ACK_QUEUE_LIMIT = 16;

/** What the viewer sends, read from the moment its socket opens. */
export interface ViewerClient {
  readonly acks: Queue.Dequeue<void>;
  /** Succeeds once the viewer's socket closed, however it closed. */
  readonly left: Effect.Effect<void>;
}

/**
 * Reads the viewer's socket for the life of the scope, from the start, so a
 * viewer that leaves is noticed even while nothing is sent to it yet (its
 * tab still attaching, say). Only acknowledgements are kept; anything else
 * is ignored, never dispatched.
 */
export const readViewerClient = (
  pull: ViewerSocket["pull"],
): Effect.Effect<ViewerClient, never, Scope.Scope> =>
  Effect.gen(function* () {
    const acks = yield* Queue.dropping<void>(ACK_QUEUE_LIMIT);
    const left = yield* Deferred.make<void>();
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.flatMap(pull, (chunks) =>
          Effect.sync(() => {
            for (const chunk of chunks) {
              if (isNodeBrowserFrameAck(chunk)) Queue.offerUnsafe(acks, undefined);
            }
          }),
        ),
      ).pipe(Effect.ensuring(Deferred.succeed(left, undefined))),
    );
    return { acks, left: Deferred.await(left) };
  });

/** Serves `output` until the viewer leaves, a `close` arrives, or the viewer falls too far behind. */
export const serveViewerSocket = (
  socket: ViewerSocket,
  client: ViewerClient,
  output: Queue.Dequeue<ViewerOutput>,
): Effect.Effect<void, Socket.SocketError, Scope.Scope> =>
  Effect.gen(function* () {
    let inFlight: Effect.Effect<void> | null = null;
    let pending: Frame | null = null;
    const release = (ack: Effect.Effect<void> | null) =>
      ack === null ? Effect.void : Effect.asVoid(Effect.forkScoped(ack));
    const write = (data: Uint8Array) =>
      Effect.suspend(() =>
        socket.bufferedBytes() + data.byteLength + WEBSOCKET_HEADER_BYTES > MAX_SOCKET_BUFFER_BYTES
          ? socket.cut.pipe(Effect.andThen(Effect.interrupt))
          : socket.write(data),
      );
    const sendFrame = (frame: Frame) => {
      inFlight = frame.ack;
      return write(frame.data);
    };
    const sendOutput = Queue.take(output).pipe(
      Effect.flatMap((next) => {
        if (next._tag === "close") {
          return socket
            .write(new Socket.CloseEvent(next.code, next.reason))
            .pipe(Effect.andThen(Effect.interrupt));
        }
        if (inFlight === null) return sendFrame(next);
        const superseded = pending;
        pending = next;
        // Never sent, but Chromium still waits for its acknowledgement.
        return release(superseded?.ack ?? null);
      }),
    );
    const receive = Effect.flatMap(Queue.take(client.acks), () => {
      const acked = inFlight;
      const next = pending;
      inFlight = null;
      pending = null;
      return Effect.andThen(release(acked), next ? sendFrame(next) : Effect.void);
    });
    // The first to end, however it ends, ends the socket.
    return yield* Effect.raceFirst(
      Effect.raceFirst(Effect.forever(sendOutput), Effect.forever(receive)),
      client.left,
    ).pipe(
      // Whatever was never acknowledged still releases Chromium, after this socket is gone.
      Effect.ensuring(
        Effect.suspend(() =>
          Effect.forEach(
            [inFlight, pending?.ack].filter((ack) => ack != null),
            (ack) => Effect.forkDetach(ack),
            { discard: true },
          ),
        ),
      ),
    );
  });
