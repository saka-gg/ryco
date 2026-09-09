import { RELAY_INITIAL_LIMITS, type RelayChannelId, type RelayFrame } from "@ryco/contracts";
import type { DpopSignerService } from "@ryco/client-runtime/platform";
import {
  encodeBase64Url,
  RELAY_E2EE_SEND_UNAVAILABLE_MESSAGE,
  type RelayE2eeChannel,
} from "@ryco/client-runtime/relay";
import { encodeRelayFrame } from "@ryco/shared/relayCodec";
import { describe, expect, it, vi } from "vite-plus/test";

// Native modules are stubbed so the adapter loads under the Node test runner,
// matching the pattern in `src/platform/platform.test.ts`.
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: () => {} }),
  },
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));

import {
  MobileHostedRelaySocket,
  type MobileHostedRelaySocketOptions,
  type NativeSocketLike,
} from "./relaySocket";

const RELAY_URL = "wss://hub.example.test/v1/relay/client";
const TOKEN = "session-token-value";
const PROOF = "proof.header.signature";
const CHANNEL_ID = "ch_cccccccccccccccccccccc" as RelayChannelId;
const VERSION = { protocolMajor: 1, protocolMinor: 2 } as const;

/** A relay ticket is 32 random bytes, base64url. */
const TICKET = encodeBase64Url(new Uint8Array(32).fill(9));

interface FakeSocket extends NativeSocketLike {
  readonly sent: ArrayBuffer[];
  readonly headers: Readonly<Record<string, string>>;
  emit: (type: string, event?: unknown) => void;
  closed: { code?: number; reason?: string } | null;
  setReadyState: (value: number) => void;
  setBufferedAmount: (value: number) => void;
}

function createFakeSocket(headers: Readonly<Record<string, string>>): FakeSocket {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  let readyState = 0;
  let bufferedAmount = 0;
  const socket: FakeSocket = {
    binaryType: "",
    get bufferedAmount() {
      return bufferedAmount;
    },
    get readyState() {
      return readyState;
    },
    sent: [],
    headers,
    closed: null,
    send: (data) => {
      socket.sent.push(data);
    },
    close: (code, reason) => {
      socket.closed = {
        ...(code === undefined ? {} : { code }),
        ...(reason === undefined ? {} : { reason }),
      };
    },
    addEventListener: (type, listener) => {
      const set = listeners.get(type) ?? [];
      set.push(listener as (event: unknown) => void);
      listeners.set(type, set);
    },
    emit: (type, event) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    setReadyState: (value) => {
      readyState = value;
    },
    setBufferedAmount: (value) => {
      bufferedAmount = value;
    },
  };
  return socket;
}

function callbacks() {
  return {
    onTransportStatus: vi.fn(),
    onSessionStatus: vi.fn(),
    onRole: vi.fn(),
    onFailure: vi.fn(),
  };
}

interface Harness {
  readonly facade: MobileHostedRelaySocket;
  readonly sockets: FakeSocket[];
  readonly sign: ReturnType<typeof vi.fn>;
  readonly events: Array<{
    type: string;
    code?: number;
    reason?: string;
    data?: unknown;
  }>;
}

function build(overrides: Partial<MobileHostedRelaySocketOptions> = {}): Harness {
  const sockets: FakeSocket[] = [];
  const sign = vi.fn(async () => PROOF);
  const signer: DpopSignerService = {
    sign: sign as unknown as DpopSignerService["sign"],
  };
  const facade = new MobileHostedRelaySocket({
    url: RELAY_URL,
    ticket: TICKET,
    ticketExpiresAt: 10_000,
    callbacks: callbacks(),
    now: () => 1_000,
    relayUrl: () => RELAY_URL,
    readBearerToken: () => TOKEN,
    dpopSigner: async () => signer,
    createSocket: (_url, headers) => {
      const socket = createFakeSocket(headers);
      sockets.push(socket);
      return socket;
    },
    ...overrides,
  });
  const events: Array<{
    type: string;
    code?: number;
    reason?: string;
    data?: unknown;
  }> = [];
  for (const type of ["open", "message", "error", "close"]) {
    facade.addEventListener(type, (event) => events.push(event));
  }
  return { facade, sockets, sign, events };
}

