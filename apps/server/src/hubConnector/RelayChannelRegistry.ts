import type {
  RelayAccountGrantContext,
  RelayCapability,
  RelayChannelId,
  RelayChannelOpenFrame,
  RelayCloseReason,
  RelayControlFrame,
  RelayDataFrame,
  RelayEffectiveRole,
  RelayFrame,
  RelayLimits,
  RelayProtocolVersion,
} from "@ryco/contracts/relay";
import { RELAY_MAX_RPC_MESSAGE_BYTES } from "@ryco/contracts/relay";
import { RELAY_CHUNK_HEADER_BYTES } from "@ryco/contracts/relay";
import {
  prepareRelayMessage,
  RELAY_CHUNK_CAPABILITY_PRELUDE,
} from "@ryco/shared/relayMessageChunks";

import { defaultRelayScheduler, type RelaySessionScheduler } from "./RelayConnectionSession.ts";
import { RelaySendQueue } from "./RelaySendQueue.ts";

/**
 * What a channel does with a message the send path would not take.
 *
 * `close` is the historical and default disposition: a refused message means
 * the channel is finished, and the registry tears it down naming the cause.
 * `report` leaves the channel untouched and hands the refusal back to the
 * caller, for a sender that treats backpressure as recoverable. Both rely on
 * the send path being all-or-nothing, so a refusal never leaves part of a
 * message on the wire.
 *
 * Every refusal applies the disposition, including the two that describe a
 * channel that is already gone or unusable — a `close` disposition on a
 * `channel_closed` refusal has nothing left to tear down and is satisfied
 * without emitting anything, rather than being silently skipped.
 */
export interface RelayChannelSendOptions {
  readonly onRefused?: "close" | "report";
}

/**
 * Why the send path would not take a message.
 *
 * The three are not interchangeable to a caller that must react: the first two
 * are permanent for this message on this channel — resending the identical
 * bytes fails identically — while `queue_full` is ordinary backpressure that a
 * later attempt may well survive. Collapsing them into one bit made an
 * application bug read as a network problem, and a sender that must
 * distinguish a size failure from unavailable transmission admission could not.
 */
export type RelayChannelSendRefusal =
  /** Larger than the reassembly ceiling this channel can carry at all. */
  | "message_too_large"
  /** Needs chunking, and this peer has not advertised chunk support. */
  | "peer_unsupported"
  /** The outbound queue could not admit every frame of the message. */
  | "queue_full"
  /** The channel is gone, or was never registered. */
  | "channel_closed"
  /** The channel's outbound data sequence is exhausted. */
  | "sequence_exhausted";

export type RelayChannelSendResult =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly refusal: RelayChannelSendRefusal };

const ACCEPTED: RelayChannelSendResult = { accepted: true };
const refused = (refusal: RelayChannelSendRefusal): RelayChannelSendResult => ({
  accepted: false,
  refusal,
});

/**
 * Enqueues one whole message on a channel's outbound data sequence.
 *
 * All-or-nothing: an accepted message has every one of its frames queued in
 * order, and a refused one produced no wire record at all.
 *
 * NOTE for a layer that assigns a nonce or sequence number of its own before
 * calling this: a refusal reported *here* is already too late. The bytes exist
 * by the time this is called, so a caller that has consumed a counter to
 * produce them and rolls it back on refusal will reuse that counter with
 * different plaintext. Such a caller must obtain admission for the whole
 * message — every frame of it — before it consumes anything, and this handle's
 * all-or-nothing refusal is what makes that possible rather than what
 * implements it. See the record-protection carry-forward in
 * docs/superpowers/specs/2026-07-29-e2ee-relay-payload-encryption-design.md.
 */
export type RelayChannelSendHandle = (
  bytes: Uint8Array,
  options?: RelayChannelSendOptions,
) => RelayChannelSendResult;

/**
 * Transmission admission for one whole message, obtained *before* the message
 * exists.
 *
 * This is the other half of the note on `RelayChannelSendHandle`. A layer that
 * consumes a nonce, a sequence number, or any other one-shot value to produce
 * its bytes cannot learn from a refusal after the fact: rolling the value back
 * and reusing it with different plaintext is exactly the failure the note
 * describes. So capacity is committed here first, against the same connection
 * budget every enqueue is measured against, and the permission to send *is* this
 * object — there is no way to obtain admission for one message and spend it on
 * another, and no way to spend it twice.
 *
 * Single use: the first of `send` and `release` settles it and the other becomes
 * a no-op. A caller that obtains one and neither sends nor releases holds
 * capacity until its channel closes, so every caller releases in a `finally`.
 */
