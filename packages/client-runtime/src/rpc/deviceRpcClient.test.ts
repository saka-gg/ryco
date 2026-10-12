import { DEVICE_WS_METHODS } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { fakeSocketPlatform, type FakeWebSocket } from "../../test/fakeWebSocket.ts";
import { createDeviceRpcClient, createDirectDeviceRpcTransport } from "./deviceRpcClient.ts";
import { resetRequestLatencyStateForTests } from "./requestLatencyState.ts";
import { resetWsConnectionStateForTests } from "./wsConnectionState.ts";
import { DeviceWsTransport, WsTransport } from "./wsTransport.ts";

const sockets: FakeWebSocket[] = [];
const disposables: Array<{ dispose: () => Promise<void> }> = [];

const handlers = { shouldReconnect: () => false, recordConnectionState: false } as const;

function setup(options?: { readonly idleCloseMs?: number }) {
  const platform = fakeSocketPlatform(sockets);
  const main = new WsTransport("ws://node.test/ws", platform, handlers);
  disposables.push(main);
  const openDedicated = vi.fn(
    () => new DeviceWsTransport("ws://node.test/ws/device", platform, handlers),
  );
  const transport = createDirectDeviceRpcTransport({
    main,
    openDedicated,
    ...(options?.idleCloseMs === undefined ? {} : { idleCloseMs: options.idleCloseMs }),
  });
  disposables.push(transport);
  return { client: createDeviceRpcClient(transport), openDedicated };
}

const socketAt = (path: string) => sockets.find((socket) => new URL(socket.url).pathname === path);

const deviceRequests = (socket: FakeWebSocket, tag: string) =>
  socket.requests().filter((request) => request.tag === tag);

const LIST_RESULT = {
  type: "list",
  result: { devices: [], availability: { kind: "available" } },
};

function replySuccess(socket: FakeWebSocket, requestId: string, value: unknown) {
  socket.reply({
    _tag: "Exit",
    requestId,
    exit: { _tag: "Success", value },
  });
}

/** What a server without the device group on `/ws` answers. */
function replyUnknownTag(socket: FakeWebSocket, requestId: string, tag: string) {
  socket.reply({
    _tag: "Exit",
    requestId,
    exit: {
      _tag: "Failure",
      cause: [{ _tag: "Die", defect: `Unknown request tag: ${tag}` }],
    },
  });
}

beforeEach(() => {
  sockets.length = 0;
  resetRequestLatencyStateForTests();
  resetWsConnectionStateForTests();
});

afterEach(async () => {
  await Promise.allSettled(disposables.map((entry) => entry.dispose()));
  disposables.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createDirectDeviceRpcTransport", () => {
  it("sends device control on the main socket without opening a device socket", async () => {
    const { client, openDedicated } = setup();
    await vi.waitFor(() => expect(socketAt("/ws")).toBeDefined());
    const main = socketAt("/ws")!;
    main.open();

    const listing = client.list({ includeShutdown: true });
    await vi.waitFor(() => expect(deviceRequests(main, DEVICE_WS_METHODS.read)).toHaveLength(1));
    replySuccess(main, deviceRequests(main, DEVICE_WS_METHODS.read)[0]!.id, LIST_RESULT);

    await expect(listing).resolves.toEqual(LIST_RESULT.result);
    expect(openDedicated).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
  });

  it("falls back to /ws/device for every device RPC once an older server rejects the tag", async () => {
    const { client, openDedicated } = setup();
    await vi.waitFor(() => expect(socketAt("/ws")).toBeDefined());
    const main = socketAt("/ws")!;
    main.open();

    const listing = client.list({});
    await vi.waitFor(() => expect(deviceRequests(main, DEVICE_WS_METHODS.read)).toHaveLength(1));
    replyUnknownTag(
      main,
      deviceRequests(main, DEVICE_WS_METHODS.read)[0]!.id,
      DEVICE_WS_METHODS.read,
    );

    // The request is resent on the dedicated socket: the server never ran it.
    await vi.waitFor(() => expect(socketAt("/ws/device")).toBeDefined());
    const dedicated = socketAt("/ws/device")!;
    dedicated.open();
    await vi.waitFor(() =>
      expect(deviceRequests(dedicated, DEVICE_WS_METHODS.read)).toHaveLength(1),
    );
    replySuccess(dedicated, deviceRequests(dedicated, DEVICE_WS_METHODS.read)[0]!.id, LIST_RESULT);
    await expect(listing).resolves.toEqual(LIST_RESULT.result);

    // Later requests go straight to the dedicated socket.
    const second = client.list({});
    await vi.waitFor(() =>
      expect(deviceRequests(dedicated, DEVICE_WS_METHODS.read)).toHaveLength(2),
    );
    replySuccess(dedicated, deviceRequests(dedicated, DEVICE_WS_METHODS.read)[1]!.id, LIST_RESULT);
    await second;
    expect(deviceRequests(main, DEVICE_WS_METHODS.read)).toHaveLength(1);
    expect(openDedicated).toHaveBeenCalledOnce();
  });

  it("moves the event stream to /ws/device when the main socket does not serve it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { client } = setup();
    await vi.waitFor(() => expect(socketAt("/ws")).toBeDefined());
    const main = socketAt("/ws")!;
    main.open();
    const onError = vi.fn();
    const events: unknown[] = [];
    const stop = client.onEvent((event) => events.push(event), { onError });

    const tag = DEVICE_WS_METHODS.subscribeEvents;
    await vi.waitFor(() => expect(deviceRequests(main, tag)).toHaveLength(1));
    replyUnknownTag(main, deviceRequests(main, tag)[0]!.id, tag);

    await vi.waitFor(() => expect(socketAt("/ws/device")).toBeDefined());
    const dedicated = socketAt("/ws/device")!;
    dedicated.open();
    await vi.waitFor(() => expect(deviceRequests(dedicated, tag)).toHaveLength(1));
    const event = {
      type: "device.open-pane-requested",
      threadId: "thread-1",
      udid: "SIM-1",
      reason: "agent-launch",
    };
    dedicated.reply({
      _tag: "Chunk",
      requestId: deviceRequests(dedicated, tag)[0]!.id,
      values: [event],
    });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(onError).not.toHaveBeenCalled();
    stop();
  });

  it("keeps screenshots on a dedicated socket that closes once idle", async () => {
    const { client, openDedicated } = setup({ idleCloseMs: 20 });
    await vi.waitFor(() => expect(socketAt("/ws")).toBeDefined());
    socketAt("/ws")!.open();

    const shot = client.screenshot({ udid: "SIM-1" as never });
    await vi.waitFor(() => expect(socketAt("/ws/device")).toBeDefined());
    const dedicated = socketAt("/ws/device")!;
    dedicated.open();
    await vi.waitFor(() =>
      expect(deviceRequests(dedicated, DEVICE_WS_METHODS.read)).toHaveLength(1),
    );
    const result = { type: "screenshot", result: { mimeType: "image/png", base64: "AA==" } };
    replySuccess(dedicated, deviceRequests(dedicated, DEVICE_WS_METHODS.read)[0]!.id, result);
    await shot.catch(() => undefined);
    expect(deviceRequests(socketAt("/ws")!, DEVICE_WS_METHODS.read)).toHaveLength(0);

    await vi.waitFor(() => expect(dedicated.readyState).toBe(3));
    expect(openDedicated).toHaveBeenCalledOnce();
  });
});
