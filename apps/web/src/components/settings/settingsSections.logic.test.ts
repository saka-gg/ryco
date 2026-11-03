import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SettingsTarget } from "../../settingsTarget";
import { SETTINGS_SEARCH_INDEX } from "./settingsSearchIndex";
import { SETTINGS_SECTION_LABELS, settingsSection } from "./settingsRegistry";
import {
  deviceSecurityReachable,
  isNodeSettingsTargetReadOnly,
  settingsSectionAppOnly,
  settingsSectionHasDeviceParts,
  settingsSectionListed,
  settingsSectionReachable,
  settingsStorageReachable,
  type HostedSettingsRole,
  type SettingsReach,
} from "./settingsSections.logic";

const ROLES = [
  "viewer",
  "operator",
  "owner",
  null,
] as const satisfies ReadonlyArray<HostedSettingsRole>;

function reach(overrides: Partial<SettingsReach> = {}): SettingsReach {
  return {
    hosted: false,
    desktopComputerUse: false,
    device: { gated: false, role: "owner" },
    ...overrides,
  };
}

describe("who may open which part", () => {
  it("keeps this app's rows reachable for every reader, hosted or not", () => {
    for (const role of ROLES) {
      expect(
        settingsStorageReachable("app", reach({ hosted: true, device: { gated: true, role } })),
      ).toBe(true);
    }
    expect(settingsStorageReachable("app", reach({ device: null }))).toBe(true);
  });

  it("gives rows stored on a device to its owner only, where the role decides", () => {
    expect(settingsStorageReachable("device", reach())).toBe(true);
    for (const role of ROLES) {
      expect(settingsStorageReachable("device", reach({ device: { gated: true, role } }))).toBe(
        role === "owner",
      );
    }
    expect(settingsStorageReachable("device", reach({ device: null }))).toBe(false);
  });

  it("lets any role read the shown device's archive, and fails closed without one", () => {
    for (const role of ROLES) {
      expect(
        settingsStorageReachable("device-read", reach({ device: { gated: true, role } })),
      ).toBe(role !== null);
    }
  });

  it("keeps this computer's reach off the hosted client, and computer use on the desktop app", () => {
    expect(settingsStorageReachable("this-computer", reach())).toBe(true);
    expect(settingsStorageReachable("this-computer", reach({ hosted: true }))).toBe(false);
    expect(settingsStorageReachable("desktop", reach())).toBe(false);
    expect(settingsStorageReachable("desktop", reach({ desktopComputerUse: true }))).toBe(true);
    expect(settingsStorageReachable("hub", reach())).toBe(false);
    expect(settingsStorageReachable("hub", reach({ hosted: true }))).toBe(true);
  });
});

describe("which sections the nav lists", () => {
  it("lists a section when any part is reachable, so mixed sections stay for a hosted viewer", () => {
    const viewer = reach({ hosted: true, device: { gated: true, role: "viewer" } });
    expect(settingsSectionListed("chat", viewer)).toBe(true);
    expect(settingsSectionListed("inbox", viewer)).toBe(true);
    expect(settingsSectionListed("providers", viewer)).toBe(false);
    expect(settingsSectionListed("agent-control", viewer)).toBe(false);
    expect(settingsSectionListed("appearance", viewer)).toBe(true);
    expect(settingsSectionListed("updates", viewer)).toBe(true);
    expect(settingsSectionListed("account", viewer)).toBe(true);
    expect(settingsSectionListed("account", reach())).toBe(false);
  });

  it("keeps a remote device's sections outside hosted mode while its role is unknown or not owner", () => {
    // Offline or connecting (no role yet), or connected without ownership: the device bar's
    // device must not send the page elsewhere; the page says why its rows do not show.
    for (const role of ROLES) {
      const remote = reach({ device: { gated: true, role } });
      expect(settingsSectionListed("providers", remote)).toBe(true);
      expect(settingsSectionListed("usage", remote)).toBe(true);
      expect(settingsSectionListed("agent-control", remote)).toBe(true);
    }
    // Still nothing on a device to list before any device is known.
    expect(settingsSectionListed("providers", reach({ device: null }))).toBe(false);
    // Hosted, the role decides.
    expect(
      settingsSectionListed(
        "providers",
        reach({ hosted: true, device: { gated: true, role: null } }),
      ),
    ).toBe(false);
  });

  it("shows the device bar only where a reachable part is stored on a device", () => {
    expect(settingsSectionHasDeviceParts("projects", reach())).toBe(true);
    expect(settingsSectionHasDeviceParts("appearance", reach())).toBe(false);
    expect(settingsSectionHasDeviceParts("device", reach())).toBe(false);
    expect(
      settingsSectionHasDeviceParts("chat", reach({ device: { gated: true, role: "viewer" } })),
    ).toBe(false);
  });

  it("calls a section This app only when every part is this app's", () => {
    expect(settingsSectionAppOnly("appearance")).toBe(true);
    expect(settingsSectionAppOnly("keybindings")).toBe(true);
    expect(settingsSectionAppOnly("chat")).toBe(false);
    expect(settingsSectionAppOnly("updates")).toBe(false);
  });
});

