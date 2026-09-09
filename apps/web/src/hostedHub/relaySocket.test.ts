import { RELAY_INITIAL_LIMITS, type RelayChannelId } from "@ryco/contracts";
import {
  encodeBase64Url,
  RELAY_E2EE_NEGOTIATION_BUFFER_FULL_MESSAGE,
  RELAY_E2EE_SEND_UNAVAILABLE_MESSAGE,
  RELAY_MESSAGE_TOO_LARGE_MESSAGE,
  RELAY_PEER_UNSUPPORTED_MESSAGE,
  RELAY_SEND_QUEUE_FULL_MESSAGE,
  type RelayE2eeChannel,
  type RelayE2eeHost,
} from "@ryco/client-runtime/relay";
import { decodeRelayFrame, encodeRelayFrame } from "@ryco/shared/relayCodec";
import { stripRelayChunkCapabilityPrelude } from "@ryco/shared/relayMessageChunks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  authenticateRelay,
  createRelayHarness,
  MockWebSocket,
  relayCallbacks,
  RELAY_CHANNEL_ID,
  RELAY_VERSION,
} from "../../test/maliciousRelay";
import { BrowserHostedRelaySocket, hostedRelayWebSocketUrl, sendException } from "./relaySocket";

/**
 * Facade-level tests for the browser relay adapter (the DOM boundary the
 * package engine cannot cover): destination/expiry validation before a socket
 * is opened, wire coercion of every browser message type, and the
 * draining/closed status transitions.
 *
 * The mock socket and the connect sequence come from `test/maliciousRelay.ts`
 * so this suite and the Chromium suites of §16.4 drive ONE implementation of
 * the wire boundary. A second copy here would let the two runtimes disagree
 * about what reached the socket, which is the only thing either suite asserts.
 */

const CHANNEL_ID: RelayChannelId = RELAY_CHANNEL_ID;
const VERSION = RELAY_VERSION;
const originalWindow = globalThis.window;

const callbacks = relayCallbacks;

/**
 * The facade as `apps/web` built it BEFORE this tier had a provider, and as it
 * still builds it whenever §14.5's startup check refuses one: no `e2ee`, so the
 * engine runs the unchanged legacy channel.
 */
function create(handlers = callbacks()) {
  return createRelayHarness({ handlers });
}

function authenticate(socket: MockWebSocket) {
  authenticateRelay(socket);
}

/**
 * The frame sequence a full connect / ping / send / send / close produces, as
 * it stood before the E2EE seams were opened inside `HostedRelayEngine`.
 * `packages/client-runtime/src/relay/relayEngine.test.ts` pins the identical
 * literal at the package boundary; both surfaces carry it because both apps
 * instantiate the engine and neither owns any framing of its own.
 */
const LEGACY_FRAME_SEQUENCE = [
  "a5647065657266636c69656e74647479706564617574686b72656c61795469636b6574582007070707070707070707070707070707070707070707070707070707070707076d70726f746f636f6c4d616a6f72016d70726f746f636f6c4d696e6f7203",
  "a4647479706564706f6e67656e6f6e63654804040404040404046d70726f746f636f6c4d616a6f72016d70726f746f636f6c4d696e6f7202",
  "a664747970656464617461677061796c6f61645320090d0a20090d0a7b226669727374223a317d6873657175656e636500696368616e6e656c4964781963685f636363636363636363636363636363636363636363636d70726f746f636f6c4d616a6f72016d70726f746f636f6c4d696e6f7202",
  "a664747970656464617461677061796c6f61645420090d0a20090d0a7b227365636f6e64223a327d6873657175656e636501696368616e6e656c4964781963685f636363636363636363636363636363636363636363636d70726f746f636f6c4d616a6f72016d70726f746f636f6c4d696e6f7202",
  "a464747970656d6368616e6e656c2e636c6f7365696368616e6e656c4964781963685f636363636363636363636363636363636363636363636d70726f746f636f6c4d616a6f72016d70726f746f636f6c4d696e6f7202",
] as const;

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function lastPayload(socket: MockWebSocket): number[] | null {
  const decoded = decodeRelayFrame(new Uint8Array(socket.sent.at(-1)!));
  return decoded.ok && decoded.value.type === "data"
    ? [...stripRelayChunkCapabilityPrelude(decoded.value.payload).message]
    : null;
}

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin: "https://hub.example.test" } },
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
  vi.restoreAllMocks();
});

