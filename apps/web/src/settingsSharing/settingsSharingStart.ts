import { scheduleIdleTask } from "../lib/idleTask";

/**
 * Starts this app's shared-settings runner once the shell is idle, so a device that comes back
 * online catches up on shared settings while settings are closed. Only this starter is in the
 * app entry; the runner loads in its own chunk.
 */
export function scheduleSettingsSharingStart(): () => void {
  let stopped = false;
  let stop: (() => void) | null = null;
  const cancelIdle = scheduleIdleTask(() => {
    void import("./settingsSharingRuntime")
      .then(({ startSettingsSharing }) => {
        if (!stopped) stop = startSettingsSharing();
      })
      .catch((error: unknown) => console.warn("Shared settings failed to load.", error));
  }, 5_000);
  return () => {
    stopped = true;
    cancelIdle();
    stop?.();
  };
}
