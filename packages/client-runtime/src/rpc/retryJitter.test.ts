import { afterEach, describe, expect, it } from "vite-plus/test";

import { jitterRetryDelayMs, RETRY_JITTER_RATIO, setRetryJitterForTests } from "./retryJitter.ts";
import { getWsReconnectDelayMsForRetry } from "./wsConnectionState.ts";

afterEach(() => setRetryJitterForTests(null));

describe("retry jitter", () => {
  it("spreads a wait by up to a quarter either way, the same for the same retry", () => {
    for (let retry = 0; retry < 50; retry += 1) {
      const delay = jitterRetryDelayMs(8_000, retry, "schedule");
      expect(delay).toBeGreaterThanOrEqual(8_000 * (1 - RETRY_JITTER_RATIO));
      expect(delay).toBeLessThanOrEqual(8_000 * (1 + RETRY_JITTER_RATIO));
      expect(jitterRetryDelayMs(8_000, retry, "schedule")).toBe(delay);
    }
  });

  it("spreads the same retry differently on different clients", () => {
    // Twenty clients that all lost the same machine at once.
    const firstRetries = Array.from({ length: 20 }, (_, client) => {
      setRetryJitterForTests({ seed: (client + 0.5) / 20 });
      return getWsReconnectDelayMsForRetry(0);
    });
    expect(new Set(firstRetries).size).toBeGreaterThan(15);
    expect(
      Math.max(...(firstRetries as number[])) - Math.min(...(firstRetries as number[])),
    ).toBeGreaterThan(300);
  });

  it("keeps independent schedules apart and leaves zero alone", () => {
    setRetryJitterForTests({ seed: 0.3 });
    const samples = Array.from({ length: 10 }, (_, retry) => [
      jitterRetryDelayMs(10_000, retry, "a"),
      jitterRetryDelayMs(10_000, retry, "b"),
    ]);
    expect(samples.some(([a, b]) => a !== b)).toBe(true);
    expect(jitterRetryDelayMs(0, 1, "a")).toBe(0);
  });

  it("can be turned off for tests that time a schedule exactly", () => {
    setRetryJitterForTests({ enabled: false });
    expect(getWsReconnectDelayMsForRetry(2)).toBe(4_000);
  });
});