export interface RelayChannelAdmission {
  /** Send the message this admission was obtained for. */
  readonly send: (bytes: Uint8Array, options?: RelayChannelSendOptions) => RelayChannelSendResult;
  /** Give the capacity back unsent. Idempotent, and a no-op after `send`. */
  readonly release: () => void;
}

/**
 * Ask whether a message of this many bytes would be admitted, and hold the
 * capacity if it would.
 *
 * `undefined` is a refusal, and it is ordinary backpressure: nothing was
 * committed, nothing was sent, and the channel is untouched. It also covers the
 * two permanent refusals `send` reports — a message the channel cannot carry at
 * all, and one needing chunking from a peer that has not advertised support —
 * because a caller that must decide before it builds the bytes has the same
 * answer to give in all three cases and no bytes to attach a reason to.
 */
export type RelayChannelAdmitHandle = (messageBytes: number) => RelayChannelAdmission | undefined;

/**
 * A ceiling on what one data frame costs the send queue beyond its payload.
 *
 * A relay data frame is a small canonical CBOR map — the type, both protocol
 * numbers, the channel id, the sequence, and the payload's own byte-string
 * header — and the send queue charges a fixed per-entry overhead on top of the
 * encoded frame. Admission must never under-count: under-counting would admit a
 * message the enqueue then refuses, which is the one outcome a reservation
 * exists to make impossible. Over-counting merely refuses a send a few bytes
 * early, which is backpressure the caller already handles. The value is
 * therefore deliberately generous rather than exact, and
 * `RelayChannelRegistry.test.ts` holds it to the real encoded cost.
 */
const DATA_FRAME_ADMISSION_OVERHEAD_BYTES = 256;

/**
 * The payload sizes `prepareRelayMessage` would produce for a message of this
 * length, or `undefined` when it would refuse one.
 *
 * Arithmetic rather than a dry run, because admission runs before the bytes
 * exist and allocating a message-sized buffer to measure it would defeat the
 * purpose. It mirrors `prepareRelayMessage` exactly: a fitting message carries
 * the capability prelude when there is headroom for it, an oversized one is
 * split into `maxChunkBytes` chunks with a header each, and the two refusals are
 * the same two.
 */
function plannedRelayPayloadSizes(
  messageBytes: number,
  options: {
    readonly maxChunkBytes: number;
    readonly maxMessageBytes: number;
    readonly peerSupportsChunking: boolean;
  },
): readonly number[] | undefined {
  if (!Number.isSafeInteger(messageBytes) || messageBytes < 0) return undefined;
  if (messageBytes > options.maxMessageBytes) return undefined;
  if (messageBytes <= options.maxChunkBytes) {
    const advertised = messageBytes + RELAY_CHUNK_CAPABILITY_PRELUDE.byteLength;
    return [advertised <= options.maxChunkBytes ? advertised : messageBytes];
  }
  if (!options.peerSupportsChunking) return undefined;
  const capacity = options.maxChunkBytes - RELAY_CHUNK_HEADER_BYTES;
  if (capacity <= 0) return undefined;
  const sizes: number[] = [];
  for (let offset = 0; offset < messageBytes; offset += capacity) {
    sizes.push(RELAY_CHUNK_HEADER_BYTES + Math.min(capacity, messageBytes - offset));
  }
  return sizes;
}

/** Connection-scoped identity a channel session may need to bind to. */
export interface RelayConnectionIdentity {
  readonly hubOrigin: string;
  readonly nodeId: string;
}

export interface RelayRpcChannelSession {
  /**
   * Accept one inbound payload.
   *
   * `false` is backpressure and nothing else: the registry closes the channel
   * as a slow consumer. A session that has to reject a payload on protocol
   * grounds names its own reason through the `close` handle it was given at
   * open instead — the decision generally cannot be made here anyway, because a
   * payload may still be one chunk of an incomplete message.
   */
  readonly receive: (bytes: Uint8Array) => Promise<boolean>;
  readonly queuedBytes: () => Promise<number>;
  readonly supportsChunkedMessages: () => boolean;
  readonly close: () => Promise<void>;
  /**
   * Called once, after the channel is registered and its `channel.accept` is
   * enqueued.
   *
   * This is the earliest point at which a session can put a message at the
   * channel's outbound sequence 0, because the send handle refuses until the
   * entry exists. What the registry guarantees is narrower than "first on the
   * wire", and a carrier protocol should read it exactly:
   *
   * - it is awaited inside the `channel.open` handling, so a caller that
   *   serializes frame delivery — as the connection does — processes no further
   *   frame, on this channel or any other, until it settles; and
   * - nothing on this channel has been able to send before it.
   *
   * The registry does **not** stop a concurrent `RelayChannelRegistry.send` for
   * this channel from taking sequence 0 first; it cannot tell such a caller
   * apart from the announcement. A protocol that owns sequence 0 must be the
   * channel's only out-of-band sender until this returns.
   *
   * **It MUST NOT perform slow work.** It occupies the connection's serialized
   * frame chain, where a `ping` waiting behind it is a `pong` the peer's
   * dead-connection timer is not receiving. Anything expensive — building and
   * signing a capability statement, reading key custody — belongs ahead of it,
   * with the bytes prepared before the channel opens, leaving the announcement
   * itself a single `send`. The registry enforces that bound rather than
   * trusting it: an announcement still outstanding after a quarter of the
   * negotiated heartbeat interval loses its channel, so no announcement can
   * hold the connection long enough for the peer to declare it dead.
   *
   * A rejection, a throw, or an overrun of that bound closes the channel
   * exactly as any other open-time session failure does.
   */
  readonly onAccepted?: () => void | Promise<void>;
}

