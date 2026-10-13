/**
 * Disk space of a project's checkouts, as the settings view and the map say
 * it. The device measures; these only add figures up and put them in words,
 * so both surfaces state the same number the same way.
 */
import type { WorkspaceDiskUsage } from "@ryco/contracts";

import { formatBytes } from "../../settings/DiagnosticsSettings.logic";

/** Space on a device's disk; `partial` makes `bytes` a lower bound. */
export interface DiskSize {
  readonly bytes: number;
  readonly partial: boolean;
}

/** What a reader knows about one checkout's disk usage. */
export type DiskUsageReading =
  | { readonly status: "unavailable" }
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly workspaces: readonly WorkspaceDiskUsage[];
      /** A newer measurement is running; these are the previous results. */
      readonly refreshing: boolean;
    };

export const diskUsageMeasuring = (reading: DiskUsageReading) =>
  reading.status === "loading" || (reading.status === "ready" && reading.refreshing);

/** One measured workspace; null when the device could not measure it. */
export const diskSizeOf = (usage: WorkspaceDiskUsage): DiskSize | null =>
  usage.bytes === null ? null : { bytes: usage.bytes, partial: usage.partial };

/**
 * The space of several checkouts together, archived ones included (they are
 * still on disk); removed checkouts take none. An unmeasured checkout makes
 * the sum a lower bound; null when nothing is measured yet.
 */
export function sumDiskSizes(
  workspaces: ReadonlyArray<{
    readonly disk: DiskSize | null;
    readonly checkoutRemoved?: boolean;
  }>,
): DiskSize | null {
  let bytes = 0;
  let partial = false;
  let measured = false;
  for (const workspace of workspaces) {
    if (workspace.checkoutRemoved) continue;
    if (!workspace.disk) {
      partial = true;
      continue;
    }
    measured = true;
    bytes += workspace.disk.bytes;
    partial ||= workspace.disk.partial;
  }
  return measured ? { bytes, partial } : null;
}

/** Everything a device reported for one checkout (it reports only checkouts on disk). */
export const readingTotal = (reading: DiskUsageReading): DiskSize | null =>
  reading.status === "ready"
    ? sumDiskSizes(reading.workspaces.map((usage) => ({ disk: diskSizeOf(usage) })))
    : null;

/** "1.4 GB", or "≥ 1.4 GB" for a lower bound: compact, for cards and rows. */
export function formatDiskSize(size: DiskSize): string {
  return `${size.partial ? "≥ " : ""}${formatBytes(size.bytes)}`;
}

/** "1.4 GB", or "At least 1.4 GB" for a lower bound: for sentences and facts. */
export const diskSizeText = (size: DiskSize) =>
  `${size.partial ? "At least " : ""}${formatBytes(size.bytes)}`;

/** A disk figure in words, or why there is none ("Measuring…", "Unavailable"). */
export function diskText(size: DiskSize | null, reading: DiskUsageReading): string {
  if (size) return diskSizeText(size);
  if (diskUsageMeasuring(reading)) return "Measuring…";
  return reading.status === "unavailable" ? "Unavailable" : "—";
}

export const LOWER_BOUND_NOTE = "At least: some checkouts could not be measured completely.";
