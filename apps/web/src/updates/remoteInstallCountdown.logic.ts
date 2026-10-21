import type { DesktopRemoteInstallState, DesktopUpdateState } from "@ryco/contracts";

export interface RemoteInstallCountdownView {
  readonly title: string;
  readonly description: string;
}

/** The remote install counting down to this app's relaunch, or null. */
export function selectRemoteInstallCountdown(
  state: DesktopUpdateState | null,
): DesktopRemoteInstallState | null {
  const remoteInstall = state?.remoteInstall ?? null;
  return remoteInstall?.phase === "countdown" ? remoteInstall : null;
}

/** Whole seconds until `restartAt`, rounded up and never below zero; 0 without a time. */
export function remoteInstallSecondsLeft(restartAt: string | null, now: number): number {
  if (restartAt === null) return 0;
  const at = Date.parse(restartAt);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** The countdown notice's wording. */
export function describeRemoteInstallCountdown(input: {
  readonly targetVersion: string;
  readonly secondsLeft: number;
}): RemoteInstallCountdownView {
  return {
    title:
      input.secondsLeft > 0
        ? `Ryco restarts in ${input.secondsLeft}s to update to ${input.targetVersion}`
        : `Ryco is restarting to update to ${input.targetVersion}`,
    description:
      "The update was requested from another device. Postpone it to keep working; the download is kept for later.",
  };
}