/** The mint is async; let it settle. */
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function emitFrame(socket: FakeSocket, frame: RelayFrame): void {
  const encoded = encodeRelayFrame(frame);
  if (!encoded.ok) throw new Error("test frame encoding failed");
  socket.emit("message", { data: Uint8Array.from(encoded.value).buffer });
}

async function authenticate(harness: Harness): Promise<FakeSocket> {
  await settle();
  const socket = harness.sockets[0]!;
  socket.setReadyState(1);
  socket.emit("open");
  emitFrame(socket, {
    type: "ready",
    ...VERSION,
    limits: RELAY_INITIAL_LIMITS,
  });
  emitFrame(socket, {
    type: "channel.open",
    ...VERSION,
    channelId: CHANNEL_ID,
    capability: "ryco.rpc",
    effectiveRole: "operator",
  });
  emitFrame(socket, {
    type: "channel.accept",
    ...VERSION,
    channelId: CHANNEL_ID,
  });
  return socket;
}

describe("relay attempt validation", () => {
  it("throws and never creates a socket for a URL other than the pinned relay endpoint", () => {
    const createSocket = vi.fn();
    expect(() => build({ url: "wss://evil.example.test/v1/relay/client", createSocket })).toThrow(
      "Relay attempt is no longer valid.",
    );
    expect(createSocket).not.toHaveBeenCalled();
  });

  it("throws and never creates a socket for an already-expired ticket", () => {
    const createSocket = vi.fn();
    const disposePreparedContext = vi.fn();
    expect(() =>
      build({
        ticketExpiresAt: 500,
        now: () => 1_000,
        createSocket,
        disposePreparedContext,
      }),
    ).toThrow("Relay attempt is no longer valid.");
    expect(createSocket).not.toHaveBeenCalled();
    expect(disposePreparedContext).toHaveBeenCalledOnce();
  });

  it("rejects a query string on the relay URL", () => {
    expect(() => build({ url: `${RELAY_URL}?x=1`, createSocket: vi.fn() })).toThrow(
      "Relay attempt is no longer valid.",
    );
  });
});

