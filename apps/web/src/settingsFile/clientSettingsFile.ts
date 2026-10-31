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

  const knownIds = new Set(current.customThemes.map((theme) => theme.id));
  const renamedIds = new Map<string, string>();
  const addThemes: ThemeDefinition[] = [];
  for (const raw of Array.isArray(value.customThemes) ? value.customThemes : []) {
    if (!isValidTheme(raw) || raw.builtIn) {
      warnings.push("customThemes: an invalid theme was left out");
      continue;
    }
    const existing = current.customThemes.find((theme) => theme.id === raw.id);
    if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(raw)) continue;
    const id = existing === undefined && !knownIds.has(raw.id) ? raw.id : options.newThemeId(raw);
    if (id !== raw.id) renamedIds.set(raw.id, id);
    knownIds.add(id);
    addThemes.push({ ...raw, id });
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
    const wanted = renamedIds.get(theme.active) ?? theme.active;
    if (!options.themeExists(wanted) && !knownIds.has(wanted)) {
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
 * Writes a plan: themes, appearance, mode and theme, then client settings last. When the client
 * settings cannot be saved, every local value it wrote goes back to what it was, so a failed
 * import leaves nothing half done.
 */
export async function applyClientSettingsImport(
  plan: ClientSettingsImportPlan,
  current: ClientSettingsFileState,
  writers: ClientSettingsImportWriters,
): Promise<void> {
  for (const theme of plan.addThemes) writers.addTheme(theme);
  for (const [key, value] of Object.entries(plan.appearance)) {
    writers.setAppearance(key as AppearancePreferenceKey, value);
  }
  if (plan.colorMode !== null) writers.setColorMode(plan.colorMode);
  if (plan.activeThemeId !== null) writers.setActiveTheme(plan.activeThemeId);
  if (Object.keys(plan.client).length === 0) return;
  try {
    await writers.saveClientSettings(plan.client);
  } catch (error) {
    if (plan.activeThemeId !== null) writers.setActiveTheme(current.activeThemeId);
    if (plan.colorMode !== null) writers.setColorMode(current.colorMode);
    for (const key of Object.keys(plan.appearance) as AppearancePreferenceKey[]) {
      writers.setAppearance(key, current.appearance[key]);
    }
    const existingIds = new Set(current.customThemes.map((theme) => theme.id));
    for (const theme of plan.addThemes) {
      if (!existingIds.has(theme.id)) writers.removeTheme(theme.id);
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
