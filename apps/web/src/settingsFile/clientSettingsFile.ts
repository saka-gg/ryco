import { ClientSettingsSchema, type ClientSettings } from "@ryco/contracts/settings";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  APPEARANCE_PREFERENCE_KEYS,
  type AppearancePreferenceKey,
  type AppearancePreferences,
  isValidPreferenceValue,
} from "../themes/appearancePreferences";
import { isValidTheme } from "../themes/registry";
import type { ThemeDefinition } from "../themes/types";

/**
 * One file with this app's own preferences (port of T3 Code's device settings file, #23045):
 * client settings, appearance, the color mode and theme, and custom themes. Nothing a node owns,
 * and nothing that names a machine, an account or a credential, is ever in it. Keybindings keep
 * their own file (Settings > Keybindings).
 */

export const CLIENT_SETTINGS_FILE_FORMAT = "ryco-client-settings";
export const CLIENT_SETTINGS_FILE_VERSION = 1;
/** Checked before a file is read. */
export const MAX_CLIENT_SETTINGS_FILE_BYTES = 1024 * 1024;
/** At most this many custom themes are read from one file; each is saved with the whole list. */
export const MAX_IMPORTED_THEMES = 100;

/**
 * Which client settings travel. Every key must be placed: a key added to `ClientSettingsSchema`
 * fails typecheck here until someone decides. Left out: what names this browser's machines or
 * local state (node ids, provider instance ids, project ids, installed editors).
 */
export const CLIENT_SETTINGS_FILE_SCOPE = {
  localOnboardingCompletedEnvironmentIds: false,
  confirmThreadArchive: true,
  confirmThreadDelete: true,
  confirmThreadUnpin: true,
  dismissedProviderUpdateNotificationKeys: false,
  diffIgnoreWhitespace: true,
  diffWordWrap: true,
  changeRequestLinkTarget: true,
  followUpBehavior: true,
  sendShortcut: true,
  claudeResumeReview: true,
  chatWidth: true,
  favorites: false,
  providerModelPreferences: false,
  sidebarProjectGroupingMode: true,
  sidebarProjectGroupingOverrides: false,
  sidebarProjectSortOrder: true,
  sidebarThreadSortOrder: true,
  sidebarAutoSettleAfterDays: true,
  timestampFormat: true,
  preferredEditor: false,
  gitStatusPollIntervalMs: true,
  sourceControlRefreshMode: true,
  notifyOnTurnCompleteWhenUnfocused: true,
  threadNotificationSound: true,
  threadNotificationToasts: true,
} as const satisfies Record<keyof ClientSettings, boolean>;

type FileClientKey = {
  [
    K in keyof typeof CLIENT_SETTINGS_FILE_SCOPE
  ]: (typeof CLIENT_SETTINGS_FILE_SCOPE)[K] extends true ? K : never;
}[keyof typeof CLIENT_SETTINGS_FILE_SCOPE];

export const CLIENT_SETTINGS_FILE_KEYS = Object.keys(CLIENT_SETTINGS_FILE_SCOPE).filter(
  (key) => CLIENT_SETTINGS_FILE_SCOPE[key as keyof ClientSettings],
) as ReadonlyArray<FileClientKey>;

export type ColorMode = "system" | "light" | "dark";
const COLOR_MODES: ReadonlySet<string> = new Set(["system", "light", "dark"]);

export interface ClientSettingsFileState {
  readonly client: ClientSettings;
  readonly appearance: AppearancePreferences;
  readonly colorMode: ColorMode;
  readonly activeThemeId: string;
  readonly customThemes: ReadonlyArray<ThemeDefinition>;
}

export interface ClientSettingsFile {
  readonly format: typeof CLIENT_SETTINGS_FILE_FORMAT;
  readonly version: typeof CLIENT_SETTINGS_FILE_VERSION;
  readonly exportedAt: string;
  readonly client: Partial<Pick<ClientSettings, FileClientKey>>;
  readonly appearance: Partial<AppearancePreferences>;
  readonly theme: { readonly mode: ColorMode; readonly active: string };
  readonly customThemes: ReadonlyArray<ThemeDefinition>;
}

export function buildClientSettingsFile(
  state: ClientSettingsFileState,
  now: Date,
): ClientSettingsFile {
  const client: Record<string, unknown> = {};
  for (const key of CLIENT_SETTINGS_FILE_KEYS) client[key] = state.client[key];
  return {
    format: CLIENT_SETTINGS_FILE_FORMAT,
    version: CLIENT_SETTINGS_FILE_VERSION,
    exportedAt: now.toISOString(),
    client: client as ClientSettingsFile["client"],
    appearance: { ...state.appearance },
    theme: { mode: state.colorMode, active: state.activeThemeId },
    customThemes: state.customThemes.filter((theme) => !theme.builtIn),
  };
}

