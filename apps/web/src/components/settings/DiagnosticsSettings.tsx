import { WS_METHODS, type DiagnosticsSnapshot, type DiagnosticsSpan } from "@ryco/contracts";
import { PauseIcon, PlayIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useSavedEnvironmentRuntimeStore } from "../../environments/runtime";
import { readEnvironmentApi } from "../../environmentApi";
import { ensureLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { useSlowRpcAckRequests } from "../../rpc/requestLatencyState";
import { useTierOverrideStore, type PresentationTierOverride } from "../../tierOverrideStore";
import { useSettingsEditingScope, useSettingsTarget } from "../../settingsTarget";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { useDiagnosticsCapability } from "./useDiagnosticsCapability";
import { createDiagnosticsRefresh } from "./diagnosticsRefresh";
import { ResourceTelemetryDiagnostics } from "./ResourceTelemetryDiagnostics";
import { ProcessDiagnosticsSection } from "./ProcessDiagnosticsSection";
import { DetailedTraceDiagnostics, DiagnosticsTraceId } from "./DetailedTraceDiagnostics";
import { DiagnosticsSupportSections } from "./DiagnosticsPanel";
import { NotificationsTestSection } from "./NotificationsTestSection";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import {
  durationBucketSeries,
  formatBytes,
  formatDuration,
  formatPercent,
  isDiagnosticsSpanFailure,
  latestFailureLabel,
  relativeTimeLabel,
  resourceCpuSeries,
  resourceMemorySeries,
  topSpanSeries,
} from "./DiagnosticsSettings.logic";

const POLL_INTERVAL_MS = 5_000;

interface SeriesPoint {
  readonly label: string;
  readonly value: number;
}

function MiniLineChart({
  points,
  formatValue,
}: {
  points: ReadonlyArray<SeriesPoint>;
  formatValue: (value: number) => string;
}) {
  const width = 320;
  const height = 96;
  const path = useMemo(() => {
    if (points.length === 0) return "";
    const max = Math.max(...points.map((point) => point.value), 1);
    return points
      .map((point, index) => {
        const x = points.length === 1 ? width : (index / (points.length - 1)) * width;
        const y = height - (point.value / max) * (height - 12) - 6;
        return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  }, [points]);
  const latest = points.at(-1)?.value ?? 0;

  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="font-mono text-[11px] text-muted-foreground/70">
          {points.length} samples
        </span>
        <span className="font-mono text-xs text-foreground">{formatValue(latest)}</span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-24 w-full overflow-visible text-info"
        role="img"
        aria-label="Diagnostics history chart"
      >
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        <line x1="0" y1={height - 1} x2={width} y2={height - 1} className="stroke-border" />
      </svg>
    </div>
  );
}

function BarList({
  points,
  formatValue = String,
}: {
  points: ReadonlyArray<SeriesPoint>;
  formatValue?: (value: number) => string;
}) {
  const max = Math.max(...points.map((point) => point.value), 1);
  if (points.length === 0) {
    return <p className="px-4 py-4 text-muted-foreground text-sm">No data yet.</p>;
  }

  return (
    <div className="divide-y divide-border/60">
      {points.map((point) => (
        <div
          key={point.label}
          className="grid grid-cols-[minmax(0,1fr)_5rem] items-center gap-3 px-4 py-2.5"
        >
          <div className="min-w-0">
            <div className="mb-1 truncate text-[12px] font-medium">{point.label}</div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-info"
                style={{ width: `${Math.max(4, (point.value / max) * 100)}%` }}
              />
            </div>
          </div>
          <div className="text-right font-mono text-[11px] text-muted-foreground">
            {formatValue(point.value)}
          </div>
        </div>
      ))}
    </div>
  );
}

function OverviewMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string | undefined;
}) {
  return (
    <div className="min-w-0 border-border/60 border-t px-4 py-3 first:border-t-0 sm:px-5">
      <div className="truncate text-[11px] font-medium text-muted-foreground uppercase tracking-[0.08em]">
        {label}
      </div>
      <div className="mt-1 truncate text-[15px] font-semibold text-foreground">{value}</div>
      {detail ? (
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{detail}</div>
      ) : null}
    </div>
  );
}

