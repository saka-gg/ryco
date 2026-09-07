import type { SettingsSectionId } from "../../settingsDialogStore";

export interface SettingsSearchEntry {
  readonly section: SettingsSectionId;
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
 * row is added or renamed, add it here; the settings browser test asserting
 * search results keeps the prominent entries honest.
 */
export const SETTINGS_SEARCH_INDEX: ReadonlyArray<SettingsSearchEntry> = [
  {
    section: "computer-use",
    title: "Computer use",
    description: "Control local apps and browsers, manage permissions, and pair a browser.",
    keywords:
      "accessibility screen recording capture cursor chrome brave edge app access foreground automation",
  },
  {
    section: "inbox",
    title: "AI Focus",
    description: "Prioritize the Inbox with bounded, environment-local model ranking.",
    keywords: "priority sort active threads model ranking focus refresh",
  },
  {
    section: "inbox",
    title: "AI Focus models",
    description: "Choose or inherit the ranking model for each connected environment.",
    keywords: "provider node disclosure privacy data",
  },
  {
    section: "general",
    title: "Time format",
    description: "System default, 12-hour or 24-hour clock.",
    keywords: "clock hours",
  },
  {
    section: "general",
    title: "Default editor",
    description: "Pin which editor opens directories and files.",
    keywords: "vscode cursor open in",
  },
  {
    section: "general",
    title: "Diff line wrapping",
    description: "Default wrap state when the diff panel opens.",
    keywords: "word wrap",
  },
  {
    section: "general",
    title: "Hide whitespace changes",
    description: "Whether the diff panel ignores whitespace-only edits.",
    keywords: "diff",
  },
  {
    section: "general",
    title: "Remote Git status",
    description: "Refresh remote branch and pull request metadata.",
    keywords: "git polling refresh remote",
  },
  {
    section: "general",
    title: "PR & workflow updates",
    description: "Choose automatic, reduced, or manual pull request and workflow refreshes.",
    keywords: "github actions checks ci polling refresh",
  },
  {
    section: "general",
    title: "Stream token by token (legacy)",
    description: "Compatibility mode for token-by-token assistant output.",
    keywords: "token streaming assistant output streaming tokens buffered",
    targetId: "legacy-token-streaming",
  },
  {
    section: "general",
    title: "Provider update checks",
    description: "Check installed provider CLIs for newer versions.",
    keywords: "upgrade cli",
  },
  {
    section: "general",
    title: "Auto-open overview",
    description: "Open the overview when plans or progress appear.",
    keywords: "panel plan",
  },
  {
    section: "general",
    title: "New threads",
    description: "Default workspace mode for newly created drafts.",
    keywords: "local worktree draft",
  },
  {
    section: "general",
    title: "Add project starts in",
    description: "Starting directory for the Add Project browser.",
    keywords: "folder path",
  },
  {
    section: "general",
    title: "Archive confirmation",
    description: "Ask before archiving a thread.",
    keywords: "confirm",
  },
  {
    section: "general",
    title: "Delete confirmation",
    description: "Ask before deleting a thread.",
    keywords: "confirm remove",
  },
  {
    section: "general",
    title: "Unpin confirmation",
    description: "Ask before removing a thread from pinned threads.",
    keywords: "confirm pin unpin favorite",
  },
  {
    section: "general",
    title: "Update track",
    description: "Which release channel the app follows.",
    keywords: "beta stable release channel",
  },
  {
    section: "appearance",
    title: "Interface font",
    description: "Normal app text, navigation, dialogs, and controls.",
    keywords: "typeface dm sans inter geist",
  },
  {
    section: "appearance",
    title: "Code font",
    description: "Code blocks, diffs, file paths, and terminal surfaces.",
    keywords: "monospace jetbrains fira",
  },
  {
    section: "appearance",
    title: "Text size",
    description: "Scale the interface independently from the theme.",
    keywords: "zoom font size compact",
  },
  {
    section: "appearance",
    title: "Corner radius",
    description: "Rounding for panels, buttons, inputs, and menus.",
    keywords: "round square",
  },
  {
    section: "appearance",
    title: "Primary color",
    description: "Accent color for links, focus rings, and actions.",
    keywords: "accent custom violet amber",
  },
  {
    section: "appearance",
    title: "Transparency",
    description: "Glass and floating surfaces like dialogs, menus, popups.",
    keywords: "glass blur liquid material solid",
  },
  {
    section: "appearance",
    title: "Theme palette",
    description: "Built-in and custom color themes; import and export.",
    keywords: "dark midnight graphite nord dracula catppuccin",
  },
  {
    section: "appearance",
    title: "Auto-collapse wide composer labels",
    description: "Show long composer mode labels only on hover or focus.",
    keywords: "chips",
  },
  {
    section: "appearance",
    title: "Always use Build mode",
    description: "Hide the mode selector and send every turn in Build mode.",
    keywords: "composer",
  },
  {
    section: "appearance",
    title: "Theme variant",
    description: "Light, dark, or follow the system preference.",
    keywords: "color mode dark light",
  },
  {
    section: "providers",
    title: "Provider instances",
    description: "Configure Codex, Claude, Copilot, OpenCode, and Cursor.",
    keywords: "api model driver accent",
  },
  {
    section: "mcp-servers",
    title: "External integrations",
    description: "Pair local Codex or Claude MCP clients with scoped, revocable access.",
    keywords: "model context protocol tools pairing codex claude approval agent control",
  },
  {
    section: "mcp-servers",
    title: "MCP Servers",
    description: "Manage Codex, Claude, and other provider-native MCP servers.",
    keywords: "model context protocol tools add server oauth profiles providers",
  },
  {
    section: "keybindings",
    title: "Keybindings file",
    description: "Customize shortcuts via the keybindings configuration file.",
    keywords: "shortcuts hotkeys keyboard",
  },
  {
    section: "source-control",
    title: "Version Control",
    description: "Git behavior and defaults.",
    keywords: "git commit",
  },
  {
    section: "source-control",
    title: "Source Control Providers",
    description: "GitHub and other source control provider connections.",
    keywords: "github pr pull request",
  },
  {
    section: "connections",
    title: "Network access",
    description: "Expose the local backend on your network.",
    keywords: "lan host remote",
  },
  {
    section: "connections",
    title: "Pairing link",
    description: "Scan to open this backend on another device.",
    keywords: "qr code phone mobile",
  },
  {
    section: "connections",
    title: "Tailscale HTTPS",
    description: "Serve over your tailnet with HTTPS.",
    keywords: "vpn remote",
  },
  {
    section: "connections",
    title: "Authorized clients",
    description: "Devices and sessions allowed to connect.",
    keywords: "revoke tokens",
  },
  // The section §13.5's copy points an owner at — "Settings → Security explains
  // what else this tab cannot check" — so the terms it sends them looking for
  // have to resolve here. `SettingsDialog.test.ts` asserts they do.
  {
    section: "security",
    title: "Session code",
    description: "Compare this browser's channel against the one your node's CLI shows.",
    keywords: "security verification websas e2ee compare short authentication string",
  },
  {
    section: "security",
    title: "Enrollment fingerprint",
    description: "This node's identity, and the prekey and continuity behind it.",
    keywords: "security e2ee key fingerprint rotate lineage",
  },
  {
    section: "security",
    title: "Authorized client keys",
    description: "Approve, reduce, revoke, or delete a client key, and open a pairing window.",
    keywords: "security e2ee pairing fingerprint refused attempts",
  },
  {
    section: "security",
    title: "Admission policy",
    description: "Require E2EE, require approved clients, and advance the policy generation.",
    keywords: "security e2ee strict fallback plaintext",
  },
  {
    section: "diagnostics",
    title: "Diagnostics",
    description: "Logs, tracing, resource history, and live activity.",
    keywords: "debug performance slow",
  },
  {
    section: "diagnostics",
    title: "Test notification",
    description: "Fire sample notifications to preview the toast design and stacking.",
    keywords: "toast notifications preview trigger sample",
  },
  {
    section: "statistics",
    title: "Statistics",
    description: "Usage activity and history.",
    keywords: "heatmap usage tokens",
  },
  {
    section: "archived",
    title: "Archive",
    description: "Archived threads; restore or delete permanently.",
    keywords: "trash restore",
  },
];
