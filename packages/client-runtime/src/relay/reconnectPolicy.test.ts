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
