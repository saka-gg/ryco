import { describe, expect, it } from "vite-plus/test";

import { E2EE_WEB_SAS_MORE } from "../hostedHub/HostedE2eeVerification.logic";
import { PHONE_SETTINGS_SECTION_IDS } from "../shell/phone/PhoneSettingsSurface";
import {
  hostedSettingsSectionAllowed,
  settingsSectionAvailable,
  settingsSectionReachable,
  settingsSectionScope,
  settingsScopeLabel,
  SETTINGS_DIALOG_SECTION_IDS,
  SETTINGS_DIALOG_SECTION_LABELS,
} from "./SettingsDialog";
import { SETTINGS_SEARCH_INDEX } from "./settingsSearchIndex";
import { DESKTOP_ONLY_SETTINGS_SECTIONS } from "./settingsSections.logic";

describe("the phone surface mirrors the desktop dialog's section inventory", () => {
  it("navigates to the same shared sections, excluding desktop-only controls", () => {
    // `PhoneSettingsSurface` keeps its own registry so it can group and order
    // independently, and the desktop dialog is what decides which sections
    // exist. Missing one there makes it unreachable on every phone-tier
    // presentation — below 768px, on a coarse-pointer device under 500px tall,
    // and in the hosted PWA on a phone — and a programmatic
    // `openSettings(section)` falls back to the section list with no error,
    // because `ALL_ITEMS.find(...)` returns undefined. `security` shipped in
    // exactly that state.
    //
    // Set equality rather than "every label in this hardcoded array is present":
    // the latter is what let it through.
    expect([...PHONE_SETTINGS_SECTION_IDS].toSorted()).toEqual(
      SETTINGS_DIALOG_SECTION_IDS.filter(
        (id) => !DESKTOP_ONLY_SETTINGS_SECTIONS.has(id),
      ).toSorted(),
    );
  });

  it("has no duplicate entry on either surface", () => {
    for (const [where, ids] of [
      ["desktop", SETTINGS_DIALOG_SECTION_IDS],
      ["phone", PHONE_SETTINGS_SECTION_IDS],
    ] as const) {
      expect(new Set(ids).size, where).toBe(ids.length);
    }
  });
});

