import { Buffer } from "node:buffer";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { Browser, CDPSession, Page, WebSocketRoute } from "playwright";

import {
  CPU_PROFILE_SAMPLING_INTERVAL_US,
  createDistSourceResolver,
  summarizeCpuProfile,
  type CdpCpuProfile,
} from "./cpuProfile.ts";
import {
  EMPTY_NETWORK_METRICS,
  UNSUPPORTED_SOURCE_CONTROL_METRICS,
  type BrowserVitals,
  type CpuProfileSummary,
  type PerfScenarioConfig,
  type PhaseNetworkMetrics,
  type SourceControlScenarioMetrics,
} from "./model.ts";
import type { ActiveSourceControlFixture } from "./sourceControlFixture.ts";

type NetworkPhase = "bootstrap" | "foregroundIdle" | "hiddenIdle" | "reconnect";

interface MutableNetworkMetrics {
  requests: number;
  fetchXhrRequests: number;
  failedRequests: number;
  encodedBytes: number;
  webSocketFrames: number;
  webSocketBytes: number;
}

interface BrowserProbeResult {
  readonly reconnectMs: number | null;
  readonly foregroundTaskMs: number | null;
  readonly hiddenTaskMs: number | null;
  readonly heapBeforeIdleBytes: number | null;
  readonly heapAfterIdleBytes: number | null;
  readonly vitals: BrowserVitals;
  readonly bootstrapNetwork: PhaseNetworkMetrics;
  readonly foregroundIdleNetwork: PhaseNetworkMetrics;
  readonly hiddenIdleNetwork: PhaseNetworkMetrics;
  readonly reconnectNetwork: PhaseNetworkMetrics;
  readonly sourceControl: SourceControlScenarioMetrics;
  readonly cpuProfile: CpuProfileSummary | null;
  readonly themeRecalcMs: number | null;
  readonly errors: readonly string[];
}

/** Elements the theme recalc probe styles, the size of a large real page. */
export const THEME_RECALC_PROBE_ELEMENTS = 4_400;

/**
 * Median time of one full-document style recalc plus layout after toggling the
 * `dark` root class (what a theme switch costs), over elements cloned from the
 * shell's own class lists so the selectors the app really uses are matched.
 */
export async function measureThemeRecalc(page: Page): Promise<number | null> {
  return page.evaluate((elementCount) => {
    interface BrowserElement {
      className: string;
      textContent: string | null;
      readonly offsetHeight: number;
      readonly classList: {
        add: (name: string) => void;
        remove: (name: string) => void;
        toggle: (name: string) => boolean;
      };
      style: { cssText: string };
      append: (...children: BrowserElement[]) => void;
      getAttribute: (name: string) => string | null;
      querySelectorAll: (selector: string) => Iterable<BrowserElement>;
      remove: () => void;
      setAttribute: (name: string, value: string) => void;
    }
    const browser = globalThis as unknown as {
      document: {
        body: BrowserElement;
        documentElement: BrowserElement;
        createElement: (tag: string) => BrowserElement;
      };
      getComputedStyle: (element: BrowserElement) => { readonly color: string };
    };
    const { document } = browser;
    const classLists = [
      ...new Set(
        Array.from(document.body.querySelectorAll("[class]"), (element) =>
          element.getAttribute("class"),
        ).filter((value): value is string => !!value && value.trim().length > 0),
      ),
    ];
    if (classLists.length === 0) return null;
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:absolute;left:-100000px;top:0;width:1024px;";
    for (let index = 0; index < elementCount; index += 1) {
      const element = document.createElement(index % 4 === 0 ? "button" : "div");
      element.className = classLists[index % classLists.length]!;
      element.textContent = "Probe";
      host.append(element);
    }
    document.body.append(host);
    const root = document.documentElement;
    const settle = () => {
      void browser.getComputedStyle(document.body).color;
      void document.body.offsetHeight;
    };
    settle();
    const samples: number[] = [];
    for (let run = 0; run < 7; run += 1) {
      const startedAt = performance.now();
      // What a theme switch does: guard transitions and flip the root class.
      root.classList.add("no-transitions");
      root.classList.toggle("dark");
      settle();
      samples.push(performance.now() - startedAt);
      root.classList.remove("no-transitions");
      settle();
    }
    // Seven toggles leave the opposite theme: restore the original.
    root.classList.toggle("dark");
    settle();
    host.remove();
    samples.sort((left, right) => left - right);
    return samples[Math.floor(samples.length / 2)] ?? null;
  }, THEME_RECALC_PROBE_ELEMENTS);
}

/** Where the boot CPU profile goes and which dist resolves its frames to sources. */
export interface BootCpuProfileTarget {
  readonly file: string;
  readonly assetsDir: string | null;
}

/** Main-thread work after the sidebar paints: deferred surfaces, idle preloads. */
const CPU_PROFILE_TAIL_MS = 5_000;

type SourceControlProbePhase =
  | "setup"
  | "discovery"
  | "observer-mount"
  | "active"
  | "hidden"
  | "settle-transition"
  | "settled"
  | "reconnect";

type SourceControlQueryKind = "list" | "detail" | "workflow" | "jobs" | "other";

interface SourceControlRequestObservation {
  readonly atMs: number;
  readonly key: string;
  readonly kind: SourceControlQueryKind;
  readonly phase: SourceControlProbePhase;
  readonly tag: string;
}

interface EffectRpcRequest {
  readonly _tag?: string;
  readonly id?: string | number;
  readonly payload?: Record<string, unknown>;
  readonly tag?: string;
}

interface BrowserPerfState {
  fcpMs: number | null;
  lcpMs: number | null;
  cls: number;
  longTasks: number;
  maxLongTaskMs: number;
  longTaskTotalMs: number;
}

/** The app's startup measures (`apps/web/src/perf/startupInstrumentation.ts`). */
export const STARTUP_MEASURE_PREFIX = "ryco:startup:";
export const SHELL_PAINTED_MEASURE = "primary-shell-painted";
const SHELL_PAINTED_WAIT_MS = 10_000;

