import {
  RELAY_INITIAL_LIMITS,
  RELAY_MAX_RPC_MESSAGE_BYTES,
  RelayLimits,
  type RelayChannelId,
  type RelayFrame,
} from "@ryco/contracts";
import { decodeRelayFrame, encodeRelayFrame } from "@ryco/shared/relayCodec";
import {
  E2EE_ENVELOPE_OVERHEAD_BYTES,
  e2eeChannelSizeBudget,
} from "@ryco/shared/relayE2eeConstants";
import {
  isChunkedPayload,
  planRelayMessage,
  RELAY_CHUNK_CAPABILITY_PRELUDE,
  splitRelayMessage,
  stripRelayChunkCapabilityPrelude,
} from "@ryco/shared/relayMessageChunks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { encodeBase64Url } from "./base64url";
import {
  HostedRelayEngine,
  RELAY_E2EE_NEGOTIATION_BUFFER_FULL_MESSAGE,
  RELAY_E2EE_SEND_UNAVAILABLE_MESSAGE,
  type HostedRelaySocketCallbacks,
  type RelayE2eeChannel,
  type RelayE2eeHost,
  type RelayE2eeMode,
  type RelayE2eeProvider,
  type RelayE2eeReservation,
  type RelaySocket,
  type RelayTimers,
  relayE2eeFailure,
  relayE2eeUnresolvedAttemptFailure,
} from "./relayEngine";

const CHANNEL_ID = "ch_cccccccccccccccccccccc" as RelayChannelId;
const VERSION = { protocolMajor: 1, protocolMinor: 2 } as const;
const VERSION_3 = { protocolMajor: 1, protocolMinor: 3 } as const;
const OPEN = 1;

/**
 * Fake raw-byte socket implementing the package's `RelaySocket` seam. The
 * engine owns every buffer it passes to `send`, so the fake keeps two views:
 * `sent` is a snapshot taken at call time (what actually went on the wire) and
 * `sentRefs` retains the engine's own buffer so a test can observe that the
 * engine zeroes it afterwards.
 */
