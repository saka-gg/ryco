import type { DesktopUpdateState } from "@ryco/contracts";
import { describe, expect, it, vi } from "vitest";

import { installDesktopAppUpdate, type DesktopAppInstallBridge } from "./desktopAppInstall";
import { desktopUpdateState } from "./testing/updateFixtures";

function fakeBridge(initial: DesktopUpdateState) {
  let state = initial;
  const listeners = new Set<(state: DesktopUpdateState) => void>();
  const calls: string[] = [];
  const push = (next: DesktopUpdateState) => {
    state = next;
    for (const listener of Array.from(listeners)) listener(next);
  };
  const bridge = {
    getUpdateState: vi.fn(async () => state),
    checkForUpdate: vi.fn(async () => {
      calls.push("check");
      return { checked: true, state };
    }),
    downloadUpdate: vi.fn(async () => {
      calls.push("download");
      state = { ...state, status: "downloaded", downloadedVersion: state.availableVersion };
      return { accepted: true, completed: true, state };
    }),
    installUpdate: vi.fn(async () => {
      calls.push("install");
      return { accepted: true, completed: false, state };
    }),
    onUpdateState: vi.fn((listener: (state: DesktopUpdateState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  } satisfies DesktopAppInstallBridge;
  return { bridge, calls, push, listeners, setState: (next: DesktopUpdateState) => (state = next) };
}

describe("installDesktopAppUpdate", () => {
  it("downloads the update it found, then installs it", async () => {
    const fake = fakeBridge(desktopUpdateState());
    const seen: string[] = [];
    await expect(
      installDesktopAppUpdate(fake.bridge, { onState: (state) => seen.push(state.status) }),
    ).resolves.toBe(true);
    expect(fake.calls).toEqual(["download", "install"]);
    expect(seen).toEqual(["available", "downloaded", "downloaded"]);
  });

  it("installs an update already downloaded without downloading again", async () => {
    const fake = fakeBridge(
      desktopUpdateState({ status: "downloaded", downloadedVersion: "0.1.36" }),
    );
    await expect(installDesktopAppUpdate(fake.bridge)).resolves.toBe(true);
    expect(fake.calls).toEqual(["install"]);
  });

  it("checks first when the updater has not found the release yet", async () => {
    const fake = fakeBridge(desktopUpdateState({ status: "idle", availableVersion: null }));
    fake.bridge.checkForUpdate.mockImplementation(async () => {
      fake.calls.push("check");
      const found = desktopUpdateState();
      fake.setState(found);
      return { checked: true, state: found };
    });
    await expect(installDesktopAppUpdate(fake.bridge)).resolves.toBe(true);
    expect(fake.calls).toEqual(["check", "download", "install"]);
  });

  it("waits for a download already running instead of starting another", async () => {
    const fake = fakeBridge(desktopUpdateState({ status: "downloading", downloadPercent: 40 }));
    const result = installDesktopAppUpdate(fake.bridge);
    await vi.waitFor(() => expect(fake.listeners.size).toBe(1));
    fake.push(desktopUpdateState({ status: "downloaded", downloadedVersion: "0.1.36" }));
    await expect(result).resolves.toBe(true);
    expect(fake.calls).toEqual(["install"]);
    expect(fake.listeners.size).toBe(0);
  });

  it("fails when nothing newer is found, the download fails, or the install is refused", async () => {
    const upToDate = fakeBridge(
      desktopUpdateState({ status: "up-to-date", availableVersion: null }),
    );
    await expect(installDesktopAppUpdate(upToDate.bridge)).resolves.toBe(false);
    expect(upToDate.calls).toEqual(["check"]);

    const failedDownload = fakeBridge(desktopUpdateState());
    failedDownload.bridge.downloadUpdate.mockImplementation(async () => ({
      accepted: true,
      completed: false,
      state: desktopUpdateState({ status: "error", errorContext: "download" }),
    }));
    await expect(installDesktopAppUpdate(failedDownload.bridge)).resolves.toBe(false);
    expect(failedDownload.bridge.installUpdate).not.toHaveBeenCalled();

    const refused = fakeBridge(desktopUpdateState({ status: "downloaded" }));
    refused.bridge.installUpdate.mockImplementation(async () => ({
      accepted: false,
      completed: false,
      state: desktopUpdateState({ status: "downloaded" }),
    }));
    await expect(installDesktopAppUpdate(refused.bridge)).resolves.toBe(false);

    const disabled = fakeBridge(desktopUpdateState({ enabled: false, status: "disabled" }));
    await expect(installDesktopAppUpdate(disabled.bridge)).resolves.toBe(false);
    expect(disabled.calls).toEqual([]);
  });

  it("fails on a bridge error and when a running download outlasts the wait", async () => {
    const broken = fakeBridge(desktopUpdateState());
    broken.bridge.downloadUpdate.mockRejectedValue(new Error("IPC closed"));
    await expect(installDesktopAppUpdate(broken.bridge)).resolves.toBe(false);

    const stuck = fakeBridge(desktopUpdateState({ status: "downloading" }));
    await expect(installDesktopAppUpdate(stuck.bridge, { waitMs: 5 })).resolves.toBe(false);
    expect(stuck.listeners.size).toBe(0);
    expect(stuck.calls).toEqual([]);
  });
});
