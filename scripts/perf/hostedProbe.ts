import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { Browser, BrowserContext, CDPSession, Page } from "playwright";

import { collectStartupMeasures, sanitizeDiagnostic } from "./browserProbe.ts";
import {
  CPU_PROFILE_SAMPLING_INTERVAL_US,
  createDistSourceResolver,
  summarizeCpuProfile,
  type CdpCpuProfile,
} from "./cpuProfile.ts";
import type { CpuProfileSummary, MetricAggregate } from "./model.ts";
import { aggregate } from "./statistics.ts";

/**
 * Hosted node-switch and cold-load profiles for the external harness.
 *
 * Both probes drive the production hosted web app in headless Chromium against
 * a compatible Hub (see docs/performance-testing.md): a fresh browser context
 * per run, the owner's session cookie injected for the Hub host, and metrics
 * read from the DOM the user sees (message rows, the read-only banner, the
 * composer) plus the app's own `ryco:startup:*` and node-switch marks. The
 * DOM metrics work on any build; the node-switch timelines only exist on
 * builds that expose them.
 */

export type SwitchKind = "cross-node" | "same-node";
export type ProbeSide = "baseline" | "candidate";
export type MetricSummary = Readonly<Record<string, MetricAggregate>>;

const VIEWPORT = { width: 1280, height: 800 } as const;
const FIXTURE_THREAD_ID = "fixture-thread-1";
/** Local processes share per-peer Hub rate buckets, so switches stay this far apart. */
const SWITCH_SETTLE_MS = 1_500;
const SWITCH_TIMEOUT_MS = 15_000;
/**
 * The press re-rendered the inbox and replaced the row it pressed before the
 * click. A pointer would have clicked whatever is under it now, so the switch
 * is reported as failed instead of timing out.
 */
export const SWITCH_ROW_REPLACED_ERROR = "row-replaced";
const SEND_TIMEOUT_MS = 10_000;
const SAME_NODE_CONTROLS = 3;
const CROSS_NODE_ROW_OFFSET = 3;
const SAME_NODE_ROW_OFFSET = 20;
/** The second switch of each kind is the one profiled (the first warms code paths up). */
const PROFILED_ORDINAL = 1;
const PRIME_NODE_TIMEOUT_MS = 20_000;
const PRIME_SETTLE_MS = 3_000;
const COLD_LOAD_TIMEOUT_MS = 30_000;
const STARTUP_SETTLE_MS = 500;
const HOSTED_REPORT_VERSION = 1;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The order in which two sides are measured in one iteration. It flips every
 * iteration so neither side always runs first (and warms the machine for the
 * other).
 */
export function interleavedOrder(iteration: number): readonly [ProbeSide, ProbeSide] {
  return iteration % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
}

/** Median and min-max per metric over samples; metrics without a finite value are omitted. */
export function summarizeMetrics(
  samples: ReadonlyArray<Readonly<Record<string, number | null | undefined>>>,
): MetricSummary {
  const names = new Set(samples.flatMap((sample) => Object.keys(sample)));
  const summary: Record<string, MetricAggregate> = {};
  for (const name of [...names].toSorted()) {
    const metric = aggregate(samples.map((sample) => sample[name]));
    if (metric) summary[name] = metric;
  }
  return summary;
}

/**
 * How many runs of a kind were attempted, timed out before the app was
 * writable, or failed outright, as summary entries `<kind>.runs`,
 * `<kind>.timedOut` and `<kind>.failed`. A median only covers the runs that
 * produced a metric, so the comparison reads these to see the runs it lost. The
 * entry's `count` is the number of runs tallied and its value the tally.
 */
