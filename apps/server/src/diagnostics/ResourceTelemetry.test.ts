import { ResourceTelemetrySnapshot, ResourceTelemetryHistory } from "@ryco/contracts";
import { Schema } from "effect";
import { parseDesktopResourceTelemetry } from "@ryco/shared/desktopResourceTelemetry";
import { afterEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
  sample: vi.fn(),
  desktop: vi.fn(),
  retry: vi.fn(),
  history: vi.fn(),
}));
vi.mock("./NativeResourceMonitor.ts", () => ({
  nativeResourceMonitor: {
    sample: mocks.sample,
    history: mocks.history,
    setExternalProcesses: vi.fn(),
    retry: mocks.retry,
    health: () => ({ status: "healthy", restartCount: 0, sidecarPid: 99 }),
  },
}));
vi.mock("./DesktopResourceTelemetry.ts", () => ({ readDesktopResourceTelemetry: mocks.desktop }));
afterEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useRealTimers();
});
it("merges desktop metrics by identity, computes rates and bounded history", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T00:00:00Z"));
  const p = {
    pid: 1,
    ppid: 0,
    startTimeMs: 1,
    runTimeMs: 100,
    name: "server",
    command: "secret argv",
    status: "running",
    cpuPercent: 5,
    cpuTimeMs: 10,
    residentBytes: 100,
    virtualBytes: 200,
    ioReadBytes: 50,
    ioWriteBytes: 20,
    ioSemantics: "storage",
  };
  mocks.desktop.mockResolvedValue(null);
  mocks.history.mockResolvedValue([]);
  mocks.sample.mockResolvedValue({
    sampledAtUnixMs: Date.now(),
    collectionDurationMicros: 100,
    scannedProcessCount: 1,
    retainedProcessCount: 1,
    inaccessibleProcessCount: 0,
    processes: [p],
  });
  const { readResourceTelemetry, readResourceTelemetryHistory, recordResourceAttribution } =
    await import("./ResourceTelemetry.ts");
  recordResourceAttribution("diagnostics", "tail", 12, 0, 2);
  const first = await readResourceTelemetry();
  Schema.decodeUnknownSync(ResourceTelemetrySnapshot)(first);
  expect(first.processes[0]?.command).toBe("server");
  expect(first.groups.allRyco.processStarts).toBe(1);
  expect(first.groups.allRyco.cpuTimeMs).toBe(0);
  expect(first.groups.allRyco.ioReadBytes).toBe(0);
  expect(first.attribution.entries[0]?.logicalReadBytes).toBe(12);
  vi.setSystemTime(new Date("2026-09-07T00:00:02Z"));
  mocks.sample.mockResolvedValue({
    sampledAtUnixMs: Date.now(),
    collectionDurationMicros: 100,
    scannedProcessCount: 1,
    retainedProcessCount: 1,
    inaccessibleProcessCount: 0,
    processes: [{ ...p, ioReadBytes: 150, residentBytes: 50, cpuTimeMs: 40 }],
  });
  const second = await readResourceTelemetry();
  expect(second.processes[0]?.ioReadBytesPerSecond).toBe(50);
  expect(second.processes[0]?.peakResidentBytes).toBe(100);
  expect(second.groups.allRyco.cpuTimeMs).toBe(30);
  expect(second.groups.allRyco.ioReadBytes).toBe(100);
  const history = await readResourceTelemetryHistory({ windowMs: 60_000, bucketMs: 10_000 });
  expect(history.retainedSampleCount).toBe(2);
  expect(history.topProcesses[0]?.sampleCount).toBe(2);
  expect(history.buckets[0]?.ioReadBytes).toBe(100);
});
it("keeps Electron and power available when native sampling fails", async () => {
  mocks.sample.mockRejectedValue(new Error("unavailable"));
  mocks.desktop.mockResolvedValue({
    sampledAt: new Date().toISOString(),
    electronPid: 2,
    power: {
      idleState: "active",
      idleSeconds: 0,
      onBattery: true,
      thermalState: "nominal",
      speedLimitPercent: 80,
      suspended: false,
    },
    processes: [
      {
        pid: 2,
        startTimeMs: 1,
        type: "Browser",
        cpuPercent: 4,
        cpuTimeMs: 2,
        residentBytes: 100,
        privateBytes: 0,
        idleWakeupsPerSecond: 3,
      },
    ],
  });
  const { readResourceTelemetry } = await import("./ResourceTelemetry.ts");
  const snapshot = await readResourceTelemetry();
  Schema.decodeUnknownSync(ResourceTelemetrySnapshot)(snapshot);
  expect(snapshot.groups.electron.processCount).toBe(1);
  expect(snapshot.processes[0]?.ioSemantics).toBe("unavailable");
  expect(snapshot.power?.onBattery).toBe(true);
  expect(snapshot.speedLimitPercent).toBe(80);
});