class MockRelaySocket implements RelaySocket {
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];
  readonly sentRefs: Uint8Array[] = [];
  /** A socket that died under the engine: the write is attempted and throws. */
  throwOnSend = false;
  onSend: (() => void) | undefined;
  #open: Array<() => void> = [];
  #message: Array<(bytes: Uint8Array) => void> = [];
  #close: Array<(reason?: string) => void> = [];
  #error: Array<() => void> = [];

  send(bytes: Uint8Array): void {
    this.sentRefs.push(bytes);
    this.sent.push(Uint8Array.from(bytes));
    if (this.throwOnSend) throw new Error("socket is gone");
    this.onSend?.();
  }
  close(): void {
    this.readyState = 3;
  }
  onOpen(listener: () => void): void {
    this.#open.push(listener);
  }
  onBinaryMessage(listener: (bytes: Uint8Array) => void): void {
    this.#message.push(listener);
  }
  onClose(listener: (reason?: string) => void): void {
    this.#close.push(listener);
  }
  onError(listener: () => void): void {
    this.#error.push(listener);
  }

  open(): void {
    this.readyState = OPEN;
    for (const listener of this.#open) listener();
  }
  emitClose(reason?: string): void {
    for (const listener of this.#close) listener(reason);
  }
  emitError(): void {
    for (const listener of this.#error) listener();
  }
  frame(frame: RelayFrame): void {
    const encoded = encodeRelayFrame(frame);
    if (!encoded.ok) throw new Error("test frame encoding failed");
    for (const listener of this.#message) listener(Uint8Array.from(encoded.value));
  }
}

/**
 * The exact frame sequence a full connect / ping / send / send / close produces
 * with NO E2EE provider injected, captured from the engine as it stood before
 * the E2EE seams were opened.
 *
 * It is pinned as bytes rather than as decoded frames because the seams are
 * only a no-op if nothing about the wire moved: an extra field, a reordered
 * map key, or one more frame would all decode to something a structural
 * assertion still accepts. `apps/web` and `apps/mobile` both instantiate this
 * engine and own no framing of their own (relaySocket.ts in each), so this one
 * sequence is the no-op proof for both surfaces.
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

/** One full turn of the microtask chain the E2EE seam interposes. */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
};

function callbacks() {
  return {
    onTransportStatus: vi.fn(),
    onSessionStatus: vi.fn(),
    onRole: vi.fn(),
    onFailure: vi.fn(),
  } satisfies HostedRelaySocketCallbacks;
}

function realTimers(): RelayTimers {
  return {
    now: () => Date.now(),
    setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
    queueMicrotask: (cb) => globalThis.queueMicrotask(cb),
  };
}

function create(
  callbackSet = callbacks(),
  timers: RelayTimers = realTimers(),
  e2ee?: RelayE2eeProvider,
) {
  const socket = new MockRelaySocket();
  const events = {
    onOpen: vi.fn(),
    onData: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
  };
  const engine = new HostedRelayEngine({
    ticket: encodeBase64Url(new Uint8Array(32).fill(7)),
    ticketExpiresAt: Date.now() + 60_000,
    socket,
    timers,
    callbacks: callbackSet,
    events,
    ...(e2ee === undefined ? {} : { e2ee }),
  });
  return { engine, socket, callbacks: callbackSet, events };
}

/**
 * A provider that records what the seam handed it and does nothing else. It is
 * the whole point of the seam: everything the protocol decides is the channel's,
 * and the engine's contribution is the reservation, the limits, the assembler
 * verdict, and the outer close.
 *
 * It locks `e2ee` from inside its own factory so these tests exercise the
 * ESTABLISHED seam, which is what they are about. §4.4's `negotiating` state and
 * its K rows are the mode machine's and are driven in `relayE2eeInitiator.test.ts`.
 */
function stubProvider(
  overrides: Partial<RelayE2eeChannel> = {},
  lock: RelayE2eeMode | null = "e2ee",
) {
  const calls = {
    hosts: [] as RelayE2eeHost[],
    emitted: [] as Uint8Array[],
    intercepted: [] as Uint8Array[],
    beginCloseCalls: 0,
    disposed: [] as ({ readonly incompleteReassembly?: boolean } | undefined)[],
  };
  const provider: RelayE2eeProvider = (host) => {
    calls.hosts.push(host);
    if (lock !== null) host.lockMode(lock);
    return {
      intercept: async (payload) => {
        calls.intercepted.push(Uint8Array.from(payload));
        return { kind: "rpc", message: payload };
      },
      submit: (message) => {
        calls.emitted.push(Uint8Array.from(message));
        return true;
      },
      beginClose: async () => {
        calls.beginCloseCalls += 1;
        host.close();
        return "opened";
      },
      dispose: (options) => calls.disposed.push(options),
      ...overrides,
    };
  };
  return { provider, calls, host: () => calls.hosts[0]! };
}

function authenticate(socket: MockRelaySocket, limits: RelayLimits = RELAY_INITIAL_LIMITS) {
  socket.open();
  const auth = decodeRelayFrame(socket.sent[0]!);
  expect(auth.ok && auth.value.type === "auth" && auth.value.peer === "client").toBe(true);
  socket.frame({ type: "ready", ...VERSION, limits });
  socket.frame({
    type: "channel.open",
    ...VERSION,
    channelId: CHANNEL_ID,
    capability: "ryco.rpc",
    effectiveRole: "operator",
  });
  socket.frame({ type: "channel.accept", ...VERSION, channelId: CHANNEL_ID });
}

function advertisedPayload(message: Uint8Array): Uint8Array {
  const payload = new Uint8Array(RELAY_CHUNK_CAPABILITY_PRELUDE.byteLength + message.byteLength);
  payload.set(RELAY_CHUNK_CAPABILITY_PRELUDE);
  payload.set(message, RELAY_CHUNK_CAPABILITY_PRELUDE.byteLength);
  return payload;
}

function sentFrames(socket: MockRelaySocket): RelayFrame[] {
  return socket.sent.flatMap((bytes) => {
    const decoded = decodeRelayFrame(bytes);
    return decoded.ok ? [decoded.value] : [];
  });
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("HostedRelayEngine", () => {
  it("emits the pre-E2EE frame sequence byte for byte when no provider is injected", async () => {
    const { engine, socket, events } = create();
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
    engine.send(new TextEncoder().encode('{"first":1}'));
    engine.send(new TextEncoder().encode('{"second":2}'));
    engine.close();

    expect(socket.sent.map(hex)).toEqual([...LEGACY_FRAME_SEQUENCE]);
    // The inbound payload still reaches the application on the same turn it
    // always did: with no provider there is no interception seam between the
    // assembler and onData.
    expect(events.onData).toHaveBeenCalledWith(new TextEncoder().encode('{"inbound":1}'));
  });

  it.each([
    ["authentication_failed", "authentication", true],
    ["authentication_required", "authentication", false],
    ["authorization_failed", "authorization-removed", false],
    ["protocol_unsupported", "incompatible", false],
    ["revoked", "revoked", false],
    ["node_offline", "offline", true],
    ["server_draining", "draining", true],
  ] as const)(
    "preserves the %s socket close before the first relay frame",
    (reason, kind, retryable) => {
      const { socket, callbacks: handlers, events } = create();
      socket.open();
      socket.emitClose(reason);
      socket.emitClose(reason);
      expect(handlers.onFailure).toHaveBeenCalledExactlyOnceWith({
        kind,
        retryable,
        closeReason: reason,
      });
      expect(events.onOpen).not.toHaveBeenCalled();
      expect(events.onClose).toHaveBeenCalledOnce();
    },
  );

  it.each([undefined, "", "private server diagnostic"])(
    "does not surface an unknown socket reason (%s)",
    (reason) => {
      const { socket, callbacks: handlers, events } = create();
      socket.emitClose(reason);
      expect(handlers.onFailure).toHaveBeenCalledExactlyOnceWith({
        kind: "network",
        retryable: true,
      });
      expect(JSON.stringify(events.onClose.mock.calls)).not.toContain("private server diagnostic");
    },
  );

  it("authenticates with a memory-only first frame and forwards RPC bytes exactly", async () => {
    const { engine, socket, callbacks: handlers, events } = create();
    const received: number[][] = [];
    events.onData.mockImplementation((bytes: Uint8Array) => received.push([...bytes]));

    authenticate(socket);
    expect(handlers.onFailure.mock.calls).toEqual([]);
    expect(events.onOpen).toHaveBeenCalledOnce();
    expect(handlers.onTransportStatus).toHaveBeenCalledWith("online");
    expect(handlers.onSessionStatus).toHaveBeenCalledWith("synchronizing");
    expect(handlers.onRole).toHaveBeenCalledWith("operator");

    const outbound = new Uint8Array([0, 1, 2, 254, 255]);
    engine.send(outbound);
    const sent = decodeRelayFrame(socket.sent.at(-1)!);
    expect(
      sent.ok && sent.value.type === "data"
        ? [...stripRelayChunkCapabilityPrelude(sent.value.payload).message]
        : null,
    ).toEqual([0, 1, 2, 254, 255]);
    expect(sent.ok && sent.value.type === "data" ? sent.value.sequence : null).toBe(0);

    const inbound = new Uint8Array([9, 8, 7, 0, 255]);
    socket.frame({
      type: "data",
      ...VERSION,
      channelId: CHANNEL_ID,
      sequence: 0 as never,
      payload: inbound,
    });
    await Promise.resolve();
    expect(received).toEqual([[9, 8, 7, 0, 255]]);
  });

  it("offers minor 3 and emits later frames at the relay-selected minor 3", () => {
    const { engine, socket } = create();
    socket.open();
    const auth = decodeRelayFrame(socket.sent[0]!);
    expect(auth.ok && auth.value.type === "auth" ? auth.value.protocolMinor : undefined).toBe(3);
    socket.frame({ type: "ready", ...VERSION_3, limits: RELAY_INITIAL_LIMITS });
    socket.frame({
      type: "channel.open",
      ...VERSION_3,
      channelId: CHANNEL_ID,
      capability: "ryco.rpc",
      effectiveRole: "operator",
    });
    socket.frame({ type: "channel.accept", ...VERSION_3, channelId: CHANNEL_ID });

    engine.send(new TextEncoder().encode('{"minor":3}'));

    const data = sentFrames(socket).findLast((frame) => frame.type === "data");
    expect(data?.protocolMinor).toBe(3);
  });

  it("closes immediately when the authenticated relay revokes this enrollment", () => {
    const handlers = callbacks();
    const { socket } = create(handlers);
    socket.open();
    socket.frame({ type: "ready", ...VERSION_3, limits: RELAY_INITIAL_LIMITS });
    socket.frame({
      type: "e2ee.enrollment-revoked",
      ...VERSION_3,
      enrollmentId: `enr_${"e".repeat(22)}`,
      enrollmentRevision: 2,
      accountAuthEpoch: 3,
      deviceAuthEpoch: 4,
    });

    expect(handlers.onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "revoked", retryable: false, closeReason: "revoked" }),
    );
  });

  it("advertises chunk support on fitting outbound RPC messages", () => {
    const { engine, socket } = create();
    authenticate(socket);
    const outbound = new TextEncoder().encode('{"request":true}');

    engine.send(outbound);

    const data = sentFrames(socket).findLast((frame) => frame.type === "data");
    expect(data?.type).toBe("data");
    if (data?.type !== "data") return;
    expect(stripRelayChunkCapabilityPrelude(data.payload)).toEqual({
      advertised: true,
      message: outbound,
    });
  });

  it("does not send chunks before the peer advertises support", () => {
    const handlers = callbacks();
    const { engine, socket } = create(handlers);
    authenticate(
      socket,
      RelayLimits.make({
        ...RELAY_INITIAL_LIMITS,
        maxControlFrameBytes: 1_024,
        maxDataChunkBytes: 1_024,
        maxQueuedBytes: 8_192,
      }),
    );
    const before = sentFrames(socket).filter((frame) => frame.type === "data").length;

    expect(() => engine.send(new Uint8Array(1_025))).toThrow();
    expect(sentFrames(socket).filter((frame) => frame.type === "data")).toHaveLength(before);
    expect(handlers.onFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "protocol",
        closeReason: "transfer_limit",
      }),
    );
  });

  it("uses an inbound advertisement to enable a later multi-frame send", async () => {
    const { engine, socket, events } = create();
    const limits = RelayLimits.make({
      ...RELAY_INITIAL_LIMITS,
      maxControlFrameBytes: 1_024,
      maxDataChunkBytes: 1_024,
      maxQueuedBytes: 8_192,
    });
    authenticate(socket, limits);
    const inbound = new TextEncoder().encode('{"response":true}');

    socket.frame({
      type: "data",
      ...VERSION,
      channelId: CHANNEL_ID,
      sequence: 0 as never,
      payload: advertisedPayload(inbound),
    });
    await Promise.resolve();
    expect(events.onData).toHaveBeenCalledWith(inbound);

    engine.send(new Uint8Array(3_000));
    const dataFrames = sentFrames(socket).filter((frame) => frame.type === "data");
    expect(dataFrames.length).toBeGreaterThan(1);
    expect(
      dataFrames.every((frame) => frame.type === "data" && isChunkedPayload(frame.payload)),
    ).toBe(true);
  });

  it("zeroes the ticket-bearing authentication frame after sending it", () => {
    const { socket } = create();
    socket.open();
    const authRef = socket.sentRefs[0]!;
    const authSnapshot = decodeRelayFrame(socket.sent[0]!);
    // The frame that actually went on the wire was a real client auth frame…
    expect(authSnapshot.ok && authSnapshot.value.type === "auth").toBe(true);
    // …and the engine's own buffer holding the ticket is zeroed immediately after.
    expect(authRef.length).toBeGreaterThan(0);
    expect([...authRef].every((byte) => byte === 0)).toBe(true);
  });

  it("spends auth before a synchronous ready response and ignores duplicate open", () => {
    vi.useFakeTimers();
    const handlers = callbacks();
    const { socket } = create(handlers, realTimers());
    socket.onSend = () => {
      socket.onSend = undefined;
      socket.frame({ type: "ready", ...VERSION, limits: RELAY_INITIAL_LIMITS });
    };
    socket.open();
    socket.open();
    expect(socket.sent).toHaveLength(1);
    expect(handlers.onTransportStatus).toHaveBeenLastCalledWith("opening-channel");
    vi.advanceTimersByTime(5_000);
    expect(handlers.onFailure).not.toHaveBeenCalled();
  });

  it("responds to canonical heartbeat pings", () => {
    const { socket } = create();
    authenticate(socket);
    socket.frame({
      type: "ping",
      ...VERSION,
      nonce: new Uint8Array(8).fill(4),
    });
    const response = decodeRelayFrame(socket.sent.at(-1)!);
    expect(response.ok && response.value.type === "pong").toBe(true);
  });

  it("enforces the five-second client authentication deadline", () => {
    vi.useFakeTimers();
    const handlers = callbacks();
    const { socket } = create(handlers, realTimers());
    socket.open();
    vi.advanceTimersByTime(5_000);
    expect(handlers.onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "authentication" }),
    );
  });

  it("does not retain or send the authentication frame after a pre-open close", () => {
    const { engine, socket } = create();
    engine.close();
    socket.open();
    expect(socket.sent).toEqual([]);
    expect(socket.sentRefs).toEqual([]);
  });

  it("honors flow pause and resume with a bounded per-instance queue", () => {
    const { engine, socket } = create();
    authenticate(socket);
    socket.frame({ type: "flow.pause", ...VERSION, channelId: CHANNEL_ID });
    const before = socket.sent.length;

    engine.send(new Uint8Array([1, 2, 3]));
    engine.send(new Uint8Array([4, 5, 6]));
    // Paused: data frames must queue, not go on the wire.
    expect(socket.sent.length).toBe(before);

    socket.frame({ type: "flow.resume", ...VERSION, channelId: CHANNEL_ID });
    // Resumed: the queue flushes in submission order with monotonic sequences.
    expect(socket.sent.length).toBe(before + 2);
    const first = decodeRelayFrame(socket.sent[before]!);
    const second = decodeRelayFrame(socket.sent[before + 1]!);
    expect(
      first.ok && first.value.type === "data"
        ? [[...stripRelayChunkCapabilityPrelude(first.value.payload).message], first.value.sequence]
        : null,
    ).toEqual([[1, 2, 3], 0]);
    expect(
      second.ok && second.value.type === "data"
        ? [
            [...stripRelayChunkCapabilityPrelude(second.value.payload).message],
            second.value.sequence,
          ]
        : null,
    ).toEqual([[4, 5, 6], 1]);
  });

  it("keeps engines independent and rejects duplicate inbound sequences", async () => {
    const firstHandlers = callbacks();
    const secondHandlers = callbacks();
    const first = create(firstHandlers);
    const second = create(secondHandlers);
    authenticate(first.socket);
    authenticate(second.socket);
    first.socket.frame({
      type: "data",
      ...VERSION,
      channelId: CHANNEL_ID,
      sequence: 1 as never,
      payload: new Uint8Array([1]),
    });
    await Promise.resolve();
    expect(firstHandlers.onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "protocol" }),
    );
    expect(second.socket.readyState).toBe(OPEN);
    expect(secondHandlers.onFailure).not.toHaveBeenCalled();
  });

  it("rejects data payloads above the reassembly ceiling", () => {
    const handlers = callbacks();
    const { engine, socket } = create(handlers);
    socket.open();
    socket.frame({
      type: "ready",
      ...VERSION,
      limits: RelayLimits.make({
        ...RELAY_INITIAL_LIMITS,
        maxControlFrameBytes: 1_024,
        maxDataChunkBytes: 1_024,
        maxQueuedBytes: 2_048,
      }),
    });
    socket.frame({
      type: "channel.open",
      ...VERSION,
      channelId: CHANNEL_ID,
      capability: "ryco.rpc",
      effectiveRole: "operator",
    });
    socket.frame({ type: "channel.accept", ...VERSION, channelId: CHANNEL_ID });
    // A message over the per-frame limit is now split rather than refused, so
    // only one above the reassembly ceiling is rejected.
    expect(() => engine.send(new Uint8Array(RELAY_MAX_RPC_MESSAGE_BYTES + 1))).toThrow(
      "RPC payload exceeds the maximum relay message size.",
    );
    expect(handlers.onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "protocol", retryable: false }),
    );
  });

  it("bounds the outbound send queue using negotiated limits", () => {
    const handlers = callbacks();
    const { engine, socket } = create(handlers);
    socket.open();
    socket.frame({
      type: "ready",
      ...VERSION,
      limits: RelayLimits.make({
        ...RELAY_INITIAL_LIMITS,
        maxControlFrameBytes: 1_024,
        maxDataChunkBytes: 1_024,
        maxQueuedBytes: 2_048,
      }),
    });
    socket.frame({
      type: "channel.open",
      ...VERSION,
      channelId: CHANNEL_ID,
      capability: "ryco.rpc",
      effectiveRole: "operator",
    });
    socket.frame({ type: "channel.accept", ...VERSION, channelId: CHANNEL_ID });
    socket.frame({ type: "flow.pause", ...VERSION, channelId: CHANNEL_ID });
    expect(() => engine.send(new Uint8Array(1_024))).toThrow("queue is full");
    expect(handlers.onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "slow-consumer", retryable: true }),
    );
  });

  it("bounds the inbound queue at the negotiated memory limit", () => {
    const handlers = callbacks();
    const { socket } = create(handlers);
    socket.open();
    socket.frame({
      type: "ready",
      ...VERSION,
      limits: RelayLimits.make({
        ...RELAY_INITIAL_LIMITS,
        maxControlFrameBytes: 1_024,
        maxDataChunkBytes: 1_024,
        maxQueuedBytes: 2_048,
      }),
    });
    socket.frame({
      type: "channel.open",
      ...VERSION,
      channelId: CHANNEL_ID,
      capability: "ryco.rpc",
      effectiveRole: "operator",
    });
    socket.frame({ type: "channel.accept", ...VERSION, channelId: CHANNEL_ID });
    // Three in-limit chunks arrive before any microtask drains: 1024, 2048, then
    // the third would push queued bytes past the negotiated maxQueuedBytes.
    for (let sequence = 0; sequence < 3; sequence += 1) {
      socket.frame({
        type: "data",
        ...VERSION,
        channelId: CHANNEL_ID,
        sequence: sequence as never,
        payload: new Uint8Array(1_024),
      });
    }
    expect(handlers.onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "slow-consumer", retryable: true }),
    );
  });

  it("counts partial reassembly against inbound flow control and queue limits", async () => {
    const handlers = callbacks();
    const { socket, events } = create(handlers);
    const limits = RelayLimits.make({
      ...RELAY_INITIAL_LIMITS,
      maxControlFrameBytes: 1_024,
      maxDataChunkBytes: 1_024,
      maxQueuedBytes: 2_048,
    });
    authenticate(socket, limits);
    const chunks = splitRelayMessage(new Uint8Array(3_000), limits.maxDataChunkBytes);

    for (let sequence = 0; sequence < chunks.length; sequence += 1) {
      socket.frame({
        type: "data",
        ...VERSION,
        channelId: CHANNEL_ID,
        sequence: sequence as never,
        payload: chunks[sequence]!,
      });
      await Promise.resolve();
    }

    expect(events.onData).not.toHaveBeenCalled();
    expect(handlers.onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "slow-consumer", retryable: true }),
    );
    expect(sentFrames(socket).some((frame) => frame.type === "flow.pause")).toBe(true);
    expect(sentFrames(socket).some((frame) => frame.type === "flow.resume")).toBe(false);
  });

  it("rejects inbound data delivered before the channel handshake completes", () => {
    const handlers = callbacks();
    const { socket, events } = create(handlers);
    socket.open();
    socket.frame({ type: "ready", ...VERSION, limits: RELAY_INITIAL_LIMITS });
    socket.frame({
      type: "channel.open",
      ...VERSION,
      channelId: CHANNEL_ID,
      capability: "ryco.rpc",
      effectiveRole: "operator",
    });
    // No channel.accept: a peer must not push RPC data during authorization.
    socket.frame({
      type: "data",
      ...VERSION,
      channelId: CHANNEL_ID,
      sequence: 0 as never,
      payload: new Uint8Array([1, 2, 3]),
    });
    expect(handlers.onFailure).toHaveBeenCalledWith(expect.objectContaining({ kind: "protocol" }));
    expect(events.onData).not.toHaveBeenCalled();
  });

  it("rejects outbound sends before the channel handshake completes", () => {
    const { engine, socket } = create();
    socket.open();
    socket.frame({ type: "ready", ...VERSION, limits: RELAY_INITIAL_LIMITS });
    socket.frame({
      type: "channel.open",
      ...VERSION,
      channelId: CHANNEL_ID,
      capability: "ryco.rpc",
      effectiveRole: "operator",
    });
    expect(() => engine.send(new Uint8Array([1, 2, 3]))).toThrow("Relay channel is not open.");
  });

  it("emits the draining transport status on an intentional close", () => {
    const handlers = callbacks();
    const { engine, socket } = create(handlers);
    authenticate(socket);
    handlers.onTransportStatus.mockClear();
    engine.close();
    expect(handlers.onTransportStatus).toHaveBeenCalledWith("draining");
  });

  it.each([
    ["node_offline", "offline", true],
    ["server_draining", "draining", true],
    ["connection_replaced", "replacement", true],
    ["ticket_expired", "authentication", true],
    ["authentication_required", "authentication", false],
    ["node_revoked", "revoked", false],
    ["authorization_failed", "authorization-removed", false],
    ["protocol_unsupported", "incompatible", false],
  ] as const)("classifies %s relay failures", (code, kind, retryable) => {
    const handlers = callbacks();
    const { socket } = create(handlers);
    authenticate(socket);
    socket.frame({
      type: "error",
      ...VERSION,
      code,
      fatal: !retryable,
      ...(code === "protocol_unsupported"
        ? { supported: { protocolMajor: 1, minimumMinor: 0, maximumMinor: 2 } }
        : {}),
    });
    expect(handlers.onFailure).toHaveBeenCalledWith(expect.objectContaining({ kind, retryable }));
    expect(handlers.onSessionStatus).not.toHaveBeenCalledWith("closed");
  });
});

