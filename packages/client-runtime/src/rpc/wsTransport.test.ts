import { AGENT_CONTROL_WS_METHODS } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { fakeSocketPlatform, type FakeWebSocket } from "../../test/fakeWebSocket";
import type { RpcRequestAdmission } from "./protocol";
import { resetRequestLatencyStateForTests } from "./requestLatencyState";
import { resetWsConnectionStateForTests } from "./wsConnectionState";
import { WsTransport } from "./wsTransport";

const sockets: FakeWebSocket[] = [];
const transports: WsTransport[] = [];

function connect(admit: () => RpcRequestAdmission): WsTransport {
  const transport = new WsTransport("ws://relay.test/relay", fakeSocketPlatform(sockets), {
    preserveSocketPath: true,
    shouldReconnect: () => false,
    recordConnectionState: false,
    authorizeRequest: () => admit(),
  });
  transports.push(transport);
  return transport;
}

function subscribeProposals(transport: WsTransport, onError: () => void): () => void {
  return transport.subscribe(
    (client) => client[AGENT_CONTROL_WS_METHODS.subscribeProposals]({}),
    () => undefined,
    { onError, retryDelay: 5, tag: AGENT_CONTROL_WS_METHODS.subscribeProposals },
  );
}

function proposalRequests(socket: FakeWebSocket) {
  return socket
    .requests()
    .filter((request) => request.tag === AGENT_CONTROL_WS_METHODS.subscribeProposals);
}

beforeEach(() => {
  sockets.length = 0;
  resetRequestLatencyStateForTests();
  resetWsConnectionStateForTests();
});

afterEach(async () => {
  await Promise.allSettled(transports.map((transport) => transport.dispose()));
  transports.length = 0;
  vi.restoreAllMocks();
});

describe("WsTransport subscriptions refused before sending", () => {
  it.each(["awaiting-session", "awaiting-acknowledgement"] as const)(
    "keep waiting while refused for now (%s) and start once admitted",
    async (refusal) => {
      let admission: RpcRequestAdmission = refusal;
      const admit = vi.fn(() => admission);
      const transport = connect(admit);
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]!.open();
      const onError = vi.fn();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const stop = subscribeProposals(transport, onError);
      // Refused locally, then retried without ending the subscription.
      await vi.waitFor(() => expect(admit.mock.calls.length).toBeGreaterThanOrEqual(3));
      expect(proposalRequests(sockets[0]!)).toHaveLength(0);
      expect(onError).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();

      admission = "allowed";
      await vi.waitFor(() => expect(proposalRequests(sockets[0]!)).toHaveLength(1));
      expect(onError).not.toHaveBeenCalled();
      stop();
    },
  );

  it("end at once when the request is refused for good", async () => {
    const admit = vi.fn((): RpcRequestAdmission => "forbidden");
    const transport = connect(admit);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onError = vi.fn();

    const stop = subscribeProposals(transport, onError);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(admit).toHaveBeenCalledOnce();
    expect(proposalRequests(sockets[0]!)).toHaveLength(0);
    stop();
  });
});
