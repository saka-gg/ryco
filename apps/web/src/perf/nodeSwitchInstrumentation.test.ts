import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  NODE_SWITCH_DEDUPE_WINDOW_MS,
  NODE_SWITCH_TIMELINE_LIMIT,
  markNodeSwitchIntent,
  markNodeSwitchPhase,
  readNodeSwitchTimeline,
  readNodeSwitchTimelines,
  resetNodeSwitchInstrumentationForTests,
  setNodeSwitchContext,
} from "./nodeSwitchInstrumentation";

function nodeSwitchEntries(type: "mark" | "measure"): string[] {
  return performance
    .getEntriesByType(type)
    .map((entry) => entry.name)
    .filter((name) => name.startsWith("ryco:node-switch:"));
}

describe("nodeSwitchInstrumentation", () => {
  let clock = 0;

  beforeEach(() => {
    resetNodeSwitchInstrumentationForTests();
    performance.clearMarks();
    performance.clearMeasures();
    clock = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("records each phase once per switch as a mark, a measure and a timeline entry", () => {
    markNodeSwitchIntent("env-a", "route");
    clock += 40;
    markNodeSwitchPhase("route", "env-a");
    clock += 60;
    markNodeSwitchPhase("online", "env-a");
    clock += 25;
    markNodeSwitchPhase("online", "env-a");

    expect(nodeSwitchEntries("mark")).toEqual([
      "ryco:node-switch:intent:1",
      "ryco:node-switch:route:1",
      "ryco:node-switch:online:1",
    ]);
    expect(nodeSwitchEntries("measure")).toEqual([
      "ryco:node-switch:route:1",
      "ryco:node-switch:online:1",
    ]);
    expect(readNodeSwitchTimeline()).toEqual({
      n: 1,
      phases: { intent: 0, route: 40, online: 100 },
      hubSessionVersion: null,
      warm: null,
      origin: "route",
    });
  });

  it("ignores phases without a switch and phases for another environment", () => {
    markNodeSwitchPhase("route", "env-a");
    expect(readNodeSwitchTimeline()).toBeNull();
    expect(nodeSwitchEntries("mark")).toEqual([]);

    markNodeSwitchIntent("env-a", "route");
    markNodeSwitchPhase("connecting", "env-b");
    expect(readNodeSwitchTimeline()?.phases).toEqual({ intent: 0 });
    expect(nodeSwitchEntries("mark")).toEqual(["ryco:node-switch:intent:1"]);
  });

  it("counts a press followed by its route publication as one switch", () => {
    markNodeSwitchIntent("env-a", "press");
    clock += NODE_SWITCH_DEDUPE_WINDOW_MS - 1;
    markNodeSwitchIntent("env-a", "route");
    expect(readNodeSwitchTimelines()).toHaveLength(1);
    expect(readNodeSwitchTimeline()?.origin).toBe("press");

    clock += 1;
    markNodeSwitchIntent("env-a", "route");
    expect(readNodeSwitchTimelines().map((timeline) => timeline.n)).toEqual([1, 2]);
  });

  it("completes a switch at mutation-ready but still accepts content-painted", () => {
    markNodeSwitchIntent("env-a", "route");
    markNodeSwitchPhase("route", "env-a");
    markNodeSwitchPhase("mutation-ready", "env-a");

    clock += 20 * 60_000;
    for (const phase of [
      "requesting-ticket",
      "connecting",
      "authenticating",
      "opening-channel",
      "online",
      "shell-accepted",
    ] as const) {
      markNodeSwitchPhase(phase, "env-a");
    }
    expect(Object.keys(readNodeSwitchTimeline()?.phases ?? {})).toEqual([
      "intent",
      "route",
      "mutation-ready",
    ]);
    expect(nodeSwitchEntries("mark")).toEqual([
      "ryco:node-switch:intent:1",
      "ryco:node-switch:route:1",
      "ryco:node-switch:mutation-ready:1",
    ]);

    markNodeSwitchPhase("content-painted", "env-a");
    expect(readNodeSwitchTimeline()?.phases["content-painted"]).toBe(20 * 60_000);
    expect(nodeSwitchEntries("measure")).toContain("ryco:node-switch:content-painted:1");
  });

  it("starts a new switch at once for another environment and keeps the superseded one", () => {
    markNodeSwitchIntent("env-a", "route");
    clock += 10;
    markNodeSwitchPhase("route", "env-a");
    clock += 10;
    markNodeSwitchIntent("env-b", "route");
    markNodeSwitchPhase("route", "env-a");
    markNodeSwitchPhase("route", "env-b");

    const timelines = readNodeSwitchTimelines();
    expect(timelines.map((timeline) => timeline.n)).toEqual([1, 2]);
    expect(timelines[0]?.phases).toEqual({ intent: 0, route: 10 });
    expect(timelines[1]?.phases).toEqual({ intent: 0, route: 0 });
  });

  it("annotates the current switch with its context", () => {
    setNodeSwitchContext({ hubSessionVersion: 2, warm: true });
    expect(readNodeSwitchTimeline()).toBeNull();

    markNodeSwitchIntent("env-a", "route");
    setNodeSwitchContext({ hubSessionVersion: 2, warm: true });
    expect(readNodeSwitchTimeline()).toMatchObject({ hubSessionVersion: 2, warm: true });
  });

  it("keeps the last twenty switches and clears only the evicted switch's entries", () => {
    const clearMarks = vi.spyOn(performance, "clearMarks");
    const clearMeasures = vi.spyOn(performance, "clearMeasures");

    for (let index = 0; index < NODE_SWITCH_TIMELINE_LIMIT; index += 1) {
      markNodeSwitchIntent(`env-${index}`, "route");
      markNodeSwitchPhase("route", `env-${index}`);
      clock += 5;
    }
    expect(readNodeSwitchTimelines()).toHaveLength(NODE_SWITCH_TIMELINE_LIMIT);
    expect(clearMarks).not.toHaveBeenCalled();
    expect(clearMeasures).not.toHaveBeenCalled();

    markNodeSwitchIntent("env-next", "route");
    markNodeSwitchPhase("route", "env-next");
    markNodeSwitchPhase("mutation-ready", "env-next");

    const timelines = readNodeSwitchTimelines();
    expect(timelines).toHaveLength(NODE_SWITCH_TIMELINE_LIMIT);
    expect(timelines[0]?.n).toBe(2);
    expect(timelines[timelines.length - 1]?.n).toBe(NODE_SWITCH_TIMELINE_LIMIT + 1);

    expect(clearMarks.mock.calls).toEqual([
      ["ryco:node-switch:intent:1"],
      ["ryco:node-switch:route:1"],
    ]);
    expect(clearMeasures.mock.calls).toEqual([
      ["ryco:node-switch:intent:1"],
      ["ryco:node-switch:route:1"],
    ]);

    expect(nodeSwitchEntries("mark")).not.toContain("ryco:node-switch:route:1");
    expect(nodeSwitchEntries("measure")).not.toContain("ryco:node-switch:route:1");
    // The current switch's marks and measures survive the eviction.
    expect(nodeSwitchEntries("mark")).toContain("ryco:node-switch:mutation-ready:21");
    expect(nodeSwitchEntries("measure")).toEqual(
      expect.arrayContaining([
        "ryco:node-switch:route:21",
        "ryco:node-switch:mutation-ready:21",
        "ryco:node-switch:route:2",
      ]),
    );
  });

  it("is a no-op where the Performance API is missing or throws", () => {
    vi.stubGlobal("performance", {});
    expect(() => {
      markNodeSwitchIntent("env-a", "route");
      markNodeSwitchPhase("route", "env-a");
      for (let index = 0; index <= NODE_SWITCH_TIMELINE_LIMIT; index += 1) {
        markNodeSwitchIntent(`env-${index}`, "route");
      }
    }).not.toThrow();
    vi.unstubAllGlobals();
    expect(nodeSwitchEntries("mark")).toEqual([]);

    const throwing = () => {
      throw new Error("unavailable");
    };
    vi.stubGlobal("performance", {
      now: () => clock,
      mark: throwing,
      measure: throwing,
      clearMarks: throwing,
      clearMeasures: throwing,
    });
    expect(() => {
      for (let index = 0; index <= NODE_SWITCH_TIMELINE_LIMIT; index += 1) {
        markNodeSwitchIntent(`env-throw-${index}`, "press");
        markNodeSwitchPhase("route", `env-throw-${index}`);
      }
    }).not.toThrow();
  });

  it("keeps input ids out of names and timelines", () => {
    const environmentId = "env_sensitive_canary";
    markNodeSwitchIntent(environmentId, "press");
    markNodeSwitchPhase("route", environmentId);
    markNodeSwitchPhase("mutation-ready", environmentId);

    const names = [...nodeSwitchEntries("mark"), ...nodeSwitchEntries("measure")];
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).not.toContain("sensitive_canary");
    expect(JSON.stringify(readNodeSwitchTimelines())).not.toContain("sensitive_canary");
  });

  it("hands out frozen copies", () => {
    markNodeSwitchIntent("env-a", "route");
    const timelines = readNodeSwitchTimelines();
    expect(Object.isFrozen(timelines)).toBe(true);
    expect(Object.isFrozen(timelines[0])).toBe(true);
    expect(Object.isFrozen(timelines[0]?.phases)).toBe(true);

    markNodeSwitchPhase("route", "env-a");
    expect(timelines[0]?.phases).toEqual({ intent: 0 });
    expect(readNodeSwitchTimeline()?.phases).toHaveProperty("route");
  });

  it("exposes a read-only reader function on the global for the probe", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "__rycoNodeSwitchTimelines");
    expect(descriptor?.value).toBe(readNodeSwitchTimelines);
    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.enumerable).toBe(false);

    markNodeSwitchIntent("env-a", "route");
    const read = (globalThis as { __rycoNodeSwitchTimelines?: () => unknown })
      .__rycoNodeSwitchTimelines;
    expect(read?.()).toEqual([expect.objectContaining({ n: 1, origin: "route" })]);
  });
});
