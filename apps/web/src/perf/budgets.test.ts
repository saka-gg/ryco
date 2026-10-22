import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  NODE_SWITCH_CONTENT_MEASURE_PREFIX,
  WEB_PERF_BUDGETS,
  evaluateMeasureDuration,
  evaluateNodeSwitchContentBudget,
  evaluateSidebarExpandBudget,
  evaluateTabSwitchBudget,
  perfMarkNamesForKey,
  readPerformanceMeasureDurationMs,
  sidebarExpandMeasureName,
  tabSwitchMeasureName,
} from "./budgets";
import {
  markNodeSwitchIntent,
  markNodeSwitchPhase,
  resetNodeSwitchInstrumentationForTests,
} from "./nodeSwitchInstrumentation";

describe("WEB_PERF_BUDGETS", () => {
  it("defines tab switch, sidebar expand and node switch ceilings", () => {
    expect(WEB_PERF_BUDGETS.tabSwitchMs).toBeGreaterThan(0);
    expect(WEB_PERF_BUDGETS.sidebarExpandMs).toBeGreaterThan(0);
    expect(WEB_PERF_BUDGETS.nodeSwitchContentMs).toBeGreaterThan(0);
  });
});

describe("evaluateMeasureDuration", () => {
  it("passes when duration is within budget", () => {
    expect(
      evaluateMeasureDuration({
        measureName: "ryco:tab-switch:env:thr_1",
        durationMs: 120,
        budgetMs: 400,
      }),
    ).toEqual({
      measureName: "ryco:tab-switch:env:thr_1",
      durationMs: 120,
      budgetMs: 400,
      withinBudget: true,
    });
  });

  it("fails when duration exceeds budget", () => {
    expect(
      evaluateMeasureDuration({
        measureName: "ryco:sidebar-expand:project-a",
        durationMs: 500,
        budgetMs: 350,
      }).withinBudget,
    ).toBe(false);
  });

  it("clamps negative durations to zero", () => {
    expect(
      evaluateMeasureDuration({
        measureName: "ryco:tab-switch:env:thr_1",
        durationMs: -10,
        budgetMs: 400,
      }).durationMs,
    ).toBe(0);
  });
});

describe("readPerformanceMeasureDurationMs", () => {
  it("returns the latest measure duration", () => {
    const entry = {
      duration: 48,
      entryType: "measure",
      name: "ryco:tab-switch:env:thr_1",
      startTime: 0,
      toJSON: () => ({}),
    } satisfies PerformanceEntry;
    const performanceObject = {
      getEntriesByName: () => [entry],
    } satisfies Pick<Performance, "getEntriesByName">;
    expect(readPerformanceMeasureDurationMs("ryco:tab-switch:env:thr_1", performanceObject)).toBe(
      48,
    );
  });

  it("returns null when no measure exists", () => {
    expect(
      readPerformanceMeasureDurationMs("ryco:tab-switch:missing", {
        getEntriesByName: () => [],
      }),
    ).toBeNull();
  });
});

describe("evaluateTabSwitchBudget", () => {
  it("evaluates the tab switch measure against the configured budget", () => {
    const entry = {
      duration: 180,
      entryType: "measure",
      name: tabSwitchMeasureName("env:thr_1"),
      startTime: 0,
      toJSON: () => ({}),
    } satisfies PerformanceEntry;
    const evaluation = evaluateTabSwitchBudget("env:thr_1", {
      getEntriesByName: (name) => (name === tabSwitchMeasureName("env:thr_1") ? [entry] : []),
    });
    expect(evaluation).toEqual({
      measureName: tabSwitchMeasureName("env:thr_1"),
      durationMs: 180,
      budgetMs: WEB_PERF_BUDGETS.tabSwitchMs,
      withinBudget: true,
    });
  });
});

