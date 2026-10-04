import { describe, expect, it } from "vite-plus/test";

import {
  usageLimitStateFromServerRateLimits,
  usageLimitStateFromWindows,
} from "./usageLimitReset.ts";

const NOW_MS = Date.parse("2026-10-04T10:00:00.000Z");
const hour = 3_600_000;

describe("usageLimitStateFromWindows", () => {
  it("needs every exhausted window to reset, so the latest reset wins", () => {
    expect(
      usageLimitStateFromWindows(
        [
          { exhausted: true, resetAtMs: NOW_MS + hour },
          { exhausted: true, resetAtMs: NOW_MS + 5 * hour },
          { exhausted: false, resetAtMs: NOW_MS + 9 * hour },
        ],
        NOW_MS,
      ),
    ).toEqual({ exhausted: true, resetAt: new Date(NOW_MS + 5 * hour).toISOString() });
  });

  it("reports an unknown reset when any exhausted window has none", () => {
    expect(
      usageLimitStateFromWindows(
        [
          { exhausted: true, resetAtMs: NOW_MS + hour },
          { exhausted: true, resetAtMs: null },
        ],
        NOW_MS,
      ),
    ).toEqual({ exhausted: true, resetAt: null });
  });

  it("is not exhausted without an exhausted window", () => {
    expect(usageLimitStateFromWindows([{ exhausted: false, resetAtMs: NOW_MS + hour }])).toEqual({
      exhausted: false,
      resetAt: null,
    });
  });

  it("drops windows that reset at or before now", () => {
    expect(
      usageLimitStateFromWindows(
        [
          { exhausted: true, resetAtMs: NOW_MS },
          { exhausted: true, resetAtMs: NOW_MS - hour },
        ],
        NOW_MS,
      ),
    ).toEqual({ exhausted: false, resetAt: null });
  });
});

describe("usageLimitStateFromServerRateLimits", () => {
  const seconds = (ms: number) => ms / 1000;

  it("reads the Claude five-hour and seven-day probe", () => {
    expect(
      usageLimitStateFromServerRateLimits(
        {
          primary: {
            usedPercent: 100,
            resetsAt: seconds(NOW_MS + 2 * hour),
            windowDurationMins: 300,
          },
          secondary: { usedPercent: 40, resetsAt: seconds(NOW_MS + 90 * hour) },
        },
        NOW_MS,
      ),
    ).toEqual({ exhausted: true, resetAt: new Date(NOW_MS + 2 * hour).toISOString() });
  });

  it("reads the Codex primary and secondary snapshot", () => {
    expect(
      usageLimitStateFromServerRateLimits(
        {
          primary: { usedPercent: 100, resetsAt: seconds(NOW_MS + hour) },
          secondary: { usedPercent: 100, resetsAt: seconds(NOW_MS + 30 * hour) },
        },
        NOW_MS,
      ),
    ).toEqual({ exhausted: true, resetAt: new Date(NOW_MS + 30 * hour).toISOString() });
    expect(usageLimitStateFromServerRateLimits(undefined, NOW_MS)).toEqual({
      exhausted: false,
      resetAt: null,
    });
    expect(
      usageLimitStateFromServerRateLimits(
        { primary: { usedPercent: 100, resetsAt: seconds(NOW_MS - hour) } },
        NOW_MS,
      ),
    ).toEqual({ exhausted: false, resetAt: null });
  });
});