/** What importing a file would do, before anything is written. */
export interface ClientSettingsImportPlan {
  readonly client: Partial<ClientSettings>;
  readonly appearance: Partial<AppearancePreferences>;
  readonly colorMode: ColorMode | null;
  readonly activeThemeId: string | null;
  /** Custom themes to add; an existing id with other content arrives renamed. */
  readonly addThemes: ReadonlyArray<ThemeDefinition>;
  /** `key: old -> new` for every value that changes. */
  readonly changes: ReadonlyArray<string>;
  /** Keys it did not know and values it refused; the current ones stay. */
  readonly warnings: ReadonlyArray<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const show = (value: unknown): string => {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.length > 60 ? `${text.slice(0, 57)}…` : text;
};

/**
 * Reads a file against the current state. Untrusted: every value is checked against the schema
 * of its key; an unknown key or a refused value becomes a warning and keeps the current value.
 */
export function planClientSettingsImport(
  value: unknown,
  current: ClientSettingsFileState,
  options: {
    readonly newThemeId: (theme: ThemeDefinition) => string;
    /** A built-in theme, or a custom one saved here. */
    readonly themeExists: (id: string) => boolean;
  },
): ClientSettingsImportPlan {
  if (!isRecord(value) || value.format !== CLIENT_SETTINGS_FILE_FORMAT) {
    throw new Error("This is not a Ryco preferences file.");
  }
  if (value.version !== CLIENT_SETTINGS_FILE_VERSION) {
    throw new Error("This preferences file comes from a newer Ryco. Update Ryco, then import it.");
  }
  const warnings: string[] = [];
  const changes: string[] = [];

  const client: Record<string, unknown> = {};
  if (value.client !== undefined && !isRecord(value.client)) warnings.push("client: not an object");
  for (const [key, raw] of Object.entries(isRecord(value.client) ? value.client : {})) {
    if (!(CLIENT_SETTINGS_FILE_KEYS as ReadonlyArray<string>).includes(key)) {
      warnings.push(`${key}: not a setting this file carries, left as it is`);
      continue;
    }
    const field = ClientSettingsSchema.fields[key as FileClientKey];
    const decoded = Schema.decodeUnknownOption(field as Schema.Decoder<unknown>)(raw);
    if (Option.isNone(decoded)) {
      warnings.push(`${key}: invalid value, kept the current one`);
      continue;
    }
    const previous = current.client[key as FileClientKey];
    if (Equal.equals(previous, decoded.value)) continue;
    client[key] = decoded.value;
    changes.push(`${key}: ${show(previous)} -> ${show(decoded.value)}`);
  }

  const appearance: Partial<Record<AppearancePreferenceKey, string>> = {};
  for (const [key, raw] of Object.entries(isRecord(value.appearance) ? value.appearance : {})) {
    if (!(APPEARANCE_PREFERENCE_KEYS as ReadonlyArray<string>).includes(key)) {
      warnings.push(`${key}: not an appearance setting, left as it is`);
      continue;
    }
    const appearanceKey = key as AppearancePreferenceKey;
    if (!isValidPreferenceValue(appearanceKey, raw)) {
      warnings.push(`${key}: invalid value, kept the current one`);
      continue;
    }
    if (current.appearance[appearanceKey] === raw) continue;
    appearance[appearanceKey] = raw;
    changes.push(`${key}: ${show(current.appearance[appearanceKey])} -> ${show(raw)}`);
  }

  // An id is taken by any theme here (built-in or saved) and by every id this import gave out.
  const givenIds = new Set<string>();
  const taken = (id: string) =>
    givenIds.has(id) ||
    options.themeExists(id) ||
    current.customThemes.some((theme) => theme.id === id);
  const freeId = (imported: ThemeDefinition) => {
    const base = options.newThemeId(imported);
    if (!taken(base)) return base;
    let attempt = 2;
    while (taken(`${base}-${attempt}`)) attempt += 1;
    return `${base}-${attempt}`;
  };
  // The file's id of each theme to the id it got here: the first theme with that id decides.
  const importedIds = new Map<string, string>();
  const addThemes: ThemeDefinition[] = [];
  const rawThemes = Array.isArray(value.customThemes) ? value.customThemes : [];
  if (rawThemes.length > MAX_IMPORTED_THEMES) {
    warnings.push(`customThemes: only the first ${MAX_IMPORTED_THEMES} themes were read`);
  }
  for (const raw of rawThemes.slice(0, MAX_IMPORTED_THEMES)) {
    if (!isValidTheme(raw) || raw.builtIn) {
      warnings.push("customThemes: an invalid theme was left out");
      continue;
    }
    // Only a theme file's own fields, as `parseTheme` reads them.
    const imported: ThemeDefinition = {
      id: raw.id,
      name: raw.name,
      builtIn: false,
      ...(raw.description ? { description: raw.description } : {}),
      ...(raw.light ? { light: { ...raw.light } } : {}),
      ...(raw.dark ? { dark: { ...raw.dark } } : {}),
    };
    const existing = current.customThemes.find((theme) => theme.id === raw.id);
    if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(imported)) {
      if (!importedIds.has(raw.id)) importedIds.set(raw.id, raw.id);
      continue;
    }
    const id = taken(raw.id) ? freeId(imported) : raw.id;
    if (!importedIds.has(raw.id)) importedIds.set(raw.id, id);
    givenIds.add(id);
    addThemes.push({ ...imported, id });
    changes.push(`custom theme: ${raw.name}${id === raw.id ? "" : " (as a copy)"}`);
  }