export interface RelayChannelSessionFactory {
  /**
   * Called once per relay connection, as its registry is constructed.
   *
   * This is the earliest point at which the connection's asserted limits are
   * known — the `ready` frame settled them — and it is strictly before any
   * channel on the connection can be opened, because a channel is only ever
   * opened through a constructed registry. A protocol whose serviceability is a
   * property of the connection rather than of a channel evaluates it here, once,
   * and a protocol with expensive per-connection preparation starts it here so
   * the first channel does not pay for it.
   *
   * The limits are the ones the Hub asserted and both endpoints adopt verbatim;
   * neither endpoint proposes or vetoes them. Synchronous and best effort: it
   * returns nothing, and a registry that has been constructed is usable whether
   * or not the factory did anything with them.
   */
  readonly connectionReady?: (input: {
    readonly limits: RelayLimits;
    readonly protocolMajor: number;
    readonly protocolMinor: number;
  }) => void;
  readonly open: (input: {
    readonly channelId: RelayChannelId;
    /** The capability the peer named on `channel.open`. */
    readonly capability: RelayCapability;
    readonly effectiveRole: RelayEffectiveRole;
    /** The relay protocol version this channel speaks. */
    readonly protocolMajor: number;
    readonly protocolMinor: number;
    /** Present only for an account-authorized native channel on relay minor 3+. */
    readonly accountGrantContext?: RelayAccountGrantContext;
    /**
     * Who this connection is, read at each use.
     *
     * A getter rather than a value: the node id is assigned while the
     * connection authenticates, and a channel can be — and in the first connect
     * after enrollment approval routinely is — opened before that read
     * completes. Capturing it at open would leave such a channel permanently
     * without an identity. Still returns undefined while nothing is known.
     */
    readonly connection: () => RelayConnectionIdentity | undefined;
    readonly send: RelayChannelSendHandle;
    /**
     * Obtain transmission admission for a message before building it.
     *
     * The seam exists for one reason and it is stated on `RelayChannelAdmission`:
     * a sender that consumes a one-shot value to produce its bytes must know the
     * whole message is admitted before it consumes anything.
     */
    readonly admit: RelayChannelAdmitHandle;
    /**
     * Close this channel from the session side, naming the reason.
     *
     * Deferred to a microtask, like every other close the send path schedules,
     * so a session may call it from inside `receive` without re-entering the
     * registry mid-frame. Anything the session enqueued before calling this is
     * drained to the socket ahead of the `channel.close` — see `closeChannel`.
     *
     * With no reason and no `notifyPeer` the channel is torn down locally and
     * the peer is told nothing. A protocol that ends a channel cleanly wants the
     * other shape — a `channel.close` carrying no reason — and asks for it with
     * `notifyPeer`.
     */
    readonly close: (
      reason?: RelayCloseReason,
      options?: { readonly notifyPeer?: boolean },
    ) => void;
  }) => Promise<RelayRpcChannelSession>;
}

interface ChannelEntry {
  readonly channelId: RelayChannelId;
  readonly role: RelayEffectiveRole;
  readonly session: RelayRpcChannelSession;
  readonly send: RelayChannelSendHandle;
  inboundSequence: number;
  outboundSequence: number;
  inboundPaused: boolean;
  graceFrames: number;
  closed: boolean;
}

export class RelayChannelProtocolError extends Error {
  constructor() {
    super("Relay channel protocol violation.");
    this.name = "RelayChannelProtocolError";
  }
}

