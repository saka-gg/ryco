import { describe, expect, it } from "vite-plus/test";

import { createStartupTiming, formatStartupTimingEntry } from "./startupTiming.ts";

describe("startupTiming", () => {
  it("records elapsed and delta timings", () => {
    const values = [100, 140, 175];
    const timing = createStartupTiming({ now: () => values.shift() ?? 175 });

    const first = timing.mark("desktop.launch");
    const second = timing.mark("desktop.ready", "source=test");

    expect(first).toEqual({
      phase: "desktop.launch",
      elapsedMs: 40,
      deltaMs: 40,
      detail: undefined,
    });
    expect(second).toEqual({
      phase: "desktop.ready",
      elapsedMs: 75,
      deltaMs: 35,
      detail: "source=test",
    });
    expect(timing.entries()).toEqual([first, second]);
  });

  it("formats timing entries for logs", () => {
    expect(
      formatStartupTimingEntry({
        phase: "desktop.backend.spawn",
        elapsedMs: 12.4,
        deltaMs: 8.6,
        detail: "port=3773",
      }),
    ).toBe("startup timing phase=desktop.backend.spawn elapsedMs=12 deltaMs=9 port=3773");
  });

  it("places phases recorded before the timing existed on the same scale", () => {
    const values = [500, 520];
    const timing = createStartupTiming({ now: () => values.shift() ?? 520 });

    const spawn = timing.markAt("desktop.backend.spawn", 380, "early=1");
    const ready = timing.mark("desktop.ready");

    expect(timing.origin).toBe(500);
    expect(spawn).toEqual({
      phase: "desktop.backend.spawn",
      elapsedMs: -120,
      deltaMs: -120,
      detail: "early=1",
    });
    expect(ready).toMatchObject({ elapsedMs: 20, deltaMs: 20 });
    expect(formatStartupTimingEntry(spawn)).toBe(
      "startup timing phase=desktop.backend.spawn elapsedMs=-120 deltaMs=-120 early=1",
    );
  });
});
