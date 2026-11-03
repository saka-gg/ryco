import { execFileSync } from "node:child_process";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  darwinSelfStartTime,
  defaultBootId,
  defaultProcessStartTime,
  isHolderAbandoned,
  isSameProcessStart,
  parseDarwinPsLstart,
  type ProcessProbe,
} from "./processIdentity.ts";

const BOOT = 1_784_000_000_000;
const BOOT_ID = "0b6ff1d4-6c1f-4f5e-9d38-6a1c3e2b7f10";
const OTHER_BOOT_ID = "9a2e7c41-0d5b-4b8e-a3f6-2c7d9e1f4b52";

const probeFor = (input: {
  readonly platform?: NodeJS.Platform;
  readonly bootId?: string;
  readonly alive?: ReadonlySet<number>;
  readonly startTimes?: ReadonlyMap<number, string>;
}): ProcessProbe => ({
  platform: input.platform ?? "linux",
  bootTime: () => BOOT,
  bootId: async () => input.bootId,
  processAlive: (pid) => input.alive?.has(pid) ?? false,
  processStartTime: async (pid) => input.startTimes?.get(pid),
});

describe("parseDarwinPsLstart", () => {
  it("reads `ps -o lstart=` output in UTC, padding included", () => {
    // `ps` pads the column: the real output ends in spaces and a newline.
    expect(parseDarwinPsLstart("Fri Oct 23 16:53:37 2026    \n")).toBe(
      String(Date.UTC(2026, 9, 23, 16, 53, 37) / 1_000),
    );
    expect(parseDarwinPsLstart("Mon Mar  2 04:05:06 2026")).toBe(
      String(Date.UTC(2026, 2, 2, 4, 5, 6) / 1_000),
    );
  });

  it("rejects anything else", () => {
    expect(parseDarwinPsLstart("")).toBeUndefined();
    expect(parseDarwinPsLstart("ps: process not found")).toBeUndefined();
    expect(parseDarwinPsLstart("Fri Foo 23 16:53:37 2026")).toBeUndefined();
    expect(parseDarwinPsLstart("Fri Oct 23 16:53 2026")).toBeUndefined();
  });

  it.skipIf(process.platform !== "darwin")(
    "agrees with this process's own uptime-based estimate",
    async () => {
      const output = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], {
        env: { LC_ALL: "C", TZ: "UTC0" },
        encoding: "utf8",
      });
      const fromPs = parseDarwinPsLstart(output);
      expect(fromPs).toBeDefined();
      expect(isSameProcessStart(darwinSelfStartTime(), fromPs, "darwin")).toBe(true);
      expect(await defaultProcessStartTime(process.pid)).toBe(darwinSelfStartTime());
    },
  );
});

describe("darwinSelfStartTime", () => {
  it("is estimated once, so a later clock step does not move it", () => {
    const first = darwinSelfStartTime();
    // The wall clock stepped back 5 s (a time sync after a long wait).
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 5_000);
    try {
      expect(darwinSelfStartTime()).toBe(first);
    } finally {
      now.mockRestore();
    }
  });
});

describe("isSameProcessStart", () => {
  it("compares Linux clock ticks exactly", () => {
    expect(isSameProcessStart("5000", "5000", "linux")).toBe(true);
    expect(isSameProcessStart("5000", "5001", "linux")).toBe(false);
  });

  it("on macOS, tells a process that started after the recorded time from the holder", () => {
    // `ps` truncates, the holder's own estimate rounds.
    expect(isSameProcessStart("1784000000", "1784000002", "darwin")).toBe(true);
    expect(isSameProcessStart("1784000002", "1784000000", "darwin")).toBe(true);
    // The holder's runtime took 30 s to initialize: its record trails its exec.
    expect(isSameProcessStart("1784000030", "1784000000", "darwin")).toBe(true);
    // The pid now belongs to a process that started after the holder.
    expect(isSameProcessStart("1784000000", "1784000003", "darwin")).toBe(false);
  });

  it("is unknown without both values or a platform that records them", () => {
    expect(isSameProcessStart(undefined, "5000", "linux")).toBeUndefined();
    expect(isSameProcessStart("5000", undefined, "darwin")).toBeUndefined();
    expect(isSameProcessStart("5000", "9000", "win32")).toBeUndefined();
  });
});

describe("defaultBootId", () => {
  it("is looked up once per process", async () => {
    const first = defaultBootId();
    expect(defaultBootId()).toBe(first);
    await first;
  });
});

describe("isHolderAbandoned", () => {
  const holder = { pid: 100, bootTime: BOOT, bootId: BOOT_ID, startTime: "5000" };

  it("keeps a live holder from this boot that started when it says", async () => {
    await expect(
      isHolderAbandoned(
        holder,
        probeFor({ bootId: BOOT_ID, alive: new Set([100]), startTimes: new Map([[100, "5000"]]) }),
      ),
    ).resolves.toBe(false);
  });

  it("drops a holder from another boot, a dead one, and a reused pid", async () => {
    const alive = new Set([100]);
    await expect(
      isHolderAbandoned(holder, probeFor({ bootId: OTHER_BOOT_ID, alive })),
    ).resolves.toBe(true);
    await expect(isHolderAbandoned(holder, probeFor({ bootId: BOOT_ID }))).resolves.toBe(true);
    await expect(
      isHolderAbandoned(
        holder,
        probeFor({ bootId: BOOT_ID, alive, startTimes: new Map([[100, "9000"]]) }),
      ),
    ).resolves.toBe(true);
  });

  it("closes the macOS pid-reuse gap within the start-time tolerance", async () => {
    const darwinHolder = { ...holder, startTime: "1784000000" };
    const alive = new Set([100]);
    await expect(
      isHolderAbandoned(
        darwinHolder,
        probeFor({
          platform: "darwin",
          bootId: BOOT_ID,
          alive,
          startTimes: new Map([[100, "1784000001"]]),
        }),
      ),
    ).resolves.toBe(false);
    await expect(
      isHolderAbandoned(
        darwinHolder,
        probeFor({
          platform: "darwin",
          bootId: BOOT_ID,
          alive,
          startTimes: new Map([[100, "1784000500"]]),
        }),
      ),
    ).resolves.toBe(true);
  });

  it("trusts a live pid whose start time cannot be read", async () => {
    await expect(
      isHolderAbandoned(holder, probeFor({ bootId: BOOT_ID, alive: new Set([100]) })),
    ).resolves.toBe(false);
    await expect(
      isHolderAbandoned(
        { ...holder, bootId: undefined, startTime: undefined },
        probeFor({ alive: new Set([100]) }),
      ),
    ).resolves.toBe(false);
  });
});
