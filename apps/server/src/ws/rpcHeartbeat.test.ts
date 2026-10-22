import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { describe, expect, it } from "@effect/vitest";
import { Clock, Duration, Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

type HeartbeatEvent = "connect" | "ping" | "pong" | "timeout" | "disconnect";

/** A loopback WebSocket server that answers the first `answeredPings` pings. */
const serveLoopback = (answeredPings: number) =>
  Effect.gen(function* () {
    let pings = 0;
    const server = yield* Effect.acquireRelease(
      Effect.callback<InstanceType<typeof NodeSocket.NodeWS.WebSocketServer>>((resume) => {
        const wss = new NodeSocket.NodeWS.WebSocketServer({ host: "127.0.0.1", port: 0 });
        wss.on("listening", () => resume(Effect.succeed(wss)));
        wss.on("connection", (ws) => {
          ws.on("message", (data) => {
            const message = JSON.parse(String(data)) as { readonly _tag?: string };
            if (message._tag === "Ping" && pings++ < answeredPings) {
              ws.send(JSON.stringify({ _tag: "Pong" }));
            }
          });
        });
      }),
      (wss) => Effect.callback<void>((resume) => wss.close(() => resume(Effect.void))),
    );
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      return yield* Effect.die(new Error("WebSocket server has no port"));
    }
    return `ws://127.0.0.1:${address.port}`;
  });

/**
 * Wraps the current clock: wall-clock reads run `skewMillis` away from the real
 * time, the way a throttled or suspended timer sees it, and every sleep is
 * recorded.
 */
const makeSkewedClock = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const state = { skewMillis: 0, sleeps: [] as Array<number> };
  const skewed: Clock.Clock = {
    currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + state.skewMillis,
    currentTimeMillis: Effect.sync(() => clock.currentTimeMillisUnsafe() + state.skewMillis),
    currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
    currentTimeNanos: clock.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: clock.monotonicTimeNanos,
    sleep: (duration) => {
      state.sleeps.push(Duration.toMillis(duration));
      return clock.sleep(duration);
    },
  };
  return { state, clock: skewed };
});

/**
 * Runs the client protocol on a skewed clock against a loopback server for
 * `maxMillis`, or until `until` holds, recording the connection hooks in order.
 * `onPong` receives the number of pongs seen so far and runs after the frame
 * has refreshed liveness, so a skew it applies shows from the next tick on.
 */
const runHeartbeat = (options: {
  readonly protocol?: Parameters<typeof RpcClient.makeProtocolSocket>[0];
  readonly answeredPings?: number;
  readonly onPong?: (pongs: number, clock: { skewMillis: number }) => void;
  readonly until?: (events: ReadonlyArray<HeartbeatEvent>) => boolean;
  readonly maxMillis: number;
}) =>
  Effect.gen(function* () {
    const serverUrl = yield* serveLoopback(options.answeredPings ?? Number.POSITIVE_INFINITY);
    const { state, clock } = yield* makeSkewedClock;
    const events: Array<HeartbeatEvent> = [];
    const sockets: Array<Socket.WebSocketLike> = [];
    const timeouts: Array<{ readonly at: number; readonly readyState: number | undefined }> = [];
    let pongs = 0;

    const hooks = Layer.succeed(
      RpcClient.ConnectionHooks,
      RpcClient.ConnectionHooks.of({
        onConnect: Effect.sync(() => void events.push("connect")),
        onDisconnect: Effect.sync(() => void events.push("disconnect")),
        onPing: Effect.sync(() => void events.push("ping")),
        onPong: Effect.sync(() => {
          events.push("pong");
          options.onPong?.(++pongs, state);
        }),
        onPingTimeout: Effect.sync(() => {
          events.push("timeout");
          timeouts.push({ at: performance.now(), readyState: sockets.at(-1)?.readyState });
        }),
      }),
    );
    // Keeps each client socket so a hook can read its state.
    const webSocketConstructor = Layer.succeed(Socket.WebSocketConstructor)((
      url,
      socketOptions,
    ) => {
      const socket =
        socketOptions === undefined ||
        typeof socketOptions === "string" ||
        Array.isArray(socketOptions)
          ? new NodeSocket.NodeWS.WebSocket(url, socketOptions)
          : new NodeSocket.NodeWS.WebSocket(url, socketOptions.protocols, {
              headers: socketOptions.headers,
            });
      sockets.push(socket);
      return socket;
    });
    const layer = Layer.mergeAll(
      Socket.layerWebSocket(serverUrl).pipe(Layer.provide(webSocketConstructor)),
      RpcSerialization.layerJson,
      hooks,
    );

    yield* Effect.gen(function* () {
      yield* RpcClient.makeProtocolSocket(options.protocol).pipe(
        Effect.provideService(Clock.Clock, clock),
      );
      // The hooks append to `events` from the client's own fibers.
      const deadline = performance.now() + options.maxMillis;
      const done = () => options.until?.(events) === true || performance.now() >= deadline;
      while (!done()) {
        yield* Effect.sleep("10 millis");
      }
    }).pipe(Effect.scoped, Effect.provide(layer));

    return { events, timeouts, sleeps: state.sleeps };
  });

