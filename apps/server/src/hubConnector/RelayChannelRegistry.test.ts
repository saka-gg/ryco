import { describe, expect, it } from "vite-plus/test";

import type {
  RelayChannelId,
  RelayChannelOpenFrame,
  RelayEffectiveRole,
  RelayFrame,
  RelayLimits,
  RelayProtocolVersion,
} from "@ryco/contracts/relay";
import { RELAY_MAX_RPC_MESSAGE_BYTES } from "@ryco/contracts/relay";
import { decodeRelayFrame } from "@ryco/shared/relayCodec";
import { stripRelayChunkCapabilityPrelude } from "@ryco/shared/relayMessageChunks";

import {
  RelayChannelProtocolError,
  RelayChannelRegistry,
  type RelayChannelSendHandle,
  type RelayChannelSessionFactory,
  type RelayConnectionIdentity,
  type RelayRpcChannelSession,
} from "./RelayChannelRegistry.ts";
import { RelaySendQueue } from "./RelaySendQueue.ts";

type ChannelOpenInput = Parameters<RelayChannelSessionFactory["open"]>[0];

const channelA = `ch_${"A".repeat(22)}` as RelayChannelId;
const channelB = `ch_${"B".repeat(22)}` as RelayChannelId;
const version = { protocolMajor: 1, protocolMinor: 2 } as const;
const limits: RelayLimits = {
  maxControlFrameBytes: 1_024,
  maxDataChunkBytes: 1_024,
  maxQueuedBytes: 4_096,
  maxChannels: 2,
  heartbeatIntervalMs: 20_000,
  deadConnectionTimeoutMs: 45_000,
  authenticationDeadlineMs: 5_000,
};

const openFrame = (
  channelId: RelayChannelId,
  effectiveRole: RelayEffectiveRole = "operator",
): RelayChannelOpenFrame => ({
  type: "channel.open",
  ...version,
  channelId,
  capability: "ryco.rpc",
  effectiveRole,
});

function decodeAll(sent: Uint8Array[]): RelayFrame[] {
  return sent.map((bytes) => {
    const decoded = decodeRelayFrame(bytes);
    if (!decoded.ok) throw new Error(decoded.error.code);
    return decoded.value;
  });
}

function harness(
  options: {
    readonly connection?: () => RelayConnectionIdentity | undefined;
    readonly onAccepted?: (input: ChannelOpenInput) => void | Promise<void>;
    readonly protocol?: RelayProtocolVersion;
  } = {},
) {
  const sent: Uint8Array[] = [];
  const socket = {
    bufferedAmount: 0,
    send: (bytes: Uint8Array) => sent.push(Uint8Array.from(bytes)),
  };
  let fatalCalls = 0;
  const sendQueue = new RelaySendQueue(socket, limits);
  const received = new Map<string, Uint8Array[]>();
  const opens: ChannelOpenInput[] = [];
  const sessions = new Map<
    string,
    RelayRpcChannelSession & {
      queued: number;
      closes: number;
      chunkSupport: boolean;
      accept: boolean;
      send: RelayChannelSendHandle;
      requestClose: ChannelOpenInput["close"];
    }
  >();
  const registry = new RelayChannelRegistry({
    limits,
    protocol: options.protocol ?? version,
    sendQueue,
    factory: {
      open: async (input) => {
        opens.push(input);
        const { channelId, send } = input;
        const values: Uint8Array[] = [];
        received.set(channelId as string, values);
        const session = {
          queued: 0,
          closes: 0,
          chunkSupport: false,
          accept: true,
          send,
          requestClose: input.close,
          receive: async (bytes: Uint8Array) => {
            values.push(Uint8Array.from(bytes));
            return session.accept;
          },
          queuedBytes: async () => session.queued,
          supportsChunkedMessages: () => session.chunkSupport,
          close: async () => {
            session.closes += 1;
          },
          ...(options.onAccepted === undefined
            ? {}
            : { onAccepted: () => options.onAccepted?.(input) }),
        };
        sessions.set(channelId as string, session);
        return session;
      },
    },
    onFatal: () => {
      fatalCalls += 1;
    },
    // Deliberately no `onOutboundReady`: every ordering guarantee asserted
    // below must hold without the owner wiring a flush at all.
    ...(options.connection === undefined ? {} : { connection: options.connection }),
  });
  return {
    registry,
    sendQueue,
    sent,
    received,
    opens,
    sessions,
    socket,
    fatalCalls: () => fatalCalls,
  };
}

