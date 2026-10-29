import type { DesktopUpdateState } from "@ryco/contracts";

/** This desktop app's updater with 0.1.36 found and not yet downloaded. */
export function desktopUpdateState(
  overrides: Partial<DesktopUpdateState> = {},
): DesktopUpdateState {
  return {
    enabled: true,
    status: "available",
    channel: "latest",
    currentVersion: "0.1.35",
    availableVersion: "0.1.36",
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: "2026-10-21T00:00:00.000Z",
    message: null,
    errorContext: null,
    canRetry: false,
    ...overrides,
  };
}
