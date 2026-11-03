/**
 * The settings page's sections, in one place: their ids, nav groups, titles,
 * descriptions, where their rows are stored, the old ids that now open them,
 * and the frozen phone tier's section for each.
 *
 * Pure data. The command palette, the settings store and the app shell's E2EE
 * pointer read it, and they sit in the eagerly loaded app while the settings
 * page is behind a dynamic import (`perf/webBundleSplitting.test.ts`), so this
 * module imports nothing at runtime. Icons and panels live with the page.
 */

/** The five nav groups, in nav order. */
export const SETTINGS_GROUPS = [
  { id: "you", title: "You" },
  { id: "work", title: "Work" },
  { id: "agents", title: "Agents" },
  { id: "devices", title: "Devices" },
  { id: "system", title: "System" },
] as const;

export type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]["id"];

/**
 * Where a part of a section keeps its values, which decides who may open it.
 *
 * - `app`: this app's own preferences (this browser profile or desktop app).
 * - `device`: stored on the device the page shows; only its owner changes it.
 * - `device-read`: the shown device's data that any role may read (archived threads).
 * - `this-computer`: the local backend this app runs (reach, pairing, clients). Never hosted.
 * - `desktop`: needs the desktop app on this computer (computer use).
 * - `hub`: the Hub account. Hosted only; it opens the Hub.
 */
export type SettingsStorage =
  | "app"
  | "device"
  | "device-read"
  | "this-computer"
  | "desktop"
  | "hub";

/** The device page's parts, in page order. Phase 2 turns them into tabs. */
export const SETTINGS_DEVICE_PARTS = [
  { id: "identity", title: "Identity", storage: "device" },
  { id: "access", title: "Access", storage: "this-computer" },
  { id: "security", title: "Security", storage: "device" },
  { id: "computer-use", title: "Computer use", storage: "desktop" },
  { id: "power", title: "Power", storage: "device" },
] as const satisfies ReadonlyArray<{
  readonly id: string;
  readonly title: string;
  readonly storage: SettingsStorage;
}>;

export type SettingsDevicePartId = (typeof SETTINGS_DEVICE_PARTS)[number]["id"];

export const SETTINGS_DEVICE_PART_TITLES: Readonly<Record<SettingsDevicePartId, string>> =
  Object.fromEntries(SETTINGS_DEVICE_PARTS.map((part) => [part.id, part.title])) as Record<
    SettingsDevicePartId,
    string
  >;

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

interface SettingsSectionDefinition {
  readonly id: string;
  readonly group: SettingsGroupId;
  readonly title: string;
  /** One line under the section title. */
  readonly description: string;
  /**
   * Where each part of the section keeps its values. A section is listed when
   * any part is reachable; a part the reader cannot open does not render. An
   * app-only section says "This app" in its header; a section with device parts
   * shows the device bar.
   */
  readonly parts: ReadonlyArray<SettingsStorage>;
  /** The frozen phone tier's section for a request to open this one. */
  readonly phone: PhoneSettingsSectionId;
  /** Opens another page instead of rendering a panel. */
  readonly link?: true;
}

/**
 * Every section, in nav order within its group. `device` is the page of one
 * device: the nav lists it once per known device, never by this title.
 */
export const SETTINGS_SECTIONS = [
  {
    id: "appearance",
    group: "you",
    title: "Appearance",
    description: "How this app looks.",
    parts: ["app"],
    phone: "appearance",
  },
  {
    id: "keybindings",
    group: "you",
    title: "Keyboard",
    description: "Shortcuts and how keys behave.",
    parts: ["app"],
    phone: "keybindings",
  },
  {
    id: "notifications",
    group: "you",
    title: "Notifications",
    description: "When Ryco gets your attention.",
    parts: ["app"],
    phone: "general",
  },
  {
    id: "account",
    group: "you",
    title: "Account",
    description: "Your Hub identity, sign-in and recovery, on the Hub.",
    parts: ["hub"],
    phone: "account",
    link: true,
  },
  {
    id: "chat",
    group: "work",
    title: "Chat & composer",
    description: "Sending, streaming and the composer.",
    parts: ["app", "device"],
    phone: "general",
  },
  {
    id: "inbox",
    group: "work",
    title: "Inbox & threads",
    description: "Settling, confirmations and archived threads.",
    parts: ["device", "app", "device-read"],
    phone: "inbox",
  },
  {
    id: "projects",
    group: "work",
    title: "Projects & worktrees",
    description: "New threads, worktrees and where projects open.",
    parts: ["device", "app"],
    phone: "general",
  },
  {
    id: "source-control",
    group: "work",
    title: "Git & pull requests",
    description: "Commits, pull requests and diffs.",
    parts: ["device", "app"],
    phone: "source-control",
  },
  {
    id: "providers",
    group: "agents",
    title: "Providers & models",
    description: "Coding agents and the models they offer.",
    parts: ["device"],
    phone: "providers",
  },
  {
    id: "usage",
    group: "agents",
    title: "Usage & cost",
    description: "Limits, prices and statistics.",
    parts: ["device"],
    phone: "general",
  },
  {
    id: "plugins",
    group: "agents",
    title: "Plugins & MCP",
    description: "What each agent can reach beyond the chat.",
    parts: ["device"],
    phone: "opinionated-plugins",
  },
  {
    id: "agent-control",
    group: "agents",
    title: "Agent Control",
    description: "Let local Codex or Claude clients drive Ryco, with scoped, revocable access.",
    parts: ["device"],
    phone: "general",
  },
  {
    id: "devices",
    group: "devices",
    title: "All devices",
    description: "Every device this app reaches. Open one for its own settings.",
    parts: ["app", "this-computer"],
    phone: "connections",
  },
  {
    id: "device",
    group: "devices",
    title: "Device",
    description: "Settings stored on this device.",
    parts: SETTINGS_DEVICE_PARTS.map((part) => part.storage),
    phone: "security",
  },
  {
    id: "updates",
    group: "system",
    title: "Updates",
    description: "Ryco and its providers on every device.",
    parts: ["app", "device"],
    phone: "general",
  },
  {
    id: "data",
    group: "system",
    title: "Data & backup",
    description: "Imports, storage and your settings file.",
    parts: ["device", "app"],
    phone: "general",
  },
  {
    id: "diagnostics",
    group: "system",
    title: "Diagnostics",
    description: "Logs, traces and resource history.",
    parts: ["device"],
    phone: "diagnostics",
  },
  {
    id: "about",
    group: "system",
    title: "About & help",
    description: "Version, tour and docs.",
    parts: ["app"],
    phone: "general",
  },
] as const satisfies ReadonlyArray<SettingsSectionDefinition>;

