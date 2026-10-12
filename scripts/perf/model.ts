export const EXTERNAL_PERF_SCHEMA_VERSION = 2 as const;

export type PerfScenarioProfile = "shell" | "active-source-control";

export interface PerfScenarioConfig {
  readonly profile: PerfScenarioProfile;
  readonly iterations: number;
  readonly idleMs: number;
  readonly hiddenIdleMs: number;
  readonly offlineMs: number;
  readonly reconnectTimeoutMs: number;
  readonly readySelector: string;
  readonly targetPath: string | null;
  readonly fixtureHome: string | null;
  readonly sourceControlDiscoveryTimeoutMs: number;
  readonly sourceControlActiveMs: number;
  readonly sourceControlHiddenMs: number;
  readonly sourceControlSettledMs: number;
  readonly sourceControlStatusRows: number;
  /** Directory for one boot `.cpuprofile` per iteration, or null to skip profiling. */
  readonly cpuProfileDir: string | null;
}

export interface PhaseNetworkMetrics {
  readonly requests: number;
  readonly fetchXhrRequests: number;
  readonly failedRequests: number;
  readonly encodedBytes: number;
  readonly webSocketFrames: number;
  readonly webSocketBytes: number;
}

export interface ProcessTreeSummary {
  readonly supported: boolean;
  readonly samples: number;
  readonly peakRssBytes: number | null;
  readonly medianCpuPercent: number | null;
  readonly peakCpuPercent: number | null;
  readonly peakProcessCount: number | null;
  readonly unavailableReason: string | null;
}

export interface BrowserVitals {
  readonly ttfbMs: number | null;
  readonly domContentLoadedMs: number | null;
  readonly fcpMs: number | null;
  readonly lcpMs: number | null;
  readonly cls: number | null;
  readonly usableMs: number | null;
  readonly longTasks: number;
  readonly maxLongTaskMs: number;
  /** Total long-task time from navigation until the vitals are read. */
  readonly longTaskTotalMs: number;
  /** Navigation start to the app's `primary-shell-painted` mark (sidebar on screen). */
  readonly shellPaintedMs: number | null;
  /** Every `ryco:startup:*` measure the app recorded, by name without the prefix. */
  readonly startupMeasures: Readonly<Record<string, number>>;
}

export interface SourceControlScenarioMetrics {
  readonly supported: boolean;
  readonly discoveryRequests: number;
  readonly discoveryCadenceMs: number | null;
  readonly duplicateObserverRequests: number;
  readonly activeRequests: number;
  readonly activeCadenceMs: number | null;
  readonly hiddenRequests: number;
  readonly settledRequests: number;
  readonly statusMotionRows: number;
  readonly statusMotionFrames: number;
  readonly statusMotionP95FrameMs: number | null;
  readonly statusMotionDroppedFrames: number;
  readonly unavailableReason: string | null;
}

/** Main-thread self time of one boot CPU profile (`scripts/perf/cpuProfile.ts`). */
export interface CpuProfileSummary {
  /** Profiled window: navigation start to shortly after `primary-shell-painted`. */
  readonly durationMs: number;
  readonly busyMs: number;
  readonly idleMs: number;
  /** Source files (or chunks without a source map) by self time, largest first. */
  readonly topSelfTime: ReadonlyArray<{ readonly source: string; readonly selfMs: number }>;
}

export interface PerfSample {
  readonly iteration: number;
  readonly serverReadyMs: number | null;
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
  readonly processTree: ProcessTreeSummary;
  readonly sourceControl: SourceControlScenarioMetrics;
  readonly cpuProfile: CpuProfileSummary | null;
  /**
   * One full-document style recalc and layout on the app's stylesheet: the
   * `dark` root class toggled over ~4,400 elements cloned from the shell's own
   * class lists. Tracks how stylesheet growth prices root-level changes (theme
   * and appearance switches). Absent from results recorded before it existed.
   */
  readonly themeRecalcMs?: number | null;
  readonly errors: readonly string[];
}

export interface MetricAggregate {
  readonly count: number;
  readonly median: number;
  readonly p95: number;
  readonly maximum: number;
  readonly minimum: number;
}

