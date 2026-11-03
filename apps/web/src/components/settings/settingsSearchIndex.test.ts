import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { HostedSettingsRole, SettingsReach } from "./settingsSections.logic";
import {
  describeSettingsSearchEntry,
  filterSettingsSearchEntries,
  settingsSearchEntryDestination,
  SETTINGS_SEARCH_INDEX,
  type SettingsDesktopCapability,
  type SettingsSearchScope,
} from "./settingsSearchIndex";

/** A local browser on its own primary device, unless overridden. */
function scope(
  overrides: {
    readonly hosted?: boolean;
    readonly desktopComputerUse?: boolean;
    readonly device?: SettingsReach["device"];
    readonly localOnboarding?: boolean;
    readonly capabilities?: ReadonlyArray<SettingsDesktopCapability>;
  } = {},
): SettingsSearchScope {
  const { capabilities = [] } = overrides;
  return {
    reach: {
      hosted: overrides.hosted ?? false,
      desktopComputerUse: overrides.desktopComputerUse ?? false,
      device: overrides.device === undefined ? { gated: false, role: "owner" } : overrides.device,
    },
    localOnboarding: overrides.localOnboarding ?? false,
    hasDesktopCapability: (capability) => capabilities.includes(capability),
  };
}

/** A device whose role decides: hosted, or a device other than this app's own. */
const gated = (role: HostedSettingsRole): SettingsReach["device"] => ({ gated: true, role });

const titles = (query: string, searchScope: SettingsSearchScope) =>
  filterSettingsSearchEntries(query, searchScope).map((entry) => entry.title);

describe("filterSettingsSearchEntries", () => {
  it("matches title, description and keywords in index order, only while typing", () => {
    expect(titles("diff", scope())).toEqual([
      "Diff style",
      "Diff line wrapping",
      "Hide whitespace changes",
      "Code font",
    ]);
    expect(titles("  DEVICE name ", scope())).toEqual(["Device name"]);
    expect(titles("", scope())).toEqual([]);
    expect(titles("   ", scope())).toEqual([]);
  });

  it("lists desktop rows only where the desktop offers them", () => {
    expect(titles("quit", scope())).toEqual([]);
    expect(titles("quit", scope({ capabilities: ["quitShortcut"] }))).toEqual(["Quit shortcut"]);
    expect(titles("browser use", scope({ capabilities: ["computerUse"] }))).toEqual([]);
    expect(
      titles("browser use", scope({ capabilities: ["computerUse"], desktopComputerUse: true })),
    ).toEqual(["Browser Use"]);
  });

  it("lists the welcome tour only on a local onboarding client", () => {
    expect(titles("tour", scope())).toEqual([]);
    expect(titles("tour", scope({ localOnboarding: true }))).toEqual(["Welcome tour"]);
  });

  it("gives a hosted viewer this app's rows and the device's archive, never its settings", () => {
    const viewer = scope({ hosted: true, device: gated("viewer") });
    const results = filterSettingsSearchEntries("thread", viewer);
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.every((entry) => entry.storage === "app" || entry.storage === "device-read"),
    ).toBe(true);
    expect(titles("unarchive", viewer)).toEqual(["Archive"]);
    expect(titles("device name", viewer)).toEqual([]);
    expect(titles("device name", scope({ hosted: true, device: gated("owner") }))).toEqual([
      "Device name",
    ]);
  });

  it("keeps this computer's reach and pairing off the hosted client", () => {
    expect(titles("pairing link", scope())).toEqual(["Pairing link"]);
    expect(titles("pairing link", scope({ hosted: true, device: gated("owner") }))).toEqual([]);
  });

  it("fails closed for device rows while the role is unknown or stale", () => {
    const local = filterSettingsSearchEntries("device", scope());
    expect(local.some((entry) => entry.storage === "device")).toBe(true);
    for (const withoutDevice of [scope({ device: null }), scope({ device: gated(null) })]) {
      expect(
        filterSettingsSearchEntries("device", withoutDevice).filter(
          (entry) => entry.storage === "device" || entry.storage === "device-read",
        ),
      ).toEqual([]);
    }
    expect(titles("device name", scope({ device: gated("owner") }))).toEqual(["Device name"]);
  });
});

describe("where a result opens", () => {
  const target = EnvironmentId.make("remote");
  const primary = EnvironmentId.make("local");

  it("opens device rows on the device searched, and this computer's rows on its own page", () => {
    const entry = (title: string) => SETTINGS_SEARCH_INDEX.find((item) => item.title === title)!;
    expect(settingsSearchEntryDestination(entry("Worktree root"), { target, primary })).toEqual({
      section: "projects",
      environmentId: target,
    });
    expect(settingsSearchEntryDestination(entry("Network access"), { target, primary })).toEqual({
      section: "device",
      environmentId: primary,
    });
    expect(settingsSearchEntryDestination(entry("Session code"), { target, primary })).toEqual({
      section: "device",
      environmentId: target,
    });
  });

  it("names the place as the nav does", () => {
    expect(describeSettingsSearchEntry({ section: "projects" })).toBe(
      "Work › Projects & worktrees",
    );
    expect(describeSettingsSearchEntry({ section: "device", part: "security" }, "Studio Mac")).toBe(
      "Devices › Studio Mac › Security",
    );
  });
});
