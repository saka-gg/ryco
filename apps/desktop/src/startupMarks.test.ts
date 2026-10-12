import { describe, expect, it, vi } from "vite-plus/test";

import {
  collectRendererStartupMarks,
  formatRendererStartupMarks,
  observeRendererStartupMarks,
  parseRendererStartupMarks,
  parseRendererStartupReport,
  SHELL_PAINTED_STARTUP_MARK,
  SHELL_USABLE_STARTUP_MARK,
} from "./startupMarks.ts";

type Entry = { name: string; startTime: number; duration: number };

function fakePerformance(entries: Entry[]) {
  return { getEntries: () => entries };
}

describe("renderer startup marks", () => {
  it("collects only Ryco startup marks, relative to navigation start", () => {
    expect(
      collectRendererStartupMarks(
        fakePerformance([
          { name: "first-paint", startTime: 10, duration: 0 },
          { name: "ryco:startup:root-before-load-start", startTime: 101.4, duration: 0 },
          { name: "ryco:startup:primary-shell-ready", startTime: 120, duration: 340.6 },
        ]),
      ),
    ).toEqual([
      { name: "root-before-load-start", startMs: 101, durationMs: 0 },
      { name: "primary-shell-ready", startMs: 120, durationMs: 341 },
    ]);
  });

  function observe(entries: Entry[], options?: { withObserver?: boolean }) {
    let observerCallback: ((list: { getEntries: () => Entry[] }) => void) | null = null;
    const disconnect = vi.fn();
    class FakeObserver {
      constructor(callback: (list: { getEntries: () => Entry[] }) => void) {
        observerCallback = callback;
      }
      observe = vi.fn();
      disconnect = disconnect;
    }
    const timers: Array<() => void> = [];
    const report = vi.fn();
    const dispose = observeRendererStartupMarks({
      performance: fakePerformance(entries),
      PerformanceObserver: options?.withObserver === false ? undefined : FakeObserver,
      report,
      setTimeout: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout: () => undefined,
    });
    const push = (entry: Entry) => {
      entries.push(entry);
      observerCallback?.({ getEntries: () => [entry] });
    };
    return { report, disconnect, timers, push, dispose };
  }

  it("reports when the shell is usable, then the paint entries once painted", () => {
    const entries: Entry[] = [];
    const { report, disconnect, push } = observe(entries);

    push({ name: "ryco:startup:root-before-load-start", startTime: 5, duration: 0 });
    expect(report).not.toHaveBeenCalled();

    push({ name: SHELL_USABLE_STARTUP_MARK, startTime: 900, duration: 0 });
    push({ name: SHELL_USABLE_STARTUP_MARK, startTime: 900, duration: 0 });
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]![0]).toEqual({
      phase: "shell-usable",
      marks: [
        { name: "root-before-load-start", startMs: 5, durationMs: 0 },
        { name: "primary-shell-usable", startMs: 900, durationMs: 0 },
      ],
    });

    entries.push({ name: "ryco:startup:primary-sidebar-commit", startTime: 900, duration: 40 });
    entries.push({ name: "ryco:startup:primary-shell-painted", startTime: 0, duration: 960 });
    push({ name: SHELL_PAINTED_STARTUP_MARK, startTime: 960, duration: 0 });
    expect(report).toHaveBeenCalledTimes(2);
    // Only what the first report did not carry; the painted mark and the
    // same-named measure from navigation start are distinct entries.
    expect(report.mock.calls[1]![0]).toEqual({
      phase: "shell-painted",
      marks: [
        { name: "primary-sidebar-commit", startMs: 900, durationMs: 40 },
        { name: "primary-shell-painted", startMs: 0, durationMs: 960 },
        { name: "primary-shell-painted", startMs: 960, durationMs: 0 },
      ],
    });
    expect(disconnect).toHaveBeenCalled();
  });

  it("stops waiting for the painted mark after a bounded time", () => {
    const entries: Entry[] = [];
    const { report, timers, push } = observe(entries);
    push({ name: SHELL_USABLE_STARTUP_MARK, startTime: 900, duration: 0 });
    entries.push({ name: "ryco:startup:primary-shell-decode", startTime: 850, duration: 12 });
    expect(timers).toHaveLength(1);
    timers[0]!();
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[1]![0]).toEqual({
      phase: "shell-painted",
      marks: [{ name: "primary-shell-decode", startMs: 850, durationMs: 12 }],
    });
    // A late painted mark reports nothing more.
    push({ name: SHELL_PAINTED_STARTUP_MARK, startTime: 9_000, duration: 0 });
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("reports everything once when the shell already painted before observing", () => {
    const { report, disconnect } = observe([
      { name: SHELL_USABLE_STARTUP_MARK, startTime: 900, duration: 0 },
      { name: SHELL_PAINTED_STARTUP_MARK, startTime: 960, duration: 0 },
    ]);
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]![0]).toEqual({
      phase: "shell-usable",
      marks: [
        { name: "primary-shell-usable", startMs: 900, durationMs: 0 },
        { name: "primary-shell-painted", startMs: 960, durationMs: 0 },
      ],
    });
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("never disturbs a page without performance observers", () => {
    const report = vi.fn();
    expect(() =>
      observeRendererStartupMarks({
        performance: fakePerformance([]),
        PerformanceObserver: undefined,
        report,
      }),
    ).not.toThrow();
    expect(report).not.toHaveBeenCalled();
  });

  it("validates reports received from a renderer", () => {
    expect(
      parseRendererStartupReport({
        phase: "shell-painted",
        marks: [{ name: "primary-shell-paint", startMs: 960.2, durationMs: 18.6 }],
      }),
    ).toEqual({
      phase: "shell-painted",
      marks: [{ name: "primary-shell-paint", startMs: 960, durationMs: 19 }],
    });
    expect(parseRendererStartupReport({ phase: "other", marks: [] })).toBeNull();
    expect(parseRendererStartupReport([])).toBeNull();
    expect(parseRendererStartupReport(null)).toBeNull();
  });

  it("validates marks received from a renderer", () => {
    expect(
      parseRendererStartupMarks([{ name: "primary-shell-usable", startMs: 1.4, durationMs: 0 }]),
    ).toEqual([{ name: "primary-shell-usable", startMs: 1, durationMs: 0 }]);
    expect(
      parseRendererStartupMarks([{ name: "has space", startMs: 1, durationMs: 0 }]),
    ).toBeNull();
    expect(parseRendererStartupMarks([{ name: "x", startMs: "1", durationMs: 0 }])).toBeNull();
    expect(parseRendererStartupMarks({})).toBeNull();
    expect(parseRendererStartupMarks(Array.from({ length: 65 }, () => ({})))).toBeNull();
  });

  it("formats one log detail per launch", () => {
    expect(
      formatRendererStartupMarks([
        { name: "primary-ws-open", startMs: 410, durationMs: 0 },
        { name: "primary-shell-ready", startMs: 120, durationMs: 800 },
      ]),
    ).toBe("primary-ws-open=410 primary-shell-ready=120+800");
  });
});
