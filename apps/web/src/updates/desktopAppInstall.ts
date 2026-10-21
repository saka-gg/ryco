import type { DesktopBridge, DesktopUpdateState } from "@ryco/contracts";

/** The desktop bridge's updater, as the install below uses it. */
export type DesktopAppInstallBridge = Pick<
  DesktopBridge,
  "getUpdateState" | "checkForUpdate" | "downloadUpdate" | "installUpdate" | "onUpdateState"
>;

/** How long the install waits for a check or a download already running. */
export const DESKTOP_APP_INSTALL_WAIT_MS = 30 * 60_000;

export interface InstallDesktopAppUpdateOptions {
  /** Every updater state seen on the way, for the renderer's copy. */
  readonly onState?: (state: DesktopUpdateState) => void;
  /** Defaults to {@link DESKTOP_APP_INSTALL_WAIT_MS}. */
  readonly waitMs?: number;
}

const BUSY: ReadonlySet<DesktopUpdateState["status"]> = new Set(["checking", "downloading"]);

/**
 * The updater's state once it is no longer checking or downloading, or null
 * when that takes longer than `waitMs`. Subscribes before reading, so a change
 * between the two is never missed.
 */
function waitUntilSettled(
  bridge: DesktopAppInstallBridge,
  waitMs: number,
  onState: (state: DesktopUpdateState) => void,
): Promise<DesktopUpdateState | null> {
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe: (() => void) | null = null;
    const finish = (state: DesktopUpdateState | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(state);
    };
    const consider = (state: DesktopUpdateState) => {
      onState(state);
      if (!BUSY.has(state.status)) finish(state);
    };
    const timer = setTimeout(() => finish(null), waitMs);
    unsubscribe = bridge.onUpdateState(consider);
    if (done) unsubscribe();
    bridge.getUpdateState().then(consider, () => finish(null));
  });
}

/**
 * Downloads this desktop app's update unless it is already downloaded, then
 * installs it. True once the app accepted the install: it quits and relaunches
 * on the new release, so the returned promise may never settle. False on any
 * failure, including an updater that finds nothing newer.
 */
export async function installDesktopAppUpdate(
  bridge: DesktopAppInstallBridge,
  options: InstallDesktopAppUpdateOptions = {},
): Promise<boolean> {
  const report = (state: DesktopUpdateState) => {
    try {
      options.onState?.(state);
    } catch {
      // A failing observer must not stop the install.
    }
    return state;
  };
  const waitMs = options.waitMs ?? DESKTOP_APP_INSTALL_WAIT_MS;
  const settle = async (state: DesktopUpdateState): Promise<DesktopUpdateState | null> =>
    BUSY.has(state.status) ? waitUntilSettled(bridge, waitMs, report) : state;
  try {
    let state: DesktopUpdateState | null = await settle(report(await bridge.getUpdateState()));
    if (state === null || !state.enabled) return false;
    if (state.status !== "available" && state.status !== "downloaded") {
      // Nothing found yet (never checked, up to date, or a failed attempt): ask once.
      state = await settle(report((await bridge.checkForUpdate()).state));
      if (state === null) return false;
    }
    if (state.status === "available") {
      const download = await bridge.downloadUpdate();
      state = await settle(report(download.state));
      if (state === null) return false;
    }
    if (state.status !== "downloaded") return false;
    const install = await bridge.installUpdate();
    report(install.state);
    return install.accepted;
  } catch {
    return false;
  }
}