/** Keeps the latest duration per startup measure, keyed without the prefix. */
export function collectStartupMeasures(
  entries: ReadonlyArray<{ readonly name: string; readonly duration: number }>,
): Record<string, number> {
  const measures: Record<string, number> = {};
  for (const entry of entries) {
    if (!entry.name.startsWith(STARTUP_MEASURE_PREFIX)) continue;
    measures[entry.name.slice(STARTUP_MEASURE_PREFIX.length)] = entry.duration;
  }
  return measures;
}

interface NavigationTimingSnapshot {
  ttfbMs: number | null;
  domContentLoadedMs: number | null;
}

function mutableNetworkMetrics(): MutableNetworkMetrics {
  return { ...EMPTY_NETWORK_METRICS };
}

function snapshotNetworkMetrics(metrics: MutableNetworkMetrics): PhaseNetworkMetrics {
  return { ...metrics };
}

const SOURCE_CONTROL_TAGS = {
  getChangeRequestDetail: "sourceControl.getChangeRequestDetail",
  getIssue: "sourceControl.getIssue",
  getWorkflowJobLog: "sourceControl.getWorkflowJobLog",
  getWorkflowRunJobs: "sourceControl.getWorkflowRunJobs",
  listChangeRequests: "sourceControl.listChangeRequests",
  listIssueAssignees: "sourceControl.listIssueAssignees",
  listIssueLabels: "sourceControl.listIssueLabels",
  listIssues: "sourceControl.listIssues",
  listWorkflowRuns: "sourceControl.listWorkflowRuns",
  searchChangeRequests: "sourceControl.searchChangeRequests",
  searchIssues: "sourceControl.searchIssues",
} as const;

const OPTION_NONE = { _id: "Option", _tag: "None" } as const;
const optionSome = <T>(value: T) => ({ _id: "Option", _tag: "Some", value }) as const;
const FIXTURE_TIMESTAMP = "2026-08-16T00:00:00.000Z";
const FIXTURE_HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

function fixtureCheckRollup(settled: boolean) {
  return [
    {
      kind: "check-run",
      name: "External performance checks",
      workflowName: "Performance fixture",
      status: optionSome(settled ? "completed" : "in_progress"),
      conclusion: settled ? optionSome("success") : OPTION_NONE,
      url: optionSome("https://example.invalid/ryco-perf/checks/1"),
      startedAt: optionSome(FIXTURE_TIMESTAMP),
      completedAt: settled ? optionSome(FIXTURE_TIMESTAMP) : OPTION_NONE,
    },
  ];
}

function fixtureChangeRequest(settled: boolean) {
  return {
    provider: "github",
    number: 1,
    title: "External performance active PR",
    url: "https://example.invalid/ryco-perf/pull/1",
    baseRefName: "main",
    headRefName: "main",
    state: settled ? "merged" : "open",
    updatedAt: optionSome(FIXTURE_TIMESTAMP),
    isDraft: false,
    author: "ryco-perf",
    commentsCount: 0,
    headSha: FIXTURE_HEAD_SHA,
    mergeability: "mergeable",
    checkRollup: fixtureCheckRollup(settled),
  } as const;
}

function fixtureChangeRequestDetail(settled: boolean) {
  return {
    ...fixtureChangeRequest(settled),
    body: "Deterministic source-control performance fixture.",
    comments: [],
    truncated: false,
    reviewers: ["reviewer"],
    participants: [{ displayName: "Performance Reviewer", username: "reviewer", role: "reviewer" }],
    commits: [
      {
        oid: FIXTURE_HEAD_SHA,
        shortOid: FIXTURE_HEAD_SHA.slice(0, 7),
        messageHeadline: "Measure active source-control refresh",
        committedDate: FIXTURE_TIMESTAMP,
        author: "Ryco Performance Fixture",
      },
    ],
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    files: [{ path: "active-source-control.txt", additions: 1, deletions: 0 }],
  } as const;
}

function fixtureWorkflowRun(settled: boolean, headSha: string) {
  return {
    provider: "github",
    runId: "run-1",
    workflowName: "Performance fixture",
    displayTitle: "External source-control performance",
    branch: optionSome("main"),
    event: "push",
    commit: {
      oid: headSha,
      shortOid: headSha.slice(0, 7),
      messageHeadline: "Measure active source-control refresh",
    },
    actor: optionSome("ryco-perf"),
    status: settled ? "completed" : "in_progress",
    conclusion: settled ? optionSome("success") : OPTION_NONE,
    startedAt: optionSome(FIXTURE_TIMESTAMP),
    updatedAt: optionSome(FIXTURE_TIMESTAMP),
    durationMs: settled ? optionSome(42_000) : OPTION_NONE,
    url: "https://example.invalid/ryco-perf/actions/runs/1",
  } as const;
}

function fixtureWorkflowJobs(settled: boolean) {
  return {
    provider: "github",
    runId: "run-1",
    jobs: [
      {
        jobId: "job-1",
        name: "Browser performance",
        status: settled ? "completed" : "in_progress",
        conclusion: settled ? optionSome("success") : OPTION_NONE,
        startedAt: optionSome(FIXTURE_TIMESTAMP),
        completedAt: settled ? optionSome(FIXTURE_TIMESTAMP) : OPTION_NONE,
        durationMs: settled ? optionSome(42_000) : OPTION_NONE,
        url: optionSome("https://example.invalid/ryco-perf/actions/jobs/1"),
        steps: [],
      },
    ],
  } as const;
}

export class DeterministicSourceControlDriver {
  readonly observations: SourceControlRequestObservation[] = [];
  phase: SourceControlProbePhase = "setup";
  private discoveryWorkflowResponses = 0;
  private prAvailable = false;
  private settled = false;

  setPhase(phase: SourceControlProbePhase): void {
    this.phase = phase;
  }

  settle(): void {
    this.settled = true;
  }

  count(phase: SourceControlProbePhase, kind?: SourceControlQueryKind, key?: string): number {
    return this.observations.filter(
      (observation) =>
        observation.phase === phase &&
        (!kind || observation.kind === kind) &&
        (!key || observation.key === key),
    ).length;
  }

  times(phase: SourceControlProbePhase, kind?: SourceControlQueryKind, key?: string): number[] {
    return this.observations
      .filter(
        (observation) =>
          observation.phase === phase &&
          (!kind || observation.kind === kind) &&
          (!key || observation.key === key),
      )
      .map((observation) => observation.atMs);
  }

