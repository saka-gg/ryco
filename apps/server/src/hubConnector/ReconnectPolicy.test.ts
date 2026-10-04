import { describe, expect, it } from "vite-plus/test";

import {
  AUTHENTICATION_FAILED_RETRY,
  CONNECTION_REPLACED_RETRY,
  IDENTITY_UNAVAILABLE_RETRY,
  reconnectDelay,
  slowRetryDelay,
} from "./ReconnectPolicy.ts";

const config = { baseDelayMs: 1_000, maxDelayMs: 60_000, jitterRatio: 0.2 } as const;

describe("reconnectDelay", () => {
  it("applies bounded exponential windows and deterministic jitter", () => {
    expect(reconnectDelay(config, 0, 0).delayMs).toBe(800);
    expect(reconnectDelay(config, 0, 0.5).delayMs).toBe(1_000);
    expect(reconnectDelay(config, 0, 1).delayMs).toBe(1_200);
    expect(reconnectDelay(config, 3, 0.5).delayMs).toBe(8_000);
    expect(reconnectDelay(config, 100_000, 1).delayMs).toBe(60_000);
  });

  it("honors retry-after as a lower bound with the protocol absolute cap", () => {
    expect(reconnectDelay(config, 0, 0.5, 45_000).delayMs).toBe(45_000);
    expect(reconnectDelay(config, 0, 0.5, 999_999).delayMs).toBe(300_000);
    expect(reconnectDelay(config, 20, 0.5, 10_000).delayMs).toBe(60_000);
  });

  it("never drops below 250 ms and rejects nondeterministic inputs", () => {
    expect(
      reconnectDelay({ baseDelayMs: 250, maxDelayMs: 250, jitterRatio: 0.5 }, 0, 0).delayMs,
    ).toBe(250);
    expect(() => reconnectDelay(config, -1, 0.5)).toThrow("Reconnect policy input is invalid.");
    expect(() => reconnectDelay(config, 0, Number.NaN)).toThrow(
      "Reconnect policy input is invalid.",
    );
  });
});

describe("slowRetryDelay", () => {
  it("never retries sooner than the policy's base, and never later than its cap", () => {
    for (const policy of [
      IDENTITY_UNAVAILABLE_RETRY,
      CONNECTION_REPLACED_RETRY,
      AUTHENTICATION_FAILED_RETRY,
    ]) {
      for (const attempt of [0, 1, 2, 3, 40]) {
        for (const random of [0, 0.5, 1]) {
          const { delayMs } = slowRetryDelay(policy, attempt, random);
          expect(delayMs).toBeGreaterThanOrEqual(policy.baseDelayMs);
          expect(delayMs).toBeLessThanOrEqual(policy.maxDelayMs);
        }
      }
    }
  });

  it("is not clamped to the relay's five-minute retry-after ceiling", () => {
    // A refused proof costs the Hub a challenge and a signature check, so its
    // retries are a quarter of an hour apart from the first.
    expect(slowRetryDelay(AUTHENTICATION_FAILED_RETRY, 0, 0.5).delayMs).toBe(900_000);
    expect(slowRetryDelay(AUTHENTICATION_FAILED_RETRY, 5, 0.5).delayMs).toBe(3_600_000);
    // A locked keychain: half a minute, growing to ten.
    expect(slowRetryDelay(IDENTITY_UNAVAILABLE_RETRY, 0, 0.5).delayMs).toBe(30_000);
    expect(slowRetryDelay(IDENTITY_UNAVAILABLE_RETRY, 10, 0.5).delayMs).toBe(600_000);
  });

  it("spreads a fleet that failed together", () => {
    expect(slowRetryDelay(CONNECTION_REPLACED_RETRY, 0, 1).delayMs).toBeGreaterThan(
      slowRetryDelay(CONNECTION_REPLACED_RETRY, 0, 0.5).delayMs,
    );
    expect(() => slowRetryDelay(CONNECTION_REPLACED_RETRY, 0, 2)).toThrow(
      "Reconnect policy input is invalid.",
    );
  });
});
