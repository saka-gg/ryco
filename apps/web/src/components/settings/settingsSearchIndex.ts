import type { EnvironmentId } from "@ryco/contracts";

import { isElectron, isHostedHubMode } from "../../env";
import type { EnvironmentSettingsTargetState } from "../../hooks/useEnvironmentSettingsTarget";
import { isLocalOnboardingClient } from "../onboarding/localOnboarding";
import {
  SETTINGS_DEVICE_PART_TITLES,
  SETTINGS_GROUP_TITLES,
  settingsSection,
  type SettingsDevicePartId,
  type SettingsPageSectionId,
  type SettingsStorage,
} from "./settingsRegistry";
import {
  settingsSectionListed,
  settingsStorageReachable,
  type SettingsReach,
} from "./settingsSections.logic";

export type SettingsDesktopCapability =
  | "cliCommand"
  | "computerUse"
  | "quitShortcut"
  | "setKeepAwakeMode"
  | "windowCapture"
  | "windowTranslucencySupported";

export interface SettingsSearchEntry {
  /** The row's one home. */
  readonly section: SettingsPageSectionId;
  /**
   * Where the row keeps its value, which decides who reaches it. A `device` row
   * shows the device the page shows; a `this-computer` or `desktop` row lives on
   * this app's own device page.
   */
  readonly storage: Exclude<SettingsStorage, "hub">;
  /** A device page row's part. */
  readonly part?: SettingsDevicePartId;
  readonly localOnboardingOnly?: boolean;
  readonly desktopCapability?: SettingsDesktopCapability;
  readonly title: string;
  readonly description: string;
  /** Extra match terms not present in title/description. */
  readonly keywords?: string;
  /** Optional in-panel target revealed after selecting this result. */
  readonly targetId?: string;
}

/**
 * Static search index over the settings surface. Panels are lazy-mounted, so
 * a runtime registry would only ever see the sections the user has already
 * visited — this manifest is the searchable source of truth instead. When a
 * row is added, moved or renamed, change it here; `settingsHomes.test.ts`
 * fails an entry whose section does not keep rows stored where it says.
 */
