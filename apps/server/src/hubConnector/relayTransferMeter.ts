/**
 * relayTransferMeter - the node's own count of what one relay channel spends of
 * the Hub's per-channel transfer budget, so the channel slows down instead of
 * being ended with `transfer_limit`.
 *
 * The Hub meters each channel as a byte rate with a burst allowance: every data
 * payload in either direction spends from a bucket that refills with time, and
 * a frame the bucket cannot pay for ends the channel (relay-protocol.md,
 * `transfer_limit`). The client then reconnects with a new ticket, handshake and
 * snapshot, and whatever the channel was doing — a large download, a terminal
 * flooding output, a device preview — stops for that long.
 *
 * The node cannot see the Hub's bucket, and the Hub's parameters are its own
 * configuration, so this meter mirrors it conservatively: a smaller burst and a
 * lower rate than the Hub runs by default. Bytes the client sends are counted
 * as they arrive. A large outbound message the meter cannot pay for waits as
 * ordinary backpressure (the RPC session retries it; a device frame is dropped
 * like any refused frame) until the meter has refilled enough. Small messages —
 * every control record, keepalive, acknowledgement and streamed delta — always
 * pass and are counted, so nothing that keeps a channel coherent is ever held.
 *
 * Opening a replacement channel before the limit was considered and rejected:
 * a new channel costs a ticket, a handshake and a new snapshot, and its
 * subscriptions are the client's lifecycle to move. Holding a large transfer
 * at the sustained rate keeps everything else on the channel live.
 *
 * @module hubConnector/relayTransferMeter
 */

/** Bytes a channel may move at once before the sustained rate applies. */
export const RELAY_TRANSFER_METER_BURST_BYTES = 32 * 1_024 * 1_024;
/**
 * Sustained bytes per second, both directions together. The device preview's
 * own cap (`RELAY_FRAME_TUNNEL_RATE_BYTES_PER_SECOND`) is the same figure, so a
 * preview at its full rate still leaves RPC its burst.
 */
export const RELAY_TRANSFER_METER_BYTES_PER_SECOND = 768 * 1_024;
/** Outbound messages of at most this many bytes are never held. */
export const RELAY_TRANSFER_METER_UNPACED_MESSAGE_BYTES = 4 * 1_024;
/** What one data frame costs beyond its payload, generously: the Hub counts whole frames. */
export const RELAY_TRANSFER_METER_FRAME_OVERHEAD_BYTES = 64;

export class RelayTransferMeter {
  readonly #burstBytes: number;
  readonly #bytesPerSecond: number;
  readonly #now: () => number;
  readonly #unpacedMessageBytes: number;
  #tokens: number;
  #updatedAt: number;

  constructor(
    options: {
      readonly burstBytes?: number;
      readonly bytesPerSecond?: number;
      readonly unpacedMessageBytes?: number;
      readonly now?: () => number;
    } = {},
  ) {
    this.#unpacedMessageBytes =
      options.unpacedMessageBytes ?? RELAY_TRANSFER_METER_UNPACED_MESSAGE_BYTES;
    this.#burstBytes = options.burstBytes ?? RELAY_TRANSFER_METER_BURST_BYTES;
    this.#bytesPerSecond = options.bytesPerSecond ?? RELAY_TRANSFER_METER_BYTES_PER_SECOND;
    this.#now = options.now ?? Date.now;
    this.#tokens = this.#burstBytes;
    this.#updatedAt = this.#now();
  }

  /** What is left now; negative after inbound traffic or small messages overspent it. */
  get available(): number {
    this.#refill();
    return this.#tokens;
  }

  /**
   * Whether an outbound message of these data payload sizes may go now. Small
   * messages always may. A large one needs the meter to cover it whole, never
   * more than the burst: one larger than the burst needs a full meter.
   */
  allows(payloadSizes: ReadonlyArray<number>): boolean {
    const cost = this.#cost(payloadSizes);
    if (cost <= this.#unpacedMessageBytes) return true;
    return this.available >= Math.min(cost, this.#burstBytes);
  }

  /** Count data payloads that went out or came in. */
  spend(payloadSizes: ReadonlyArray<number>): void {
    this.#refill();
    // Debt is bounded: a channel that ran this far over is one the Hub has ended.
    this.#tokens = Math.max(-this.#burstBytes, this.#tokens - this.#cost(payloadSizes));
  }

  #cost(payloadSizes: ReadonlyArray<number>): number {
    let total = 0;
    for (const size of payloadSizes) total += size + RELAY_TRANSFER_METER_FRAME_OVERHEAD_BYTES;
    return total;
  }

  #refill(): void {
    const at = this.#now();
    const elapsedMs = at - this.#updatedAt;
    this.#updatedAt = at;
    if (elapsedMs > 0) {
      this.#tokens = Math.min(
        this.#burstBytes,
        this.#tokens + (elapsedMs * this.#bytesPerSecond) / 1_000,
      );
    }
  }
}
