import {
  RELAY_AUTHORIZED_CHANNEL_MINOR,
  RELAY_AUTHENTICATION_DEADLINE_MS,
  RELAY_MAX_CONTROL_FRAME_BYTES,
  RELAY_MAX_DATA_CHUNK_BYTES,
  RELAY_MAX_RPC_MESSAGE_BYTES,
  RELAY_MAX_DATA_FRAME_BYTES,
  RELAY_MAX_DATA_FRAME_OVERHEAD_BYTES,
  RELAY_PROTOCOL_MAJOR,
  RELAY_PROTOCOL_MINOR,
  RELAY_CLOSE_REASONS,
  type RelayChannelId,
  type RelayAccountGrantContext,
  type RelayCloseReason,
  type RelayEffectiveRole,
  type RelayFrame,
  type RelayLimits,
} from "@ryco/contracts";
import { decodeRelayFrame, encodeRelayFrame } from "@ryco/shared/relayCodec";
import {
  e2eeChannelSizeBudget,
  e2eeNegotiationBufferMaxBytes,
  E2EE_CLIENT_HELLO_MAX_BYTES,
  E2EE_ENVELOPE_OVERHEAD_BYTES,
} from "@ryco/shared/relayE2eeConstants";
import {
  planRelayMessage,
  prepareRelayMessage,
  RELAY_CHUNK_CAPABILITY_PRELUDE,
  RelayMessageAssembler,
} from "@ryco/shared/relayMessageChunks";

import { decodeBase64Url } from "./base64url.ts";
import type {
  HostedRelayFailure,
  HostedRelayTransportStatus,
  HostedRycoSessionStatus,
} from "../authorization/types.ts";

const VERSION = {
  protocolMajor: RELAY_PROTOCOL_MAJOR,
  protocolMinor: RELAY_PROTOCOL_MINOR,
} as const;
const OPEN = 1;
/** Per-entry bookkeeping headroom so the send bound accounts for queue overhead. */
const QUEUE_ENTRY_OVERHEAD_BYTES = 32;
/**
 * Send-queue capacity the §4.4 buffer never takes: the one bounded
 * `E2EEClientHello` a `negotiating` channel may still have to emit (§8.5) and
 * the payload overhead the queue charges for it.
 *
 * `E2EE_NEGOTIATION_BUFFER_MAX_BYTES` is the same aggregate the send queue
 * enforces, so without this reserve buffered application bytes are entitled to
 * all of it — and then `host.admit` refuses the hello, while §4.4's
 * no-legacy-after-validated-evidence rule leaves the client only FATAL-PRE.
 * That is ordinary backpressure escalated into a non-retryable close, which
 * §11.4 forbids; refusing the submission that would have taken the last of the
 * budget is the disposition §11.4 asks for instead. §4.4's bound is a ceiling,
 * so holding the buffer below it conforms.
 */
const E2EE_NEGOTIATION_HANDSHAKE_RESERVE_BYTES =
  E2EE_CLIENT_HELLO_MAX_BYTES +
  RELAY_CHUNK_CAPABILITY_PRELUDE.byteLength +
  QUEUE_ENTRY_OVERHEAD_BYTES;

function relayQueueCharge(payloadBytes: readonly number[]): number {
  let charge = 0;
  for (const bytes of payloadBytes) charge += bytes + QUEUE_ENTRY_OVERHEAD_BYTES;
  return charge;
}

/**
 * Platform socket seam. Implementations must not copy, retain, or re-send any
 * buffer passed to send: relay ticket and frame ownership remains with engine.
 */