describe("RelayChannelRegistry", () => {
  it("explicitly accepts authorized channels and forwards opaque ordered bytes", async () => {
    const { registry, sendQueue, sent, received, sessions } = harness();
    await registry.handle(openFrame(channelA));
    sendQueue.flush();
    expect(decodeAll(sent)[0]).toMatchObject({ type: "channel.accept", channelId: channelA });
    const payload = Uint8Array.of(0, 255, 0x7b, 0x80);
    await registry.handle({
      type: "data",
      ...version,
      channelId: channelA,
      sequence: 0 as never,
      payload,
    });
    expect(received.get(channelA as string)).toEqual([payload]);

    expect(sessions.get(channelA as string)!.send(Uint8Array.of(9, 0, 8))).toEqual({
      accepted: true,
    });
    sendQueue.flush();
    const output = decodeAll(sent).at(-1);
    expect(output).toMatchObject({ type: "data", channelId: channelA, sequence: 0 });
    expect(
      output?.type === "data" && stripRelayChunkCapabilityPrelude(output.payload).message,
    ).toEqual(Uint8Array.of(9, 0, 8));
  });

  it("closes an oversized outbound frame as transfer_limit, not slow_consumer", async () => {
    // Regression: a response larger than maxDataChunkBytes and a genuinely full
    // send queue used to collapse into one close reason. Reporting the first as
    // `slow_consumer` makes an application bug -- this node emitted a frame over
    // the negotiated limit -- read as a network problem in relay telemetry, and
    // that is why oversized RPC responses went undiagnosed. The inbound path has
    // always called the identical condition `transfer_limit`.
    const { registry, sendQueue, sent, sessions } = harness();
    await registry.handle(openFrame(channelA));
    sendQueue.flush();
    sent.length = 0;

    // A message over the per-frame limit is now SPLIT rather than refused, so
    // only one above the reassembly ceiling is rejected — and when it is, the
    // reason must name the real cause.
    const session = sessions.get(channelA as string)!;
    expect(session.send(new Uint8Array(RELAY_MAX_RPC_MESSAGE_BYTES + 1))).toEqual({
      accepted: false,
      refusal: "message_too_large",
    });

    await Promise.resolve();
    sendQueue.flush();
    const close = decodeAll(sent).find((frame) => frame.type === "channel.close");
    expect(close).toMatchObject({ channelId: channelA, reason: "transfer_limit" });
    expect(close?.type === "channel.close" && close.reason).not.toBe("slow_consumer");
  });

  it("splits a message larger than one data frame instead of killing the channel", async () => {
    // The defect this fixes: one RPC response was unconditionally one relay
    // frame, so any response over the limit destroyed the channel. Repositories
    // of a few thousand files already exceeded it.
    const { registry, sendQueue, sent, sessions } = harness();
    await registry.handle(openFrame(channelA));
    sendQueue.flush();
    sent.length = 0;

    // Two frames' worth. Each frame also costs ~101 bytes of CBOR overhead
    // against the 4 KiB queue budget, so a larger message would trip the queue
    // rather than exercise the split.
    const message = new Uint8Array(limits.maxDataChunkBytes * 2 - 64);
    for (let i = 0; i < message.byteLength; i += 1) message[i] = i % 251;
    const session = sessions.get(channelA as string)!;
    session.chunkSupport = true;
    expect(session.send(message)).toEqual({ accepted: true });
    sendQueue.flush();

    const frames = decodeAll(sent);
    expect(frames.every((frame) => frame.type === "data")).toBe(true);
    expect(frames.length).toBeGreaterThan(1);
    // Every frame stays inside the negotiated limit, and the channel survives.
    for (const frame of frames) {
      expect(frame.type === "data" && frame.payload.byteLength).toBeLessThanOrEqual(
        limits.maxDataChunkBytes,
      );
    }
    expect(registry.has(channelA)).toBe(true);
    // Sequence numbers advance once per FRAME, not once per message.
    expect(frames.map((frame) => (frame.type === "data" ? frame.sequence : -1))).toEqual(
      frames.map((_, index) => index),
    );
  });

  it("closes with transfer_limit instead of sending chunks before peer support", async () => {
    const { registry, sendQueue, sent, sessions } = harness();
    await registry.handle(openFrame(channelA));
    sendQueue.flush();
    sent.length = 0;

    const message = new Uint8Array(limits.maxDataChunkBytes + 1);
    expect(sessions.get(channelA as string)!.send(message)).toEqual({
      accepted: false,
      refusal: "peer_unsupported",
    });
    await Promise.resolve();
    sendQueue.flush();

    const frames = decodeAll(sent);
    expect(frames).toEqual([
      expect.objectContaining({
        type: "channel.close",
        channelId: channelA,
        reason: "transfer_limit",
      }),
    ]);
  });

  it("rejects unsupported and duplicate channels without constructing extra sessions", async () => {
    const { registry, sendQueue, sent, sessions } = harness();
    await registry.handle(openFrame(channelA, "viewer"));
    await registry.handle(openFrame(channelA, "owner"));
    await registry.handle({
      type: "channel.open",
      ...version,
      channelId: channelB,
      effectiveRole: "operator",
    });
    sendQueue.flush();
    expect(sessions).toHaveLength(1);
    expect(decodeAll(sent).map((frame) => frame.type)).toEqual([
      "channel.accept",
      "channel.reject",
      "channel.reject",
    ]);
  });

  it("closes sequence violations and slow consumers per channel only", async () => {
    const { registry, sendQueue, sent, sessions } = harness();
    await registry.handle(openFrame(channelA));
    await registry.handle(openFrame(channelB));
    await registry.handle({
      type: "data",
      ...version,
      channelId: channelA,
      sequence: 1 as never,
      payload: Uint8Array.of(1),
    });
    expect(registry.has(channelA)).toBe(false);
    expect(registry.has(channelB)).toBe(true);
    expect(sessions.get(channelA as string)!.closes).toBe(1);

    const sessionB = sessions.get(channelB as string)!;
    sessionB.queued = 1_200;
    await registry.handle({
      type: "data",
      ...version,
      channelId: channelB,
      sequence: 0 as never,
      payload: new Uint8Array(1_000),
    });
    // A paused channel now gets enough grace for one whole message to land,
    // since a message can be many frames. Drive past that allowance.
    const allowance = Math.ceil(limits.maxQueuedBytes / limits.maxDataChunkBytes) + 1;
    for (let sequence = 1; sequence <= allowance + 1; sequence += 1) {
      await registry.handle({
        type: "data",
        ...version,
        channelId: channelB,
        sequence: sequence as never,
        payload: Uint8Array.of(2),
      });
    }
    expect(registry.has(channelB)).toBe(false);
    expect(sessionB.closes).toBe(1);
    sendQueue.flush();
    expect(
      decodeAll(sent).some(
        (frame) => frame.type === "channel.close" && frame.reason === "slow_consumer",
      ),
    ).toBe(true);
  });

  it("pauses outbound data independently and cleans every channel on shutdown", async () => {
    const { registry, sendQueue, sent, sessions } = harness();
    await registry.handle(openFrame(channelA));
    await registry.handle(openFrame(channelB));
    sendQueue.flush();
    sent.length = 0;
    await registry.handle({ type: "flow.pause", ...version, channelId: channelA });
    sessions.get(channelA as string)!.send(Uint8Array.of(1));
    sessions.get(channelB as string)!.send(Uint8Array.of(2));
    sendQueue.flush();
    expect(decodeAll(sent)).toHaveLength(1);
    expect(decodeAll(sent)[0]).toMatchObject({ type: "data", channelId: channelB });
    await registry.closeAll();
    expect(registry.size).toBe(0);
    expect([...sessions.values()].every((session) => session.closes === 1)).toBe(true);
    expect(sendQueue.queuedBytes).toBe(0);
  });

  it("reports inbound flow refresh demand until a drained channel resumes", async () => {
    const { registry, sendQueue, sent, sessions } = harness();
    await registry.handle(openFrame(channelA));
    sendQueue.flush();
    sent.length = 0;
    const session = sessions.get(channelA as string)!;
    session.queued = 1_200;
    await registry.handle({
      type: "data",
      ...version,
      channelId: channelA,
      sequence: 0 as never,
      payload: Uint8Array.of(1),
    });
    expect(registry.needsFlowRefresh).toBe(true);
    sendQueue.flush();
    expect(decodeAll(sent).at(-1)?.type).toBe("flow.pause");

    session.queued = 0;
    await registry.refreshFlow();
    expect(registry.needsFlowRefresh).toBe(false);
    sendQueue.flush();
    expect(decodeAll(sent).at(-1)?.type).toBe("flow.resume");
  });

  it("fails closed on unknown ownership and isolates negotiated or aggregate limit violations", async () => {
    const { registry, sendQueue, sent, sessions } = harness();
    await expect(
      registry.handle({
        type: "data",
        ...version,
        channelId: channelA,
        sequence: 0 as never,
        payload: Uint8Array.of(1),
      }),
    ).rejects.toBeInstanceOf(RelayChannelProtocolError);

    await registry.handle(openFrame(channelA));
    await registry.handle(openFrame(channelB));
    sendQueue.flush();
    sent.length = 0;
    await registry.handle({
      type: "data",
      ...version,
      channelId: channelA,
      sequence: 0 as never,
      payload: new Uint8Array(limits.maxDataChunkBytes + 1),
    });
    expect(registry.has(channelA)).toBe(false);
    expect(registry.has(channelB)).toBe(true);

    sessions.get(channelB as string)!.queued = limits.maxQueuedBytes - limits.maxControlFrameBytes;
    await registry.handle({
      type: "data",
      ...version,
      channelId: channelB,
      sequence: 0 as never,
      payload: Uint8Array.of(2),
    });
    expect(registry.has(channelB)).toBe(false);
    sendQueue.flush();
    expect(
      decodeAll(sent).some(
        (frame) => frame.type === "channel.close" && frame.reason === "transfer_limit",
      ),
    ).toBe(true);
  });

  it("ignores frames the relay forwarded before it learned a channel ended", async () => {
    const { registry, sendQueue } = harness();
    await registry.handle(openFrame(channelA));
    await registry.handle(openFrame(channelB));
    await registry.closeChannel(channelA, "slow_consumer");
    sendQueue.flush();

    // Frames already in flight when the node closed A. Treating them as a
    // protocol violation used to tear down the whole connection, B included.
    await expect(
      registry.handle({
        type: "data",
        ...version,
        channelId: channelA,
        sequence: 0 as never,
        payload: Uint8Array.of(1),
      }),
    ).resolves.toBeUndefined();
    await expect(
      registry.handle({ type: "flow.pause", ...version, channelId: channelA }),
    ).resolves.toBeUndefined();
    await expect(
      registry.handle({ type: "flow.resume", ...version, channelId: channelA }),
    ).resolves.toBeUndefined();
    expect(registry.has(channelB)).toBe(true);

    // A channel that never existed is still a violation.
    const unknown = `ch_${"C".repeat(22)}` as RelayChannelId;
    await expect(
      registry.handle({ type: "flow.pause", ...version, channelId: unknown }),
    ).rejects.toBeInstanceOf(RelayChannelProtocolError);
  });

  it("hands a session its channel context and a send handle usable outside the RPC path", async () => {
    let connection: RelayConnectionIdentity | undefined;
    const { registry, sendQueue, sent, opens } = harness({ connection: () => connection });
    await registry.handle(openFrame(channelA, "owner"));
    sendQueue.flush();
    sent.length = 0;

    // Everything a session needs to bind itself to this channel, which it
    // previously had no way to learn: the capability and role the peer named,
    // the protocol version the channel speaks, and who this connection is.
    expect(opens[0]).toMatchObject({
      channelId: channelA,
      capability: "ryco.rpc",
      effectiveRole: "owner",
      ...version,
    });

    // Read at each use, not captured at open. A channel opened before the
    // connection knows its own node id — which is every channel of the first
    // connect after enrollment approval — would otherwise be stuck without an
    // identity for its whole lifetime.
    expect(opens[0]!.connection()).toBeUndefined();
    connection = { hubOrigin: "https://hub.example", nodeId: "nd_example" };
    expect(opens[0]!.connection()).toEqual(connection);

    // Out-of-band sends share the channel's outbound sequence with the RPC
    // path rather than running a second, competing one.
    expect(registry.send(channelA, Uint8Array.of(1, 2))).toEqual({ accepted: true });
    expect(registry.send(channelA, Uint8Array.of(3, 4))).toEqual({ accepted: true });
    expect(registry.send(channelB, Uint8Array.of(5))).toEqual({
      accepted: false,
      refusal: "channel_closed",
    });
    sendQueue.flush();
    const frames = decodeAll(sent);
    expect(frames.map((frame) => (frame.type === "data" ? frame.sequence : -1))).toEqual([0, 1]);
  });

  it("passes the exact minor-3 account-grant context only to its channel session", async () => {
    const protocol = { protocolMajor: 1, protocolMinor: 3 } as const;
    const grantDigest = new Uint8Array(32).fill(2);
    const statementDigest = new Uint8Array(32).fill(3);
    const { registry, opens } = harness({ protocol });
    await registry.handle({
      type: "channel.open",
      ...protocol,
      channelId: channelA,
      capability: "ryco.rpc",
      effectiveRole: "operator",
      accountGrantContext: [2, `rtk_${"T".repeat(22)}`, grantDigest, statementDigest],
    } as unknown as RelayChannelOpenFrame);

    expect(opens[0]?.accountGrantContext).toEqual([
      2,
      `rtk_${"T".repeat(22)}`,
      grantDigest,
      statementDigest,
    ]);
    expect(opens[0]).toMatchObject(protocol);
  });

  it("awaits an asynchronous acceptance announcement before delivering any inbound frame", async () => {
    // Void-return bivariance accepts an async announcement silently. If it is
    // not awaited, the message it is emitting at sequence 0 can be overtaken by
    // whatever the peer sends next — the one thing a sequence-0 carrier cannot
    // survive.
    let released: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const { registry, sendQueue, sent, received } = harness({
      onAccepted: async (input) => {
        await gate;
        input.send(Uint8Array.of(0xc0, 0xff, 0xee));
      },
    });
    const opening = registry.handle(openFrame(channelA));
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    expect(registry.has(channelA)).toBe(true);
    released?.();
    await opening;

    // The frame chain could only deliver this once `handle` resolved, which is
    // the guarantee: the announcement completed first.
    await registry.handle({
      type: "data",
      ...version,
      channelId: channelA,
      sequence: 0 as never,
      payload: Uint8Array.of(1),
    });
    expect(received.get(channelA as string)).toHaveLength(1);

    sendQueue.flush();
    const frames = decodeAll(sent);
    expect(frames.map((frame) => frame.type)).toEqual(["channel.accept", "data"]);
    expect(frames[1]?.type === "data" && frames[1].sequence).toBe(0);
  });

  it("closes as channel_rejected, not internal_error, when acceptance announcement fails", async () => {
    // A failed announcement must be indistinguishable on the wire from every
    // other open-time rejection: a distinct reason would partition an
    // authentication layer's pre-key failures by cause.
    const { registry, sendQueue, sent, sessions } = harness({
      onAccepted: () => {
        throw new Error("announcement failed");
      },
    });
    await registry.handle(openFrame(channelA));

    expect(registry.has(channelA)).toBe(false);
    expect(sessions.get(channelA as string)!.closes).toBe(1);
    sendQueue.flush();
    expect(decodeAll(sent).map((frame) => frame.type)).toEqual(["channel.accept", "channel.close"]);
    expect(decodeAll(sent).at(-1)).toMatchObject({
      type: "channel.close",
      channelId: channelA,
      reason: "channel_rejected",
    });
  });

  it("flushes a record queued before a close ahead of the outer channel.close", async () => {
    // Regression: the close purged the channel's queue with no intervening
    // flush, and control frames drain ahead of data anyway, so a record
    // enqueued immediately before a close could never reach the wire first.
    //
    // This harness wires no outbound-ready hook at all, so the drain has to be
    // the close path's own doing. A fix that only worked when the owner
    // happened to flush would leave nothing behind here.
    const { registry, sendQueue, sent, sessions } = harness();
    await registry.handle(openFrame(channelA));
    sendQueue.flush();
    sent.length = 0;

    expect(sessions.get(channelA as string)!.send(Uint8Array.of(7, 7, 7))).toEqual({
      accepted: true,
    });
    expect(sendQueue.queuedBytes).toBeGreaterThan(0);
    await registry.closeChannel(channelA, "channel_rejected");
    // The data is already on the socket at this point; only the close frame
    // still needs the owner's flush, which is exactly the ordering required.
    expect(decodeAll(sent).map((frame) => frame.type)).toEqual(["data"]);
    sendQueue.flush();

    const frames = decodeAll(sent);
    expect(frames.map((frame) => frame.type)).toEqual(["data", "channel.close"]);
    expect(
      frames[0]?.type === "data" && stripRelayChunkCapabilityPrelude(frames[0].payload).message,
    ).toEqual(Uint8Array.of(7, 7, 7));
  });

  it("gets a session's last record out before the close it requests itself", async () => {
    const { registry, sendQueue, sent, sessions } = harness();
    await registry.handle(openFrame(channelA));
    sendQueue.flush();
    sent.length = 0;

    // The sequence a payload-authentication layer performs on a fatal
    // condition: emit the final record, then close naming the reason.
    const session = sessions.get(channelA as string)!;
    expect(session.send(Uint8Array.of(0xff, 0x03))).toEqual({ accepted: true });
    session.requestClose("channel_rejected");
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    sendQueue.flush();

    expect(decodeAll(sent).map((frame) => frame.type)).toEqual(["data", "channel.close"]);
    expect(decodeAll(sent).at(-1)).toMatchObject({ reason: "channel_rejected" });
  });

  it("does not push a flow-paused channel's queued record past the pause on close", async () => {
    // The documented limit of the close drain: the peer asked this channel to
    // stop, so its queued record is lost rather than sent in violation. A
    // protocol that needs delivery proof cannot take an accepted enqueue for
    // one.
    const { registry, sendQueue, sent, sessions } = harness();
    await registry.handle(openFrame(channelA));
    sendQueue.flush();
    sent.length = 0;

    await registry.handle({ type: "flow.pause", ...version, channelId: channelA });
    expect(sessions.get(channelA as string)!.send(Uint8Array.of(7))).toEqual({ accepted: true });
    await registry.closeChannel(channelA, "channel_rejected");
    sendQueue.flush();

    expect(decodeAll(sent).map((frame) => frame.type)).toEqual(["channel.close"]);
    expect(sendQueue.queuedBytes).toBe(0);
  });

  it("does not drain a channel the peer has already closed", async () => {
    const { registry, sendQueue, sent, sessions } = harness();
    await registry.handle(openFrame(channelA));
    sendQueue.flush();
    sent.length = 0;

    expect(sessions.get(channelA as string)!.send(Uint8Array.of(7))).toEqual({ accepted: true });
    // The relay no longer knows this channel, so its queued data has nowhere
    // to go and must not be pushed after the peer's close.
    await registry.handle({ type: "channel.close", ...version, channelId: channelA });
    sendQueue.flush();
    expect(sent).toEqual([]);
    expect(sendQueue.queuedBytes).toBe(0);
  });

  it("reports a refused send without disturbing the channel", async () => {
    const { registry, sendQueue, sent, sessions, socket } = harness();
    await registry.handle(openFrame(channelA));
    sendQueue.flush();
    sent.length = 0;

    socket.bufferedAmount = limits.maxQueuedBytes;
    const session = sessions.get(channelA as string)!;
    expect(session.send(Uint8Array.of(9), { onRefused: "report" })).toEqual({
      accepted: false,
      refusal: "queue_full",
    });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();

    // The default disposition would have closed the channel here.
    expect(registry.has(channelA)).toBe(true);
    expect(session.closes).toBe(0);
    expect(sent).toEqual([]);
    socket.bufferedAmount = 0;
    expect(session.send(Uint8Array.of(9))).toEqual({ accepted: true });
  });

  it("keeps a size refusal distinguishable from backpressure", async () => {
    // A sender that must map these onto different errors — permanent versus
    // retryable — cannot do it from one bit.
    const { registry, sendQueue, sessions, socket } = harness();
    await registry.handle(openFrame(channelA));
    sendQueue.flush();

    const session = sessions.get(channelA as string)!;
    const report = { onRefused: "report" } as const;
    expect(session.send(new Uint8Array(limits.maxDataChunkBytes + 1), report)).toEqual({
      accepted: false,
      refusal: "peer_unsupported",
    });
    session.chunkSupport = true;
    expect(session.send(new Uint8Array(RELAY_MAX_RPC_MESSAGE_BYTES + 1), report)).toEqual({
      accepted: false,
      refusal: "message_too_large",
    });
    socket.bufferedAmount = limits.maxQueuedBytes;
    expect(session.send(Uint8Array.of(1), report)).toEqual({
      accepted: false,
      refusal: "queue_full",
    });
    expect(registry.has(channelA)).toBe(true);
  });

  it("enqueues every chunk of a message or none of them", async () => {
    const { registry, sendQueue, sessions, socket } = harness();
    await registry.handle(openFrame(channelA));
    sendQueue.flush();

    const session = sessions.get(channelA as string)!;
    session.chunkSupport = true;
    // Room for one frame of this message but not both. Enqueuing the first and
    // refusing the second would leave the peer's reassembler holding a
    // truncated message that nothing will ever complete.
    socket.bufferedAmount = 1_500;
    expect(
      session.send(new Uint8Array(limits.maxDataChunkBytes * 2 - 64), {
        onRefused: "report",
      }),
    ).toEqual({ accepted: false, refusal: "queue_full" });
    expect(sendQueue.queuedBytes).toBe(0);
  });

  it("closes a channel from the session side with the reason the session names", async () => {
    const { registry, sendQueue, sent, sessions } = harness();
    await registry.handle(openFrame(channelA));
    sendQueue.flush();
    sent.length = 0;

    sessions.get(channelA as string)!.requestClose("channel_rejected");
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();

    expect(registry.has(channelA)).toBe(false);
    expect(sessions.get(channelA as string)!.closes).toBe(1);
    sendQueue.flush();
    expect(decodeAll(sent)).toEqual([
      expect.objectContaining({
        type: "channel.close",
        channelId: channelA,
        reason: "channel_rejected",
      }),
    ]);
  });

  it("still closes a refusing receiver as a slow consumer", async () => {
    const { registry, sendQueue, sent, sessions } = harness();
    await registry.handle(openFrame(channelA));
    sendQueue.flush();
    sent.length = 0;

    sessions.get(channelA as string)!.accept = false;
    await registry.handle({
      type: "data",
      ...version,
      channelId: channelA,
      sequence: 0 as never,
      payload: Uint8Array.of(1),
    });

    expect(registry.has(channelA)).toBe(false);
    sendQueue.flush();
    expect(decodeAll(sent)).toEqual([
      expect.objectContaining({
        type: "channel.close",
        channelId: channelA,
        reason: "slow_consumer",
      }),
    ]);
  });

  it("closes a channel and signals fatal when outbound buffering cannot retain a close", async () => {
    const { registry, sendQueue, sessions, socket, fatalCalls } = harness();
    await registry.handle(openFrame(channelA));
    sendQueue.flush();
    socket.bufferedAmount = limits.maxQueuedBytes;
    expect(sessions.get(channelA as string)!.send(Uint8Array.of(9)).accepted).toBe(false);
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    expect(registry.has(channelA)).toBe(false);
    expect(sessions.get(channelA as string)!.closes).toBe(1);
    expect(fatalCalls()).toBe(1);
  });
  it("never admits a message for less than the send queue then charges it", async () => {
    const { registry, sendQueue, sessions, opens } = harness();
    await registry.handle(openFrame(channelA));
    sessions.get(channelA as string)!.chunkSupport = true;
    const admit = opens[0]!.admit;
    // Both shapes `prepareRelayMessage` produces: a fitting message that gets
    // the capability prelude, and one split into several chunks.
    for (const size of [1, 64, limits.maxDataChunkBytes - 32, limits.maxDataChunkBytes * 2 + 7]) {
      sendQueue.flush();
      const admission = admit(size);
      if (admission === undefined) continue;
      const reserved = sendQueue.reservedBytes;
      const before = sendQueue.queuedBytes;
      expect(admission.send(new Uint8Array(size)).accepted).toBe(true);
      // The whole point of the reservation: what the queue actually charges is
      // never more than what admission held for it, so an admitted message is
      // never then refused.
      expect(sendQueue.queuedBytes - before).toBeLessThanOrEqual(reserved);
      expect(sendQueue.reservedBytes).toBe(0);
    }
  });

  it("refuses admission when the connection budget is spoken for, and holds it until settled", async () => {
    const { registry, sendQueue, opens, sent } = harness();
    await registry.handle(openFrame(channelA));
    const admit = opens[0]!.admit;
    sendQueue.flush();
    const dataCapacity = limits.maxQueuedBytes - limits.maxControlFrameBytes;
    expect(sendQueue.reserveData(channelA, dataCapacity)).toBe(true);
    // Nothing was built and nothing was sent: a refusal is a value.
    expect(admit(16)).toBeUndefined();
    const before = sent.length;
    sendQueue.flush();
    expect(sent).toHaveLength(before);
    sendQueue.releaseReservation(channelA, dataCapacity);

    // An abandoned admission gives the capacity back; a spent one does not have
    // to be released twice.
    const abandoned = admit(16)!;
    expect(sendQueue.reservedBytes).toBeGreaterThan(0);
    abandoned.release();
    abandoned.release();
    expect(sendQueue.reservedBytes).toBe(0);
    const spent = admit(16)!;
    expect(spent.send(new Uint8Array(16)).accepted).toBe(true);
    spent.release();
    expect(sendQueue.reservedBytes).toBe(0);
  });
});