function summarizeRunTallies(
  kind: string,
  runs: ReadonlyArray<{ readonly timedOut: boolean; readonly error: string | null }>,
): MetricSummary {
  if (runs.length === 0) return {};
  const tally = (value: number): MetricAggregate => ({
    count: runs.length,
    median: value,
    p95: value,
    maximum: value,
    minimum: value,
  });
  return {
    [`${kind}.runs`]: tally(runs.length),
    [`${kind}.timedOut`]: tally(runs.filter((run) => run.error === null && run.timedOut).length),
    [`${kind}.failed`]: tally(runs.filter((run) => run.error !== null).length),
  };
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatSummaryTable(summary: MetricSummary): string {
  return [
    "| metric | median | min-max | n |",
    "| --- | ---: | ---: | ---: |",
    ...Object.entries(summary).map(
      ([name, metric]) =>
        `| ${name} | ${formatNumber(metric.median)} | ${formatNumber(metric.minimum)}-${formatNumber(metric.maximum)} | ${metric.count} |`,
    ),
  ].join("\n");
}

export interface HostedMetricComparison {
  readonly metric: string;
  readonly baselineMedian: number | null;
  readonly candidateMedian: number | null;
  readonly delta: number | null;
  readonly deltaPercent: number | null;
  readonly target: number | null;
  /** Why the candidate's median cannot be trusted for the target; null when it can. */
  readonly incomplete: string | null;
  /** Candidate median within the target and complete; null when the metric has no target. */
  readonly passed: boolean | null;
}

/** The kind of run a metric comes from: `<kind>.<metric>` for switches, else a cold load. */
function runKindOf(metric: string): string {
  return /^(cross-node|same-node)\./u.exec(metric)?.[1] ?? "cold";
}

/**
 * Why a candidate median cannot be held to a target, or null. The median only
 * covers the runs that produced the metric, so a candidate whose runs never
 * became writable would otherwise look fast. The rule: more timed-out or failed
 * runs of the metric's kind than the baseline, or fewer samples of the metric
 * than runs of that kind that completed (neither timed out nor failed), is
 * incomplete. As many timeouts as the baseline is the setup's noise floor, so
 * the median decides then.
 */
function candidateIncompleteness(
  baseline: MetricSummary,
  candidate: MetricSummary,
  metric: string,
): string | null {
  const kind = runKindOf(metric);
  const tally = (summary: MetricSummary, name: string) => summary[`${kind}.${name}`]?.median ?? 0;
  const runs = tally(candidate, "runs");
  for (const [name, label] of [
    ["timedOut", "timed out"],
    ["failed", "failed"],
  ] as const) {
    if (tally(candidate, name) > tally(baseline, name)) {
      return `${tally(candidate, name)} of ${runs} runs ${label} (baseline ${tally(baseline, name)})`;
    }
  }
  const completed = runs - tally(candidate, "timedOut") - tally(candidate, "failed");
  const samples = candidate[metric]?.count;
  return samples !== undefined && samples < completed
    ? `${samples} of ${completed} completed runs recorded it`
    : null;
}

/**
 * Per-metric median deltas. A target is an upper bound for the candidate's
 * median; a target whose metric the candidate did not record, or whose
 * candidate runs are incomplete (see `candidateIncompleteness`), fails.
 */
export function compareHostedSummaries(
  baseline: MetricSummary,
  candidate: MetricSummary,
  targets: Readonly<Record<string, number>> = {},
): { readonly rows: readonly HostedMetricComparison[]; readonly passed: boolean } {
  const metrics = [
    ...new Set([...Object.keys(baseline), ...Object.keys(candidate), ...Object.keys(targets)]),
  ].toSorted();
  const rows = metrics.map((metric): HostedMetricComparison => {
    const baselineMedian = baseline[metric]?.median ?? null;
    const candidateMedian = candidate[metric]?.median ?? null;
    const target = targets[metric] ?? null;
    const incomplete =
      target === null ? null : candidateIncompleteness(baseline, candidate, metric);
    const delta =
      baselineMedian === null || candidateMedian === null ? null : candidateMedian - baselineMedian;
    return {
      metric,
      baselineMedian,
      candidateMedian,
      delta,
      deltaPercent:
        delta === null || baselineMedian === null || baselineMedian === 0
          ? null
          : (delta / baselineMedian) * 100,
      target,
      incomplete,
      passed:
        target === null
          ? null
          : candidateMedian !== null && candidateMedian <= target && incomplete === null,
    };
  });
  return { rows, passed: rows.every((row) => row.passed !== false) };
}

export function formatComparisonTable(rows: readonly HostedMetricComparison[]): string {
  return [
    "| metric | baseline | candidate | delta | delta % | target | result |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...rows.map(
      (row) =>
        `| ${row.metric} | ${formatNumber(row.baselineMedian)} | ${formatNumber(row.candidateMedian)} | ${formatNumber(row.delta)} | ${formatNumber(row.deltaPercent)} | ${formatNumber(row.target)} | ${row.passed === null ? "-" : row.passed ? "pass" : `FAIL${row.incomplete ? ` (${row.incomplete})` : ""}`} |`,
    ),
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMetricAggregate(value: unknown): value is MetricAggregate {
  return (
    isRecord(value) &&
    ["count", "median", "p95", "maximum", "minimum"].every(
      (key) => typeof value[key] === "number" && Number.isFinite(value[key]),
    )
  );
}

/** The metric summary of a probe result file. */
export function readHostedSummary(file: string): MetricSummary {
  const report: unknown = JSON.parse(readFileSync(file, "utf8"));
  const summary = isRecord(report) ? report.summary : undefined;
  if (!isRecord(summary) || !Object.values(summary).every(isMetricAggregate)) {
    throw new Error("The file is not a hosted probe result: it has no metric summary.");
  }
  return summary as MetricSummary;
}

export function readTargets(file: string): Record<string, number> {
  const targets: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    !isRecord(targets) ||
    !Object.values(targets).every((value) => typeof value === "number" && Number.isFinite(value))
  ) {
    throw new Error("Targets must be a JSON object mapping a metric name to a number of ms.");
  }
  return targets as Record<string, number>;
}

export function runHostedCompare(input: {
  readonly baselineFile: string;
  readonly candidateFile: string;
  readonly targetsFile: string | null;
}): { readonly rows: readonly HostedMetricComparison[]; readonly passed: boolean } {
  return compareHostedSummaries(
    readHostedSummary(input.baselineFile),
    readHostedSummary(input.candidateFile),
    input.targetsFile ? readTargets(input.targetsFile) : {},
  );
}

export interface HostedNode {
  readonly id: string;
  readonly environmentId: string;
}

/** The online nodes of a Hub node-directory response. */
export function parseOnlineNodes(body: unknown): HostedNode[] {
  const nodes = isRecord(body) ? body.nodes : undefined;
  if (!Array.isArray(nodes)) throw new Error("The Hub node directory has no node list.");
  return nodes.flatMap((node): HostedNode[] => {
    if (!isRecord(node) || !isRecord(node.presence) || node.presence.online !== true) return [];
    return typeof node.id === "string" && typeof node.environmentId === "string"
      ? [{ id: node.id, environmentId: node.environmentId }]
      : [];
  });
}

export function threadPath(node: HostedNode, threadId: string = FIXTURE_THREAD_ID): string {
  return `/node/${node.id}/${node.environmentId}/${threadId}`;
}

export interface HostedRoute {
  readonly nodeId: string;
  readonly environmentId: string;
  readonly threadId: string;
}

export function parseThreadRoute(pathname: string): HostedRoute | null {
  const match = /^\/node\/([^/]+)\/([^/]+)\/([^/]+)\/?$/u.exec(pathname);
  return match ? { nodeId: match[1]!, environmentId: match[2]!, threadId: match[3]! } : null;
}

function rowEnvironment(rowKey: string): string {
  const separator = rowKey.indexOf(":");
  return separator < 0 ? rowKey : rowKey.slice(0, separator);
}

function rowThreadId(rowKey: string): string {
  return rowKey.slice(rowKey.indexOf(":") + 1);
}

/**
 * The inbox row to click for one switch. Cross-node switches rotate through the
 * environments that list rows, starting after the current one; same-node
 * controls stay on the current environment. Rows differ per switch, never
 * repeat within a session while an unused one exists, and never carry the id of
 * the thread already open: fixture nodes generate the same message ids for the
 * same thread id, so such a switch would show no new message and could not be
 * told apart from no content at all. A cross-node switch with no other
 * environment listing rows has no row (null) rather than a same-node one, which
 * would be recorded as a cross-node switch and understate its cost.
 */
export function chooseRowKey(input: {
  readonly rowKeys: readonly string[];
  readonly kind: SwitchKind;
  readonly current: Pick<HostedRoute, "environmentId" | "threadId"> | null;
  readonly ordinal: number;
  readonly used: ReadonlySet<string>;
}): string | null {
  const environments = [...new Set(input.rowKeys.map(rowEnvironment))];
  if (environments.length === 0) return null;
  const currentIndex = input.current ? environments.indexOf(input.current.environmentId) : -1;
  const targetIndex =
    input.kind === "same-node"
      ? Math.max(0, currentIndex)
      : (currentIndex + 1) % environments.length;
  const target = environments[targetIndex]!;
  if (input.kind === "cross-node" && target === input.current?.environmentId) return null;
  const rows = input.rowKeys.filter(
    (key) => rowEnvironment(key) === target && rowThreadId(key) !== input.current?.threadId,
  );
  if (rows.length === 0) return null;
  const start =
    (input.kind === "cross-node" ? CROSS_NODE_ROW_OFFSET : SAME_NODE_ROW_OFFSET) + input.ordinal;
  for (let step = 0; step < rows.length; step += 1) {
    const key = rows[(start + step) % rows.length]!;
    if (!input.used.has(key)) return key;
  }
  return rows[start % rows.length]!;
}

/**
 * Node-switch timelines recorded since a previous read. Entries carry a switch
 * counter `n` on builds that expose the timelines; without one, the entries
 * past the previous length are taken.
 */
export function newTimelineEntries(before: unknown, after: unknown): unknown[] {
  const previous = Array.isArray(before) ? before : [];
  const current = Array.isArray(after) ? after : [];
  const counter = (entry: unknown) =>
    isRecord(entry) && typeof entry.n === "number" ? entry.n : null;
  if (current.length > 0 && current.every((entry) => counter(entry) !== null)) {
    const seen = Math.max(-1, ...previous.map((entry) => counter(entry) ?? -1));
    return current.filter((entry) => counter(entry)! > seen);
  }
  return current.slice(previous.length);
}

/** Phase offsets (ms since intent) of a timeline entry, keyed `timeline.<phase>`. */
export function timelineMetrics(entries: readonly unknown[]): Record<string, number> {
  const latest = entries.at(-1);
  const phases = isRecord(latest) && isRecord(latest.phases) ? latest.phases : {};
  return Object.fromEntries(
    Object.entries(phases).flatMap(([phase, value]) =>
      typeof value === "number" && Number.isFinite(value)
        ? [[`timeline.${phase}`, value] as const]
        : [],
    ),
  );
}

export interface SwitchRun {
  readonly kind: SwitchKind;
  readonly side: ProbeSide | null;
  readonly rowKey: string | null;
  /**
   * Epoch ms of the primary-button press that precedes the click by one task;
   * server-side evidence of what the press starts is joined from here
   * (`hosted-correlate`).
   */
  readonly pressEpochMs: number | null;
  /** Epoch ms of the click, for joining with server-side evidence (`hosted-correlate`). */
  readonly clickEpochMs: number | null;
  readonly firstFrame: number | null;
  readonly route: number | null;
  readonly content: number | null;
  readonly writable: number | null;
  readonly readOnlySeen: number | null;
  readonly sendAccepted: number | null;
  readonly detailState: string | null;
  /** `[startMsAfterClick, durationMs]` of each main-thread long task until writable. */
  readonly longTasks: ReadonlyArray<readonly [number, number]>;
  readonly timedOut: boolean;
  readonly profiled: boolean;
  readonly error: string | null;
  readonly timelines: readonly unknown[];
}

/**
 * Metrics per switch kind, `<kind>.<metric>`, and the run tallies of each kind.
 * Profiled switches are left out: sampling slows the main thread. Failed ones
 * are left out of the metrics (they have no marks) but are tallied, as are
 * timed-out ones, which only lack the marks they never reached.
 */
export function summarizeSwitchRuns(runs: readonly SwitchRun[]): MetricSummary {
  const measured = runs.filter((run) => !run.profiled);
  const samples = measured
    .filter((run) => run.error === null)
    .map((run) => {
      const metrics: Record<string, number | null> = {
        firstFrame: run.firstFrame,
        route: run.route,
        content: run.content,
        writable: run.writable,
        readOnlySeen: run.readOnlySeen,
        sendAccepted: run.sendAccepted,
        longTaskCount: run.longTasks.length,
        longTaskMaxMs: Math.max(0, ...run.longTasks.map(([, duration]) => duration)),
        longTaskTotalMs: run.longTasks.reduce((total, [, duration]) => total + duration, 0),
        ...timelineMetrics(run.timelines),
      };
      return Object.fromEntries(
        Object.entries(metrics).map(([name, value]) => [`${run.kind}.${name}`, value]),
      );
    });
  const summary: Record<string, MetricAggregate> = summarizeMetrics(samples);
  for (const kind of new Set(measured.map((run) => run.kind))) {
    Object.assign(
      summary,
      summarizeRunTallies(
        kind,
        measured.filter((run) => run.kind === kind),
      ),
    );
  }
  return summary;
}

export interface RecordedRequest {
  /** Pathname without the query. */
  readonly path: string;
  /** CDP resource type: Document, Script, Fetch, WebSocket, ... */
  readonly type: string;
  /** Pathname of the script or document that started the request. */
  readonly initiator: string | null;
  /** Milliseconds from navigation start. */
  readonly startMs: number;
  readonly endMs: number | null;
  readonly transferSize: number | null;
  /** WebSocket only: when frames arrived, in milliseconds from navigation start. */
  readonly frameTimesMs?: readonly number[] | undefined;
}

export interface CriticalPathItem {
  readonly path: string;
  readonly type: string;
  readonly initiator: string | null;
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
}

export interface CriticalPath {
  /** Chronological: the document first, the response the content waited for last. */
  readonly items: readonly CriticalPathItem[];
  /** Non-overlapping waves on the chain: the serial network round trips before content. */
  readonly serialRoundTrips: number;
  /** The same items, longest own duration first, with the module that started each. */
  readonly cutList: ReadonlyArray<
    Pick<CriticalPathItem, "path" | "type" | "initiator" | "durationMs">
  >;
}

/** When a request's last response before `limitMs` ended, or null if none had. */
function responseEndBefore(request: RecordedRequest, limitMs: number): number | null {
  if (request.frameTimesMs) {
    return request.frameTimesMs.findLast((time) => time <= limitMs) ?? null;
  }
  return request.endMs !== null && request.endMs <= limitMs ? request.endMs : null;
}

/**
 * The chain of requests the first content waited for: start from the request
 * whose response ended last before the content appeared (for a WebSocket, its
 * last frame), then follow each request to the request for the module that
 * started it, back to the document.
 */
export function computeCriticalPath(
  requests: readonly RecordedRequest[],
  firstContentMs: number,
): CriticalPath {
  let terminal: RecordedRequest | null = null;
  let terminalEnd = Number.NEGATIVE_INFINITY;
  for (const request of requests) {
    const end = responseEndBefore(request, firstContentMs);
    if (end === null) continue;
    if (end > terminalEnd || (end === terminalEnd && request.startMs > (terminal?.startMs ?? 0))) {
      terminal = request;
      terminalEnd = end;
    }
  }

  const chain: CriticalPathItem[] = [];
  const visited = new Set<RecordedRequest>();
  for (let request = terminal; request && !visited.has(request);) {
    visited.add(request);
    const end = responseEndBefore(request, firstContentMs) ?? request.startMs;
    chain.push({
      path: request.path,
      type: request.type,
      initiator: request.initiator,
      startMs: request.startMs,
      endMs: end,
      durationMs: Math.max(0, end - request.startMs),
    });
    const current: RecordedRequest = request;
    // The most recent earlier request for the initiating module.
    request =
      requests
        .filter(
          (candidate) =>
            candidate !== current &&
            current.initiator !== null &&
            candidate.path === current.initiator &&
            candidate.startMs <= current.startMs,
        )
        .toSorted((left, right) => right.startMs - left.startMs)[0] ?? null;
  }
  const items = chain.toReversed();

  let waves = 0;
  let waveEnd = Number.NEGATIVE_INFINITY;
  for (const item of items.toSorted((left, right) => left.startMs - right.startMs)) {
    if (item.startMs >= waveEnd) waves += 1;
    waveEnd = Math.max(waveEnd, item.endMs);
  }
  return {
    items,
    serialRoundTrips: waves,
    cutList: items
      .map(({ path: itemPath, type, initiator, durationMs }) => ({
        path: itemPath,
        type,
        initiator,
        durationMs,
      }))
      .toSorted((left, right) => right.durationMs - left.durationMs),
  };
}

interface CdpInitiator {
  readonly url?: string | undefined;
  readonly stack?: CdpStackTrace | undefined;
}
interface CdpStackTrace {
  readonly callFrames: ReadonlyArray<{ readonly url: string }>;
  readonly parent?: CdpStackTrace | undefined;
}

function pathnameOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.pathname : null;
  } catch {
    return null;
  }
}