function EvidenceRow({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <div className="grid gap-1 border-border/60 border-t px-4 py-3 first:border-t-0 sm:grid-cols-[11rem_minmax(0,1fr)] sm:px-5">
      <div className="text-[12px] font-medium text-foreground">{label}</div>
      <div className="min-w-0">
        <div className="font-mono text-[12px] text-foreground">{value}</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">{detail}</div>
      </div>
    </div>
  );
}

function RawDetails({ value }: { value: unknown }) {
  return (
    <details className="group">
      <summary className="cursor-pointer select-none text-[11px] text-muted-foreground hover:text-foreground">
        raw
      </summary>
      <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted/60 p-3 text-[11px] leading-relaxed">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

function SpanRows({
  spans,
  showTraceId = false,
}: {
  spans: ReadonlyArray<DiagnosticsSpan>;
  showTraceId?: boolean;
}) {
  if (spans.length === 0) {
    return <p className="px-4 py-4 text-muted-foreground text-sm">No spans retained yet.</p>;
  }
  return (
    <div className="divide-y divide-border/60">
      {spans.slice(0, 10).map((span) => (
        <div
          key={span.id}
          className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_6rem_5rem] sm:items-start"
        >
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[13px] font-medium">{span.name}</span>
              <Badge
                size="sm"
                variant={isDiagnosticsSpanFailure(span.status) ? "error" : "outline"}
              >
                {span.status}
              </Badge>
            </div>
            <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
              {span.source} / {span.kind} / {span.spanId}
            </div>
            {showTraceId ? <DiagnosticsTraceId value={span.traceId} /> : null}
            {span.failureMessage && isDiagnosticsSpanFailure(span.status) ? (
              <div className="mt-1 line-clamp-2 text-[11px] text-destructive">
                {span.failureMessage}
              </div>
            ) : null}
            <div className="mt-2">
              <RawDetails value={span} />
            </div>
          </div>
          <div className="font-mono text-[11px] text-muted-foreground sm:text-right">
            {formatDuration(span.durationMs)}
          </div>
          <div className="font-mono text-[11px] text-muted-foreground sm:text-right">
            {relativeTimeLabel(span.endTime)}
          </div>
        </div>
      ))}
    </div>
  );
}

function ResourceHistorySection({
  memorySeries,
  cpuSeries,
}: {
  readonly memorySeries: ReadonlyArray<SeriesPoint>;
  readonly cpuSeries: ReadonlyArray<SeriesPoint>;
}) {
  return (
    <SettingsSection title="Resource history">
      <div className="grid gap-0 divide-y divide-border/60 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
        <div className="min-w-0 p-4">
          <div className="mb-1 text-[12px] font-semibold">RSS memory</div>
          <MiniLineChart points={memorySeries} formatValue={formatBytes} />
        </div>
        <div className="min-w-0 p-4">
          <div className="mb-1 text-[12px] font-semibold">CPU utilization</div>
          <MiniLineChart points={cpuSeries} formatValue={(value) => `${value.toFixed(1)}%`} />
        </div>
      </div>
    </SettingsSection>
  );
}

function TracingDiagnosticsSection({
  snapshot,
  showTraceId = false,
}: {
  readonly snapshot: DiagnosticsSnapshot | null;
  readonly showTraceId?: boolean;
}) {
  return (
    <SettingsSection title="Tracing diagnostics">
      <div className="grid gap-0 divide-y divide-border/60 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
        <div className="min-w-0">
          <div className="border-border/60 border-b px-4 py-2 text-[12px] font-semibold">
            Top span names
          </div>
          <BarList points={topSpanSeries(snapshot?.tracing.topSpanNames ?? [])} />
        </div>
        <div className="min-w-0">
          <div className="border-border/60 border-b px-4 py-2 text-[12px] font-semibold">
            Duration buckets
          </div>
          <BarList points={durationBucketSeries(snapshot?.tracing.durationBuckets ?? [])} />
        </div>
      </div>
      <div className="border-border/60 border-t">
        <div className="border-border/60 border-b px-4 py-2 text-[12px] font-semibold">
          Slowest spans
        </div>
        <SpanRows spans={snapshot?.tracing.slowestSpans ?? []} showTraceId={showTraceId} />
      </div>
    </SettingsSection>
  );
}

function FailuresSection({
  snapshot,
  nowMs,
}: {
  readonly snapshot: DiagnosticsSnapshot | null;
  readonly nowMs: number;
}) {
  return (
    <SettingsSection title="Failures">
      <div className="divide-y divide-border/60">
        {(snapshot?.failures.latest ?? []).slice(0, 8).map((failure) => (
          <div key={failure.id} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_6rem]">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <Badge size="sm" variant="error">
                  {failure.category}
                </Badge>
                <span className="truncate text-[13px] font-medium">{failure.message}</span>
              </div>
              <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                {failure.source} / {failure.signature}
              </div>
              <div className="mt-2">
                <RawDetails value={failure.raw ?? failure} />
              </div>
            </div>
            <div className="font-mono text-[11px] text-muted-foreground sm:text-right">
              {relativeTimeLabel(failure.occurredAt, nowMs)}
            </div>
          </div>
        ))}
        {snapshot && snapshot.failures.latest.length === 0 ? (
          <p className="px-4 py-4 text-muted-foreground text-sm">No failures retained.</p>
        ) : null}
      </div>
    </SettingsSection>
  );
}