describe("hosted settings capabilities", () => {
  it("declares the ownership scope of every settings section", () => {
    expect(
      SETTINGS_DIALOG_SECTION_IDS.map((section) => [section, settingsSectionScope(section)]),
    ).toEqual(
      expect.arrayContaining([
        ["general", "mixed"],
        ["appearance", "browser"],
        ["connections", "device"],
        ["computer-use", "device"],
        ["account", "account"],
        ["providers", "node"],
        ["source-control", "node"],
        ["security", "node"],
      ]),
    );
  });

  it("uses the native device mental model for renderer-local preferences", () => {
    expect(settingsScopeLabel("browser", { nativeClient: false, nodeLabel: null })).toBe(
      "This browser",
    );
    expect(settingsScopeLabel("browser", { nativeClient: true, nodeLabel: null })).toBe(
      "This device",
    );
    expect(settingsScopeLabel("device", { nativeClient: false, nodeLabel: null })).toBe(
      "This device",
    );
    expect(settingsScopeLabel("account", { nativeClient: true, nodeLabel: null })).toBe(
      "Hub account",
    );
    expect(settingsScopeLabel("node", { nativeClient: true, nodeLabel: "Studio Mac" })).toBe(
      "Node: Studio Mac",
    );
    expect(settingsScopeLabel("mixed", { nativeClient: false, nodeLabel: "Studio Mac" })).toBe(
      "This browser + Node: Studio Mac",
    );
    expect(settingsScopeLabel("mixed", { nativeClient: true, nodeLabel: "Studio Mac" })).toBe(
      "This device + Node: Studio Mac",
    );
  });

  it("fails closed while role state is unavailable", () => {
    expect(hostedSettingsSectionAllowed("appearance", null)).toBe(true);
    expect(hostedSettingsSectionAllowed("archived", null)).toBe(false);
    expect(hostedSettingsSectionAllowed("providers", null)).toBe(false);
    expect(hostedSettingsSectionAllowed("statistics", null)).toBe(false);
    // The node's E2EE operator surface is node-scoped state, so it fails closed
    // with the rest of that set rather than on the strength of the hosted HTTP
    // boundary alone.
    expect(hostedSettingsSectionAllowed("security", null)).toBe(false);
  });

  it("keeps local connection setup hidden and restricts node mutations to owners", () => {
    expect(hostedSettingsSectionAllowed("connections", "owner")).toBe(false);
    expect(hostedSettingsSectionAllowed("providers", "viewer")).toBe(false);
    expect(hostedSettingsSectionAllowed("keybindings", "operator")).toBe(false);
    expect(hostedSettingsSectionAllowed("statistics", "owner")).toBe(true);
    expect(hostedSettingsSectionAllowed("providers", "owner")).toBe(true);
    expect(hostedSettingsSectionAllowed("security", "viewer")).toBe(false);
    expect(hostedSettingsSectionAllowed("security", "operator")).toBe(false);
    expect(hostedSettingsSectionAllowed("security", "owner")).toBe(true);
  });

  it("no longer offers account management from this dialog in the hosted client", () => {
    // Account management is a Hub page now — `/account/*`, rendered by
    // `components/hostedHub/HubAccountPage.tsx` — not tab one of a thirteen-tab
    // IDE preferences modal. The gate stays closed for every role rather than
    // being deleted, so a stale caller asking this dialog for the section is
    // refused instead of being shown a section it no longer renders.
    expect(hostedSettingsSectionAllowed("account", null)).toBe(false);
    expect(hostedSettingsSectionAllowed("account", "viewer")).toBe(false);
    expect(hostedSettingsSectionAllowed("account", "owner")).toBe(false);

    // Unchanged: the standard (local-server) client has no Hub account at all,
    // so the section does not exist there either.
    expect(settingsSectionAvailable("account", false)).toBe(false);
    expect(settingsSectionAvailable("account", true)).toBe(true);
  });

  it("leaves every other section reachable in the standard client", () => {
    for (const section of [
      "general",
      "providers",
      "appearance",
      "connections",
      "security",
      "diagnostics",
      "archived",
    ] as const) {
      expect(settingsSectionAvailable(section, false)).toBe(true);
      expect(settingsSectionAvailable(section, true)).toBe(true);
    }
  });

  it("is one predicate, so a nav and a pointer at a section cannot disagree", () => {
    // `settingsSectionReachable` is what both navs filter on and what
    // `HostedE2eeVerification` asks before it draws §13.5's pointer. Written out
    // per call site it was three copies of the same two clauses, and the copy
    // that NAMES a section is the caller most likely to be forgotten when the
    // gate moves.
    for (const role of ["viewer", "operator", "owner", null] as const) {
      expect(settingsSectionReachable("security", { hosted: true, role })).toBe(
        hostedSettingsSectionAllowed("security", role),
      );
    }
    // Local mode has no hosted role at all, and the section is not hosted-only.
    expect(settingsSectionReachable("security", { hosted: false, role: null })).toBe(true);
    expect(settingsSectionReachable("account", { hosted: false, role: null })).toBe(false);
  });
});

describe("§13.5's pointer names a section this dialog actually has", () => {
  it("spells the label the nav draws, so a rename fails here", () => {
    // `E2EE_WEB_SAS_MORE` is the second sentence beside the session code:
    // "Settings → Security explains what else this tab cannot check." Nothing
    // else ties that string to the shipped section, so renaming the nav item
    // would leave the copy naming a section that no longer exists — on the one
    // surface where an owner is performing a security check.
    const label = SETTINGS_DIALOG_SECTION_LABELS.get("security");
    expect(label, "the security section left the dialog").toBeDefined();
    expect(E2EE_WEB_SAS_MORE).toContain(`Settings → ${label!}`);
  });

  it("is findable by the search box that replaces the section list", () => {
    // The dialog's header search swaps the whole panel area for its results, so
    // an owner who follows the pointer and types what it named would be told
    // "No settings match “security”" — the search actively denying the
    // destination the copy had just given them. (`account` and
    // `opinionated-plugins` are also unindexed; both predate this pointer and
    // neither is named by shipped security copy, so they are left alone.)
    const indexed = SETTINGS_SEARCH_INDEX.filter((entry) => entry.section === "security");
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

describe("legacy token streaming search", () => {
  it("routes the legacy result to the revealable General-settings row", () => {
    const entry = SETTINGS_SEARCH_INDEX.find(
      (candidate) => candidate.title === "Stream token by token (legacy)",
    );
    expect(entry).toMatchObject({
      section: "general",
      targetId: "legacy-token-streaming",
    });
    expect(`${entry?.title} ${entry?.description} ${entry?.keywords}`.toLowerCase()).toContain(
      "token streaming",
    );
  });
});
