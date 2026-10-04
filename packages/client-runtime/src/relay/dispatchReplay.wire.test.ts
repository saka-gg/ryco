import {
  CommandId,
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { HostedRuntimeTimers } from "../authorization/runtime";
import { resetRequestLatencyStateForTests } from "../rpc/requestLatencyState";
import { resetWsConnectionStateForTests } from "../rpc/wsConnectionState";
import { createWsRpcClient, type WsRpcClient } from "../rpc/wsRpcClient";
import { WsTransport } from "../rpc/wsTransport";
import { fakeSocketPlatform, type FakeWebSocket } from "../../test/fakeWebSocket";
import { bindHostedDispatchReplay, HostedDispatchReplay } from "./dispatchReplay";

/**
 * Runs the replay against the real RPC client, protocol layer, and Effect
 * socket — only the WebSocket itself is faked — so the failures it classifies
 * are the ones a dropped relay or a disposed client actually produce.
 */

const sockets: FakeWebSocket[] = [];
const platform = fakeSocketPlatform(sockets);

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
let markUncertain: ReturnType<typeof vi.fn<() => void>>;
const clients: WsRpcClient[] = [];

/** One hosted connection attempt: its own transport and socket, like a client rebuild. */
async function connect(
  options: { readonly replayed?: boolean } = {},
): Promise<{ readonly client: WsRpcClient; readonly socket: FakeWebSocket }> {
  const before = sockets.length;
  const transport = new WsTransport(
    "ws://relay.test/relay",
    platform,
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
          markUncertain,
          replay,
        }).wrap(raw);
  clients.push(client);
  return { client, socket: await socketAfter(before) };
}

async function socketAfter(count: number): Promise<FakeWebSocket> {
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(count));
  return sockets[count]!;
}

async function sentDispatch(socket: FakeWebSocket) {
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
  markUncertain = vi.fn<() => void>();
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

  it("reports the node's own defect at once, without holding or marking anything", async () => {
    const { client, socket } = await connect();
    const result = client.orchestration.dispatchCommand(command);
    socket.open();
    const sent = await sentDispatch(socket);

    // What the node answers for a payload it cannot decode, such as a command
    // type from a newer hosted bundle. The connection stays up.
    socket.reply({
      _tag: "Exit",
      requestId: sent.id,
      exit: {
        _tag: "Failure",
        cause: [{ _tag: "Die", defect: "Expected a known command type" }],
      },
    });
    expect(await settled(result)).toBe("rejected");
    await expect(result).rejects.toBe("Expected a known command type");
    expect(markUncertain).not.toHaveBeenCalled();

    // No later readiness replays it either.
    replay.markReady(environmentId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socket.requests()).toHaveLength(1);
  });

  it("holds a command the node interrupted and replays it once the session is ready", async () => {
    const { client, socket } = await connect();
    const result = client.orchestration.dispatchCommand(command);
    socket.open();
    const sent = await sentDispatch(socket);

    // A node on its way down interrupts what it was handling.
    socket.reply({
      _tag: "Exit",
      requestId: sent.id,
      exit: { _tag: "Failure", cause: [{ _tag: "Interrupt", fiberId: 1 }] },
    });
    expect(await settled(result)).toBe("pending");

    replay.markReady(environmentId);
    await vi.waitFor(() => expect(socket.requests()).toHaveLength(2));
    const replayed = socket.requests()[1]!;
    expect(replayed.payload).toEqual(sent.payload);
    socket.reply({
      _tag: "Exit",
      requestId: replayed.id,
      exit: { _tag: "Success", value: { sequence: 11 } },
    });
    await expect(result).resolves.toEqual({ sequence: 11 });
  });
});
