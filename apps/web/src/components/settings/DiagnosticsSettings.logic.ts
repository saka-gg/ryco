import type {
  DiagnosticsDurationBucket,
  DiagnosticsResourceSample,
  DiagnosticsSnapshot,
  DiagnosticsSpanStatus,
  DiagnosticsSpanNameSummary,
} from "@ryco/contracts";
import { formatBytes } from "@ryco/shared/byteSize";

export { formatBytes };

export function isDiagnosticsSpanFailure(status: DiagnosticsSpanStatus): boolean {
  return status === "failure" || status === "error";
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 ms";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

export function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "n/a";
  return `${Math.max(0, value).toFixed(1)}%`;
}

export function relativeTimeLabel(iso: string, nowMs = Date.now()): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return iso;
  const elapsedMs = Math.max(0, nowMs - timestamp);
  if (elapsedMs < 1_000) return "just now";
  if (elapsedMs < 60_000) return `${Math.floor(elapsedMs / 1_000)}s ago`;
  if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)}m ago`;
  if (elapsedMs < 86_400_000) return `${Math.floor(elapsedMs / 3_600_000)}h ago`;
  return `${Math.floor(elapsedMs / 86_400_000)}d ago`;
}

export function resourceMemorySeries(samples: ReadonlyArray<DiagnosticsResourceSample>) {
  return samples.map((sample) => ({
    label: sample.sampledAt,
    value: sample.memory.rssBytes,
  }));
}

export function resourceCpuSeries(samples: ReadonlyArray<DiagnosticsResourceSample>) {
  return samples.map((sample) => ({
    label: sample.sampledAt,
    value: sample.cpu.utilizationPercent ?? 0,
  }));
}

export function durationBucketSeries(buckets: ReadonlyArray<DiagnosticsDurationBucket>) {
  return buckets.map((bucket) => ({
    label: bucket.label,
    value: bucket.count,
  }));
}

export function topSpanSeries(spans: ReadonlyArray<DiagnosticsSpanNameSummary>) {
  return spans.slice(0, 8).map((span) => ({
    label: span.name,
    value: span.count,
  }));
}

export function latestFailureLabel(snapshot: DiagnosticsSnapshot): string {
  const latest = snapshot.failures.latest[0];
  return latest ? latest.message : "No failures";
}
