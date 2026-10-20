import { AGENT_CONTROL_WS_METHODS, WS_METHODS } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { fakeSocketPlatform, type FakeWebSocket } from "../../test/fakeWebSocket.ts";
import { type RpcRequestAdmission, type WsProtocolLifecycleHandlers } from "./protocol.ts";
import { resetRequestLatencyStateForTests } from "./requestLatencyState.ts";
import { resetWsConnectionStateForTests } from "./wsConnectionState.ts";
import {
  isResponseTooLargeError,
  isUnsupportedRpcError,
  RESYNC_SUBSCRIPTION_MAX_DELAY_MS,
  resyncSubscriptionRetryDelayMs,
  RpcRequestAbortedError,
  WsTransport,
} from "./wsTransport.ts";

const sockets: FakeWebSocket[] = [];
const transports: WsTransport[] = [];

function connect(
  admit: () => RpcRequestAdmission,
  subscribeAdmissionChanges?: WsProtocolLifecycleHandlers["subscribeAdmissionChanges"],
): WsTransport {
  const transport = new WsTransport("ws://relay.test/relay", fakeSocketPlatform(sockets), {
    preserveSocketPath: true,
    shouldReconnect: () => false,
    recordConnectionState: false,
    authorizeRequest: () => admit(),
    ...(subscribeAdmissionChanges ? { subscribeAdmissionChanges } : {}),
  });
  transports.push(transport);
  return transport;
}

