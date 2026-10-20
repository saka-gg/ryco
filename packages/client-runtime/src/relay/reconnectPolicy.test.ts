import { describe, expect, it } from "vite-plus/test";

import { HostedReconnectPolicy } from "./reconnectPolicy.ts";

describe("HostedReconnectPolicy", () => {
  it("uses bounded deterministic exponential jitter and honors retry-after", () => {
    let now = 0;
    const policy = new HostedReconnectPolicy({ random: () => 0.5, now: () => now });
    expect(policy.nextDelay()).toBe(1_000);
    expect(policy.nextDelay()).toBe(2_000);
    expect(policy.nextDelay(30_000)).toBe(30_000);
    for (let index = 0; index < 20; index += 1) policy.nextDelay();
    expect(policy.nextDelay()).toBe(60_000);

    policy.opened();
    now = 59_999;
    policy.closed();
    expect(policy.nextDelay()).toBe(60_000);

    policy.opened();
    now += 60_000;
    policy.closed();
    expect(policy.nextDelay()).toBe(1_000);
  });

  it("escalates rather than resets when a FATAL-PRE lands seconds after channel accept", () => {
    // docs/relay-e2ee-protocol.md §15: "A client MUST NOT hot-retry after
    // FATAL-PRE." The client-side lever is this policy, which resets its attempt
    // counter only after a SUSTAINED stable connection — so a channel that
    // failed a cryptographic check within a second of `channel.accept` cannot
    // reconnect into the same failure at the base delay.
    let now = 0;
    const policy = new HostedReconnectPolicy({ random: () => 0.5, now: () => now });
    expect(policy.nextDelay()).toBe(1_000);

    policy.opened();
    now = 1_000;
    policy.closed();

    expect(policy.nextDelay()).toBe(2_000);

    // §4.4 moved the release valve behind the mode lock, so a FATAL-PRE before
    // one is reached never calls `opened` at all — the escalation holds a
    // fortiori, and this is the weaker of the two cases.
    policy.closed();
    expect(policy.nextDelay()).toBe(4_000);
  });

  it("injects randomness without exceeding the configured window", () => {
    const low = new HostedReconnectPolicy({ random: () => 0 });
    const high = new HostedReconnectPolicy({ random: () => 1 });
    expect(low.nextDelay()).toBe(800);
    expect(high.nextDelay()).toBe(1_200);
  });
});

describe("HostedReconnectPolicy wakes", () => {
  it("shortens one wait without resetting the backoff", () => {
    let now = 0;
    const policy = new HostedReconnectPolicy({ now: () => now });
    for (let index = 0; index < 4; index += 1) policy.nextDelay();

    const wake = policy.wake();
    expect(wake).not.toBeNull();
    expect(wake).toBeGreaterThanOrEqual(0);
    expect(wake).toBeLessThanOrEqual(1_200);
    const next = policy.nextDelay();
    expect(next).toBeGreaterThanOrEqual(12_800);
    expect(next).toBeLessThanOrEqual(19_200);
  });

  it.each([
    [0, 0],
    [0.5, 600],
    [1, 1_200],
  ])("waits a jittered share of the base delay (random %s)", (random, expected) => {
    const policy = new HostedReconnectPolicy({ random: () => random, now: () => 0 });
    expect(policy.wake()).toBe(expected);
  });

  it("never cuts a Hub retry-after that set the delay", () => {
    let now = 0;
    const policy = new HostedReconnectPolicy({ random: () => 0.5, now: () => now });
    expect(policy.nextDelay(3_000)).toBe(3_000);
    now = 1_000;
    expect(policy.wake()).toBeNull();
    now = 3_100;
    expect(policy.wake()).toBe(600);
  });

  it("never cuts a Hub retry-after that is shorter than the jittered delay", () => {
    let now = 0;
    const policy = new HostedReconnectPolicy({ random: () => 0.5, now: () => now });
    for (let index = 0; index < 3; index += 1) policy.nextDelay();
    expect(policy.nextDelay(3_000)).toBe(8_000);
    now = 1_000;
    expect(policy.wake()).toBeNull();
    now = 3_100;
    expect(policy.wake()).toBe(600);
  });

  it("drops an earlier retry-after once a delay comes without one", () => {
    let now = 0;
    const policy = new HostedReconnectPolicy({ random: () => 0.5, now: () => now });
    policy.nextDelay(30_000);
    policy.nextDelay();
    now = 1_000;
    expect(policy.wake()).toBe(600);
  });

  it("grants at most one wake per interval", () => {
    let now = 0;
    const policy = new HostedReconnectPolicy({ random: () => 0.5, now: () => now });
    expect(policy.wake()).toBe(600);
    now = 5_000;
    expect(policy.wake()).toBeNull();
    now = 10_100;
    expect(policy.wake()).toBe(600);
  });

  it("keeps growing the backoff under a flapping node", () => {
    let now = 0;
    const policy = new HostedReconnectPolicy({ random: () => 0.5, now: () => now });
    const woken: number[] = [];
    const delays: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      now = index * 3_000;
      if (policy.wake() !== null) woken.push(now);
      delays.push(policy.nextDelay());
    }
    expect(woken).toEqual([0, 12_000, 24_000]);
    expect(delays).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000,
    ]);
  });

  it("forgets its retry-after and wake interval on reset, and resets after a stable minute", () => {
    let now = 0;
    const policy = new HostedReconnectPolicy({ random: () => 0.5, now: () => now });
    policy.nextDelay(30_000);
    expect(policy.wake()).toBeNull();
    policy.reset();
    expect(policy.wake()).toBe(600);
    policy.reset();
    expect(policy.wake()).toBe(600);

    for (let index = 0; index < 4; index += 1) policy.nextDelay();
    policy.opened();
    now += 60_000;
    policy.closed();
    expect(policy.nextDelay()).toBe(1_000);
  });
});
