import { describe, expect, it } from "vitest";
import {
  availablePercent,
  clampUsedPercent,
  describeRateLimitPace,
  rateLimitPace,
  isRateLimitSnapshotAvailable,
} from "./limits.ts";

const checkedAt = "2026-09-15T12:00:00Z";
const now = Date.parse(checkedAt);
const window = { usedPercent: 40, windowDurationMins: 300, resetsAt: (now + 120 * 60_000) / 1000 };

describe("snapshot allowance pace", () => {
  it("compares exact provider usage with elapsed allowance, independently per instance", () => {
    expect(rateLimitPace(window, checkedAt, now, true)).toEqual({
      status: "reserve",
      points: 20,
      expectedUsedPercent: 60,
    });
    expect(rateLimitPace({ ...window, usedPercent: 80 }, checkedAt, now, true)).toEqual({
      status: "deficit",
      points: 20,
      expectedUsedPercent: 60,
    });
    expect(window.usedPercent).toBe(40);
  });
  it("does not improve stale usage as time passes", () => {
    expect(rateLimitPace(window, checkedAt, now + 60_000, true)).toEqual(
      rateLimitPace(window, checkedAt, now, true),
    );
    expect(rateLimitPace(window, checkedAt, window.resetsAt * 1000, true).status).toBe(
      "unavailable",
    );
    expect(rateLimitPace(window, checkedAt, now, false).status).toBe("unavailable");
  });
  it("suppresses early and near-even comparisons without calling them zero", () => {
    expect(rateLimitPace({ ...window, usedPercent: 58 }, checkedAt, now, true).status).toBe(
      "quiet",
    );
    expect(
      rateLimitPace({ ...window, resetsAt: (now + 299 * 60_000) / 1000 }, checkedAt, now, true)
        .status,
    ).toBe("quiet");
    expect(describeRateLimitPace({ status: "quiet" })).toBeNull();
    expect(describeRateLimitPace({ status: "unavailable" })).toBe("Pace unavailable");
  });
  it("rounds reserve and deficit halves symmetrically", () => {
    for (const [usedPercent, status] of [
      [52.5, "reserve"],
      [67.5, "deficit"],
    ] as const) {
      expect(rateLimitPace({ ...window, usedPercent }, checkedAt, now, true)).toMatchObject({
        status,
        points: 8,
      });
    }
  });
  it.each([NaN, Infinity, -Infinity, -1, 101])(
    "rejects untrustworthy usage %s without clamping pace",
    (usedPercent) => {
      expect(rateLimitPace({ ...window, usedPercent }, checkedAt, now, true).status).toBe(
        "unavailable",
      );
    },
  );
  it.each([undefined, 0, -1, NaN, Infinity])(
    "requires a finite positive duration %s",
    (windowDurationMins) => {
      expect(rateLimitPace({ ...window, windowDurationMins }, checkedAt, now, true).status).toBe(
        "unavailable",
      );
    },
  );
  it.each([undefined, 0, NaN, Infinity, (now + 301 * 60_000) / 1000])(
    "rejects missing or invalid reset %s",
    (resetsAt) => {
      expect(rateLimitPace({ ...window, resetsAt }, checkedAt, now, true).status).toBe(
        "unavailable",
      );
    },
  );
  it("rejects missing/future snapshot timestamps and an invalid clock", () => {
    for (const checked of [undefined, "invalid", new Date(now + 1).toISOString()]) {
      expect(rateLimitPace(window, checked, now, true).status).toBe("unavailable");
    }
    expect(rateLimitPace(window, checkedAt, NaN, true).status).toBe("unavailable");
  });
  it.each([NaN, Infinity, -Infinity])(
    "never displays unknown usage %s as zero or full allowance",
    (value) => {
      expect(clampUsedPercent(value)).toBeNull();
      expect(availablePercent(value)).toBeNull();
    },
  );
  it("retains valid zero usage and expresses gaps in percentage points", () => {
    expect(availablePercent(0)).toBe(100);
    expect(describeRateLimitPace(rateLimitPace(window, checkedAt, now, true))).toBe(
      "20 percentage points below even pace · at last check",
    );
  });
});

describe("provider snapshot qualification", () => {
  const provider = { enabled: true, status: "ready", auth: { status: "authenticated" } } as const;
  it("requires a connected, enabled, ready, authenticated and available provider", () => {
    expect(isRateLimitSnapshotAvailable(provider, true)).toBe(true);
    expect(isRateLimitSnapshotAvailable(provider, false)).toBe(false);
    for (const changed of [
      { ...provider, availability: "unavailable" as const },
      { ...provider, enabled: false },
      { ...provider, status: "warning" as const },
      { ...provider, status: "error" as const },
      { ...provider, auth: { status: "unknown" as const } },
    ]) {
      expect(
        rateLimitPace(window, checkedAt, now, isRateLimitSnapshotAvailable(changed, true)).status,
      ).toBe("unavailable");
    }
  });
});