export const SETTINGS_SEARCH_INDEX: ReadonlyArray<SettingsSearchEntry> = [
  {
    section: "projects",
    storage: "device",
    title: "Project defaults",
    description:
      "Inherited initial model, effort, thread location, branch prefix, and worktree setup.",
    keywords: "inherit override reset scope project model effort setup",
  },
  {
    section: "about",
    storage: "app",
    title: "Welcome tour",
    description: "Replay provider setup, add a project, and learn the essentials.",
    keywords: "onboarding first run getting started setup",
    localOnboardingOnly: true,
  },
  {
    section: "source-control",
    storage: "app",
    title: "Diff style",
    description: "Preview unified and split layouts for code changes.",
    keywords: "diff design side by side stacked layout",
  },
  {
    section: "device",
    storage: "desktop",
    part: "computer-use",
    title: "Browser Use",
    description: "Pair browsers and manage agent access to local tabs.",
    keywords: "chrome brave edge browser extension",
    desktopCapability: "computerUse",
  },
  {
    section: "keybindings",
    storage: "app",
    title: "Quit shortcut",
    description: "Prevent accidental quits: press twice, hold, or quit immediately.",
    keywords: "ctrl cmd q exit desktop",
    desktopCapability: "quitShortcut",
  },
  {
    section: "projects",
    storage: "app",
    title: "Terminal command",
    description: "Install the ryco command to use this app's node from any terminal.",
    keywords: "cli command line shell path install ryco nightly",
    desktopCapability: "cliCommand",
  },
  {
    section: "chat",
    storage: "app",
    title: "Window capture",
    description: "Capture shortcut and Mac permissions for attaching app windows to the composer.",
    keywords: "screenshot snapshot appsnap screen recording input monitoring option keys hotkey",
    desktopCapability: "windowCapture",
  },
  {
    section: "device",
    storage: "device",
    part: "overview",
    title: "Device name",
    description: "Rename the selected device for everyone who can access it.",
    keywords: "machine hostname node name rename icon",
    targetId: "Device",
  },
  {
    section: "device",
    storage: "device",
    part: "computer-use",
    title: "Device permissions",
    description:
      "Manage permissions on the selected device or learn where local approval is required.",
    keywords: "computer use accessibility screen recording capture device local remote",
  },
  {
    section: "device",
    storage: "desktop",
    part: "computer-use",
    desktopCapability: "computerUse",
    title: "Computer use",
    targetId: "Computer Use",
    description: "Control local apps and browsers, manage permissions, and pair a browser.",
    keywords:
      "accessibility screen recording capture cursor chrome brave edge app access foreground automation",
  },
  {
    section: "inbox",
    storage: "device",
    title: "Auto-settle inactive tasks",
    description: "Move inactive tasks to Settled after their last message or turn.",
    keywords: "housekeeping settled archive inactive threads days",
  },
  {
    section: "appearance",
    storage: "app",
    title: "Time format",
    description: "System default, 12-hour or 24-hour clock.",
    keywords: "clock hours",
  },
  {
    section: "projects",
    storage: "app",
    title: "Default editor",
    description: "Pin which editor opens directories and files.",
    keywords: "vscode cursor open in",
  },
  {
    section: "source-control",
    storage: "app",
    title: "Diff line wrapping",
    description: "Default wrap state when the diff panel opens.",
    keywords: "word wrap",
  },
  {
    section: "source-control",
    storage: "app",
    title: "Hide whitespace changes",
    description: "Whether the diff panel ignores whitespace-only edits.",
    keywords: "diff",
  },
  {
    section: "source-control",
    storage: "app",
    title: "Remote Git status",
    description: "Refresh remote branch and pull request metadata.",
    keywords: "git polling refresh remote",
  },
  {
    section: "source-control",
    storage: "app",
    title: "PR & workflow updates",
    description: "Choose automatic, reduced, or manual pull request and workflow refreshes.",
    keywords: "github actions checks ci polling refresh",
  },
  {
    section: "source-control",
    storage: "app",
    title: "Pull request links in chat",
    description: "Open pull request links on the Pull requests page or in the browser.",
    keywords: "pr link url open browser github gitlab merge request",
  },
  {
    section: "chat",
    storage: "device",
    title: "Response streaming",
    description:
      "Show replies a paragraph at a time, a whole message at a time, or token by token.",
    keywords:
      "stream streaming paragraph token turn whole message buffered output assistant legacy",
    targetId: "shared-setting-responseStreamingMode",
  },
  {
    section: "updates",
    storage: "device",
    title: "Provider update checks",
    description: "Check installed provider CLIs for newer versions.",
    keywords: "upgrade cli",
  },
  {
    section: "device",
    storage: "device",
    part: "power",
    title: "Lower agent CPU priority",
    description: "Run agents and their tests and builds at a lower CPU priority.",
    keywords: "nice cpu priority responsive load performance below normal agent processes",
  },
  {
    section: "projects",
    storage: "device",
    title: "New threads",
    description: "Default workspace mode for newly created drafts.",
    keywords: "local worktree draft",
  },
  {
    section: "projects",
    storage: "device",
    title: "Worktree branch prefix",
    description: "Default prefix for generated worktree branches on this device.",
    keywords: "git namespace branch naming ryco",
  },
  {
    section: "projects",
    storage: "device",
    title: "Worktree root",
    description:
      "Environment worktree directory and project overrides. Existing checkouts keep their paths.",
    keywords: "folder path location inherit reset",
  },
  {
    section: "projects",
    storage: "device",
    title: "Worktree submodules",
    description:
      "Initialization for new worktrees, with project overrides and repository configuration.",
    keywords: "git recursive top-level none initialize inherit",
  },
  {
    section: "projects",
    storage: "device",
    title: "Add project starts in",
    description: "Starting directory for the Add Project browser.",
    keywords: "folder path",
  },
  {
    section: "inbox",
    storage: "app",
    title: "Archive confirmation",
    description: "Ask before archiving a thread.",
    keywords: "confirm",
  },
  {
    section: "inbox",
    storage: "app",
    title: "Delete confirmation",
    description: "Ask before deleting a thread.",
    keywords: "confirm remove",
  },
  {
    section: "inbox",
    storage: "app",
    title: "Unpin confirmation",
    description: "Ask before removing a thread from pinned threads.",
    keywords: "confirm pin unpin favorite",
  },
  {
    section: "notifications",
    storage: "app",
    title: "Thread alerts",
    description: "Notifications or a sound when a thread finishes, fails, or needs you.",
    keywords: "notifications sound badge alerts toast chime approval",
  },
  {
    section: "notifications",
    storage: "app",
    title: "In-app alerts",
    description: "A toast with Open thread when another thread finishes or needs you.",
    keywords: "notifications sound badge alerts toast",
  },
  {
    section: "updates",
    storage: "app",
    title: "Update track",
    description: "Which release channel the app follows.",
    keywords: "beta stable release channel",
  },
  {
    section: "appearance",
    storage: "app",
    title: "Interface font",
    description: "Normal app text, navigation, dialogs, and controls.",
    keywords: "typeface dm sans inter geist",
  },
  {
    section: "appearance",
    storage: "app",
    title: "Code font",
    description: "Code blocks, diffs, file paths, and terminal surfaces.",
    keywords: "monospace jetbrains fira",
  },
  {
    section: "appearance",
    storage: "app",
    title: "Text size",
    description: "Scale the interface independently from the theme.",
    keywords: "zoom font size compact",
  },
  {
    section: "appearance",
    storage: "app",
    title: "Contrast",
    description: "Make text and borders stronger, or softer, than the theme draws them.",
    keywords: "accessibility readability legibility high contrast",
  },
  {
    section: "appearance",
    storage: "app",
    title: "Primary color",
    description: "Accent color for links, focus rings, and actions.",
    keywords: "accent custom violet amber",
  },
  {
    section: "appearance",
    storage: "app",
    title: "Translucent window",
    desktopCapability: "windowTranslucencySupported",
    description: "Let the desktop show through the app window, blurred.",
    keywords: "vibrancy glass transparency translucent see-through wallpaper blur opacity macos",
  },
  {
    section: "appearance",
    storage: "app",
    title: "Theme palette",
    description: "Built-in and custom color themes; import and export.",
    keywords: "dark midnight graphite nord dracula catppuccin",
  },
  {
    section: "keybindings",
    storage: "app",
    title: "Send shortcut",
    description: "Send with Enter, or with Mod+Enter for multiline prompts or always.",
    keywords: "enter return cmd command ctrl multiline new line submit composer",
  },
  {
    section: "chat",
    storage: "app",
    title: "Messages sent while a turn runs",
    description:
      "Queue follow-ups or steer them into the running turn, or do the opposite for one message.",
    keywords: "steer queue follow-up enter mod",
  },
  {
    section: "chat",
    storage: "app",
    title: "Review large Claude resumes",
    description: "Ask before a send resumes a large Claude conversation that sat idle.",
    keywords: "claude cache prompt compact compaction resume idle tokens cost don't ask again",
  },
  {
    section: "chat",
    storage: "app",
    title: "Auto-collapse wide composer labels",
    description: "Show long composer mode labels only on hover or focus.",
    keywords: "chips",
  },
  {
    section: "chat",
    storage: "app",
    title: "Always use Build mode",
    description: "Hide the mode selector and send every turn in Build mode.",
    keywords: "composer",
  },
  {
    section: "appearance",
    storage: "app",
    title: "Chat width",
    description: "How wide messages and the composer grow on large screens.",
    keywords: "comfortable wide full width column layout timeline monitor",
  },
  {
    section: "chat",
    storage: "app",
    title: "Open chat tabs",
    description: "Keep the chats you open as tabs in the chat header, like a browser.",
    keywords: "tabs tab strip header browser open chats threads",
  },
  {
    section: "appearance",
    storage: "app",
    title: "Color mode",
    description: "Light, dark, or follow the system preference.",
    keywords: "color mode dark light",
  },
  {
    section: "source-control",
    storage: "device",
    title: "Writing style",
    description:
      "Write commit messages and pull requests like the repository or as Conventional Commits.",
    keywords: "git commit message pr title conventional commits repository style writing",
  },
  {
    section: "source-control",
    storage: "device",
    title: "Commit message instructions",
    description: "Guide the style of generated commit messages.",
    keywords: "git writing prompt text generation conventional commits custom",
  },
  {
    section: "source-control",
    storage: "device",
    title: "Pull request instructions",
    description: "Guide generated pull request titles and descriptions.",
    keywords: "git writing prompt text generation pr body description before after custom",
  },
  {
    section: "source-control",
    storage: "device",
    title: "Pull request templates",
    description: "Fill pull request descriptions from the repository's template.",
    keywords: "pr template description github gitlab merge request",
  },
  {
    section: "providers",
    storage: "device",
    title: "Provider instances",
    description: "Configure Codex, Claude, Copilot, OpenCode, and Cursor.",
    keywords: "api model driver accent",
  },
  {
    section: "providers",
    storage: "device",
    title: "Where each provider runs",
    description: "Every provider on every device. Add one to a device from its column.",
    keywords: "providers devices table add edit ready sign in",
  },
  {
    section: "agent-control",
    storage: "device",
    title: "Private Agent Control",
    targetId: "Agent Control",
    description: "Pair local Codex or Claude MCP clients with scoped, revocable access.",
    keywords: "model context protocol tools pairing codex claude approval agent control",
  },
  {
    section: "plugins",
    storage: "device",
    title: "MCP Servers",
    description: "Manage Codex, Claude, and other provider-native MCP servers.",
    keywords: "model context protocol tools add server oauth profiles providers",
  },
  {
    section: "keybindings",
    storage: "app",
    title: "Keyboard shortcuts",
    description: "Customize app shortcuts locally or import legacy node bindings.",
    keywords: "shortcuts hotkeys keyboard",
  },
  {
    section: "source-control",
    storage: "device",
    title: "Version Control",
    description: "Git behavior and defaults.",
    keywords: "git commit",
  },
  {
    section: "source-control",
    storage: "device",
    title: "Hosting accounts",
    description: "GitHub and other source control provider connections.",
    keywords: "github pr pull request",
  },
  {
    section: "device",
    storage: "this-computer",
    part: "access",
    title: "Network access",
    description: "Expose the local backend on your network.",
    keywords: "lan host remote",
  },
  {
    section: "device",
    storage: "this-computer",
    part: "access",
    title: "Pairing link",
    description: "Scan to open this backend on another device.",
    keywords: "qr code phone mobile",
    // PAIRING_LINK_TARGET_ID: no heading reads "Pairing link", so it jumps to the Network access row.
    targetId: "pairing-link",
  },
  {
    section: "device",
    storage: "this-computer",
    part: "access",
    title: "Tailscale HTTPS",
    description: "Serve over your tailnet with HTTPS.",
    keywords: "vpn remote",
  },
  {
    section: "device",
    storage: "this-computer",
    part: "power",
    title: "Keep this computer awake",
    desktopCapability: "setKeepAwakeMode",
    description:
      "Stop idle sleep while other devices reach this computer or agents work, on AC power.",
    keywords: "sleep caffeinate power battery plugged in awake agents",
    // DESKTOP_KEEP_AWAKE_ROW_ID: the row's title names the device, so it cannot be the target.
    targetId: "desktop-keep-awake",
  },
  {
    section: "device",
    storage: "this-computer",
    part: "access",
    title: "Authorized clients",
    description: "Devices and sessions allowed to connect.",
    keywords: "revoke tokens",
  },
  {
    section: "updates",
    storage: "app",
    title: "Update everything",
    description: "Update Ryco and its providers on every connected device in one click.",
    keywords: "upgrade release version check for updates node cli provider channel",
  },
  // The section §13.5's copy points an owner at — "Settings → Security explains
  // what else this tab cannot check" — so the terms it sends them looking for
  // have to resolve here. `SettingsPage.test.ts` asserts they do.
  {
    section: "device",
    storage: "device",
    part: "security",
    title: "Session code",
    description: "Compare this browser's channel against the one your node's CLI shows.",
    keywords: "security verification websas e2ee compare short authentication string",
  },
  {
    section: "device",
    storage: "device",
    part: "security",
    title: "Enrollment fingerprint",
    description: "This node's identity, and the prekey and continuity behind it.",
    keywords: "security e2ee key fingerprint rotate lineage",
  },
  {
    section: "device",
    storage: "device",
    part: "security",
    title: "Authorized client keys",
    description: "Approve, reduce, revoke, or delete a client key, and open a pairing window.",
    keywords: "security e2ee pairing fingerprint refused attempts",
  },
  {
    section: "device",
    storage: "device",
    part: "security",
    title: "Admission policy",
    description: "Require E2EE, require approved clients, and advance the policy generation.",
    keywords: "security e2ee strict fallback plaintext",
  },
  {
    section: "diagnostics",
    storage: "device",
    title: "Diagnostics",
    description: "Logs, tracing, resource history, and live activity.",
    keywords: "debug performance slow",
  },
  {
    section: "notifications",
    storage: "app",
    title: "Test notification",
    description: "Fire sample notifications to preview the toast design and stacking.",
    keywords: "toast notifications preview trigger sample",
  },
  {
    section: "usage",
    storage: "device",
    title: "Statistics",
    description: "Usage activity and history.",
    keywords: "heatmap usage tokens",
  },
  {
    section: "usage",
    storage: "device",
    title: "Model prices",
    description: "Custom prices and model mappings for usage cost.",
    keywords: "usage cost price pricing rates override map alias preview gateway unpriced",
  },
  {
    section: "inbox",
    storage: "device-read",
    title: "Archive",
    description: "Archived threads; unarchive or delete them.",
    keywords: "unarchive delete restore retention cleanup suggestions",
  },
  {
    section: "data",
    storage: "device",
    title: "Import conversations",
    description: "Bring Codex or Claude history into Ryco, whole projects at a time.",
    keywords: "import sessions history codex claude migrate",
  },
  {
    section: "data",
    storage: "device",
    title: "Chats folder",
    description: "Where chats without a project keep their files.",
    keywords: "chats root folder path no project cleanup empty",
  },
  {
    section: "data",
    storage: "device",
    title: "Storage",
    description: "What Ryco keeps on this device, retention, and cleanup.",
    keywords: "disk space retention cleanup database shrink compaction worktrees",
  },
  {
    section: "data",
    storage: "device",
    title: "Restore this device's defaults",
    description: "Reset the settings this device keeps to their defaults.",
    keywords: "reset factory clear device",
  },
  {
    section: "data",
    storage: "app",
    title: "Settings file",
    description: "Back up this app's and your devices' shared settings, or restore them.",
    keywords: "backup restore export import json preferences devices",
  },
  {
    section: "data",
    storage: "app",
    title: "Restore this app's defaults",
    description: "Reset this app's settings to their defaults.",
    keywords: "reset factory clear app preferences",
  },
  {
    section: "usage",
    storage: "device",
    title: "Usage limits",
    description: "Resume or snooze threads that hit a usage limit.",
    keywords: "limit rate auto-resume snooze quota",
  },
  {
    section: "plugins",
    storage: "device",
    title: "Ryco plugins",
    description: "Plugins Ryco installs into each agent on this device.",
    keywords: "plugin skills claude codex opinionated install",
  },
  {
    section: "devices",
    storage: "app",
    title: "Remote environments",
    description: "Devices this app connects to, and adding another.",
    keywords: "add device environment remote ssh pair connect hub",
  },
  {
    section: "about",
    storage: "app",
    title: "Version",
    description: "The version of Ryco this app runs.",
    keywords: "about release build check for updates",
  },
];

