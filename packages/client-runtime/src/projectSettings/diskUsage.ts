/**
 * Disk space of a project's checkouts, as the settings view and the map say
 * it. The device measures; these only add figures up and put them in words,
 * so both surfaces state the same number the same way.
 */
import type {
  ProjectId,
  WorkspaceDiskUsage,
  WorkspaceDiskUsageInput,
  WorkspaceDiskUsageResult,
} from "@ryco/contracts";
import { formatBytes } from "@ryco/shared/byteSize";

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

/** How soon to read again while the device is still measuring: quick first, then calmer. */
const DISK_USAGE_POLL_DELAYS_MS = [1_000, 2_000, 4_000] as const;

/** Whether the device is measuring any of these checkouts afresh (`allowStale` answers). */
export const diskUsageStillMeasuring = (result: WorkspaceDiskUsageResult) =>
  result.workspaces.some((workspace) => workspace.measuring === true);

/**
 * Reads a project's disk usage without waiting for the device to measure every checkout: the
 * device answers at once from its last measurements (`allowStale`), marking checkouts it is
 * measuring again, and this reads again until none is. A device that predates `allowStale`
 * waits and answers once, as before. `onResult` gets each answer and whether it is the last.
 * Returns a function that stops reading.
 */
export function readDiskUsageProgressively(input: {
  readonly read: (request: WorkspaceDiskUsageInput) => Promise<WorkspaceDiskUsageResult>;
  readonly projectId: ProjectId;
  /** Measure everything afresh (only the first read asks). */
  readonly refresh: boolean;
  readonly onResult: (result: WorkspaceDiskUsageResult, final: boolean) => void;
  readonly onError: (error: unknown) => void;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const readOnce = (attempt: number) => {
    input
      .read({
        projectId: input.projectId,
        allowStale: true,
        ...(attempt === 0 && input.refresh ? { refresh: true } : {}),
      })
      .then(
        (result) => {
          if (stopped) return;
          const final = !diskUsageStillMeasuring(result);
          input.onResult(result, final);
          if (final) return;
          const delay =
            DISK_USAGE_POLL_DELAYS_MS[Math.min(attempt, DISK_USAGE_POLL_DELAYS_MS.length - 1)]!;
          timer = setTimeout(() => readOnce(attempt + 1), delay);
        },
        (error: unknown) => {
          if (!stopped) input.onError(error);
        },
      );
  };
  readOnce(0);
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