describe("BrowserHostedRelaySocket destination validation", () => {
  it("reports a canonical upgrade rejection received only in the socket close", () => {
    const handlers = callbacks();
    const { socket } = create(handlers);
    socket.open();
    socket.dispatchEvent(Object.assign(new Event("close"), { reason: "authorization_failed" }));
    expect(handlers.onFailure).toHaveBeenCalledExactlyOnceWith({
      kind: "authorization-removed",
      retryable: false,
      closeReason: "authorization_failed",
    });
  });

  it("rejects a non-relay destination before opening a socket or sending the ticket", () => {
    const sockets: MockWebSocket[] = [];
    expect(
      () =>
        new BrowserHostedRelaySocket({
          url: "wss://evil.example.test/v1/relay/client",
          ticket: encodeBase64Url(new Uint8Array(32).fill(7)),
          ticketExpiresAt: Date.now() + 60_000,
          callbacks: callbacks(),
          createSocket: () => {
            const socket = new MockWebSocket();
            sockets.push(socket);
            return socket as unknown as WebSocket;
          },
        }),
    ).toThrow("Relay attempt is no longer valid.");
    expect(sockets).toHaveLength(0);
  });

  it("rejects an expired ticket before opening a socket", () => {
    const sockets: MockWebSocket[] = [];
    expect(
      () =>
        new BrowserHostedRelaySocket({
          url: hostedRelayWebSocketUrl(),
          ticket: encodeBase64Url(new Uint8Array(32).fill(7)),
          ticketExpiresAt: Date.now() - 1,
          callbacks: callbacks(),
          createSocket: () => {
            const socket = new MockWebSocket();
            sockets.push(socket);
            return socket as unknown as WebSocket;
          },
        }),
    ).toThrow("Relay attempt is no longer valid.");
    expect(sockets).toHaveLength(0);
  });

  it("closes the created socket when engine construction fails after prevalidation", () => {
    const sockets: MockWebSocket[] = [];
    // URL and expiry prevalidation pass, so the socket is created — but the
    // ticket material is undecodable, so the engine constructor throws.
    expect(
      () =>
        new BrowserHostedRelaySocket({
          url: hostedRelayWebSocketUrl(),
          ticket: "not valid base64url!!!",
          ticketExpiresAt: Date.now() + 60_000,
          callbacks: callbacks(),
          createSocket: () => {
            const socket = new MockWebSocket();
            sockets.push(socket);
            return socket as unknown as WebSocket;
          },
        }),
    ).toThrow("Invalid encoded material.");
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closeCalls).toBe(1);
    expect(sockets[0]!.readyState).toBe(MockWebSocket.CLOSED);
  });
});