describe("HostedRelayEngine E2EE seams", () => {
  it("builds the channel at channel.accept, from the negotiated limits, before onOpen", () => {
    const { provider, calls, host } = stubProvider();
    const limits = RelayLimits.make({
      ...RELAY_INITIAL_LIMITS,
      maxControlFrameBytes: 1_024,
      maxDataChunkBytes: 1_024,
      maxQueuedBytes: 8_192,
    });
    const { socket, events } = create(callbacks(), realTimers(), provider);

    socket.open();
    socket.frame({ type: "ready", ...VERSION, limits });
    socket.frame({
      type: "channel.open",
      ...VERSION,
      channelId: CHANNEL_ID,
      capability: "ryco.rpc",
      effectiveRole: "operator",
    });
    expect(calls.hosts).toHaveLength(0);
    socket.frame({ type: "channel.accept", ...VERSION, channelId: CHANNEL_ID });

    // The limits are the Hub-asserted ones, adopted verbatim: the engine holds
    // no ceiling of its own and no tier constant of its own.
    expect(host().limits).toEqual(limits);
    // §8.3 elements 2, 13, 14 come from the `channel.open` this endpoint
    // received, so the machine cannot commit to authority the Hub did not
    // present on this channel.
    expect(host().channel).toEqual({
      channelId: CHANNEL_ID,
      capability: "ryco.rpc",
      effectiveRole: "operator",
      relayProtocolMajor: 1,
      relayProtocolMinor: 2,
    });
    expect(calls.hosts).toHaveLength(1);
    // §4.4: the valve opened because THE MACHINE locked a mode, not because the
    // channel was accepted.
    expect(events.onOpen).toHaveBeenCalledOnce();
  });

  it("passes the exact minor-3 account-grant context into the E2EE channel", () => {
    const { provider, host } = stubProvider();
    const { socket } = create(callbacks(), realTimers(), provider);
    const grantDigest = new Uint8Array(32).fill(3);
    const statementDigest = new Uint8Array(32).fill(4);
    const relayTicketId = `rtk_${"t".repeat(22)}`;
    socket.open();
    socket.frame({ type: "ready", ...VERSION_3, limits: RELAY_INITIAL_LIMITS });
    socket.frame({
      type: "channel.open",
      ...VERSION_3,
      channelId: CHANNEL_ID,
      capability: "ryco.rpc",
      effectiveRole: "operator",
      accountGrantContext: [2, relayTicketId, grantDigest, statementDigest],
    });
    socket.frame({ type: "channel.accept", ...VERSION_3, channelId: CHANNEL_ID });

    expect(host().channel.accountGrantContext).toEqual({
      relayTicketId,
      deviceGrantDigest: grantDigest,
      nodeCapabilityStatementDigest: statementDigest,
    });
  });

  it("releases nothing at channel.accept until the machine locks a mode", () => {
    // §4.4: `channel.accept` decides nothing. A channel that is `negotiating`
    // may still lock `e2ee`, lock `legacy`, or close FATAL-PRE without ever
    // releasing anything, so the open event, the status callbacks, and every
    // buffered outbound byte wait for the lock.
    const { provider } = stubProvider({}, null);
    const handlers = callbacks();
    const { engine, socket, events } = create(handlers, realTimers(), provider);
    authenticate(socket);

    expect(events.onOpen).not.toHaveBeenCalled();
    expect(handlers.onTransportStatus).not.toHaveBeenCalledWith("online");
    expect(handlers.onSessionStatus).not.toHaveBeenCalledWith("synchronizing");

    engine.send(new TextEncoder().encode('{"_tag":"Ping"}'));
    expect(sentFrames(socket).some((frame) => frame.type === "data")).toBe(false);
    expect(engine.bufferedAmount).toBeGreaterThan(0);
  });

  it("charges a buffered send for the eventual E2EE envelope layout", () => {
    // §4.4: the buffer is charged "as though the bytes had already been
    // enqueued", against the same aggregate the queue enforces. `admit` IS that
    // charge for the eventual envelope, so the two must agree to the byte — a
    // buffer charged only for plaintext can accept a burst that later fails to
    // drain after the channel locks E2EE.
    const { provider, host } = stubProvider({}, null);
    const { engine, socket } = create(callbacks(), realTimers(), provider);
    authenticate(socket);
    const message = new Uint8Array(4_000).fill(0x7b);

    const reservation = host().admit(E2EE_ENVELOPE_OVERHEAD_BYTES + message.byteLength);
    const reserved = engine.bufferedAmount;
    reservation?.release();
    expect(engine.bufferedAmount).toBe(0);

    engine.send(message);

    expect(reserved).toBeGreaterThan(message.byteLength);
    expect(engine.bufferedAmount).toBe(reserved);
  });

  it("flushes every accepted negotiating send after an E2EE lock", () => {
    const reservations: RelayE2eeReservation[] = [];
    let e2eeHost: RelayE2eeHost | undefined;
    const submit = vi.fn((message: Uint8Array) => {
      const reservation = e2eeHost?.admit(E2EE_ENVELOPE_OVERHEAD_BYTES + message.byteLength);
      if (reservation === undefined) return false;
      reservations.push(reservation);
      return true;
    });
    const provider: RelayE2eeProvider = (host) => {
      e2eeHost = host;
      return {
        intercept: async () => ({ kind: "claimed" }),
        submit,
        beginClose: async () => "refused",
        dispose: () => undefined,
      };
    };
    const limits = RelayLimits.make({
      ...RELAY_INITIAL_LIMITS,
      maxControlFrameBytes: 1_024,
      maxDataChunkBytes: 1_024,
      maxQueuedBytes: 16_384,
    });
    const handlers = callbacks();
    const { engine, socket, events } = create(handlers, realTimers(), provider);
    authenticate(socket, limits);

    let accepted = 0;
    for (; accepted < 1_000; accepted += 1) {
      try {
        engine.send(Uint8Array.of(accepted & 0xff));
      } catch (error) {
        expect(error).toEqual(new Error(RELAY_E2EE_NEGOTIATION_BUFFER_FULL_MESSAGE));
        break;
      }
    }
    expect(accepted).toBeGreaterThan(1);

    e2eeHost?.lockMode("e2ee");

    expect(submit).toHaveBeenCalledTimes(accepted);
    expect(handlers.onFailure).not.toHaveBeenCalled();
    expect(events.onClose).not.toHaveBeenCalled();
    expect(events.onOpen).toHaveBeenCalledOnce();
    for (const reservation of reservations) reservation.release();
    expect(engine.bufferedAmount).toBe(0);
  });

  it("keeps the valve shut when the flush itself failed the channel", () => {
    // §4.4's flush runs BEFORE the release, and it can end the channel: the
    // socket may have died between the mode lock and it. The flush swallows that
    // failure by design — the send path already reported it through `#fail` and
    // has no caller here — so releasing regardless emits `onOpen` after
    // `onClose`, and both facades set their readyState from those two events.
    const { provider, host } = stubProvider({}, null);
    const handlers = callbacks();
    const { engine, socket, events } = create(handlers, realTimers(), provider);
    authenticate(socket);
    engine.send(new TextEncoder().encode('{"first":1}'));
    engine.send(new TextEncoder().encode('{"second":2}'));
    socket.throwOnSend = true;

    host().lockMode("legacy");

    expect(handlers.onFailure).toHaveBeenCalledWith({
      kind: "network",
      retryable: true,
    });
    expect(events.onClose).toHaveBeenCalledOnce();
    expect(events.onOpen).not.toHaveBeenCalled();
    expect(handlers.onTransportStatus).not.toHaveBeenCalledWith("online");
    expect(handlers.onSessionStatus).not.toHaveBeenCalledWith("synchronizing");
  });

  it("stops the flush at the first failure instead of re-queueing the rest", () => {
    // `#fail` has already discarded and zeroized the send queue by this point.
    // Feeding the remaining buffered messages back into the send path builds
    // fresh plaintext chunk copies and pushes them onto a queue nothing zeroizes
    // again — the one thing the §4.4 discard path exists to prevent.
    const { provider, host } = stubProvider({}, null);
    const { engine, socket } = create(callbacks(), realTimers(), provider);
    authenticate(socket);
    for (const message of ['{"first":1}', '{"second":2}', '{"third":3}']) {
      engine.send(new TextEncoder().encode(message));
    }
    const before = socket.sent.length;
    socket.throwOnSend = true;

    host().lockMode("legacy");

    // One attempt, not three, and nothing is left charged against the queue.
    expect(socket.sent.length - before).toBe(1);
    expect(engine.bufferedAmount).toBe(0);
  });

  it("ignores a second lockMode, and one issued after the channel closed", () => {
    // §4.4's transitions are one-way, and `RelayE2eeProvider` is a public seam:
    // a provider that locks twice would otherwise open the valve twice and could
    // re-decide a `legacy` channel as `e2ee`.
    const { provider, host } = stubProvider({}, null);
    const handlers = callbacks();
    const { engine, socket, events } = create(handlers, realTimers(), provider);
    authenticate(socket);

    host().lockMode("legacy");
    host().lockMode("e2ee");

    expect(events.onOpen).toHaveBeenCalledOnce();
    expect(
      handlers.onTransportStatus.mock.calls.filter(([status]) => status === "online"),
    ).toHaveLength(1);
    expect(
      handlers.onSessionStatus.mock.calls.filter(([status]) => status === "synchronizing"),
    ).toHaveLength(1);
    // Still `legacy`: the second lock did not move the mode, so this send is
    // framed rather than handed to the channel.
    engine.send(new TextEncoder().encode('{"after":1}'));
    expect(sentFrames(socket).filter((frame) => frame.type === "data")).toHaveLength(1);

    engine.close();
    host().lockMode("e2ee");
    expect(events.onOpen).toHaveBeenCalledOnce();
  });

  it("flushes the §4.4 buffer ahead of everything the application submits at onOpen", () => {
    // §4.4 flushes first BECAUSE the buffered sends are the ones the application
    // submitted first — and §8.9 makes the first envelope after an `e2ee` lock
    // the client's implicit finish, so a submission from an `onOpen` handler
    // must not be able to overtake them.
    const { provider, host } = stubProvider({}, null);
    const { engine, socket, events } = create(callbacks(), realTimers(), provider);
    authenticate(socket);
    engine.send(new TextEncoder().encode('{"buffered":1}'));
    events.onOpen.mockImplementation(() => engine.send(new TextEncoder().encode('{"onopen":1}')));

    host().lockMode("legacy");

    const payloads = sentFrames(socket).flatMap((frame) =>
      frame.type === "data"
        ? [new TextDecoder().decode(stripRelayChunkCapabilityPrelude(frame.payload).message)]
        : [],
    );
    expect(payloads).toEqual(['{"buffered":1}', '{"onopen":1}']);
  });

  it("fails the channel when a record the channel refused to protect was buffered", async () => {
    // §11.4 forbids a silent drop as firmly as it forbids escalating
    // backpressure, and the flush has no caller to hand a rejection to — so a
    // rejected `emit` must reach `#failE2ee` from the flush exactly as it does
    // from a direct send.
    const { provider, host } = stubProvider({ submit: () => false }, null);
    const handlers = callbacks();
    const { engine, socket } = create(handlers, realTimers(), provider);
    authenticate(socket);
    engine.send(new TextEncoder().encode('{"buffered":1}'));

    host().lockMode("e2ee");
    await flush();

    expect(handlers.onFailure).toHaveBeenCalledWith({
      kind: "protocol",
      retryable: false,
      closeReason: "channel_rejected",
    });
  });

  it("fails the channel when a directly submitted record cannot be protected", async () => {
    const { provider } = stubProvider({
      submit: () => {
        throw new Error("protect failed");
      },
    });
    const handlers = callbacks();
    const { engine, socket } = create(handlers, realTimers(), provider);
    authenticate(socket);

    expect(() => engine.send(new TextEncoder().encode('{"direct":1}'))).toThrow("protect failed");

    expect(handlers.onFailure).toHaveBeenCalledWith({
      kind: "protocol",
      retryable: false,
      closeReason: "channel_rejected",
    });
  });

  it("hands the machine the effective role the channel.open actually presented", () => {
    // §8.3 element 14 is the received `channel.open`'s, and the node
    // reconstructs elements 11–12 from ITS OWN frame: a client that committed to
    // a role the Hub did not grant on this channel would be a context mismatch
    // at best, and a silently escalated commitment at worst.
    const { provider, host } = stubProvider();
    const { socket } = create(callbacks(), realTimers(), provider);
    socket.open();
    socket.frame({ type: "ready", ...VERSION, limits: RELAY_INITIAL_LIMITS });
    socket.frame({
      type: "channel.open",
      ...VERSION,
      channelId: CHANNEL_ID,
      capability: "ryco.rpc",
      effectiveRole: "viewer",
    });
    socket.frame({ type: "channel.accept", ...VERSION, channelId: CHANNEL_ID });

    expect(host().channel.effectiveRole).toBe("viewer");
  });

  it("fails the channel and never opens it when the provider refuses these limits", () => {
    const handlers = callbacks();
    const provider: RelayE2eeProvider = () => {
      throw new RangeError("Relay E2EE session requires a positive plaintext ceiling.");
    };
    const { socket, events } = create(handlers, realTimers(), provider);

    authenticate(socket);

    // §4.5: establishment fails BEFORE the channel is released to the
    // application, and §11.1's reason is non-retryable.
    expect(events.onOpen).not.toHaveBeenCalled();
    expect(handlers.onFailure).toHaveBeenCalledWith({
      kind: "protocol",
      retryable: false,
      closeReason: "channel_rejected",
    });
  });

  it("routes outbound RPC through the channel instead of framing it directly", () => {
    const { provider, calls } = stubProvider();
    const { engine, socket } = create(callbacks(), realTimers(), provider);
    authenticate(socket);
    const before = sentFrames(socket).filter((frame) => frame.type === "data").length;

    engine.send(new Uint8Array([1, 2, 3]));

    expect(calls.emitted).toEqual([new Uint8Array([1, 2, 3])]);
    // Nothing was chunked or queued here: §4.2's whole pipeline is the
    // channel's, including the reservation that precedes the pair assignment.
    expect(sentFrames(socket).filter((frame) => frame.type === "data")).toHaveLength(before);
  });

  it("routes inbound payloads through the channel and delivers only what it returns", async () => {
    const claimed: Uint8Array[] = [];
    const { provider } = stubProvider({
      intercept: async (payload) => {
        claimed.push(Uint8Array.from(payload));
        return { kind: "claimed" };
      },
    });
    const { socket, events } = create(callbacks(), realTimers(), provider);
    authenticate(socket);

    socket.frame({
      type: "data",
      ...VERSION,
      channelId: CHANNEL_ID,
      sequence: 0 as never,
      payload: new Uint8Array([9, 9, 9]),
    });
    await flush();

    expect(claimed).toEqual([new Uint8Array([9, 9, 9])]);
    // A record the channel claims never reaches the RPC parser (§4.3).
    expect(events.onData).not.toHaveBeenCalled();
  });

  it("reserves capacity for every chunk of a record before the record exists", async () => {
    const { provider, host } = stubProvider();
    const limits = RelayLimits.make({
      ...RELAY_INITIAL_LIMITS,
      maxControlFrameBytes: 1_024,
      maxDataChunkBytes: 1_024,
      maxQueuedBytes: 65_536,
    });
    const { engine, socket, events } = create(callbacks(), realTimers(), provider);
    authenticate(socket, limits);
    // Latch peer chunk support, so an oversized record is admissible at all.
    socket.frame({
      type: "data",
      ...VERSION,
      channelId: CHANNEL_ID,
      sequence: 0 as never,
      payload: advertisedPayload(new Uint8Array([1])),
    });
    await flush();
    expect(events.onData).toHaveBeenCalled();

    const reservation = host().admit(3_000);
    if (reservation === undefined) throw new Error("expected an admission");
    // Three chunks of 1024/1024/976 bytes plus per-entry bookkeeping: the
    // reservation is the queue capacity the record will actually spend, and it
    // is visible as backpressure before a single byte is encrypted.
    expect(engine.bufferedAmount).toBe(1_024 + 1_024 + 976 + 3 * 32);

    const before = sentFrames(socket).filter((frame) => frame.type === "data").length;
    expect(reservation.send(new Uint8Array(3_000))).toBe(true);
    expect(sentFrames(socket).filter((frame) => frame.type === "data")).toHaveLength(before + 3);
    expect(engine.bufferedAmount).toBe(0);
    // A spent reservation is spent once.
    expect(reservation.send(new Uint8Array(3_000))).toBe(false);
    reservation.release();
    expect(engine.bufferedAmount).toBe(0);
  });

  it("refuses admission the queue cannot hold, without failing the channel", () => {
    const { provider, host } = stubProvider();
    const limits = RelayLimits.make({
      ...RELAY_INITIAL_LIMITS,
      maxControlFrameBytes: 1_024,
      maxDataChunkBytes: 1_024,
      maxQueuedBytes: 8_192,
    });
    const handlers = callbacks();
    const { engine, socket } = create(handlers, realTimers(), provider);
    authenticate(socket, limits);
    socket.frame({ type: "flow.pause", ...VERSION, channelId: CHANNEL_ID });

    const held: unknown[] = [];
    for (let index = 0; index < 8; index += 1) {
      const reservation = host().admit(1_000);
      if (reservation) held.push(reservation);
    }

    // Backpressure is not a fatal condition: the channel is untouched and the
    // record session sees `e2ee_send_unavailable` rather than a closed channel.
    expect(host().admit(1_000)).toBeUndefined();
    expect(handlers.onFailure).not.toHaveBeenCalled();
    expect(engine.bufferedAmount).toBeGreaterThan(0);
  });

  it("bounds rapid established submissions in the aggregate reservation ceiling", () => {
    const reservations: RelayE2eeReservation[] = [];
    const provider: RelayE2eeProvider = (host) => {
      host.lockMode("e2ee");
      return {
        intercept: async () => ({ kind: "claimed" }),
        submit: (message) => {
          const reservation = host.admit(E2EE_ENVELOPE_OVERHEAD_BYTES + message.byteLength);
          if (reservation === undefined) return false;
          reservations.push(reservation);
          return true;
        },
        beginClose: async () => "refused",
        dispose: () => undefined,
      };
    };
    const limits = RelayLimits.make({
      ...RELAY_INITIAL_LIMITS,
      maxControlFrameBytes: 1_024,
      maxDataChunkBytes: 1_024,
      maxQueuedBytes: 8_192,
    });
    const handlers = callbacks();
    const { engine, socket, events } = create(handlers, realTimers(), provider);
    authenticate(socket, limits);

    let refused = false;
    for (let index = 0; index < 32; index += 1) {
      try {
        engine.send(new Uint8Array(900).fill(index));
      } catch (error) {
        expect(error).toEqual(new Error(RELAY_E2EE_SEND_UNAVAILABLE_MESSAGE));
        refused = true;
        break;
      }
    }

    expect(refused).toBe(true);
    expect(reservations.length).toBeGreaterThan(0);
    expect(engine.bufferedAmount).toBeLessThanOrEqual(
      limits.maxQueuedBytes - limits.maxControlFrameBytes,
    );
    expect(handlers.onFailure).not.toHaveBeenCalled();
    expect(events.onClose).not.toHaveBeenCalled();

    for (const reservation of reservations) reservation.release();
    expect(engine.bufferedAmount).toBe(0);
  });

  it("accounts chunked established submissions through flow pause and slow socket ownership", async () => {
    const provider: RelayE2eeProvider = (host) => {
      host.lockMode("e2ee");
      return {
        intercept: async (payload) => ({ kind: "rpc", message: payload }),
        submit: (message) => {
          const envelope = new Uint8Array(E2EE_ENVELOPE_OVERHEAD_BYTES + message.byteLength);
          const reservation = host.admit(envelope.byteLength);
          return reservation?.send(envelope) ?? false;
        },
        beginClose: async () => "refused",
        dispose: () => undefined,
      };
    };
    const limits = RelayLimits.make({
      ...RELAY_INITIAL_LIMITS,
      maxControlFrameBytes: 1_024,
      maxDataChunkBytes: 1_024,
      maxQueuedBytes: 8_192,
    });
    const handlers = callbacks();
    const { engine, socket, events } = create(handlers, realTimers(), provider);
    authenticate(socket, limits);
    socket.frame({
      type: "data",
      ...VERSION,
      channelId: CHANNEL_ID,
      sequence: 0 as never,
      payload: advertisedPayload(new Uint8Array([1])),
    });
    await flush();
    expect(events.onData).toHaveBeenCalled();
    socket.frame({ type: "flow.pause", ...VERSION, channelId: CHANNEL_ID });

    engine.send(new Uint8Array(3_000));
    const plan = planRelayMessage(3_000 + E2EE_ENVELOPE_OVERHEAD_BYTES, {
      maxChunkBytes: limits.maxDataChunkBytes,
      maxMessageBytes: limits.maxQueuedBytes - limits.maxControlFrameBytes,
      peerSupportsChunking: true,
    });
    if (plan.kind === "error") throw new Error("expected a chunk plan");
    expect(engine.bufferedAmount).toBe(
      plan.payloadBytes.reduce((total, payloadBytes) => total + payloadBytes + 32, 0),
    );
    engine.send(new Uint8Array(3_000));
    expect(engine.bufferedAmount).toBe(
      plan.payloadBytes.reduce((total, payloadBytes) => total + payloadBytes + 32, 0) * 2,
    );
    expect(() => engine.send(new Uint8Array(3_000))).toThrow(RELAY_E2EE_SEND_UNAVAILABLE_MESSAGE);
    expect(handlers.onFailure).not.toHaveBeenCalled();

    socket.frame({ type: "flow.resume", ...VERSION, channelId: CHANNEL_ID });
    expect(engine.bufferedAmount).toBe(0);

    socket.bufferedAmount = limits.maxQueuedBytes - limits.maxControlFrameBytes;
    expect(() => engine.send(new Uint8Array(16))).toThrow(RELAY_E2EE_SEND_UNAVAILABLE_MESSAGE);
    expect(handlers.onFailure).not.toHaveBeenCalled();
    socket.bufferedAmount = 0;
    expect(() => engine.send(new Uint8Array(16))).not.toThrow();
    expect(engine.bufferedAmount).toBe(0);

    const maximum = e2eeChannelSizeBudget(limits).plaintextCeiling;
    expect(() => engine.send(new Uint8Array(maximum))).toThrow(RELAY_E2EE_SEND_UNAVAILABLE_MESSAGE);
    expect(handlers.onFailure).not.toHaveBeenCalled();
  });

  it("invalidates pending reservations so late close-race settlement cannot go negative", () => {
    const { provider, host } = stubProvider();
    const { engine, socket } = create(callbacks(), realTimers(), provider);
    authenticate(socket);
    const reservations = Array.from({ length: 8 }, () => host().admit(512)).filter(
      (value): value is RelayE2eeReservation => value !== undefined,
    );
    expect(reservations).toHaveLength(8);
    expect(engine.bufferedAmount).toBeGreaterThan(0);

    host().close();
    expect(engine.bufferedAmount).toBe(0);

    reservations.forEach((reservation, index) => {
      if (index % 2 === 0) reservation.release();
      else expect(reservation.send(new Uint8Array(512))).toBe(false);
    });
    expect(engine.bufferedAmount).toBe(0);
  });

  it("keeps a reentrant control reservation inert after its close invalidates ownership", () => {
    let reservation: RelayE2eeReservation | undefined;
    const provider: RelayE2eeProvider = (host) => {
      host.lockMode("e2ee");
      return {
        intercept: async () => ({ kind: "claimed" }),
        submit: () => true,
        beginClose: async () => {
          reservation = host.admit(64);
          host.close();
          return "opened";
        },
        dispose: () => undefined,
      };
    };
    const { engine, socket } = create(callbacks(), realTimers(), provider);
    authenticate(socket);

    engine.close();
    expect(engine.bufferedAmount).toBe(0);
    reservation?.release();
    expect(reservation?.send(new Uint8Array(64))).toBe(false);
    expect(engine.bufferedAmount).toBe(0);
  });

  it("reports the assembler's partial reassembly to the channel before resetting it", async () => {
    const { provider, calls } = stubProvider();
    const limits = RelayLimits.make({
      ...RELAY_INITIAL_LIMITS,
      maxControlFrameBytes: 1_024,
      maxDataChunkBytes: 1_024,
      maxQueuedBytes: 65_536,
    });
    const { engine, socket } = create(callbacks(), realTimers(), provider);
    authenticate(socket, limits);
    const chunks = splitRelayMessage(new Uint8Array(3_000), limits.maxDataChunkBytes);
    socket.frame({
      type: "data",
      ...VERSION,
      channelId: CHANNEL_ID,
      sequence: 0 as never,
      payload: chunks[0]!,
    });
    await flush();

    engine.close();

    // §10.4: a partial reassembly held when the channel ends IS truncation, and
    // the verdict is recorded from the assembler's own state rather than
    // inferred after it has been reset.
    expect(calls.disposed).toEqual([{ incompleteReassembly: true }]);
  });

  it("holds the outer channel.close until the channel asks for it", async () => {
    let release: (() => void) | undefined;
    const { provider, calls, host } = stubProvider({
      beginClose: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return "opened";
      },
    });
    const handlers = callbacks();
    const { engine, socket } = create(handlers, realTimers(), provider);
    authenticate(socket);

    engine.close();

    // §10.3 lower bound: enqueueing one's own final records is not delivering
    // them, so the outer frame waits for the channel's own decision.
    expect(handlers.onTransportStatus).toHaveBeenCalledWith("draining");
    expect(sentFrames(socket).some((frame) => frame.type === "channel.close")).toBe(false);

    host().close();
    release?.();
    await Promise.resolve();

    expect(sentFrames(socket).some((frame) => frame.type === "channel.close")).toBe(true);
    expect(calls.disposed).toEqual([{ incompleteReassembly: false }]);
  });

  it("retries a close the send queue refused instead of latching it away", async () => {
    // §11.4: a refused `E2EEClose` opened no close phase — no pair consumed, no
    // wire record, no `T_CLOSE` wait armed — so nothing bounds the channel and
    // nothing will ever emit the outer close on its own. Latching on the attempt
    // rather than on its outcome escalates ordinary backpressure into a channel
    // that can never be closed cleanly, with its §6.5 secrets never erased.
    let refuse = true;
    const { provider, calls, host } = stubProvider({
      beginClose: async () => {
        calls.beginCloseCalls += 1;
        if (refuse) return "refused";
        host.close();
        return "opened";
      },
    });
    const handlers = callbacks();
    const { engine, socket } = create(handlers, realTimers(), provider);
    authenticate(socket);

    engine.close();
    await flush();
    engine.close();
    await flush();
    expect(calls.beginCloseCalls).toBe(2);
    expect(sentFrames(socket).some((frame) => frame.type === "channel.close")).toBe(false);
    expect(calls.disposed).toEqual([]);

    refuse = false;
    engine.close();
    await flush();

    expect(calls.beginCloseCalls).toBe(3);
    expect(sentFrames(socket).some((frame) => frame.type === "channel.close")).toBe(true);
    expect(calls.disposed).toEqual([{ incompleteReassembly: false }]);
  });

  it("re-attempts a refused close when the outbound queue drains", async () => {
    // The capacity a §11.4 refusal was waiting for comes back at the drain, not
    // at a caller: the application asked once and is owed the close.
    let refuse = true;
    const { provider, calls, host } = stubProvider({
      beginClose: async () => {
        calls.beginCloseCalls += 1;
        if (refuse) return "refused";
        host.close();
        return "opened";
      },
    });
    const limits = RelayLimits.make({
      ...RELAY_INITIAL_LIMITS,
      maxControlFrameBytes: 1_024,
      maxDataChunkBytes: 1_024,
      maxQueuedBytes: 65_536,
    });
    const { engine, socket } = create(callbacks(), realTimers(), provider);
    authenticate(socket, limits);
    socket.frame({ type: "flow.pause", ...VERSION, channelId: CHANNEL_ID });
    const reservation = host().admit(64);
    if (reservation === undefined) throw new Error("expected an admission");
    expect(reservation.send(new Uint8Array(64))).toBe(true);

    engine.close();
    await flush();
    expect(calls.beginCloseCalls).toBe(1);
    refuse = false;

    socket.frame({ type: "flow.resume", ...VERSION, channelId: CHANNEL_ID });
    await flush();

    expect(calls.beginCloseCalls).toBe(2);
    expect(sentFrames(socket).some((frame) => frame.type === "channel.close")).toBe(true);
    expect(engine.bufferedAmount).toBe(0);
  });

  it("puts every queued record on the socket before the outer channel.close", async () => {
    // §10.3 and §11.3: `#finish` discards whatever is still queued and the close
    // control frame is written straight to the socket, so a close emitted over a
    // non-empty queue destroys the record the peer needs to verify the exchange
    // — after the sequence pair for it was spent. The node does the same thing
    // from the other side, and a protocol that must get a final record onto the
    // wire before the outer close cannot be built otherwise.
    const { provider, host } = stubProvider();
    const limits = RelayLimits.make({
      ...RELAY_INITIAL_LIMITS,
      maxControlFrameBytes: 1_024,
      maxDataChunkBytes: 1_024,
      maxQueuedBytes: 4_096,
    });
    const { engine, socket } = create(callbacks(), realTimers(), provider);
    authenticate(socket, limits);
    const reservation = host().admit(256);
    if (reservation === undefined) throw new Error("expected an admission");
    // The socket backs up between admission and transmission, so the flush
    // defers behind its own timer and the record is still queued at the close.
    socket.bufferedAmount = limits.maxQueuedBytes;
    expect(reservation.send(new Uint8Array(256).fill(0xab))).toBe(true);
    expect(sentFrames(socket).some((frame) => frame.type === "data")).toBe(false);

    engine.close();

    const frames = sentFrames(socket);
    const data = frames.findIndex((frame) => frame.type === "data");
    const close = frames.findIndex((frame) => frame.type === "channel.close");
    expect(data).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(data);
  });

  it("refuses a second channel.accept instead of building a second channel over the first", () => {
    // §4.4 creates the channel's machine at `channel.accept` and destroys it
    // when the channel closes. A repeat from an untrusted Hub would leave the
    // first machine holding live §6.5 secrets nobody erases and close timers
    // armed on a channel nothing holds, able to tear down its replacement.
    const { provider, calls } = stubProvider();
    const handlers = callbacks();
    const { socket, events } = create(handlers, realTimers(), provider);
    authenticate(socket);

    socket.frame({ type: "channel.accept", ...VERSION, channelId: CHANNEL_ID });

    expect(calls.hosts).toHaveLength(1);
    expect(events.onOpen).toHaveBeenCalledOnce();
    expect(handlers.onFailure).toHaveBeenCalledWith({
      kind: "protocol",
      retryable: false,
      closeReason: "channel_rejected",
    });
    expect(calls.disposed).toEqual([{ incompleteReassembly: false }]);
  });

  it("ends the linger on the peer's reasonless channel.close without reporting a failure", async () => {
    // §10.3: observing the peer's `channel.close` is one of the three events
    // that end the linger, and a reasonless one is the relay protocol's orderly
    // close — §11.1 gives every E2EE-fatal condition a reason. Losing the
    // channel here "changes the peer's verdict, never this endpoint's, and MUST
    // NOT be reported as a failure of this endpoint's exchange".
    let release: (() => void) | undefined;
    const { provider, calls } = stubProvider({
      beginClose: async () => {
        calls.beginCloseCalls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return "opened";
      },
    });
    const handlers = callbacks();
    const { engine, socket, events } = create(handlers, realTimers(), provider);
    authenticate(socket);
    engine.close();
    await flush();

    socket.frame({ type: "channel.close", ...VERSION, channelId: CHANNEL_ID });
    release?.();
    await flush();

    expect(handlers.onFailure).not.toHaveBeenCalled();
    expect(events.onError).not.toHaveBeenCalled();
    expect(events.onClose).toHaveBeenCalledWith(1000, "closed");
    expect(handlers.onSessionStatus).toHaveBeenCalledWith("closed");
    // The channel is still told the channel ended, so §10.4 can record it.
    expect(calls.disposed).toEqual([{ incompleteReassembly: false }]);
  });

  it("still fails on a peer close that names a reason", () => {
    // §11.1 gives every E2EE-fatal condition a reason, so a named close is a
    // rejection and keeps the reason's own classification.
    const { provider } = stubProvider();
    const handlers = callbacks();
    const { socket } = create(handlers, realTimers(), provider);
    authenticate(socket);

    socket.frame({
      type: "channel.close",
      ...VERSION,
      channelId: CHANNEL_ID,
      reason: "node_offline",
    });

    expect(handlers.onFailure).toHaveBeenCalledWith({
      kind: "offline",
      retryable: true,
      closeReason: "node_offline",
    });
  });

  it("delivers inbound payloads to the channel in arrival order", async () => {
    // §9.2 compares each envelope against ONE expected pair, so two overlapping
    // `unprotect` calls race that comparison — and the close machine's §10.1
    // passed-through comparison runs against a next-send another interception is
    // in the middle of moving. The engine can complete several messages in a
    // single synchronous drain, so the ordering is the engine's to hold.
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const { provider } = stubProvider({
      intercept: async (payload) => {
        const label = String(payload[0]);
        order.push(`enter:${label}`);
        if (releaseFirst === undefined && label === "1") {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        order.push(`leave:${label}`);
        return { kind: "rpc", message: payload };
      },
    });
    const { socket, events } = create(callbacks(), realTimers(), provider);
    authenticate(socket);

    socket.frame({
      type: "data",
      ...VERSION,
      channelId: CHANNEL_ID,
      sequence: 0 as never,
      payload: new Uint8Array([1]),
    });
    socket.frame({
      type: "data",
      ...VERSION,
      channelId: CHANNEL_ID,
      sequence: 1 as never,
      payload: new Uint8Array([2]),
    });
    await flush();
    expect(order).toEqual(["enter:1"]);

    releaseFirst?.();
    await flush();

    expect(order).toEqual(["enter:1", "leave:1", "enter:2", "leave:2"]);
    expect(events.onData.mock.calls.map(([bytes]) => bytes[0])).toEqual([1, 2]);
  });

  it("takes the channel's fatal failure verbatim onto the outer close", () => {
    const { provider, host } = stubProvider();
    const handlers = callbacks();
    const { socket } = create(handlers, realTimers(), provider);
    authenticate(socket);

    host().close(relayE2eeFailure("fatal_post_key"));

    expect(handlers.onFailure).toHaveBeenCalledWith({
      kind: "protocol",
      retryable: false,
      closeReason: "channel_rejected",
    });
    // §11.1: the detecting endpoint emits the outer `channel.close` WITH
    // `channel_rejected` after completing the §11.3 procedure. The relay-level
    // failure path sends no frame at all, so the E2EE path cannot inherit it.
    expect(sentFrames(socket).find((frame) => frame.type === "channel.close")).toMatchObject({
      reason: "channel_rejected",
    });
  });

  it("gives an unresolved §4.4 attempt the same wire close and a retryable disposition", () => {
    const { provider, host } = stubProvider();
    const handlers = callbacks();
    const { socket } = create(handlers, realTimers(), provider);
    authenticate(socket);

    host().close(relayE2eeUnresolvedAttemptFailure());

    // §11.5's uniform observable: byte-identical on the wire to every other
    // pre-key close, so nothing about the local cause is measurable.
    expect(sentFrames(socket).find((frame) => frame.type === "channel.close")).toMatchObject({
      reason: "channel_rejected",
    });
    expect(closeReason(relayE2eeFailure("fatal_pre_key"))).toBe(
      closeReason(relayE2eeUnresolvedAttemptFailure()),
    );
    // …and the local disposition differs, because nothing failed a check here.
    // A non-retryable close drives `transportStatus` to `terminal-failure`,
    // which stops reconnection entirely; a warm-up race must cost one channel.
    expect(relayE2eeFailure("fatal_pre_key").retryable).toBe(false);
    expect(handlers.onFailure).toHaveBeenCalledWith({
      kind: "protocol",
      retryable: true,
      closeReason: "channel_rejected",
    });
  });

  it("releases no plaintext when an unresolved provider closes during channel acceptance", () => {
    const provider: RelayE2eeProvider = (host) => {
      host.close(relayE2eeUnresolvedAttemptFailure());
      return {
        intercept: async () => ({ kind: "rejected" }),
        submit: () => false,
        beginClose: async () => "refused",
        dispose: () => undefined,
      };
    };
    const handlers = callbacks();
    const { engine, socket, events } = create(handlers, realTimers(), provider);

    authenticate(socket);

    expect(events.onOpen).not.toHaveBeenCalled();
    expect(() => engine.send(new TextEncoder().encode('{"mustNotEscape":true}'))).toThrow(
      "Relay channel is not open.",
    );
    expect(sentFrames(socket).filter((frame) => frame.type === "data")).toHaveLength(0);
    expect(sentFrames(socket).find((frame) => frame.type === "channel.close")).toMatchObject({
      reason: "channel_rejected",
    });
  });

  it("reports established E2EE admission refusal synchronously without failing the channel", () => {
    const { provider } = stubProvider({ submit: () => false });
    const handlers = callbacks();
    const { engine, socket, events } = create(handlers, realTimers(), provider);
    authenticate(socket);

    expect(() => engine.send(new TextEncoder().encode('{"_tag":"Ping"}'))).toThrow(
      RELAY_E2EE_SEND_UNAVAILABLE_MESSAGE,
    );
    expect(handlers.onFailure).not.toHaveBeenCalled();
    expect(events.onClose).not.toHaveBeenCalled();
  });
});

function closeReason(failure: { readonly closeReason?: string }): string | undefined {
  return failure.closeReason;
}