/**
 * What the settings page can show: this app, and the device it shows values
 * for. Built by {@link readSettingsSearchScope}.
 */
export interface SettingsSearchScope {
  readonly reach: SettingsReach;
  readonly localOnboarding: boolean;
  readonly hasDesktopCapability: (capability: SettingsDesktopCapability) => boolean;
}

/** Who may open which part of settings, for the device the page shows. */
export function readSettingsReach(
  node: Pick<EnvironmentSettingsTargetState, "target" | "isPrimary" | "nodeRole">,
): SettingsReach {
  const hosted = isHostedHubMode();
  return {
    hosted,
    desktopComputerUse: isElectron && Boolean(window.desktopBridge?.computerUse),
    // A hosted role is already null while its snapshot is stale, and a device
    // that is not connected grants nothing until it is.
    device: node.target
      ? { gated: hosted || !node.isPrimary, role: node.target.connected ? node.nodeRole : null }
      : null,
  };
}

export function readSettingsSearchScope(
  node: Pick<EnvironmentSettingsTargetState, "target" | "isPrimary" | "nodeRole">,
): SettingsSearchScope {
  return {
    reach: readSettingsReach(node),
    localOnboarding: isLocalOnboardingClient(),
    hasDesktopCapability: (capability) => Boolean(window.desktopBridge?.[capability]),
  };
}

