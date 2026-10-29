import type { TerminalEvent, TerminalSessionSnapshot } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTerminalHeaderActivity,
  buildTerminalTabs,
  canCreateMobileTerminalSession,
  createMobileTerminalId,
  knownTerminalSessionIds,
  normalizeTerminalLabel,
  selectRetainedRendererTerminalIds,
  terminalStatusFromEvents,
} from "./terminalSessionModel";

const event = (event: Partial<TerminalEvent> & Pick<TerminalEvent, "type">): TerminalEvent =>
  ({
    threadId: "thread-a",
    terminalId: "default",
    createdAt: "2026-08-11T12:00:00.000Z",
    ...event,
  }) as TerminalEvent;

const snapshot = (overrides: Partial<TerminalSessionSnapshot>): TerminalSessionSnapshot => ({
  threadId: "thread-a",
  terminalId: "default",
  cwd: "/repo",
  worktreePath: null,
  status: "running",
  pid: 1,
  history: "",
  exitCode: null,
  exitSignal: null,
  updatedAt: "2026-08-11T12:00:00.000Z",
  ...overrides,
});

describe("terminal session policy", () => {
  it("creates bounded stable ids and rejects non-canonical UUIDs", () => {
    expect(createMobileTerminalId("550E8400-E29B-41D4-A716-446655440000")).toBe(
      "mobile-550e8400-e29b-41d4-a716-446655440000",
    );
    expect(() => createMobileTerminalId("not-an-id")).toThrow();
  });

  it("normalizes display labels by Unicode code point", () => {
    expect(normalizeTerminalLabel("   ", "Terminal 2")).toBe("Terminal 2");
    expect(normalizeTerminalLabel("😀".repeat(40), "fallback")).toBe("😀".repeat(32));
  });

  it("caps user-created sessions at eight", () => {
    expect(
      canCreateMobileTerminalSession(Array.from({ length: 7 }, (_, index) => `t-${index}`)),
    ).toBe(true);
    expect(
      canCreateMobileTerminalSession(Array.from({ length: 8 }, (_, index) => `t-${index}`)),
    ).toBe(false);
  });

  it("knows a session only from the store or from the node's events, never from rendering", () => {
    expect(knownTerminalSessionIds({ sessions: null, defaultTerminalHasEvents: false })).toEqual(
      [],
    );
    expect(knownTerminalSessionIds({ sessions: null, defaultTerminalHasEvents: true })).toEqual([
      "default",
    ]);
    expect(
      knownTerminalSessionIds({
        sessions: { terminalIds: ["default", "b"], runningTerminalIds: [], activeTerminalId: "b" },
        defaultTerminalHasEvents: false,
      }),
    ).toEqual(["default", "b"]);
  });

  it("retains the active renderer first and then the most recent known renderers", () => {
    expect(
      selectRetainedRendererTerminalIds({
        activeTerminalId: "t-4",
        knownTerminalIds: ["t-1", "t-2", "t-3", "t-4"],
        recentTerminalIds: ["missing", "t-2", "t-3"],
        maxRetained: 3,
      }),
    ).toEqual(["t-4", "t-2", "t-3"]);
  });

  it("derives status from the snapshot a start carries and from later events", () => {
    expect(
      terminalStatusFromEvents([
        event({ type: "started", snapshot: snapshot({ status: "running" }) }),
        event({ type: "output", data: "x" }),
      ]),
    ).toEqual({ status: "running", exitCode: null });
    expect(
      terminalStatusFromEvents([
        event({ type: "started", snapshot: snapshot({}) }),
        event({ type: "exited", exitCode: 2, exitSignal: null }),
      ]),
    ).toEqual({ status: "exited", exitCode: 2 });
    expect(terminalStatusFromEvents([])).toEqual({ status: "starting", exitCode: null });
  });

  it("builds tabs with labels, status and subprocess state", () => {
    const tabs = buildTerminalTabs({
      terminalIds: ["default", "tests"],
      activeTerminalId: "tests",
      runningTerminalIds: ["default"],
      labelsByTerminalId: { tests: "Watcher" },
      statusByTerminalId: {
        default: { status: "running", exitCode: null },
        tests: { status: "exited", exitCode: 2 },
      },
    });

    expect(tabs).toEqual([
      {
        terminalId: "default",
        label: "Terminal 1",
        active: false,
        status: "running",
        hasRunningSubprocess: true,
        exitCode: null,
      },
      {
        terminalId: "tests",
        label: "Watcher",
        active: true,
        status: "exited",
        hasRunningSubprocess: false,
        exitCode: 2,
      },
    ]);
  });

  it("derives a truthful header count and activity", () => {
    expect(buildTerminalHeaderActivity({ terminalIds: [], runningTerminalIds: [] })).toEqual({
      sessionCount: 0,
      hasRunningSubprocess: false,
      badgeLabel: null,
      accessibilityLabel: "Open terminal. No terminal sessions.",
    });
    expect(
      buildTerminalHeaderActivity({
        terminalIds: ["default", "tests"],
        runningTerminalIds: ["tests"],
      }),
    ).toEqual({
      sessionCount: 2,
      hasRunningSubprocess: true,
      badgeLabel: "2",
      accessibilityLabel: "Open terminal. 2 terminal sessions. A subprocess is running.",
    });
  });
});
