/**
 * The web settings page's section registry: the shared section model
 * (`@ryco/client-runtime/state/settings/settingsSections`, also read by the
 * mobile app), the frozen phone tier's sections, and the settings address.
 *
 * Pure data. The command palette, the settings store and the app shell's E2EE
 * pointer read it, and they sit in the eagerly loaded app while the settings
 * page is behind a dynamic import (`perf/webBundleSplitting.test.ts`), so this
 * module imports nothing at runtime beyond that pure model. Icons and panels
 * live with the page.
 */
import {
  isSettingsDevicePartId,
  isSettingsPageSectionId,
  isSettingsSectionId,
  type SettingsDevicePartId,
  type SettingsPageSectionId,
  type SettingsSectionId,
} from "@ryco/client-runtime/state/settings/settingsSections";

export * from "@ryco/client-runtime/state/settings/settingsSections";

/**
 * The sections the frozen web phone tier still navigates (`PhoneSettingsSurface`).
 * AGENTS.md: that tier is not extended, so it keeps the inventory it shipped with.
 */
export const PHONE_SETTINGS_SECTIONS = [
  "account",
  "general",
  "inbox",
  "providers",
  "opinionated-plugins",
  "mcp-servers",
  "appearance",
  "keybindings",
  "source-control",
  "connections",
  "security",
  "statistics",
  "archived",
  "diagnostics",
] as const;

export type PhoneSettingsSectionId = (typeof PHONE_SETTINGS_SECTIONS)[number];

/** The frozen phone tier's section for a request to open each page section. */
const PHONE_SECTION_FOR = {
  appearance: "appearance",
  keybindings: "keybindings",
  notifications: "general",
  account: "account",
  chat: "general",
  inbox: "inbox",
  projects: "general",
  "source-control": "source-control",
  providers: "providers",
  usage: "general",
  plugins: "opinionated-plugins",
  "agent-control": "general",
  devices: "connections",
  device: "security",
  updates: "general",
  data: "general",
  diagnostics: "diagnostics",
  about: "general",
} as const satisfies Record<SettingsPageSectionId, PhoneSettingsSectionId>;

/**
 * Where the settings page is, as its address carries it (`/settings?section=…`):
 * the section, a device page's tab, and outside hosted mode the device. A named
 * device opens on its own values; where the device bar offers "All devices",
 * `view=all` says every device's show instead. The page keeps it in step with
 * the settings store, so Back and Forward, and a link, open the same device,
 * view and tab.
 */
export interface SettingsLocationSearch {
  readonly section?: SettingsSectionId;
  readonly device?: string;
  readonly view?: "all";
  readonly tab?: SettingsDevicePartId;
}

/** The `/settings` route's search, with anything unknown dropped. */
export function parseSettingsLocationSearch(
  search: Record<string, unknown>,
): SettingsLocationSearch {
  const section =
    typeof search.section === "string" && isSettingsSectionId(search.section)
      ? search.section
      : undefined;
  const tab =
    typeof search.tab === "string" && isSettingsDevicePartId(search.tab) ? search.tab : undefined;
  const device =
    typeof search.device === "string" && search.device.length > 0 && search.device.length <= 256
      ? search.device
      : undefined;
  // The view chooses between a named device's values and every device's.
  const view = device && search.view === "all" ? search.view : undefined;
  return {
    ...(section ? { section } : {}),
    ...(device ? { device } : {}),
    ...(view ? { view } : {}),
    ...(tab ? { tab } : {}),
  };
}

/** One string per location, equal while the location is. */
export function settingsLocationKey(search: SettingsLocationSearch): string {
  return [search.section ?? "", search.device ?? "", search.view ?? "", search.tab ?? ""].join(
    "\n",
  );
}

/** The frozen phone tier's section for any id a caller asked for. */
export function resolvePhoneSettingsSection(id: SettingsSectionId): PhoneSettingsSectionId {
  if (!isSettingsPageSectionId(id)) {
    // Old ids the phone tier never listed open the phone home of their new section.
    return id === "integrations" || id === "computer-use" ? "general" : id;
  }
  return PHONE_SECTION_FOR[id];
}
