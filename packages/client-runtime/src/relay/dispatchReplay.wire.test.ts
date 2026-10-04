import {
  CommandId,
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@ryco/contracts";
import { Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { HostedRuntimeTimers } from "../authorization/runtime";
import type { ObservabilityService } from "../platform/index";
import { resetRequestLatencyStateForTests } from "../rpc/requestLatencyState";
import { resetWsConnectionStateForTests } from "../rpc/wsConnectionState";
import { createWsRpcClient, type WsRpcClient } from "../rpc/wsRpcClient";
import { WsTransport } from "../rpc/wsTransport";
import { bindHostedDispatchReplay, HostedDispatchReplay } from "./dispatchReplay";

/**
 * Runs the replay against the real RPC client, protocol layer, and Effect
 * socket — only the WebSocket itself is faked — so the failures it classifies
 * are the ones a dropped relay or a disposed client actually produce.
 */

type Listener = (event: { code?: number; reason?: string; data?: unknown }) => void;

class FakeSocket {
  readyState = 0;
  binaryType = "blob";
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    sockets.push(this);
  }

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

  requests(): Array<{ readonly id: string; readonly tag: string; readonly payload: unknown }> {
    return this.sent
      .map(
        (frame) => JSON.parse(frame) as { _tag: string; id: string; tag: string; payload: unknown },
      )
      .filter((message) => message._tag === "Request");
  }

  #emit(type: string, event: Parameters<Listener>[0]) {
    for (const listener of Array.from(this.#listeners.get(type) ?? [])) listener(event);
  }
}

const sockets: FakeSocket[] = [];

const observability: ObservabilityService = {
  tracingLayer: Layer.empty,
  performanceEnabled: () => false,
  recordPerformance: () => undefined,
};

const timers: HostedRuntimeTimers = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
  queueMicrotask: (callback) => globalThis.queueMicrotask(callback),
};

const environmentId = EnvironmentId.make("env_wire");
const command: ClientOrchestrationCommand = {
  type: "thread.meta.update",
  commandId: CommandId.make("cmd-wire"),
  threadId: ThreadId.make("thread-wire"),
  title: "Renamed",
};

let replay: HostedDispatchReplay;
const clients: WsRpcClient[] = [];

/** One hosted connection attempt: its own transport and socket, like a client rebuild. */
async function connect(
  options: { readonly replayed?: boolean } = {},
): Promise<{ readonly client: WsRpcClient; readonly socket: FakeSocket }> {
  const before = sockets.length;
  const transport = new WsTransport(
    "ws://relay.test/relay",
    { observability, socket: { webSocketConstructor: (url) => new FakeSocket(url) } },
    // A dropped attempt is replaced by a new client, never reconnected in place.
    { preserveSocketPath: true, shouldReconnect: () => false, recordConnectionState: false },
  );
  const raw = createWsRpcClient(transport);
  const client =
    options.replayed === false
      ? raw
      : bindHostedDispatchReplay({
          environmentId,
          lineage: "account-1",
          markUncertain: () => undefined,
          replay,
        }).wrap(raw);
  clients.push(client);
  return { client, socket: await socketAfter(before) };
}

async function socketAfter(count: number): Promise<FakeSocket> {
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(count));
  return sockets[count]!;
}

async function sentDispatch(socket: FakeSocket) {
  await vi.waitFor(() =>
    expect(
      socket.requests().some((request) => request.tag === ORCHESTRATION_WS_METHODS.dispatchCommand),
    ).toBe(true),
  );
  return socket
    .requests()
    .find((request) => request.tag === ORCHESTRATION_WS_METHODS.dispatchCommand)!;
}

async function settled(promise: Promise<unknown>) {
  let state: "pending" | "resolved" | "rejected" = "pending";
  promise.then(
    () => (state = "resolved"),
    () => (state = "rejected"),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  return state;
}

beforeEach(() => {
  sockets.length = 0;
  replay = new HostedDispatchReplay(() => timers);
  resetRequestLatencyStateForTests();
  resetWsConnectionStateForTests();
});

afterEach(async () => {
  await Promise.allSettled(clients.map((client) => client.dispose()));
  clients.length = 0;
  replay.resetForTests();
});

describe("hosted dispatch replay over the real RPC protocol", () => {
  it("a relay drop fails the raw request with a socket read error, not a close", async () => {
    const { client, socket } = await connect({ replayed: false });
    const result = client.orchestration.dispatchCommand(command);
    socket.open();
    await sentDispatch(socket);

    socket.drop();
    // Why matching "SocketCloseError" in the message never caught a real drop.
    await expect(result).rejects.toMatchObject({
      _tag: "RpcClientError",
      reason: { _tag: "SocketReadError" },
    });
  });

  it("holds a command through a relay drop and replays it on the recovered session", async () => {
    const first = await connect();
    const result = first.client.orchestration.dispatchCommand(command);
    first.socket.open();
    const original = await sentDispatch(first.socket);

    first.socket.drop();
    expect(await settled(result)).toBe("pending");

    const second = await connect();
    second.socket.open();
    // Not before the replacement session has accepted its snapshot.
    expect(await settled(result)).toBe("pending");
    expect(second.socket.requests()).toHaveLength(0);

    replay.markReady(environmentId);
    const replayed = await sentDispatch(second.socket);
    expect(replayed.payload).toEqual(original.payload);

    second.socket.reply({
      _tag: "Exit",
      requestId: replayed.id,
      exit: { _tag: "Success", value: { sequence: 9 } },
    });
    await expect(result).resolves.toEqual({ sequence: 9 });
  });

  it("holds a command whose client is disposed mid-request and replays it", async () => {
    const first = await connect();
    const result = first.client.orchestration.dispatchCommand(command);
    first.socket.open();
    const original = await sentDispatch(first.socket);

    // A browser suspend or a lifecycle retry disposes the client.
    await first.client.dispose();
    expect(await settled(result)).toBe("pending");

    const second = await connect();
    second.socket.open();
    replay.markReady(environmentId);

    const replayed = await sentDispatch(second.socket);
    expect(replayed.payload).toEqual(original.payload);
    second.socket.reply({
      _tag: "Exit",
      requestId: replayed.id,
      exit: { _tag: "Success", value: { sequence: 10 } },
    });
    await expect(result).resolves.toEqual({ sequence: 10 });
  });
});