/**
 * How many recently ended channel ids a connection remembers.
 *
 * Frames the relay forwarded before it learned a channel ended are still on the
 * wire when the node ends it, so a `data` or flow frame naming a just-closed
 * channel is an ordinary race, not a protocol violation. Treating it as one
 * tore down the whole connection — every other channel with it — and a second
 * occurrence before the stability interval parked the connector for operator
 * action. Bounded, oldest first, because the race window is short and a peer
 * must not be able to grow node memory by cycling channels.
 */
const RECENTLY_CLOSED_CHANNEL_LIMIT = 256;

export class RelayChannelQueueError extends Error {
  constructor() {
    super("Relay channel control queue is full.");
    this.name = "RelayChannelQueueError";
  }
}

export class RelayChannelRegistry {
  readonly #limits: RelayLimits;
  readonly #version: RelayProtocolVersion;
  readonly #sendQueue: RelaySendQueue;
  readonly #factory: RelayChannelSessionFactory;
  readonly #onFatal: () => void;
  readonly #onOutboundReady: () => void;
  readonly #connection: () => RelayConnectionIdentity | undefined;
  readonly #scheduler: RelaySessionScheduler;
  readonly #channels = new Map<string, ChannelEntry>();
  readonly #preparing = new Set<string>();
  readonly #recentlyClosed = new Set<string>();
  #stopping = false;

  constructor(options: {
    readonly limits: RelayLimits;
    /** The exact version selected by the relay `ready` frame. */
    readonly protocol: RelayProtocolVersion;
    readonly sendQueue: RelaySendQueue;
    readonly factory: RelayChannelSessionFactory;
    readonly onFatal?: () => void;
    readonly onOutboundReady?: () => void;
    /**
     * Who this connection is, handed to every session as a getter.
     *
     * Never resolved to a value here: the node id becomes known only after
     * identity state has been read, which happens after this registry exists
     * and after the first channels can already have opened.
     */
    readonly connection?: () => RelayConnectionIdentity | undefined;
    /**
     * Timer source for the acceptance-announcement deadline, and nothing else.
     *
     * Injectable so the connection's own scheduler — the one its heartbeat and
     * reconnect timers already run on — governs the one bound this registry
     * enforces, rather than a second, untestable clock.
     */
    readonly scheduler?: RelaySessionScheduler;
  }) {
    this.#limits = options.limits;
    this.#version = { ...options.protocol };
    this.#sendQueue = options.sendQueue;
    this.#factory = options.factory;
    this.#onFatal = options.onFatal ?? (() => undefined);
    this.#onOutboundReady = options.onOutboundReady ?? (() => undefined);
    this.#connection = options.connection ?? (() => undefined);
    this.#scheduler = options.scheduler ?? defaultRelayScheduler;
    // Last, and inside the constructor rather than on the first `channel.open`:
    // "before any channel on this connection is accepted" is the guarantee the
    // hook exists to give, and it is only a guarantee if nothing can reach the
    // registry first. A throw here is the factory's own defect and belongs to
    // the caller constructing this registry, not to a channel.
    this.#factory.connectionReady?.({ limits: this.#limits, ...this.#version });
  }

  get size(): number {
    return this.#channels.size;
  }

  get needsFlowRefresh(): boolean {
    for (const entry of this.#channels.values()) {
      if (entry.inboundPaused && !entry.closed) return true;
    }
    return false;
  }

  has(channelId: RelayChannelId): boolean {
    return this.#channels.has(channelId as string);
  }

  async handle(frame: RelayFrame): Promise<void> {
    switch (frame.type) {
      case "channel.open":
        await this.#open(frame);
        return;
      case "data":
        await this.#data(frame);
        return;
      case "flow.pause":
        if (!this.#channels.has(frame.channelId as string)) {
          this.#assertRecentlyClosed(frame.channelId);
          return;
        }
        this.#sendQueue.pause(frame.channelId);
        return;
      case "flow.resume":
        if (!this.#channels.has(frame.channelId as string)) {
          this.#assertRecentlyClosed(frame.channelId);
          return;
        }
        this.#sendQueue.resume(frame.channelId);
        return;
      case "channel.close":
        // The peer already tore the channel down, so anything still queued for
        // it has nowhere to go: draining it would push data frames for a
        // channel the relay no longer knows.
        await this.closeChannel(frame.channelId, undefined, { flushQueued: false });
        return;
      default:
        return;
    }
  }

