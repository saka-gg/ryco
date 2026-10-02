import {
  WS_METHODS,
  type ResourceTelemetryHistory,
  type ResourceTelemetrySnapshot,
} from "@ryco/contracts";
import { useEffect, useRef, useState } from "react";
import { readEnvironmentApi } from "../../environmentApi";
import { useDiagnosticsCapability } from "./useDiagnosticsCapability";
import { ensureLocalApi } from "../../localApi";
import { useSettingsTarget } from "../../settingsTarget";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";
import { visibleTelemetryProcesses } from "./ResourceTelemetryDiagnostics.logic";
import { createDiagnosticsRefresh } from "./diagnosticsRefresh";
import {
  formatBytes,
  formatDuration,
  formatPercent,
  relativeTimeLabel,
} from "./DiagnosticsSettings.logic";

const WINDOWS = [
  { label: "5m", windowMs: 300_000, bucketMs: 15_000 },
  { label: "15m", windowMs: 900_000, bucketMs: 30_000 },
  { label: "30m", windowMs: 1_800_000, bucketMs: 60_000 },
  { label: "1h", windowMs: 3_600_000, bucketMs: 120_000 },
] as const;

export function ResourceTelemetryDiagnostics({
  telemetry,
  paused,
  refresh,
}: {
  readonly telemetry: ResourceTelemetrySnapshot | undefined;
  readonly paused: boolean;
  readonly refresh: () => Promise<void>;
}) {
  const target = useSettingsTarget();
  const environmentId = target?.environmentId;
  const [windowIndex, setWindowIndex] = useState(0);
  const [history, setHistory] = useState<ResourceTelemetryHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [showIdle, setShowIdle] = useState(true);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const historyRefresh = useRef<(() => Promise<void>) | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const retryCapability = useDiagnosticsCapability(WS_METHODS.serverRetryResourceTelemetry);
  const historyCapability = useDiagnosticsCapability(WS_METHODS.serverGetResourceTelemetryHistory);
  const selectedWindow = WINDOWS[windowIndex] ?? WINDOWS[0];
  const retryLifetime = useRef(0);
  useEffect(() => {
    retryLifetime.current += 1;
    setRetrying(false);
    return () => {
      retryLifetime.current += 1;
    };
  }, [environmentId]);
  useEffect(() => {
    setHistory(null);
    setError(null);
    if (!historyCapability.allowed) {
      setLoading(false);
      return;
    }
    const controller = createDiagnosticsRefresh({
      fetch: async () => {
        const server = environmentId
          ? readEnvironmentApi(environmentId)?.server
          : ensureLocalApi().server;
        if (!server?.getResourceTelemetryHistory)
          throw new Error("Resource history is unavailable on this server.");
        return server.getResourceTelemetryHistory({
          windowMs: selectedWindow.windowMs,
          bucketMs: selectedWindow.bucketMs,
        });
      },
      onSuccess: (value) => {
        setHistory(value);
        setError(null);
      },
      onError: (cause) =>
        setError(
          cause instanceof Error ? cause.message : "Resource history could not be refreshed.",
        ),
      onLoading: setLoading,
    });
    historyRefresh.current = controller.refresh;
    const poll = () => {
      if (!pausedRef.current && document.visibilityState === "visible") void controller.refresh();
    };
    poll();
    const interval = window.setInterval(poll, 5_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      controller.dispose();
      historyRefresh.current = null;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [environmentId, selectedWindow, historyCapability.allowed, historyCapability.reason]);

  async function retry() {
    if (retrying || !retryCapability.allowed) return;
    const generation = retryLifetime.current;
    setRetrying(true);
    try {
      const server = environmentId
        ? readEnvironmentApi(environmentId)?.server
        : ensureLocalApi().server;
      if (!server?.retryResourceTelemetry)
        throw new Error("Resource monitor retry is unavailable on this server.");
      await server.retryResourceTelemetry();
      if (generation !== retryLifetime.current) return;
      await refresh();
      await historyRefresh.current?.();
    } catch (cause) {
      if (generation === retryLifetime.current)
        setError(cause instanceof Error ? cause.message : "Could not retry resource monitor.");
    } finally {
      if (generation === retryLifetime.current) setRetrying(false);
    }
  }
  const health = telemetry?.health;
  const processes = visibleTelemetryProcesses(telemetry?.processes ?? [], collapsed).filter(
    (process) =>
      showIdle ||
      process.cpuPercent > 0 ||
      process.ioReadBytesPerSecond > 0 ||
      process.ioWriteBytesPerSecond > 0 ||
      process.category === "server",
  );
  const buckets = history?.buckets ?? [];
  const cpuMax = Math.max(1, ...buckets.map((bucket) => bucket.maxCpuPercent));
  const ioMax = Math.max(
    1,
    ...buckets.map((bucket) => Math.max(bucket.ioReadBytes, bucket.ioWriteBytes)),
  );
  const memoryMax = Math.max(1, ...buckets.map((bucket) => bucket.maxRssBytes));
  return (
    <>
      <SettingsSection
        title="Resource monitor"
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={retrying || !retryCapability.allowed}
            onClick={() => void retry()}
          >
            {retrying ? "Retrying…" : "Retry monitor"}
          </Button>
        }
      >
        <p className="px-4 sm:px-5 py-3 text-xs text-muted-foreground">
          {telemetry
            ? `Sampled ${relativeTimeLabel(telemetry.readAt)} · interval ${formatDuration(telemetry.sampleIntervalMs)}`
            : "Waiting for resource telemetry."}{" "}
          CPU may exceed 100% across cores. I/O availability depends on the platform.
        </p>
        <dl className="grid grid-cols-2 gap-px border-t border-border/60 bg-border/60 lg:grid-cols-3">
          {[
            [
              "Current CPU",
              telemetry ? formatPercent(telemetry.groups.allRyco.currentCpuPercent) : "Loading…",
            ],
            [
              "Resident memory",
              telemetry ? formatBytes(telemetry.groups.allRyco.currentRssBytes) : "Loading…",
            ],
            [
              "Process count",
              telemetry ? String(telemetry.groups.allRyco.processCount) : "Loading…",
            ],
            [
              "Read throughput",
              telemetry
                ? `${formatBytes(telemetry.groups.allRyco.ioReadBytesPerSecond)}/s`
                : "Loading…",
            ],
            [
              "Write throughput",
              telemetry
                ? `${formatBytes(telemetry.groups.allRyco.ioWriteBytesPerSecond)}/s`
                : "Loading…",
            ],
            [
              "CPU speed limit",
              telemetry?.speedLimitPercent == null ? "Unknown" : `${telemetry.speedLimitPercent}%`,
            ],
          ].map(([label, value]) => (
            <div key={label} className="bg-card px-4 py-4 sm:px-5">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-1.5 text-xl font-semibold tracking-tight tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[850px] text-left text-xs [&_td]:px-4 [&_td]:py-3">
            <thead className="border-y text-muted-foreground">
              <tr>
                {[
                  "Group",
                  "Processes",
                  "CPU / time",
                  "RSS / peak",
                  "Read / write rate",
                  "Read / write total",
                  "Starts / exits",
                ].map((label) => (
                  <th className="px-4 sm:px-5 py-2 font-medium" key={label}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {telemetry
                ? Object.entries(telemetry.groups).map(([name, group]) => (
                    <tr key={name}>
                      <td>
                        {(
                          {
                            allRyco: "All Ryco",
                            backend: "Backend + agents",
                            electron: "Desktop",
                            monitor: "Monitor overhead",
                          } as Record<string, string>
                        )[name] ?? name}
                      </td>
                      <td>{group.processCount}</td>
                      <td>
                        {formatPercent(group.currentCpuPercent)}
                        <div>{formatDuration(group.cpuTimeMs)}</div>
                      </td>
                      <td>
                        {formatBytes(group.currentRssBytes)}
                        <div>{formatBytes(group.peakRssBytes)}</div>
                      </td>
                      <td>
                        {formatBytes(group.ioReadBytesPerSecond)}/s
                        <div>{formatBytes(group.ioWriteBytesPerSecond)}/s</div>
                      </td>
                      <td>
                        {formatBytes(group.ioReadBytes)}
                        <div>{formatBytes(group.ioWriteBytes)}</div>
                      </td>
                      <td>
                        {group.processStarts} / {group.processExits}
                      </td>
                    </tr>
                  ))
                : null}
            </tbody>
          </table>
        </div>
      </SettingsSection>
      <SettingsSection title="Host & collection">
        {health ? (
          <div className="grid gap-3 border-t px-4 sm:px-5 py-3 text-xs sm:grid-cols-2">
            {(["native", "desktop"] as const).map((source) => (
              <div key={source}>
                <strong className="capitalize">
                  {source}: {health[source].status}
                </strong>
                <p className="mt-1 text-muted-foreground">
                  {health[source].lastSampleAt
                    ? `Last sample ${relativeTimeLabel(health[source].lastSampleAt)}`
                    : "No sample"}
                </p>
                {health[source].lastError ? (
                  <p className="mt-1 text-warning">{health[source].lastError}</p>
                ) : null}
              </div>
            ))}
            <p>
              Monitor {health.sidecarVersion ?? "version unavailable"} · PID{" "}
              {health.sidecarPid ?? "unavailable"} · {health.restartCount} restarts
            </p>
            <p>
              {(health.collectionDurationMicros / 1_000).toFixed(2)} ms collection ·{" "}
              {health.scannedProcessCount} scanned · {health.retainedProcessCount} retained ·{" "}
              {health.inaccessibleProcessCount} inaccessible
            </p>
          </div>
        ) : null}
        <div className="border-t px-4 sm:px-5 py-3 text-xs">
          <h3 className="text-xs font-medium">Power and background state</h3>
          {telemetry?.power ? (
            <dl className="mt-3 grid grid-cols-2 gap-3">
              {Object.entries(telemetry.power).map(([key, value]) => (
                <div key={key}>
                  <dt className="text-muted-foreground">
                    {(
                      {
                        idleState: "Idle state",
                        idleSeconds: "Idle seconds",
                        onBattery: "On battery",
                        thermalState: "Thermal state",
                        speedLimitPercent: "CPU speed limit (%)",
                        suspended: "Suspended",
                        lowPowerMode: "Low power mode",
                        locked: "Screen locked",
                        updatedAt: "Updated",
                        stale: "Stale",
                      } as Record<string, string>
                    )[key] ?? key}
                  </dt>
                  <dd>
                    {value === null
                      ? "Unknown"
                      : typeof value === "boolean"
                        ? value
                          ? "Yes"
                          : "No"
                        : String(value)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-2 text-muted-foreground">
              Desktop power state is unavailable on this connection.
            </p>
          )}
          <p className="mt-2">
            CPU speed limit:{" "}
            {telemetry?.speedLimitPercent == null ? "Unknown" : `${telemetry.speedLimitPercent}%`}
          </p>
        </div>
      </SettingsSection>
      <SettingsSection
        title="Resource timeline"
        headerAction={
          <div className="flex items-center gap-1">
            <div role="group" aria-label="Resource history period" className="flex gap-1">
              {WINDOWS.map((window, index) => (
                <Button
                  key={window.label}
                  size="xs"
                  variant={windowIndex === index ? "secondary" : "outline"}
                  aria-pressed={windowIndex === index}
                  onClick={() => setWindowIndex(index)}
                >
                  {window.label}
                </Button>
              ))}
            </div>
            <Button
              size="xs"
              variant="outline"
              disabled={loading}
              onClick={() => void historyRefresh.current?.()}
            >
              Refresh
            </Button>
          </div>
        }
      >
        {error ? (
          <p role="alert" className="px-4 sm:px-5 py-3 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <p className="px-4 sm:px-5 py-3 text-xs text-muted-foreground">
          {history
            ? `${history.totalCpuTimeMs === undefined ? "Unavailable" : formatDuration(history.totalCpuTimeMs)} total CPU time · ${history.retainedSampleCount} retained samples · ${formatDuration(history.sampleIntervalMs)} sampling interval · checked ${relativeTimeLabel(history.readAt)}`
            : "Collecting resource history…"}
        </p>
        <div className="grid gap-4 px-4 sm:px-5 pb-4 sm:grid-cols-2">
          {(["cpu", "memory", "read", "write"] as const).map((metric) => (
            <div key={metric}>
              <p className="mb-2 text-xs font-medium">
                {metric === "cpu"
                  ? "CPU average / peak"
                  : metric === "memory"
                    ? "Peak RSS"
                    : metric === "read"
                      ? "I/O reads"
                      : "I/O writes"}
              </p>
              <svg
                viewBox="0 0 400 100"
                role="img"
                aria-label={
                  metric === "cpu"
                    ? "CPU history"
                    : metric === "memory"
                      ? "Memory history"
                      : metric === "read"
                        ? "I/O read history"
                        : "I/O write history"
                }
                className="h-24 w-full text-info"
              >
                {buckets.map((bucket, index) => {
                  const value =
                    metric === "cpu"
                      ? bucket.maxCpuPercent / cpuMax
                      : metric === "memory"
                        ? bucket.maxRssBytes / memoryMax
                        : (metric === "read" ? bucket.ioReadBytes : bucket.ioWriteBytes) / ioMax;
                  const avg = bucket.avgCpuPercent / cpuMax;
                  return (
                    <g key={bucket.startedAt}>
                      <title>
                        {new Date(bucket.startedAt).toLocaleTimeString()}: average{" "}
                        {formatPercent(bucket.avgCpuPercent)}, peak{" "}
                        {formatPercent(bucket.maxCpuPercent)}, RSS {formatBytes(bucket.maxRssBytes)}
                        , read {formatBytes(bucket.ioReadBytes)}, write{" "}
                        {formatBytes(bucket.ioWriteBytes)}, {bucket.maxProcessCount} processes
                      </title>
                      <rect
                        x={(index * 400) / Math.max(1, buckets.length)}
                        y={100 - value * 100}
                        width={Math.max(1, 400 / Math.max(1, buckets.length) - 2)}
                        height={value * 100}
                        fill="currentColor"
                        opacity={metric === "cpu" ? 0.3 : 1}
                      />
                      {metric === "cpu" ? (
                        <rect
                          x={(index * 400) / Math.max(1, buckets.length)}
                          y={100 - avg * 100}
                          width={Math.max(1, 400 / Math.max(1, buckets.length) - 2)}
                          height={avg * 100}
                          fill="currentColor"
                        />
                      ) : null}
                    </g>
                  );
                })}
              </svg>
              <p className="text-[11px] text-muted-foreground">
                Scale:{" "}
                {metric === "cpu"
                  ? formatPercent(cpuMax)
                  : formatBytes(metric === "memory" ? memoryMax : ioMax)}
              </p>
            </div>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[850px] text-left text-xs [&_td]:px-4 [&_td]:py-3">
            <thead className="border-y text-muted-foreground">
              <tr>
                {[
                  "Process",
                  "CPU avg / peak",
                  "CPU time",
                  "RSS / peak",
                  "I/O read / write",
                  "Samples / last seen",
                ].map((label) => (
                  <th key={label} className="px-4 sm:px-5 py-2 font-medium">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {history?.topProcesses.map((process) => (
                <tr key={`${process.identity.pid}:${process.identity.startTimeMs}`}>
                  <td>
                    <details>
                      <summary className="cursor-pointer">
                        {process.name} ({process.identity.pid})
                      </summary>
                      <p className="max-w-72 break-all font-mono">{process.command}</p>
                    </details>
                    <div className="text-muted-foreground">{process.category}</div>
                  </td>
                  <td>
                    {formatPercent(process.avgCpuPercent)} / {formatPercent(process.maxCpuPercent)}
                  </td>
                  <td>{formatDuration(process.cpuTimeMs)}</td>
                  <td>
                    {formatBytes(process.currentRssBytes)} / {formatBytes(process.peakRssBytes)}
                  </td>
                  <td>
                    {process.ioSemantics === "unavailable"
                      ? "Unavailable"
                      : `${formatBytes(process.ioReadBytes)} / ${formatBytes(process.ioWriteBytes)}`}
                  </td>
                  <td>
                    {process.sampleCount} · {relativeTimeLabel(process.lastSeenAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SettingsSection>
      <SettingsSection
        title="Live process tree"
        headerAction={
          <Button
            size="xs"
            variant="outline"
            aria-pressed={showIdle}
            onClick={() => setShowIdle((value) => !value)}
          >
            {showIdle ? "Hide idle processes" : "Show idle processes"}
          </Button>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px] text-left text-xs [&_td]:px-4 [&_td]:py-3 [&_td]:align-top">
            <thead className="border-b text-muted-foreground">
              <tr>
                {[
                  "Process / category",
                  "PID / parent",
                  "CPU / time",
                  "RSS / peak / virtual",
                  "I/O rate / semantics",
                  "Wakeups / uptime",
                ].map((label) => (
                  <th key={label} className="px-4 sm:px-5 py-2 font-medium">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {processes.map((process) => (
                <tr key={`${process.identity.pid}:${process.identity.startTimeMs}`}>
                  <td className="max-w-80">
                    <div style={{ paddingLeft: Math.min(process.depth, 8) * 10 }}>
                      {process.childPids.length > 0 ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label={`${collapsed.has(`${process.identity.pid}:${process.identity.startTimeMs}`) ? "Expand" : "Collapse"} ${process.name} children`}
                          aria-expanded={
                            !collapsed.has(
                              `${process.identity.pid}:${process.identity.startTimeMs}`,
                            )
                          }
                          onClick={() =>
                            setCollapsed((current) => {
                              const next = new Set(current);
                              const key = `${process.identity.pid}:${process.identity.startTimeMs}`;
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            })
                          }
                        >
                          {collapsed.has(`${process.identity.pid}:${process.identity.startTimeMs}`)
                            ? "+"
                            : "−"}
                        </Button>
                      ) : null}
                      <details>
                        <summary className="cursor-pointer break-all">{process.name}</summary>
                        <p className="mt-2 break-all font-mono">{process.command}</p>
                        <p>
                          First seen {relativeTimeLabel(process.firstSeenAt)} · last seen{" "}
                          {relativeTimeLabel(process.lastSeenAt)}
                        </p>
                      </details>
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {process.category} {process.electronType} {process.electronServiceName} ·{" "}
                      {process.status}
                    </div>
                  </td>
                  <td>
                    {process.identity.pid} / {process.ppid}
                  </td>
                  <td>
                    {formatPercent(process.cpuPercent)}
                    <div>{formatDuration(process.cpuTimeMs)}</div>
                  </td>
                  <td>
                    {formatBytes(process.residentBytes)}
                    <div>{formatBytes(process.peakResidentBytes)}</div>
                    <div>{formatBytes(process.virtualBytes)}</div>
                  </td>
                  <td>
                    {process.ioSemantics === "unavailable" ? (
                      "Unavailable"
                    ) : (
                      <>
                        {formatBytes(process.ioReadBytesPerSecond)}/s read
                        <div>{formatBytes(process.ioWriteBytesPerSecond)}/s write</div>
                        <div>
                          {formatBytes(process.ioReadBytes)} / {formatBytes(process.ioWriteBytes)}{" "}
                          total
                        </div>
                      </>
                    )}
                    <div className="text-muted-foreground">{process.ioSemantics}</div>
                  </td>
                  <td>
                    {process.idleWakeupsPerSecond == null
                      ? "Unavailable"
                      : `${process.idleWakeupsPerSecond.toFixed(1)}/s`}
                    <div>{formatDuration(process.runTimeMs)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {processes.length === 0 ? (
          <p className="px-4 sm:px-5 py-3 text-xs text-muted-foreground">
            No active processes in this sample. Show idle processes to include retained idle
            entries.
          </p>
        ) : null}
      </SettingsSection>
      <SettingsSection title="Instrumented application I/O">
        <p className="px-4 sm:px-5 py-3 text-xs text-muted-foreground">
          Application read/write counters describe logical work and are separate from
          operating-system storage bytes.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[650px] text-left text-xs [&_td]:px-4 [&_td]:py-3">
            <thead className="border-y text-muted-foreground">
              <tr>
                {["Component / operation", "Read", "Write", "Count", "Duration"].map((label) => (
                  <th key={label} className="px-4 sm:px-5 py-2 font-medium">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {telemetry?.attribution.entries.map((entry) => (
                <tr key={`${entry.component}:${entry.operation}`}>
                  <td>
                    {entry.component} / {entry.operation}
                  </td>
                  <td>{formatBytes(entry.logicalReadBytes)}</td>
                  <td>{formatBytes(entry.logicalWriteBytes)}</td>
                  <td>{entry.count}</td>
                  <td>{formatDuration(entry.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!telemetry?.attribution.entries.length ? (
          <p className="px-4 sm:px-5 py-3 text-xs text-muted-foreground">
            No logical I/O attribution captured.
          </p>
        ) : null}
      </SettingsSection>
    </>
  );
}
