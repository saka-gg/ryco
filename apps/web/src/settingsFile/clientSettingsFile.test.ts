import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@ryco/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  APPEARANCE_PREFERENCE_KEYS,
  DEFAULT_APPEARANCE_PREFERENCES,
  type AppearancePreferenceKey,
} from "../themes/appearancePreferences";
import type { ThemeDefinition } from "../themes/types";
import {
  applyClientSettingsImport,
  buildClientSettingsFile,
  CLIENT_SETTINGS_FILE_KEYS,
  type ClientSettingsFileState,
  type ClientSettingsImportWriters,
  planClientSettingsImport,
} from "./clientSettingsFile";

const sunset: ThemeDefinition = { id: "custom-sunset", name: "Sunset", builtIn: false };

const defaults: ClientSettingsFileState = {
  client: DEFAULT_CLIENT_SETTINGS,
  appearance: DEFAULT_APPEARANCE_PREFERENCES,
  colorMode: "system",
  activeThemeId: "default",
  customThemes: [],
};

const options = {
  newThemeId: (theme: ThemeDefinition) => `${theme.id}-copy`,
  themeExists: (id: string) => id === "default" || id === "nord",
};

/** Writers over a state object, recording what they did. */
function fakeWriters(
  state: { current: ClientSettingsFileState },
  failSave = false,
  failOn: string | null = null,
) {
  const calls: string[] = [];
  const writers: ClientSettingsImportWriters = {
    addTheme: (theme) => {
      calls.push(`add ${theme.id}`);
      state.current = { ...state.current, customThemes: [...state.current.customThemes, theme] };
    },
    removeTheme: (id) => {
      calls.push(`remove ${id}`);
      state.current = {
        ...state.current,
        customThemes: state.current.customThemes.filter((theme) => theme.id !== id),
      };
    },
    setAppearance: (key, value) => {
      calls.push(`appearance ${key}`);
      state.current = {
        ...state.current,
        appearance: { ...state.current.appearance, [key]: value },
      };
    },
    setColorMode: (mode) => {
      if (failOn === "mode") throw new Error("storage full");
      calls.push(`mode ${mode}`);
      state.current = { ...state.current, colorMode: mode };
    },
    setActiveTheme: (id) => {
      calls.push(`theme ${id}`);
      state.current = { ...state.current, activeThemeId: id };
    },
    saveClientSettings: async (patch) => {
      calls.push("save client");
      if (failSave) throw new Error("disk full");
      state.current = { ...state.current, client: { ...state.current.client, ...patch } };
    },
  };
  return { calls, writers };
}

