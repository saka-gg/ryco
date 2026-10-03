import type { SourceControlRefreshMode } from "@ryco/contracts/settings";

export const POST_PUSH_DISCOVERY_WINDOW_MS = 90_000;
export const AUTOMATIC_DISCOVERY_REFRESH_MS = 10_000;
export const REDUCED_DISCOVERY_REFRESH_MS = 30_000;
export const AUTOMATIC_ACTIVE_REFRESH_MS = 30_000;
export const REDUCED_ACTIVE_REFRESH_MS = 60_000;
export const SOURCE_CONTROL_MAX_BACKOFF_MS = 5 * 60_000;

export type SourceControlRefreshPhase = "discovery" | "active" | "settled";

export function resolveSourceControlRefreshDelay(input: {
  readonly mode: SourceControlRefreshMode;
  readonly phase: SourceControlRefreshPhase;
  readonly nowMs?: number;
  readonly discoveryExpiresAtMs?: number | null;
}): number | false {
  if (input.mode === "manual" || input.phase === "settled") return false;
  if (
    input.phase === "discovery" &&
    input.discoveryExpiresAtMs != null &&
    (input.nowMs ?? Date.now()) >= input.discoveryExpiresAtMs
  ) {
    return false;
  }
  if (input.phase === "discovery") {
    return input.mode === "reduced" ? REDUCED_DISCOVERY_REFRESH_MS : AUTOMATIC_DISCOVERY_REFRESH_MS;
  }
  return input.mode === "reduced" ? REDUCED_ACTIVE_REFRESH_MS : AUTOMATIC_ACTIVE_REFRESH_MS;
}

export function shouldRefreshSourceControlOnLifecycle(input: {
  readonly mode: SourceControlRefreshMode;
  readonly hasData: boolean;
  readonly invalidated: boolean;
  readonly lastFetchedAtMs: number;
  readonly staleTimeMs: number;
  readonly nowMs?: number;
}): boolean {
  if (input.mode === "manual") return false;
  if (!input.hasData || input.invalidated) return true;
  return (input.nowMs ?? Date.now()) - input.lastFetchedAtMs >= input.staleTimeMs;
}

export function resolveSourceControlFailureDelay(input: {
  readonly baseDelayMs: number;
  readonly consecutiveFailures: number;
  readonly retryAfterMs?: number | null;
}): number {
  if (input.retryAfterMs != null && Number.isFinite(input.retryAfterMs)) {
    return Math.min(SOURCE_CONTROL_MAX_BACKOFF_MS, Math.max(1_000, input.retryAfterMs));
  }
  const exponent = Math.max(0, Math.min(8, Math.floor(input.consecutiveFailures) - 1));
  return Math.min(
    SOURCE_CONTROL_MAX_BACKOFF_MS,
    Math.max(1_000, input.baseDelayMs) * 2 ** exponent,
  );
}

// ---------------------------------------------------------------------------
// Workflow run jobs
//
// Each run's jobs poll on their own evidence: the runs list says the run is
// not completed, or the cached jobs still show unfinished work. Every running
// workflow is therefore followed (not just one "active" run), and a run that
// finishes gets one final read because its cached jobs still show it running.
// ---------------------------------------------------------------------------

function isCompletedWorkflowStatus(status: string): boolean {
  return status.trim().toLowerCase() === "completed";
}

function hasUnfinishedJobs(jobs: ReadonlyArray<{ readonly status: string }>): boolean {
  return jobs.some((job) => !isCompletedWorkflowStatus(job.status));
}

export function resolveWorkflowRunJobsPhase(input: {
  /** The runs list reports the run as not completed. */
  readonly runIncomplete: boolean;
  /** Cached jobs of the run; null before the first read. */
  readonly jobs: ReadonlyArray<{ readonly status: string }> | null;
}): Extract<SourceControlRefreshPhase, "active" | "settled"> {
  return input.runIncomplete || (input.jobs !== null && hasUnfinishedJobs(input.jobs))
    ? "active"
    : "settled";
}

/**
 * True when the cached jobs contradict the run's status after it changed: a
 * finished run whose jobs still show work (take the final read now), or a
 * (re)started run whose jobs all look finished (start following it now).
 */
export function workflowRunJobsContradictRun(input: {
  readonly runIncomplete: boolean;
  readonly jobs: ReadonlyArray<{ readonly status: string }>;
}): boolean {
  return input.runIncomplete !== hasUnfinishedJobs(input.jobs);
}
