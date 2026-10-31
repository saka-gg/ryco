/**
 * automaticAppUpdates - The desktop app's unattended updates.
 *
 * The node's owner turns automatic updates on in the node's settings (`automaticUpdates`, with
 * update checks on; never on a dev server). The backend this app launched reports that as an
 * `app-update-policy` frame on their private pipe. Nothing else can set it: no renderer IPC
 * carries it, a report from a backend generation that is not the current one is dropped, and it
 * turns off when the backend exits (until the next one reports), so it fails closed.
 *
 * While it is on:
 * - The startup and poll checks also download the update they find. A check and its download
 *   hold one reservation: a scheduled check that comes while one runs joins it.
 * - Where the platform allows (`install-on-quit`: Windows NSIS, Linux AppImage), electron-updater
 *   installs the downloaded update when the app quits normally (`autoInstallOnAppQuit`), silently
 *   and without starting the app again. On macOS (`restart`) the download waits for the person's
 *   Restart: Squirrel.Mac stages an update armed for quit irreversibly.
 * - A version whose download or install failed, here or (per the install record) in an earlier
 *   run, is not downloaded or armed again in the background. The person can still install it.
 *
 * electron-updater registers its quit installer when a download completes, and only while
 * armed, so a download is armed before it starts. Turning the policy off, a failed install and a
 * relaunch disarm it. The checks themselves are unchanged: same channel, no downgrade, and the
 * updater's signature and checksum verification.
 *
 * Pure apart from the injected effects, so the flow is testable without Electron.
 *
 * @module automaticAppUpdates
 */
import type { DesktopUpdateState } from "@ryco/contracts";
import type { DesktopAppAutomaticUpdateMode } from "@ryco/shared/desktopResourceTelemetry";

export type ScheduledUpdateCheckReason = "startup" | "poll";

export interface AutomaticAppUpdatesEffects {
  /** What this platform does with a downloaded update; `null` when the app cannot update. */
  readonly mode: DesktopAppAutomaticUpdateMode | null;
  /** The updater's state now. */
  readonly state: () => DesktopUpdateState;
  /** Checks the feed, or joins the check already running; resolves with its outcome in the state. */
  readonly check: (reason: ScheduledUpdateCheckReason) => Promise<void>;
  /** Downloads the available update, or joins the running download; resolves once it settled. */
  readonly download: () => Promise<void>;
  /** electron-updater's `autoInstallOnAppQuit`. */
  readonly setInstallOnQuit: (armed: boolean) => void;
  readonly log: (line: string) => void;
}

/**
 * The version a scheduled check should download in the background, or `null`: only with the
 * policy on, an update available (the check already kept to this app's channel and refused older
 * versions), and that version not failed before.
 */
export function backgroundDownloadVersion(input: {
  readonly automatic: boolean;
  readonly state: DesktopUpdateState;
  readonly failedVersions: ReadonlySet<string>;
}): string | null {
  const { state } = input;
  const version = state.availableVersion;
  if (!input.automatic || !state.enabled || state.status !== "available" || version === null) {
    return null;
  }
  if (version === state.currentVersion || input.failedVersions.has(version)) return null;
  return version;
}

/** Whether electron-updater may install `version` when the app quits. */
export function shouldArmInstallOnQuit(input: {
  readonly mode: DesktopAppAutomaticUpdateMode | null;
  readonly automatic: boolean;
  readonly version: string | null;
  readonly failedVersions: ReadonlySet<string>;
}): boolean {
  return (
    input.mode === "install-on-quit" &&
    input.automatic &&
    input.version !== null &&
    !input.failedVersions.has(input.version)
  );
}

export class AutomaticAppUpdates {
  readonly #effects: AutomaticAppUpdatesEffects;
  #child: object | null = null;
  #automatic = false;
  readonly #failed = new Set<string>();
  #reservation: Promise<void> | null = null;
  #armed = false;
  // electron-updater added its quit installer: a download completed while armed. It stays.
  #installerRegistered = false;
  #relaunching = false;

  constructor(effects: AutomaticAppUpdatesEffects) {
    this.#effects = effects;
  }

  /** The policy the current backend reported; off until it reports. */
  get automatic(): boolean {
    return this.#automatic;
  }