describe("evaluateSidebarExpandBudget", () => {
  it("evaluates the sidebar expand measure against the configured budget", () => {
    const entry = {
      duration: 420,
      entryType: "measure",
      name: sidebarExpandMeasureName("project-a"),
      startTime: 0,
      toJSON: () => ({}),
    } satisfies PerformanceEntry;
    const evaluation = evaluateSidebarExpandBudget("project-a", {
      getEntriesByName: (name) => (name === sidebarExpandMeasureName("project-a") ? [entry] : []),
    });
    expect(evaluation?.withinBudget).toBe(false);
  });
});

describe("perfMarkNamesForKey", () => {
  it("aligns mark names with measure helpers", () => {
    expect(perfMarkNamesForKey("env:thr_1")).toEqual({
      tabSwitchClick: "ryco:tab-switch:click:env:thr_1",
      tabSwitchFirstPaint: "ryco:tab-switch:first-paint:env:thr_1",
      sidebarExpandClick: "ryco:sidebar-expand:click:env:thr_1",
      sidebarExpandFirstPaint: "ryco:sidebar-expand:first-paint:env:thr_1",
    });
  });
});

function measureEntry(name: string, duration: number): PerformanceEntry {
  return { duration, entryType: "measure", name, startTime: 0, toJSON: () => ({}) };
}

function performanceWithMeasures(entries: PerformanceEntry[]) {
  return {
    getEntriesByType: (type: string) => (type === "measure" ? entries : []),
  } satisfies Pick<Performance, "getEntriesByType">;
}

describe("evaluateNodeSwitchContentBudget", () => {
  afterEach(() => {
    resetNodeSwitchInstrumentationForTests();
    performance.clearMarks();
    performance.clearMeasures();
  });

  it("evaluates the content measure of the latest switch against the configured budget", () => {
    const evaluation = evaluateNodeSwitchContentBudget(
      performanceWithMeasures([
        measureEntry(`${NODE_SWITCH_CONTENT_MEASURE_PREFIX}2`, 600),
        measureEntry(`${NODE_SWITCH_CONTENT_MEASURE_PREFIX}10`, 150),
        measureEntry(`${NODE_SWITCH_CONTENT_MEASURE_PREFIX}9`, 900),
      ]),
    );
    expect(evaluation).toEqual({
      measureName: `${NODE_SWITCH_CONTENT_MEASURE_PREFIX}10`,
      durationMs: 150,
      budgetMs: WEB_PERF_BUDGETS.nodeSwitchContentMs,
      withinBudget: true,
    });
  });

  it("fails when the latest switch paints its content over budget", () => {
    expect(
      evaluateNodeSwitchContentBudget(
        performanceWithMeasures([
          measureEntry(`${NODE_SWITCH_CONTENT_MEASURE_PREFIX}1`, 120),
          measureEntry(`${NODE_SWITCH_CONTENT_MEASURE_PREFIX}2`, 450),
        ]),
      )?.withinBudget,
    ).toBe(false);
  });

  it("ignores other phases, tab switches and malformed names", () => {
    expect(
      evaluateNodeSwitchContentBudget(
        performanceWithMeasures([
          measureEntry("ryco:node-switch:mutation-ready:3", 80),
          measureEntry("ryco:tab-switch:env:thr_1", 80),
          measureEntry(`${NODE_SWITCH_CONTENT_MEASURE_PREFIX}latest`, 80),
          measureEntry(NODE_SWITCH_CONTENT_MEASURE_PREFIX, 80),
        ]),
      ),
    ).toBeNull();
  });

  it("returns null when no switch was measured", () => {
    expect(evaluateNodeSwitchContentBudget(performanceWithMeasures([]))).toBeNull();
  });

  it("finds the measures the node switch instrumentation records", () => {
    markNodeSwitchIntent("environment-a", "press");
    markNodeSwitchPhase("content-painted", "environment-a");
    const evaluation = evaluateNodeSwitchContentBudget();
    expect(evaluation?.measureName).toMatch(
      new RegExp(`^${NODE_SWITCH_CONTENT_MEASURE_PREFIX}\\d+$`),
    );
    expect(evaluation?.budgetMs).toBe(WEB_PERF_BUDGETS.nodeSwitchContentMs);
  });
});