  traceSummary(): string {
    const counts = new Map<string, number>();
    for (const observation of this.observations) {
      const key = `${observation.phase}:${observation.key}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].map(([key, count]) => `${key}=${count}`).join(", ");
  }

  private queryKind(request: EffectRpcRequest): SourceControlQueryKind {
    if (request.tag === SOURCE_CONTROL_TAGS.listChangeRequests) return "list";
    if (request.tag === SOURCE_CONTROL_TAGS.getChangeRequestDetail) return "detail";
    if (request.tag === SOURCE_CONTROL_TAGS.getWorkflowRunJobs) return "jobs";
    if (request.tag === SOURCE_CONTROL_TAGS.listWorkflowRuns) {
      if (this.phase === "discovery" && typeof request.payload?.commitSha !== "string") {
        return "other";
      }
      return "workflow";
    }
    return "other";
  }

  private queryKey(request: EffectRpcRequest): string {
    if (request.tag === SOURCE_CONTROL_TAGS.listChangeRequests) {
      return `list:${String(request.payload?.state ?? "")}:${String(request.payload?.limit ?? "")}`;
    }
    if (request.tag === SOURCE_CONTROL_TAGS.getChangeRequestDetail) {
      return `detail:${String(request.payload?.reference ?? "")}:${request.payload?.fullContent === true ? "full" : "summary"}`;
    }
    if (request.tag === SOURCE_CONTROL_TAGS.listWorkflowRuns) {
      if (typeof request.payload?.pullRequestNumber === "number") {
        return `workflow:pr:${request.payload.pullRequestNumber}`;
      }
      if (typeof request.payload?.commitSha === "string") {
        return `workflow:commit:${request.payload.commitSha}`;
      }
      return `workflow:branch:${String(request.payload?.branch ?? "")}`;
    }
    if (request.tag === SOURCE_CONTROL_TAGS.getWorkflowRunJobs) {
      return `jobs:${String(request.payload?.runId ?? "")}`;
    }
    return request.tag ?? "unknown";
  }

  handle(message: string | Buffer): string | null {
    const raw = typeof message === "string" ? message : message.toString("utf8");
    let request: EffectRpcRequest;
    try {
      request = JSON.parse(raw) as EffectRpcRequest;
    } catch {
      return null;
    }
    if (
      request._tag !== "Request" ||
      typeof request.tag !== "string" ||
      !request.tag.startsWith("sourceControl.") ||
      request.id === undefined
    ) {
      return null;
    }

    const kind = this.queryKind(request);
    this.observations.push({
      atMs: performance.now(),
      key: this.queryKey(request),
      kind,
      phase: this.phase,
      tag: request.tag,
    });
    const value = this.responseValue(request);
    return JSON.stringify({
      _tag: "Exit",
      requestId: request.id,
      exit: { _tag: "Success", value },
    });
  }

  private responseValue(request: EffectRpcRequest): unknown {
    switch (request.tag) {
      case SOURCE_CONTROL_TAGS.listChangeRequests:
      case SOURCE_CONTROL_TAGS.searchChangeRequests:
        return this.prAvailable ? [fixtureChangeRequest(this.settled)] : [];
      case SOURCE_CONTROL_TAGS.getChangeRequestDetail:
        return fixtureChangeRequestDetail(this.settled);
      case SOURCE_CONTROL_TAGS.listWorkflowRuns: {
        if (this.phase === "discovery" && typeof request.payload?.commitSha === "string") {
          this.discoveryWorkflowResponses += 1;
          if (this.discoveryWorkflowResponses === 1) {
            return {
              provider: "github",
              repository: optionSome("ryco-perf/external-performance-fixture"),
              pullRequestNumber: OPTION_NONE,
              headSha: OPTION_NONE,
              runs: [],
            };
          }
          this.prAvailable = true;
        }
        const payloadHeadSha = request.payload?.commitSha;
        const headSha = typeof payloadHeadSha === "string" ? payloadHeadSha : FIXTURE_HEAD_SHA;
        return {
          provider: "github",
          repository: optionSome("ryco-perf/external-performance-fixture"),
          pullRequestNumber: request.payload?.pullRequestNumber === 1 ? optionSome(1) : OPTION_NONE,
          headSha: optionSome(headSha),
          runs: this.phase === "setup" ? [] : [fixtureWorkflowRun(this.settled, headSha)],
        };
      }
      case SOURCE_CONTROL_TAGS.getWorkflowRunJobs:
        return fixtureWorkflowJobs(this.settled);
      case SOURCE_CONTROL_TAGS.getWorkflowJobLog:
        return { provider: "github", runId: "run-1", jobId: "job-1", log: "", truncated: false };
      case SOURCE_CONTROL_TAGS.listIssues:
      case SOURCE_CONTROL_TAGS.searchIssues:
      case SOURCE_CONTROL_TAGS.listIssueAssignees:
      case SOURCE_CONTROL_TAGS.listIssueLabels:
        return [];
      case SOURCE_CONTROL_TAGS.getIssue:
        return {
          provider: "github",
          number: 1,
          title: "External performance fixture",
          url: "https://example.invalid/ryco-perf/issues/1",
          state: "open",
          updatedAt: optionSome(FIXTURE_TIMESTAMP),
          body: "",
          comments: [],
          truncated: false,
        };
      default:
        return {};
    }
  }
}

function payloadBytes(payloadData: string, opcode: number): number {
  if (opcode === 2) {
    try {
      return Buffer.from(payloadData, "base64").byteLength;
    } catch {
      return Buffer.byteLength(payloadData);
    }
  }
  return Buffer.byteLength(payloadData);
}

export function sanitizeDiagnostic(message: string): string {
  return message
    .replace(/\b(?:https?|wss?):\/\/[^\s'"<>]+/giu, (rawUrl) => {
      try {
        const url = new URL(rawUrl);
        return `${url.protocol}//${url.host}${url.pathname}${url.search || url.hash ? "?[redacted]" : ""}`;
      } catch {
        return "[redacted-url]";
      }
    })
    .replace(
      /\b(token|secret|password|credential|authorization|cookie|session[-_]?id)\s*[:=]\s*([^\s&]+)/giu,
      "$1=[redacted]",
    );
}