describe("the Updates section", () => {
  it("lists every device from this app, for every hosted role", () => {
    expect(SETTINGS_SECTION_LABELS.get("updates")).toBe("Updates");
    expect(settingsSection("updates").parts).toContain("app");
    for (const role of ROLES) {
      expect(
        settingsSectionListed("updates", reach({ hosted: true, device: { gated: true, role } })),
      ).toBe(true);
    }
  });

  it("is findable by search under this app", () => {
    const entries = SETTINGS_SEARCH_INDEX.filter((entry) => entry.title === "Update everything");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ section: "updates", storage: "app" });
    expect(`${entries[0]?.keywords}`).toContain("check for updates");
  });
});

describe("the frozen phone tier's gates", () => {
  it("keeps today's per-section rules, failing closed while the hosted role is unknown", () => {
    expect(settingsSectionReachable("appearance", { hosted: true, role: null })).toBe(true);
    expect(settingsSectionReachable("archived", { hosted: true, role: null })).toBe(false);
    expect(settingsSectionReachable("archived", { hosted: true, role: "viewer" })).toBe(true);
    expect(settingsSectionReachable("providers", { hosted: true, role: "operator" })).toBe(false);
    expect(settingsSectionReachable("providers", { hosted: true, role: "owner" })).toBe(true);
    expect(settingsSectionReachable("connections", { hosted: true, role: "owner" })).toBe(false);
    expect(settingsSectionReachable("connections", { hosted: false, role: null })).toBe(true);
    // The Hub account is a Hub page, never a section of the sheet.
    for (const hosted of [false, true]) {
      expect(settingsSectionReachable("account", { hosted, role: "owner" })).toBe(false);
    }
  });

  it("agrees with the page on a device's Security", () => {
    for (const role of ROLES) {
      expect(deviceSecurityReachable({ hosted: true, role })).toBe(
        settingsSectionReachable("security", { hosted: true, role }),
      );
    }
    expect(deviceSecurityReachable({ hosted: false, role: null })).toBe(true);
  });
});

describe("isNodeSettingsTargetReadOnly", () => {
  const target: SettingsTarget = {
    environmentId: EnvironmentId.make("environment-local"),
    nodeLabel: "This Mac",
    serverConfig: null,
    primary: true,
    connected: true,
  };

  it("allows a connected node this client may change", () => {
    expect(isNodeSettingsTargetReadOnly("all", target)).toBe(false);
    expect(isNodeSettingsTargetReadOnly("node", target)).toBe(false);
    expect(
      isNodeSettingsTargetReadOnly("all", { ...target, canManage: true, canMutate: true }),
    ).toBe(false);
    expect(isNodeSettingsTargetReadOnly("all", null)).toBe(false);
  });

  it("is read-only for client-only editing and node editing without a target", () => {
    expect(isNodeSettingsTargetReadOnly("client", target)).toBe(true);
    expect(isNodeSettingsTargetReadOnly("node", null)).toBe(true);
  });

  it("is read-only for a disconnected, unmanaged or immutable target", () => {
    expect(isNodeSettingsTargetReadOnly("all", { ...target, connected: false })).toBe(true);
    expect(isNodeSettingsTargetReadOnly("all", { ...target, canManage: false })).toBe(true);
    expect(isNodeSettingsTargetReadOnly("node", { ...target, canMutate: false })).toBe(true);
  });
});