export type SettingsPageSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export type SettingsSection = SettingsSectionDefinition & { readonly id: SettingsPageSectionId };

/**
 * Section ids from before the regroup. They still open settings, from stale
 * callers, deep links, and the frozen phone tier, and the page redirects each
 * to its new home ({@link resolveSettingsPageSection}).
 */
export const LEGACY_SETTINGS_SECTIONS = [
  "general",
  "opinionated-plugins",
  "mcp-servers",
  "integrations",
  "computer-use",
  "connections",
  "security",
  "statistics",
  "archived",
] as const;

export type LegacySettingsSectionId = (typeof LEGACY_SETTINGS_SECTIONS)[number];

/** Any section a caller may ask settings to open. */
export type SettingsSectionId = SettingsPageSectionId | LegacySettingsSectionId;

/**
 * Where each old id lands. `general` held thirty unrelated rows, so it lands
 * on the first section; a caller that wants a row asks for its new section.
 */
const LEGACY_SECTION_HOMES = {
  general: "appearance",
  "opinionated-plugins": "plugins",
  "mcp-servers": "plugins",
  integrations: "agent-control",
  "computer-use": "device",
  connections: "devices",
  security: "device",
  statistics: "usage",
  archived: "inbox",
} as const satisfies Record<LegacySettingsSectionId, SettingsPageSectionId>;

const SECTIONS_BY_ID: ReadonlyMap<string, SettingsSection> = new Map(
  SETTINGS_SECTIONS.map((section) => [section.id, section]),
);

export function isSettingsPageSectionId(id: string): id is SettingsPageSectionId {
  return SECTIONS_BY_ID.has(id);
}

export function settingsSection(id: SettingsPageSectionId): SettingsSection {
  return SECTIONS_BY_ID.get(id)!;
}

/** The section the page shows for any id a caller asked for. */
export function resolveSettingsPageSection(id: SettingsSectionId): SettingsPageSectionId {
  return isSettingsPageSectionId(id) ? id : LEGACY_SECTION_HOMES[id];
}

/** The frozen phone tier's section for any id a caller asked for. */
export function resolvePhoneSettingsSection(id: SettingsSectionId): PhoneSettingsSectionId {
  if (!isSettingsPageSectionId(id)) {
    // Old ids the phone tier never listed open the phone home of their new section.
    return id === "integrations" || id === "computer-use" ? "general" : id;
  }
  return settingsSection(id).phone;
}

/** Section titles by id, so the command palette can name a section without loading it. */
export const SETTINGS_SECTION_TITLES: Readonly<Record<SettingsPageSectionId, string>> =
  Object.fromEntries(SETTINGS_SECTIONS.map((section) => [section.id, section.title])) as Record<
    SettingsPageSectionId,
    string
  >;

export const SETTINGS_GROUP_TITLES: Readonly<Record<SettingsGroupId, string>> = Object.fromEntries(
  SETTINGS_GROUPS.map((group) => [group.id, group.title]),
) as Record<SettingsGroupId, string>;

/**
 * Labels copy may name, by id: each section's title, and each device page
 * part's title under `device:<part>`. `SettingsPage.test.ts` holds copy that
 * points at a place in settings (the E2EE pointer at a device's Security) to
 * these labels, so a rename fails a test instead of stranding the pointer.
 */
export const SETTINGS_SECTION_LABELS: ReadonlyMap<string, string> = new Map<string, string>([
  ...SETTINGS_SECTIONS.map((section) => [section.id, section.title] as const),
  ...SETTINGS_GROUPS.map((group) => [`group:${group.id}`, group.title] as const),
  ...SETTINGS_DEVICE_PARTS.map((part) => [`device:${part.id}`, part.title] as const),
]);
