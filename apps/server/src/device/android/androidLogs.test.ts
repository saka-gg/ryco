import { describe, expect, it } from "vitest";

import { androidLogResult, packagePids, parseLogcat } from "./androidLogs.ts";

const T = 1_793_991_000;
const line = (seconds: number, pid: number, level: string, tag: string, message: string) =>
  `         ${T + seconds}.123  ${pid}  ${pid} ${level} ${tag}: ${message}`;

const LOG = [
  "--------- beginning of main",
  line(0, 500, "I", "ActivityManager", "Start proc 4100:com.example.app/u0a190 for top-activity"),
  line(1, 4100, "D", "MainActivity", "onCreate"),
  line(2, 4100, "I", "Network", "GET /items 200"),
  line(3, 999, "I", "Other", "not ours"),
  line(4, 4100, "E", "AndroidRuntime", "FATAL EXCEPTION: main"),
  line(4, 4100, "E", "AndroidRuntime", "Process: com.example.app, PID: 4100"),
  line(4, 4100, "E", "AndroidRuntime", "java.lang.IllegalStateException: Cart is empty"),
  line(5, 500, "I", "ActivityManager", "Process com.example.app (pid 4100) has died"),
  line(6, 500, "I", "ActivityManager", "Start proc 4200:com.example.app/u0a190 for top-activity"),
  line(7, 500, "E", "ActivityManager", "ANR in com.example.app (com.example.app/.MainActivity)"),
  line(7, 500, "E", "ActivityManager", "PID: 4200"),
  line(7, 500, "E", "ActivityManager", "Reason: Input dispatching timed out"),
  line(8, 4300, "F", "DEBUG", "pid: 4200, tid: 4200, name: example.app  >>> com.example.app <<<"),
  line(8, 4300, "F", "DEBUG", "signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0"),
].join("\n");

describe("Android logs", () => {
  it("parses logcat epoch lines and collects the package's pids", () => {
    const entries = parseLogcat(LOG);
    expect(entries).toHaveLength(14);
    expect(entries[1]).toMatchObject({
      pid: 4100,
      level: "D",
      tag: "MainActivity",
      message: "onCreate",
    });
    expect([...packagePids(entries, "com.example.app", [4300])].toSorted()).toEqual([
      4100, 4200, 4300,
    ]);
    // A package whose name only starts with this one's is someone else's.
    expect(packagePids(entries, "com.example", []).size).toBe(0);
  });

  it("keeps the app's lines at the level asked for and summarizes crashes newest first", () => {
    const result = androidLogResult({
      query: { bundleId: "com.example.app", sinceSeconds: 60, level: "default", limit: 50 },
      output: LOG,
      livePids: [],
      sinceEpochMs: T * 1_000,
    });
    expect(result.log.some((entry) => entry.includes("onCreate"))).toBe(false);
    expect(result.log.some((entry) => entry.includes("GET /items"))).toBe(true);
    expect(result.log.some((entry) => entry.includes("not ours"))).toBe(false);
    expect(result.log.some((entry) => entry.includes("has died"))).toBe(true);
    expect(result.crashes.map((crash) => crash.exception)).toEqual([
      "SIGSEGV",
      "ANR",
      "java.lang.IllegalStateException",
    ]);
    expect(result.crashes[1]!.reason).toBe("Input dispatching timed out");
    expect(result.crashes[2]!.reason).toBe("Cart is empty");
    expect(result.process).toContain("com.example.app");
  });

  it("filters by text and window, and limits from the newest end", () => {
    const debug = androidLogResult({
      query: {
        bundleId: "com.example.app",
        sinceSeconds: 60,
        level: "debug",
        limit: 1,
        contains: "ONCREATE",
      },
      output: LOG,
      livePids: [],
      sinceEpochMs: T * 1_000,
    });
    expect(debug.log).toHaveLength(1);
    expect(debug.log[0]).toContain("onCreate");
    const later = androidLogResult({
      query: { bundleId: "com.example.app", sinceSeconds: 1, level: "error", limit: 50 },
      output: LOG,
      livePids: [],
      sinceEpochMs: (T + 9) * 1_000,
    });
    expect(later.log).toEqual([]);
    expect(later.note).toContain("No process of com.example.app");
  });
});
