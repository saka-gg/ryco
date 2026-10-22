/**
 * Graceful HTTP shutdown (patched @effect/platform-node: WebSocket clients are
 * asked to go away before `server.close()` is awaited, and keep-alive
 * connections close as soon as the responses in flight on them finish).
 */
import * as Http from "node:http";
import * as Net from "node:net";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect";
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

  it("terminates a WebSocket client that never answers the close frame", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const serverContext = yield* Layer.buildWithScope(
        NodeHttpServer.layer(() => Http.createServer(), {
          host: "127.0.0.1",
          port: 0,
          gracefulShutdownTimeout: "200 millis",
        }),
        scope,
      );
      yield* Layer.buildWithScope(
        HttpRouter.serve(echoUntilClosed, { disableLogger: true, disableListenLog: true }),
        scope,
      ).pipe(Effect.provide(serverContext));
      const address = Context.get(serverContext, HttpServer.HttpServer).address;
      if (!("port" in address)) throw new Error("expected a TCP address");

      // A frozen peer (or a half-open connection): it completes the upgrade, then never reads
      // or answers again. Node drops upgraded sockets from `closeAllConnections`.
      const socket = Net.connect(address.port, "127.0.0.1");
      const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            socket.once("error", reject);
            socket.once("connect", () => {
              socket.write(
                [
                  "GET /ws HTTP/1.1",
                  `Host: 127.0.0.1:${address.port}`,
                  "Upgrade: websocket",
                  "Connection: Upgrade",
                  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
                  "Sec-WebSocket-Version: 13",
                  "",
                  "",
                ].join("\r\n"),
              );
            });
            socket.once("data", (chunk: Buffer) => {
              if (!chunk.toString("latin1").startsWith("HTTP/1.1 101")) {
                reject(new Error("upgrade refused"));
                return;
              }
              socket.pause();
              resolve();
            });
          }),
      );

      const startedAt = Date.now();
      yield* Scope.close(scope, Exit.void);
      const elapsedMs = Date.now() - startedAt;
      // Read again so the end of the stream is seen: the server dropped the connection.
      socket.resume();
      yield* Effect.promise(() => socketClosed);
      return elapsedMs;
    });

    // Without termination the final `wss.close()` waits out ws's 30 s close timeout.
    expect(await Effect.runPromise(program)).toBeLessThan(2_000);
  });

  it("closes a keep-alive connection as soon as a response in flight at shutdown finishes", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const release = yield* Deferred.make<void>();
      // Only the shutdown can close the connection: Node's keep-alive timeout
      // outlasts the graceful one.
      const nodeServer = Http.createServer({ keepAliveTimeout: 60_000 });
      const serverContext = yield* Layer.buildWithScope(
        NodeHttpServer.layer(() => nodeServer, {
          host: "127.0.0.1",
          port: 0,
          gracefulShutdownTimeout: "10 seconds",
        }),
        scope,
      );
      const finishesOnRelease = HttpRouter.add(
        "GET",
        "/in-flight",
        Effect.succeed(
          HttpServerResponse.stream(
            Stream.concat(
              Stream.make(new TextEncoder().encode("head;")),
              Stream.fromEffect(
                Deferred.await(release).pipe(Effect.as(new TextEncoder().encode("tail"))),
              ),
            ),
          ),
        ),
      );
      yield* Layer.buildWithScope(
        HttpRouter.serve(finishesOnRelease, { disableLogger: true, disableListenLog: true }),
        scope,
      ).pipe(Effect.provide(serverContext));
      const address = Context.get(serverContext, HttpServer.HttpServer).address;
      if (!("port" in address)) throw new Error("expected a TCP address");

      // A keep-alive client that never closes the connection itself.
      const socket = Net.connect(address.port, "127.0.0.1");
      let received = "";
      const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            socket.once("error", reject);
            socket.on("data", (chunk: Buffer) => {
              received += chunk.toString("latin1");
              if (received.includes("head;")) resolve();
            });
            socket.write(`GET /in-flight HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\n\r\n`);
          }),
      );

      const startedAt = Date.now();
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
      // The response must finish after `server.close()`, which closes only the
      // connections idle at the time it is called.
      while (nodeServer.listening) yield* Effect.sleep("1 millis");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(closing);
      const elapsedMs = Date.now() - startedAt;
      yield* Effect.promise(() => socketClosed);
      return { elapsedMs, received };
    });

    const result = await Effect.runPromise(program);
    // The in-flight response was finished, chunked terminator included, before
    // the connection closed.
    expect(result.received).toMatch(/^HTTP\/1\.1 200 /);
    expect(result.received).toContain("tail");
    expect(result.received.endsWith("0\r\n\r\n")).toBe(true);
    expect(result.elapsedMs).toBeLessThan(2_000);
  });

  it("leaves other connections' responses intact when one finishes during shutdown", async () => {
    // Far more than the loopback socket buffers hold, so most of it is still
    // queued in the server while the client is not reading.
    const bigLength = 32 * 1024 * 1024;
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const releaseBig = yield* Deferred.make<void>();
      const releaseQuick = yield* Deferred.make<void>();
      const releaseStream = yield* Deferred.make<void>();
      const nodeServer = Http.createServer({ keepAliveTimeout: 60_000 });
      const bigRequestArrived = new Promise<Http.ServerResponse>((resolve) =>
        nodeServer.on("request", (request: Http.IncomingMessage, response: Http.ServerResponse) => {
          if (request.url === "/big") resolve(response);
        }),
      );
      const serverContext = yield* Layer.buildWithScope(
        NodeHttpServer.layer(() => nodeServer, {
          host: "127.0.0.1",
          port: 0,
          gracefulShutdownTimeout: "10 seconds",
        }),
        scope,
      );
      const routes = Layer.mergeAll(
        HttpRouter.add(
          "GET",
          "/big",
          Deferred.await(releaseBig).pipe(
            Effect.as(HttpServerResponse.uint8Array(new Uint8Array(bigLength).fill(97))),
          ),
        ),
        HttpRouter.add(
          "GET",
          "/quick",
          Deferred.await(releaseQuick).pipe(Effect.as(HttpServerResponse.text("quick"))),
        ),
        HttpRouter.add(
          "GET",
          "/stream",
          Effect.succeed(
            HttpServerResponse.stream(
              Stream.concat(
                Stream.make(new TextEncoder().encode("head;")),
                Stream.fromEffect(
                  Deferred.await(releaseStream).pipe(Effect.as(new TextEncoder().encode("tail"))),
                ),
              ),
            ),
          ),
        ),
      );
      yield* Layer.buildWithScope(
        HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }),
        scope,
      ).pipe(Effect.provide(serverContext));
      const address = Context.get(serverContext, HttpServer.HttpServer).address;
      if (!("port" in address)) throw new Error("expected a TCP address");

      const connect = (path: string) => {
        const socket = Net.connect(address.port, "127.0.0.1");
        const chunks: Array<Buffer> = [];
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket.on("error", () => {});
        const closed = new Promise<Buffer>((resolve) =>
          socket.once("close", () => resolve(Buffer.concat(chunks))),
        );
        socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\n\r\n`);
        return { socket, chunks, closed };
      };
      // A slow client: it stops reading until the shutdown is under way.
      const big = connect("/big");
      big.socket.pause();
      const quick = connect("/quick");
      const streamed = connect("/stream");
      while (!Buffer.concat(streamed.chunks).includes("head;")) yield* Effect.sleep("1 millis");

      const startedAt = Date.now();
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
      while (nodeServer.listening) yield* Effect.sleep("1 millis");
      // The big response ends after `server.close()` and is still being flushed
      // to the paused client when the quick one finishes on its own connection.
      const bigResponse = yield* Effect.promise(() => bigRequestArrived);
      yield* Deferred.succeed(releaseBig, undefined);
      while (!bigResponse.writableEnded) yield* Effect.sleep("1 millis");
      const bigFlushingWhenQuickFinished = !bigResponse.writableFinished;
      yield* Deferred.succeed(releaseQuick, undefined);
      const quickReceived = (yield* Effect.promise(() => quick.closed)).toString("latin1");

      big.socket.resume();
      yield* Deferred.succeed(releaseStream, undefined);
      const [bigReceived, streamedReceived] = yield* Effect.promise(() =>
        Promise.all([big.closed, streamed.closed]),
      );
      yield* Fiber.join(closing);
      return {
        elapsedMs: Date.now() - startedAt,
        bigFlushingWhenQuickFinished,
        quickReceived,
        bigReceived,
        streamedReceived: streamedReceived.toString("latin1"),
      };
    });

    const result = await Effect.runPromise(program);
    expect(result.bigFlushingWhenQuickFinished).toBe(true);
    expect(result.quickReceived).toMatch(/^HTTP\/1\.1 200 /);
    expect(result.quickReceived.endsWith("quick")).toBe(true);
    const bigHeaderEnd = result.bigReceived.indexOf("\r\n\r\n") + 4;
    expect(result.bigReceived.subarray(0, bigHeaderEnd).toString("latin1")).toContain(
      `content-length: ${bigLength}`,
    );
    expect(result.bigReceived.length - bigHeaderEnd).toBe(bigLength);
    expect(result.streamedReceived).toContain("tail");
    expect(result.streamedReceived.endsWith("0\r\n\r\n")).toBe(true);
    // Every connection still closed as its response finished.
    expect(result.elapsedMs).toBeLessThan(5_000);
  });

  it("waits for the request body before closing a connection answered early during shutdown", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const nodeServer = Http.createServer({ keepAliveTimeout: 60_000 });
      const serverContext = yield* Layer.buildWithScope(
        NodeHttpServer.layer(() => nodeServer, {
          host: "127.0.0.1",
          port: 0,
          gracefulShutdownTimeout: "10 seconds",
        }),
        scope,
      );
      // Answers without reading the upload, as a rejected request does.
      const rejectsUpload = HttpRouter.add(
        "POST",
        "/upload",
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(HttpServerResponse.text("rejected", { status: 413 })),
        ),
      );
      yield* Layer.buildWithScope(
        HttpRouter.serve(rejectsUpload, { disableLogger: true, disableListenLog: true }),
        scope,
      ).pipe(Effect.provide(serverContext));
      const address = Context.get(serverContext, HttpServer.HttpServer).address;
      if (!("port" in address)) throw new Error("expected a TCP address");

      const socket = Net.connect(address.port, "127.0.0.1");
      let received = "";
      let endedByServer = false;
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("latin1");
      });
      socket.once("end", () => {
        endedByServer = true;
      });
      const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      socket.write(
        `POST /upload HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nContent-Length: 1000\r\n\r\n`,
      );
      socket.write("x".repeat(100));
      yield* Deferred.await(started);

      const startedAt = Date.now();
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
      while (nodeServer.listening) yield* Effect.sleep("1 millis");
      yield* Deferred.succeed(release, undefined);
      while (!received.endsWith("rejected")) yield* Effect.sleep("1 millis");
      // Closing now would reset the connection under the rest of the upload.
      yield* Effect.sleep("50 millis");
      const endedBeforeBody = endedByServer;
      socket.write("x".repeat(900));
      yield* Effect.promise(() => socketClosed);
      yield* Fiber.join(closing);
      return { elapsedMs: Date.now() - startedAt, endedBeforeBody, received };
    });

    const result = await Effect.runPromise(program);
    expect(result.received).toMatch(/^HTTP\/1\.1 413 /);
    expect(result.endedBeforeBody).toBe(false);
    expect(result.elapsedMs).toBeLessThan(2_000);
  });
});