function cdpMetricValue(
  response: { readonly metrics?: ReadonlyArray<{ readonly name: string; readonly value: number }> },
  name: string,
): number | null {
  const value = response.metrics?.find((metric) => metric.name === name)?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function readCdpRuntimeMetrics(session: CDPSession): Promise<{
  readonly taskMs: number | null;
  readonly heapBytes: number | null;
}> {
  const metrics = (await session.send("Performance.getMetrics")) as {
    readonly metrics?: ReadonlyArray<{ readonly name: string; readonly value: number }>;
  };
  const taskSeconds = cdpMetricValue(metrics, "TaskDuration");
  return {
    taskMs: taskSeconds === null ? null : taskSeconds * 1_000,
    heapBytes: cdpMetricValue(metrics, "JSHeapUsedSize"),
  };
}

function durationDelta(after: number | null, before: number | null): number | null {
  if (after === null || before === null) return null;
  return Math.max(0, after - before);
}

async function forceDocumentVisibility(page: Page, state: "hidden" | "visible"): Promise<void> {
  await page.evaluate((nextState) => {
    const setter = (
      globalThis as unknown as {
        readonly __rycoSetExternalVisibility?: (value: "hidden" | "visible") => void;
      }
    ).__rycoSetExternalVisibility;
    if (!setter) throw new Error("External visibility controller was not installed.");
    setter(nextState);
  }, state);
}

function nearestRankP95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null;
}

function medianValue(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const left = sorted[middle - 1];
  const right = sorted[middle];
  return left === undefined || right === undefined ? null : (left + right) / 2;
}

function sourceControlPrimaryCount(
  driver: DeterministicSourceControlDriver,
  phase: SourceControlProbePhase,
): number {
  return (
    driver.count(phase, "list") +
    driver.count(phase, "detail") +
    driver.count(phase, "workflow") +
    driver.count(phase, "jobs")
  );
}

