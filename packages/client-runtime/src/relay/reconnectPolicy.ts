import { RELAY_MAX_RETRY_AFTER_MS } from "@ryco/contracts/relay";

export interface HostedReconnectPolicyOptions {
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly stableIntervalMs?: number;
  readonly jitterRatio?: number;
  /** The shortest gap between two {@link HostedReconnectPolicy.wake} calls that shorten a wait. */
  readonly wakeMinIntervalMs?: number;
  readonly random?: () => number;
  readonly now?: () => number;
}

export class HostedReconnectPolicy {
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #stableIntervalMs: number;
  readonly #jitterRatio: number;
  readonly #wakeMinIntervalMs: number;
  readonly #random: () => number;
  readonly #now: () => number;
  #attempt = 0;
  #openedAt: number | null = null;
  /** Until when the last delay's Hub `retryAfterMs` holds; no wake cuts it short. */
  #retryAfterUntil = 0;
  #lastWakeAt: number | null = null;

  constructor(options: HostedReconnectPolicyOptions = {}) {
    this.#baseDelayMs = options.baseDelayMs ?? 1_000;
    this.#maxDelayMs = options.maxDelayMs ?? 60_000;
    this.#stableIntervalMs = options.stableIntervalMs ?? 60_000;
    this.#jitterRatio = options.jitterRatio ?? 0.2;
    this.#wakeMinIntervalMs = options.wakeMinIntervalMs ?? 10_000;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
  }

  opened(): void {
    this.#openedAt = this.#now();
  }

  closed(): void {
    if (this.#openedAt !== null && this.#now() - this.#openedAt >= this.#stableIntervalMs) {
      this.#attempt = 0;
    }
    this.#openedAt = null;
  }

  nextDelay(retryAfterMs?: number): number {
    const exponent = Math.min(this.#attempt, 30);
    this.#attempt += 1;
    const exponential = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** exponent);
    const randomValue = Math.max(0, Math.min(1, this.#random()));
    const multiplier = 1 - this.#jitterRatio + 2 * this.#jitterRatio * randomValue;
    const jittered = Math.max(
      250,
      Math.min(this.#maxDelayMs, Math.round(exponential * multiplier)),
    );
    const retryAfter = Math.max(
      0,
      Math.min(RELAY_MAX_RETRY_AFTER_MS, Math.round(retryAfterMs ?? 0)),
    );
    // The Hub's floor holds even when the jittered delay is the longer one.
    this.#retryAfterUntil = retryAfter > 0 ? this.#now() + retryAfter : 0;
    return Math.min(RELAY_MAX_RETRY_AFTER_MS, Math.max(jittered, retryAfter));
  }

  /**
   * A short random delay to retry after instead of waiting out the rest of the
   * current one, or `null` while the Hub's `retryAfterMs` for that delay still
   * holds or while an earlier wake was granted less than `wakeMinIntervalMs`
   * ago. A wake never resets the backoff: the next delay still grows until a
   * session stays stable.
   */
  wake(): number | null {
    const now = this.#now();
    if (now < this.#retryAfterUntil) return null;
    if (this.#lastWakeAt !== null && now - this.#lastWakeAt < this.#wakeMinIntervalMs) {
      return null;
    }
    this.#lastWakeAt = now;
    const randomValue = Math.max(0, Math.min(1, this.#random()));
    return Math.round(this.#baseDelayMs * (1 + this.#jitterRatio) * randomValue);
  }

  reset(): void {
    this.#attempt = 0;
    this.#openedAt = null;
    this.#retryAfterUntil = 0;
    this.#lastWakeAt = null;
  }
}