function LiveActivitySection({
  snapshot,
  slowRpcAcks,
  nowMs,
}: {
  readonly snapshot: DiagnosticsSnapshot | null;
  readonly slowRpcAcks: ReturnType<typeof useSlowRpcAckRequests>;
  readonly nowMs: number;
}) {
  return (
    <SettingsSection title="Live activity">
      <div className="grid gap-0 divide-y divide-border/60 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
        <div className="min-w-0">
          <div className="border-border/60 border-b px-4 py-2 text-[12px] font-semibold">
            Providers
          </div>
          <div className="divide-y divide-border/60">
            {(snapshot?.liveProcesses.providers ?? []).map((provider) => (
              <div
                key={provider.instanceId}
                className="flex min-w-0 items-center justify-between gap-3 px-4 py-2.5"
              >
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium">
                    {provider.displayName ?? provider.instanceId}
                  </div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">
                    {provider.driver}
                  </div>
                </div>
                <Badge
                  size="sm"
                  variant={
                    provider.status === "error"
                      ? "error"
                      : provider.status === "warning"
                        ? "warning"
                        : "outline"
                  }
                >
                  {provider.status}
                </Badge>
              </div>
            ))}
          </div>
        </div>
        <div className="min-w-0">
          <div className="border-border/60 border-b px-4 py-2 text-[12px] font-semibold">
            Terminals and slow RPCs
          </div>
          <div className="divide-y divide-border/60">
            {(snapshot?.liveProcesses.terminals ?? []).map((terminal) => (
              <div key={`${terminal.threadId}:${terminal.terminalId}`} className="px-4 py-2.5">
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <span className="truncate text-[13px] font-medium">{terminal.terminalId}</span>
                  <Badge size="sm" variant={terminal.status === "error" ? "error" : "outline"}>
                    {terminal.status}
                  </Badge>
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                  pid {terminal.pid ?? "n/a"} / subprocess{" "}
                  {terminal.hasRunningSubprocess ? "yes" : "no"}
                </div>
              </div>
            ))}
            {slowRpcAcks.map((request) => (
              <div key={request.requestId} className="px-4 py-2.5">
                <div className="truncate text-[13px] font-medium">{request.tag}</div>
                <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                  slow ack / {relativeTimeLabel(request.startedAt, nowMs)}
                </div>
              </div>
            ))}
            {(snapshot?.liveProcesses.terminals.length ?? 0) === 0 && slowRpcAcks.length === 0 ? (
              <p className="px-4 py-4 text-muted-foreground text-sm">
                No live terminal or slow RPC activity.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}

function LegacyDiagnosticsSections({
  snapshot,
  memorySeries,
  cpuSeries,
  slowRpcAcks,
  latestFailure,
  nowMs,
}: {
  readonly snapshot: DiagnosticsSnapshot | null;
  readonly memorySeries: ReadonlyArray<SeriesPoint>;
  readonly cpuSeries: ReadonlyArray<SeriesPoint>;
  readonly slowRpcAcks: ReturnType<typeof useSlowRpcAckRequests>;
  readonly latestFailure: string;
  readonly nowMs: number;
}) {
  return (
    <>
      <SettingsSection title="Overview">
        <div className="grid sm:grid-cols-2 lg:grid-cols-3">
          <OverviewMetric
            label="Uptime"
            value={snapshot ? formatDuration(snapshot.uptimeMs) : "n/a"}
            detail={
              snapshot ? `Started ${relativeTimeLabel(snapshot.serverStartedAt, nowMs)}` : undefined
            }
          />
          <OverviewMetric
            label="Memory"
            value={snapshot ? formatBytes(snapshot.resources.current.memory.rssBytes) : "n/a"}
            detail={
              snapshot
                ? `${formatBytes(snapshot.resources.current.memory.heapUsedBytes)} heap used`
                : undefined
            }
          />
          <OverviewMetric
            label="CPU"
            value={
              snapshot ? formatPercent(snapshot.resources.current.cpu.utilizationPercent) : "n/a"
            }
            detail={
              snapshot?.resources.current.eventLoopDelayMs !== undefined
                ? `${formatDuration(snapshot.resources.current.eventLoopDelayMs)} event loop delay`
                : undefined
            }
          />
          <OverviewMetric
            label="Activity"
            value={`${snapshot?.liveProcesses.providers.filter((provider) => provider.enabled).length ?? 0} providers`}
            detail={`${snapshot?.liveProcesses.terminals.length ?? 0} terminal sessions`}
          />
          <OverviewMetric
            label="Tracing"
            value={`${snapshot?.tracing.retainedSpanCount ?? 0} spans`}
            detail={snapshot ? `${snapshot.limits.fileTailBytes / 1024} KB file tail` : undefined}
          />
          <OverviewMetric label="Latest failure" value={latestFailure} />
        </div>
      </SettingsSection>

      <ResourceHistorySection memorySeries={memorySeries} cpuSeries={cpuSeries} />
      <TracingDiagnosticsSection snapshot={snapshot} />
      <FailuresSection snapshot={snapshot} nowMs={nowMs} />
      <LiveActivitySection snapshot={snapshot} slowRpcAcks={slowRpcAcks} nowMs={nowMs} />
    </>
  );
}

function DiagnosticsWarnings({
  snapshot,
  error,
}: {
  snapshot: DiagnosticsSnapshot | null;
  error: string | null;
}) {
  if (!error && (!snapshot || snapshot.warnings.length === 0)) return null;

  return (
    <Alert variant={error ? "error" : "warning"}>
      <TriangleAlertIcon />
      <AlertTitle>{error ? "Diagnostics refresh failed" : "Diagnostics warnings"}</AlertTitle>
      <AlertDescription>
        {error ? <span>{error}</span> : null}
        {snapshot?.warnings.slice(0, 4).map((warning) => (
          <span key={`${warning.code}:${warning.source ?? ""}`}>
            {warning.message}
            {warning.count ? ` (${warning.count})` : ""}
          </span>
        ))}
      </AlertDescription>
    </Alert>
  );
}

const TIER_PREVIEW_OPTIONS: ReadonlyArray<{
  label: string;
  value: PresentationTierOverride | null;
}> = [
  { label: "Auto", value: null },
  { label: "Phone preview", value: "phone" },
  { label: "Desktop preview", value: "desktop" },
];

/**
 * Development/QA-only preview override for the presentation tier. Rendered
 * exclusively behind `import.meta.env.DEV`, so production builds tree-shake
 * this section away. Forcing the tier only changes the tier signal and the
 * root `data-tier` attribute; it never touches `prefers-color-scheme`,
 * `display-mode`, reduced motion, PWA lifecycle, or capability logic.
 */
function TierPreviewSection() {
  const override = useTierOverrideStore((state) => state.override);
  const setOverride = useTierOverrideStore((state) => state.setOverride);
  const tier = usePresentationTier();

  return (
    <SettingsSection title="Presentation tier preview">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label="Presentation tier preview"
        >
          {TIER_PREVIEW_OPTIONS.map((option) => (
            <Button
              key={option.label}
              size="xs"
              variant={override === option.value ? "secondary" : "outline"}
              aria-pressed={override === option.value}
              onClick={() => setOverride(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <span className="font-mono text-[11px] text-muted-foreground">Effective tier: {tier}</span>
      </div>
      <p className="border-border/60 border-t px-4 py-2.5 text-[11px] text-muted-foreground sm:px-5">
        Development-only QA preview. Forces the phone/desktop layout tier; residual width-based
        cosmetics may differ slightly from a real device. Theme, display-mode, and PWA behavior are
        never affected.
      </p>
    </SettingsSection>
  );
}

export type DiagnosticsPresentation = "performance" | "phone-legacy";

export function DiagnosticsSettings({
  presentation = "performance",
}: {
  readonly presentation?: DiagnosticsPresentation;
}) {
  const settingsTarget = useSettingsTarget();
  const scope = useSettingsEditingScope();
  if (scope === "client")
    return (
      <SettingsPageContainer>
        <NotificationsTestSection />
        {import.meta.env.DEV ? <TierPreviewSection /> : null}
      </SettingsPageContainer>
    );
  return (
    <DiagnosticsSettingsContent
      key={settingsTarget?.environmentId ?? "local"}
      presentation={presentation}
    />
  );
}

function DiagnosticsSettingsContent({
  presentation,
}: {
  readonly presentation: DiagnosticsPresentation;
}) {
  const settingsTarget = useSettingsTarget();
  const scope = useSettingsEditingScope();
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const slowRpcAcks = useSlowRpcAckRequests();
  const environmentRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const nowMs = Date.now();
  const readCapability = useDiagnosticsCapability(WS_METHODS.serverGetDiagnosticsSnapshot);
  const targetEnvironmentId = settingsTarget?.environmentId;
  const targetLabel = settingsTarget?.nodeLabel;

  const refresh = useCallback(async (_allowHidden = false) => {
    await refreshRef.current?.();
  }, []);

  useEffect(() => {
    setSnapshot(null);
    setError(null);
    setLoading(true);
    if (!readCapability.allowed) {
      setError(readCapability.reason);
      setLoading(false);
      return;
    }
    const controller = createDiagnosticsRefresh({
      fetch: async () => {
        const server = targetEnvironmentId
          ? readEnvironmentApi(targetEnvironmentId)?.server
          : ensureLocalApi().server;
        if (!server)
          throw new Error(`Diagnostics are unavailable on ${targetLabel ?? "this environment"}.`);
        return server.getDiagnosticsSnapshot();
      },
      onSuccess: (next) => {
        setSnapshot(next);
        setError(null);
      },
      onError: (refreshError) =>
        setError(
          refreshError instanceof Error ? refreshError.message : "Unable to refresh diagnostics.",
        ),
      onLoading: setLoading,
    });
    refreshRef.current = controller.refresh;
    const poll = () => {
      if (!pausedRef.current && document.visibilityState === "visible") void controller.refresh();
    };
    poll();
    const intervalId = window.setInterval(poll, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      controller.dispose();
      refreshRef.current = null;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [targetEnvironmentId, targetLabel, readCapability.allowed, readCapability.reason]);

  useEffect(() => {
    if (!paused && document.visibilityState === "visible") void refresh();
  }, [paused, refresh]);

  const memorySeries = useMemo(
    () => resourceMemorySeries(snapshot?.resources.history ?? []),
    [snapshot],
  );
  const cpuSeries = useMemo(() => resourceCpuSeries(snapshot?.resources.history ?? []), [snapshot]);
  const latestFailure = snapshot ? latestFailureLabel(snapshot) : "No snapshot";
  const activeProviderCount =
    snapshot?.liveProcesses.providers.filter((provider) => provider.enabled).length ?? 0;
  const activeTerminalCount =
    snapshot?.liveProcesses.terminals.filter(
      (terminal) => terminal.status === "starting" || terminal.status === "running",
    ).length ?? 0;
  const environmentConnectionStates = Object.values(environmentRuntimeById);
  const connectedEnvironmentCount = environmentConnectionStates.filter(
    (runtime) => runtime.connectionState === "connected",
  ).length;
  const connectingEnvironmentCount = environmentConnectionStates.filter(
    (runtime) => runtime.connectionState === "connecting",
  ).length;
  const websocketState =
    environmentConnectionStates.length === 0
      ? "No tracked clients"
      : `${connectedEnvironmentCount} connected${connectingEnvironmentCount > 0 ? ` · ${connectingEnvironmentCount} connecting` : ""}`;
  const slowestServerSpan =
    snapshot?.tracing.slowestSpans.find((span) => span.source === "server") ?? null;
  const latestSlowRpc = slowRpcAcks[0] ?? null;
  const performance = snapshot?.performance ?? null;
  const turnQuiescenceAvgMs = performance?.local.turnQuiescenceAvgMs ?? null;
  const checkpointDurationP95Ms = performance?.local.checkpointDurationP95Ms ?? null;
  const latestThreadSnapshotDurationMs = performance?.local.latestThreadSnapshotDurationMs ?? null;
  const threadSnapshotDurationP95Ms = performance?.local.threadSnapshotDurationP95Ms ?? null;

  return (
    <SettingsPageContainer>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-base font-semibold">Diagnostics</h1>
          <p className="mt-1 text-muted-foreground text-xs">
            {snapshot
              ? `Updated ${relativeTimeLabel(snapshot.generatedAt, nowMs)}`
              : "Waiting for snapshot"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="xs" variant="outline" onClick={() => setPaused((value) => !value)}>
            {paused ? <PlayIcon className="size-3.5" /> : <PauseIcon className="size-3.5" />}
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button size="xs" variant="outline" onClick={() => void refresh(true)} disabled={loading}>
            <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      <DiagnosticsWarnings snapshot={snapshot} error={error} />

      {import.meta.env.DEV && presentation === "phone-legacy" ? <TierPreviewSection /> : null}

      {presentation === "phone-legacy" ? (
        <LegacyDiagnosticsSections
          snapshot={snapshot}
          memorySeries={memorySeries}
          cpuSeries={cpuSeries}
          slowRpcAcks={slowRpcAcks}
          latestFailure={latestFailure}
          nowMs={nowMs}
        />
      ) : (
        <>
          <ResourceTelemetryDiagnostics
            key={`telemetry:${targetEnvironmentId ?? "local"}`}
            telemetry={snapshot?.telemetry}
            paused={paused}
            refresh={refresh}
          />
          <ProcessDiagnosticsSection
            key={targetEnvironmentId ?? "local"}
            snapshot={snapshot}
            refresh={refresh}
          />
          <DetailedTraceDiagnostics snapshot={snapshot} nowMs={nowMs} />
          <TracingDiagnosticsSection snapshot={snapshot} showTraceId />
          <FailuresSection snapshot={snapshot} nowMs={nowMs} />
          <LiveActivitySection snapshot={snapshot} slowRpcAcks={slowRpcAcks} nowMs={nowMs} />
          <SettingsSection title="Performance now">
            <div className="grid sm:grid-cols-2 lg:grid-cols-3">
              <OverviewMetric
                label="Backend CPU"
                value={
                  snapshot
                    ? formatPercent(snapshot.resources.current.cpu.utilizationPercent)
                    : "n/a"
                }
                detail={
                  snapshot ? `Process uptime ${formatDuration(snapshot.uptimeMs)}` : undefined
                }
              />
              <OverviewMetric
                label="RSS / heap"
                value={snapshot ? formatBytes(snapshot.resources.current.memory.rssBytes) : "n/a"}
                detail={
                  snapshot
                    ? `${formatBytes(snapshot.resources.current.memory.heapUsedBytes)} heap used`
                    : undefined
                }
              />
              <OverviewMetric
                label="Event-loop delay"
                value={
                  snapshot?.resources.current.eventLoopDelayMs !== undefined
                    ? formatDuration(snapshot.resources.current.eventLoopDelayMs)
                    : "n/a"
                }
                detail="Measured once for this requested snapshot"
              />
              <OverviewMetric
                label="Providers / terminals"
                value={`${activeProviderCount} enabled providers`}
                detail={`${activeTerminalCount} active terminals`}
              />
              <OverviewMetric
                label="Turn quiescence"
                value={
                  turnQuiescenceAvgMs === null ? "No samples" : formatDuration(turnQuiescenceAvgMs)
                }
                detail="Rolling average"
              />
              <OverviewMetric
                label="Checkpoint duration"
                value={
                  checkpointDurationP95Ms === null
                    ? "No samples"
                    : formatDuration(checkpointDurationP95Ms)
                }
                detail="Rolling p95"
              />
              <OverviewMetric
                label="WebSocket state"
                value={websocketState}
                detail={`${performance?.local.wsReconnectCount ?? 0} reconnects in this server process`}
              />
              <OverviewMetric
                label="Thread snapshot"
                value={
                  latestThreadSnapshotDurationMs === null
                    ? "No samples"
                    : formatDuration(latestThreadSnapshotDurationMs)
                }
                detail={
                  threadSnapshotDurationP95Ms === null
                    ? "Latest successful subscription snapshot"
                    : `${formatDuration(threadSnapshotDurationP95Ms)} rolling p95`
                }
              />
              <OverviewMetric label="Latest failure" value={latestFailure} />
            </div>
          </SettingsSection>

          <SettingsSection title="Why was this slow?">
            <EvidenceRow
              label="Thread snapshot"
              value={
                latestThreadSnapshotDurationMs === null
                  ? "No thread snapshot timing yet"
                  : `${formatDuration(latestThreadSnapshotDurationMs)} latest`
              }
              detail={
                threadSnapshotDurationP95Ms === null
                  ? "Replay duration and payload bytes are not collected because the current transport has no zero-copy attribution hook."
                  : `${formatDuration(threadSnapshotDurationP95Ms)} rolling p95. Replay duration and payload bytes are not collected because the current transport has no zero-copy attribution hook.`
              }
            />
            <EvidenceRow
              label="Queue pressure"
              value={
                performance
                  ? `${performance.queues.runtimeDepthTotal + performance.queues.liveBufferDepthTotal} queued now`
                  : "No snapshot"
              }
              detail={
                performance
                  ? `Largest runtime high-water ${performance.queues.runtimeHighWaterMax}; live-buffer high-water ${performance.queues.liveBufferHighWaterMax}; ${performance.queues.liveBufferOverflowCount} overflows; replay depth ${performance.queues.replayDepthMax}; replay lag ${performance.queues.replayLagMax}; ${performance.queues.providerLogDroppedRecords} provider log records dropped.`
                  : "Runtime and replay queue evidence will appear after the first snapshot."
              }
            />
            <EvidenceRow
              label="Slowest server stage"
              value={
                slowestServerSpan
                  ? `${slowestServerSpan.name} · ${formatDuration(slowestServerSpan.durationMs)}`
                  : "No retained spans"
              }
              detail={
                slowestServerSpan
                  ? `Server span completed ${relativeTimeLabel(slowestServerSpan.endTime, nowMs)}.`
                  : "Tracing has not retained a server stage yet."
              }
            />
            <EvidenceRow
              label="Current slow client RPC"
              value={latestSlowRpc?.tag ?? "No slow RPC acknowledgement in progress"}
              detail={
                latestSlowRpc
                  ? `Exceeded its ${formatDuration(latestSlowRpc.thresholdMs)} acknowledgement threshold; started ${relativeTimeLabel(latestSlowRpc.startedAt, nowMs)}.`
                  : "Only RPCs that cross the existing client acknowledgement threshold appear here."
              }
            />
            <EvidenceRow
              label="Reconnect / resume"
              value={websocketState}
              detail={`${performance?.local.wsReconnectCount ?? 0} server-side reconnects. Per-environment push gaps and recovery state are in the Environments section.`}
            />
            <EvidenceRow
              label="Recent failure"
              value={snapshot?.failures.latest[0]?.message ?? "No retained failures"}
              detail={
                snapshot?.failures.latest[0]
                  ? `${snapshot.failures.latest[0].source} · ${relativeTimeLabel(snapshot.failures.latest[0].occurredAt, nowMs)}`
                  : "No failure evidence is available for the current server process."
              }
            />
            <EvidenceRow
              label="Trace persistence"
              value={
                performance?.traceSink
                  ? `${formatBytes(performance.traceSink.bufferedBytes)} buffered`
                  : "Health unavailable"
              }
              detail={
                performance?.traceSink
                  ? `${formatBytes(performance.traceSink.maxBufferedBytes)} cap; ${performance.traceSink.droppedRecords} dropped records; ${performance.traceSink.writeFailures} write failures; retry delay ${formatDuration(performance.traceSink.retryDelayMs)}.`
                  : "This diagnostics service is not attached to the local trace-file sink."
              }
            />
          </SettingsSection>

          <ResourceHistorySection memorySeries={memorySeries} cpuSeries={cpuSeries} />
          <DiagnosticsSupportSections snapshot={snapshot} />
          {scope === "all" && <NotificationsTestSection />}
          {import.meta.env.DEV && scope !== "node" ? <TierPreviewSection /> : null}
        </>
      )}
    </SettingsPageContainer>
  );
}
