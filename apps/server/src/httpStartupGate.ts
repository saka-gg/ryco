/**
 * httpStartupGate - Holds requests that reach the HTTP port before the router
 * is attached.
 *
 * The Node platform binds the port when the `HttpServer` layer is built, but
 * only attaches its `request`/`upgrade` handlers once the whole runtime graph
 * (migrations, orchestration hydration, provider registry, ...) is built and
 * `HttpRouter.serve` runs. Node drops events that have no listener, so a
 * request or WebSocket upgrade that arrives in that window is never answered
 * and never closed. The gate is installed on the `http.Server` before it
 * listens: it parks early requests and upgrades in a bounded set and replays
 * them into the real handlers the moment they are attached. Entries that
 * overflow the bound or wait too long, and everything still held when the
 * server closes while gated, get a `503` with `Retry-After` instead.
 *
 * While gated, an optional early handler may answer requests that need no
 * runtime services (the static web shell), so clients can start loading the
 * UI while the runtime builds.
 *
 * @module httpStartupGate
 */
import type * as Http from "node:http";
import type { Duplex } from "node:stream";

export const HTTP_STARTUP_GATE_MAX_PENDING = 256;
export const HTTP_STARTUP_GATE_MAX_WAIT_MS = 10_000;

/**
 * Answers a request while the gate is closed. Returns `true` when it took
 * ownership of the response; `false` leaves the request to be held for the
 * router.
 */
export type HttpStartupGateEarlyHandler = (
  request: Http.IncomingMessage,
  response: Http.ServerResponse,
) => boolean;

export interface HttpStartupGateOptions {
  readonly maxPending?: number;
  readonly maxWaitMs?: number;
}

export interface HttpStartupGate {
  /** True once both the real `request` and `upgrade` handlers are attached. */
  readonly isOpen: () => boolean;
  /** Requests and upgrades currently held for the router. */
  readonly pendingCount: () => number;
  readonly setEarlyRequestHandler: (handler: HttpStartupGateEarlyHandler | null) => void;
}

interface HeldRequest {
  readonly request: Http.IncomingMessage;
  readonly response: Http.ServerResponse;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface HeldUpgrade {
  readonly request: Http.IncomingMessage;
  readonly socket: Duplex;
  readonly head: Buffer;
  readonly timer: ReturnType<typeof setTimeout>;
}

type RequestListener = (request: Http.IncomingMessage, response: Http.ServerResponse) => void;
type UpgradeListener = (request: Http.IncomingMessage, socket: Duplex, head: Buffer) => void;

const STARTING_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store",
  "Retry-After": "1",
  Connection: "close",
} as const;

const STARTING_UPGRADE_RESPONSE =
  "HTTP/1.1 503 Service Unavailable\r\n" +
  "Retry-After: 1\r\n" +
  "Cache-Control: no-store\r\n" +
  "Connection: close\r\n" +
  "Content-Length: 0\r\n\r\n";

export function respondServerStarting(response: Http.ServerResponse): void {
  if (response.headersSent || response.writableEnded || response.destroyed) return;
  try {
    response.writeHead(503, STARTING_HEADERS);
    response.end("Ryco is starting. Retry shortly.\n");
  } catch {
    response.destroy();
  }
}

function rejectUpgradeServerStarting(socket: Duplex): void {
  if (socket.destroyed) return;
  try {
    socket.end(STARTING_UPGRADE_RESPONSE);
  } catch {
    socket.destroy();
  }
}

/**
 * Installs the gate on a server that has no `request`/`upgrade` handler yet.
 * Must run before `listen()`. Listeners registered after installation are
 * treated as the real handlers; listeners registered before it (for example a
 * header policy prepended to `upgrade`) are ignored.
 */
