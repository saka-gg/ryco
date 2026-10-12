/**
 * Graceful HTTP shutdown with open WebSockets (patched @effect/platform-node:
 * WebSocket clients are asked to go away before `server.close()` is awaited).
 */
import * as Http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { describe, expect, it } from "vite-plus/test";

/** Holds every upgraded socket open until the peer or the server closes it. */
const echoUntilClosed = HttpRouter.add(
  "GET",
  "/ws",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const socket = yield* request.upgrade;
    const reader = yield* socket.reader;
    yield* Effect.forever(reader.pull).pipe(Effect.ignore);
    return HttpServerResponse.empty();
  }).pipe(Effect.scoped),
);

describe("HTTP server shutdown", () => {
  it("closes open WebSockets with 1001 instead of waiting out the graceful timeout", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const serverContext = yield* Layer.buildWithScope(
        NodeHttpServer.layer(() => Http.createServer(), {
          host: "127.0.0.1",
          port: 0,
          gracefulShutdownTimeout: "10 seconds",
        }),
        scope,
      );
      yield* Layer.buildWithScope(
        HttpRouter.serve(echoUntilClosed, { disableLogger: true, disableListenLog: true }),
        scope,
      ).pipe(Effect.provide(serverContext));
      const address = Context.get(serverContext, HttpServer.HttpServer).address;
      if (!("port" in address)) throw new Error("expected a TCP address");

      const client = new NodeSocket.NodeWS.WebSocket(`ws://127.0.0.1:${address.port}/ws`);
      const closed = new Promise<number>((resolve) => client.once("close", resolve));
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            client.once("open", () => resolve());
            client.once("error", reject);
          }),
      );

      const startedAt = Date.now();
      yield* Scope.close(scope, Exit.void);
      return { elapsedMs: Date.now() - startedAt, closeCode: yield* Effect.promise(() => closed) };
    });

    const result = await Effect.runPromise(program);
    expect(result.closeCode).toBe(1001);
    expect(result.elapsedMs).toBeLessThan(2_000);
  });
});
