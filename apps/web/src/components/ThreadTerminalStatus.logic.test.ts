import { describe, expect, it } from "vitest";

import {
  formatTerminalRunningLine,
  resolveThreadTerminalStatus,
} from "./ThreadTerminalStatus.logic";

describe("resolveThreadTerminalStatus", () => {
  it("stays quiet for a closed drawer with idle shells", () => {
    expect(resolveThreadTerminalStatus({ open: false, count: 3, runningCount: 0 })).toBeNull();
  });

  it("marks an open drawer even when nothing runs", () => {
    expect(resolveThreadTerminalStatus({ open: true, count: 1, runningCount: 0 })).toEqual({
      count: 1,
      runningCount: 0,
      label: "Terminal open",
    });
    expect(resolveThreadTerminalStatus({ open: true, count: 3, runningCount: 0 })?.label).toBe(
      "3 terminals open",
    );
  });

  it("marks running processes behind a closed drawer", () => {
    expect(resolveThreadTerminalStatus({ open: false, count: 1, runningCount: 1 })).toEqual({
      count: 1,
      runningCount: 1,
      label: "Terminal process running",
    });
    expect(resolveThreadTerminalStatus({ open: false, count: 3, runningCount: 2 })?.label).toBe(
      "3 terminals open · 2 running",
    );
  });
});

describe("formatTerminalRunningLine", () => {
  it("counts from two", () => {
    expect(formatTerminalRunningLine(1)).toBe("Terminal running");
    expect(formatTerminalRunningLine(2)).toBe("2 terminals running");
  });
});