describe("the client settings file", () => {
  it("carries exactly the portable client settings and every appearance setting", () => {
    const file = buildClientSettingsFile(
      { ...defaults, customThemes: [sunset] },
      new Date("2026-10-31T08:00:00Z"),
    );
    expect(Object.keys(file.client).toSorted()).toEqual([...CLIENT_SETTINGS_FILE_KEYS].toSorted());
    expect(Object.keys(file.client)).toHaveLength(21);
    for (const key of [
      "localOnboardingCompletedEnvironmentIds",
      "dismissedProviderUpdateNotificationKeys",
      "favorites",
      "providerModelPreferences",
      "sidebarProjectGroupingOverrides",
      "preferredEditor",
    ]) {
      expect(file.client, key).not.toHaveProperty(key);
    }
    expect(Object.keys(file.appearance).toSorted()).toEqual(
      [...APPEARANCE_PREFERENCE_KEYS].toSorted(),
    );
    expect(file.customThemes).toEqual([sunset]);
    // Nothing that names a connection or a credential.
    expect(JSON.stringify(file)).not.toMatch(/bearerToken|saved-environment|environmentId/u);
  });

  it("reproduces the exported preferences when imported elsewhere", async () => {
    const source: ClientSettingsFileState = {
      client: { ...DEFAULT_CLIENT_SETTINGS, chatWidth: "wide", confirmThreadArchive: true },
      appearance: { ...DEFAULT_APPEARANCE_PREFERENCES, fontSizeBase: "15px", radius: "0.375rem" },
      colorMode: "dark",
      activeThemeId: "custom-sunset",
      customThemes: [sunset],
    };
    const file = JSON.parse(JSON.stringify(buildClientSettingsFile(source, new Date())));
    const plan = planClientSettingsImport(file, defaults, options);
    expect(plan.warnings).toEqual([]);
    const state = { current: defaults };
    await applyClientSettingsImport(plan, defaults, fakeWriters(state).writers);
    expect(state.current).toEqual(source);
  });

  it("changes only what a partial file names, and says how", () => {
    const plan = planClientSettingsImport(
      { format: "ryco-client-settings", version: 1, client: { chatWidth: "wide" } },
      defaults,
      options,
    );
    expect(plan.client).toEqual({ chatWidth: "wide" });
    expect(plan.changes).toEqual(['chatWidth: "comfortable" -> "wide"']);
    expect(plan.appearance).toEqual({});
    expect(plan.colorMode).toBeNull();
  });

  it("keeps the current value for an invalid value or a key it does not carry", () => {
    const plan = planClientSettingsImport(
      {
        format: "ryco-client-settings",
        version: 1,
        client: { chatWidth: "huge", favorites: [], bearerToken: "x" },
        appearance: { fontSizeBase: "99px", notAKey: "1" },
        theme: { mode: "sepia", active: "nowhere" },
      },
      defaults,
      options,
    );
    expect(plan.client).toEqual({});
    expect(plan.appearance).toEqual({});
    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual([
      "chatWidth: invalid value, kept the current one",
      "favorites: not a setting this file carries, left as it is",
      "bearerToken: not a setting this file carries, left as it is",
      "fontSizeBase: invalid value, kept the current one",
      "notAKey: not an appearance setting, left as it is",
      "theme.mode: invalid value, kept the current one",
      'theme.active: no theme "nowhere" here, kept the current one',
    ]);
  });

  it("imports a custom theme with a taken id as a copy, and points the theme at the copy", () => {
    const current = { ...defaults, customThemes: [{ ...sunset, name: "My sunset" }] };
    const plan = planClientSettingsImport(
      {
        format: "ryco-client-settings",
        version: 1,
        theme: { mode: "system", active: "custom-sunset" },
        customThemes: [sunset],
      },
      current,
      options,
    );
    expect(plan.addThemes).toEqual([{ ...sunset, id: "custom-sunset-copy" }]);
    expect(plan.activeThemeId).toBe("custom-sunset-copy");
    // The same theme again is no change.
    expect(
      planClientSettingsImport(
        { format: "ryco-client-settings", version: 1, customThemes: [sunset] },
        { ...defaults, customThemes: [sunset] },
        options,
      ).addThemes,
    ).toEqual([]);
  });

  it("never takes a built-in theme's id, nor an id it already gave out", () => {
    const plan = planClientSettingsImport(
      {
        format: "ryco-client-settings",
        version: 1,
        theme: { mode: "system", active: "nord" },
        customThemes: [
          { id: "nord", name: "My Nord", builtIn: false },
          { id: "a", name: "A", builtIn: false },
          { id: "a-copy", name: "A copy", builtIn: false },
          { id: "a", name: "A again", builtIn: false },
        ],
      },
      { ...defaults, customThemes: [{ id: "a", name: "Local A", builtIn: false }] },
      options,
    );
    const ids = plan.addThemes.map((theme) => theme.id);
    expect(ids).toEqual(["nord-copy", "a-copy", "a-copy-copy", "a-copy-2"]);
    expect(new Set(ids).size).toBe(ids.length);
    // The file's "nord" is its own theme, so the pick follows it, not the built-in one.
    expect(plan.activeThemeId).toBe("nord-copy");
  });

  it("keeps only a theme file's own fields, and reads at most 100 themes", () => {
    const plan = planClientSettingsImport(
      {
        format: "ryco-client-settings",
        version: 1,
        customThemes: [
          { id: "custom-x", name: "X", builtIn: 0, extra: "kept?", light: { primary: "red" } },
          ...Array.from({ length: 120 }, (_, index) => ({
            id: `custom-t${index}`,
            name: `T${index}`,
            builtIn: false,
          })),
        ],
      },
      defaults,
      options,
    );
    expect(plan.addThemes[0]).toEqual({
      id: "custom-x",
      name: "X",
      builtIn: false,
      light: { primary: "red" },
    });
    expect(plan.addThemes).toHaveLength(100);
    expect(plan.warnings).toContain("customThemes: only the first 100 themes were read");
  });

  it("undoes exactly what it wrote when a local write throws", async () => {
    const plan = planClientSettingsImport(
      {
        format: "ryco-client-settings",
        version: 1,
        client: { chatWidth: "full" },
        appearance: { fontSizeBase: "15px" },
        theme: { mode: "dark", active: "custom-sunset" },
        customThemes: [sunset],
      },
      defaults,
      options,
    );
    const state = { current: defaults };
    const { calls, writers } = fakeWriters(state, false, "mode");
    await expect(applyClientSettingsImport(plan, defaults, writers)).rejects.toThrow(
      "storage full",
    );
    expect(state.current).toEqual(defaults);
    expect(calls).not.toContain("save client");
    expect(calls.slice(-2)).toEqual(["appearance fontSizeBase", "remove custom-sunset"]);
  });

  it("undoes every local write when the client settings cannot be saved", async () => {
    const plan = planClientSettingsImport(
      {
        format: "ryco-client-settings",
        version: 1,
        client: { chatWidth: "full" },
        appearance: { fontSizeBase: "15px" },
        theme: { mode: "dark", active: "custom-sunset" },
        customThemes: [sunset],
      },
      defaults,
      options,
    );
    const state = { current: defaults };
    const { calls, writers } = fakeWriters(state, true);
    await expect(applyClientSettingsImport(plan, defaults, writers)).rejects.toThrow("disk full");
    expect(state.current).toEqual(defaults);
    // Client settings are written last, after everything that can be undone.
    expect(calls.indexOf("save client")).toBeGreaterThan(calls.indexOf("theme custom-sunset"));
  });

  it("refuses a file that is not one, or comes from a newer Ryco", () => {
    expect(() => planClientSettingsImport({ hello: 1 }, defaults, options)).toThrow(
      "This is not a Ryco preferences file.",
    );
    expect(() =>
      planClientSettingsImport({ format: "ryco-client-settings", version: 2 }, defaults, options),
    ).toThrow(/newer Ryco/u);
  });
});

// Type check: the scope covers every client setting.
const _everyKey: ReadonlyArray<keyof ClientSettings> = CLIENT_SETTINGS_FILE_KEYS;
void _everyKey;
void (null as unknown as AppearancePreferenceKey);
