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
import { Effect, Queue, type Scope } from "effect";
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

/** Serves `output` until the viewer leaves, a `close` arrives, or the viewer falls too far behind. */
export const serveViewerSocket = (
  socket: ViewerSocket,
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
    // The viewer may send only acknowledgements; anything else is ignored.
    const receive = (chunk: string | Uint8Array) => {
      if (!isNodeBrowserFrameAck(chunk)) return Effect.void;
      const acked = inFlight;
      const next = pending;
      inFlight = null;
      pending = null;
      return Effect.andThen(release(acked), next ? sendFrame(next) : Effect.void);
    };
    const receiveAll = socket.pull.pipe(
      Effect.flatMap((chunks) => Effect.forEach(chunks, receive, { discard: true })),
    );
    return yield* Effect.raceFirst(Effect.forever(sendOutput), Effect.forever(receiveAll)).pipe(
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