  const theme = isRecord(value.theme) ? value.theme : {};
  let colorMode: ColorMode | null = null;
  if (theme.mode !== undefined) {
    if (typeof theme.mode === "string" && COLOR_MODES.has(theme.mode)) {
      if (theme.mode !== current.colorMode) {
        colorMode = theme.mode as ColorMode;
        changes.push(`color mode: ${current.colorMode} -> ${colorMode}`);
      }
    } else {
      warnings.push("theme.mode: invalid value, kept the current one");
    }
  }
  let activeThemeId: string | null = null;
  if (typeof theme.active === "string") {
    const wanted = importedIds.get(theme.active) ?? theme.active;
    if (!options.themeExists(wanted) && !givenIds.has(wanted)) {
      warnings.push(`theme.active: no theme ${show(theme.active)} here, kept the current one`);
    } else if (wanted !== current.activeThemeId) {
      activeThemeId = wanted;
      changes.push(`theme: ${current.activeThemeId} -> ${wanted}`);
    }
  }

  return {
    client: client as Partial<ClientSettings>,
    appearance,
    colorMode,
    activeThemeId,
    addThemes,
    changes,
    warnings,
  };
}

/** Where an import writes. Injected, so the order and the rollback are tested without mocks. */
export interface ClientSettingsImportWriters {
  readonly addTheme: (theme: ThemeDefinition) => void;
  readonly removeTheme: (id: string) => void;
  readonly setAppearance: (key: AppearancePreferenceKey, value: string) => void;
  readonly setColorMode: (mode: ColorMode) => void;
  readonly setActiveTheme: (id: string) => void;
  /** Rejects when the client settings could not be saved. */
  readonly saveClientSettings: (patch: Partial<ClientSettings>) => Promise<void>;
}

/**
 * Writes a plan: themes, appearance, mode and theme, then client settings last. When any write
 * fails (a full storage throws, the client settings may not save), exactly the writes made so far
 * are undone, newest first, so a failed import leaves nothing half done.
 */
export async function applyClientSettingsImport(
  plan: ClientSettingsImportPlan,
  current: ClientSettingsFileState,
  writers: ClientSettingsImportWriters,
): Promise<void> {
  const undo: Array<() => void> = [];
  const existingIds = new Set(current.customThemes.map((theme) => theme.id));
  try {
    for (const theme of plan.addThemes) {
      // Never removes a theme that was there before the import.
      if (existingIds.has(theme.id)) continue;
      writers.addTheme(theme);
      undo.push(() => writers.removeTheme(theme.id));
    }
    for (const [key, value] of Object.entries(plan.appearance)) {
      const appearanceKey = key as AppearancePreferenceKey;
      writers.setAppearance(appearanceKey, value);
      undo.push(() => writers.setAppearance(appearanceKey, current.appearance[appearanceKey]));
    }
    if (plan.colorMode !== null) {
      writers.setColorMode(plan.colorMode);
      undo.push(() => writers.setColorMode(current.colorMode));
    }
    if (plan.activeThemeId !== null) {
      writers.setActiveTheme(plan.activeThemeId);
      undo.push(() => writers.setActiveTheme(current.activeThemeId));
    }
    if (Object.keys(plan.client).length > 0) await writers.saveClientSettings(plan.client);
  } catch (error) {
    for (const step of undo.toReversed()) {
      try {
        step();
      } catch {
        // One failed undo must not keep the others from running.
      }
    }
    throw error;
  }
}

/** Reads a picked file into an import plan; throws a message for the person picking it. */
export async function readClientSettingsImportFile(
  file: Pick<File, "size" | "text">,
  current: ClientSettingsFileState,
  options: Parameters<typeof planClientSettingsImport>[2],
): Promise<ClientSettingsImportPlan> {
  if (file.size > MAX_CLIENT_SETTINGS_FILE_BYTES) {
    throw new Error("A preferences file is never larger than 1 MiB.");
  }
  let value: unknown;
  try {
    value = JSON.parse(await file.text());
  } catch {
    throw new Error("This file is not JSON.");
  }
  return planClientSettingsImport(value, current, options);
}