it("serializes fractional Electron millisecond metrics in snapshots and history", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T00:00:00Z"));
  mocks.sample.mockRejectedValue(new Error("unavailable"));
  mocks.history.mockResolvedValue([]);
  const desktop = (cpuTimeMs: number) =>
    parseDesktopResourceTelemetry({
      sampledAt: new Date().toISOString(),
      processSample: true,
      electronPid: 2,
      power: {
        idleState: "active",
        idleSeconds: 0,
        onBattery: false,
        thermalState: "nominal",
        speedLimitPercent: null,
        suspended: false,
        locked: false,
        lowPowerMode: false,
        updatedAt: new Date().toISOString(),
        stale: false,
      },
      processes: [
        {
          pid: 2,
          startTimeMs: Date.parse("2026-09-06T23:59:00Z") + 0.75,
          type: "Browser",
          cpuPercent: 4.5,
          cpuTimeMs,
          residentBytes: 100,
          privateBytes: 0,
          idleWakeupsPerSecond: 3.5,
        },
      ],
    });
  mocks.desktop.mockResolvedValue(desktop(12.999));
  const { readResourceTelemetry, readResourceTelemetryHistory } =
    await import("./ResourceTelemetry.ts");
  const first = await readResourceTelemetry();
  Schema.decodeUnknownSync(ResourceTelemetrySnapshot)(first);
  vi.setSystemTime(new Date("2026-09-07T00:00:02Z"));
  mocks.desktop.mockResolvedValue(desktop(17.001));
  const second = await readResourceTelemetry();
  Schema.decodeUnknownSync(ResourceTelemetrySnapshot)(second);
  expect(second.groups.electron.cpuTimeMs).toBe(5);
  expect(second.groups.electron.processStarts).toBe(1);
  expect(second.processes[0]?.cpuPercent).toBe(4.5);
  const history = await readResourceTelemetryHistory({ windowMs: 60_000, bucketMs: 10_000 });
  Schema.decodeUnknownSync(ResourceTelemetryHistory)(history);
  expect(history.totalCpuTimeMs).toBe(5);
  expect(history.topProcesses[0]?.cpuTimeMs).toBe(5);
});