export interface RelaySocket {
  readonly bufferedAmount: number;
  readonly readyState: number;
  send(bytes: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onOpen(listener: () => void): void;
  onBinaryMessage(listener: (bytes: Uint8Array) => void): void;
  onClose(listener: (reason?: string) => void): void;
  onError(listener: () => void): void;
}
export interface RelayTimers {
  now(): number;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  queueMicrotask(cb: () => void): void;
}
export interface HostedRelaySocketCallbacks {
  onTransportStatus(status: HostedRelayTransportStatus): void;
  onSessionStatus(status: HostedRycoSessionStatus): void;
  onRole(role: RelayEffectiveRole | null): void;
  onFailure(failure: HostedRelayFailure): void;
}
export interface RelayEngineEvents {
  onOpen(): void;
  onData(bytes: Uint8Array): void;
  onError(): void;
  onClose(code: number, reason: string): void;
}

// ─── the E2EE seam (docs/relay-e2ee-protocol.md §4, §9, §10) ─────────────────
//
// The engine owns relay framing and the send queue; it owns no key material, no
// record protection, and no close machine. Everything this protocol adds is
// reached through the OPTIONAL provider below, and a caller that supplies none
// gets the byte-identical frame sequence it got before the seam existed. THE
// TIER IS NEVER AN ENGINE-INTERNAL CONSTANT: what the engine knows is that a
// provider exists, and every decision the protocol makes belongs to it.

/**
 * §9.3 "reserve before you encrypt": send-queue capacity held for EVERY payload
 * of one record — every chunk of it — before the record's `(epoch, counter)`
 * pair is assigned and before the AEAD runs.
 *
 * A reservation is spent exactly once. `send` is all-or-nothing precisely
 * because the capacity is already held: `false` therefore means no byte of the
 * record reached the relay, which is §9.3's `none` branch and not backpressure.
 */
export interface RelayE2eeReservation {
  send(message: Uint8Array): boolean;
  /** Give the capacity back; the record was never built. */
  release(): void;
}

/**
 * §4.4: what a channel's mode machine locked it to. There are only these two
 * transitions out of `negotiating`, they are one-way, and exactly one of them
 * happens on any channel that is released to the application at all.
 */
export type RelayE2eeMode = "e2ee" | "legacy";

/**
 * §8.3 elements 2, 13, and 14, plus the §8.4 prologue's protocol version.
 *
 * The engine hands the mode machine the `channel.open` IT RECEIVED rather than
 * letting the machine's owner configure the same values from application state:
 * §8.3 requires elements 11–12 to byte-equal elements 13–14 at both endpoints,
 * and a second source for the received half would be a second thing that can
 * disagree with the frame that actually arrived.
 */
export interface RelayE2eeChannelIdentity {
  readonly channelId: string;
  readonly capability: string;
  readonly effectiveRole: string;
  readonly relayProtocolMajor: number;
  readonly relayProtocolMinor: number;
  /** Exact authenticated relay-minor-3 context carried by this channel.open. */
  readonly accountGrantContext?:
    | {
        readonly relayTicketId: string;
        readonly deviceGrantDigest: Uint8Array;
        readonly nodeCapabilityStatementDigest: Uint8Array;
      }
    | undefined;
}

/** The engine surface one E2EE channel drives, and no more of it. */
export interface RelayE2eeHost {
  /** §4.5: the Hub-asserted `ready` limits, adopted verbatim. */
  readonly limits: RelayLimits;
  /** §8.3: the `channel.open` this endpoint received, and nothing derived from it. */
  readonly channel: RelayE2eeChannelIdentity;
  /** §9.3: admission for the entire record; `undefined` refuses it. */
  readonly admit: (messageBytes: number) => RelayE2eeReservation | undefined;
  /**
   * §4.4: THE RELEASE VALVE, and its single owner.
   *
   * Nothing is released to the application before a mode is locked — not the
   * open event, not one inbound payload, and not one buffered outbound byte.
   * The engine no longer opens the valve at `channel.accept`, because a channel
   * that is `negotiating` has decided nothing yet: it may still lock `e2ee`
   * (rows K1/K5), lock `legacy` (rows K9/K13), or close FATAL-PRE without ever
   * releasing anything. Calling it flushes the §4.4 send buffer in the way the
   * locked mode requires — as envelopes, or as plaintext — and then opens.
   *
   * One-way and idempotent: a second call, or one after the channel closed, is
   * ignored rather than obeyed (§4.4 mode transitions are one-way).
   */
  readonly lockMode: (mode: RelayE2eeMode) => void;
  /**
   * The outer relay close (§10.3). With no failure this is the reasonless
   * `channel.close` that follows a clean exchange; with one it is §11.1's
   * fatal teardown.
   */
  readonly close: (failure?: HostedRelayFailure) => void;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (id: unknown) => void;
}

/**
 * What one inbound, reassembled, prelude-stripped payload becomes (§4.3).
 * `rejected` means the channel has already emitted whatever §11 record the
 * condition calls for and asked for the outer close.
 */
export type RelayE2eeInboundDisposition =
  | { readonly kind: "rpc"; readonly message: Uint8Array }
  | { readonly kind: "claimed" }
  | { readonly kind: "rejected" };

/**
 * What one §10.2 close attempt did to the channel.
 *
 * `refused` is §11.4 and nothing else: the `E2EEClose` obtained no transmission
 * admission, so no pair was consumed, no wire record of any kind was produced,
 * and NO CLOSE PHASE OPENED — nothing is owed, no `T_CLOSE` wait is armed, and
 * nothing bounds the channel. The caller must be able to ask again, because
 * ordinary backpressure MUST NOT be escalated into a channel that can never be
 * closed cleanly.
 */
export type RelayE2eeCloseAttempt = "opened" | "refused";

export interface RelayE2eeChannel {
  /** §4.3: discriminate, authenticate, and dispatch one inbound payload. */
  readonly intercept: (payload: Uint8Array) => Promise<RelayE2eeInboundDisposition>;
  /** §4.2: synchronously reserve one outbound RPC record before copying it. */
  readonly submit: (message: Uint8Array) => boolean;
  /** §10: begin the authenticated close; the channel asks for the outer one. */
  readonly beginClose: () => Promise<RelayE2eeCloseAttempt>;
  /** §9.5, §10.4: the channel ended. Idempotent. */
  readonly dispose: (options?: { readonly incompleteReassembly?: boolean }) => void;
}

/**
 * Built once per channel, at `channel.accept`, from the negotiated limits.
 *
 * What it returns is the channel's §4.4 MODE MACHINE, not an established
 * session: at `channel.accept` nothing has been negotiated, and every inbound
 * payload from that instant belongs to the machine until it locks a mode. A
 * caller that supplies no provider gets no machine, an immediate `legacy` lock,
 * and the byte-identical frame sequence it got before the seam existed.
 */
export type RelayE2eeProvider = (host: RelayE2eeHost) => RelayE2eeChannel;

/**
 * §11.4 `e2ee_send_unavailable`, in the one form this engine can raise it: the
 * §4.4 negotiation send buffer is already at `E2EE_NEGOTIATION_BUFFER_MAX_BYTES`.
 *
 * Exported because both facades map the engine's send errors and this one is a
 * NEW refusal reason rather than a re-shaped old one. It is deliberately
 * distinct from `"Relay send queue is full."`: that one has already failed the
 * channel with `slow_consumer`, and this one leaves the channel completely
 * unaffected — §11.4 forbids escalating ordinary backpressure to channel-fatal,
 * and forbids a silent drop just as firmly.
 */
export const RELAY_E2EE_NEGOTIATION_BUFFER_FULL_MESSAGE =
  "Relay E2EE negotiation send buffer is full.";

/** §11.4: an established E2EE record could not reserve aggregate send capacity. */
export const RELAY_E2EE_SEND_UNAVAILABLE_MESSAGE = "Relay E2EE send is unavailable.";

/**
 * The other three send refusals, named for the same reason.
 *
 * Both facades classify this engine's send errors BY MESSAGE, so the strings
 * are part of the engine's contract rather than of its prose: a renamed message
 * silently re-routes a refusal at every boundary that maps it. They are
 * exported so the mapping and the throw read from one definition — the web
 * facade matched a fourth string for a while that nothing here had thrown since
 * the oversized-RPC framing change renamed it.
 */
export const RELAY_MESSAGE_TOO_LARGE_MESSAGE =
  "RPC payload exceeds the maximum relay message size.";
export const RELAY_PEER_UNSUPPORTED_MESSAGE =
  "Relay peer does not support multi-frame RPC messages.";
export const RELAY_SEND_QUEUE_FULL_MESSAGE = "Relay send queue is full.";

/** The engine's view of §4.4's three channel states. */
type RelayEngineMode = "negotiating" | RelayE2eeMode;

/**
 * Every way an E2EE channel ends the connection. §11.1 introduces no close
 * reason of its own, so all of them take the existing `channel_rejected`, and
 * none may reach the retryable `internal` default below: a channel that failed
 * a cryptographic check must not be reconnected into the same failure.
 */
export type RelayE2eeFailureKind =
  /** §11.2: a pre-key fatal condition, including §4.5's unestablishable channel. */
  | "fatal_pre_key"
  /** §11.3: a post-key fatal condition. */
  | "fatal_post_key"
  /** §11.3 Q10: a local send failure no byte of which reached the relay. */
  | "send_path_unusable";

/**
 * §11.1 and §11.5: one close reason for every E2EE-fatal condition, written as
 * a table so the uniform observable is a fact of the code rather than of three
 * call sites that happen to agree today.
 */
const RELAY_E2EE_CLOSE_REASONS: Readonly<Record<RelayE2eeFailureKind, RelayCloseReason>> = {
  fatal_pre_key: "channel_rejected",
  fatal_post_key: "channel_rejected",
  send_path_unusable: "channel_rejected",
};

export interface RelayEngineOptions {
  ticket: string;
  ticketExpiresAt: number;
  socket: RelaySocket;
  timers: RelayTimers;
  callbacks: HostedRelaySocketCallbacks;
  events: RelayEngineEvents;
  /** §4: the E2EE channel factory. Absent means an unchanged legacy channel. */
  e2ee?: RelayE2eeProvider;
}

interface QueuedPayload {
  readonly bytes: Uint8Array;
  readonly reservedBytes: number;
}

interface OutboundReservationToken {
  readonly reservedBytes: number;
  active: boolean;
}

function failure(reason: RelayCloseReason | "protocol_invalid" | "network"): HostedRelayFailure {
  if (
    [
      "node_offline",
      "server_draining",
      "connection_replaced",
      "rate_limited",
      "slow_consumer",
    ].includes(reason)
  )
    return {
      kind:
        reason === "node_offline"
          ? "offline"
          : reason === "server_draining"
            ? "draining"
            : reason === "connection_replaced"
              ? "replacement"
              : reason === "rate_limited"
                ? "rate-limited"
                : "slow-consumer",
      retryable: true,
      closeReason: reason as RelayCloseReason,
    };
  if (["revoked", "node_revoked", "grant_revoked"].includes(reason))
    return {
      kind: "revoked",
      retryable: false,
      closeReason: reason as RelayCloseReason,
    };
  if (reason === "authorization_failed")
    return {
      kind: "authorization-removed",
      retryable: false,
      closeReason: reason,
    };
  if (
    [
      "authentication_failed",
      "authentication_required",
      "ticket_expired",
      "ticket_consumed",
      "authentication_timeout",
    ].includes(reason)
  )
    return {
      kind: "authentication",
      retryable: reason !== "authentication_required",
      closeReason: reason as RelayCloseReason,
    };
  if (reason === "protocol_unsupported")
    return { kind: "incompatible", retryable: false, closeReason: reason };
  if (
    ["protocol_invalid", "frame_too_large", "channel_rejected", "transfer_limit"].includes(reason)
  )
    return {
      kind: "protocol",
      retryable: false,
      ...(reason === "protocol_invalid" ? {} : { closeReason: reason as RelayCloseReason }),
    };
  return reason === "network"
    ? { kind: "network", retryable: true }
    : {
        kind: "internal",
        retryable: true,
        closeReason: reason as RelayCloseReason,
      };
}

/**
 * The failure an E2EE-fatal condition reports. Non-retryable by construction:
 * it routes through the `channel_rejected` row above, so no E2EE condition can
 * reach the retryable `internal` default and have the transport reconnect into
 * the same cryptographic failure.
 */
export function relayE2eeFailure(kind: RelayE2eeFailureKind): HostedRelayFailure {
  return failure(RELAY_E2EE_CLOSE_REASONS[kind]);
}

/**
 * The client declining to open a channel because it had no resolved §4.4
 * attempt to build the machine from. LOCAL, and not a cryptographic verdict.
 *
 * The WIRE observable is §11.5's uniform one — the same `channel_rejected` every
 * other pre-key close carries, so this is indistinguishable from any other
 * refusal — but the LOCAL disposition is retryable, and that difference is the
 * whole point. `relayE2eeFailure` is non-retryable because "a channel that
 * failed a cryptographic check must not be reconnected into the same failure";
 * nothing here failed a check. The attempt reads a keychain and a secure store,
 * and the next ticket resolves into a warm slot, so borrowing the non-retryable
 * disposition would take the whole hosted session to `terminal-failure` — no
 * automatic recovery, until the owner reselects the node — for a launch race
 * that costs one channel.
 */
export function relayE2eeUnresolvedAttemptFailure(): HostedRelayFailure {
  return { kind: "protocol", retryable: true, closeReason: "channel_rejected" };
}

export class HostedRelayEngine {
  readonly options: RelayEngineOptions;
  #limits: RelayLimits | null = null;
  /** The relay-selected version, bounded by the version offered in `auth`. */
  #protocol: { readonly protocolMajor: number; readonly protocolMinor: number } | null = null;
  #channel: RelayChannelId | null = null;
  #accountGrantContext: RelayAccountGrantContext | undefined;
  #accepted = false;
  #role: RelayEffectiveRole | null = null;
  #inboundSequence = 0;
  #outboundSequence = 0;
  #outboundPaused = false;
  #outboundQueue: QueuedPayload[] = [];
  #outboundQueuedBytes = 0;
  #inboundQueue: Uint8Array[] = [];
  #inboundQueuedBytes = 0;
  #inboundPaused = false;
  #drainingInbound = false;
  #closed = false;
  #reported = false;
  #auth: Uint8Array | null = null;
  #authTimer: unknown = null;
  #flushTimer: unknown = null;
  #e2ee: RelayE2eeChannel | null = null;
  /**
   * §4.4, which creates the channel's machine at `channel.accept`.
   *
   * Before that instant nothing may be sent or delivered anyway — `send` refuses
   * an unaccepted channel and `#receiveData` rejects data on one — so starting
   * here costs nothing and buys the one property that matters: the ONLY way out
   * of this state is `#applyModeLock`, on every path, with a provider or
   * without one.
   */
  #mode: RelayEngineMode = "negotiating";
  /** A `lockMode` a provider issued from inside its own factory (§4.4). */
  #pendingLock: RelayE2eeMode | null = null;
  /**
   * §4.4: the plaintext an E2EE-capable client holds while `negotiating` — the
   * RPC keepalive `Ping` included — and the ONLY sink `send` has in that state.
   *
   * The buffer sits ABOVE the relay send queue precisely so that nothing is
   * handed down to it, so it does not inherit the queue's accounting and is
   * charged explicitly against `E2EE_NEGOTIATION_BUFFER_MAX_BYTES`. §4.4 makes
   * that charge PER RELAY CONNECTION rather than per channel; this engine drives
   * one channel per connection, so the two coincide here and the field is the
   * connection-wide total by construction rather than by an accident that a
   * second channel would break silently.
   */
  #negotiationBuffer: Uint8Array[] = [];
  #negotiationBufferedBytes = 0;
  /** §9.3: capacity held by admitted records that have not yet been queued. */
  #outboundReservedBytes = 0;
  /** Close invalidates every token so a late release cannot debit the next lifecycle. */
  readonly #outboundReservations = new Set<OutboundReservationToken>();
  /** §9.2 requires envelopes to reach `unprotect` in arrival order. */
  #e2eeInbound: Promise<void> = Promise.resolve();
  /** A §10 close attempt is in flight, or its phase opened. Never both at once. */
  #e2eeClosing = false;
  /** The application asked for the close; it stands until one attempt opens a phase. */
  #e2eeCloseRequested = false;