/** Pathname of the script or document that started a request, from its CDP initiator. */
export function initiatorPath(initiator: CdpInitiator | undefined): string | null {
  if (!initiator) return null;
  if (initiator.url) return pathnameOf(initiator.url);
  for (let stack = initiator.stack; stack; stack = stack.parent) {
    const frame = stack.callFrames.find((candidate) => candidate.url);
    if (frame) return pathnameOf(frame.url);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Page scripts
// ---------------------------------------------------------------------------

/** Shared by the scripts below: what "writable" means in the page. */
const PAGE_SHARED_SOURCE = `
const READ_ONLY_TITLE = "Read-only hosted session";
// Runs every frame: look at the few alert titles instead of serializing the page text.
const bannerShown = () => {
  for (const title of document.querySelectorAll('[data-slot="alert-title"]')) {
    if ((title.textContent || "").includes(READ_ONLY_TITLE)) return true;
  }
  return false;
};
const composerEditable = () => {
  const composer = document.querySelector('[data-testid="composer-editor"]');
  return composer !== null && composer.getAttribute("contenteditable") !== "false" && composer.getAttribute("aria-disabled") !== "true";
};
// Builds that expose a mutation-readiness marker are measured by it; others by
// what a user can see: no read-only banner and an editable composer.
const mutationReady = () => {
  const marker = document.querySelector("[data-mutation-ready]");
  if (marker) return marker.getAttribute("data-mutation-ready") === "true";
  return !bannerShown() && composerEditable();
};
`;

/** Marks first content and writable of a page load, against navigation start. */
const COLD_LOAD_SCRIPT = `(() => {
  if (window.top !== window) return;
  ${PAGE_SHARED_SOURCE}
  const marks = {};
  window.__rycoColdLoad = marks;
  const tick = () => {
    const now = performance.now();
    if (marks.firstContent === undefined && document.querySelector("[data-message-id]")) marks.firstContent = now;
    if (marks.firstContent !== undefined && marks.writable === undefined && mutationReady()) marks.writable = now;
    if (marks.writable === undefined) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`;

/** Installs the switch probe (`window.__rycoHostedProbe`) and its long-task observer. */
export const SWITCH_PROBE_SCRIPT = `(() => {
  ${PAGE_SHARED_SOURCE}
  const longTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push([entry.startTime, entry.duration]);
    }).observe({ type: "longtask" });
  } catch (error) {}
  // A primary-button mouse press and its release, as a pointer produces before a click.
  const pointerInit = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true };
  const pressDown = (target) => {
    target.dispatchEvent(new PointerEvent("pointerdown", pointerInit));
    target.dispatchEvent(new MouseEvent("mousedown", pointerInit));
  };
  const release = (target) => {
    const init = { ...pointerInit, buttons: 0 };
    target.dispatchEvent(new PointerEvent("pointerup", init));
    target.dispatchEvent(new MouseEvent("mouseup", init));
  };
  window.__rycoHostedProbe = {
    // Presses the row, clicks it in a later task, and polls once per frame.
    switchTo(rowKey, timeoutMs) {
      return new Promise((resolve) => {
        const threadId = rowKey.slice(rowKey.indexOf(":") + 1);
        const selector = "[data-inbox-row-key=" + JSON.stringify(rowKey) + "] [data-testid='inbox-thread-row']";
        const row = document.querySelector(selector);
        if (!row) { resolve({ error: "row-missing" }); return; }
        const before = new Set(Array.from(document.querySelectorAll("[data-message-id]"), (element) => element.getAttribute("data-message-id")));
        let start = 0;
        const marks = {};
        const tick = () => {
          const now = performance.now() - start;
          if (marks.firstFrame === undefined) marks.firstFrame = Math.round(now);
          if (marks.route === undefined && location.pathname.endsWith("/" + threadId)) marks.route = Math.round(now);
          if (marks.content === undefined) {
            for (const element of document.querySelectorAll("[data-message-id]")) {
              if (!before.has(element.getAttribute("data-message-id"))) { marks.content = Math.round(now); break; }
            }
          }
          if (marks.readOnlySeen === undefined && bannerShown()) marks.readOnlySeen = Math.round(now);
          if (marks.content !== undefined && marks.writable === undefined && mutationReady()) marks.writable = Math.round(now);
          if (marks.writable !== undefined || now > timeoutMs) {
            const detail = document.querySelector("[data-thread-detail-state]");
            resolve({
              ...marks,
              timedOut: marks.writable === undefined,
              detailState: detail ? detail.getAttribute("data-thread-detail-state") : null,
              pressEpochMs: performance.timeOrigin + pressStart,
              clickEpochMs: performance.timeOrigin + start,
              longTasks: longTasks
                .filter(([startTime, duration]) => startTime + duration > start)
                .map(([startTime, duration]) => [Math.max(0, Math.round(startTime - start)), Math.round(duration)]),
            });
            return;
          }
          requestAnimationFrame(tick);
        };
        // A user presses before the click completes, and the row's press handler
        // is where the thread's detail starts loading: run that path too. A pointer
        // delivers the press in one task and the release and click in a later one,
        // so the press's handlers (and the microtasks they queue) are done before
        // the click; the timer models the shortest such gap, a tap without a hold.
        // A press that replaced the row is reported, never clicked.
        const pressStart = performance.now();
        pressDown(row);
        setTimeout(() => {
          if (document.querySelector(selector) !== row) {
            release(row);
            resolve({ error: ${JSON.stringify(SWITCH_ROW_REPLACED_ERROR)} });
            return;
          }
          start = performance.now();
          release(row);
          row.click();
          requestAnimationFrame(tick);
        }, 0);
      });
    },
    // Resolves with ms from the next Enter key press until the composer cleared
    // or a queued message appeared; null when neither happens in time.
    watchSend(timeoutMs) {
      window.__rycoSendWatch = new Promise((resolve) => {
        let pressedAt = null;
        const onKey = (event) => { if (event.key === "Enter" && pressedAt === null) pressedAt = performance.now(); };
        document.addEventListener("keydown", onKey, true);
        const deadline = performance.now() + timeoutMs + 5000;
        const finish = (value) => { document.removeEventListener("keydown", onKey, true); resolve(value); };
        const tick = () => {
          const now = performance.now();
          if (pressedAt !== null) {
            const editor = document.querySelector('[data-testid="composer-editor"]');
            const cleared = !editor || (editor.textContent || "").trim() === "";
            if (cleared || document.querySelector('[aria-label*="queued message"]')) { finish(Math.round(now - pressedAt)); return; }
            if (now - pressedAt > timeoutMs) { finish(null); return; }
          } else if (now > deadline) { finish(null); return; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    },
  };
})()`;

/** Expands every collapsed inbox section; returns how many it expanded. */
const EXPAND_SECTIONS_SCRIPT = `(() => {
  let expanded = 0;
  for (const button of document.querySelectorAll('button[aria-expanded="false"]')) {
    if (button.querySelector('h2[id^="inbox-section-"]')) {
      button.click();
      expanded += 1;
    }
  }
  return expanded;
})()`;

const READ_ROW_KEYS_SCRIPT = `Array.from(document.querySelectorAll("[data-inbox-row-key]"), (element) => element.getAttribute("data-inbox-row-key"))`;

const READ_TIMELINES_SCRIPT = `typeof globalThis.__rycoNodeSwitchTimelines === "function" ? globalThis.__rycoNodeSwitchTimelines() : null`;

/** Resolves once a registered service worker is active, or after a few seconds without one. */
const SERVICE_WORKER_READY_SCRIPT = `Promise.race([
  navigator.serviceWorker ? navigator.serviceWorker.ready.then(() => true) : Promise.resolve(false),
  new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
])`;

const READ_MEASURES_SCRIPT = `performance.getEntriesByType("measure").map((entry) => ({ name: entry.name, duration: entry.duration }))`;

// ---------------------------------------------------------------------------
// Browser and Hub plumbing
// ---------------------------------------------------------------------------

export interface HostedCookie {
  readonly cookieName: string;
  readonly cookieValue: string;
}

export function readCookieFile(file: string): HostedCookie {
  const cookie: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    !isRecord(cookie) ||
    typeof cookie.cookieName !== "string" ||
    typeof cookie.cookieValue !== "string"
  ) {
    throw new Error("The cookie file must be JSON with string cookieName and cookieValue fields.");
  }
  return { cookieName: cookie.cookieName, cookieValue: cookie.cookieValue };
}

export interface HostedProbeBaseOptions {
  readonly repoRoot: string;
  readonly hubUrl: string;
  /** Candidate Hub URL; when set, every iteration measures both Hubs, alternating who goes first. */
  readonly candidateHubUrl: string | null;
  readonly cookieFile: string;
  readonly iterations: number;
  readonly outputDir: string;
}

export interface HostedSwitchOptions extends HostedProbeBaseOptions {
  readonly send: boolean;
  readonly cpuProfileDir: string | null;
  /** Web build directory whose hidden source maps resolve CPU profile frames to sources. */
  readonly distDir: string | null;
}

export interface HostedColdLoadOptions extends HostedProbeBaseOptions {
  readonly targetPath: string | null;
  /** Measure a second load in a context that already loaded the app once. */
  readonly visited: boolean;
}

interface HubTarget {
  readonly side: ProbeSide | null;
  readonly url: URL;
}

function hubTargets(options: HostedProbeBaseOptions): HubTarget[] {
  return options.candidateHubUrl
    ? [
        { side: "baseline", url: new URL(options.hubUrl) },
        { side: "candidate", url: new URL(options.candidateHubUrl) },
      ]
    : [{ side: null, url: new URL(options.hubUrl) }];
}

/** Targets in the order one iteration measures them. */
function iterationOrder(targets: readonly HubTarget[], iteration: number): HubTarget[] {
  if (targets.length < 2) return [...targets];
  const order = interleavedOrder(iteration);
  return order.map((side) => targets.find((target) => target.side === side)!);
}

function launchBrowser(repoRoot: string): Promise<Browser> {
  // Playwright and its pinned Chromium are installed with the web package.
  const webRequire = createRequire(path.join(repoRoot, "apps/web/package.json"));
  const { chromium } = webRequire("playwright") as typeof import("playwright");
  return chromium.launch({ headless: true });
}

async function newHostedContext(
  browser: Browser,
  hub: URL,
  cookie: HostedCookie,
): Promise<BrowserContext> {
  // A fresh context per run: the hosted app's service worker and caches persist per context.
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addCookies([
    {
      name: cookie.cookieName,
      value: cookie.cookieValue,
      domain: hub.hostname,
      path: "/",
      httpOnly: true,
      secure: hub.protocol === "https:",
      sameSite: "Lax",
    },
  ]);
  return context;
}

async function fetchOnlineNodes(hub: URL, cookie: HostedCookie): Promise<HostedNode[]> {
  const response = await fetch(new URL("/api/nodes", hub), {
    headers: { cookie: `${cookie.cookieName}=${cookie.cookieValue}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`The Hub node directory answered HTTP ${response.status}.`);
  return parseOnlineNodes(await response.json());
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(sanitizeDiagnostic(error.message).slice(0, 300)));
  return errors;
}

function writeReport(outputDir: string, name: string, side: ProbeSide | null, report: object) {
  mkdirSync(outputDir, { recursive: true });
  const file = path.join(outputDir, side ? `${name}.${side}.json` : `${name}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

// ---------------------------------------------------------------------------
// hosted-switch
// ---------------------------------------------------------------------------

interface SwitchSession {
  readonly side: ProbeSide | null;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly errors: string[];
  readonly onlineNodes: number;
  readonly primeMs: number;
  readonly firstContentMs: number;
  readonly startup: Record<string, number>;
  /** Rows already opened by this session. */
  readonly used: Set<string>;
}

async function readStartupMeasures(page: Page): Promise<Record<string, number>> {
  return collectStartupMeasures(
    (await page.evaluate(READ_MEASURES_SCRIPT)) as ReadonlyArray<{
      name: string;
      duration: number;
    }>,
  );
}

async function readRowKeys(page: Page): Promise<string[]> {
  return (await page.evaluate(READ_ROW_KEYS_SCRIPT)) as string[];
}

async function waitForEnvironmentRows(
  page: Page,
  environmentId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    await page.evaluate(EXPAND_SECTIONS_SCRIPT);
    if ((await readRowKeys(page)).some((key) => rowEnvironment(key) === environmentId)) return;
    await sleep(250);
  }
  throw new Error("A node's threads never appeared in the inbox after opening one of them.");
}

/**
 * Opens the hosted app and gets every online node's threads into the inbox.
 * A fresh page load lists only the routed node's threads, and a full reload
 * forgets the others again, while in-app navigation keeps every visited
 * node's list in memory: so the first node is opened by page load and the
 * rest by in-app navigation.
 */
async function openSwitchSession(
  browser: Browser,
  target: HubTarget,
  cookie: HostedCookie,
): Promise<SwitchSession> {
  const nodes = await fetchOnlineNodes(target.url, cookie);
  if (nodes.length < 2) {
    throw new Error("Switch measurements need at least two online nodes on the Hub.");
  }
  const context = await newHostedContext(browser, target.url, cookie);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = trackPageErrors(page);
  const cdp = await context.newCDPSession(page);

  const startedAt = performance.now();
  await page.goto(new URL(threadPath(nodes[0]!), target.url).toString(), {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("[data-message-id]");
  const firstContentMs = performance.now() - startedAt;
  for (const node of nodes.slice(1)) {
    await page.evaluate(
      `(() => { const href = ${JSON.stringify(threadPath(node))}; history.pushState(history.state, "", href); dispatchEvent(new PopStateEvent("popstate", { state: history.state })); })()`,
    );
    await waitForEnvironmentRows(page, node.environmentId, PRIME_NODE_TIMEOUT_MS);
  }
  const primeMs = performance.now() - startedAt;
  const startup = await readStartupMeasures(page);
  await sleep(PRIME_SETTLE_MS);
  await page.evaluate(SWITCH_PROBE_SCRIPT);
  return {
    side: target.side,
    context,
    page,
    cdp,
    errors,
    onlineNodes: nodes.length,
    primeMs,
    firstContentMs,
    startup,
    used: new Set(),
  };
}

async function readTimelines(page: Page): Promise<unknown> {
  return await page.evaluate(READ_TIMELINES_SCRIPT);
}

interface SwitchCpuProfile {
  readonly kind: SwitchKind;
  readonly side: ProbeSide | null;
  readonly file: string;
  readonly summary: CpuProfileSummary;
}

interface SwitchInput {
  readonly session: SwitchSession;
  readonly kind: SwitchKind;
  readonly ordinal: number;
  readonly options: HostedSwitchOptions;
  readonly resolveSource: ReturnType<typeof createDistSourceResolver> | null;
  readonly cpuProfiles: SwitchCpuProfile[];
}

function failedSwitchRun(kind: SwitchKind, side: ProbeSide | null, error: string): SwitchRun {
  return {
    kind,
    side,
    rowKey: null,
    pressEpochMs: null,
    clickEpochMs: null,
    firstFrame: null,
    route: null,
    content: null,
    writable: null,
    readOnlySeen: null,
    sendAccepted: null,
    detailState: null,
    longTasks: [],
    timedOut: false,
    profiled: false,
    error,
    timelines: [],
  };
}

function errorMessage(error: unknown): string {
  return sanitizeDiagnostic(error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/** Stops the profiler and returns the profile; null when nothing was recording. */
async function stopProfiler(cdp: CDPSession): Promise<CdpCpuProfile | null> {
  try {
    return ((await cdp.send("Profiler.stop")) as { profile: CdpCpuProfile }).profile;
  } catch {
    return null;
  }
}

function recordCpuProfile(input: SwitchInput, profile: CdpCpuProfile): void {
  const { session, kind, options } = input;
  if (!options.cpuProfileDir) return;
  mkdirSync(options.cpuProfileDir, { recursive: true });
  const file = path.join(
    options.cpuProfileDir,
    `${session.side ? `${session.side}-` : ""}${kind}-switch.cpuprofile`,
  );
  writeFileSync(file, JSON.stringify(profile));
  input.cpuProfiles.push({
    kind,
    side: session.side,
    file: path.basename(file),
    summary: summarizeCpuProfile(
      profile,
      input.resolveSource ? { resolveSource: input.resolveSource } : {},
    ),
  });
}

/**
 * One switch. A failure of any step is recorded as a failed run rather than
 * thrown, so the switches measured so far are still summarized and written.
 */
async function runSwitch(input: SwitchInput): Promise<SwitchRun> {
  try {
    return await measureSwitch(input);
  } catch (error) {
    await sleep(SWITCH_SETTLE_MS);
    return failedSwitchRun(input.kind, input.session.side, errorMessage(error));
  }
}

async function measureSwitch(input: SwitchInput): Promise<SwitchRun> {
  const { session, kind, options } = input;
  const { page, cdp } = session;

  // A node switch can collapse an inbox section again (some builds remount the
  // inbox per node), which would hide the open node's rows from the same-node
  // control. Expand it and let the rows settle before choosing one.
  if (((await page.evaluate(EXPAND_SECTIONS_SCRIPT)) as number) > 0) {
    await sleep(SWITCH_SETTLE_MS);
  }
  const pathname = (await page.evaluate("location.pathname")) as string;
  const rowKey = chooseRowKey({
    rowKeys: await readRowKeys(page),
    kind,
    current: parseThreadRoute(pathname),
    ordinal: input.ordinal,
    used: session.used,
  });
  if (rowKey === null) return failedSwitchRun(kind, session.side, "no-row-available");
  session.used.add(rowKey);

  const profiled = options.cpuProfileDir !== null && input.ordinal === PROFILED_ORDINAL;
  const timelinesBefore = await readTimelines(page);
  let result: Partial<SwitchRun> & { readonly error?: string };
  try {
    if (profiled) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", {
        interval: CPU_PROFILE_SAMPLING_INTERVAL_US,
      });
      await cdp.send("Profiler.start");
    }
    result = (await page.evaluate(
      `window.__rycoHostedProbe.switchTo(${JSON.stringify(rowKey)}, ${SWITCH_TIMEOUT_MS})`,
    )) as typeof result;
  } finally {
    // Never leave the profiler running when the switch itself failed.
    if (profiled) {
      const profile = await stopProfiler(cdp);
      if (profile) recordCpuProfile(input, profile);
    }
  }
  if (result.error) return failedSwitchRun(kind, session.side, result.error);

  let sendAccepted: number | null = null;
  if (options.send && result.writable !== undefined) {
    try {
      await page.evaluate(`window.__rycoHostedProbe.watchSend(${SEND_TIMEOUT_MS})`);
      await page.locator('[data-testid="composer-editor"]').click({ timeout: SEND_TIMEOUT_MS });
      await page.keyboard.insertText(`switch probe ${input.ordinal} ${Date.now()}`);
      await page.keyboard.press("Enter");
      sendAccepted = (await page.evaluate("window.__rycoSendWatch")) as number | null;
    } catch {
      // The switch itself was measured; an unsent message only leaves its metric out.
    }
  }
  await sleep(SWITCH_SETTLE_MS);

  return {
    kind,
    side: session.side,
    rowKey,
    pressEpochMs: result.pressEpochMs ?? null,
    clickEpochMs: result.clickEpochMs ?? null,
    firstFrame: result.firstFrame ?? null,
    route: result.route ?? null,
    content: result.content ?? null,
    writable: result.writable ?? null,
    readOnlySeen: result.readOnlySeen ?? null,
    sendAccepted,
    detailState: result.detailState ?? null,
    longTasks: result.longTasks ?? [],
    timedOut: result.timedOut ?? false,
    profiled,
    error: null,
    timelines: newTimelineEntries(timelinesBefore, await readTimelines(page)),
  };
}

export async function runHostedSwitch(options: HostedSwitchOptions): Promise<MetricSummary[]> {
  const cookie = readCookieFile(options.cookieFile);
  const targets = hubTargets(options);
  const resolveSource = options.distDir
    ? createDistSourceResolver(path.join(path.resolve(options.distDir), "assets"))
    : null;
  const browser = await launchBrowser(options.repoRoot);
  const sessions: SwitchSession[] = [];
  const runs: SwitchRun[] = [];
  const cpuProfiles: SwitchCpuProfile[] = [];
  try {
    for (const target of targets) {
      console.log(`Priming ${target.side ?? "hub"} workspace...`);
      sessions.push(await openSwitchSession(browser, target, cookie));
    }
    const steps = [
      ...Array.from({ length: options.iterations }, (_, ordinal) => ({
        kind: "cross-node" as const,
        ordinal,
      })),
      ...Array.from({ length: SAME_NODE_CONTROLS }, (_, ordinal) => ({
        kind: "same-node" as const,
        ordinal,
      })),
    ];
    for (const [index, step] of steps.entries()) {
      for (const target of iterationOrder(targets, index)) {
        const session = sessions.find((candidate) => candidate.side === target.side)!;
        const run = await runSwitch({
          session,
          kind: step.kind,
          ordinal: step.ordinal,
          options,
          resolveSource,
          cpuProfiles,
        });
        runs.push(run);
        console.log(
          `${target.side ?? "hub"} ${step.kind} #${step.ordinal + 1}: ${
            run.error ??
            `content ${run.content ?? "-"} ms, writable ${run.writable ?? "-"} ms${
              options.send ? `, send accepted ${run.sendAccepted ?? "-"} ms` : ""
            }`
          }`,
        );
      }
    }

    const summaries: MetricSummary[] = [];
    for (const session of sessions) {
      const sideRuns = runs.filter((run) => run.side === session.side);
      const summary = summarizeSwitchRuns(sideRuns);
      const file = writeReport(options.outputDir, "hosted-switch", session.side, {
        version: HOSTED_REPORT_VERSION,
        command: "hosted-switch",
        side: session.side,
        hubOrigin: targets.find((target) => target.side === session.side)!.url.origin,
        generatedAt: new Date().toISOString(),
        iterations: options.iterations,
        sameNodeControls: SAME_NODE_CONTROLS,
        onlineNodes: session.onlineNodes,
        primeMs: Math.round(session.primeMs),
        firstContentMs: Math.round(session.firstContentMs),
        startup: session.startup,
        errors: session.errors,
        failures: sideRuns.filter((run) => run.error !== null || run.timedOut).length,
        summary,
        cpuProfiles: cpuProfiles.filter((profile) => profile.side === session.side),
        runs: sideRuns,
      });
      console.log(`\n${session.side ?? "Hub"} switch metrics (ms)\n${formatSummaryTable(summary)}`);
      console.log(`Result: ${file}`);
      summaries.push(summary);
    }
    return summaries;
  } finally {
    await Promise.all(sessions.map((session) => session.context.close().catch(() => undefined)));
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// hosted-cold-load
// ---------------------------------------------------------------------------

interface MutableRequest {
  type: string;
  path: string;
  initiator: string | null;
  startMs: number;
  endMs: number | null;
  transferSize: number | null;
  frameTimesMs?: number[];
}

/** Records every request and WebSocket frame time of a page over CDP, in epoch milliseconds. */
class NetworkRecorder {
  readonly #requests = new Map<string, MutableRequest>();
  #wallOffsetMs: number | null = null;

  constructor(session: CDPSession) {
    const epochMs = (timestamp: number) => timestamp * 1000 + (this.#wallOffsetMs ?? 0);
    session.on("Network.requestWillBeSent", (event) => {
      const requestPath = pathnameOf(event.request.url);
      if (requestPath === null) return;
      this.#wallOffsetMs ??= event.wallTime * 1000 - event.timestamp * 1000;
      const existing = this.#requests.get(event.requestId);
      if (existing) {
        // A redirect continues the same request.
        existing.path = requestPath;
        return;
      }
      this.#requests.set(event.requestId, {
        type: event.type ?? "Other",
        path: requestPath,
        initiator: initiatorPath(event.initiator),
        startMs: event.wallTime * 1000,
        endMs: null,
        transferSize: null,
      });
    });
    session.on("Network.loadingFinished", (event) => {
      const request = this.#requests.get(event.requestId);
      if (!request) return;
      request.endMs = epochMs(event.timestamp);
      request.transferSize = Math.max(0, event.encodedDataLength);
    });
    session.on("Network.loadingFailed", (event) => {
      const request = this.#requests.get(event.requestId);
      if (request) request.endMs = epochMs(event.timestamp);
    });
    session.on("Network.webSocketCreated", (event) => {
      const requestPath = pathnameOf(event.url.replace(/^ws/u, "http"));
      if (requestPath === null) return;
      this.#requests.set(event.requestId, {
        type: "WebSocket",
        path: requestPath,
        initiator: initiatorPath(event.initiator),
        startMs: Date.now(),
        endMs: null,
        transferSize: 0,
        frameTimesMs: [],
      });
    });
    session.on("Network.webSocketWillSendHandshakeRequest", (event) => {
      const request = this.#requests.get(event.requestId);
      if (request) request.startMs = event.wallTime * 1000;
    });
    session.on("Network.webSocketFrameReceived", (event) => {
      const request = this.#requests.get(event.requestId);
      if (!request?.frameTimesMs) return;
      request.frameTimesMs.push(epochMs(event.timestamp));
      request.transferSize = (request.transferSize ?? 0) + event.response.payloadData.length;
    });
  }

  reset(): void {
    this.#requests.clear();
  }

  /** Requests with times in milliseconds from `timeOriginMs` (the page's navigation start). */
  snapshot(timeOriginMs: number): RecordedRequest[] {
    return [...this.#requests.values()].map((request) => ({
      path: request.path,
      type: request.type,
      initiator: request.initiator,
      startMs: request.startMs - timeOriginMs,
      endMs: request.endMs === null ? null : request.endMs - timeOriginMs,
      transferSize: request.transferSize,
      frameTimesMs: request.frameTimesMs?.map((time) => time - timeOriginMs),
    }));
  }
}

export interface ColdLoadRun {
  readonly side: ProbeSide | null;
  readonly firstContent: number | null;
  readonly writable: number | null;
  readonly timedOut: boolean;
  readonly startup: Record<string, number>;
  readonly requestCount: number;
  readonly transferBytes: number;
  readonly webSocketFrames: number;
  readonly serialRoundTrips: number | null;
  readonly criticalPath: readonly CriticalPathItem[];
  readonly cutList: CriticalPath["cutList"];
  /** Uncaught errors of the page. */
  readonly errors: readonly string[];
  /** Why the load could not be measured (navigation failure, ...); null for a measured load. */
  readonly error: string | null;
}

/**
 * The metrics of cold-load runs: marks, request totals, serial round trips and
 * startup measures, and the `cold.*` run tallies. A load that could not be
 * measured has no metrics and is left out of them, but is tallied.
 */
export function summarizeColdLoadRuns(runs: readonly ColdLoadRun[]): MetricSummary {
  return {
    ...summarizeMetrics(runs.filter((run) => run.error === null).map(coldLoadMetrics)),
    ...summarizeRunTallies("cold", runs),
  };
}

function coldLoadMetrics(run: ColdLoadRun): Record<string, number | null> {
  return {
    firstContent: run.firstContent,
    writable: run.writable,
    serialRoundTrips: run.serialRoundTrips,
    requestCount: run.requestCount,
    transferBytes: run.transferBytes,
    webSocketFrames: run.webSocketFrames,
    ...Object.fromEntries(
      Object.entries(run.startup).map(([name, duration]) => [`startup.${name}`, duration]),
    ),
  };
}

function failedColdLoadRun(side: ProbeSide | null, error: string): ColdLoadRun {
  return {
    side,
    firstContent: null,
    writable: null,
    timedOut: false,
    startup: {},
    requestCount: 0,
    transferBytes: 0,
    webSocketFrames: 0,
    serialRoundTrips: null,
    criticalPath: [],
    cutList: [],
    errors: [],
    error,
  };
}

/**
 * One cold load. A failure of the load (a navigation timeout, a network error)
 * is recorded as a failed run rather than thrown, so the loads measured so far
 * are still summarized and written.
 */
async function runColdLoad(
  browser: Browser,
  target: HubTarget,
  cookie: HostedCookie,
  targetPath: string,
  options: HostedColdLoadOptions,
): Promise<ColdLoadRun> {
  try {
    return await measureColdLoad(browser, target, cookie, targetPath, options);
  } catch (error) {
    return failedColdLoadRun(target.side, errorMessage(error));
  }
}

async function measureColdLoad(
  browser: Browser,
  target: HubTarget,
  cookie: HostedCookie,
  targetPath: string,
  options: HostedColdLoadOptions,
): Promise<ColdLoadRun> {
  const context = await newHostedContext(browser, target.url, cookie);
  try {
    await context.addInitScript({ content: COLD_LOAD_SCRIPT });
    const page = await context.newPage();
    const errors = trackPageErrors(page);
    const cdp = await context.newCDPSession(page);
    const recorder = new NetworkRecorder(cdp);
    await cdp.send("Network.enable");
    const url = new URL(targetPath, target.url).toString();

    await page.goto(url, { waitUntil: "domcontentloaded" });
    if (options.visited) {
      // Let the first load finish and the service worker install, then measure a reload.
      await waitForColdLoadMarks(page);
      await page.evaluate(SERVICE_WORKER_READY_SCRIPT);
      await sleep(PRIME_SETTLE_MS);
      recorder.reset();
      await page.reload({ waitUntil: "domcontentloaded" });
    }
    const marks = await waitForColdLoadMarks(page);
    await sleep(STARTUP_SETTLE_MS);

    const timeOrigin = (await page.evaluate("performance.timeOrigin")) as number;
    const requests = recorder.snapshot(timeOrigin);
    const criticalPath =
      marks.firstContent === undefined ? null : computeCriticalPath(requests, marks.firstContent);
    return {
      side: target.side,
      firstContent: marks.firstContent === undefined ? null : Math.round(marks.firstContent),
      writable: marks.writable === undefined ? null : Math.round(marks.writable),
      timedOut: marks.writable === undefined,
      startup: await readStartupMeasures(page),
      requestCount: requests.length,
      transferBytes: requests.reduce((total, request) => total + (request.transferSize ?? 0), 0),
      webSocketFrames: requests.reduce(
        (total, request) => total + (request.frameTimesMs?.length ?? 0),
        0,
      ),
      serialRoundTrips: criticalPath?.serialRoundTrips ?? null,
      criticalPath: criticalPath?.items ?? [],
      cutList: criticalPath?.cutList ?? [],
      errors,
      error: null,
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function firstThreadPath(hub: URL, cookie: HostedCookie): Promise<string> {
  const [node] = await fetchOnlineNodes(hub, cookie);
  if (!node) throw new Error("The Hub lists no online node to load a thread from.");
  return threadPath(node);
}

async function waitForColdLoadMarks(
  page: Page,
): Promise<{ firstContent?: number; writable?: number }> {
  // A function predicate, not a string: a string is evaluated with eval in the
  // page, which a content security policy without 'unsafe-eval' refuses.
  await page
    .waitForFunction(
      () =>
        (globalThis as unknown as { readonly __rycoColdLoad?: { readonly writable?: number } })
          .__rycoColdLoad?.writable !== undefined,
      undefined,
      { timeout: COLD_LOAD_TIMEOUT_MS },
    )
    .catch(() => undefined);
  return (await page.evaluate("window.__rycoColdLoad")) as {
    firstContent?: number;
    writable?: number;
  };
}

export async function runHostedColdLoad(options: HostedColdLoadOptions): Promise<MetricSummary[]> {
  const cookie = readCookieFile(options.cookieFile);
  const targets = hubTargets(options);
  const browser = await launchBrowser(options.repoRoot);
  const runs: ColdLoadRun[] = [];
  try {
    // Resolved once per Hub and before any load: a Hub without an online node
    // is a setup error, not a failed measurement.
    const targetPaths = new Map<ProbeSide | null, string>();
    for (const target of targets) {
      targetPaths.set(
        target.side,
        options.targetPath ?? (await firstThreadPath(target.url, cookie)),
      );
    }
    for (let iteration = 0; iteration < options.iterations; iteration += 1) {
      for (const target of iterationOrder(targets, iteration)) {
        const run = await runColdLoad(
          browser,
          target,
          cookie,
          targetPaths.get(target.side)!,
          options,
        );
        runs.push(run);
        console.log(
          `${target.side ?? "hub"} load #${iteration + 1}: ${
            run.error ??
            `content ${run.firstContent ?? "-"} ms, writable ${run.writable ?? "-"} ms, ${run.serialRoundTrips ?? "-"} serial round trips`
          }`,
        );
      }
    }

    const summaries: MetricSummary[] = [];
    for (const target of targets) {
      const sideRuns = runs.filter((run) => run.side === target.side);
      const summary = summarizeColdLoadRuns(sideRuns);
      // The run closest to the median first content shows the representative critical path.
      const median = summary.firstContent?.median ?? 0;
      const representative = sideRuns
        .filter((run) => run.firstContent !== null)
        .toSorted(
          (left, right) =>
            Math.abs((left.firstContent ?? 0) - median) -
            Math.abs((right.firstContent ?? 0) - median),
        )[0];
      const file = writeReport(options.outputDir, "hosted-cold-load", target.side, {
        version: HOSTED_REPORT_VERSION,
        command: "hosted-cold-load",
        side: target.side,
        hubOrigin: target.url.origin,
        generatedAt: new Date().toISOString(),
        iterations: options.iterations,
        visited: options.visited,
        failures: sideRuns.filter((run) => run.error !== null || run.timedOut).length,
        summary,
        cutList: representative?.cutList ?? [],
        runs: sideRuns,
      });
      console.log(
        `\n${target.side ?? "Hub"} cold-load metrics (ms)\n${formatSummaryTable(summary)}`,
      );
      if (representative && representative.cutList.length > 0) {
        console.log(
          `\nCut list (own duration on the critical path, ${representative.serialRoundTrips ?? "-"} serial round trips)\n${formatCutList(representative.cutList)}`,
        );
      }
      console.log(`Result: ${file}`);
      summaries.push(summary);
    }
    return summaries;
  } finally {
    await browser.close();
  }
}

export function formatCutList(cutList: CriticalPath["cutList"]): string {
  return [
    "| own ms | type | request | started by |",
    "| ---: | --- | --- | --- |",
    ...cutList.map(
      (item) =>
        `| ${formatNumber(Math.round(item.durationMs))} | ${item.type} | ${item.path} | ${item.initiator ?? "-"} |`,
    ),
  ].join("\n");
}