  async refreshFlow(): Promise<void> {
    const lowWater = Math.floor(this.#channelBudget() * 0.5);
    for (const entry of this.#channels.values()) {
      if (!entry.inboundPaused || entry.closed) continue;
      if ((await entry.session.queuedBytes()) <= lowWater) {
        entry.inboundPaused = false;
        entry.graceFrames = 0;
        this.#enqueueControl({
          type: "flow.resume",
          ...this.#version,
          channelId: entry.channelId,
        });
      }
    }
  }

  /**
   * How many frames a paused channel may still deliver before it counts as a
   * slow consumer.
   *
   * This used to be 1, on the assumption that one message is one frame. A
   * message can now arrive as several, so a one-frame grace would kill a
   * channel mid-message the moment it paused. The bound is the queue budget
   * rather than RELAY_MAX_RPC_MESSAGE_BYTES: a peer cannot have more than
   * `maxQueuedBytes` in flight regardless, so this is the tightest allowance
   * that cannot sever a legitimate message.
   */
  #graceFrameAllowance(): number {
    return Math.ceil(this.#limits.maxQueuedBytes / this.#limits.maxDataChunkBytes) + 1;
  }

  /**
   * Emit one message on a live channel from outside the RPC path.
   *
   * Goes through the channel's own send handle, so an out-of-band message
   * shares the per-channel outbound sequence, the chunk-support latch and the
   * refusal handling with everything the RPC path emits. A channel that is gone
   * refuses as `channel_closed`.
   */
  send(
    channelId: RelayChannelId,
    bytes: Uint8Array,
    options: RelayChannelSendOptions = {},
  ): RelayChannelSendResult {
    const entry = this.#channels.get(channelId as string);
    if (entry === undefined || entry.closed) {
      return this.#refuse(channelId, "channel_closed", options);
    }
    return entry.send(bytes, options);
  }

  /**
   * Close one channel, optionally naming the reason to the peer.
   *
   * `flushQueued` defaults to true because this is the deliberate per-channel
   * close: a session that emitted a final record and then asked for a close
   * needs that record to reach the socket ahead of the `channel.close`. The two
   * paths that pass false are the ones where a drain has no addressee — a close
   * the peer initiated, and connection teardown (`closeAll`).
   *
   * `notifyPeer` defaults to "whenever a reason was named", which is the
   * historical behavior and the only one anything needed until a protocol
   * arrived that ends a channel *cleanly*: the relay frame carries the reason as
   * an optional field, so an orderly close is a `channel.close` with no reason,
   * and it is a different thing from tearing a channel down locally and telling
   * the peer nothing. Passing it explicitly is how a caller asks for the first.
   */
  async closeChannel(
    channelId: RelayChannelId,
    reason?: RelayCloseReason,
    options: { readonly flushQueued?: boolean; readonly notifyPeer?: boolean } = {},
  ) {
    const key = channelId as string;
    const entry = this.#channels.get(key);
    if (entry === undefined || entry.closed) return;
    entry.closed = true;
    this.#channels.delete(key);
    this.#rememberClosed(key);
    // A message enqueued immediately before a close used to be destroyed
    // outright: the purge below drops the channel's queue, and even without it
    // `flush` drains control frames ahead of data, so the `channel.close` would
    // still have overtaken the message it was supposed to follow. A protocol
    // that has to get a final record onto the wire before the outer close
    // cannot be built on that, so the queue is drained here — directly, not
    // through the outbound-ready notification, which the owner is free to
    // defer or drop.
    //
    // Best effort, and knowingly so: a channel the peer has flow-paused cannot
    // be drained without violating that pause, and a socket that cannot take
    // the bytes cannot be made to. Both lose the queued record, which is why a
    // protocol needing delivery proof must obtain it from its peer rather than
    // from a successful enqueue.
    if (options.flushQueued ?? true) this.#sendQueue.flushChannel(channelId);
    this.#sendQueue.removeChannel(channelId);
    let controlError: RelayChannelQueueError | undefined;
    try {
      if (options.notifyPeer ?? reason !== undefined) {
        this.#enqueueControl({
          type: "channel.close",
          ...this.#version,
          channelId,
          ...(reason === undefined ? {} : { reason }),
        });
      }
    } catch (error: unknown) {
      if (error instanceof RelayChannelQueueError) controlError = error;
      else throw error;
    }
    await entry.session.close().catch(() => undefined);
    if (controlError !== undefined) throw controlError;
  }

  /**
   * Tear every channel down, draining none of them.
   *
   * Teardown deliberately does not inherit the per-channel close's drain. It
   * names no reason, so no `channel.close` is emitted for any of these
   * channels; and every caller closes the send queue and the socket
   * immediately afterwards, so the drain would either write into a socket that
   * is being discarded or fail and close the queue from underneath the
   * teardown that is already running. The record-ordering guarantee the drain
   * exists for is a property of a deliberate close that names its reason, not
   * of a connection ending.
   */
  async closeAll(): Promise<void> {
    this.#stopping = true;
    const ids = [...this.#channels.values()].map((entry) => entry.channelId);
    await Promise.all(ids.map((id) => this.closeChannel(id, undefined, { flushQueued: false })));
    this.#preparing.clear();
  }

  /**
   * Report a refused send, and apply the caller's disposition.
   *
   * Every refusal comes through here, so the disposition the caller asked for
   * is applied to all five and not just to the ones that happen to be produced
   * downstream of a size or queue check. A channel that is already gone is the
   * one case with nothing to tear down: the disposition is satisfied by the
   * channel's absence, and scheduling a close for an entry that no longer
   * exists would only queue a microtask that finds nothing.
   *
   * The close reason and the refusal are separate vocabularies on purpose: a
   * size failure is `transfer_limit` — exactly what the inbound check reports
   * for the identical condition — while a full queue is genuine backpressure
   * and stays `slow_consumer`. Reporting the first as the second makes an
   * application bug ("this node emitted a message the channel cannot carry")
   * look like a network problem, which is why it went undiagnosed. An
   * exhausted outbound sequence takes `channel_rejected`, the reason the
   * inbound path already uses for the identical condition in the other
   * direction.
   */
  #refuse(
    channelId: RelayChannelId,
    refusal: RelayChannelSendRefusal,
    options: RelayChannelSendOptions,
  ): RelayChannelSendResult {
    if ((options.onRefused ?? "close") === "close" && this.#channels.has(channelId as string)) {
      const reason: RelayCloseReason =
        refusal === "queue_full"
          ? "slow_consumer"
          : refusal === "sequence_exhausted"
            ? "channel_rejected"
            : "transfer_limit";
      queueMicrotask(() => {
        void this.closeChannel(channelId, reason).catch(this.#onFatal);
      });
    }
    return refused(refusal);
  }

  #channelBudget(): number {
    return Math.max(
      this.#limits.maxDataChunkBytes,
      Math.floor(
        (this.#limits.maxQueuedBytes - this.#limits.maxControlFrameBytes) /
          this.#limits.maxChannels,
      ),
    );
  }

  /**
   * How long an acceptance announcement may hold the connection's frame chain.
   *
   * Derived from the connection's own liveness parameters rather than invented:
   * the relay contract holds `deadConnectionTimeoutMs` at no less than twice
   * `heartbeatIntervalMs`, so a quarter of the heartbeat interval is comfortably
   * inside the window the peer allows a `pong` to arrive in — even at the
   * smallest limits either side may negotiate. The bound is a backstop for a
   * hung announcement, not a budget to spend: a conforming announcement
   * prepares its bytes in advance and finishes in one `send`.
   */
  #announcementDeadlineMs(): number {
    return Math.max(1, Math.floor(this.#limits.heartbeatIntervalMs / 4));
  }

  /**
   * Run one acceptance announcement under the bound its contract states.
   *
   * A synchronous announcement — the shape a prepared carrier has — arms no
   * timer at all. An asynchronous one is raced against the deadline, and losing
   * that race is reported as a failure so the caller closes the channel exactly
   * as it does for a rejection: an announcement that cannot finish is not a
   * channel that may proceed without it.
   *
   * The announcement itself keeps running — it cannot be cancelled — but its
   * channel is gone by then, so the send handle refuses everything it attempts
   * afterwards and its own late failure is absorbed here rather than surfacing
   * as an unhandled rejection.
   */
  async #announce(onAccepted: () => void | Promise<void>): Promise<void> {
    const result = onAccepted();
    if (result === undefined) return;
    const announcement = Promise.resolve(result);
    announcement.catch(() => undefined);
    let timer: unknown;
    try {
      await Promise.race([
        announcement,
        new Promise<never>((_resolve, reject) => {
          timer = this.#scheduler.setTimeout(
            () => reject(new Error("Relay channel acceptance announcement exceeded its deadline.")),
            this.#announcementDeadlineMs(),
          );
        }),
      ]);
    } finally {
      this.#scheduler.clearTimeout(timer);
    }
  }

  #rememberClosed(key: string): void {
    this.#recentlyClosed.delete(key);
    this.#recentlyClosed.add(key);
    if (this.#recentlyClosed.size > RECENTLY_CLOSED_CHANNEL_LIMIT) {
      const oldest = this.#recentlyClosed.values().next().value;
      if (oldest !== undefined) this.#recentlyClosed.delete(oldest);
    }
  }

  /**
   * A frame for a channel this connection does not have is ignored when the
   * channel ended recently — see `RECENTLY_CLOSED_CHANNEL_LIMIT` — and is still a
   * protocol violation when the channel never existed.
   */
  #assertRecentlyClosed(channelId: RelayChannelId): void {
    if (!this.#recentlyClosed.has(channelId as string)) throw new RelayChannelProtocolError();
  }

  async #open(frame: RelayChannelOpenFrame): Promise<void> {
    const key = frame.channelId as string;
    const rejected =
      this.#stopping ||
      frame.capability !== "ryco.rpc" ||
      frame.effectiveRole === undefined ||
      this.#channels.size + this.#preparing.size >= this.#limits.maxChannels ||
      this.#channels.has(key) ||
      this.#preparing.has(key);
    if (rejected) {
      if (!this.#channels.has(key) && !this.#preparing.has(key)) this.#rememberClosed(key);
      this.#enqueueControl({
        type: "channel.reject",
        ...this.#version,
        channelId: frame.channelId,
        reason: this.#stopping ? "server_draining" : "channel_rejected",
      });
      return;
    }
    this.#recentlyClosed.delete(key);
    this.#preparing.add(key);
    let entry: ChannelEntry | undefined;
    try {
      const role = frame.effectiveRole;
      let outputSequence = 0;
      const messageLimits = () => ({
        maxChunkBytes: this.#limits.maxDataChunkBytes,
        maxMessageBytes: Math.min(
          RELAY_MAX_RPC_MESSAGE_BYTES,
          this.#limits.maxQueuedBytes - this.#limits.maxControlFrameBytes,
        ),
        peerSupportsChunking: entry?.session.supportsChunkedMessages() ?? false,
      });
      const emit = (
        bytes: Uint8Array,
        options: RelayChannelSendOptions,
        admittedBytes: number,
      ): RelayChannelSendResult => {
        if (entry === undefined || entry.closed) {
          return this.#refuse(frame.channelId, "channel_closed", options);
        }
        if (outputSequence > 0xffff_ffff) {
          return this.#refuse(frame.channelId, "sequence_exhausted", options);
        }
        // A message larger than one data frame is split across several. All
        // chunks of one message go into the per-channel FIFO synchronously
        // here, so they cannot interleave with another message, and they go in
        // together or not at all so a refusal never leaves a truncated message
        // the peer can never complete.
        const prepared = prepareRelayMessage(bytes, messageLimits());
        // `prepareRelayMessage`'s two error reasons are carried through rather
        // than collapsed: they are different failures with different remedies.
        if (prepared.kind === "error") {
          return this.#refuse(frame.channelId, prepared.reason, options);
        }
        const accepted = this.#sendQueue.enqueueDataBatch(
          prepared.payloads.map((payload, index) => ({
            type: "data",
            ...this.#version,
            channelId: frame.channelId,
            sequence: (outputSequence + index) as RelayDataFrame["sequence"],
            payload: Uint8Array.from(payload),
          })),
          { admittedBytes },
        );
        if (!accepted) return this.#refuse(frame.channelId, "queue_full", options);
        outputSequence += prepared.payloads.length;
        entry.outboundSequence = outputSequence;
        this.#onOutboundReady();
        return ACCEPTED;
      };
      const send: RelayChannelSendHandle = (bytes, options = {}) => emit(bytes, options, 0);
      const admit: RelayChannelAdmitHandle = (messageBytes) => {
        if (entry === undefined || entry.closed) return undefined;
        if (outputSequence > 0xffff_ffff) return undefined;
        const sizes = plannedRelayPayloadSizes(messageBytes, messageLimits());
        if (sizes === undefined) return undefined;
        const reservedBytes = sizes.reduce(
          (total, size) => total + size + DATA_FRAME_ADMISSION_OVERHEAD_BYTES,
          0,
        );
        if (!this.#sendQueue.reserveData(frame.channelId, reservedBytes)) return undefined;
        let settled = false;
        return {
          send: (bytes, options = {}) => {
            if (settled) return emit(bytes, options, 0);
            settled = true;
            return emit(bytes, options, reservedBytes);
          },
          release: () => {
            if (settled) return;
            settled = true;
            this.#sendQueue.releaseReservation(frame.channelId, reservedBytes);
          },
        };
      };
      const session = await this.#factory.open({
        channelId: frame.channelId,
        capability: frame.capability,
        effectiveRole: role,
        ...this.#version,
        ...(frame.accountGrantContext === undefined
          ? {}
          : { accountGrantContext: frame.accountGrantContext }),
        connection: this.#connection,
        send,
        admit,
        close: (reason, closeOptions = {}) => {
          queueMicrotask(() => {
            void this.closeChannel(frame.channelId, reason, closeOptions).catch(this.#onFatal);
          });
        },
      });
      if (this.#stopping) {
        await session.close().catch(() => undefined);
        throw new Error("stopping");
      }
      entry = {
        channelId: frame.channelId,
        role,
        session,
        send,
        inboundSequence: 0,
        outboundSequence: 0,
        inboundPaused: false,
        graceFrames: 0,
        closed: false,
      };
      this.#channels.set(key, entry);
      this.#enqueueControl({
        type: "channel.accept",
        ...this.#version,
        channelId: frame.channelId,
      });
    } catch (error: unknown) {
      if (error instanceof RelayChannelQueueError) {
        this.#channels.delete(key);
        await entry?.session.close().catch(() => undefined);
        throw error;
      }
      this.#enqueueControl({
        type: "channel.reject",
        ...this.#version,
        channelId: frame.channelId,
        reason: this.#stopping ? "server_draining" : "channel_rejected",
      });
    } finally {
      this.#preparing.delete(key);
    }
    // Announced only once the channel is live, and only after the accept, so a
    // session that must put something at outbound sequence 0 has a point at
    // which the send handle will actually take it. Awaited rather than
    // fire-and-forget: an asynchronous announcement that raced the first
    // inbound frame would emit its "first" message after other traffic, which
    // is exactly what a sequence-0 carrier cannot do. Awaiting it here is what
    // costs the connection's frame chain, which is why the announcement
    // contract bounds what it may do and `#announce` enforces that bound.
    const accepted = this.#channels.get(key);
    const onAccepted = accepted?.session.onAccepted;
    if (accepted === undefined || accepted.closed || onAccepted === undefined) return;
    try {
      await this.#announce(onAccepted.bind(accepted.session));
    } catch {
      // Deliberately the same reason a session that fails to open at all
      // produces. A distinguishable "internal" close here would partition an
      // announcement failure from every other open-time rejection on the wire,
      // and the protocols that use this seam require those to be
      // indistinguishable.
      await this.closeChannel(frame.channelId, "channel_rejected").catch(this.#onFatal);
    }
  }

  async #data(frame: RelayDataFrame): Promise<void> {
    const entry = this.#channels.get(frame.channelId as string);
    if (entry === undefined || entry.closed) {
      this.#assertRecentlyClosed(frame.channelId);
      return;
    }
    if (
      (frame.sequence as number) !== entry.inboundSequence ||
      entry.inboundSequence > 0xffff_ffff
    ) {
      await this.closeChannel(frame.channelId, "channel_rejected");
      return;
    }
    if (frame.payload.byteLength > this.#limits.maxDataChunkBytes) {
      await this.closeChannel(frame.channelId, "transfer_limit");
      return;
    }
    if (entry.inboundPaused) {
      entry.graceFrames += 1;
      // One message can now arrive as many frames, so a one-frame grace would
      // kill a channel mid-message the instant it paused. Allow a whole
      // maximum-size message to land, plus one.
      if (entry.graceFrames > this.#graceFrameAllowance()) {
        await this.closeChannel(frame.channelId, "slow_consumer");
        return;
      }
    }
    const aggregateQueued = (
      await Promise.all(
        [...this.#channels.values()].map((channel) => channel.session.queuedBytes()),
      )
    ).reduce((total, value) => total + value, 0);
    if (
      aggregateQueued + frame.payload.byteLength >
      this.#limits.maxQueuedBytes - this.#limits.maxControlFrameBytes
    ) {
      await this.closeChannel(frame.channelId, "slow_consumer");
      return;
    }
    const accepted = await entry.session.receive(Uint8Array.from(frame.payload));
    if (!accepted) {
      await this.closeChannel(frame.channelId, "slow_consumer");
      return;
    }
    // A session may close its own channel while this await is outstanding, and
    // so may a refused send scheduled before it. Neither leaves anything to
    // account for here.
    if (entry.closed) return;
    entry.inboundSequence += 1;
    const queuedBytes = await entry.session.queuedBytes();
    if (!entry.inboundPaused && queuedBytes >= Math.floor(this.#channelBudget() * 0.75)) {
      entry.inboundPaused = true;
      entry.graceFrames = 0;
      this.#enqueueControl({
        type: "flow.pause",
        ...this.#version,
        channelId: frame.channelId,
      });
    }
  }

  #enqueueControl(frame: RelayControlFrame): void {
    if (!this.#sendQueue.enqueueControl(frame)) throw new RelayChannelQueueError();
    this.#onOutboundReady();
  }
}
