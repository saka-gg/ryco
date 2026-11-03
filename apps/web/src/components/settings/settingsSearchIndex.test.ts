import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { HostedSettingsRole } from "./settingsSections.logic";
import {
  filterSettingsSearchEntries,
  settingsSectionListed,
  type SettingsDesktopCapability,
  type SettingsSearchScope,
} from "./settingsSearchIndex";

function node(input: {
  readonly primary?: boolean;
  readonly connected?: boolean;
  readonly role?: HostedSettingsRole;
}): SettingsSearchScope["node"] {
  const primary = input.primary ?? true;
  return {
    target: {
      environmentId: EnvironmentId.make("environment-local"),
      nodeLabel: "Studio Mac",
      serverConfig: null,
      primary,
      connected: input.connected ?? true,
    },
    isPrimary: primary,
    nodeRole: input.role === undefined ? "owner" : input.role,
  };
}

/** A local browser on its own primary node, unless overridden. */
function scope(
  overrides: Partial<SettingsSearchScope> & {
    readonly capabilities?: ReadonlyArray<SettingsDesktopCapability>;
  } = {},
): SettingsSearchScope {
  const { capabilities = [], ...rest } = overrides;
  return {
    hosted: false,
    desktopComputerUse: false,
    localOnboarding: false,
    hasDesktopCapability: (capability) => capabilities.includes(capability),
    node: node({}),
    ...rest,
  };
}

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

  it("gives a hosted viewer only this app's rows and the device's archive", () => {
    const viewer = scope({ hosted: true, node: node({ role: "viewer" }) });
    const results = filterSettingsSearchEntries("device", viewer);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((entry) => entry.owner === "client")).toBe(true);
    expect(titles("unarchive", viewer)).toEqual(["Archive"]);
    expect(titles("device name", scope({ hosted: true }))).toEqual(["Device name"]);
  });

  it("drops device rows with no device, or one this client cannot change", () => {
    const local = filterSettingsSearchEntries("device", scope());
    expect(local.some((entry) => entry.owner === "node")).toBe(true);
    for (const withoutDevice of [
      scope({ node: { target: null, isPrimary: false, nodeRole: null } }),
      scope({ node: node({ primary: false, connected: false }) }),
      scope({ node: node({ primary: false, role: "viewer" }) }),
    ]) {
      expect(
        filterSettingsSearchEntries("device", withoutDevice).filter(
          (entry) => entry.owner === "node",
        ),
      ).toEqual([]);
    }
    expect(titles("device name", scope({ node: node({ primary: false }) }))).toEqual([
      "Device name",
    ]);
  });
});

describe("settingsSectionListed", () => {
  it("keeps Connections in this app, and out of it on the hosted client", () => {
    expect(settingsSectionListed(scope(), "client", "connections")).toBe(true);
    expect(settingsSectionListed(scope({ hosted: true }), "client", "connections")).toBe(false);
    expect(settingsSectionListed(scope(), "node", "connections")).toBe(false);
  });

  it("lists Integrations in this app only on desktops with computer use", () => {
    expect(settingsSectionListed(scope(), "client", "integrations")).toBe(false);
    expect(
      settingsSectionListed(scope({ desktopComputerUse: true }), "client", "integrations"),
    ).toBe(true);
    expect(settingsSectionListed(scope(), "node", "integrations")).toBe(true);
  });

  it("lists device sections only for a device whose role allows them", () => {
    expect(settingsSectionListed(scope(), "node", "providers")).toBe(true);
    expect(
      settingsSectionListed(
        scope({ node: { target: null, isPrimary: false, nodeRole: "owner" } }),
        "node",
        "providers",
      ),
    ).toBe(false);
    const remoteViewer = scope({ node: node({ primary: false, role: "viewer" }) });
    expect(settingsSectionListed(remoteViewer, "node", "providers")).toBe(false);
    expect(settingsSectionListed(remoteViewer, "node", "archived")).toBe(true);
  });
});
