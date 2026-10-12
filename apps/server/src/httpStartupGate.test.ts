import * as Http from "node:http";
import * as Net from "node:net";
import type { AddressInfo } from "node:net";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Context, Deferred, Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  installHttpStartupGate,
  isEarlyStaticPath,
  isEarlyStaticRequest,
  type HttpStartupGateOptions,
} from "./httpStartupGate.ts";

const servers: Array<Http.Server> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function listenGated(options?: HttpStartupGateOptions) {
  const server = Http.createServer();
  servers.push(server);
  const gate = installHttpStartupGate(server, options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, gate, port };
}

function get(port: number, path = "/") {
  return new Promise<{ status: number; body: string; headers: Http.IncomingHttpHeaders }>(
    (resolve, reject) => {
      const request = Http.get({ host: "127.0.0.1", port, path, agent: false }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body, headers: response.headers }),
        );
      });
      request.on("error", reject);
    },
  );
}

/** Sends a raw WebSocket-style upgrade and resolves with the first response bytes. */
function upgrade(port: number) {
  return new Promise<string>((resolve, reject) => {
    const socket = Net.connect(port, "127.0.0.1", () => {
      socket.write(
        "GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
    });
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.includes("\r\n\r\n")) {
        resolve(received);
        socket.destroy();
      }
    });
    socket.on("error", reject);
  });
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe("http startup gate", () => {
  it("holds requests that arrive before the handler and replays them once it attaches", async () => {
    const { server, gate, port } = await listenGated();
    const early = get(port, "/api/early");
    await tick();
    expect(gate.pendingCount()).toBe(1);

    server.on("request", (request, response) => {
      response.end(`handled ${request.url}`);
    });

    await expect(early).resolves.toMatchObject({ status: 200, body: "handled /api/early" });
    expect(gate.pendingCount()).toBe(0);
    // Later requests go straight to the real handler.
    await expect(get(port, "/later")).resolves.toMatchObject({ body: "handled /later" });
  });

  it("holds upgrades and replays them into the real upgrade handler", async () => {
    const { server, gate, port } = await listenGated();
    const early = upgrade(port);
    await tick();
    expect(gate.pendingCount()).toBe(1);

    server.on("request", (_request, response) => response.end());
    server.on("upgrade", (_request, socket: Net.Socket) => {
      socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n");
    });

    await expect(early).resolves.toContain("101 Switching Protocols");
    expect(gate.isOpen()).toBe(true);
  });

  it("answers 503 with Retry-After once the bound is full", async () => {
    const { port } = await listenGated({ maxPending: 1 });
    // Still held when the test ends; the teardown resets its connection.
    get(port, "/held").catch(() => undefined);
    await tick();
    const overflow = await get(port, "/overflow");
    expect(overflow.status).toBe(503);
    expect(overflow.headers["retry-after"]).toBe("1");
    expect(overflow.headers["cache-control"]).toBe("no-store");
  });

  it("answers 503 to requests held longer than the deadline", async () => {
    const { port, gate } = await listenGated({ maxWaitMs: 50 });
    const response = await get(port, "/slow-start");
    expect(response.status).toBe(503);
    expect(gate.pendingCount()).toBe(0);
  });

  it("answers held requests and upgrades with 503 when the server closes while gated", async () => {
    const { server, port } = await listenGated();
    const request = get(port, "/held");
    const upgraded = upgrade(port);
    await tick();
    server.close();
    await expect(request).resolves.toMatchObject({ status: 503 });
    await expect(upgraded).resolves.toContain("503 Service Unavailable");
  });

  it("lets the early handler answer static requests and holds everything else", async () => {
    const { server, gate, port } = await listenGated();
    gate.setEarlyRequestHandler((request, response) => {
      if (!isEarlyStaticRequest(request)) return false;
      response.end("shell");
      return true;
    });

    await expect(get(port, "/assets/main-abc12345.js")).resolves.toMatchObject({
      status: 200,
      body: "shell",
    });
    const api = get(port, "/api/auth/session");
    await tick();
    expect(gate.pendingCount()).toBe(1);

    server.on("request", (_request, response) => response.end("router"));
    await expect(api).resolves.toMatchObject({ body: "router" });
  });
});

describe("early static paths", () => {
  it("covers the document, hashed assets and root files", () => {
    expect(isEarlyStaticPath("/")).toBe(true);
    expect(isEarlyStaticPath("/index.html")).toBe(true);
    expect(isEarlyStaticPath("/assets/main-BKvXLkrW.css")).toBe(true);
    expect(isEarlyStaticPath("/favicon.svg")).toBe(true);
    expect(isEarlyStaticPath("/site.webmanifest")).toBe(true);
  });

  it("leaves routes, deep links and traversal attempts to the router", () => {
    expect(isEarlyStaticPath("/api/auth/session")).toBe(false);
    expect(isEarlyStaticPath("/.well-known/ryco/environment")).toBe(false);
    expect(isEarlyStaticPath("/ws")).toBe(false);
    expect(isEarlyStaticPath("/attachments/a.png")).toBe(false);
    expect(isEarlyStaticPath("/settings")).toBe(false);
    expect(isEarlyStaticPath("/pair")).toBe(false);
    expect(isEarlyStaticPath("/assets/../secrets")).toBe(false);
    expect(isEarlyStaticPath("/.env")).toBe(false);
  });
});

describe("startup gate with the Effect Node HTTP server", () => {
  it("answers a request sent before HttpRouter.serve attaches its handlers", async () => {
    const program = Effect.gen(function* () {
      const serverContext = yield* Layer.build(
        NodeHttpServer.layer(
          () => {
            const server = Http.createServer();
            installHttpStartupGate(server);
            return server;
          },
          { host: "127.0.0.1", port: 0 },
        ),
      );
      const address = Context.get(serverContext, HttpServer.HttpServer).address;
      if (!("port" in address)) throw new Error("expected a TCP address");

      // The route layer is deliberately slow, like the runtime graph the real
      // router waits for: the port is bound, but no handler is attached yet.
      const routesReady = yield* Deferred.make<void>();
      const slowRoutes = Layer.mergeAll(
        HttpRouter.add("GET", "/ping", HttpServerResponse.text("pong")),
        Layer.effectDiscard(Deferred.await(routesReady)),
      );
      yield* Layer.build(
        HttpRouter.serve(slowRoutes, { disableLogger: true, disableListenLog: true }),
      ).pipe(Effect.provide(serverContext), Effect.forkScoped);

      const early = get(address.port, "/ping");
      yield* Effect.sleep("50 millis");
      yield* Deferred.succeed(routesReady, undefined);
      return yield* Effect.promise(() => early);
    }).pipe(Effect.scoped);

    await expect(Effect.runPromise(program)).resolves.toMatchObject({
      status: 200,
      body: "pong",
    });
  });
});
