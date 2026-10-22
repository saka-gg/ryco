import type { DesktopRemoteInstallState } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import {
  describeRemoteInstallCountdown,
  remoteInstallSecondsLeft,
  selectRemoteInstallCountdown,
} from "./remoteInstallCountdown.logic";
import { desktopUpdateState } from "./testing/updateFixtures";

const remoteInstall = (
  overrides: Partial<DesktopRemoteInstallState> = {},
): DesktopRemoteInstallState => ({
  requestId: "request-1",
  targetVersion: "0.1.36",
  phase: "countdown",
  restartAt: "2026-10-21T12:00:30.000Z",
  message: null,
  ...overrides,
});

describe("selectRemoteInstallCountdown", () => {
  it("is the remote install only while it counts down", () => {
    const counting = remoteInstall();
    expect(selectRemoteInstallCountdown(desktopUpdateState({ remoteInstall: counting }))).toBe(
      counting,
    );
    for (const phase of ["downloading", "installing", "postponed", "failed"] as const) {
      expect(
        selectRemoteInstallCountdown(
          desktopUpdateState({ remoteInstall: remoteInstall({ phase }) }),
        ),
      ).toBeNull();
    }
    expect(selectRemoteInstallCountdown(desktopUpdateState())).toBeNull();
    expect(selectRemoteInstallCountdown(desktopUpdateState({ remoteInstall: null }))).toBeNull();
    expect(selectRemoteInstallCountdown(null)).toBeNull();
  });
});

describe("remoteInstallSecondsLeft", () => {
  const restartAt = "2026-10-21T12:00:30.000Z";
  const at = Date.parse(restartAt);

  it("rounds up to whole seconds and stops at zero", () => {
    expect(remoteInstallSecondsLeft(restartAt, at - 30_000)).toBe(30);
    expect(remoteInstallSecondsLeft(restartAt, at - 29_001)).toBe(30);
    expect(remoteInstallSecondsLeft(restartAt, at - 1)).toBe(1);
    expect(remoteInstallSecondsLeft(restartAt, at)).toBe(0);
    expect(remoteInstallSecondsLeft(restartAt, at + 5_000)).toBe(0);
  });

  it("is zero without a usable time", () => {
    expect(remoteInstallSecondsLeft(null, at)).toBe(0);
    expect(remoteInstallSecondsLeft("not a date", at)).toBe(0);
  });
});

describe("describeRemoteInstallCountdown", () => {
  it("names the seconds left and the release, and says another device asked", () => {
    const view = describeRemoteInstallCountdown({ targetVersion: "0.1.36", secondsLeft: 12 });
    expect(view.title).toBe("Ryco restarts in 12s to update to 0.1.36");
    expect(view.description).toContain("requested from another device");
  });

  it("says it is restarting once the countdown ran out", () => {
    expect(describeRemoteInstallCountdown({ targetVersion: "0.1.36", secondsLeft: 0 }).title).toBe(
      "Ryco is restarting to update to 0.1.36",
    );
  });
});
