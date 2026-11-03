import { describe, expect, it } from "vite-plus/test";

import { describeHostFreeze, HOST_FREEZE_NOTICE_MS, nextHostFreezeExpiryMs } from "./hostFreeze.ts";

const AT = Date.parse("2026-10-30T14:02:00.000Z");
const at = (ms: number) => `T${ms === Date.parse("2026-10-30T14:02:00.000Z") ? "14:02" : "?"}`;

describe("describeHostFreeze", () => {
  it("says how long the machine froze, when, and how loaded it was", () => {
    expect(
      describeHostFreeze(
        {
          startedAt: "2026-10-30T14:02:00.000Z",
          durationMs: 7_250,
          loadAverage1m: 22.3,
          cpuCount: 8,
        },
        { nowMs: AT, formatTime: at },
      ),
    ).toBe("Froze for 7 s at T14:02, load 22 on 8 cores");
    expect(
      describeHostFreeze(
        {
          startedAt: "2026-10-30T14:02:00.000Z",
          durationMs: 5_000,
          loadAverage1m: 3.14,
          cpuCount: 1,
        },
        { nowMs: AT, formatTime: at },
      ),
    ).toBe("Froze for 5 s at T14:02, load 3.1 on 1 core");
  });

  it("leaves out what the node could not measure", () => {
    expect(
      describeHostFreeze(
        { startedAt: "2026-10-30T14:02:00.000Z", durationMs: 12_400, cpuCount: 4 },
        { nowMs: AT, formatTime: at },
      ),
    ).toBe("Froze for 12 s at T14:02");
  });

  it("says nothing without a readable stall", () => {
    expect(describeHostFreeze(undefined, { nowMs: AT })).toBeNull();
    expect(
      describeHostFreeze({ startedAt: "nonsense", durationMs: 6_000 }, { nowMs: AT }),
    ).toBeNull();
  });

  it("writes the time as the device's local clock without Intl", () => {
    const text = describeHostFreeze(
      { startedAt: "2026-10-30T14:02:00.000Z", durationMs: 6_000 },
      { nowMs: AT },
    );
    expect(text).toMatch(/^Froze for 6 s at \d{2}:\d{2}$/u);
  });

  it("goes away five minutes after the freeze, though the config still holds it", () => {
    const stall = { startedAt: "2026-10-30T14:02:00.000Z", durationMs: 6_000 };
    expect(describeHostFreeze(stall, { nowMs: AT + HOST_FREEZE_NOTICE_MS })).not.toBeNull();
    expect(describeHostFreeze(stall, { nowMs: AT + HOST_FREEZE_NOTICE_MS + 1 })).toBeNull();
    // The next day it is gone, not "at 14:02" again.
    expect(describeHostFreeze(stall, { nowMs: AT + 24 * 60 * 60_000 })).toBeNull();
  });
});

describe("nextHostFreezeExpiryMs", () => {
  it("names when the first notice still showing goes away", () => {
    const early = { startedAt: "2026-10-30T14:02:00.000Z", durationMs: 6_000 };
    const late = { startedAt: "2026-10-30T14:04:00.000Z", durationMs: 9_000 };
    expect(nextHostFreezeExpiryMs([late, undefined, early], AT + 60_000)).toBe(
      AT + HOST_FREEZE_NOTICE_MS,
    );
    // The early one is over: the late one is next.
    expect(nextHostFreezeExpiryMs([late, early], AT + HOST_FREEZE_NOTICE_MS + 1)).toBe(
      AT + 120_000 + HOST_FREEZE_NOTICE_MS,
    );
    expect(nextHostFreezeExpiryMs([late, early], AT + 60 * 60_000)).toBeNull();
    expect(nextHostFreezeExpiryMs([], AT)).toBeNull();
  });
});