  constructor(options: RelayEngineOptions) {
    this.options = options;
    if (options.ticketExpiresAt <= options.timers.now())
      throw new Error("Relay attempt is no longer valid.");
    const ticket = decodeBase64Url(options.ticket);
    try {
      const encoded = encodeRelayFrame({
        type: "auth",
        peer: "client",
        ...VERSION,
        relayTicket: ticket,
      });
      if (!encoded.ok) throw new Error("Relay authentication could not be encoded.");
      this.#auth = encoded.value;
    } finally {
      ticket.fill(0);
    }
    options.callbacks.onTransportStatus("connecting");
    options.socket.onOpen(() => this.#open());
    options.socket.onBinaryMessage((bytes) => this.#receive(bytes));
    options.socket.onError(() => {
      if (!this.#closed) options.events.onError();
    });
    options.socket.onClose((reason) => {
      if (this.#closed) return;
      // Upgrade authentication can fail before the relay sends a control frame.
      // Preserve only canonical reasons; arbitrary server text is never surfaced.
      const knownReason = RELAY_CLOSE_REASONS.find((candidate) => candidate === reason);
      this.#fail(failure(knownReason ?? "network"));
    });
  }

  /** Socket backpressure plus everything still awaiting a flow.resume flush. */
  readonly #assembler = new RelayMessageAssembler();

  get bufferedAmount(): number {
    return (
      this.options.socket.bufferedAmount +
      this.#outboundQueuedBytes +
      this.#outboundReservedBytes +
      this.#negotiationBufferedBytes
    );
  }

  /**
   * One outbound RPC message, dispatched by the channel's §4.4 mode.
   *
   * THE `negotiating` BRANCH RETURNS BEFORE ANY OTHER STATEMENT RUNS, and that
   * is the structural guarantee rather than an ordering preference: §4.4 forbids
   * transmitting ANY plaintext while `negotiating`, including the RPC keepalive
   * `Ping` that Effect's connection hooks write several layers above this seam
   * and that nothing here can otherwise decline. With the buffer as the only
   * reachable sink, a caller that ignores the mode cannot put a plaintext byte
   * on the wire — there is no path from this state to `#enqueueOutbound`.
   */
  send(payload: Uint8Array): void {
    // Outbound RPC is only permitted after the authorization handshake fully
    // completes (channel.accept); a channel that is merely open is not enough.
    if (this.#closed || !this.#accepted || !this.#channel || !this.#limits)
      throw new Error("Relay channel is not open.");
    if (this.#mode === "negotiating") return this.#bufferNegotiating(payload, this.#limits);
    // `legacy` is the ONLY mode that may reach the plaintext path. The dispatch
    // is exhaustive on the mode rather than conditional on the channel being
    // present, because the failure direction of a missing channel is the one
    // this seam must never take: a mode machine that locked `e2ee` putting
    // application plaintext on the wire.
    if (this.#mode === "e2ee") return this.#emitE2ee(payload);
    this.#sendPlaintext(payload);
  }

  /**
   * §4.2: the E2EE layer owns the whole send pipeline from the ceiling check to
   * the reservation, so nothing is chunked or queued here. A record it refuses
   * is §11.4 sender-local — no pair consumed, no wire record, channel unaffected
   * — and is surfaced synchronously with the stable send-unavailable error. A
   * close-phase keepalive receives that same observable refusal; neither case
   * fails the channel or falls back to plaintext.
   */
  #emitE2ee(payload: Uint8Array): void {
    const channel = this.#e2ee;
    // Unreachable by construction — `#e2ee` is cleared only by `#finish`, which
    // sets `#closed` first, and every caller here refuses a closed engine — and
    // fatal rather than silent if it ever stops being: §11.3 Q10 is a local send
    // failure no byte of which reached the relay.
    if (!channel) return this.#failE2ee(relayE2eeFailure("send_path_unusable"));
    let admitted: boolean;
    try {
      admitted = channel.submit(payload);
    } catch (cause) {
      this.#failE2ee(relayE2eeFailure("fatal_post_key"));
      throw cause;
    }
    if (!admitted) throw new Error(RELAY_E2EE_SEND_UNAVAILABLE_MESSAGE);
  }

  /** The unchanged legacy send path: the chunk layer, then the relay send queue. */
  #sendPlaintext(payload: Uint8Array): void {
    const prepared = prepareRelayMessage(payload, this.#messageLimits(this.#limits!));
    if (prepared.kind === "error") {
      payload.fill(0);
      this.#fail(failure("transfer_limit"));
      throw new Error(
        prepared.reason === "peer_unsupported"
          ? RELAY_PEER_UNSUPPORTED_MESSAGE
          : RELAY_MESSAGE_TOO_LARGE_MESSAGE,
      );
    }
    for (const chunk of prepared.payloads) {
      this.#enqueueOutbound(Uint8Array.from(chunk));
    }
  }

  /**
   * §4.4: hold one plaintext submission until the channel locks a mode.
   *
   * BOTH HALVES OF §4.4'S BOUND ARE APPLIED HERE, AT SUBMISSION, because the
   * only other moment either could be applied is the flush — where there is no
   * caller left to refuse and the disposition degenerates into the two things
   * §4.4 and §11.4 forbid outright: a silent drop on the `e2ee` sink, whose
   * `submit` refuses an over-ceiling body, and a channel-fatal `transfer_limit` or
   * `slow_consumer` on the plaintext one.
   *
   * 1. "Each buffered send MUST satisfy the §4.5 per-message bounds at
   *    submission time." The mode is undecided here, so the bound is the tighter
   *    of the two sinks — §4.5's `plaintextCeiling`, the legacy ceiling less the
   *    envelope overhead — and the layout is the one the plaintext flush would
   *    produce. A submission is therefore refused at exactly the moment an
   *    unbuffered legacy channel would have refused it, with that channel's own
   *    message, so a caller sees one refusal shape rather than one per mode.
   * 2. The total is charged "as though the bytes had already been enqueued"
   *    against "the same aggregate budget the relay send queue enforces". The
   *    mode is still undecided, so the charge is the larger of the legacy
   *    plaintext layout and the eventual encrypted-envelope layout, including
   *    every planned payload and its per-entry overhead. A buffer at its bound
   *    is then flushable through either sink AND leaves the hello admissible.
   *
   * The overflow is §11.4 `e2ee_send_unavailable` and nothing else: no wire
   * record of any kind is produced, the channel is UNAFFECTED and remains
   * usable, and the caller is told rather than having its message silently
   * dropped or the buffer grown without bound. It deliberately does not zero the
   * caller's payload and does not fail the channel — both of which the
   * already-full relay send queue does, because that refusal is a slow-consumer
   * condition and this one is not. Neither does the size refusal above: §11.4's
   * `e2ee_message_too_large` is sender-local and leaves the channel usable.
   */
  #bufferNegotiating(payload: Uint8Array, limits: RelayLimits): void {
    if (payload.byteLength > e2eeChannelSizeBudget(limits).plaintextCeiling)
      throw new Error(RELAY_MESSAGE_TOO_LARGE_MESSAGE);
    const legacyPlan = planRelayMessage(payload.byteLength, this.#messageLimits(limits));
    if (legacyPlan.kind === "error")
      throw new Error(
        legacyPlan.reason === "peer_unsupported"
          ? RELAY_PEER_UNSUPPORTED_MESSAGE
          : RELAY_MESSAGE_TOO_LARGE_MESSAGE,
      );
    const e2eePlan = planRelayMessage(
      E2EE_ENVELOPE_OVERHEAD_BYTES + payload.byteLength,
      this.#messageLimits(limits),
    );
    if (e2eePlan.kind === "error")
      throw new Error(
        e2eePlan.reason === "peer_unsupported"
          ? RELAY_PEER_UNSUPPORTED_MESSAGE
          : RELAY_MESSAGE_TOO_LARGE_MESSAGE,
      );
    const charge = Math.max(
      relayQueueCharge(legacyPlan.payloadBytes),
      relayQueueCharge(e2eePlan.payloadBytes),
    );
    const budget = Math.max(
      0,
      e2eeNegotiationBufferMaxBytes(limits) - E2EE_NEGOTIATION_HANDSHAKE_RESERVE_BYTES,
    );
    if (this.bufferedAmount + charge > budget)
      throw new Error(RELAY_E2EE_NEGOTIATION_BUFFER_FULL_MESSAGE);
    this.#negotiationBuffer.push(Uint8Array.from(payload));
    this.#negotiationBufferedBytes += charge;
  }

  close(code = 1000, reason = "closed"): void {
    if (this.#closed) return;
    // §10 exists only inside `e2ee`. A `negotiating` channel holds no session
    // keys and owes no authenticated close: it takes the outer close below, and
    // `#finish` discards its buffered plaintext on the way out.
    if (this.#mode === "e2ee" && this.#e2ee) {
      // §10.3 lower bound: the outer `channel.close` MUST NOT be emitted until
      // the authenticated exchange has produced the encrypted peer proof this
      // endpoint's role requires, or `T_CLOSE` expires. Enqueueing one's own
      // final records is never sufficient, so the channel — not this method —
      // decides when the frame below goes out, through `host.close`. A repeat
      // call while a phase is open is therefore a no-op rather than a shortcut
      // past that bound; the phase is bounded by `T_CLOSE` and ends on its own.
      this.#e2eeCloseRequested = true;
      this.options.callbacks.onTransportStatus("draining");
      this.#attemptE2eeClose();
      return;
    }
    this.#outerClose(code, reason);
  }

  /**
   * §10.2, §11.4: ask the channel to open its close phase, and keep the request
   * standing until one attempt does.
   *
   * A refused attempt opened nothing — no pair consumed, no wire record, no
   * `T_CLOSE` wait armed — so latching on the attempt rather than on its outcome
   * would turn ordinary send-queue backpressure into a channel that can never be
   * closed cleanly, with its §6.5 session secrets never erased. The retry is
   * driven from the outbound drain below, which is where the capacity a refusal
   * was waiting for actually comes back.
   */
  #attemptE2eeClose(): void {
    const channel = this.#e2ee;
    if (this.#closed || !channel || this.#e2eeClosing || !this.#e2eeCloseRequested) return;
    this.#e2eeClosing = true;
    void channel.beginClose().then(
      (outcome) => {
        if (outcome === "refused" && !this.#closed && this.#e2ee === channel) {
          this.#e2eeClosing = false;
        }
      },
      () => this.#failE2ee(relayE2eeFailure("fatal_post_key")),
    );
  }

  #outerClose(code: number, reason: string): void {
    if (this.#closed) return;
    this.#e2eeClosing = true;
    this.options.callbacks.onTransportStatus("draining");
    // §10.3 and §11.3: this endpoint's own final records go out AHEAD of the
    // frame that ends the channel. `#finish` discards whatever is still queued
    // and the control frame below is written straight to the socket, so a close
    // emitted over a non-empty queue destroys the very close-machine record or
    // `E2EEError` the peer needs — after the sequence pair for it was spent.
    this.#flushOutbound(true);
    if (this.#channel)
      this.#frame({
        type: "channel.close",
        ...this.#wireVersion(),
        channelId: this.#channel,
      });
    this.#finish(code, reason);
  }

  /**
   * Fail closed on a platform message the browser adapter could not read as
   * relay bytes. The DOM boundary classifies the cause and passes the matching
   * relay reason — a non-binary payload maps to an oversized frame, a raw
   * SharedArrayBuffer to an invalid frame — preserving the original semantics.
   */
  reportUndecodableMessage(reason: "frame_too_large" | "protocol_invalid"): void {
    this.#fail(failure(reason));
  }

  #open(): void {
    if (this.#closed || !this.#auth) return;
    const auth = this.#auth;
    // Spend the frame before calling the socket: test transports and loopback
    // relays may synchronously re-enter this engine with `ready` or another
    // `open`. Neither may observe reusable ticket-bearing bytes.
    this.#auth = null;
    this.options.callbacks.onTransportStatus("authenticating");
    this.#authTimer = this.options.timers.setTimeout(
      () => this.#fail(failure("authentication_timeout")),
      RELAY_AUTHENTICATION_DEADLINE_MS,
    );
    try {
      this.options.socket.send(auth);
    } catch {
      this.#fail(failure("network"));
    } finally {
      auth.fill(0);
    }
  }

  #receive(bytes: Uint8Array): void {
    if (bytes.byteLength > RELAY_MAX_DATA_FRAME_BYTES)
      return this.#fail(failure("frame_too_large"));
    const owned = Uint8Array.from(bytes);
    const decoded = decodeRelayFrame(
      owned,
      this.#protocol === null ? {} : { expectedVersion: this.#protocol },
    );
    owned.fill(0);
    if (!decoded.ok) return this.#fail(failure("protocol_invalid"));
    const frame = decoded.value;
    const negotiatedFrameLimit =
      frame.type === "data"
        ? (this.#limits?.maxDataChunkBytes ?? RELAY_MAX_DATA_CHUNK_BYTES) +
          RELAY_MAX_DATA_FRAME_OVERHEAD_BYTES
        : (this.#limits?.maxControlFrameBytes ?? RELAY_MAX_CONTROL_FRAME_BYTES);
    if (bytes.byteLength > negotiatedFrameLimit) return this.#fail(failure("frame_too_large"));
    if (frame.type === "ping")
      return this.#frame({
        type: "pong",
        ...this.#wireVersion(),
        nonce: Uint8Array.from(frame.nonce),
      });
    if (frame.type === "error") {
      const classified = failure(
        frame.code === "invalid_encoding" ||
          frame.code === "invalid_frame" ||
          frame.code === "invalid_limits" ||
          frame.code === "missing_discriminant" ||
          frame.code === "unknown_frame_type"
          ? "protocol_invalid"
          : frame.code,
      );
      return this.#fail({
        ...classified,
        ...(frame.retryAfterMs === undefined ? {} : { retryAfterMs: frame.retryAfterMs }),
      });
    }
    if (!this.#limits) {
      if (
        frame.type !== "ready" ||
        frame.protocolMajor !== RELAY_PROTOCOL_MAJOR ||
        frame.protocolMinor < RELAY_AUTHORIZED_CHANNEL_MINOR ||
        frame.protocolMinor > RELAY_PROTOCOL_MINOR
      )
        return this.#fail(
          failure(frame.type === "ready" ? "protocol_unsupported" : "protocol_invalid"),
        );
      this.#protocol = {
        protocolMajor: frame.protocolMajor,
        protocolMinor: frame.protocolMinor,
      };
      this.#limits = frame.limits;
      if (this.#authTimer) this.options.timers.clearTimeout(this.#authTimer);
      this.#authTimer = null;
      this.options.callbacks.onTransportStatus("opening-channel");
      return;
    }
    if (frame.type === "channel.open") {
      if (this.#channel || frame.capability !== "ryco.rpc" || !frame.effectiveRole)
        return this.#fail(failure("channel_rejected"));
      this.#channel = frame.channelId;
      this.#accountGrantContext = frame.accountGrantContext;
      this.#role = frame.effectiveRole;
      this.options.callbacks.onRole(this.#role);
      return;
    }
    if (frame.type === "channel.accept") {
      // §4.4 creates the channel's machine at `channel.accept` and destroys it
      // when the channel closes; there is no second acceptance of one channel.
      // A repeat would build a second machine over the first, orphaning its
      // §6.5 secrets unerased and its close timers armed on a channel nothing
      // holds any more — so it is refused rather than obeyed.
      if (this.#accepted || frame.channelId !== this.#channel || !this.#role)
        return this.#fail(failure("channel_rejected"));
      this.#accepted = true;
      if (this.options.e2ee) {
        // §4.4: the channel is `negotiating` from this instant, BEFORE the
        // provider runs. The machine — not this branch — owns the release valve
        // from here, and a provider that throws leaves no window in which a
        // plaintext byte could reach the wire.
        this.#mode = "negotiating";
        this.#openE2eeChannel(this.#limits);
        return;
      }
      this.#applyModeLock("legacy");
      return;
    }
    if (
      frame.type === "channel.close" &&
      frame.reason === undefined &&
      frame.channelId === this.#channel &&
      this.#e2eeClosing
    ) {
      // §10.3: observing the peer's `channel.close` is one of the three events
      // that end this endpoint's linger, and a reasonless one is the relay
      // protocol's orderly close rather than a rejection — §11.1 gives every
      // E2EE-fatal condition a reason. Losing the channel here "changes the
      // peer's verdict, never this endpoint's, and MUST NOT be reported as a
      // failure of this endpoint's exchange"; §10.4 fixed that verdict when the
      // exchange completed or `T_CLOSE` expired, and the channel records the
      // ending itself through `dispose`.
      return this.#outerClose(1000, "closed");
    }
    if (frame.type === "channel.close" || frame.type === "channel.reject")
      return frame.channelId === this.#channel
        ? this.#fail(failure(frame.reason ?? "channel_rejected"))
        : this.#fail(failure("channel_rejected"));
    if (frame.type === "e2ee.enrollment-revoked") {
      return this.#fail(failure("revoked"));
    }
    if (frame.type === "flow.pause" || frame.type === "flow.resume") {
      if (frame.channelId !== this.#channel) return this.#fail(failure("channel_rejected"));
      this.#outboundPaused = frame.type === "flow.pause";
      if (!this.#outboundPaused) this.#flushOutbound();
      return;
    }
    if (frame.type === "data") this.#receiveData(frame);
  }

  /**
   * §4.4: the channel's E2EE machine is created when the channel is accepted
   * and destroyed when it closes. It is built BEFORE `onOpen`, because §4.5
   * requires a channel whose plaintext ceiling is not positive to fail during
   * establishment rather than be released to the application with a silently
   * shrunk one — so a provider that refuses these limits fails the channel here
   * and the application never sees it open.
   */
  #openE2eeChannel(limits: RelayLimits): void {
    try {
      this.#e2ee = this.options.e2ee!({
        limits,
        channel: {
          channelId: this.#channel!,
          // The engine admits exactly one `channel.open`, and only with this
          // capability; the role is whatever that frame presented.
          capability: "ryco.rpc",
          effectiveRole: this.#role!,
          relayProtocolMajor: this.#wireVersion().protocolMajor,
          relayProtocolMinor: this.#wireVersion().protocolMinor,
          ...(this.#accountGrantContext === undefined
            ? {}
            : {
                accountGrantContext: {
                  relayTicketId: this.#accountGrantContext[1],
                  deviceGrantDigest: Uint8Array.from(this.#accountGrantContext[2]),
                  nodeCapabilityStatementDigest: Uint8Array.from(this.#accountGrantContext[3]),
                },
              }),
        },
        admit: (messageBytes) => this.#reserveOutbound(messageBytes),
        lockMode: (mode) => this.#lockMode(mode),
        close: (value) => {
          if (value) return this.#failE2ee(value);
          // §10.3: after a clean exchange the endpoint sends `channel.close`
          // with no reason — the relay protocol's orderly close.
          this.#outerClose(1000, "closed");
        },
        now: () => this.options.timers.now(),
        setTimeout: (callback, ms) => this.options.timers.setTimeout(callback, ms),
        clearTimeout: (id) => this.options.timers.clearTimeout(id),
      });
    } catch {
      this.#failE2ee(relayE2eeFailure("fatal_pre_key"));
      return;
    }
    const pending = this.#pendingLock;
    this.#pendingLock = null;
    if (pending) this.#applyModeLock(pending);
  }

  /**
   * §4.4's release valve, from the machine's side.
   *
   * A lock issued from inside the provider's own factory is held rather than
   * applied: the machine object does not exist yet, so an `e2ee` flush would
   * have nothing to encrypt through. It is applied the moment the factory
   * returns, which keeps the valve's single-owner property exact instead of
   * making it depend on when a provider happens to call.
   */
  #lockMode(mode: RelayE2eeMode): void {
    if (this.#closed || this.#mode !== "negotiating") return;
    if (!this.#e2ee) {
      this.#pendingLock = mode;
      return;
    }
    this.#applyModeLock(mode);
  }

  /**
   * Lock the mode, flush what §4.4 held, and release the channel — in that
   * order, because the buffered sends are the ones the application submitted
   * FIRST and §8.9 makes the first envelope after an `e2ee` lock the client's
   * implicit finish.
   *
   * One-way and once: `negotiating` is the only state this leaves, so a second
   * call is ignored (§4.4 mode transitions are one-way).
   */
  #applyModeLock(mode: RelayE2eeMode): void {
    if (this.#closed || this.#mode !== "negotiating") return;
    this.#mode = mode;
    this.#flushNegotiationBuffer(mode);
    // THE VALVE OPENS ONLY FOR A CHANNEL THAT IS STILL THERE. The flush swallows
    // its own failure by design — the send path reported it through `#fail` and
    // has no caller here — so `#closed` is the only remaining evidence that the
    // channel died between the lock and this line: a socket that failed
    // underneath it, or a queue that refused a payload. Releasing anyway emits
    // `onOpen` after `onClose`, and both facades set their readyState from those
    // two events, so a WebSocket-shaped consumer is left holding a dead
    // transport that says it is live.
    if (this.#closed) return;
    this.options.callbacks.onTransportStatus("online");
    this.options.callbacks.onSessionStatus("synchronizing");
    this.options.events.onOpen();
  }

  /**
   * §4.4: flush the held plaintext as envelopes on an `e2ee` lock and as
   * plaintext on a `legacy` lock, in submission order.
   *
   * The buffer is emptied BEFORE the first send, so the bytes are charged
   * against the relay send queue exactly once rather than against both budgets
   * at the same time. A throw from the plaintext path has already failed the
   * channel and has no caller here to receive it.
   *
   * IT STOPS AT THE FIRST FAILURE. `#fail` has by then discarded the send queue
   * and zeroized it, so re-entering the send path would build fresh plaintext
   * chunk copies and push them onto a queue nothing zeroizes a second time —
   * leaving the very bytes this path exists to bound resident on a channel that
   * is already torn down. The remainder is wiped here instead, which is the same
   * disposition `#discardNegotiationBuffer` gives every FATAL-PRE row.
   */
  #flushNegotiationBuffer(mode: RelayE2eeMode): void {
    const buffered = this.#negotiationBuffer;
    this.#negotiationBuffer = [];
    this.#negotiationBufferedBytes = 0;
    for (const payload of buffered) {
      if (!this.#closed) {
        try {
          if (mode === "e2ee") this.#emitE2ee(payload);
          else this.#sendPlaintext(payload);
        } catch {
          // The send path reports its own failure through `#fail`; the entries
          // it did not reach are zeroed by the loop and dropped with the channel.
          if (mode === "e2ee" && !this.#closed) {
            this.#failE2ee(relayE2eeFailure("fatal_post_key"));
          }
        }
      }
      payload.fill(0);
    }
  }

  /**
   * THE ONE EXIT that drops buffered plaintext without sending it, and it
   * zeroizes before dropping (§4.4, §11.2).
   *
   * Every client FATAL-PRE row of `negotiating` — K2, K4, K6, K7, K8, K10, K11,
   * K12, K14, K15, K23, K24 — reaches it through `#finish`, and so does every
   * transport failure underneath the channel. There is deliberately no second
   * path: "no buffered byte is ever flushed as plaintext on a channel that
   * closed rather than locking `legacy`" is a property of there being nowhere
   * else for the bytes to go.
   */
  #discardNegotiationBuffer(): void {
    for (const payload of this.#negotiationBuffer) payload.fill(0);
    this.#negotiationBuffer = [];
    this.#negotiationBufferedBytes = 0;
  }

  /**
   * §11.1: the endpoint that detects an E2EE-fatal condition emits the outer
   * relay `channel.close` WITH `channel_rejected` after completing the §11.2 or
   * §11.3 procedure, and only then tears the connection down.
   *
   * The relay-level `#fail` below does not send that frame — a transport that
   * failed underneath the channel has nothing to say on it — so the E2EE path
   * sends it here and then takes the same teardown.
   */
  #failE2ee(value: HostedRelayFailure): void {
    if (this.#closed) return;
    this.#e2eeClosing = true;
    // §11.3's procedure emits one `E2EEError` and only then the close, so the
    // record goes out ahead of the frame here for the same reason `#outerClose`
    // drains: the frame is written past the queue and `#fail` discards it.
    this.#flushOutbound(true);
    if (this.#channel && value.closeReason) {
      this.#frame({
        type: "channel.close",
        ...this.#wireVersion(),
        channelId: this.#channel,
        reason: value.closeReason,
      });
    }
    this.#fail(value);
  }

  /**
   * §9.3: hold send-queue capacity for every payload of one record before its
   * pair is assigned.
   *
   * The payload layout comes from the chunk layer's own rule
   * (`planRelayMessage`), so the capacity held is the capacity the record will
   * actually spend. A refusal returns `undefined`, which the record session
   * reports as `e2ee_send_unavailable`: no pair consumed, nothing encrypted,
   * nothing on the wire, and the channel unaffected. It never fails the
   * channel — ordinary backpressure is not a fatal condition.
   */
  #reserveOutbound(messageBytes: number): RelayE2eeReservation | undefined {
    const limits = this.#limits;
    if (this.#closed || !this.#channel || !limits) return undefined;
    const plan = planRelayMessage(messageBytes, this.#messageLimits(limits));
    if (plan.kind === "error") return undefined;
    const reserved = relayQueueCharge(plan.payloadBytes);
    if (this.bufferedAmount + reserved > limits.maxQueuedBytes - limits.maxControlFrameBytes) {
      return undefined;
    }
    this.#outboundReservedBytes += reserved;
    const token: OutboundReservationToken = {
      reservedBytes: reserved,
      active: true,
    };
    this.#outboundReservations.add(token);
    const settle = (): boolean => {
      if (!token.active) return false;
      token.active = false;
      this.#outboundReservations.delete(token);
      this.#outboundReservedBytes -= token.reservedBytes;
      return true;
    };
    return {
      release: () => void settle(),
      send: (message) => (settle() ? this.#sendReserved(message) : false),
    };
  }

  /**
   * Queue every payload of an admitted record. The reservation already covers
   * them, so this cannot overflow the queue and is all-or-nothing: `false`
   * means no byte of the record reached the relay (§9.3).
   */
  #sendReserved(message: Uint8Array): boolean {
    const limits = this.#limits;
    if (this.#closed || !this.#channel || !limits) return false;
    const prepared = prepareRelayMessage(message, this.#messageLimits(limits));
    if (prepared.kind === "error") return false;
    for (const chunk of prepared.payloads) {
      const bytes = Uint8Array.from(chunk);
      const reservedBytes = bytes.byteLength + QUEUE_ENTRY_OVERHEAD_BYTES;
      this.#outboundQueue.push({ bytes, reservedBytes });
      this.#outboundQueuedBytes += reservedBytes;
    }
    this.#flushOutbound();
    return true;
  }

  #messageLimits(limits: RelayLimits): {
    readonly maxChunkBytes: number;
    readonly maxMessageBytes: number;
    readonly peerSupportsChunking: boolean;
  } {
    return {
      maxChunkBytes: limits.maxDataChunkBytes,
      maxMessageBytes: Math.min(
        RELAY_MAX_RPC_MESSAGE_BYTES,
        limits.maxQueuedBytes - limits.maxControlFrameBytes,
      ),
      peerSupportsChunking: this.#assembler.peerSupportsChunking,
    };
  }

  #receiveData(frame: Extract<RelayFrame, { readonly type: "data" }>): void {
    // Reject inbound RPC data delivered before the handshake completes
    // (channel.accept); a peer must not push data during authorization.
    if (
      this.#closed ||
      !this.#accepted ||
      frame.channelId !== this.#channel ||
      frame.sequence !== this.#inboundSequence ||
      !this.#limits
    )
      return this.#fail(failure("channel_rejected"));
    this.#inboundSequence += 1;
    const payload = Uint8Array.from(frame.payload);
    if (this.#inboundOwnedBytes() + payload.byteLength > this.#limits.maxQueuedBytes) {
      payload.fill(0);
      return this.#fail(failure("slow_consumer"));
    }
    this.#inboundQueue.push(payload);
    this.#inboundQueuedBytes += payload.byteLength;
    this.#refreshInboundFlow();
    this.#drainInbound();
  }

  #inboundOwnedBytes(): number {
    return this.#inboundQueuedBytes + this.#assembler.heldBytes;
  }

  #refreshInboundFlow(): void {
    if (!this.#limits || !this.#channel) return;
    const ownedBytes = this.#inboundOwnedBytes();
    if (!this.#inboundPaused && ownedBytes >= Math.floor(this.#limits.maxQueuedBytes * 0.75)) {
      this.#inboundPaused = true;
      this.#frame({ type: "flow.pause", ...this.#wireVersion(), channelId: this.#channel });
    } else if (this.#inboundPaused && ownedBytes <= Math.floor(this.#limits.maxQueuedBytes * 0.5)) {
      this.#inboundPaused = false;
      this.#frame({
        type: "flow.resume",
        ...this.#wireVersion(),
        channelId: this.#channel,
      });
    }
  }

  #drainInbound(): void {
    if (this.#drainingInbound) return;
    this.#drainingInbound = true;
    this.options.timers.queueMicrotask(() => {
      this.#drainingInbound = false;
      if (this.#closed) return;
      const payload = this.#inboundQueue.shift();
      if (payload) {
        this.#inboundQueuedBytes -= payload.byteLength;
        const delivered = Uint8Array.from(payload);
        payload.fill(0);
        // Reassemble before delivering. An unchunked payload passes straight
        // through, so an old peer is unaffected; a partial message is held
        // until its final chunk arrives.
        const assembled = this.#assembler.push(delivered);
        if (assembled.kind === "error") {
          this.#fail(failure("transfer_limit"));
          return;
        }
        if (assembled.kind === "done") this.#deliver(assembled.message);
      }
      this.#refreshInboundFlow();
      if (this.#inboundQueue.length > 0) this.#drainInbound();
    });
  }

  /**
   * One reassembled, prelude-stripped payload (§4.3 step 1).
   *
   * With no E2EE channel this is the application's message and reaches it on
   * the same turn it always did. With one, the payload is the mode machine's in
   * EVERY mode — §4.4's rows are defined over `negotiating`, `e2ee`, and
   * `legacy` alike, and a payload the engine routed around the machine after a
   * `legacy` lock would be rows K19–K22 with nobody to decide them. §4.3 puts
   * discrimination behind the assembler, and unauthenticated bytes never reach
   * the RPC parser. The interceptions are chained rather than launched, because
   * §9.2 compares each envelope against a single expected pair and two
   * overlapping `unprotect` calls would race that comparison.
   */
  #deliver(message: Uint8Array): void {
    const channel = this.#e2ee;
    if (!channel) return this.options.events.onData(message);
    const intercept = async (): Promise<void> => {
      if (this.#closed || this.#e2ee !== channel) return;
      try {
        const disposition = await channel.intercept(message);
        if (disposition.kind === "rpc" && !this.#closed) {
          this.options.events.onData(disposition.message);
        }
      } catch {
        // The channel decides every condition it can decide; a throw escaping
        // it is a local defect, and the only fail-closed answer is to stop
        // consuming (§4.3: nothing unauthenticated reaches the parser).
        this.#failE2ee(relayE2eeFailure("fatal_post_key"));
      }
    };
    this.#e2eeInbound = this.#e2eeInbound.then(intercept, intercept);
  }

  #enqueueOutbound(payload: Uint8Array): void {
    const limits = this.#limits!;
    const reservedBytes = payload.byteLength + QUEUE_ENTRY_OVERHEAD_BYTES;
    if (this.bufferedAmount + reservedBytes > limits.maxQueuedBytes - limits.maxControlFrameBytes) {
      payload.fill(0);
      this.#fail(failure("slow_consumer"));
      throw new Error(RELAY_SEND_QUEUE_FULL_MESSAGE);
    }
    this.#outboundQueue.push({ bytes: payload, reservedBytes });
    this.#outboundQueuedBytes += reservedBytes;
    this.#flushOutbound();
  }

  /**
   * `final` is the best-effort drain a close takes before its own frame: it
   * writes past the local queue threshold, because deferring is exactly what
   * loses the payload the caller is about to close over. It stays inside the
   * peer's `flow.pause` — a paused channel cannot be drained without violating
   * relay flow control, and a socket that will not take the bytes cannot be made
   * to. Both lose the record, which is why §10.3 takes delivery proof from the
   * peer and never from a successful enqueue.
   */
  #flushOutbound(final = false): void {
    if (this.#closed || this.#outboundPaused || !this.#channel || !this.#limits) return;
    if (this.#flushTimer) this.options.timers.clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    while (this.#outboundQueue.length > 0) {
      const next = this.#outboundQueue[0]!;
      if (
        !final &&
        this.options.socket.bufferedAmount + next.reservedBytes > this.#limits.maxQueuedBytes
      ) {
        this.#flushTimer = this.options.timers.setTimeout(() => this.#flushOutbound(), 10);
        return;
      }
      this.#outboundQueue.shift();
      this.#outboundQueuedBytes -= next.reservedBytes;
      const sequence = this.#outboundSequence;
      if (sequence > 0xffff_ffff) {
        next.bytes.fill(0);
        this.#fail(failure("transfer_limit"));
        return;
      }
      this.#outboundSequence += 1;
      this.#frame({
        type: "data",
        ...this.#wireVersion(),
        channelId: this.#channel,
        sequence: sequence as never,
        payload: next.bytes,
      });
      next.bytes.fill(0);
    }
    // The queue is empty, so the capacity a §11.4 refusal was waiting for is
    // back: a close the application already asked for gets its next attempt here
    // rather than waiting for a caller that may never come again.
    this.#attemptE2eeClose();
  }