const count = (events: ReadonlyArray<HeartbeatEvent>, event: HeartbeatEvent) =>
  events.filter((candidate) => candidate === event).length;

/**
 * The RPC client heartbeat (patched locally) pings every 8 seconds by default
 * and checks liveness on each ping tick, against a timeout of twice the
 * interval. A timeout equal to the interval leaves no slack for timer drift: on
 * loopback the pong lands before the drift, so a healthy idle connection would
 * look dead and every in-flight RPC would fail. A tick that runs late (a
 * throttled background tab, a suspended laptop) sends a ping before it may
 * declare the connection silent. The desktop app talks to its local server over
 * loopback, so these run the real pinger against a server that answers
 * instantly.
 */
describe("RPC client heartbeat", () => {
  it.live("keeps a healthy idle loopback connection alive with the default timeout", () =>
    Effect.gen(function* () {
      const { events } = yield* runHeartbeat({
        protocol: { pingInterval: "100 millis" },
        maxMillis: 1_500,
      });

      expect(count(events, "timeout")).toBe(0);
      expect(count(events, "connect")).toBe(1);
      expect(count(events, "ping")).toBeGreaterThanOrEqual(5);
      expect(count(events, "pong")).toBeGreaterThanOrEqual(5);
    }),
  );

  it.live("keeps a healthy connection alive when a ping tick runs late", () =>
    Effect.gen(function* () {
      const skewAfterPongs = 3;
      const { events } = yield* runHeartbeat({
        protocol: { pingInterval: "100 millis" },
        // The next tick sees a minute since the last frame, as in a throttled tab.
        onPong: (pongs, clock) => {
          if (pongs === skewAfterPongs) clock.skewMillis += 60_000;
        },
        maxMillis: 1_500,
      });

      expect(count(events, "timeout")).toBe(0);
      expect(count(events, "connect")).toBe(1);
      expect(count(events, "pong") - skewAfterPongs).toBeGreaterThanOrEqual(3);
    }),
  );

  it.live("times out a silent server once, before disconnecting, after twice the interval", () =>
    Effect.gen(function* () {
      let lastPongAt = 0;
      const { events, timeouts } = yield* runHeartbeat({
        protocol: { pingInterval: "100 millis" },
        answeredPings: 3,
        // Half an interval behind keeps every later check off the timeout
        // boundary, so timer drift cannot move the verdict across a tick.
        onPong: (pongs, clock) => {
          if (pongs !== 3) return;
          lastPongAt = performance.now();
          clock.skewMillis = -50;
        },
        until: (events) => events.includes("disconnect"),
        maxMillis: 2_000,
      });

      expect(events.filter((event) => event !== "ping").slice(0, 6)).toEqual([
        "connect",
        "pong",
        "pong",
        "pong",
        "timeout",
        "disconnect",
      ]);
      // The hook reports the timeout while the socket is still open.
      const [timeout] = timeouts;
      expect(timeout?.readyState).toBe(NodeSocket.NodeWS.WebSocket.OPEN);
      const silentMillis = (timeout?.at ?? 0) - lastPongAt;
      expect(silentMillis).toBeGreaterThanOrEqual(250);
      expect(silentMillis).toBeLessThan(450);
    }),
  );

  it.live("pings every 8 seconds by default", () =>
    Effect.gen(function* () {
      const { sleeps } = yield* runHeartbeat({ maxMillis: 300 });

      expect(sleeps).toContain(8_000);
      expect(sleeps).not.toContain(5_000);
    }),
  );
});
