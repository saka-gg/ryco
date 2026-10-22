import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { useSettingsDialogStore } from "../../settingsDialogStore";
import { SETTINGS_SECTION_IDS, SETTINGS_SECTION_LABELS } from "./SettingsPage";
import { SETTINGS_SEARCH_INDEX } from "./settingsSearchIndex";
import {
  hostedSettingsSectionAllowed,
  settingsSectionAvailable,
  settingsSectionInDestination,
  settingsSectionReachable,
  settingsSectionScope,
} from "./settingsSections.logic";

describe("the Updates section", () => {
  it("belongs to this app, which reaches every device, never to one node's settings", () => {
    expect(SETTINGS_SECTION_IDS).toContain("updates");
    expect(SETTINGS_SECTION_LABELS.get("updates")).toBe("Updates");
    expect(settingsSectionScope("updates")).toBe("device");
    expect(settingsSectionInDestination("updates", "client", false)).toBe(true);
    expect(settingsSectionInDestination("updates", "client", true)).toBe(true);
    expect(settingsSectionInDestination("updates", "node", true)).toBe(false);
    expect(settingsSectionInDestination("updates", "node", false)).toBe(false);
  });

  it("opens in this app's settings even when a device is named", () => {
    useSettingsDialogStore.getState().openSettings("updates", EnvironmentId.make("remote-node"));
    expect(useSettingsDialogStore.getState()).toMatchObject({
      section: "updates",
      editingScope: "client",
    });
    useSettingsDialogStore.getState().closeSettings();
  });

  it("is reachable in every build and for every hosted role", () => {
    // Each device's own owner check decides what may be updated there (the plan
    // marks the rest skipped), so the section itself is not gated on one role.
    expect(settingsSectionAvailable("updates", false)).toBe(true);
    expect(settingsSectionAvailable("updates", true)).toBe(true);
    expect(settingsSectionReachable("updates", { hosted: false, role: null })).toBe(true);
    for (const role of ["viewer", "operator", "owner", null] as const) {
      expect(hostedSettingsSectionAllowed("updates", role)).toBe(true);
      expect(settingsSectionReachable("updates", { hosted: true, role })).toBe(true);
    }
  });

  it("is findable by search under this app", () => {
    const entries = SETTINGS_SEARCH_INDEX.filter((entry) => entry.section === "updates");
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.owner).toBe("client");
    expect(
      entries.some((entry) =>
        `${entry.title} ${entry.description} ${entry.keywords ?? ""}`
          .toLowerCase()
          .includes("check for updates"),
      ),
    ).toBe(true);
  });
});
