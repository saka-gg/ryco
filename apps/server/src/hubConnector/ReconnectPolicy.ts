import { RELAY_MAX_RETRY_AFTER_MS } from "@ryco/contracts/relay";

export interface ReconnectPolicyConfig {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

export interface ReconnectDecision {
  readonly attempt: number;
  readonly delayMs: number;
}

function assertDeterministicInput(attempt: number, randomValue: number): void {
  if (
    !Number.isSafeInteger(attempt) ||
    attempt < 0 ||
    !Number.isFinite(randomValue) ||
    randomValue < 0 ||
    randomValue > 1
  ) {
    throw new Error("Reconnect policy input is invalid.");
  }
}

export function reconnectDelay(
  config: ReconnectPolicyConfig,
  attempt: number,
  randomValue: number,
  retryAfterMs?: number,
): ReconnectDecision {
  assertDeterministicInput(attempt, randomValue);
  const exponent = Math.min(attempt, 52);
  const exponential = Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** exponent);
  const multiplier = 1 - config.jitterRatio + 2 * config.jitterRatio * randomValue;
  const jittered = Math.max(250, Math.min(config.maxDelayMs, Math.round(exponential * multiplier)));
  const boundedRetryAfter =
    retryAfterMs === undefined
      ? 0
      : Math.max(0, Math.min(RELAY_MAX_RETRY_AFTER_MS, Math.round(retryAfterMs)));
  return {
    attempt,
    delayMs: Math.min(RELAY_MAX_RETRY_AFTER_MS, Math.max(jittered, boundedRetryAfter)),
  };
}

/**
 * A retry schedule for a failure that is usually transient but could also be
 * real: a locked credential store, a duplicate process, a rejected proof.
 *
 * These are retried on their own clock rather than the ordinary backoff,
 * because the ordinary backoff caps at a minute and would hammer the Hub — or
 * fight a duplicate — indefinitely. Every attempt still uses a fresh challenge
 * and goes through the Hub's full authentication, so a genuinely refused node
 * gains nothing by retrying; it simply stops parking for an operator when the
 * cause has gone away on its own.
 */
export interface SlowRetryPolicy extends ReconnectPolicyConfig {
  /**
   * At most this many retries within any rolling hour; past it the failure
   * stops for an operator. For a failure that two parties can cause each other,
   * where retrying forever would be the flapping itself.
   */
  readonly maxPerHour?: number;
}

/** A locked keychain or a contended state file: worth checking soon, then less often. */
export const IDENTITY_UNAVAILABLE_RETRY: SlowRetryPolicy = {
  baseDelayMs: 30_000,
  maxDelayMs: 600_000,
  jitterRatio: 0.2,
};

/**
 * Another local process holds this identity's process lock. Nothing reaches
 * the Hub until the lock is free, so checking is a file read and costs no one
 * anything; it only needs to notice promptly when the other copy exits.
 */
export const IDENTITY_IN_USE_RETRY: SlowRetryPolicy = {
  baseDelayMs: 30_000,
  maxDelayMs: 120_000,
  jitterRatio: 0.2,
};

/**
 * Another process authenticated as this node. Retrying displaces it, and its
 * retry displaces this one, so the gap is long and the budget is small: two
 * duplicates converge on one connected copy within the hour instead of
 * swapping forever.
 */
export const CONNECTION_REPLACED_RETRY: SlowRetryPolicy = {
  baseDelayMs: 300_000,
  maxDelayMs: 900_000,
  jitterRatio: 0.25,
  maxPerHour: 3,
};

/**
 * The relay refused this node's proof. Usually a revoked or replaced key,
 * which no retry fixes — but the Hub cannot say so on the wire, and the same
 * refusal follows a Hub-side incident that does clear. Each attempt costs the
 * Hub one challenge and one signature check.
 */
export const AUTHENTICATION_FAILED_RETRY: SlowRetryPolicy = {
  baseDelayMs: 900_000,
  maxDelayMs: 3_600_000,
  jitterRatio: 0.25,
};

/**
 * Exponential from `baseDelayMs` to `maxDelayMs`, jittered uniformly within
 * both: the base is the promise ("at least five minutes"), the jitter keeps a
 * fleet that failed together from retrying together.
 *
 * The jitter window is clamped before it is sampled, not the jittered value
 * after: clamping afterwards would put half of every first retry exactly on the
 * base and half of every capped one exactly on the cap — the synchronized burst
 * the jitter exists to prevent, aimed at a Hub that is recovering.
 */
export function slowRetryDelay(
  policy: SlowRetryPolicy,
  attempt: number,
  randomValue: number,
): ReconnectDecision {
  assertDeterministicInput(attempt, randomValue);
  const exponent = Math.min(attempt, 52);
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  const low = Math.max(policy.baseDelayMs, exponential * (1 - policy.jitterRatio));
  const high = Math.min(policy.maxDelayMs, exponential * (1 + policy.jitterRatio));
  return { attempt, delayMs: Math.round(low + (high - low) * randomValue) };
}