  #frame(frame: RelayFrame): void {
    if (this.#closed || this.options.socket.readyState !== OPEN) return;
    const encoded = encodeRelayFrame(frame);
    if (
      !encoded.ok ||
      encoded.value.byteLength >
        (frame.type === "data" ? RELAY_MAX_DATA_FRAME_BYTES : RELAY_MAX_CONTROL_FRAME_BYTES)
    )
      return this.#fail(failure("protocol_invalid"));
    try {
      this.options.socket.send(encoded.value);
    } catch {
      this.#fail(failure("network"));
    } finally {
      encoded.value.fill(0);
    }
  }

  /** Current offer before `ready`, exact relay selection afterwards. */
  #wireVersion(): { readonly protocolMajor: number; readonly protocolMinor: number } {
    return this.#protocol ?? VERSION;
  }

  #fail(value: HostedRelayFailure): void {
    if (this.#closed) return;
    if (!this.#reported) {
      this.#reported = true;
      this.options.callbacks.onFailure(value);
    }
    this.options.events.onError();
    this.#finish(4000, value.kind);
  }

  #finish(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#authTimer) this.options.timers.clearTimeout(this.#authTimer);
    if (this.#flushTimer) this.options.timers.clearTimeout(this.#flushTimer);
    this.#authTimer = null;
    this.#flushTimer = null;
    this.#auth?.fill(0);
    this.#auth = null;
    // §4.4: the buffer's single discard path. It runs before anything else is
    // torn down so a channel that closed rather than locking `legacy` cannot
    // reach a flush from any later step.
    this.#discardNegotiationBuffer();
    for (const item of this.#outboundQueue) item.bytes.fill(0);
    for (const item of this.#inboundQueue) item.fill(0);
    // §10.4: a partial reassembly held when the channel ends IS truncation, and
    // the verdict is recorded at that instant — so the channel is told BEFORE
    // the reset below erases the evidence, and before the outer close.
    const channel = this.#e2ee;
    this.#e2ee = null;
    channel?.dispose({
      incompleteReassembly: this.#assembler.incompleteMessage,
    });
    this.#assembler.reset();
    this.#outboundQueue = [];
    this.#inboundQueue = [];
    this.#outboundQueuedBytes = 0;
    for (const reservation of this.#outboundReservations) reservation.active = false;
    this.#outboundReservations.clear();
    this.#outboundReservedBytes = 0;
    this.#inboundQueuedBytes = 0;
    this.options.callbacks.onRole(null);
    if (code === 1000 && !this.#reported) this.options.callbacks.onSessionStatus("closed");
    try {
      this.options.socket.close(code === 1000 ? 1000 : 4000, reason.slice(0, 64));
    } catch {
      // The underlying socket may already be closed.
    }
    this.options.events.onClose(code, reason);
  }
}
