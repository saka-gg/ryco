import type { DesktopUpdateState } from "@ryco/contracts";
import type { DesktopAppAutomaticUpdateMode } from "@ryco/shared/desktopResourceTelemetry";
import { describe, expect, it } from "vite-plus/test";

import {
  AutomaticAppUpdates,
  backgroundDownloadVersion,
  shouldArmInstallOnQuit,
} from "./automaticAppUpdates.ts";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine.ts";

const AT = "2026-10-31T12:00:00.000Z";

const idle = (): DesktopUpdateState => ({
  ...createInitialDesktopUpdateState("1.0.0", "latest"),
  enabled: true,
  status: "idle",
});

/**
 * The controller over a fake updater: a check finds `offer` (or nothing), a download completes
 * or fails per `downloadFails`, and `autoInstallOnAppQuit` is mirrored the way electron-updater
 * reads it when a download completes. Every effect call is recorded in `calls`.
 */
function harness(options: {
  readonly mode: DesktopAppAutomaticUpdateMode | null;
  offer?: string | null;
  downloadFails?: boolean;
}) {
  let state = idle();
  let installOnQuit = false;
  const calls: string[] = [];
  const pendingChecks: Array<() => void> = [];
  let holdChecks = false;
  const runCheck = () => {
    state = reduceDesktopUpdateStateOnCheckStart(state, AT);
    state =
      options.offer === null || options.offer === undefined
        ? reduceDesktopUpdateStateOnNoUpdate(state, AT)
        : reduceDesktopUpdateStateOnUpdateAvailable(state, options.offer, AT);
  };
  const updates: AutomaticAppUpdates = new AutomaticAppUpdates({
    mode: options.mode,
    state: () => state,
    check: async (reason) => {
      calls.push(`check:${reason}`);
      if (holdChecks) await new Promise<void>((resolve) => pendingChecks.push(resolve));
      runCheck();
    },
    download: async () => {
      if (state.status !== "available") return;
      const version = state.availableVersion;
      calls.push(`download:${version}`);
      // What main's downloadAvailableUpdate does around electron-updater.
      updates.downloadStarting(version);
      state = reduceDesktopUpdateStateOnDownloadStart(state);
      await Promise.resolve();
      if (options.downloadFails) {
        updates.downloadFailed(version);
        state = reduceDesktopUpdateStateOnDownloadFailure(state, "socket hang up");
        return;
      }
      state = reduceDesktopUpdateStateOnDownloadComplete(state, version!);
      updates.downloaded(version!, installOnQuit);
    },
    setInstallOnQuit: (armed) => {
      installOnQuit = armed;
    },
    log: () => undefined,
  });
  const backend = {};
  updates.begin(backend);
  return {
    updates,
    backend,
    calls,
    installOnQuit: () => installOnQuit,
    state: () => state,
    setState: (next: DesktopUpdateState) => {
      state = next;
    },
    holdChecks: () => {
      holdChecks = true;
    },
    releaseChecks: () => {
      holdChecks = false;
      for (const resolve of pendingChecks.splice(0)) resolve();
    },
  };
}

describe("backgroundDownloadVersion", () => {
  const available = reduceDesktopUpdateStateOnUpdateAvailable(idle(), "1.1.0", AT);

  it("downloads an available update only with the policy on and the version not failed", () => {
    const none = new Set<string>();
    expect(
      backgroundDownloadVersion({ automatic: true, state: available, failedVersions: none }),
    ).toBe("1.1.0");
    expect(
      backgroundDownloadVersion({ automatic: false, state: available, failedVersions: none }),
    ).toBeNull();
    expect(
      backgroundDownloadVersion({
        automatic: true,
        state: available,
        failedVersions: new Set(["1.1.0"]),
      }),
    ).toBeNull();
    expect(
      backgroundDownloadVersion({
        automatic: true,
        state: reduceDesktopUpdateStateOnNoUpdate(idle(), AT),
        failedVersions: none,
      }),
    ).toBeNull();
    // The running version is never "downloaded again".
    expect(
      backgroundDownloadVersion({
        automatic: true,
        state: { ...available, availableVersion: "1.0.0" },
        failedVersions: none,
      }),
    ).toBeNull();
    // An updater that is off does nothing, whatever the policy says.
    expect(
      backgroundDownloadVersion({
        automatic: true,
        state: { ...available, enabled: false },
        failedVersions: none,
      }),
    ).toBeNull();
  });

  it("arms the install at quit only where the platform installs unattended", () => {
    const none = new Set<string>();
    expect(
      shouldArmInstallOnQuit({
        mode: "install-on-quit",
        automatic: true,
        version: "1.1.0",
        failedVersions: none,
      }),
    ).toBe(true);
    for (const mode of ["restart", null] as const) {
      expect(
        shouldArmInstallOnQuit({ mode, automatic: true, version: "1.1.0", failedVersions: none }),
      ).toBe(false);
    }
    expect(
      shouldArmInstallOnQuit({
        mode: "install-on-quit",
        automatic: false,
        version: "1.1.0",
        failedVersions: none,
      }),
    ).toBe(false);
    expect(
      shouldArmInstallOnQuit({
        mode: "install-on-quit",
        automatic: true,
        version: "1.1.0",
        failedVersions: new Set(["1.1.0"]),
      }),
    ).toBe(false);
  });
});

