import "../../index.css";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type DiagnosticsSnapshot,
  type EnvironmentApi,
  type ResourceTelemetryHistory,
  type ServerConfig,
} from "@ryco/contracts";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import {
  resetSavedEnvironmentRuntimeStoreForTests,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { AppAtomRegistryProvider, resetAppAtomRegistryForTests } from "../../rpc/atomRegistry";
import { SettingsTargetProvider } from "../../settingsTarget";
import { DiagnosticsSettings } from "./DiagnosticsSettings";

const environmentId = EnvironmentId.make("diagnostics-primary");
const now = "2026-09-07T12:00:00.000Z";
const observability = {
  logsDirectoryPath: "/tmp/logs",
  serverLogPath: "/tmp/logs/server.log",
  serverTracePath: "/tmp/logs/trace.jsonl",
  providerEventLogPath: "/tmp/logs/providers.jsonl",
  localTracingEnabled: true,
  otlpTracesEnabled: false,
  otlpMetricsEnabled: false,
};
const healthSource = { status: "healthy" as const, lastSampleAt: now, lastError: null };
const aggregate = {
  processCount: 2,
  currentCpuPercent: 37.5,
  cpuTimeMs: 42_000,
  currentRssBytes: 16_777_216,
  peakRssBytes: 20_971_520,
  ioReadBytes: 1024,
  ioWriteBytes: 2048,
  ioReadBytesPerSecond: 128,
  ioWriteBytesPerSecond: 256,
  processStarts: 2,
  processExits: 0,
};
const health = {
  native: healthSource,
  desktop: { ...healthSource, status: "unavailable" as const },
  sidecarVersion: "test",
  sidecarPid: 100,
  restartCount: 0,
  collectionDurationMicros: 100,
  scannedProcessCount: 10,
  retainedProcessCount: 2,
  inaccessibleProcessCount: 0,
};
const resourceSample = {
  sampledAt: now,
  uptimeMs: 1000,
  memory: {
    rssBytes: 16_777_216,
    heapUsedBytes: 1024,
    heapTotalBytes: 2048,
    externalBytes: 0,
    arrayBuffersBytes: 0,
  },
  cpu: { userMicros: 1000, systemMicros: 1000, utilizationPercent: 37.5 },
};
const snapshot = {
  generatedAt: now,
  serverStartedAt: now,
  uptimeMs: 1000,
  limits: { traceRecordLimit: 100, resourceSampleLimit: 100, fileTailBytes: 1024 },
  observability,
  resources: { current: resourceSample, history: [resourceSample] },
  liveProcesses: {
    server: { pid: 10, platform: "darwin", runtime: "bun", version: "1.4.0", cwd: "/repo" },
    terminals: [],
    providers: [],
  },
  processTree: {
    readAt: now,
    serverPid: 10,
    processes: [
      {
        pid: 20,
        ppid: 10,
        startTimeMs: 123,
        command: "diagnostics-agent",
        status: "running",
        cpuPercent: 37.5,
        rssBytes: 1024,
        elapsed: "00:10",
        depth: 0,
        childPids: [],
      },
    ],
    totalCpuPercent: 37.5,
    totalRssBytes: 1024,
  },
  telemetry: {
    readAt: now,
    sampleIntervalMs: 1000,
    processes: [],
    groups: {
      backend: aggregate,
      electron: { ...aggregate, processCount: 0 },
      monitor: { ...aggregate, processCount: 1 },
      allRyco: aggregate,
    },
    power: null,
    speedLimitPercent: null,
    attribution: { readAt: now, entries: [] },
    health,
  },
  tracing: {
    retainedSpanCount: 0,
    recentSpans: [],
    slowestSpans: [],
    topSpanNames: [],
    durationBuckets: [],
    recentEvents: [],
  },
  failures: { latest: [], common: [] },
  client: { slowRpcAcks: [] },
  warnings: [],
} satisfies DiagnosticsSnapshot;
const history = {
  readAt: now,
  windowMs: 300_000,
  bucketMs: 15_000,
  sampleIntervalMs: 1000,
  retainedSampleCount: 12,
  totalCpuTimeMs: 42000,
  buckets: [],
  topProcesses: [],
  health,
} satisfies ResourceTelemetryHistory;
const serverConfig = {
  environment: {
    environmentId,
    label: "Local",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "test",
    capabilities: {
      repositoryIdentity: true,
      threadSettlement: false,
      threadPriorityRanking: false,
    },
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie"],
    sessionCookieName: "ryco_session",
  },
  cwd: "/repo",
  keybindingsConfigPath: "/tmp/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  observability,
  settings: DEFAULT_SERVER_SETTINGS,
} satisfies ServerConfig;
const getSnapshot = vi.fn(async (): Promise<DiagnosticsSnapshot> => snapshot);
const getHistory = vi.fn(async () => history);
function mount(connected = true) {
  return render(
    <AppAtomRegistryProvider>
      <SettingsTargetProvider
        value={{ environmentId, nodeLabel: "Local", serverConfig, primary: true, connected }}
      >
        <DiagnosticsSettings />
      </SettingsTargetProvider>
    </AppAtomRegistryProvider>,
  );
}
beforeEach(() => {
  resetAppAtomRegistryForTests();
  resetSavedEnvironmentRuntimeStoreForTests();
  getSnapshot.mockClear();
  getHistory.mockClear();
  __setEnvironmentApiOverrideForTests(environmentId, {
    server: { getDiagnosticsSnapshot: getSnapshot, getResourceTelemetryHistory: getHistory },
  } as unknown as EnvironmentApi);
});
afterEach(() => {
  __resetEnvironmentApiOverridesForTests();
  resetSavedEnvironmentRuntimeStoreForTests();
});

describe("Diagnostics settings with actual connection capability", () => {
  it("fetches a connected primary node without requiring a saved-environment owner row", async () => {
    expect(useSavedEnvironmentRuntimeStore.getState().byId[environmentId]).toBeUndefined();
    await mount();
    await expect.poll(() => getSnapshot.mock.calls.length).toBeGreaterThan(0);
    await expect.poll(() => getHistory.mock.calls.length).toBeGreaterThan(0);
    await expect.element(page.getByText("Resource monitor", { exact: true })).toBeVisible();
    await expect.element(page.getByText("37.5%", { exact: true }).first()).toBeVisible();
    expect(document.querySelector("details.group\\/diagnostics")).toBeNull();
    await expect.element(page.getByText(/12 retained samples/)).toBeVisible();
    await expect
      .element(page.getByText("diagnostics-agent", { exact: true }).first())
      .toBeVisible();
  });

  it("lists the server's event-loop stalls", async () => {
    getSnapshot.mockImplementation(async () => ({
      ...snapshot,
      eventLoop: {
        thresholdMs: 2_000,
        windowMs: 30_000,
        historyFilePaths: ["/tmp/logs/event-loop-stalls.ndjson"],
        recent: [
          {
            time: now,
            kind: "event-loop",
            durationMs: 6_200,
            count: 3,
            totalMs: 11_000,
            cpuUserMs: 6_000,
            uptimeMs: 20_000,
            phases: ["persistence.migrations (6100 ms)"],
          },
        ],
        last24h: { records: 1, stalls: 3, longestMs: 6_200, threadpoolStalls: 0 },
      },
    }));
    try {
      await mount();
      await expect
        .element(page.getByText("3 stalls in the last 24 h, longest 6.2 s", { exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByText("3 stalls, 11 s in total", { exact: true }))
        .toBeVisible();
      await expect.element(page.getByText("during startup", { exact: true })).toBeVisible();
      await expect
        .element(page.getByText("CPU-bound (JavaScript or garbage collection)", { exact: true }))
        .toBeVisible();
    } finally {
      getSnapshot.mockImplementation(async () => snapshot);
    }
  });

  it("says when the node's server does not record stalls", async () => {
    await mount();
    await expect
      .element(
        page.getByText("This node's server does not record stalls. Update it to see them here.", {
          exact: true,
        }),
      )
      .toBeVisible();
  });

  it("does not request diagnostics while the selected primary node is disconnected", async () => {
    await mount(false);
    await expect
      .element(page.getByText(/connected owner session|disconnected|unavailable/i).first())
      .toBeVisible();
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(getHistory).not.toHaveBeenCalled();
  });
});
