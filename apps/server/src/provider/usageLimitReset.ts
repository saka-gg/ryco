/**
 * Turns provider rate-limit windows into one provider-agnostic usage-limit state:
 * whether the account is exhausted and when work can continue. Shared by the Claude
 * and Codex adapters and the usage-limit recovery worker.
 *
 * @module usageLimitReset
 */
import type { ServerProviderRateLimits, UsageLimitState } from "@ryco/contracts";

export interface UsageWindowObservation {
  readonly exhausted: boolean;
  /** Epoch milliseconds; null when the provider did not say. */
  readonly resetAtMs: number | null;
}

/** Larger values are not representable as a Date. */
const MAX_DATE_MS = 8.64e15;

export function isRepresentableEpochMs(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) < MAX_DATE_MS;
}

/**
 * All exhausted windows must reset before work can continue, so the latest reset wins.
 * `resetAt` is null when any exhausted window's reset is unknown. With `nowMs`, a window
 * whose known reset already passed no longer counts as exhausted.
 */
export function usageLimitStateFromWindows(
  windows: ReadonlyArray<UsageWindowObservation>,
  nowMs?: number,
): UsageLimitState {
  let exhausted = false;
  let unknownReset = false;
  let latestResetMs: number | null = null;
  for (const window of windows) {
    if (!window.exhausted) continue;
    const resetMs =
      window.resetAtMs !== null && isRepresentableEpochMs(window.resetAtMs)
        ? window.resetAtMs
        : null;
    if (resetMs !== null && nowMs !== undefined && resetMs <= nowMs) continue;
    exhausted = true;
    if (resetMs === null) {
      unknownReset = true;
    } else if (latestResetMs === null || resetMs > latestResetMs) {
      latestResetMs = resetMs;
    }
  }
  return {
    exhausted,
    resetAt:
      exhausted && !unknownReset && latestResetMs !== null
        ? new Date(latestResetMs).toISOString()
        : null,
  };
}

/** Reads a registry usage probe (`ServerProvider.rateLimits`, resets in epoch seconds). */
export function usageLimitStateFromServerRateLimits(
  rateLimits: ServerProviderRateLimits | undefined,
  nowMs: number,
): UsageLimitState {
  const windows: UsageWindowObservation[] = [];
  for (const window of [rateLimits?.primary, rateLimits?.secondary, rateLimits?.tertiary]) {
    if (!window || !Number.isFinite(window.usedPercent)) continue;
    windows.push({
      exhausted: window.usedPercent >= 100,
      resetAtMs:
        window.resetsAt !== undefined && Number.isFinite(window.resetsAt)
          ? window.resetsAt * 1000
          : null,
    });
  }
  return usageLimitStateFromWindows(windows, nowMs);
}
