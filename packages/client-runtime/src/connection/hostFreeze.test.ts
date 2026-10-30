import { describe, expect, it } from "vite-plus/test";

import { describeHostFreeze } from "./hostFreeze.ts";

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
        { formatTime: at },
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
        { formatTime: at },
      ),
    ).toBe("Froze for 5 s at T14:02, load 3.1 on 1 core");
  });

  it("leaves out what the node could not measure", () => {
    expect(
      describeHostFreeze(
        { startedAt: "2026-10-30T14:02:00.000Z", durationMs: 12_400, cpuCount: 4 },
        { formatTime: at },
      ),
    ).toBe("Froze for 12 s at T14:02");
  });

  it("says nothing without a readable stall", () => {
    expect(describeHostFreeze(undefined)).toBeNull();
    expect(describeHostFreeze({ startedAt: "nonsense", durationMs: 6_000 })).toBeNull();
  });

  it("writes the time as the device's local clock without Intl", () => {
    const text = describeHostFreeze({ startedAt: "2026-10-30T14:02:00.000Z", durationMs: 6_000 });
    expect(text).toMatch(/^Froze for 6 s at \d{2}:\d{2}$/u);
  });
});
