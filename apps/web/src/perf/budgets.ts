import { makeSidebarExpandMarkName, makeTabSwitchMarkName } from "./tabSwitchInstrumentation";

/** Soft ceilings for opt-in client perf profiling (`VITE_RYCO_PERF_PROFILE=1`). */
export const WEB_PERF_BUDGETS = {
  /** Thread tab switch: click mark → first paint measure. */
  tabSwitchMs: 400,
  /** Sidebar project expand: click mark → thread list first paint. */
  sidebarExpandMs: 350,
  /** Hosted node switch toward an established node: intent → thread content painted. */
  nodeSwitchContentMs: 200,
} as const satisfies Record<string, number>;

export type WebPerfBudgetKey = keyof typeof WEB_PERF_BUDGETS;

export interface PerfBudgetEvaluation {
  readonly measureName: string;
  readonly durationMs: number;
  readonly budgetMs: number;
  readonly withinBudget: boolean;
}

/**
 * Node-switch content measures are named per switch,
 * `ryco:node-switch:content-painted:<n>`, so they are found by this prefix.
 */
export const NODE_SWITCH_CONTENT_MEASURE_PREFIX = "ryco:node-switch:content-painted:";

export function tabSwitchMeasureName(key: string): string {
  return `ryco:tab-switch:${key}`;
}

export function sidebarExpandMeasureName(key: string): string {
  return `ryco:sidebar-expand:${key}`;
}

export function evaluateMeasureDuration(input: {
  measureName: string;
  budgetMs: number;
  durationMs: number;
}): PerfBudgetEvaluation {
  const durationMs = Math.max(0, input.durationMs);
  return {
    measureName: input.measureName,
    durationMs,
    budgetMs: input.budgetMs,
    withinBudget: durationMs <= input.budgetMs,
  };
}

export function readPerformanceMeasureDurationMs(
  measureName: string,
  performanceObject: Pick<Performance, "getEntriesByName"> = globalThis.performance,
): number | null {
  if (!performanceObject) {
    return null;
  }
  const entries = performanceObject.getEntriesByName(measureName, "measure");
  const latest = entries.at(-1);
  if (!latest || typeof latest.duration !== "number" || !Number.isFinite(latest.duration)) {
    return null;
  }
  return latest.duration;
}

export function evaluateTabSwitchBudget(
  key: string,
  performanceObject?: Pick<Performance, "getEntriesByName">,
): PerfBudgetEvaluation | null {
  const measureName = tabSwitchMeasureName(key);
  const durationMs = readPerformanceMeasureDurationMs(measureName, performanceObject);
  if (durationMs === null) {
    return null;
  }
  return evaluateMeasureDuration({
    measureName,
    durationMs,
    budgetMs: WEB_PERF_BUDGETS.tabSwitchMs,
  });
}

export function evaluateSidebarExpandBudget(
  key: string,
  performanceObject?: Pick<Performance, "getEntriesByName">,
): PerfBudgetEvaluation | null {
  const measureName = sidebarExpandMeasureName(key);
  const durationMs = readPerformanceMeasureDurationMs(measureName, performanceObject);
  if (durationMs === null) {
    return null;
  }
  return evaluateMeasureDuration({
    measureName,
    durationMs,
    budgetMs: WEB_PERF_BUDGETS.sidebarExpandMs,
  });
}

/** Evaluates the most recent node switch whose content paint was measured. */
export function evaluateNodeSwitchContentBudget(
  performanceObject: Pick<Performance, "getEntriesByType"> = globalThis.performance,
): PerfBudgetEvaluation | null {
  if (!performanceObject) {
    return null;
  }
  let latest: { readonly n: number; readonly entry: PerformanceEntry } | null = null;
  for (const entry of performanceObject.getEntriesByType("measure")) {
    if (!entry.name.startsWith(NODE_SWITCH_CONTENT_MEASURE_PREFIX)) {
      continue;
    }
    const switchNumber = entry.name.slice(NODE_SWITCH_CONTENT_MEASURE_PREFIX.length);
    if (!/^\d+$/.test(switchNumber) || !Number.isFinite(entry.duration)) {
      continue;
    }
    const n = Number(switchNumber);
    if (latest === null || n > latest.n) {
      latest = { n, entry };
    }
  }
  if (latest === null) {
    return null;
  }
  return evaluateMeasureDuration({
    measureName: latest.entry.name,
    durationMs: latest.entry.duration,
    budgetMs: WEB_PERF_BUDGETS.nodeSwitchContentMs,
  });
}

/** Validates mark naming stays aligned with measure helpers. */
export function perfMarkNamesForKey(key: string): {
  tabSwitchClick: string;
  tabSwitchFirstPaint: string;
  sidebarExpandClick: string;
  sidebarExpandFirstPaint: string;
} {
  return {
    tabSwitchClick: makeTabSwitchMarkName("click", key),
    tabSwitchFirstPaint: makeTabSwitchMarkName("first-paint", key),
    sidebarExpandClick: makeSidebarExpandMarkName("click", key),
    sidebarExpandFirstPaint: makeSidebarExpandMarkName("first-paint", key),
  };
}
