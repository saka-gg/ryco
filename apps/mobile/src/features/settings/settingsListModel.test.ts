import { describe, expect, it } from "vite-plus/test";

import { MVP_SETTINGS_ROUTES } from "../../navigation/mvpRouteConfig";
import {
  buildSettingsSections,
  buildSettingsSummary,
  settingsSummaryHub,
} from "./settingsListModel";

describe("Settings list", () => {
  const sections = buildSettingsSections({ version: "0.4.0" });
  const ids = new Set(sections.flatMap((section) => section.rows.map((row) => row.id)));

  it("keeps every settings page reachable from the list or from the page that owns it", () => {
    // The account page opens from Hub and account (the summary card); every machine's own
    // pages (its settings and the Hub node security with its verification) from the machine's
    // page in Machines, the summary card's other row.
    const reachedElsewhere = new Set([
      "SettingsAccount",
      "SettingsNodeSecurity",
      "SettingsNodeVerification",
      "SettingsMachines",
      "SettingsMachine",
      "SettingsMachineProviders",
      "SettingsMachineProvider",
      "SettingsMachineAgents",
      "SettingsMachineWork",
      "SettingsMachineSystem",
      "SettingsMachineUsagePrices",
      "SettingsMachineImport",
    ]);
    for (const route of Object.keys(MVP_SETTINGS_ROUTES)) {
      if (reachedElsewhere.has(route)) continue;
      if (route === "SettingsHub") continue; // the summary card
      expect(ids.has(route as never), route).toBe(true);
    }
  });

  it("names machines once: no Machines group under the Machines summary row", () => {
    expect(sections.map((section) => section.title)).not.toContain("Machines");
    const labels = sections.flatMap((section) => section.rows.map((row) => row.label));
    expect(labels.some((label) => /machine|node security/i.test(label))).toBe(false);
  });

  it("drops the Usage row now that Usage is a tab, and lists no page twice", () => {
    const all = sections.flatMap((section) => section.rows.map((row) => row.id));
    expect(new Set(all).size).toBe(all.length);
    expect(all.some((id) => /usage|statistics/i.test(id))).toBe(false);
  });

  it("gives every row an icon and puts the rarely used pages last", () => {
    for (const section of sections) {
      for (const row of section.rows) expect(row.icon, row.id).not.toBe("");
    }
    expect(sections.at(-1)?.rows.map((row) => row.id)).toEqual([
      "SettingsArchived",
      "SettingsClientStorage",
      "SettingsDiagnostics",
      "SettingsAbout",
    ]);
    expect(sections.at(-1)?.rows.at(-1)?.value).toBe("0.4.0");
  });
});

describe("Settings summary", () => {
  it("names the Hub by host and counts the machines online", () => {
    expect(
      buildSettingsSummary({
        hub: { label: "Ryco Hub", origin: "https://hub.example.com" },
        machines: { total: 3, connected: 2 },
      }),
    ).toEqual({
      hubLabel: "Ryco Hub",
      hubDetail: "hub.example.com",
      machinesValue: "2 of 3 online",
    });
    expect(buildSettingsSummary({ hub: null, machines: { total: 0, connected: 0 } })).toMatchObject(
      {
        hubLabel: "No Hub",
        machinesValue: "None",
      },
    );
    expect(
      buildSettingsSummary({ hub: null, machines: { total: 2, connected: 2 } }).machinesValue,
    ).toBe("2 online");
  });
});

describe("settingsSummaryHub", () => {
  it("prefers the saved profile and falls back to the build's Hub", () => {
    const saved = { label: "Work Hub", origin: "https://work.example.com" };
    expect(settingsSummaryHub(saved, "https://hub.example.com")).toBe(saved);
    expect(settingsSummaryHub(undefined, "https://hub.example.com")).toEqual({
      label: "Ryco Hub",
      origin: "https://hub.example.com",
    });
    expect(settingsSummaryHub(null, null)).toBeNull();
  });
});