  /** `child` is the backend now; only its reports count. */
  begin(child: object): void {
    this.#child = child;
  }

  /** The backend's policy frame; dropped unless `child` is the current backend. */
  report(child: object, automatic: boolean): void {
    if (child !== this.#child) return;
    this.#setPolicy(automatic);
  }

  /**
   * `child` exited. Unless the app is quitting, the policy turns off until the next backend
   * reports. While quitting it stands: the quit stops the backend before the install at quit.
   */
  end(child: object, options: { readonly quitting: boolean }): void {
    if (child !== this.#child) return;
    this.#child = null;
    if (!options.quitting) this.#setPolicy(false);
  }

  /** The scheduled check and its download while they run, else `null`. */
  get reservation(): Promise<void> | null {
    return this.#reservation;
  }

  /**
   * A startup or poll check. With the policy on it also downloads what it finds, under the same
   * reservation; a scheduled check that comes meanwhile joins it.
   */
  runScheduledCheck(reason: ScheduledUpdateCheckReason): Promise<void> {
    if (this.#reservation !== null) return this.#reservation;
    const reservation = this.#runScheduledCheck(reason)
      .catch((error: unknown) => {
        this.#effects.log(`Scheduled update check (${reason}) failed: ${String(error)}`);
      })
      .finally(() => {
        if (this.#reservation === reservation) this.#reservation = null;
      });
    this.#reservation = reservation;
    return reservation;
  }

  /** Any download is about to start; arms the install at quit for `version` when allowed. */
  downloadStarting(version: string | null): void {
    this.#setArmed(this.#shouldArm(version));
  }

  /** A download completed; `armed` is `autoInstallOnAppQuit` at that moment. */
  downloaded(armed: boolean): void {
    if (armed) this.#installerRegistered = true;
  }

  /** A download of `version` failed: not downloaded again in the background. */
  downloadFailed(version: string | null): void {
    if (version !== null) this.#failed.add(version);
    this.#setArmed(false);
  }

  /** An install of `version` failed, here or in an earlier run: never armed again. */
  installFailed(version: string | null): void {
    if (version !== null) this.#failed.add(version);
    this.#setArmed(false);
  }

  /** The app relaunches (`app.exit` still emits `quit`): nothing installs under the new app. */
  relaunching(): void {
    this.#relaunching = true;
    this.#setArmed(false);
  }

  /** The version electron-updater installs when the app quits now, or `null`. */
  quitInstallVersion(): string | null {
    return this.#armed && this.#installerRegistered
      ? this.#effects.state().downloadedVersion
      : null;
  }

  async #runScheduledCheck(reason: ScheduledUpdateCheckReason): Promise<void> {
    await this.#effects.check(reason);
    const version = backgroundDownloadVersion({
      automatic: this.#automatic,
      state: this.#effects.state(),
      failedVersions: this.#failed,
    });
    if (version === null) return;
    this.#effects.log(`Downloading ${version} in the background (${reason}).`);
    await this.#effects.download();
  }

  #setPolicy(automatic: boolean): void {
    if (automatic !== this.#automatic) {
      this.#effects.log(`Automatic updates ${automatic ? "on" : "off"}.`);
    }
    this.#automatic = automatic;
    const state = this.#effects.state();
    if (state.status === "downloading") {
      // electron-updater adds its quit installer when this download completes, if armed then.
      this.#setArmed(this.#shouldArm(state.availableVersion));
      return;
    }
    // Re-arming a finished download helps only where electron-updater added its installer.
    this.#setArmed(this.#installerRegistered && this.#shouldArm(state.downloadedVersion));
  }

  #shouldArm(version: string | null): boolean {
    return (
      !this.#relaunching &&
      shouldArmInstallOnQuit({
        mode: this.#effects.mode,
        automatic: this.#automatic,
        version,
        failedVersions: this.#failed,
      })
    );
  }

  #setArmed(armed: boolean): void {
    if (armed !== this.#armed) {
      this.#effects.log(armed ? "Installing the update when Ryco quits." : "No install at quit.");
    }
    this.#armed = armed;
    this.#effects.setInstallOnQuit(armed);
  }
}
