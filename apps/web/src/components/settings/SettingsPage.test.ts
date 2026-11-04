import { EnvironmentId } from "@ryco/contracts";
import { useSettingsDialogStore } from "../../settingsDialogStore";
import { describe, expect, it } from "vite-plus/test";

import { E2EE_WEB_SAS_MORE } from "../hostedHub/HostedE2eeVerification.logic";
import { PHONE_SETTINGS_SECTION_IDS } from "../shell/phone/PhoneSettingsSurface";
import { DESKTOP_KEEP_AWAKE_ROW_ID } from "./desktopKeepAwake.logic";
import { settingsNodeStatus } from "./settingsDevices.logic";
import {
  LEGACY_SETTINGS_SECTIONS,
  PHONE_SETTINGS_SECTIONS,
  resolvePhoneSettingsSection,
  resolveSettingsPageSection,
  SETTINGS_GROUPS,
  SETTINGS_SECTION_LABELS,
  SETTINGS_SECTIONS,
  settingsSection,
} from "./settingsRegistry";
import { SETTINGS_SEARCH_INDEX } from "./settingsSearchIndex";
import { PAIRING_LINK_TARGET_ID } from "./settingsSearchReveal";
import { settingsScopeLabel } from "./settingsSections.logic";

const SECTION_IDS = SETTINGS_SECTIONS.map((section) => section.id);

describe("one nav of five groups", () => {
  it("groups every section under You, Work, Agents, Devices and System", () => {
    expect(SETTINGS_GROUPS.map((group) => group.title)).toEqual([
      "You",
      "Work",
      "Agents",
      "Devices",
      "System",
    ]);
    const byGroup = Object.fromEntries(
      SETTINGS_GROUPS.map((group) => [
        group.title,
        SETTINGS_SECTIONS.filter((section) => section.group === group.id).map(
          (section) => section.title,
        ),
      ]),
    );
    expect(byGroup).toEqual({
      You: ["Appearance", "Keyboard", "Notifications", "Account"],
      Work: ["Chat & composer", "Inbox & threads", "Projects & worktrees", "Git & pull requests"],
      Agents: ["Providers & models", "Usage & cost", "Plugins & MCP", "Agent Control"],
      // "Device" is the page the nav lists once per known device.
      Devices: ["All devices", "Device"],
      System: ["Updates", "Data & backup", "Diagnostics", "About & help"],
    });
  });

  it("has no duplicate section", () => {
    expect(new Set(SECTION_IDS).size).toBe(SECTION_IDS.length);
  });

  it("retires General", () => {
    expect(SECTION_IDS).not.toContain("general");
    expect(resolveSettingsPageSection("general")).toBe("appearance");
  });
});

describe("old section ids keep working", () => {
  it("redirects every old id to a section the page has", () => {
    for (const legacy of LEGACY_SETTINGS_SECTIONS) {
      expect(SECTION_IDS, legacy).toContain(resolveSettingsPageSection(legacy));
    }
    expect(resolveSettingsPageSection("connections")).toBe("devices");
    expect(resolveSettingsPageSection("security")).toBe("device");
    expect(resolveSettingsPageSection("computer-use")).toBe("device");
    expect(resolveSettingsPageSection("archived")).toBe("inbox");
    expect(resolveSettingsPageSection("mcp-servers")).toBe("plugins");
    expect(resolveSettingsPageSection("opinionated-plugins")).toBe("plugins");
    expect(resolveSettingsPageSection("integrations")).toBe("agent-control");
    expect(resolveSettingsPageSection("statistics")).toBe("usage");
    expect(resolveSettingsPageSection("source-control")).toBe("source-control");
  });

  it("keeps the id a caller asked for, so each surface redirects it itself", () => {
    useSettingsDialogStore.getState().openSettings("security", EnvironmentId.make("remote"));
    expect(useSettingsDialogStore.getState()).toMatchObject({
      section: "security",
      targetEnvironmentId: "remote",
    });
    useSettingsDialogStore.getState().closeSettings();
  });
});

describe("the frozen phone surface keeps its existing section inventory", () => {
  it("navigates exactly the phone tier's sections", () => {
    // `PhoneSettingsSurface` keeps its own list so it can group and order
    // independently. Missing one there makes it unreachable on every phone-tier
    // presentation — below 768px, on a coarse-pointer device under 500px tall,
    // and in the hosted PWA on a phone — and a programmatic
    // `openSettings(section)` falls back to the section list with no error,
    // because `ALL_ITEMS.find(...)` returns undefined. `security` shipped in
    // exactly that state. Set equality, not "every label is present".
    expect([...PHONE_SETTINGS_SECTION_IDS].toSorted()).toEqual(
      [...PHONE_SETTINGS_SECTIONS].toSorted(),
    );
    expect(new Set(PHONE_SETTINGS_SECTION_IDS).size).toBe(PHONE_SETTINGS_SECTION_IDS.length);
  });

  it("opens a phone section for every id a caller may ask for", () => {
    for (const id of [...SECTION_IDS, ...LEGACY_SETTINGS_SECTIONS]) {
      expect(PHONE_SETTINGS_SECTION_IDS, id).toContain(resolvePhoneSettingsSection(id));
    }
    // Ids the phone tier always had open as they did.
    for (const id of PHONE_SETTINGS_SECTIONS) {
      if (id !== "general" && id !== "security")
        expect(resolvePhoneSettingsSection(id), id).toBe(id);
    }
  });
});