async function waitForSourceControlCount(input: {
  readonly driver: DeterministicSourceControlDriver;
  readonly phase: SourceControlProbePhase;
  readonly kind?: SourceControlQueryKind;
  readonly minimum: number;
  readonly timeoutMs: number;
  readonly page: Page;
}): Promise<void> {
  const deadline = performance.now() + input.timeoutMs;
  while (input.driver.count(input.phase, input.kind) < input.minimum) {
    if (performance.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${input.minimum} ${input.kind ?? "source-control"} request(s) during ${input.phase}.`,
      );
    }
    await input.page.waitForTimeout(100);
  }
}

async function waitForSourceControlQuiescence(input: {
  readonly driver: DeterministicSourceControlDriver;
  readonly phase: SourceControlProbePhase;
  readonly quietMs: number;
  readonly timeoutMs: number;
  readonly page: Page;
}): Promise<void> {
  const deadline = performance.now() + input.timeoutMs;
  let lastCount = sourceControlPrimaryCount(input.driver, input.phase);
  let unchangedSince = performance.now();
  while (performance.now() - unchangedSince < input.quietMs) {
    if (performance.now() >= deadline) {
      throw new Error(`Source-control requests did not quiesce during ${input.phase}.`);
    }
    await input.page.waitForTimeout(100);
    const nextCount = sourceControlPrimaryCount(input.driver, input.phase);
    if (nextCount !== lastCount) {
      lastCount = nextCount;
      unchangedSince = performance.now();
    }
  }
}

async function startStatusMotionFrameSampler(page: Page, rows: number): Promise<number> {
  return await page.evaluate((rowCount) => {
    interface BrowserStyle {
      cssText: string;
      setProperty: (name: string, value: string) => void;
    }
    interface BrowserElement {
      childElementCount: number;
      className: string;
      id: string;
      style: BrowserStyle;
      textContent: string | null;
      append: (...children: BrowserElement[]) => void;
      remove: () => void;
      setAttribute: (name: string, value: string) => void;
    }
    const browserGlobal = globalThis as unknown as {
      __rycoExternalStatusFrames?: {
        active: boolean;
        frames: number[];
        lastAt: number | null;
      };
      document: {
        body: BrowserElement;
        createElement: (tag: string) => BrowserElement;
        getElementById: (id: string) => BrowserElement | null;
      };
      requestAnimationFrame: (callback: (now: number) => void) => number;
    };
    const existing = browserGlobal.document.getElementById("ryco-external-perf-status-motion");
    existing?.remove();
    const host = browserGlobal.document.createElement("aside");
    host.id = "ryco-external-perf-status-motion";
    host.setAttribute("aria-label", "External performance status motion fixture");
    host.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:2147483646;width:260px;padding:10px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:8px;background:var(--background);display:grid;gap:4px;contain:layout paint style";
    for (let index = 0; index < rowCount; index += 1) {
      const row = browserGlobal.document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:7px;min-width:0;font-size:12px";
      const signal = browserGlobal.document.createElement("span");
      signal.className = "status-activity-signal size-[9px] text-sky-500";
      const core = browserGlobal.document.createElement("span");
      core.className = "size-full rounded-full bg-sky-500";
      signal.append(core);
      const label = browserGlobal.document.createElement("span");
      label.className =
        "sidebar-status-text sidebar-status-text--in-progress sidebar-status-text--flow";
      label.style.setProperty("--sidebar-status-text-spread", "28px");
      label.textContent = `Working session ${index + 1}`;
      row.append(signal, label);
      host.append(row);
    }
    browserGlobal.document.body.append(host);
    const state = { active: true, frames: [] as number[], lastAt: null as number | null };
    browserGlobal.__rycoExternalStatusFrames = state;
    const sample = (now: number) => {
      if (!state.active) return;
      if (state.lastAt !== null) state.frames.push(now - state.lastAt);
      state.lastAt = now;
      browserGlobal.requestAnimationFrame(sample);
    };
    browserGlobal.requestAnimationFrame(sample);
    return host.childElementCount;
  }, rows);
}

async function stopStatusMotionFrameSampler(page: Page): Promise<number[]> {
  return await page.evaluate(() => {
    const browserGlobal = globalThis as unknown as {
      __rycoExternalStatusFrames?: {
        active: boolean;
        frames: number[];
      };
    };
    const state = browserGlobal.__rycoExternalStatusFrames;
    if (!state) return [];
    state.active = false;
    return [...state.frames];
  });
}

function activeCadenceMs(driver: DeterministicSourceControlDriver): number | null {
  const deltas: number[] = [];
  for (let index = 0; index < driver.observations.length; index += 1) {
    const current = driver.observations[index];
    if (!current || current.phase !== "active" || current.kind === "other") continue;
    const previous = driver.observations
      .slice(0, index)
      .findLast((observation) => observation.key === current.key);
    if (previous) deltas.push(current.atMs - previous.atMs);
  }
  return medianValue(deltas);
}

async function runActiveSourceControlScenario(input: {
  readonly driver: DeterministicSourceControlDriver;
  readonly fixture: ActiveSourceControlFixture;
  readonly page: Page;
  readonly scenario: PerfScenarioConfig;
  readonly session: CDPSession;
  readonly setNetworkPhase: (phase: "foregroundIdle" | "hiddenIdle") => void;
}): Promise<{
  readonly foregroundTaskMs: number | null;
  readonly heapAfterIdleBytes: number | null;
  readonly heapBeforeIdleBytes: number | null;
  readonly hiddenTaskMs: number | null;
  readonly metrics: SourceControlScenarioMetrics;
}> {
  const { driver, fixture, page, scenario, session } = input;
  input.setNetworkPhase("foregroundIdle");
  const beforeScenario = await readCdpRuntimeMetrics(session);
  const newThreadButton = page.getByTestId("new-thread-composer-button").first();
  await newThreadButton.waitFor({ state: "attached", timeout: 15_000 });
  await newThreadButton.click({ force: true });

  const overviewToggle = page.getByRole("button", { name: "Toggle overview panel" }).first();
  await overviewToggle.waitFor({ state: "visible", timeout: 15_000 });
  if (!(await page.locator('[data-slot="overview-branch-header"]').isVisible())) {
    await overviewToggle.click();
  }
  await page
    .locator('[data-slot="overview-branch-header"]')
    .waitFor({ state: "visible", timeout: 15_000 });

  driver.setPhase("discovery");
  const gitActions = page.getByRole("group", { name: "Git actions" }).first();
  const pushButton = gitActions.getByRole("button", { name: "Push", exact: true }).first();
  await pushButton.waitFor({ state: "visible", timeout: 20_000 });
  await pushButton.click();
  const confirmPush = page.getByRole("button", { name: /^Push to main$/u }).first();
  if (await confirmPush.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await confirmPush.click();
  }
  await waitForSourceControlCount({
    driver,
    phase: "discovery",
    kind: "workflow",
    minimum: 2,
    timeoutMs: scenario.sourceControlDiscoveryTimeoutMs,
    page,
  });
  const discoveryTimes = driver.times("discovery", "workflow");
  const discoveryCadenceMs =
    discoveryTimes[0] === undefined || discoveryTimes[1] === undefined
      ? null
      : discoveryTimes[1] - discoveryTimes[0];

  driver.setPhase("setup");
  const openProjectOverview = page
    .getByRole("button", { name: `Open project overview for ${fixture.projectTitle}` })
    .first();
  await openProjectOverview.waitFor({ state: "attached", timeout: 15_000 });
  await openProjectOverview.click({ force: true });
  const pullRequestsTab = page.getByRole("tab", { name: "Pull requests", exact: true }).first();
  await pullRequestsTab.waitFor({ state: "visible", timeout: 15_000 });
  await pullRequestsTab.click();
  // The list may have cached the intentionally empty pre-discovery response.
  // Exercise the product's explicit refresh path before selecting the fixture PR.
  const refreshPullRequests = page.getByRole("button", { name: "Refresh", exact: true }).first();
  await refreshPullRequests.waitFor({ state: "visible", timeout: 15_000 });
  await refreshPullRequests.click();
  const pullRequest = page.getByRole("option", { name: /External performance active PR/u }).first();
  await pullRequest.waitFor({ state: "visible", timeout: 15_000 });

  const setupDeadline = performance.now() + 15_000;
  while (
    !driver.observations.some((observation) => observation.kind === "detail") ||
    !driver.observations.some(
      (observation) => observation.kind === "workflow" && observation.phase === "setup",
    )
  ) {
    if (performance.now() >= setupDeadline) {
      throw new Error("Overview did not establish the canonical PR detail and workflow queries.");
    }
    await page.waitForTimeout(100);
  }

  driver.setPhase("observer-mount");
  await pullRequest.click();
  const checksTab = page.getByRole("tab", { name: "Checks", exact: true }).first();
  await checksTab.waitFor({ state: "visible", timeout: 15_000 });
  await checksTab.click();
  await page.waitForTimeout(750);
  const duplicateObserverRequests =
    driver.count("observer-mount", "detail") + driver.count("observer-mount", "workflow");

  const statusMotionRows = await startStatusMotionFrameSampler(
    page,
    scenario.sourceControlStatusRows,
  );
  driver.setPhase("active");
  await page.waitForTimeout(scenario.sourceControlActiveMs);
  const statusMotionFrames = await stopStatusMotionFrameSampler(page);

  driver.setPhase("hidden");
  input.setNetworkPhase("hiddenIdle");
  const beforeHidden = await readCdpRuntimeMetrics(session);
  await forceDocumentVisibility(page, "hidden");
  await page.waitForTimeout(scenario.sourceControlHiddenMs);
  const afterHidden = await readCdpRuntimeMetrics(session);

  driver.setPhase("settle-transition");
  input.setNetworkPhase("foregroundIdle");
  driver.settle();
  await forceDocumentVisibility(page, "visible");
  const refreshChecks = page.getByRole("button", { name: "Refresh", exact: true }).first();
  await refreshChecks.click();
  await waitForSourceControlCount({
    driver,
    phase: "settle-transition",
    minimum: 2,
    timeoutMs: 10_000,
    page,
  });
  await waitForSourceControlQuiescence({
    driver,
    phase: "settle-transition",
    quietMs: 750,
    timeoutMs: 10_000,
    page,
  });

  driver.setPhase("settled");
  await page.waitForTimeout(scenario.sourceControlSettledMs);
  const afterScenario = await readCdpRuntimeMetrics(session);

  const droppedFrames = statusMotionFrames.filter((duration) => duration > 50).length;
  return {
    foregroundTaskMs: durationDelta(afterScenario.taskMs, beforeScenario.taskMs),
    heapAfterIdleBytes: afterScenario.heapBytes,
    heapBeforeIdleBytes: beforeScenario.heapBytes,
    hiddenTaskMs: durationDelta(afterHidden.taskMs, beforeHidden.taskMs),
    metrics: {
      supported: true,
      discoveryRequests: driver.count("discovery", "workflow"),
      discoveryCadenceMs,
      duplicateObserverRequests,
      activeRequests: sourceControlPrimaryCount(driver, "active"),
      activeCadenceMs: activeCadenceMs(driver),
      hiddenRequests: sourceControlPrimaryCount(driver, "hidden"),
      settledRequests: sourceControlPrimaryCount(driver, "settled"),
      statusMotionRows,
      statusMotionFrames: statusMotionFrames.length,
      statusMotionP95FrameMs: nearestRankP95(statusMotionFrames),
      statusMotionDroppedFrames: droppedFrames,
      unavailableReason: null,
    },
  };
}

async function installPerfObservers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface BrowserPerformanceEntry {
      readonly name: string;
      readonly startTime: number;
      readonly duration: number;
      readonly hadRecentInput?: boolean;
      readonly value?: number;
    }
    const browserGlobal = globalThis as unknown as {
      readonly PerformanceObserver: new (
        callback: (list: { getEntries: () => BrowserPerformanceEntry[] }) => void,
      ) => { observe: (options: { type: string; buffered: boolean }) => void };
      readonly Event: new (type: string) => unknown;
      readonly document: {
        readonly hidden: boolean;
        readonly visibilityState: string;
        dispatchEvent: (event: unknown) => void;
      };
    };
    const state: BrowserPerfState = {
      fcpMs: null,
      lcpMs: null,
      cls: 0,
      longTasks: 0,
      maxLongTaskMs: 0,
      longTaskTotalMs: 0,
    };
    Object.defineProperty(globalThis, "__rycoExternalPerf", {
      value: state,
      configurable: false,
      enumerable: false,
      writable: false,
    });
    let forcedVisibility: "hidden" | "visible" = "visible";
    Object.defineProperty(browserGlobal.document, "hidden", {
      configurable: true,
      get: () => forcedVisibility === "hidden",
    });
    Object.defineProperty(browserGlobal.document, "visibilityState", {
      configurable: true,
      get: () => forcedVisibility,
    });
    Object.defineProperty(globalThis, "__rycoSetExternalVisibility", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: (value: "hidden" | "visible") => {
        forcedVisibility = value;
        browserGlobal.document.dispatchEvent(new browserGlobal.Event("visibilitychange"));
      },
    });
    const observe = (type: string, callback: (entries: BrowserPerformanceEntry[]) => void) => {
      try {
        const observer = new browserGlobal.PerformanceObserver((list) =>
          callback(list.getEntries()),
        );
        observer.observe({ type, buffered: true });
      } catch {
        // Unsupported entry types remain null/zero and are reported as unavailable.
      }
    };
    observe("paint", (entries) => {
      const fcp = entries.find((entry) => entry.name === "first-contentful-paint");
      if (fcp) state.fcpMs = fcp.startTime;
    });
    observe("largest-contentful-paint", (entries) => {
      const latest = entries.at(-1);
      if (latest) state.lcpMs = latest.startTime;
    });
    observe("layout-shift", (entries) => {
      for (const entry of entries) {
        if (!entry.hadRecentInput && typeof entry.value === "number") state.cls += entry.value;
      }
    });
    observe("longtask", (entries) => {
      state.longTasks += entries.length;
      for (const entry of entries) {
        state.maxLongTaskMs = Math.max(state.maxLongTaskMs, entry.duration);
        state.longTaskTotalMs += entry.duration;
      }
    });
  });
}

async function readBrowserVitals(page: Page, usableMs: number): Promise<BrowserVitals> {
  const observed = await page.evaluate(() => {
    interface BrowserNavigationTiming {
      readonly responseStart: number;
      readonly domContentLoadedEventEnd: number;
    }
    interface BrowserMeasure {
      readonly name: string;
      readonly duration: number;
    }
    const browserGlobal = globalThis as unknown as {
      readonly __rycoExternalPerf?: BrowserPerfState;
      readonly performance: {
        getEntriesByType: ((type: "navigation") => BrowserNavigationTiming[]) &
          ((type: "measure") => BrowserMeasure[]);
      };
    };
    const state = browserGlobal.__rycoExternalPerf;
    const navigation = browserGlobal.performance.getEntriesByType("navigation")[0];
    return {
      state: state ?? null,
      measures: browserGlobal.performance
        .getEntriesByType("measure")
        .map((entry) => ({ name: entry.name, duration: entry.duration })),
      navigation: navigation
        ? {
            ttfbMs: navigation.responseStart,
            domContentLoadedMs: navigation.domContentLoadedEventEnd,
          }
        : null,
    };
  });
  const navigation: NavigationTimingSnapshot = observed.navigation ?? {
    ttfbMs: null,
    domContentLoadedMs: null,
  };
  const startupMeasures = collectStartupMeasures(observed.measures);
  return {
    ttfbMs: navigation.ttfbMs,
    domContentLoadedMs: navigation.domContentLoadedMs,
    fcpMs: observed.state?.fcpMs ?? null,
    lcpMs: observed.state?.lcpMs ?? null,
    cls: observed.state?.cls ?? null,
    usableMs,
    longTasks: observed.state?.longTasks ?? 0,
    maxLongTaskMs: observed.state?.maxLongTaskMs ?? 0,
    longTaskTotalMs: observed.state?.longTaskTotalMs ?? 0,
    shellPaintedMs: startupMeasures[SHELL_PAINTED_MEASURE] ?? null,
    startupMeasures,
  };
}

/**
 * Waits (bounded) for the app's painted-shell measure. Paths that never paint
 * a primary shell (pairing, hosted, an error) report no value instead of
 * failing the sample.
 */
async function waitForShellPainted(page: Page): Promise<void> {
  await page
    .waitForFunction(
      (name) =>
        (
          globalThis as unknown as {
            readonly performance: { getEntriesByName: (name: string) => unknown[] };
          }
        ).performance.getEntriesByName(name).length > 0,
      `${STARTUP_MEASURE_PREFIX}${SHELL_PAINTED_MEASURE}`,
      { timeout: SHELL_PAINTED_WAIT_MS },
    )
    .catch(() => undefined);
}

export async function runBrowserProbe(input: {
  readonly browser: Browser;
  readonly entryUrl: string;
  readonly scenario: PerfScenarioConfig;
  readonly sourceControlFixture: ActiveSourceControlFixture | null;
  readonly cpuProfile?: BootCpuProfileTarget | null;
}): Promise<BrowserProbeResult> {
  const context = await input.browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  const errors: string[] = [];
  const phases: Record<NetworkPhase, MutableNetworkMetrics> = {
    bootstrap: mutableNetworkMetrics(),
    foregroundIdle: mutableNetworkMetrics(),
    hiddenIdle: mutableNetworkMetrics(),
    reconnect: mutableNetworkMetrics(),
  };
  const requestPhases = new Map<string, NetworkPhase>();
  let phase: NetworkPhase = "bootstrap";
  let reconnectResolver: (() => void) | null = null;
  const activeWebSocketRef: { current: WebSocketRoute | null } = { current: null };
  const sourceControlDriver = input.sourceControlFixture
    ? new DeterministicSourceControlDriver()
    : null;

  await page.routeWebSocket("**", (webSocket) => {
    activeWebSocketRef.current = webSocket;
    const serverWebSocket = webSocket.connectToServer();
    if (sourceControlDriver) {
      webSocket.onMessage((message) => {
        const response = sourceControlDriver.handle(message);
        if (response === null) serverWebSocket.send(message);
        else webSocket.send(response);
      });
    }
    reconnectResolver?.();
  });

  page.on("pageerror", (error) => errors.push(`page: ${sanitizeDiagnostic(error.message)}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (phase === "reconnect" && text.includes("ERR_INTERNET_DISCONNECTED")) return;
    errors.push(`console: ${sanitizeDiagnostic(text)}`);
  });

  session.on("Network.requestWillBeSent", (event) => {
    requestPhases.set(event.requestId, phase);
    const metrics = phases[phase];
    metrics.requests += 1;
    if (event.type === "Fetch" || event.type === "XHR") metrics.fetchXhrRequests += 1;
  });
  session.on("Network.loadingFinished", (event) => {
    const requestPhase = requestPhases.get(event.requestId) ?? phase;
    phases[requestPhase].encodedBytes += Math.max(0, event.encodedDataLength);
    requestPhases.delete(event.requestId);
  });
  session.on("Network.loadingFailed", (event) => {
    const requestPhase = requestPhases.get(event.requestId) ?? phase;
    phases[requestPhase].failedRequests += event.canceled ? 0 : 1;
    requestPhases.delete(event.requestId);
  });
  session.on("Network.webSocketFrameReceived", (event) => {
    const metrics = phases[phase];
    metrics.webSocketFrames += 1;
    metrics.webSocketBytes += payloadBytes(event.response.payloadData, event.response.opcode);
  });

  await Promise.all([
    session.send("Network.enable"),
    session.send("Network.setCacheDisabled", { cacheDisabled: true }),
    session.send("Performance.enable"),
    installPerfObservers(page),
  ]);

  let reconnectMs: number | null = null;
  let foregroundTaskMs: number | null = null;
  let hiddenTaskMs: number | null = null;
  let heapBeforeIdleBytes: number | null = null;
  let heapAfterIdleBytes: number | null = null;
  let sourceControl = UNSUPPORTED_SOURCE_CONTROL_METRICS;
  let vitals: BrowserVitals = {
    ttfbMs: null,
    domContentLoadedMs: null,
    fcpMs: null,
    lcpMs: null,
    cls: null,
    usableMs: null,
    longTasks: 0,
    maxLongTaskMs: 0,
    longTaskTotalMs: 0,
    shellPaintedMs: null,
    startupMeasures: {},
  };
  let cpuProfile: CpuProfileSummary | null = null;
  let themeRecalcMs: number | null = null;

  try {
    if (input.cpuProfile) {
      await session.send("Profiler.enable");
      await session.send("Profiler.setSamplingInterval", {
        interval: CPU_PROFILE_SAMPLING_INTERVAL_US,
      });
      await session.send("Profiler.start");
    }
    const navigationStartedAt = performance.now();
    await page.goto(input.entryUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const entryPath = new URL(input.entryUrl).pathname;
    if (entryPath === "/pair") {
      await page.waitForURL((url) => url.pathname !== "/pair", { timeout: 30_000 });
    }
    if (input.scenario.targetPath) {
      const targetUrl = new URL(input.scenario.targetPath, page.url()).toString();
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    await page.locator(input.scenario.readySelector).waitFor({ state: "visible", timeout: 30_000 });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          (
            globalThis as unknown as {
              requestAnimationFrame: (callback: () => void) => number;
            }
          ).requestAnimationFrame(() => resolve()),
        ),
    );
    const usableMs = performance.now() - navigationStartedAt;
    await page.waitForTimeout(750);
    await waitForShellPainted(page);
    vitals = await readBrowserVitals(page, usableMs);
    if (input.cpuProfile) {
      await page.waitForTimeout(CPU_PROFILE_TAIL_MS);
      const { profile } = (await session.send("Profiler.stop")) as { profile: CdpCpuProfile };
      mkdirSync(path.dirname(input.cpuProfile.file), { recursive: true });
      writeFileSync(input.cpuProfile.file, JSON.stringify(profile));
      cpuProfile = summarizeCpuProfile(
        profile,
        input.cpuProfile.assetsDir
          ? { resolveSource: createDistSourceResolver(input.cpuProfile.assetsDir) }
          : {},
      );
    }

    if (input.scenario.profile === "active-source-control") {
      if (!sourceControlDriver || !input.sourceControlFixture) {
        throw new Error(
          "The active source-control profile requires a harness-owned local fixture.",
        );
      }
      phase = "foregroundIdle";
      const scenarioResult = await runActiveSourceControlScenario({
        driver: sourceControlDriver,
        fixture: input.sourceControlFixture,
        page,
        scenario: input.scenario,
        session,
        setNetworkPhase: (nextPhase) => {
          phase = nextPhase;
        },
      });
      foregroundTaskMs = scenarioResult.foregroundTaskMs;
      hiddenTaskMs = scenarioResult.hiddenTaskMs;
      heapBeforeIdleBytes = scenarioResult.heapBeforeIdleBytes;
      heapAfterIdleBytes = scenarioResult.heapAfterIdleBytes;
      sourceControl = scenarioResult.metrics;
      if (sourceControl.discoveryRequests !== 2) {
        errors.push(
          `source-control: expected two discovery requests, observed ${sourceControl.discoveryRequests}.`,
        );
      }
      if (
        sourceControl.discoveryCadenceMs === null ||
        sourceControl.discoveryCadenceMs < 8_000 ||
        sourceControl.discoveryCadenceMs > 14_000
      ) {
        errors.push(
          `source-control: expected a 10s discovery cadence, observed ${sourceControl.discoveryCadenceMs ?? "unavailable"}ms.`,
        );
      }
      if (sourceControl.duplicateObserverRequests !== 0) {
        errors.push(
          `source-control: duplicate observers issued ${sourceControl.duplicateObserverRequests} extra request(s).`,
        );
      }
      if (sourceControl.activeRequests === 0) {
        errors.push("source-control: active checks did not issue a scheduled refresh.");
      }
      if (
        sourceControl.activeCadenceMs === null ||
        sourceControl.activeCadenceMs < 26_000 ||
        sourceControl.activeCadenceMs > 36_000
      ) {
        errors.push(
          `source-control: expected a 30s active cadence, observed ${sourceControl.activeCadenceMs ?? "unavailable"}ms.`,
        );
      }
      if (sourceControl.hiddenRequests !== 0) {
        errors.push(
          `source-control: hidden document issued ${sourceControl.hiddenRequests} timer request(s).`,
        );
      }
      if (sourceControl.settledRequests !== 0) {
        errors.push(
          `source-control: settled queries issued ${sourceControl.settledRequests} timer request(s).`,
        );
      }
      if (sourceControl.statusMotionRows !== input.scenario.sourceControlStatusRows) {
        errors.push(
          `source-control: expected ${input.scenario.sourceControlStatusRows} status rows, rendered ${sourceControl.statusMotionRows}.`,
        );
      }
      if (sourceControl.statusMotionFrames === 0) {
        errors.push("source-control: active status motion produced no animation frames.");
      }
    } else {
      const beforeForeground = await readCdpRuntimeMetrics(session);
      heapBeforeIdleBytes = beforeForeground.heapBytes;
      phase = "foregroundIdle";
      await page.waitForTimeout(input.scenario.idleMs);
      const afterForeground = await readCdpRuntimeMetrics(session);
      foregroundTaskMs = durationDelta(afterForeground.taskMs, beforeForeground.taskMs);

      await forceDocumentVisibility(page, "hidden");
      const beforeHidden = await readCdpRuntimeMetrics(session);
      phase = "hiddenIdle";
      await page.waitForTimeout(input.scenario.hiddenIdleMs);
      const afterHidden = await readCdpRuntimeMetrics(session);
      hiddenTaskMs = durationDelta(afterHidden.taskMs, beforeHidden.taskMs);
      await forceDocumentVisibility(page, "visible");
    }

    phase = "reconnect";
    sourceControlDriver?.setPhase("reconnect");
    await context.setOffline(true);
    if (activeWebSocketRef.current) {
      await activeWebSocketRef.current.close({
        code: 1012,
        reason: "external performance recovery probe",
      });
      activeWebSocketRef.current = null;
    } else {
      errors.push("browser: no active WebSocket was available for the recovery probe.");
    }
    await page.waitForTimeout(input.scenario.offlineMs);
    const onlineAt = performance.now();
    const reconnectPromise = new Promise<void>((resolve) => {
      reconnectResolver = resolve;
    });
    await context.setOffline(false);
    const reconnected = await Promise.race([
      reconnectPromise.then(() => true),
      page.waitForTimeout(input.scenario.reconnectTimeoutMs).then(() => false),
    ]);
    reconnectResolver = null;
    if (reconnected) reconnectMs = performance.now() - onlineAt;
    else errors.push("browser: no WebSocket reconnect handshake before the recovery deadline.");
    heapAfterIdleBytes ??= (await readCdpRuntimeMetrics(session)).heapBytes;
    // Last, so its synthetic DOM never touches the idle and network phases.
    themeRecalcMs = await measureThemeRecalc(page);
  } catch (error) {
    errors.push(
      `browser: ${sanitizeDiagnostic(error instanceof Error ? error.message : String(error))}`,
    );
    if (sourceControlDriver) {
      errors.push(`source-control trace: ${sourceControlDriver.traceSummary() || "no requests"}.`);
      const emptyPullRequestsVisible = await page
        .getByText("No pull requests to show.", { exact: true })
        .isVisible()
        .catch(() => false);
      const pullRequestErrorVisible = await page
        .getByText(/Failed to load pull requests\./u)
        .isVisible()
        .catch(() => false);
      errors.push(
        `source-control UI: empty=${emptyPullRequestsVisible}, error=${pullRequestErrorVisible}.`,
      );
    }
  } finally {
    await context.close();
  }

  return {
    reconnectMs,
    foregroundTaskMs,
    hiddenTaskMs,
    heapBeforeIdleBytes,
    heapAfterIdleBytes,
    vitals,
    bootstrapNetwork: snapshotNetworkMetrics(phases.bootstrap),
    foregroundIdleNetwork: snapshotNetworkMetrics(phases.foregroundIdle),
    hiddenIdleNetwork: snapshotNetworkMetrics(phases.hiddenIdle),
    reconnectNetwork: snapshotNetworkMetrics(phases.reconnect),
    sourceControl,
    cpuProfile,
    themeRecalcMs,
    errors,
  };
}