describe("AutomaticAppUpdates", () => {
  it("only checks while the policy is off", async () => {
    const app = harness({ mode: "install-on-quit", offer: "1.1.0" });
    await app.updates.runScheduledCheck("startup");
    expect(app.calls).toEqual(["check:startup"]);
    expect(app.state().status).toBe("available");
    expect(app.installOnQuit()).toBe(false);
  });

  it("downloads after a scheduled check with the policy on and installs at quit on Windows and AppImage", async () => {
    const app = harness({ mode: "install-on-quit", offer: "1.1.0" });
    app.updates.report(app.backend, true);
    await app.updates.runScheduledCheck("poll");
    expect(app.calls).toEqual(["check:poll", "download:1.1.0"]);
    expect(app.state().status).toBe("downloaded");
    expect(app.installOnQuit()).toBe(true);
    expect(app.updates.quitInstallVersion()).toBe("1.1.0");
  });

  it("downloads on macOS but never arms the install at quit", async () => {
    const app = harness({ mode: "restart", offer: "1.1.0" });
    const armed: boolean[] = [];
    app.updates.report(app.backend, true);
    await app.updates.runScheduledCheck("startup");
    armed.push(app.installOnQuit());
    // Turning it off and on again changes nothing either.
    app.updates.report(app.backend, false);
    app.updates.report(app.backend, true);
    armed.push(app.installOnQuit());
    expect(app.calls).toEqual(["check:startup", "download:1.1.0"]);
    expect(app.state().status).toBe("downloaded");
    expect(armed).toEqual([false, false]);
    expect(app.updates.quitInstallVersion()).toBeNull();
  });

  it("does not download a version again in the background after its download failed", async () => {
    const app = harness({ mode: "install-on-quit", offer: "1.1.0", downloadFails: true });
    app.updates.report(app.backend, true);
    await app.updates.runScheduledCheck("startup");
    await app.updates.runScheduledCheck("poll");
    expect(app.calls).toEqual(["check:startup", "download:1.1.0", "check:poll"]);
    expect(app.installOnQuit()).toBe(false);
  });

  it("disarms the install at quit when the policy turns off, and re-arms when it turns on", async () => {
    const app = harness({ mode: "install-on-quit", offer: "1.1.0" });
    app.updates.report(app.backend, true);
    await app.updates.runScheduledCheck("startup");
    expect(app.installOnQuit()).toBe(true);
    app.updates.report(app.backend, false);
    expect(app.installOnQuit()).toBe(false);
    expect(app.updates.quitInstallVersion()).toBeNull();
    app.updates.report(app.backend, true);
    expect(app.installOnQuit()).toBe(true);
  });

  it("never arms a download that completed while disarmed: electron-updater added no quit installer", async () => {
    const app = harness({ mode: "install-on-quit", offer: "1.1.0" });
    await app.updates.runScheduledCheck("startup");
    // A person downloads it while the policy is off.
    app.updates.downloadStarting("1.1.0");
    app.setState(reduceDesktopUpdateStateOnDownloadComplete(app.state(), "1.1.0"));
    app.updates.downloaded("1.1.0", app.installOnQuit());
    app.updates.report(app.backend, true);
    expect(app.installOnQuit()).toBe(false);
    expect(app.updates.quitInstallVersion()).toBeNull();
  });

  it("never arms a later download that completed while disarmed, though an earlier one was armed", async () => {
    const app = harness({ mode: "install-on-quit", offer: "1.1.0" });
    app.updates.report(app.backend, true);
    await app.updates.runScheduledCheck("startup");
    expect(app.updates.quitInstallVersion()).toBe("1.1.0");
    // electron-updater's quit installer stays; it would install whatever was downloaded last.
    app.updates.report(app.backend, false);
    // A person downloads a newer version while the policy is off.
    app.updates.downloadStarting("1.2.0");
    app.setState(reduceDesktopUpdateStateOnDownloadComplete(app.state(), "1.2.0"));
    app.updates.downloaded("1.2.0", app.installOnQuit());
    app.updates.report(app.backend, true);
    expect(app.installOnQuit()).toBe(false);
    expect(app.updates.quitInstallVersion()).toBeNull();
    expect(app.updates.quitting({ exitCode: 0, sessionEnding: false })).toBeNull();
  });

  it("installs at a normal quit, but never at one during a system shutdown or logout", async () => {
    const app = harness({ mode: "install-on-quit", offer: "1.1.0" });
    app.updates.report(app.backend, true);
    await app.updates.runScheduledCheck("startup");
    // A failed exit installs nothing (electron-updater checks it too) and changes nothing.
    expect(app.updates.quitting({ exitCode: 1, sessionEnding: false })).toBeNull();
    expect(app.installOnQuit()).toBe(true);
    expect(app.updates.quitting({ exitCode: 0, sessionEnding: false })).toBe("1.1.0");
    expect(app.installOnQuit()).toBe(true);
    // The session ends (Windows logoff, a Linux shutdown's SIGTERM): disarmed before
    // electron-updater's quit installer reads it, so the update waits for a later quit.
    expect(app.updates.quitting({ exitCode: 0, sessionEnding: true })).toBeNull();
    expect(app.installOnQuit()).toBe(false);
    expect(app.updates.quitInstallVersion()).toBeNull();
  });

  it("disarms after a failed install and never arms that version again", async () => {
    const app = harness({ mode: "install-on-quit", offer: "1.1.0" });
    app.updates.report(app.backend, true);
    await app.updates.runScheduledCheck("startup");
    app.updates.installFailed("1.1.0");
    expect(app.installOnQuit()).toBe(false);
    app.updates.report(app.backend, false);
    app.updates.report(app.backend, true);
    expect(app.installOnQuit()).toBe(false);
  });

  it("skips a version the last run failed to install (from its install record)", async () => {
    const app = harness({ mode: "install-on-quit", offer: "1.1.0" });
    app.updates.installFailed("1.1.0");
    app.updates.report(app.backend, true);
    await app.updates.runScheduledCheck("startup");
    expect(app.calls).toEqual(["check:startup"]);
  });

  it("holds one reservation over a check and its download: a scheduled check meanwhile joins it", async () => {
    const app = harness({ mode: "install-on-quit", offer: "1.1.0" });
    app.updates.report(app.backend, true);
    app.holdChecks();
    const first = app.updates.runScheduledCheck("startup");
    const second = app.updates.runScheduledCheck("poll");
    expect(second).toBe(first);
    expect(app.updates.reservation).toBe(first);
    app.releaseChecks();
    await Promise.all([first, second]);
    expect(app.calls).toEqual(["check:startup", "download:1.1.0"]);
    expect(app.updates.reservation).toBeNull();
  });

  it("takes the policy only from the current backend, and drops it when that backend exits", async () => {
    const app = harness({ mode: "install-on-quit", offer: "1.1.0" });
    const stranger = {};
    app.updates.report(stranger, true);
    expect(app.updates.automatic).toBe(false);
    app.updates.report(app.backend, true);
    await app.updates.runScheduledCheck("startup");
    expect(app.installOnQuit()).toBe(true);

    // A replaced generation's late report changes nothing.
    const next = {};
    app.updates.end(app.backend, { quitting: false });
    expect(app.updates.automatic).toBe(false);
    expect(app.installOnQuit()).toBe(false);
    app.updates.begin(next);
    app.updates.report(app.backend, true);
    expect(app.updates.automatic).toBe(false);
    app.updates.report(next, true);
    expect(app.installOnQuit()).toBe(true);
  });

  it("turns the policy off when a new backend starts, until that backend reports", async () => {
    const app = harness({ mode: "install-on-quit", offer: "1.1.0" });
    app.updates.report(app.backend, true);
    await app.updates.runScheduledCheck("startup");
    expect(app.installOnQuit()).toBe(true);
    // The next backend starts before the old one's exit was seen.
    const next = {};
    app.updates.begin(next);
    expect(app.updates.automatic).toBe(false);
    expect(app.installOnQuit()).toBe(false);
    app.updates.report(next, true);
    expect(app.installOnQuit()).toBe(true);
  });

  it("keeps the install at quit when the quit itself stopped the backend", async () => {
    const app = harness({ mode: "install-on-quit", offer: "1.1.0" });
    app.updates.report(app.backend, true);
    await app.updates.runScheduledCheck("startup");
    app.updates.end(app.backend, { quitting: true });
    expect(app.installOnQuit()).toBe(true);
    expect(app.updates.quitInstallVersion()).toBe("1.1.0");
  });

  it("disarms for a relaunch and stays disarmed", async () => {
    const app = harness({ mode: "install-on-quit", offer: "1.1.0" });
    app.updates.report(app.backend, true);
    await app.updates.runScheduledCheck("startup");
    app.updates.relaunching();
    app.updates.report(app.backend, true);
    expect(app.installOnQuit()).toBe(false);
    expect(app.updates.quitInstallVersion()).toBeNull();
  });
});