it("hydrates native history and preserves IO from exited process identities", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T00:00:10Z"));
  mocks.desktop.mockResolvedValue(null);
  mocks.history.mockResolvedValue([]);
  const processSample = {
    pid: 42,
    ppid: 0,
    startTimeMs: 1,
    runTimeMs: 100,
    name: "worker",
    command: "worker",
    status: "running",
    cpuPercent: 2,
    cpuTimeMs: 10,
    residentBytes: 100,
    virtualBytes: 0,
    ioReadBytes: 50,
    ioWriteBytes: 0,
    ioSemantics: "storage",
  };
  const sample = (time: number, processes: unknown[]) => ({
    sampledAtUnixMs: time,
    collectionDurationMicros: 1,
    scannedProcessCount: processes.length,
    retainedProcessCount: processes.length,
    inaccessibleProcessCount: 0,
    processes,
  });
  mocks.sample.mockResolvedValue(sample(Date.now(), []));
  mocks.history.mockResolvedValue([
    sample(Date.now() - 6000, [processSample]),
    sample(Date.now() - 4000, [{ ...processSample, ioReadBytes: 150 }]),
    sample(Date.now() - 2000, []),
  ]);
  const { readResourceTelemetryHistory } = await import("./ResourceTelemetry.ts");
  const result = await readResourceTelemetryHistory({ windowMs: 60000, bucketMs: 10000 });
  Schema.decodeUnknownSync(ResourceTelemetryHistory)(result);
  expect(result.retainedSampleCount).toBe(4);
  expect(result.buckets.reduce((sum, b) => sum + b.ioReadBytes, 0)).toBe(100);
  expect(result.topProcesses[0]?.identity.pid).toBe(42);
  expect(result.topProcesses[0]?.peakRssBytes).toBe(100);
});
it("rejects reused desktop PIDs and classifies registered terminal roots", async () => {
  const p = {
    pid: 42,
    ppid: 0,
    startTimeMs: 10_000,
    runTimeMs: 100,
    name: "shell",
    command: "shell",
    status: "running",
    cpuPercent: 2,
    cpuTimeMs: 10,
    residentBytes: 100,
    virtualBytes: 0,
    ioReadBytes: 50,
    ioWriteBytes: 0,
    ioSemantics: "storage",
  };
  mocks.sample.mockResolvedValue({
    sampledAtUnixMs: Date.now(),
    collectionDurationMicros: 1,
    scannedProcessCount: 1,
    retainedProcessCount: 1,
    inaccessibleProcessCount: 0,
    processes: [p],
  });
  mocks.desktop.mockResolvedValue({
    sampledAt: new Date().toISOString(),
    electronPid: 42,
    power: {
      idleState: "active",
      idleSeconds: 0,
      onBattery: false,
      thermalState: "nominal",
      speedLimitPercent: null,
      suspended: false,
    },
    processes: [
      {
        pid: 42,
        startTimeMs: 1,
        type: "Browser",
        cpuPercent: 4,
        cpuTimeMs: 2,
        residentBytes: 100,
        privateBytes: 0,
        idleWakeupsPerSecond: 3,
      },
    ],
  });
  const { readResourceTelemetry } = await import("./ResourceTelemetry.ts");
  const snapshot = await readResourceTelemetry({ terminalPids: [42] });
  expect(snapshot.processes).toHaveLength(1);
  expect(snapshot.processes[0]?.category).toBe("terminal-root");
  expect(snapshot.processes[0]?.electronType).toBeUndefined();
});
it("spreads native history across the full window and preserves known Electron identity", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T01:00:00Z"));
  const p = {
    pid: 42,
    ppid: 0,
    startTimeMs: 1,
    runTimeMs: 100,
    name: "electron",
    command: "electron",
    status: "running",
    cpuPercent: 2,
    cpuTimeMs: 10,
    residentBytes: 100,
    virtualBytes: 0,
    ioReadBytes: 50,
    ioWriteBytes: 0,
    ioSemantics: "storage",
  };
  const sample = (time: number) => ({
    sampledAtUnixMs: time,
    collectionDurationMicros: 1,
    scannedProcessCount: 1,
    retainedProcessCount: 1,
    inaccessibleProcessCount: 0,
    processes: [p],
  });
  mocks.sample.mockResolvedValue(sample(Date.now()));
  mocks.desktop.mockResolvedValue({
    sampledAt: new Date().toISOString(),
    electronPid: 42,
    power: {
      idleState: "active",
      idleSeconds: 0,
      onBattery: true,
      thermalState: "nominal",
      speedLimitPercent: null,
      suspended: false,
    },
    processes: [
      {
        pid: 42,
        startTimeMs: 999,
        type: "Browser",
        cpuPercent: 4,
        cpuTimeMs: 2,
        residentBytes: 100,
        privateBytes: 0,
        idleWakeupsPerSecond: 3,
      },
    ],
  });
  mocks.history.mockResolvedValue(
    Array.from({ length: 3600 }, (_, i) => sample(Date.now() - 3_600_000 + i * 1000)),
  );
  const { readResourceTelemetryHistory } = await import("./ResourceTelemetry.ts");
  const result = await readResourceTelemetryHistory({ windowMs: 3_600_000, bucketMs: 60_000 });
  expect(result.retainedSampleCount).toBe(720);
  expect(result.buckets[0]?.startedAt).toBe("2026-09-07T00:00:00.000Z");
  expect(result.topProcesses[0]?.category).toBe("electron-main");
});

it("totals CPU across all identities before truncating the top-process table", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T01:00:00Z"));
  mocks.desktop.mockResolvedValue(null);
  const processes = Array.from({ length: 150 }, (_, index) => ({
    pid: index + 100,
    ppid: 0,
    startTimeMs: 1,
    runTimeMs: 100,
    name: "worker",
    command: "worker",
    status: "running",
    cpuPercent: 2,
    cpuTimeMs: 1000,
    residentBytes: 100,
    virtualBytes: 0,
    ioReadBytes: 0,
    ioWriteBytes: 0,
    ioSemantics: "storage",
  }));
  const sample = (time: number, ps: unknown[]) => ({
    sampledAtUnixMs: time,
    collectionDurationMicros: 1,
    scannedProcessCount: ps.length,
    retainedProcessCount: ps.length,
    inaccessibleProcessCount: 0,
    processes: ps,
  });
  mocks.sample.mockResolvedValue(sample(Date.now(), []));
  mocks.history.mockResolvedValue([
    sample(Date.now() - 2000, processes),
    sample(
      Date.now() - 1000,
      processes.map((p) => ({ ...p, cpuTimeMs: 1010 })),
    ),
  ]);
  const { readResourceTelemetryHistory } = await import("./ResourceTelemetry.ts");
  const result = await readResourceTelemetryHistory({ windowMs: 60000, bucketMs: 1000 });
  expect(result.topProcesses).toHaveLength(100);
  expect(result.totalCpuTimeMs).toBe(1500);
  expect(result.topProcesses.reduce((sum, p) => sum + p.cpuTimeMs, 0)).toBe(1000);
});