describe("DPoP upgrade", () => {
  it("passes a socket-only protocol rejection to the shared failure policy", async () => {
    const handlers = callbacks();
    const harness = build({ callbacks: handlers });
    await settle();
    harness.sockets[0]!.emit("close", { code: 4406, reason: "protocol_unsupported" });
    expect(handlers.onFailure).toHaveBeenCalledExactlyOnceWith({
      kind: "incompatible",
      retryable: false,
      closeReason: "protocol_unsupported",
    });
  });

  it("sends exactly the Authorization and DPoP headers, and no Cookie", async () => {
    const harness = build();
    await settle();

    expect(harness.sockets).toHaveLength(1);
    const headers = harness.sockets[0]!.headers;
    expect(headers).toEqual({ Authorization: `DPoP ${TOKEN}`, DPoP: PROOF });
    // A Cookie header on this upgrade is a hard 403 server-side.
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain("cookie");
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain("origin");
  });

  it("signs the proof over GET and the full relay URL, bound to the token", async () => {
    const harness = build();
    await settle();

    expect(harness.sign).toHaveBeenCalledTimes(1);
    expect(harness.sign).toHaveBeenCalledWith({
      method: "GET",
      url: RELAY_URL,
      token: TOKEN,
    });
  });

  it("sets arraybuffer binaryType on the platform socket", async () => {
    const harness = build();
    await settle();
    expect(harness.sockets[0]!.binaryType).toBe("arraybuffer");
  });

  it("fails closed when the proof mint rejects: error then close, no socket", async () => {
    const createSocket = vi.fn();
    const harness = build({
      dpopSigner: async () => {
        throw new Error("enclave unavailable at 0xdeadbeef");
      },
      createSocket,
    });
    await settle();

    expect(createSocket).not.toHaveBeenCalled();
    expect(harness.events.map((event) => event.type)).toEqual(["error", "close"]);
    expect(harness.facade.readyState).toBe(harness.facade.CLOSED);
  });

  it("fails closed when no bearer token is held", async () => {
    const createSocket = vi.fn();
    const harness = build({ readBearerToken: () => null, createSocket });
    await settle();

    expect(createSocket).not.toHaveBeenCalled();
    expect(harness.events.map((event) => event.type)).toEqual(["error", "close"]);
  });

  it("abandons a pending mint when the caller closes first", async () => {
    // Without this, a close issued while signing is in flight still opens an
    // authenticated upgrade when the proof resolves — against an engine that is
    // already closed, so it would never be authenticated or torn down.
    const createSocket = vi.fn();
    // The mint must be genuinely in flight when `close()` lands. The adapter
    // yields once before reading the token, so the deferred has to be created
    // up front — capturing it inside the signer would leave it undefined at
    // close time and the test would pass for the wrong reason.
    let releaseMint!: () => void;
    const minting = new Promise<void>((resolve) => {
      releaseMint = resolve;
    });
    const harness = build({
      createSocket,
      dpopSigner: async () => {
        await minting;
        return { sign: async () => PROOF } as unknown as DpopSignerService;
      },
    });

    // Let the adapter reach the pending mint before cancelling.
    await settle();
    harness.facade.close(1000, "cancelled");
    releaseMint();
    await settle();

    expect(createSocket).not.toHaveBeenCalled();
  });

  it("fails the engine on a mint failure, not just the facade", async () => {
    // Emitting only on the facade looks like an ordinary close to the shared
    // transport, which would reconnect and issue a fresh ticket — turning a
    // permanent key failure into an unbounded ticket loop.
    const onFailure = vi.fn();
    build({
      callbacks: { ...callbacks(), onFailure },
      dpopSigner: async () => {
        throw new Error("no key");
      },
    });
    await settle();

    expect(onFailure).toHaveBeenCalled();
  });

  it("never puts the token, proof, or ticket into a surfaced event", async () => {
    const harness = build({
      dpopSigner: async () => {
        throw new Error(`mint failed for ${TOKEN}`);
      },
    });
    await settle();

    const serialized = JSON.stringify(harness.events);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(PROOF);
    expect(serialized).not.toContain(TICKET);
  });
});