function subscribeProposals(
  transport: WsTransport,
  onError: () => void,
  retryDelay = 5,
): () => void {
  return transport.subscribe(
    (client) => client[AGENT_CONTROL_WS_METHODS.subscribeProposals]({}),
    () => undefined,
    { onError, retryDelay, tag: AGENT_CONTROL_WS_METHODS.subscribeProposals },
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

  it("wakes immediately when admission changes without bypassing the request gate", async () => {
    let admission: RpcRequestAdmission = "awaiting-session";
    const listeners = new Set<() => void>();
    const admit = vi.fn(() => admission);
    const transport = connect(admit, (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    const stop = subscribeProposals(transport, vi.fn(), 4_000);
    await vi.waitFor(() => expect(admit).toHaveBeenCalledOnce());

    for (const listener of listeners) listener();
    await vi.waitFor(() => expect(admit).toHaveBeenCalledTimes(2));
    expect(proposalRequests(sockets[0]!)).toHaveLength(0);

    admission = "allowed";
    for (const listener of listeners) listener();
    await vi.waitFor(() => expect(proposalRequests(sockets[0]!)).toHaveLength(1));
    stop();
    await vi.waitFor(() => expect(listeners.size).toBe(0));
  });

  it("does not lose an admission change before the refusal is observed", async () => {
    const listeners = new Set<() => void>();
    let admission: RpcRequestAdmission = "awaiting-session";
    const transport = connect(
      () => {
        const current = admission;
        if (current === "awaiting-session") {
          admission = "allowed";
          for (const listener of listeners) listener();
        }
        return current;
      },
      (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    );
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    const stop = subscribeProposals(transport, vi.fn(), 4_000);
    await vi.waitFor(() => expect(proposalRequests(sockets[0]!)).toHaveLength(1));
    stop();
  });

  it.each(["unsubscribe", "dispose"] as const)(
    "releases an admission wait on %s",
    async (action) => {
      const listeners = new Set<() => void>();
      const admit = vi.fn((): RpcRequestAdmission => "awaiting-session");
      const transport = connect(admit, (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]!.open();
      const stop = subscribeProposals(transport, vi.fn(), 4_000);
      await vi.waitFor(() => expect(admit).toHaveBeenCalledOnce());
      if (action === "unsubscribe") stop();
      else await transport.dispose();
      await vi.waitFor(() => expect(listeners.size).toBe(0));
      expect(proposalRequests(sockets[0]!)).toHaveLength(0);
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
    // The hook learns that the subscription ended, never the failure itself.
    expect(onError).toHaveBeenCalledWith();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(admit).toHaveBeenCalledOnce();
    expect(proposalRequests(sockets[0]!)).toHaveLength(0);
    stop();
  });
});

describe("WsTransport resync failures", () => {
  it("grows the retry delay for back-to-back resyncs up to a cap", () => {
    expect(
      [0, 1, 2, 3, 4, 5, 6, 40].map((count) => resyncSubscriptionRetryDelayMs(250, count)),
    ).toEqual([250, 500, 1_000, 2_000, 4_000, 8_000, 8_000, RESYNC_SUBSCRIPTION_MAX_DELAY_MS]);
  });

  it("resubscribes after a server resync request with backoff and one warning", async () => {
    const transport = connect(() => "allowed");
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0]!;
    socket.open();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stop = transport.subscribe(
      (client) => client[WS_METHODS.subscribeTerminalEvents]({ replay: "metadata" }),
      () => undefined,
      { retryDelay: 25, tag: WS_METHODS.subscribeTerminalEvents },
    );
    const requests = () =>
      socket.requests().filter((request) => request.tag === WS_METHODS.subscribeTerminalEvents);
    const arrivals: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await vi.waitFor(() => expect(requests()).toHaveLength(attempt), { timeout: 2_000 });
      arrivals.push(Date.now());
      expect(requests().at(-1)?.payload).toEqual({ replay: "metadata" });
      socket.reply({
        _tag: "Exit",
        requestId: requests().at(-1)!.id,
        exit: {
          _tag: "Failure",
          cause: [
            {
              _tag: "Fail",
              error: {
                _tag: "TerminalSubscriptionResyncError",
                reason: "slowConsumer",
                capacity: 256,
              },
            },
          ],
        },
      });
    }
    await vi.waitFor(() => expect(requests()).toHaveLength(5), { timeout: 2_000 });
    arrivals.push(Date.now());
    // Delays of 25, 50, 100 and 200 ms: each retry waits about twice as long as the last.
    expect(arrivals[4]! - arrivals[3]!).toBeGreaterThanOrEqual(180);
    expect(arrivals[4]! - arrivals[3]!).toBeGreaterThan(arrivals[1]! - arrivals[0]!);
    expect(
      warn.mock.calls.filter(
        ([message]) => message === "WebSocket RPC subscription resynchronizing",
      ),
    ).toHaveLength(1);
    stop();
  });
});

describe("WsTransport stream chunks", () => {
  it("delivers every value of one server chunk in a single pass", async () => {
    const transport = connect(() => "allowed");
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    const delivered: string[] = [];
    const stop = transport.subscribe(
      (client) => client[WS_METHODS.subscribeTerminalEvents]({}),
      (event) => {
        if (event.type !== "output") return;
        if (delivered.length === 0) {
          // Batching consumers (one store commit per chunk) run after the pass.
          void Promise.resolve().then(() => delivered.push("after-chunk"));
        }
        delivered.push(event.data);
      },
      { tag: WS_METHODS.subscribeTerminalEvents },
    );
    await vi.waitFor(() =>
      expect(
        sockets[0]!
          .requests()
          .filter((request) => request.tag === WS_METHODS.subscribeTerminalEvents),
      ).toHaveLength(1),
    );
    const request = sockets[0]!
      .requests()
      .find((candidate) => candidate.tag === WS_METHODS.subscribeTerminalEvents)!;
    const output = (data: string) => ({
      threadId: "thread-1",
      terminalId: "default",
      createdAt: "2026-10-01T00:00:00.000Z",
      type: "output",
      data,
    });
    sockets[0]!.reply({
      _tag: "Chunk",
      requestId: request.id,
      values: [output("a"), output("b"), output("c")],
    });

    await vi.waitFor(() => expect(delivered).toEqual(["a", "b", "c", "after-chunk"]));
    stop();
  });

  it("classifies the failures a subscription can fall back from", () => {
    expect(isUnsupportedRpcError("Unknown request tag: orchestration.subscribeThreadWindow")).toBe(
      true,
    );
    expect(
      isResponseTooLargeError(
        new Error("The response exceeded the largest message this connection can carry."),
      ),
    ).toBe(true);
    expect(isUnsupportedRpcError(new Error("Failed to load bounded history"))).toBe(false);
  });
});

describe("WsTransport unary requests", () => {
  it("withdraws a request whose signal aborts and tells the server", async () => {
    const transport = connect(() => "allowed");
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    const controller = new AbortController();
    const pending = transport.request(
      (client) =>
        client[WS_METHODS.serverGetUsageSummary]({
          contractVersion: 2,
          endDate: "2026-08-10",
          timeZone: "UTC",
        }),
      { signal: controller.signal },
    );
    await vi.waitFor(() =>
      expect(
        sockets[0]!
          .requests()
          .filter((request) => request.tag === WS_METHODS.serverGetUsageSummary),
      ).toHaveLength(1),
    );
    const request = sockets[0]!
      .requests()
      .find((candidate) => candidate.tag === WS_METHODS.serverGetUsageSummary)!;
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    await vi.waitFor(() =>
      expect(
        sockets[0]!.sent
          .map(
            (frame) => JSON.parse(frame) as { readonly _tag: string; readonly requestId?: string },
          )
          .some((message) => message._tag === "Interrupt" && message.requestId === request.id),
      ).toBe(true),
    );
  });
});

describe("WsTransport socket URL providers", () => {
  it("abandons a URL request that never answers and starts a fresh attempt", async () => {
    const signals: AbortSignal[] = [];
    const transport = new WsTransport(
      (signal) => {
        if (signal) signals.push(signal);
        if (signals.length === 1) {
          // The token request reached a server that never answers it.
          return new Promise<string>(() => undefined);
        }
        return Promise.resolve("ws://node.test/ws");
      },
      fakeSocketPlatform(sockets),
      {
        recordConnectionState: false,
        urlProviderTimeoutMs: 20,
        getReconnectDelayMs: () => 0,
      },
    );
    transports.push(transport);

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  });
});

describe("WsTransport request abort", () => {
  const sentFrames = (socket: FakeWebSocket) =>
    socket.sent.map(
      (frame) => JSON.parse(frame) as { readonly _tag: string; readonly requestId?: unknown },
    );

  it("never sends a request whose signal is already aborted", async () => {
    const transport = connect(() => "allowed");
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    const controller = new AbortController();
    controller.abort();

    await expect(
      transport.request((client) => client[WS_METHODS.serverGetConfig]({}), {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(RpcRequestAbortedError);
    expect(sockets[0]!.requests()).toHaveLength(0);
  });

  it("interrupts a running request on the server when its signal aborts", async () => {
    const transport = connect(() => "allowed");
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    const controller = new AbortController();

    const pending = transport.request((client) => client[WS_METHODS.serverGetConfig]({}), {
      signal: controller.signal,
    });
    const outcome = expect(pending).rejects.toBeInstanceOf(RpcRequestAbortedError);
    await vi.waitFor(() => expect(sockets[0]!.requests()).toHaveLength(1));
    const requestId = sockets[0]!.requests()[0]!.id;

    controller.abort();

    await outcome;
    // The client tells the server to stop working on it.
    await vi.waitFor(() =>
      expect(
        sentFrames(sockets[0]!).some(
          (frame) => frame._tag === "Interrupt" && String(frame.requestId) === String(requestId),
        ),
      ).toBe(true),
    );
  });
});

describe("WsTransport reconnect wakes", () => {
  /** A test-controlled wake source that records the listeners it holds. */
  function wakeSource() {
    const listeners = new Set<(delayMs: number) => void>();
    const source = {
      listeners,
      subscriptions: 0,
      subscribe(listener: (delayMs: number) => void) {
        source.subscriptions += 1;
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      wake(delayMs: number) {
        for (const listener of Array.from(listeners)) listener(delayMs);
      },
    };
    return source;
  }

  function reconnecting(
    url: string | (() => Promise<string>),
    options: {
      readonly delayMs?: number;
      readonly wake?: ReturnType<typeof wakeSource>;
    } = {},
  ): WsTransport {
    const transport = new WsTransport(url, fakeSocketPlatform(sockets), {
      preserveSocketPath: true,
      recordConnectionState: false,
      getReconnectDelayMs: () => options.delayMs ?? 60_000,
      ...(options.wake === undefined ? {} : { subscribeReconnectWake: options.wake.subscribe }),
    });
    transports.push(transport);
    return transport;
  }

  /** Open the first socket, then drop it so a reconnect delay starts. */
  async function dropFirstSocket(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(0);
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries at once when woken during a long delay", async () => {
    const wake = wakeSource();
    reconnecting("ws://relay.test/relay", { wake });
    await dropFirstSocket();
    expect(wake.listeners.size).toBe(1);

    wake.wake(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
    // The listener left with the delay it served.
    expect(wake.listeners.size).toBe(0);
  });

  it("retries after the wake's own delay", async () => {
    const wake = wakeSource();
    reconnecting("ws://relay.test/relay", { wake });
    await dropFirstSocket();

    wake.wake(500);
    await vi.advanceTimersByTimeAsync(499);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
  });

  it("never lengthens a delay that ends before the wake's", async () => {
    const wake = wakeSource();
    reconnecting("ws://relay.test/relay", { delayMs: 300, wake });
    await dropFirstSocket();

    wake.wake(1_000);
    await vi.advanceTimersByTimeAsync(299);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    expect(wake.listeners.size).toBe(0);
  });

  it("listens only while a delay is pending", async () => {
    const wake = wakeSource();
    reconnecting("ws://relay.test/relay", { wake });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.open();
    await vi.advanceTimersByTimeAsync(0);

    expect(wake.listeners.size).toBe(0);
    wake.wake(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(1);
  });

  it("makes one attempt for two wakes during one delay", async () => {
    const wake = wakeSource();
    reconnecting("ws://relay.test/relay", { wake });
    await dropFirstSocket();
    const listener = Array.from(wake.listeners)[0]!;

    listener(100);
    // Only the first wake of a delay counts, even through a listener still held.
    listener(0);
    wake.wake(0);
    await vi.advanceTimersByTimeAsync(99);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    expect(wake.subscriptions).toBe(1);
  });

  it("stops listening when the delay ends without a wake", async () => {
    const wake = wakeSource();
    reconnecting("ws://relay.test/relay", { delayMs: 300, wake });
    await dropFirstSocket();
    expect(wake.listeners.size).toBe(1);

    await vi.advanceTimersByTimeAsync(300);
    expect(sockets).toHaveLength(2);
    expect(wake.listeners.size).toBe(0);
  });

  it("stops listening when the transport is disposed", async () => {
    const wake = wakeSource();
    const transport = reconnecting("ws://relay.test/relay", { wake });
    await dropFirstSocket();
    expect(wake.listeners.size).toBe(1);

    await transport.dispose();
    expect(wake.listeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("wakes a socket URL provider that failed", async () => {
    const wake = wakeSource();
    const provider = vi.fn(async () => {
      if (provider.mock.calls.length === 1) throw new Error("node offline");
      return "ws://relay.test/relay";
    });
    reconnecting(provider, { wake });
    await vi.advanceTimersByTimeAsync(0);
    expect(provider).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(0);
    expect(wake.listeners.size).toBe(1);

    wake.wake(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(1);
    expect(wake.listeners.size).toBe(0);
  });

  it("waits the whole delay without a wake handler", async () => {
    reconnecting("ws://relay.test/relay");
    await dropFirstSocket();

    await vi.advanceTimersByTimeAsync(59_999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
  });
});
