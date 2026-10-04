import { Layer } from "effect";

import type { ObservabilityService, SocketService } from "../src/platform/index.ts";

/**
 * Test-side WebSocket for running the real RPC client, protocol layer, and
 * Effect socket with only the socket itself faked, so suites exercise the
 * failures and refusals the runtime actually produces.
 */

type Listener = (event: { code?: number; reason?: string; data?: unknown }) => void;

export interface FakeRpcRequest {
  readonly id: string;
  readonly tag: string;
  readonly payload: unknown;
}

export class FakeWebSocket {
  readyState = 0;
  binaryType = "blob";
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: Listener) {
    const listeners = this.#listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener) {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#emit("close", { code, reason });
  }

  open() {
    this.readyState = 1;
    this.#emit("open", {});
  }

  /** The hosted relay facades' failure order: `error`, then `close`. */
  drop() {
    this.#emit("error", {});
    this.close(1006, "relay closed");
  }

  reply(data: unknown) {
    this.#emit("message", { data: JSON.stringify(data) });
  }

  requests(): ReadonlyArray<FakeRpcRequest> {
    return this.sent
      .map((frame) => JSON.parse(frame) as FakeRpcRequest & { readonly _tag: string })
      .filter((message) => message._tag === "Request");
  }

  #emit(type: string, event: Parameters<Listener>[0]) {
    for (const listener of Array.from(this.#listeners.get(type) ?? [])) listener(event);
  }
}

/** A transport platform whose sockets are recorded, in creation order, into `sockets`. */
export function fakeSocketPlatform(sockets: FakeWebSocket[]): {
  readonly observability: ObservabilityService;
  readonly socket: SocketService;
} {
  return {
    observability: {
      tracingLayer: Layer.empty,
      performanceEnabled: () => false,
      recordPerformance: () => undefined,
    },
    socket: {
      webSocketConstructor: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    },
  };
}
