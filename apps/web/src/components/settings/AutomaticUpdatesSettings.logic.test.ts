import { DEFAULT_SERVER_SETTINGS, type ServerConfig } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  automaticUpdatesDesktopNote,
  automaticUpdatesSwitch,
  automaticUpdatesView,
} from "./AutomaticUpdatesSettings.logic";

function config(input: {
  readonly capability?: boolean;
  readonly automaticUpdates?: boolean;
  readonly enableProviderUpdateChecks?: boolean;
}): ServerConfig {
  return {
    environment: {
      capabilities: input.capability === undefined ? {} : { automaticUpdates: input.capability },
    },
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      automaticUpdates: input.automaticUpdates ?? false,
      enableProviderUpdateChecks: input.enableProviderUpdateChecks ?? true,
    },
  } as unknown as ServerConfig;
}

describe("automaticUpdatesView", () => {
  it("shows the node's setting to its owner", () => {
    expect(automaticUpdatesView({ config: config({ capability: true }), owner: true })).toBe("off");
    expect(
      automaticUpdatesView({
        config: config({ capability: true, automaticUpdates: true }),
        owner: true,
      }),
    ).toBe("on");
  });

  it("never offers it to a session that does not own the node", () => {
    expect(
      automaticUpdatesView({
        config: config({ capability: true, automaticUpdates: true }),
        owner: false,
      }),
    ).toBe("hidden");
  });

  it("hides it on nodes too old to update unattended, or not known yet", () => {
    expect(automaticUpdatesView({ config: config({}), owner: true })).toBe("hidden");
    expect(automaticUpdatesView({ config: null, owner: true })).toBe("hidden");
  });

  it("shows the real value while provider update checks are off", () => {
    const checksOff = (automaticUpdates: boolean) =>
      automaticUpdatesView({
        config: config({ capability: true, automaticUpdates, enableProviderUpdateChecks: false }),
        owner: true,
      });
    expect(checksOff(true)).toBe("on-checks-off");
    expect(checksOff(false)).toBe("off-checks-off");
  });
});

describe("automaticUpdatesSwitch", () => {
  it("can always be turned off, and turned on only while provider update checks are on", () => {
    expect(automaticUpdatesSwitch("on")).toEqual({
      checked: true,
      checksOff: false,
      canChange: true,
    });
    expect(automaticUpdatesSwitch("off")).toEqual({
      checked: false,
      checksOff: false,
      canChange: true,
    });
    expect(automaticUpdatesSwitch("on-checks-off")).toEqual({
      checked: true,
      checksOff: true,
      canChange: true,
    });
    expect(automaticUpdatesSwitch("off-checks-off")).toEqual({
      checked: false,
      checksOff: true,
      canChange: false,
    });
  });
});

describe("automaticUpdatesDesktopNote", () => {
  const desktop = (desktopAppUpdates?: "install-on-quit" | "restart") =>
    ({
      environment: {
        capabilities: {
          automaticUpdates: true,
          ...(desktopAppUpdates === undefined ? {} : { desktopAppUpdates }),
        },
      },
      settings: DEFAULT_SERVER_SETTINGS,
    }) as unknown as ServerConfig;

  it("says what the desktop app does with its own updates on each platform", () => {
    expect(automaticUpdatesDesktopNote(desktop("install-on-quit"))).toBe(
      "This desktop app also downloads its own updates in the background and installs one when you quit it. It never restarts by itself.",
    );
    expect(automaticUpdatesDesktopNote(desktop("restart"))).toBe(
      "This desktop app also downloads its own updates in the background. On macOS one installs only when you choose Restart.",
    );
  });

  it("says nothing for CLI nodes, older desktop apps and unknown nodes", () => {
    expect(automaticUpdatesDesktopNote(desktop())).toBeNull();
    expect(automaticUpdatesDesktopNote(null)).toBeNull();
  });
});