/**
 * Where a result lives, as the nav names it: "Work › Projects & worktrees", or
 * for a device page row "Devices › <device> › Security".
 */
export function describeSettingsSearchEntry(
  entry: Pick<SettingsSearchEntry, "section" | "part">,
  deviceLabel?: string | null,
): string {
  const section = settingsSection(entry.section);
  const group = SETTINGS_GROUP_TITLES[section.group];
  if (entry.section !== "device") return `${group} › ${section.title}`;
  const part = entry.part ? ` › ${SETTINGS_DEVICE_PART_TITLES[entry.part]}` : "";
  return `${group}${deviceLabel ? ` › ${deviceLabel}` : ""}${part}`;
}

/**
 * Where picking a result opens: its section, on the device the search was
 * checked against, or this app's own device page for a row of this computer;
 * a device page row on its tab.
 */
export function settingsSearchEntryDestination(
  entry: Pick<SettingsSearchEntry, "section" | "storage" | "part">,
  devices: {
    readonly target: EnvironmentId | null;
    readonly primary: EnvironmentId | null;
  },
): {
  readonly section: SettingsPageSectionId;
  readonly environmentId: EnvironmentId | null;
  readonly deviceTab: SettingsDevicePartId | null;
} {
  const ownDevice = entry.storage === "this-computer" || entry.storage === "desktop";
  return {
    section: entry.section,
    environmentId: ownDevice ? (devices.primary ?? devices.target) : devices.target,
    deviceTab: entry.section === "device" ? (entry.part ?? null) : null,
  };
}

/** The entries a settings search lists for `query`, in index order. */
export function filterSettingsSearchEntries(
  query: string,
  scope: SettingsSearchScope,
  entries: ReadonlyArray<SettingsSearchEntry> = SETTINGS_SEARCH_INDEX,
): SettingsSearchEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return [];
  return entries.filter(
    (entry) =>
      settingsSectionListed(entry.section, scope.reach) &&
      settingsStorageReachable(entry.storage, scope.reach) &&
      (!entry.localOnboardingOnly || scope.localOnboarding) &&
      (!entry.desktopCapability || scope.hasDesktopCapability(entry.desktopCapability)) &&
      `${entry.title} ${entry.description} ${entry.keywords ?? ""}`
        .toLowerCase()
        .includes(normalizedQuery),
  );
}
