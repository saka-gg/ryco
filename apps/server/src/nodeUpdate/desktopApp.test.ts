import { describe, expect, it } from "@effect/vitest";
import type { DesktopAppUpdateSnapshot } from "@ryco/shared/desktopResourceTelemetry";

import { applyDesktopRemoteInstall, desktopLatestVersion } from "./desktopApp.ts";
import { IDLE_NODE_UPDATE_RUN } from "./NodeUpdateService.ts";

const snapshot = (overrides: Partial<DesktopAppUpdateSnapshot> = {}): DesktopAppUpdateSnapshot => ({
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "0.1.35",
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  remoteInstall: null,
  ...overrides,
});

const remote = (
  phase: NonNullable<DesktopAppUpdateSnapshot["remoteInstall"]>["phase"],
  overrides: Partial<NonNullable<DesktopAppUpdateSnapshot["remoteInstall"]>> = {},
) => ({
  requestId: "update-1",
  targetVersion: "0.1.36",
  phase,
  restartAt: null,
  message: null,
  ...overrides,
});

const run = {
  ...IDLE_NODE_UPDATE_RUN,
  status: "preparing" as const,
  requestId: "update-1",
  fromVersion: "0.1.35",
  targetVersion: "0.1.36",
  startedAt: "2026-10-21T10:00:00.000Z",
};
const now = "2026-10-21T10:05:00.000Z";

describe("desktop app updater reports", () => {
  it("knows the newest release from what the app found, downloaded, or confirmed", () => {
    expect(desktopLatestVersion(snapshot())).toBeNull();
    expect(desktopLatestVersion(snapshot({ status: "up-to-date" }))).toBe("0.1.35");
    expect(
      desktopLatestVersion(snapshot({ status: "available", availableVersion: "0.1.36" })),
    ).toBe("0.1.36");
    expect(
      desktopLatestVersion(snapshot({ status: "downloaded", downloadedVersion: "0.1.37" })),
    ).toBe("0.1.37");
  });

  it("maps the app's remote install phases onto the run", () => {
    expect(
      applyDesktopRemoteInstall(
        run,
        snapshot({ downloadPercent: 42, remoteInstall: remote("downloading") }),
        now,
      ),
    ).toMatchObject({ status: "preparing", progressPercent: 42 });
    expect(
      applyDesktopRemoteInstall(
        run,
        snapshot({ remoteInstall: remote("countdown", { restartAt: "2026-10-21T10:06:00.000Z" }) }),
        now,
      ),
    ).toMatchObject({
      status: "waiting",
      restartAt: "2026-10-21T10:06:00.000Z",
      progressPercent: null,
    });
    expect(
      applyDesktopRemoteInstall(run, snapshot({ remoteInstall: remote("installing") }), now),
    ).toMatchObject({ status: "restarting" });
    expect(
      applyDesktopRemoteInstall(
        run,
        snapshot({ remoteInstall: remote("postponed", { message: "Postponed by Ada." }) }),
        now,
      ),
    ).toMatchObject({ status: "postponed", message: "Postponed by Ada.", finishedAt: null });
    expect(
      applyDesktopRemoteInstall(run, snapshot({ remoteInstall: remote("failed") }), now),
    ).toMatchObject({
      status: "failed",
      finishedAt: now,
      message: "The desktop app could not install the update.",
    });
  });

  it("ignores reports about another request and repeats that change nothing", () => {
    expect(
      applyDesktopRemoteInstall(
        run,
        snapshot({ remoteInstall: remote("countdown", { requestId: "update-2" }) }),
        now,
      ),
    ).toBeNull();
    expect(
      applyDesktopRemoteInstall(
        IDLE_NODE_UPDATE_RUN,
        snapshot({ remoteInstall: remote("installing") }),
        now,
      ),
    ).toBeNull();
    expect(
      applyDesktopRemoteInstall(run, snapshot({ remoteInstall: remote("downloading") }), now),
    ).toBeNull();
    const failed = { ...run, status: "failed" as const, finishedAt: now, message: "x" };
    expect(
      applyDesktopRemoteInstall(failed, snapshot({ remoteInstall: remote("failed") }), now),
    ).toBeNull();
  });

  it("picks a countdown up again after the backend restarted and reported a failure", () => {
    const reportedAtBoot = {
      ...run,
      status: "failed" as const,
      finishedAt: now,
      message: "Restarted on 0.1.35 instead of 0.1.36.",
    };
    expect(
      applyDesktopRemoteInstall(
        reportedAtBoot,
        snapshot({ remoteInstall: remote("countdown", { restartAt: "2026-10-21T10:06:00.000Z" }) }),
        now,
      ),
    ).toMatchObject({ status: "waiting", finishedAt: null, message: null });
  });
});
