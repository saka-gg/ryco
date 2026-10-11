import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

/**
 * The RPC client heartbeat (patched in `patches/effect@4.0.2.patch`) checks
 * liveness on each ping tick. Effect 4.0.2 defaults the timeout to the ping
 * interval, which leaves no slack for timer drift: on loopback the pong lands
 * before the drift, so a healthy idle connection looks dead and every in-flight
 * RPC fails. The desktop app talks to its local server over loopback, so this
 * runs the real pinger against a server that answers instantly.
 */
describe("RPC client heartbeat", () => {
  it.live("keeps a healthy idle loopback connection alive with the default timeout", () =>
    Effect.gen(function* () {
      const counts = { connect: 0, ping: 0, pong: 0, timeout: 0 };
      const server = yield* Effect.acquireRelease(
        Effect.callback<InstanceType<typeof NodeSocket.NodeWS.WebSocketServer>>((resume) => {
          const wss = new NodeSocket.NodeWS.WebSocketServer({ host: "127.0.0.1", port: 0 });
          wss.on("listening", () => resume(Effect.succeed(wss)));
          wss.on("connection", (ws) => {
            ws.on("message", (data) => {
              const message = JSON.parse(String(data)) as { readonly _tag?: string };
              if (message._tag === "Ping") ws.send(JSON.stringify({ _tag: "Pong" }));
            });
          });
        }),
        (wss) => Effect.callback<void>((resume) => wss.close(() => resume(Effect.void))),
      );
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        return yield* Effect.die(new Error("WebSocket server has no port"));
      }

      const hooks = Layer.succeed(
        RpcClient.ConnectionHooks,
        RpcClient.ConnectionHooks.of({
          onConnect: Effect.sync(() => void counts.connect++),
          onDisconnect: Effect.void,
          onPing: Effect.sync(() => void counts.ping++),
          onPong: Effect.sync(() => void counts.pong++),
          onPingTimeout: Effect.sync(() => void counts.timeout++),
        }),
      );
      const layer = Layer.mergeAll(
        Socket.layerWebSocket(`ws://127.0.0.1:${address.port}`).pipe(
          Layer.provide(NodeSocket.layerWebSocketConstructor),
        ),
        RpcSerialization.layerJson,
        hooks,
      );

      yield* Effect.gen(function* () {
        yield* RpcClient.makeProtocolSocket({ pingInterval: "100 millis" });
        yield* Effect.sleep("1500 millis");
      }).pipe(Effect.scoped, Effect.provide(layer));

      expect(counts.timeout).toBe(0);
      expect(counts.connect).toBe(1);
      expect(counts.ping).toBeGreaterThanOrEqual(5);
      expect(counts.pong).toBeGreaterThanOrEqual(5);
    }),
  );
});
