import type { DesktopRemoteInstallState, DesktopUpdateState } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createRemoteAppInstaller,
  isRemoteInstallActive,
  parseRemoteInstallResponse,
  reduceRemoteInstall,
  REMOTE_INSTALL_COUNTDOWN_MS,
  type RemoteAppInstallerEffects,
} from "./remoteAppInstall.ts";
import { createInitialDesktopUpdateState } from "./updateMachine.ts";

const NOW = Date.parse("2026-10-21T10:00:00.000Z");

function harness(
  initial: Partial<DesktopUpdateState> = {},
  overrides: Partial<RemoteAppInstallerEffects> = {},
) {
  let update: DesktopUpdateState = {
    ...createInitialDesktopUpdateState("1.0.0", "latest"),
    enabled: true,
    status: "idle",
    ...initial,
  };
  const published: Array<DesktopRemoteInstallState | null> = [];
  const refused: DesktopRemoteInstallState[] = [];
  const effects = {
    updateState: () => update,
    publish: (remoteInstall: DesktopRemoteInstallState | null) => {
      published.push(remoteInstall);
    },
    reportRefused: (state: DesktopRemoteInstallState) => {
      refused.push(state);
    },
    prepareUpdater: vi.fn(async (): Promise<string | null> => null),
    checkForUpdate: vi.fn(async () => {
      update = { ...update, status: "available", availableVersion: "1.1.0" };
    }),
    downloadUpdate: vi.fn(async () => {
      update = {
        ...update,
        status: "downloaded",
        downloadedVersion: update.availableVersion,
        downloadPercent: 100,
      };
    }),
    installUpdate: vi.fn(async (): Promise<string | null> => null),
    countdownStarted: vi.fn(),
    now: () => NOW,
    schedule: (callback: () => void, delayMs: number) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
    ...overrides,
  };
  const installer = createRemoteAppInstaller(effects);
  return {
    installer,
    effects,
    published,
    refused,
    phases: () => published.map((state) => state?.phase ?? null),
    setUpdate: (patch: Partial<DesktopUpdateState>) => {
      update = { ...update, ...patch };
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("remote app install", () => {
  it("checks, downloads, counts down and installs at the deadline", async () => {
    const { installer, effects, phases } = harness();

    await installer.request("req-1", "1.1.0");

    expect(effects.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(effects.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(installer.current()).toEqual({
      requestId: "req-1",
      targetVersion: "1.1.0",
      phase: "countdown",
      restartAt: new Date(NOW + REMOTE_INSTALL_COUNTDOWN_MS).toISOString(),
      message: null,
    });
    expect(effects.countdownStarted).toHaveBeenCalledWith(installer.current());
    expect(installer.isActive()).toBe(true);

    await vi.advanceTimersByTimeAsync(REMOTE_INSTALL_COUNTDOWN_MS - 1);
    expect(effects.installUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(effects.installUpdate).toHaveBeenCalledTimes(1);
    expect(installer.current()).toMatchObject({ phase: "installing", restartAt: null });
    expect(phases()).toEqual(["downloading", "countdown", "installing"]);
  });

  it("installs right away on 'now' and cancels the countdown", async () => {
    const { installer, effects } = harness();
    await installer.request("req-1", "1.1.0");

    expect(installer.respond("now")).toMatchObject({ phase: "installing" });
    await vi.advanceTimersByTimeAsync(REMOTE_INSTALL_COUNTDOWN_MS * 2);

    expect(effects.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("postpones without installing, keeps the download, and installs on a later 'now'", async () => {
    const { installer, effects } = harness();
    await installer.request("req-1", "1.1.0");

    expect(installer.respond("postpone")).toMatchObject({ phase: "postponed", restartAt: null });
    expect(installer.isActive()).toBe(false);
    await vi.advanceTimersByTimeAsync(REMOTE_INSTALL_COUNTDOWN_MS * 2);
    expect(effects.installUpdate).not.toHaveBeenCalled();

    // A second postpone is a no-op; "now" still installs the kept download.
    expect(installer.respond("postpone")).toMatchObject({ phase: "postponed" });
    installer.respond("now");
    await vi.advanceTimersByTimeAsync(0);
    expect(effects.installUpdate).toHaveBeenCalledTimes(1);
    expect(effects.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("fails when the feed offers another version", async () => {
    const { installer, effects, setUpdate } = harness(
      {},
      {
        checkForUpdate: vi.fn(async () => {
          setUpdate({ status: "available", availableVersion: "1.2.0" });
        }),
      },
    );

    await installer.request("req-1", "1.1.0");

    expect(installer.current()).toMatchObject({
      phase: "failed",
      message: "This app's update feed offers 1.2.0, not 1.1.0.",
    });
    expect(effects.downloadUpdate).not.toHaveBeenCalled();
    expect(effects.countdownStarted).not.toHaveBeenCalled();
  });

  it("fails with the check error when the feed cannot be read", async () => {
    const { installer, setUpdate } = harness(
      {},
      {
        checkForUpdate: vi.fn(async () => {
          setUpdate({ status: "error", errorContext: "check", message: "offline" });
        }),
      },
    );

    await installer.request("req-1", "1.1.0");

    expect(installer.current()).toMatchObject({
      phase: "failed",
      message: "Could not check for updates: offline",
    });
  });

  it("fails when the updater is disabled or cannot be prepared", async () => {
    const disabled = harness(
      { enabled: false, status: "disabled" },
      {
        prepareUpdater: vi.fn(
          async () => "Automatic updates are only available in packaged production builds.",
        ),
      },
    );
    await disabled.installer.request("req-1", "1.1.0");
    expect(disabled.installer.current()).toMatchObject({
      phase: "failed",
      message: "Automatic updates are only available in packaged production builds.",
    });
    expect(disabled.effects.checkForUpdate).not.toHaveBeenCalled();

    const broken = harness(
      {},
      {
        prepareUpdater: vi.fn(async () => {
          throw new Error("electron-updater failed to load");
        }),
      },
    );
    await expect(broken.installer.request("req-2", "1.1.0")).resolves.toBeUndefined();
    expect(broken.installer.current()).toMatchObject({
      phase: "failed",
      message: "electron-updater failed to load",
    });
  });

  it("refuses a second request while one is running, without touching the first", async () => {
    const { installer, refused, published } = harness();
    await installer.request("req-1", "1.1.0");
    const publishedBefore = published.length;

    await installer.request("req-2", "1.1.0");

    expect(refused).toEqual([
      {
        requestId: "req-2",
        targetVersion: "1.1.0",
        phase: "failed",
        restartAt: null,
        message: "Another update is already in progress.",
      },
    ]);
    expect(installer.current()).toMatchObject({ requestId: "req-1", phase: "countdown" });
    expect(published).toHaveLength(publishedBefore);
  });

  it("treats a repeated request as the same one", async () => {
    const { installer, effects, published } = harness();
    await installer.request("req-1", "1.1.0");
    const publishedBefore = published.length;

    await installer.request("req-1", "1.1.0");

    expect(published).toHaveLength(publishedBefore);
    expect(effects.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(effects.downloadUpdate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REMOTE_INSTALL_COUNTDOWN_MS);
    expect(effects.installUpdate).toHaveBeenCalledTimes(1);

    // A finished request stays finished when it is repeated.
    const failed = harness({ enabled: false }, { prepareUpdater: vi.fn(async () => "disabled") });
    await failed.installer.request("req-9", "1.1.0");
    await failed.installer.request("req-9", "1.1.0");
    expect(failed.effects.prepareUpdater).toHaveBeenCalledTimes(1);
    expect(failed.installer.current()).toMatchObject({ phase: "failed" });
  });

  it("replaces a postponed or failed request with a new one", async () => {
    const { installer, effects } = harness();
    await installer.request("req-1", "1.1.0");
    installer.respond("postpone");

    await installer.request("req-2", "1.1.0");

    expect(installer.current()).toMatchObject({ requestId: "req-2", phase: "countdown" });
    // Already downloaded: neither checked nor downloaded again.
    expect(effects.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(effects.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("fails when the download does not finish", async () => {
    const { installer, setUpdate } = harness(
      {},
      {
        downloadUpdate: vi.fn(async () => {
          setUpdate({
            status: "available",
            errorContext: "download",
            message: "disk full",
            downloadPercent: null,
          });
        }),
      },
    );

    await installer.request("req-1", "1.1.0");

    expect(installer.current()).toMatchObject({
      phase: "failed",
      message: "Could not download 1.1.0: disk full",
    });
  });

  it("fails when the install path refuses to start or fails after the handoff", async () => {
    const refusing = harness(
      {},
      { installUpdate: vi.fn(async () => "The update is not ready to install.") },
    );
    await refusing.installer.request("req-1", "1.1.0");
    refusing.installer.respond("now");
    await vi.advanceTimersByTimeAsync(0);
    expect(refusing.installer.current()).toMatchObject({
      phase: "failed",
      message: "The update is not ready to install.",
    });

    const failing = harness();
    await failing.installer.request("req-2", "1.1.0");
    await vi.advanceTimersByTimeAsync(REMOTE_INSTALL_COUNTDOWN_MS);
    expect(failing.installer.current()).toMatchObject({ phase: "installing" });
    failing.installer.installFailed("Squirrel could not replace the bundle");
    expect(failing.installer.current()).toMatchObject({
      phase: "failed",
      message: "Squirrel could not replace the bundle",
    });
  });

  it("uses a download already on disk and joins a running one", async () => {
    const downloaded = harness({
      status: "downloaded",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
    });
    await downloaded.installer.request("req-1", "1.1.0");
    expect(downloaded.effects.checkForUpdate).not.toHaveBeenCalled();
    expect(downloaded.effects.downloadUpdate).not.toHaveBeenCalled();
    expect(downloaded.installer.current()).toMatchObject({ phase: "countdown" });

    const downloading = harness({
      status: "downloading",
      availableVersion: "1.1.0",
      downloadPercent: 40,
    });
    await downloading.installer.request("req-2", "1.1.0");
    expect(downloading.effects.checkForUpdate).not.toHaveBeenCalled();
    expect(downloading.effects.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(downloading.installer.current()).toMatchObject({ phase: "countdown" });
  });

  it("re-checks a stale offer and refuses the version this app already runs", async () => {
    const stale = harness({ status: "available", availableVersion: "1.0.5" });
    await stale.installer.request("req-1", "1.1.0");
    expect(stale.effects.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(stale.installer.current()).toMatchObject({ phase: "countdown" });

    const current = harness();
    await current.installer.request("req-2", "1.0.0");
    expect(current.installer.current()).toMatchObject({
      phase: "failed",
      message: "This app already runs 1.0.0.",
    });
    expect(current.effects.checkForUpdate).not.toHaveBeenCalled();
  });

  it("ends the countdown when someone here starts the install themselves", async () => {
    const { installer, effects } = harness();
    await installer.request("req-1", "1.1.0");

    installer.installStarting();
    expect(installer.current()).toMatchObject({ phase: "installing", restartAt: null });
    await vi.advanceTimersByTimeAsync(REMOTE_INSTALL_COUNTDOWN_MS);

    expect(effects.installUpdate).not.toHaveBeenCalled();
  });

  it("drops a running flow and the countdown on dispose", async () => {
    let finishDownload: () => void = () => undefined;
    const { installer, effects, setUpdate } = harness(
      {},
      {
        downloadUpdate: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finishDownload = () => {
                setUpdate({ status: "downloaded", downloadedVersion: "1.1.0" });
                resolve();
              };
            }),
        ),
      },
    );
    const pending = installer.request("req-1", "1.1.0");
    await vi.advanceTimersByTimeAsync(0);
    expect(installer.current()).toMatchObject({ phase: "downloading" });

    installer.dispose();
    finishDownload();
    await pending;
    await vi.advanceTimersByTimeAsync(REMOTE_INSTALL_COUNTDOWN_MS);

    expect(installer.current()).toMatchObject({ phase: "downloading" });
    expect(effects.countdownStarted).not.toHaveBeenCalled();
    expect(effects.installUpdate).not.toHaveBeenCalled();
  });

  it("keeps counting down when the notification cannot be shown", async () => {
    const { installer, effects } = harness(
      {},
      {
        countdownStarted: vi.fn(() => {
          throw new Error("notifications unavailable");
        }),
      },
    );
    await installer.request("req-1", "1.1.0");
    await vi.advanceTimersByTimeAsync(REMOTE_INSTALL_COUNTDOWN_MS);
    expect(effects.installUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("remote install reducer", () => {
  const countdown: DesktopRemoteInstallState = {
    requestId: "req-1",
    targetVersion: "1.1.0",
    phase: "countdown",
    restartAt: "2026-10-21T10:00:30.000Z",
    message: null,
  };

  it("ignores transitions that do not apply to the phase", () => {
    const postponed = reduceRemoteInstall(countdown, { type: "postponed" });
    expect(postponed).toMatchObject({ phase: "postponed", restartAt: null });
    expect(reduceRemoteInstall(postponed, { type: "postponed" })).toBe(postponed);
    expect(
      reduceRemoteInstall(postponed, { type: "count-down", restartAt: countdown.restartAt! }),
    ).toBe(postponed);
    expect(reduceRemoteInstall(postponed, { type: "failed", message: "late" })).toBe(postponed);
    expect(reduceRemoteInstall(null, { type: "installing" })).toBeNull();
  });

  it("bounds failure messages to what the pipe protocol accepts", () => {
    const long = reduceRemoteInstall(countdown, { type: "failed", message: "x".repeat(5_000) });
    expect(long?.message?.length).toBe(1_000);
    expect(reduceRemoteInstall(countdown, { type: "failed", message: "  " })?.message).toBe(
      "The update failed.",
    );
  });

  it("knows which phases are still running and which answers are valid", () => {
    expect(isRemoteInstallActive(countdown)).toBe(true);
    expect(isRemoteInstallActive({ ...countdown, phase: "postponed" })).toBe(false);
    expect(isRemoteInstallActive(null)).toBe(false);
    expect(parseRemoteInstallResponse("now")).toBe("now");
    expect(parseRemoteInstallResponse("postpone")).toBe("postpone");
    expect(parseRemoteInstallResponse("later")).toBeNull();
    expect(parseRemoteInstallResponse(undefined)).toBeNull();
  });
});
