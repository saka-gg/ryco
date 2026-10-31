import { describe, expect, it } from "vite-plus/test";

import {
  appCrashRecords,
  formatCrashReport,
  mergeCrashRecords,
  parseStartupCrashRecords,
  stripPaths,
} from "./crashLogModel";

const startupEntry = (timestamp: number, description: string) => ({
  timestamp,
  code: "JSRuntimeError",
  level: "fatal",
  message: [
    "ErrorRecovery fatal exception: Unhandled JS Exception",
    `Description: Unhandled JS Exception: ${description}`,
    "    at renderThread (/var/containers/Bundle/Application/ABC/Ryco.app/main.jsbundle:1:2345)",
    "    at <anonymous> (<anonymous>)",
  ].join("\n"),
});

describe("crash log model", () => {
  it("reads expo-updates startup crashes like T3, and skips everything else", () => {
    const records = parseStartupCrashRecords([
      startupEntry(1_000, "TypeError: undefined is not an object"),
      { timestamp: 2_000, code: "JSRuntimeError", level: "error", message: "something else" },
      { timestamp: 3_000, code: "UpdateFailedToLoad", level: "fatal", message: "nope" },
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      timestamp: 1_000,
      description: "TypeError: undefined is not an object",
      frames: ["renderThread (main.jsbundle:1:2345)", "<anonymous>"],
      source: "startup",
    });
    expect(records[0]?.detail).not.toContain("/var/containers");
  });

  it("strips absolute paths from messages and stacks, not only frames", () => {
    expect(
      stripPaths("ENOENT: open '/var/mobile/Containers/Data/Application/X/Documents/a.json'"),
    ).toBe("ENOENT: open 'a.json'");
    expect(stripPaths("at f (file:///private/var/app/main.jsbundle:3:4)")).toBe(
      "at f (main.jsbundle:3:4)",
    );
  });

  it("merges both sources newest first, keeping a crash both caught once", () => {
    const at = Date.parse("2026-10-31T06:00:00.000Z");
    const app = appCrashRecords([
      {
        at: "2026-10-31T06:00:01.000Z",
        message: "TypeError: undefined is not an object",
        stack: null,
      },
      {
        at: "2026-10-31T07:00:00.000Z",
        message: "Error: later",
        stack: "Error: later\n    at x (/a/b/c.js:1:1)",
      },
    ]);
    const merged = mergeCrashRecords(
      app,
      parseStartupCrashRecords([startupEntry(at, "TypeError: undefined is not an object")]),
    );
    expect(merged.map((record) => record.description)).toEqual([
      "Error: later",
      "TypeError: undefined is not an object",
    ]);
    expect(merged[0]?.frames).toEqual(["x (c.js:1:1)"]);
  });

  it("puts the version, update and launch fallback above the crashes", () => {
    const report = formatCrashReport([], {
      version: "0.1.0",
      build: "preview",
      updateId: "update-1",
      channel: "preview",
      runtimeVersion: "fingerprint-1",
      emergencyLaunchReason: "Failed to launch /var/app/update.bundle",
    });
    expect(report.split("\n")).toEqual([
      "Ryco 0.1.0 (preview)",
      "Runtime: fingerprint-1",
      "Channel: preview",
      "Update: update-1",
      "This launch fell back to the bundled version: Failed to launch update.bundle",
      "No crashes recorded.",
    ]);
  });
});
