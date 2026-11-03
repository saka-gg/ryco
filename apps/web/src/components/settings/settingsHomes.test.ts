import type { ClientSettings, ServerSettings } from "@ryco/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { KEYBINDING_SEARCH_ENTRIES } from "./keybindingSearchEntries";
import {
  isSettingsPageSectionId,
  settingsSection,
  type SettingsPageSectionId,
  type SettingsStorage,
} from "./settingsRegistry";
import { SETTINGS_SEARCH_INDEX } from "./settingsSearchIndex";

/**
 * Where each setting is edited: its one section, or null when settings never
 * show it (state kept by other surfaces). Typed over every key, so a setting
 * added to `ClientSettingsSchema` or `ServerSettings` fails typecheck here until
 * someone gives it a home.
 */
const CLIENT_SETTING_HOMES = {
  localOnboardingCompletedEnvironmentIds: null,
  confirmThreadArchive: "inbox",
  confirmThreadDelete: "inbox",
  confirmThreadUnpin: "inbox",
  dismissedProviderUpdateNotificationKeys: null,
  diffIgnoreWhitespace: "source-control",
  diffWordWrap: "source-control",
  changeRequestLinkTarget: "source-control",
  followUpBehavior: "chat",
  sendShortcut: "keybindings",
  claudeResumeReview: "chat",
  chatWidth: "appearance",
  openChatTabs: "chat",
  // The model picker and the sidebar's own menus keep these.
  favorites: null,
  providerModelPreferences: null,
  sidebarProjectGroupingMode: null,
  sidebarProjectGroupingOverrides: null,
  sidebarProjectSortOrder: null,
  sidebarThreadSortOrder: null,
  // This app's own rule, for devices too old to keep one (`InboxSettings`).
  sidebarAutoSettleAfterDays: "inbox",
  timestampFormat: "appearance",
  preferredEditor: "projects",
  gitStatusPollIntervalMs: "source-control",
  sourceControlRefreshMode: "source-control",
  notifyOnTurnCompleteWhenUnfocused: "notifications",
  threadNotificationSound: "notifications",
  threadNotificationToasts: "notifications",
} as const satisfies Record<keyof ClientSettings, SettingsPageSectionId | null>;

const SERVER_SETTING_HOMES = {
  initialModelSelection: "projects",
  runSetupScript: "projects",
  projectPreferences: "projects",
  environmentIcon: "device",
  responseStreamingMode: "chat",
  enableProviderUpdateChecks: "updates",
  automaticUpdates: "updates",
  lowerAgentProcessPriority: "device",
  continueThreadsAfterRestart: "projects",
  autoResumeLimitedThreads: "usage",
  snoozeLimitedThreads: "usage",
  storageRetention: "data",
  projectStorageRetention: "data",
  lifecycleSuggestions: "data",
  projectLifecycleSuggestions: "data",
  worktreeRoot: "projects",
  chatsRoot: "data",
  chatFolderCleanupAfterDays: "data",
  worktreeSubmodules: "projects",
  projectWorktreeSubmodules: "projects",
  projectWorktreeRoots: "projects",
  worktreeBranchPrefix: "projects",
  worktreeBranchChangeTypes: "projects",
  defaultThreadEnvMode: "projects",
  defaultAgentTokenMode: "plugins",
  addProjectBaseDirectory: "projects",
  textGenerationModelSelection: "source-control",
  commitMessageInstructions: "source-control",
  pullRequestInstructions: "source-control",
  gitWritingStyle: "source-control",
  projectGitWritingStyle: "source-control",
  pullRequestTemplates: "source-control",
  threadAutoSettleAfterDays: "inbox",
  providers: "providers",
  providerInstances: "providers",
  // Written by the node's own diagnostics, never edited in settings.
  providerEventLogs: null,
  cliProxyHubs: "providers",
  usagePriceOverrides: "usage",
  observability: "diagnostics",
  agentControl: "agent-control",
} as const satisfies Record<keyof ServerSettings, SettingsPageSectionId | null>;

function keepsRowsIn(section: SettingsPageSectionId, storage: SettingsStorage): boolean {
  return (settingsSection(section).parts as ReadonlyArray<SettingsStorage>).includes(storage);
}

describe("every setting has one home", () => {
  it("edits this app's settings in a section with rows stored in this app", () => {
    for (const [key, section] of Object.entries(CLIENT_SETTING_HOMES)) {
      if (section === null) continue;
      expect(keepsRowsIn(section, "app"), `${key} → ${section}`).toBe(true);
    }
  });

  it("edits a device's settings in a section with rows stored on a device", () => {
    for (const [key, section] of Object.entries(SERVER_SETTING_HOMES)) {
      if (section === null) continue;
      expect(keepsRowsIn(section, "device"), `${key} → ${section}`).toBe(true);
    }
  });

  it("files every search entry under a section that keeps rows where the entry says", () => {
    for (const entry of [...SETTINGS_SEARCH_INDEX, ...KEYBINDING_SEARCH_ENTRIES]) {
      expect(isSettingsPageSectionId(entry.section), entry.title).toBe(true);
      expect(keepsRowsIn(entry.section, entry.storage), `${entry.title} → ${entry.section}`).toBe(
        true,
      );
      // A device page row names its part; no other row does.
      expect(entry.part !== undefined, entry.title).toBe(entry.section === "device");
    }
  });

  it("indexes each row once", () => {
    const titles = SETTINGS_SEARCH_INDEX.map((entry) => entry.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("gives every section a search entry, so search reaches all of settings", () => {
    const indexed = new Set(
      [...SETTINGS_SEARCH_INDEX, ...KEYBINDING_SEARCH_ENTRIES].map((entry) => entry.section),
    );
    for (const section of [
      "appearance",
      "keybindings",
      "notifications",
      "chat",
      "inbox",
      "projects",
      "source-control",
      "providers",
      "usage",
      "plugins",
      "agent-control",
      "devices",
      "device",
      "updates",
      "data",
      "diagnostics",
      "about",
    ] as const) {
      expect(indexed.has(section), section).toBe(true);
    }
  });
});