export type PerfMetricKey =
  | "serverReadyMs"
  | "ttfbMs"
  | "domContentLoadedMs"
  | "fcpMs"
  | "lcpMs"
  | "cls"
  | "usableMs"
  | "longTasks"
  | "maxLongTaskMs"
  | "longTaskTotalMs"
  | "shellPaintedMs"
  | "bootstrapRequests"
  | "bootstrapEncodedBytes"
  | "bootstrapWebSocketBytes"
  | "foregroundIdleRequests"
  | "hiddenIdleRequests"
  | "reconnectMs"
  | "foregroundTaskMs"
  | "hiddenTaskMs"
  | "heapAfterIdleBytes"
  | "peakTreeRssBytes"
  | "medianTreeCpuPercent"
  | "peakTreeCpuPercent"
  | "sourceControlDiscoveryRequests"
  | "sourceControlDiscoveryCadenceMs"
  | "sourceControlDuplicateObserverRequests"
  | "sourceControlActiveRequests"
  | "sourceControlActiveCadenceMs"
  | "sourceControlHiddenRequests"
  | "sourceControlSettledRequests"
  | "statusMotionP95FrameMs"
  | "statusMotionDroppedFrames"
  | "themeRecalcMs";

export type ComparisonMetricKey =
  | PerfMetricKey
  | "buildDurationMs"
  | "buildPeakRssBytes"
  | "bundleRawBytes"
  | "bundleGzipBytes"
  | "bundleBrotliBytes";

export interface BuildMeasurement {
  readonly durationMs: number;
  readonly peakRssBytes: number | null;
  readonly exitCode: number;
}

export interface BundleMeasurement {
  readonly files: number;
  readonly rawBytes: number;
  readonly gzipBytes: number;
  readonly brotliBytes: number;
}

/**
 * A module that must not be statically reachable from a closure, matched
 * against repository-relative sourcemap sources (`apps/web/src/…`,
 * `packages/…`, and `node_modules/<package>/…` for installed packages).
 */
export interface ForbiddenBundleSource {
  readonly pattern: RegExp;
  readonly reason: string;
}

/**
 * One static-import closure of the standard web build and what it may carry.
 * `chunk` is the hashed chunk's name prefix (`RootAppShell` for
 * `RootAppShell-<hash>.js`); `main` is the boot entry. `beyondBoot` measures
 * only the files the boot closure does not already load, which is what opening
 * that surface costs once the app is running.
 */
export interface BundleClosureBudget {
  readonly name: string;
  readonly chunk: string;
  readonly beyondBoot: boolean;
  readonly maxGzipBytes: number | null;
  readonly forbiddenSources: readonly ForbiddenBundleSource[];
}

export interface BundleBudgetPolicy {
  readonly bootChunk: string;
  readonly closures: readonly BundleClosureBudget[];
}

const KIB = 1024;

/**
 * The hosted-hub runtime, its Hub API client, and the relay E2EE stack. The
 * standard build resolves every hosted seam to an inert sibling
 * (`apps/web/src/clientModeSeams.ts`); a hit here means a new static edge
 * bypassed a seam.
 */