describe("BrowserHostedRelaySocket wire compatibility", () => {
  it("emits the pre-E2EE frame sequence byte for byte when constructed with no E2EE provider", async () => {
    const { facade, socket } = create();
    const received: number[][] = [];
    facade.addEventListener("message", (event) =>
      received.push([...new Uint8Array((event as MessageEvent).data)]),
    );
    authenticate(socket);
    socket.frame({
      type: "ping",
      ...VERSION,
      nonce: new Uint8Array(8).fill(4),
    });
    socket.frame({
      type: "data",
      ...VERSION,
      channelId: CHANNEL_ID,
      sequence: 0 as never,
      payload: new TextEncoder().encode('{"inbound":1}'),
    });
    await Promise.resolve();
    facade.send(new TextEncoder().encode('{"first":1}'));
    facade.send(new TextEncoder().encode('{"second":2}'));
    facade.close();

    // The facade owns no framing — it instantiates the same engine
    // `apps/mobile` does — so the E2EE seams inside that engine are a no-op on a
    // PROVIDER-LESS construction exactly as long as this sequence is unchanged.
    // It is pinned as bytes for the reason the package-level copy is: an extra
    // frame or a reordered map key would still satisfy a structural assertion.
    //
    // This is not the shape `runtime.ts` builds any more — that one injects
    // `resolveWebRelayE2eeProvider()` — and it is deliberately still pinned,
    // because it is exactly what docs/relay-e2ee-protocol.md §14.5's startup
    // refusal falls back to.
    expect(socket.sent.map((bytes) => hex(new Uint8Array(bytes)))).toEqual([
      ...LEGACY_FRAME_SEQUENCE,
    ]);
    expect(received).toEqual([[...new TextEncoder().encode('{"inbound":1}')]]);
  });

  it("hands a supplied E2EE provider to the engine, which builds it at channel.accept", () => {
    // The twin of the case above: the ONE structural difference between a
    // provider-less facade and a wired one is that the engine builds a §4.4 mode
    // machine, and §4.4 fixes when — "created at `channel.accept`", before any
    // payload. A provider that is merely accepted as an option and never reached
    // would leave every K row unreachable while this suite stayed green.
    const built: RelayE2eeHost[] = [];
    const channel: RelayE2eeChannel = {
      intercept: async () => ({ kind: "claimed" }),
      submit: () => false,
      beginClose: async () => "refused",
      dispose: () => undefined,
    };
    const { socket } = createRelayHarness({
      e2ee: (host) => {
        built.push(host);
        return channel;
      },
    });
    socket.open();
    socket.frame({ type: "ready", ...VERSION, limits: RELAY_INITIAL_LIMITS });
    socket.frame({
      type: "channel.open",
      ...VERSION,
      channelId: CHANNEL_ID,
      capability: "ryco.rpc",
      effectiveRole: "operator",
    });
    expect(built).toHaveLength(0);
    socket.frame({ type: "channel.accept", ...VERSION, channelId: CHANNEL_ID });
    expect(built).toHaveLength(1);
    expect(built[0]!.channel.channelId).toBe(CHANNEL_ID);
  });

  it("coerces string, ArrayBuffer, typed-array, and SharedArrayBuffer send inputs", () => {
    const { facade, socket } = create();
    authenticate(socket);

    facade.send(new Uint8Array([1, 2, 3]).buffer);
    expect(lastPayload(socket)).toEqual([1, 2, 3]);
    facade.send(new Uint8Array([4, 5, 6]));
    expect(lastPayload(socket)).toEqual([4, 5, 6]);
    facade.send(new DataView(new Uint8Array([7, 8, 9]).buffer));
    expect(lastPayload(socket)).toEqual([7, 8, 9]);
    facade.send("AB");
    expect(lastPayload(socket)).toEqual([65, 66]);
    if (typeof SharedArrayBuffer !== "undefined") {
      const shared = new SharedArrayBuffer(3);
      new Uint8Array(shared).set([10, 11, 12]);
      facade.send(shared);
      expect(lastPayload(socket)).toEqual([10, 11, 12]);
    }
  });

  it("rejects Blob send inputs", () => {
    const { facade, socket } = create();
    authenticate(socket);
    expect(() => facade.send(new Blob([new Uint8Array([1])]))).toThrow(
      "Blob RPC writes are unsupported.",
    );
  });

  it("throws an InvalidStateError when sending before the channel handshake completes", () => {
    const { facade } = create();
    // No authenticate: the engine has no accepted channel yet, and the
    // WebSocket-API contract requires an InvalidStateError DOMException.
    let thrown: unknown;
    try {
      facade.send(new Uint8Array([1, 2, 3]));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe("InvalidStateError");
    expect((thrown as DOMException).message).toBe("Relay channel is not open.");
  });

  it("keeps every send refusal on its own DOMException name", () => {
    // The engine's send errors are mapped BY MESSAGE at this boundary, so the
    // mapping is asserted against the engine's own exported strings rather than
    // through one caller: the §4.4 negotiation-buffer refusal is reachable only
    // inside a single channel's `negotiating` window and never at all on a
    // provider-less construction, and a test that could only reach it through
    // `send` would pin one caller's timing instead of the contract.
    for (const message of [
      RELAY_SEND_QUEUE_FULL_MESSAGE,
      RELAY_MESSAGE_TOO_LARGE_MESSAGE,
      RELAY_PEER_UNSUPPORTED_MESSAGE,
      RELAY_E2EE_NEGOTIATION_BUFFER_FULL_MESSAGE,
      RELAY_E2EE_SEND_UNAVAILABLE_MESSAGE,
    ]) {
      const mapped = sendException(new Error(message));
      expect(mapped).toBeInstanceOf(DOMException);
      expect((mapped as DOMException).name).toBe("QuotaExceededError");
      expect((mapped as DOMException).message).toBe(message);
    }
    // Everything else is a state error, and a DOMException is passed through.
    const state = sendException(new Error("Relay channel is not open."));
    expect((state as DOMException).name).toBe("InvalidStateError");
    const original = new DOMException("already mapped", "QuotaExceededError");
    expect(sendException(original)).toBe(original);
  });

  it("raises the queue-full refusal through the facade with that name", () => {
    const { facade, socket } = create();
    authenticate(socket);
    socket.bufferedAmount = RELAY_INITIAL_LIMITS.maxQueuedBytes;

    let thrown: unknown;
    try {
      facade.send(new Uint8Array(1_024));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe("QuotaExceededError");
    expect((thrown as DOMException).message).toBe(RELAY_SEND_QUEUE_FULL_MESSAGE);
  });

  it("reports an established E2EE keepalive refusal as observable quota backpressure", () => {
    const onFailure = vi.fn();
    const channel: RelayE2eeChannel = {
      intercept: async () => ({ kind: "claimed" }),
      submit: () => false,
      beginClose: async () => "refused",
      dispose: () => undefined,
    };
    const { facade, socket } = createRelayHarness({
      handlers: { ...callbacks(), onFailure },
      e2ee: (host) => {
        host.lockMode("e2ee");
        return channel;
      },
    });
    authenticate(socket);

    let thrown: unknown;
    try {
      // Effect's keepalive is an ordinary application RPC write at this seam.
      // Ignoring the admission result must still produce a synchronous refusal.
      facade.send('{"_tag":"Ping"}');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe("QuotaExceededError");
    expect((thrown as DOMException).message).toBe(RELAY_E2EE_SEND_UNAVAILABLE_MESSAGE);
    expect(onFailure).not.toHaveBeenCalled();
    expect(facade.readyState).toBe(WebSocket.OPEN);
  });

  it("raises an over-ceiling submission as a quota refusal, not an invalid state", () => {
    // The mapping's first arm matched a message the engine stopped throwing when
    // the oversized-RPC framing landed, so this one had been falling through to
    // `InvalidStateError` — a size refusal reported as a state error.
    const { facade, socket } = create();
    authenticate(socket);

    let thrown: unknown;
    try {
      facade.send(new Uint8Array(RELAY_INITIAL_LIMITS.maxQueuedBytes * 4));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as DOMException).name).toBe("QuotaExceededError");
    expect((thrown as DOMException).message).toBe(RELAY_MESSAGE_TOO_LARGE_MESSAGE);
  });

  it("delivers ArrayBuffer and typed-array inbound messages", async () => {
    const { facade, socket } = create();
    const received: number[][] = [];
    facade.addEventListener("message", (event) =>
      received.push([...new Uint8Array((event as MessageEvent).data)]),
    );
    authenticate(socket);

    socket.frame({
      type: "data",
      ...VERSION,
      channelId: CHANNEL_ID,
      sequence: 0 as never,
      payload: new Uint8Array([9, 8, 7]),
    });
    const secondFrame = encodeRelayFrame({
      type: "data",
      ...VERSION,
      channelId: CHANNEL_ID,
      sequence: 1 as never,
      payload: new Uint8Array([6, 5, 4]),
    });
    if (!secondFrame.ok) throw new Error("test frame encoding failed");
    // Deliver the second inbound frame as a typed-array view rather than an
    // ArrayBuffer, exercising the view branch of the message coercion.
    socket.deliver(Uint8Array.from(secondFrame.value));

    for (let hop = 0; hop < 6; hop += 1) await Promise.resolve();
    expect(received).toEqual([
      [9, 8, 7],
      [6, 5, 4],
    ]);
  });

  it("classifies a non-binary inbound message as an oversized frame, not a dropped payload", () => {
    const handlers = callbacks();
    const { socket } = create(handlers);
    socket.open();
    socket.deliver("this is a text frame, not relay bytes");
    // The original façade classified a message with no relay byte length as
    // frame_too_large — assert that exact close reason, not protocol_invalid.
    expect(handlers.onFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "protocol",
        retryable: false,
        closeReason: "frame_too_large",
      }),
    );
  });

  it("fails closed on a direct inbound SharedArrayBuffer", () => {
    if (typeof SharedArrayBuffer === "undefined") return;
    const handlers = callbacks();
    const { socket } = create(handlers);
    socket.open();
    socket.deliver(new SharedArrayBuffer(8));
    expect(handlers.onFailure).toHaveBeenCalledWith(expect.objectContaining({ kind: "protocol" }));
    // A raw SharedArrayBuffer is an invalid frame (protocol_invalid), which
    // carries no close reason — distinct from the oversized-frame case.
    const failure = handlers.onFailure.mock.calls.at(-1)?.[0] as {
      closeReason?: string;
    };
    expect(failure.closeReason).toBeUndefined();
  });

  it("emits draining on close and guards an already-closed facade", () => {
    const handlers = callbacks();
    const { facade, socket } = create(handlers);
    authenticate(socket);
    handlers.onTransportStatus.mockClear();

    facade.close();
    expect(handlers.onTransportStatus).toHaveBeenCalledWith("draining");
    expect(facade.readyState).toBe(WebSocket.CLOSED);

    handlers.onTransportStatus.mockClear();
    facade.close();
    expect(facade.readyState).toBe(WebSocket.CLOSED);
    expect(handlers.onTransportStatus).not.toHaveBeenCalled();
  });
});
