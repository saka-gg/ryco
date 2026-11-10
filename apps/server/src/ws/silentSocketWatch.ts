/**
 * Ends direct WebSocket connections whose client went silent.
 *
 * Only the client checked the connection: it pings every 8 s (about once a
 * minute in a hidden browser tab, where timers are throttled). A laptop that
 * slept or a phone that left the network sends nothing more, yet the server
 * kept its subscriptions, live queues (up to 4 MiB per stream) and per-event
 * work until the operating system gave up on the socket, which can take many
 * minutes. The server now ends a connection from which no frame (a ping, a
 * request, an acknowledgement) arrived for {@link DIRECT_SOCKET_SILENCE_TIMEOUT_MS}:
 * three of the slowest ping intervals a live client produces, the same
 * silence after which the client itself treats its connection as dead
 * (`VIEW_RESUME_SILENT_MS`). A client that comes back reconnects and resumes,
 * as it does after any lost connection.
 *
 * @module silentSocketWatch
 */
import { Clock, Effect } from "effect";
import type { HttpServerRequest } from "effect/http";
import * as Socket from "effect/socket/Socket";

export const DIRECT_SOCKET_SILENCE_TIMEOUT_MS = 3 * 60_000;

export interface SilentSocketWatch {
  /** The request to serve: its upgraded socket records each frame it reads. */
  readonly request: HttpServerRequest.HttpServerRequest;
  /** Completes once the client has sent nothing for the timeout. */
  readonly silent: Effect.Effect<void>;
}

const watchReads = (socket: Socket.Socket, touch: () => void): Socket.Socket => ({
  [Socket.TypeId]: Socket.TypeId,
  reader: Effect.map(socket.reader, (reader) => ({
    pull: Effect.tap(reader.pull, () => Effect.sync(touch)),
    upgrade: reader.upgrade,
  })),
  writer: socket.writer,
});

export const makeSilentSocketWatch = (
  request: HttpServerRequest.HttpServerRequest,
  options: { readonly timeoutMs?: number } = {},
): Effect.Effect<SilentSocketWatch> =>
  Effect.gen(function* () {
    const timeoutMs = options.timeoutMs ?? DIRECT_SOCKET_SILENCE_TIMEOUT_MS;
    const clock = yield* Clock.Clock;
    // The upgrade itself is the client's first word.
    let lastFrameAt = clock.currentTimeMillisUnsafe();
    const touch = () => {
      lastFrameAt = clock.currentTimeMillisUnsafe();
    };
    const upgrade = Effect.map(request.upgrade, (socket) => watchReads(socket, touch));
    const watched = new Proxy(request, {
      get(target, property) {
        if (property === "upgrade") return upgrade;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    // Wakes when the timeout would run out since the last frame, so a busy
    // connection costs one timer per timeout, not one per frame.
    const silent: Effect.Effect<void> = Effect.suspend(() => {
      const waitMs = lastFrameAt + timeoutMs - clock.currentTimeMillisUnsafe();
      return waitMs <= 0 ? Effect.void : Effect.sleep(waitMs).pipe(Effect.andThen(silent));
    });
    return { request: watched, silent };
  });