export function installHttpStartupGate(
  server: Http.Server,
  options: HttpStartupGateOptions = {},
): HttpStartupGate {
  const maxPending = options.maxPending ?? HTTP_STARTUP_GATE_MAX_PENDING;
  const maxWaitMs = options.maxWaitMs ?? HTTP_STARTUP_GATE_MAX_WAIT_MS;
  const heldRequests = new Set<HeldRequest>();
  const heldUpgrades = new Set<HeldUpgrade>();
  let requestHandlerAttached = false;
  let upgradeHandlerAttached = false;
  let closing = false;
  let earlyHandler: HttpStartupGateEarlyHandler | null = null;

  const pendingCount = () => heldRequests.size + heldUpgrades.size;
  const canHold = () => !closing && pendingCount() < maxPending;

  const gateRequest: RequestListener = (request, response) => {
    if (requestHandlerAttached) return;
    if (earlyHandler !== null && !closing) {
      try {
        if (earlyHandler(request, response)) return;
      } catch {
        // A failing early path must never lose the request: hold it instead.
      }
    }
    if (!canHold()) {
      respondServerStarting(response);
      return;
    }
    const timer = setTimeout(() => {
      heldRequests.delete(entry);
      respondServerStarting(response);
    }, maxWaitMs);
    timer.unref?.();
    const entry: HeldRequest = { request, response, timer };
    heldRequests.add(entry);
    response.once("close", () => {
      clearTimeout(timer);
      heldRequests.delete(entry);
    });
  };

  const gateUpgrade: UpgradeListener = (request, socket, head) => {
    if (upgradeHandlerAttached) return;
    if (!canHold()) {
      rejectUpgradeServerStarting(socket);
      return;
    }
    const timer = setTimeout(() => {
      heldUpgrades.delete(entry);
      rejectUpgradeServerStarting(socket);
    }, maxWaitMs);
    timer.unref?.();
    const entry: HeldUpgrade = { request, socket, head, timer };
    heldUpgrades.add(entry);
    // Upgrade sockets surface errors only to listeners; never let a reset
    // from a held client become an uncaught exception.
    socket.on("error", () => {});
    socket.once("close", () => {
      clearTimeout(timer);
      heldUpgrades.delete(entry);
    });
  };

  const releaseRequests = (listener: RequestListener) => {
    server.off("request", gateRequest);
    const entries = [...heldRequests];
    heldRequests.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      if (entry.response.destroyed || entry.response.writableEnded) continue;
      listener.call(server, entry.request, entry.response);
    }
  };

  const releaseUpgrades = (listener: UpgradeListener) => {
    server.off("upgrade", gateUpgrade);
    const entries = [...heldUpgrades];
    heldUpgrades.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      if (entry.socket.destroyed) continue;
      listener.call(server, entry.request, entry.socket, entry.head);
    }
  };

  const restoreClose = () => {
    if (requestHandlerAttached && upgradeHandlerAttached) {
      server.off("newListener", onNewListener);
      server.close = originalClose;
    }
  };

  // `newListener` fires before the listener is added; replay on the next tick
  // so the platform finishes attaching both handlers first.
  function onNewListener(event: string | symbol, listener: unknown) {
    if (event === "request" && listener !== gateRequest && !requestHandlerAttached) {
      requestHandlerAttached = true;
      process.nextTick(() => {
        releaseRequests(listener as RequestListener);
        restoreClose();
      });
    } else if (event === "upgrade" && listener !== gateUpgrade && !upgradeHandlerAttached) {
      upgradeHandlerAttached = true;
      process.nextTick(() => {
        releaseUpgrades(listener as UpgradeListener);
        restoreClose();
      });
    }
  }

  // A server that closes while still gated (startup failed) answers what it
  // holds right away; `close()` would otherwise wait for every held socket.
  const originalClose = server.close;
  server.close = function closeGatedServer(
    this: Http.Server,
    ...args: Parameters<Http.Server["close"]>
  ) {
    closing = true;
    earlyHandler = null;
    if (!requestHandlerAttached) {
      for (const entry of heldRequests) {
        clearTimeout(entry.timer);
        respondServerStarting(entry.response);
      }
      heldRequests.clear();
    }
    if (!upgradeHandlerAttached) {
      for (const entry of heldUpgrades) {
        clearTimeout(entry.timer);
        rejectUpgradeServerStarting(entry.socket);
      }
      heldUpgrades.clear();
    }
    return originalClose.apply(this, args);
  } as typeof server.close;

  server.on("request", gateRequest);
  server.on("upgrade", gateUpgrade);
  server.on("newListener", onNewListener);

  return {
    isOpen: () => requestHandlerAttached && upgradeHandlerAttached,
    pendingCount,
    setEarlyRequestHandler: (handler) => {
      earlyHandler = handler;
    },
  };
}

/**
 * The paths the gate may serve from the static shell before the router is
 * attached: the document root, `index.html`, hashed build assets, and
 * root-level files with an extension (icons, manifests). Everything else -
 * APIs, `/.well-known/*`, WebSocket endpoints, SPA deep links - waits for the
 * router, so no route can be shadowed by the static fallback.
 */
export function isEarlyStaticPath(pathname: string): boolean {
  if (pathname === "/" || pathname === "/index.html") return true;
  if (pathname.startsWith("/assets/")) {
    return !pathname.includes("..") && !pathname.includes("\\");
  }
  return /^\/[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9]+$/u.test(pathname);
}

export function isEarlyStaticRequest(request: Http.IncomingMessage): boolean {
  if (request.method !== "GET" || request.headers.upgrade !== undefined) return false;
  const rawUrl = request.url ?? "/";
  const queryIndex = rawUrl.search(/[?#]/u);
  const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  return isEarlyStaticPath(pathname);
}

/**
 * The early static requests any server mode may answer: hashed build assets and root-level
 * files, but not the document (`/`, `/index.html`). Readiness probes such as the SSH
 * launcher's `wait_ready` poll the document and must not see a server ready before its router
 * serves; assets only matter to a client that already loaded a document.
 */
export function isEarlyStaticAssetRequest(request: Http.IncomingMessage): boolean {
  if (!isEarlyStaticRequest(request)) return false;
  const rawUrl = request.url ?? "/";
  const queryIndex = rawUrl.search(/[?#]/u);
  const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  return pathname !== "/" && pathname !== "/index.html";
}