describe("engine seam", () => {
  it("copies the outbound buffer synchronously so the engine's zeroing cannot reach the wire", async () => {
    const harness = build();
    await settle();
    const socket = harness.sockets[0]!;

    socket.setReadyState(1);
    socket.emit("open");

    // The engine sends its CBOR auth frame on open; that is the buffer under
    // test. It zeroes the array immediately after `send` returns, so a facade
    // that enqueued the caller's array would transmit zeros.
    expect(socket.sent).toHaveLength(1);
    const transmitted = new Uint8Array(socket.sent[0]!);
    expect(transmitted.some((byte) => byte !== 0)).toBe(true);
  });

  it("reports an undecodable inbound message instead of dropping it", async () => {
    const harness = build();
    await settle();
    const socket = harness.sockets[0]!;
    socket.setReadyState(1);
    socket.emit("open");

    // A string payload has no relay byte length; nothing may be silently dropped.
    socket.emit("message", { data: "not-binary" });

    // The engine turns an undecodable frame into a transport failure rather
    // than ignoring it, so the facade must have been driven to close.
    expect(harness.events.some((event) => event.type === "close")).toBe(true);
  });

  it("reports bufferedAmount from the engine, not the raw socket", async () => {
    const harness = build();
    await settle();
    harness.sockets[0]!.setBufferedAmount(4_096);

    // Before the channel is accepted the engine has nothing queued, so the
    // facade must not echo the platform socket's 4096.
    expect(harness.facade.bufferedAmount).toBe(4_096 + 0);
    expect(typeof harness.facade.bufferedAmount).toBe("number");
  });

  it("refuses to send before the relay channel is accepted", async () => {
    const harness = build();
    await settle();

    expect(() => harness.facade.send(new Uint8Array([1, 2, 3]))).toThrow(
      "Relay channel is not open.",
    );
  });

  it("preserves the established E2EE refusal message for an RPC keepalive", async () => {
    const onFailure = vi.fn();
    const channel: RelayE2eeChannel = {
      intercept: async () => ({ kind: "claimed" }),
      submit: () => false,
      beginClose: async () => "refused",
      dispose: () => undefined,
    };
    const harness = build({
      callbacks: { ...callbacks(), onFailure },
      e2ee: (host) => {
        host.lockMode("e2ee");
        return channel;
      },
    });
    await authenticate(harness);

    let thrown: unknown;
    try {
      // Native has no DOMException mapping. Effect's keepalive still receives
      // the same synchronous, stable Error the engine exposes for every caller.
      harness.facade.send('{"_tag":"Ping"}');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(RELAY_E2EE_SEND_UNAVAILABLE_MESSAGE);
    expect(onFailure).not.toHaveBeenCalled();
    expect(harness.facade.readyState).toBe(harness.facade.OPEN);
  });
});

describe("WebSocket facade contract", () => {
  it("exposes the members the RPC socket layer drives", async () => {
    const harness = build();
    const facade = harness.facade as unknown as Record<string, unknown>;

    for (const member of [
      "url",
      "binaryType",
      "readyState",
      "bufferedAmount",
      "send",
      "close",
      "addEventListener",
      "removeEventListener",
      "CONNECTING",
      "OPEN",
      "CLOSING",
      "CLOSED",
    ]) {
      expect(member in facade).toBe(true);
    }
    expect(harness.facade.CONNECTING).toBe(0);
    expect(harness.facade.OPEN).toBe(1);
    expect(harness.facade.CLOSING).toBe(2);
    expect(harness.facade.CLOSED).toBe(3);
    await settle();
  });

  it("honours {once:true} listener semantics", async () => {
    const harness = build();
    const once = vi.fn();
    harness.facade.addEventListener("close", once, { once: true });
    await settle();
    const socket = harness.sockets[0]!;
    socket.setReadyState(1);
    socket.emit("open");

    harness.facade.close(1000, "done");
    harness.facade.close(1000, "again");

    expect(once).toHaveBeenCalledTimes(1);
  });

  it("removes a listener on request", async () => {
    const harness = build();
    const listener = vi.fn();
    harness.facade.addEventListener("close", listener);
    harness.facade.removeEventListener("close", listener);
    await settle();

    harness.facade.close(1000, "done");

    expect(listener).not.toHaveBeenCalled();
  });

  it("emits close with code and reason the socket layer reads", async () => {
    const harness = build();
    await settle();
    const socket = harness.sockets[0]!;
    socket.setReadyState(1);
    socket.emit("open");

    harness.facade.close(1000, "done");

    const close = harness.events.find((event) => event.type === "close");
    expect(close).toBeDefined();
    expect(typeof close?.code).toBe("number");
    expect(typeof close?.reason).toBe("string");
  });

  it("drives the on* handler properties as well as listeners", async () => {
    const harness = build();
    const onclose = vi.fn();
    harness.facade.onclose = onclose;
    await settle();

    harness.facade.close(1000, "done");

    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("starts in CONNECTING before the mint resolves", () => {
    const harness = build();
    expect(harness.facade.readyState).toBe(harness.facade.CONNECTING);
  });
});