describe("scope labels rows carry", () => {
  it("uses the native device mental model for renderer-local preferences", () => {
    expect(settingsScopeLabel("browser", { nativeClient: false, nodeLabel: null })).toBe(
      "Ryco Web · current browser",
    );
    expect(settingsScopeLabel("browser", { nativeClient: true, nodeLabel: null })).toBe(
      "Ryco Desktop",
    );
    expect(settingsScopeLabel("account", { nativeClient: true, nodeLabel: null })).toBe(
      "Hub account",
    );
    expect(settingsScopeLabel("node", { nativeClient: true, nodeLabel: "Studio Mac" })).toBe(
      "Studio Mac",
    );
    expect(settingsScopeLabel("mixed", { nativeClient: true, nodeLabel: "Studio Mac" })).toBe(
      "Ryco Desktop + Studio Mac",
    );
  });
});

describe("§13.5's pointer names a place settings actually has", () => {
  it("spells the labels the nav and the device page draw, so a rename fails here", () => {
    // `E2EE_WEB_SAS_MORE` is the second sentence beside the session code. Nothing
    // else ties that string to the shipped settings, so renaming the Devices
    // group or a device's Security would leave the copy naming a place that no
    // longer exists — on the one surface where an owner is performing a
    // security check.
    const devices = SETTINGS_SECTION_LABELS.get("group:devices");
    const security = SETTINGS_SECTION_LABELS.get("device:security");
    expect(devices).toBe("Devices");
    expect(security).toBe("Security");
    expect(E2EE_WEB_SAS_MORE).toContain(`Settings → ${devices!} →`);
    expect(E2EE_WEB_SAS_MORE).toContain(`→ ${security!} explains`);
  });

  it("is findable by the search box that replaces the section list", () => {
    // The page's header search swaps the whole panel area for its results, so
    // an owner who follows the pointer and types what it named must find it.
    const indexed = SETTINGS_SEARCH_INDEX.filter(
      (entry) => entry.section === "device" && entry.part === "security",
    );
    expect(indexed.length).toBeGreaterThan(0);
    for (const query of ["security", "session code", "verification", "e2ee", "fingerprint"]) {
      const matches = indexed.filter((entry) =>
        `${entry.title} ${entry.description} ${entry.keywords ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      );
      expect(matches.length, `nothing in the index matches ${query}`).toBeGreaterThan(0);
    }
  });
});

describe("rows that moved", () => {
  const entry = (title: string) => SETTINGS_SEARCH_INDEX.find((item) => item.title === title);

  it("finds response streaming under Chat & composer, stored on the device", () => {
    expect(entry("Response streaming")).toMatchObject({
      section: "chat",
      storage: "device",
      targetId: "shared-setting-responseStreamingMode",
    });
    const text = `${entry("Response streaming")?.keywords}`.toLowerCase();
    for (const query of ["paragraph", "token", "streaming", "legacy"]) {
      expect(text).toContain(query);
    }
  });

  it("finds keep-awake on this computer's Power, only where the desktop can set it", () => {
    expect(entry("Keep this computer awake")).toMatchObject({
      section: "device",
      part: "power",
      storage: "this-computer",
      desktopCapability: "setKeepAwakeMode",
      // The row's title names the device ("this Mac"), so the search jumps by its id.
      targetId: DESKTOP_KEEP_AWAKE_ROW_ID,
    });
  });

  it("jumps to the pairing row first-run setup links to, on this computer's Access", () => {
    expect(entry("Pairing link")).toMatchObject({
      section: "device",
      part: "access",
      storage: "this-computer",
      targetId: PAIRING_LINK_TARGET_ID,
    });
  });

  it("applies the renames and merges", () => {
    expect(settingsSection("keybindings").title).toBe("Keyboard");
    expect(settingsSection("source-control").title).toBe("Git & pull requests");
    expect(settingsSection("providers").title).toBe("Providers & models");
    expect(settingsSection("plugins").title).toBe("Plugins & MCP");
    expect(entry("Private Agent Control")?.section).toBe("agent-control");
    expect(entry("MCP Servers")?.section).toBe("plugins");
    expect(entry("Hosting accounts")?.section).toBe("source-control");
    expect(entry("Diff style")?.section).toBe("source-control");
    expect(entry("Time format")?.section).toBe("appearance");
    expect(entry("Send shortcut")?.section).toBe("keybindings");
    expect(entry("Quit shortcut")?.section).toBe("keybindings");
    expect(entry("Test notification")?.section).toBe("notifications");
    expect(entry("Open chat tabs")?.section).toBe("chat");
    expect(entry("Lower agent CPU priority")).toMatchObject({ section: "device", part: "power" });
    expect(entry("Model prices")?.section).toBe("usage");
    expect(entry("Archive")?.section).toBe("inbox");
  });
});

describe("device status", () => {
  it("calls a device Offline or Connecting from the facts the empty state uses", () => {
    expect(settingsNodeStatus({ connection: "connected" })).toBeNull();
    // Its Hub machine record or directory says it is offline.
    expect(settingsNodeStatus({ connection: "disconnected", online: false })).toBe("offline");
    expect(settingsNodeStatus({ connection: "connected", online: false })).toBe("offline");
    // A connection underway, or one its machine record allows.
    expect(settingsNodeStatus({ connection: "connecting" })).toBe("connecting");
    expect(settingsNodeStatus({ connection: "disconnected", online: true, canConnect: true })).toBe(
      "connecting",
    );
    // Any other connection that is not up.
    expect(settingsNodeStatus({ connection: "disconnected" })).toBe("offline");
    expect(settingsNodeStatus({ connection: "error", canConnect: false })).toBe("offline");
    // No connection by design (a hosted node the cursor is not on) only follows presence.
    expect(settingsNodeStatus({ connection: undefined, online: true })).toBeNull();
    expect(settingsNodeStatus({ connection: undefined })).toBeNull();
  });
});