const HOSTED_RUNTIME_SOURCES: readonly ForbiddenBundleSource[] = [
  { pattern: /^node_modules\/@noble\//u, reason: "relay E2EE crypto (@noble)" },
  { pattern: /^node_modules\/cborg\//u, reason: "relay CBOR codec (cborg)" },
  { pattern: /^packages\/shared\/src\/relay(?:E2ee|Codec)/u, reason: "relay wire / E2EE protocol" },
  {
    pattern: /^packages\/client-runtime\/src\/relay\/(?!(?:reconnectPolicy|base64url)\.ts$)/u,
    reason: "relay engine (only reconnectPolicy and base64url are light)",
  },
  {
    pattern:
      /^packages\/client-runtime\/src\/authorization\/(?!(?:nodeMutationLease|capabilities|deliveryNotice|hostedStores|types)\.ts$)/u,
    reason: "hosted authorization runtime (import a light subpath instead of the barrel)",
  },
  {
    pattern:
      /^apps\/web\/src\/(?:hostedHub\/(?:state|transport|runtime|readCache|hostedConnectionCoordinator|nodeRouteOrchestrator|relaySocket|hubSession|e2ee\w*)|components\/hostedHub\/HostedConnectionControls|components\/NoActiveThreadHostedStatus|pwa\/lifecycle)\.tsx?$/u,
    reason: "hosted-only module (standard builds use its *.standard sibling)",
  },
];

/** The markdown renderer: comment threads and chat messages load it on demand. */
const MARKDOWN_SOURCES: readonly ForbiddenBundleSource[] = [
  { pattern: /^node_modules\/react-markdown\//u, reason: "markdown renderer" },
  { pattern: /^node_modules\/micromark/u, reason: "markdown parser" },
  { pattern: /^node_modules\/parse5\//u, reason: "HTML parser (rehype-raw)" },
];

/** The diff renderer and its syntax highlighter. */
const DIFF_RENDERER_SOURCES: readonly ForbiddenBundleSource[] = [
  { pattern: /^node_modules\/@pierre\/diffs\//u, reason: "diff renderer" },
  { pattern: /^node_modules\/(?:shiki|@shikijs\/)/u, reason: "syntax highlighter" },
];

/** OTLP export loads when client tracing is configured, never at boot. */
const TRACING_EXPORTER_SOURCES: readonly ForbiddenBundleSource[] = [
  { pattern: /^node_modules\/effect\/dist\/observability\/Otlp/u, reason: "OTLP exporter" },
];

/**
 * Budgets of the standard web build (gzip, summed per file). Measured
 * 2026-10-11 after hosted code left the standard boot graph: boot 472 KiB
 * (644 KiB before), RootAppShell beyond boot 367 KiB (538 KiB before),
 * ChatThreadRouteView beyond boot 974 KiB. The thread route's target is
 * 700 KiB; its budget sits just above today's size so it blocks growth until
 * the thread route is split further.
 */
export const DEFAULT_BUNDLE_BUDGET_POLICY: BundleBudgetPolicy = {
  bootChunk: "main",
  closures: [
    {
      name: "boot",
      chunk: "main",
      beyondBoot: false,
      maxGzipBytes: 520 * KIB,
      forbiddenSources: [
        ...HOSTED_RUNTIME_SOURCES,
        ...MARKDOWN_SOURCES,
        ...DIFF_RENDERER_SOURCES,
        ...TRACING_EXPORTER_SOURCES,
      ],
    },
    {
      name: "RootAppShell",
      chunk: "RootAppShell",
      beyondBoot: true,
      // The boot code-splitting group keeps shell-only @base-ui and lucide
      // modules out of boot, so ~20 KiB gzip sits here instead (405 KiB).
      maxGzipBytes: 420 * KIB,
      forbiddenSources: [...HOSTED_RUNTIME_SOURCES, ...MARKDOWN_SOURCES, ...DIFF_RENDERER_SOURCES],
    },
    {
      // 813 KiB on 2026-10-12, after route-level splitting (974 KiB before).
      name: "ChatThreadRouteView",
      chunk: "ChatThreadRouteView",
      beyondBoot: true,
      maxGzipBytes: 880 * KIB,
      forbiddenSources: HOSTED_RUNTIME_SOURCES,
    },
    {
      // Route-level splitting makes the route view the page's chunk entry.
      name: "PullRequestsRouteView",
      chunk: "PullRequestsRouteView",
      beyondBoot: true,
      maxGzipBytes: null,
      forbiddenSources: [...HOSTED_RUNTIME_SOURCES, ...DIFF_RENDERER_SOURCES],
    },
  ],
};

export interface BenchmarkMetadata {
  readonly generatedAt: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly bunVersion: string;
  readonly nodeVersion: string;
  readonly cpuModel: string;
  readonly cpuCount: number;
  readonly totalMemoryBytes: number;
}

export interface BenchmarkResult {
  readonly schemaVersion: typeof EXTERNAL_PERF_SCHEMA_VERSION;
  readonly label: string;
  readonly revision: string;
  readonly scenario: PerfScenarioConfig;
  readonly metadata: BenchmarkMetadata;
  readonly build: BuildMeasurement | null;
  readonly bundle: BundleMeasurement | null;
  readonly samples: readonly PerfSample[];
  readonly aggregates: Readonly<Partial<Record<PerfMetricKey, MetricAggregate>>>;
  readonly errors: readonly string[];
}

export interface MetricRegressionPolicy {
  readonly relativePercent: number;
  readonly absolute: number;
}

export interface ComparisonPolicy {
  readonly metrics: Readonly<Partial<Record<ComparisonMetricKey, MetricRegressionPolicy>>>;
  readonly idleRequestAllowance: number;
  readonly failOnSampleErrors: boolean;
}

export interface MetricComparison {
  readonly metric: ComparisonMetricKey;
  readonly baseline: number | null;
  readonly candidate: number | null;
  readonly delta: number | null;
  readonly relativePercent: number | null;
  readonly regressed: boolean;
  readonly reason: string | null;
}

export interface BenchmarkComparison {
  readonly schemaVersion: typeof EXTERNAL_PERF_SCHEMA_VERSION;
  readonly baselineLabel: string;
  readonly candidateLabel: string;
  readonly comparisons: readonly MetricComparison[];
  readonly failures: readonly string[];
  readonly passed: boolean;
}

export const EMPTY_NETWORK_METRICS: PhaseNetworkMetrics = {
  requests: 0,
  fetchXhrRequests: 0,
  failedRequests: 0,
  encodedBytes: 0,
  webSocketFrames: 0,
  webSocketBytes: 0,
};

export const UNSUPPORTED_SOURCE_CONTROL_METRICS: SourceControlScenarioMetrics = {
  supported: false,
  discoveryRequests: 0,
  discoveryCadenceMs: null,
  duplicateObserverRequests: 0,
  activeRequests: 0,
  activeCadenceMs: null,
  hiddenRequests: 0,
  settledRequests: 0,
  statusMotionRows: 0,
  statusMotionFrames: 0,
  statusMotionP95FrameMs: null,
  statusMotionDroppedFrames: 0,
  unavailableReason: "The shell profile does not run the active source-control scenario.",
};

export const DEFAULT_COMPARISON_POLICY: ComparisonPolicy = {
  metrics: {
    serverReadyMs: { relativePercent: 15, absolute: 50 },
    ttfbMs: { relativePercent: 15, absolute: 50 },
    domContentLoadedMs: { relativePercent: 15, absolute: 50 },
    fcpMs: { relativePercent: 15, absolute: 50 },
    lcpMs: { relativePercent: 15, absolute: 100 },
    usableMs: { relativePercent: 15, absolute: 100 },
    bootstrapEncodedBytes: { relativePercent: 10, absolute: 10 * 1024 },
    bootstrapWebSocketBytes: { relativePercent: 10, absolute: 10 * 1024 },
    heapAfterIdleBytes: { relativePercent: 10, absolute: 20 * 1024 * 1024 },
    peakTreeRssBytes: { relativePercent: 10, absolute: 20 * 1024 * 1024 },
    reconnectMs: { relativePercent: 20, absolute: 250 },
    maxLongTaskMs: { relativePercent: 20, absolute: 50 },
    longTaskTotalMs: { relativePercent: 20, absolute: 50 },
    shellPaintedMs: { relativePercent: 15, absolute: 100 },
    buildDurationMs: { relativePercent: 15, absolute: 5_000 },
    buildPeakRssBytes: { relativePercent: 10, absolute: 100 * 1024 * 1024 },
    bundleRawBytes: { relativePercent: 5, absolute: 50 * 1024 },
    bundleGzipBytes: { relativePercent: 5, absolute: 20 * 1024 },
    bundleBrotliBytes: { relativePercent: 5, absolute: 20 * 1024 },
    sourceControlDiscoveryCadenceMs: { relativePercent: 20, absolute: 2_000 },
    sourceControlActiveCadenceMs: { relativePercent: 15, absolute: 3_000 },
    statusMotionP95FrameMs: { relativePercent: 20, absolute: 4 },
    statusMotionDroppedFrames: { relativePercent: 50, absolute: 3 },
    themeRecalcMs: { relativePercent: 20, absolute: 10 },
  },
  idleRequestAllowance: 1,
  failOnSampleErrors: true,
};

export const PERF_METRIC_KEYS: readonly PerfMetricKey[] = [
  "serverReadyMs",
  "ttfbMs",
  "domContentLoadedMs",
  "fcpMs",
  "lcpMs",
  "cls",
  "usableMs",
  "longTasks",
  "maxLongTaskMs",
  "longTaskTotalMs",
  "shellPaintedMs",
  "bootstrapRequests",
  "bootstrapEncodedBytes",
  "bootstrapWebSocketBytes",
  "foregroundIdleRequests",
  "hiddenIdleRequests",
  "reconnectMs",
  "foregroundTaskMs",
  "hiddenTaskMs",
  "heapAfterIdleBytes",
  "peakTreeRssBytes",
  "medianTreeCpuPercent",
  "peakTreeCpuPercent",
  "sourceControlDiscoveryRequests",
  "sourceControlDiscoveryCadenceMs",
  "sourceControlDuplicateObserverRequests",
  "sourceControlActiveRequests",
  "sourceControlActiveCadenceMs",
  "sourceControlHiddenRequests",
  "sourceControlSettledRequests",
  "statusMotionP95FrameMs",
  "statusMotionDroppedFrames",
  "themeRecalcMs",
];

export function sampleMetric(sample: PerfSample, metric: PerfMetricKey): number | null {
  switch (metric) {
    case "serverReadyMs":
      return sample.serverReadyMs;
    case "ttfbMs":
    case "domContentLoadedMs":
    case "fcpMs":
    case "lcpMs":
    case "cls":
    case "usableMs":
    case "longTasks":
    case "maxLongTaskMs":
    case "longTaskTotalMs":
    case "shellPaintedMs":
      return sample.vitals[metric];
    case "bootstrapRequests":
      return sample.bootstrapNetwork.requests;
    case "bootstrapEncodedBytes":
      return sample.bootstrapNetwork.encodedBytes;
    case "bootstrapWebSocketBytes":
      return sample.bootstrapNetwork.webSocketBytes;
    case "foregroundIdleRequests":
      return sample.foregroundIdleNetwork.fetchXhrRequests;
    case "hiddenIdleRequests":
      return sample.hiddenIdleNetwork.fetchXhrRequests;
    case "reconnectMs":
      return sample.reconnectMs;
    case "foregroundTaskMs":
      return sample.foregroundTaskMs;
    case "hiddenTaskMs":
      return sample.hiddenTaskMs;
    case "heapAfterIdleBytes":
      return sample.heapAfterIdleBytes;
    case "peakTreeRssBytes":
      return sample.processTree.peakRssBytes;
    case "medianTreeCpuPercent":
      return sample.processTree.medianCpuPercent;
    case "peakTreeCpuPercent":
      return sample.processTree.peakCpuPercent;
    case "sourceControlDiscoveryRequests":
      return sample.sourceControl.supported ? sample.sourceControl.discoveryRequests : null;
    case "sourceControlDiscoveryCadenceMs":
      return sample.sourceControl.discoveryCadenceMs;
    case "sourceControlDuplicateObserverRequests":
      return sample.sourceControl.supported ? sample.sourceControl.duplicateObserverRequests : null;
    case "sourceControlActiveRequests":
      return sample.sourceControl.supported ? sample.sourceControl.activeRequests : null;
    case "sourceControlActiveCadenceMs":
      return sample.sourceControl.activeCadenceMs;
    case "sourceControlHiddenRequests":
      return sample.sourceControl.supported ? sample.sourceControl.hiddenRequests : null;
    case "sourceControlSettledRequests":
      return sample.sourceControl.supported ? sample.sourceControl.settledRequests : null;
    case "statusMotionP95FrameMs":
      return sample.sourceControl.statusMotionP95FrameMs;
    case "statusMotionDroppedFrames":
      return sample.sourceControl.supported ? sample.sourceControl.statusMotionDroppedFrames : null;
    case "themeRecalcMs":
      return sample.themeRecalcMs ?? null;
  }
}
