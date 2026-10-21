/**
 * nodeUpdate/desktopApp - Reads a desktop app's updater report as node update state.
 *
 * A desktop backend does not update itself: its Electron app owns the updater and
 * reports over the backend pipe (see `desktopAppUpdateBridge`). These helpers turn that
 * report into the newest known release and map the app's progress on a remote install
 * request onto the run the client follows.
 *
 * @module nodeUpdate/desktopApp
 */
import type { NodeUpdateRun } from "@ryco/contracts";
import type { DesktopAppUpdateSnapshot } from "@ryco/shared/desktopResourceTelemetry";

/** Trimmed text, or `null` for none. */
export function presentText(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/** An ISO timestamp the app reported, or `null` when it is not one. */
export function presentIsoTime(value: string | null | undefined): string | null {
  const text = presentText(value);
  if (text === null) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The newest release the app knows about, or `null` before its first check. */
export function desktopLatestVersion(snapshot: DesktopAppUpdateSnapshot): string | null {
  return (
    presentText(snapshot.availableVersion) ??
    presentText(snapshot.downloadedVersion) ??
    (snapshot.status === "up-to-date" ? presentText(snapshot.currentVersion) : null)
  );
}

const clampPercent = (value: number | null): number | null =>
  value === null || !Number.isFinite(value) ? null : Math.min(100, Math.max(0, value));

/**
 * `run` after the app's report on it, or `null` when the report is not about this run
 * or changes nothing. A run is matched by its request id, so a backend that restarted
 * while the app was still counting down picks the countdown up again.
 */
export function applyDesktopRemoteInstall(
  run: NodeUpdateRun,
  snapshot: DesktopAppUpdateSnapshot,
  nowIso: string,
): NodeUpdateRun | null {
  const remote = snapshot.remoteInstall;
  if (remote === null || run.requestId === null || remote.requestId !== run.requestId) return null;
  if (run.status === "succeeded") return null;
  const base: NodeUpdateRun = {
    ...run,
    targetVersion: run.targetVersion ?? presentText(remote.targetVersion),
    finishedAt: null,
    restartAt: null,
    progressPercent: null,
    message: null,
    output: null,
  };
  let next: NodeUpdateRun;
  switch (remote.phase) {
    case "downloading":
      next = {
        ...base,
        status: "preparing",
        progressPercent: clampPercent(snapshot.downloadPercent),
      };
      break;
    case "countdown":
      next = { ...base, status: "waiting", restartAt: presentIsoTime(remote.restartAt) };
      break;
    case "installing":
      next = { ...base, status: "restarting" };
      break;
    case "postponed":
      next = { ...base, status: "postponed", message: presentText(remote.message) };
      break;
    case "failed":
      if (run.status === "failed") return null;
      next = {
        ...base,
        status: "failed",
        finishedAt: nowIso,
        message: presentText(remote.message) ?? "The desktop app could not install the update.",
      };
      break;
  }
  return JSON.stringify(next) === JSON.stringify(run) ? null : next;
}
