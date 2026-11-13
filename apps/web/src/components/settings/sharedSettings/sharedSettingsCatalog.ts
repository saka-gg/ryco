import type { ServerSettings } from "@ryco/contracts/settings";
import { GIT_WRITING_STYLE_OPTIONS } from "@ryco/shared/gitWritingStyle";
import { projectPreferenceValueLabel } from "@ryco/shared/projectPreferences";
import type {
  ShareableServerSettingKey,
  ShareableSettingValue,
} from "@ryco/shared/settingsSharing";
import { WORKTREE_SUBMODULE_OPTIONS } from "@ryco/shared/worktreeSubmodules";

import type { SettingsPageSectionId } from "../settingsRegistry";

/**
 * Where each shared device setting lives on the settings page, its name, and how one value
 * reads in the device list, the hints of one-device mode, "Use … everywhere" and the compare
 * table. A shareable key added to the catalog fails typecheck here until it has a home.
 */
export interface SharedSettingDisplay<K extends ShareableServerSettingKey> {
  readonly section: SettingsPageSectionId;
  readonly title: string;
  readonly format: (value: ShareableSettingValue<K>) => string;
}

const onOff = (value: boolean): string => (value ? "On" : "Off");
const text =
  (empty: string) =>
  (value: string): string => {
    const line = value.trim().replace(/\s+/g, " ");
    if (!line) return empty;
    return line.length > 48 ? `${line.slice(0, 47)}…` : line;
  };
const days = (value: number | null, never = "Never"): string =>
  value === null ? never : value === 1 ? "1 day" : `${value} days`;
const option = <T extends string>(
  options: ReadonlyArray<{ readonly value: T; readonly label: string }>,
  value: T,
): string => options.find((entry) => entry.value === value)?.label ?? value;

const STREAMING_LABELS: Record<ServerSettings["responseStreamingMode"], string> = {
  paragraph: "Paragraphs",
  turn: "Whole messages",
  token: "Token by token",
};
const TOKEN_MODE_LABELS: Record<ServerSettings["defaultAgentTokenMode"], string> = {
  off: "Off",
  balanced: "Balanced",
  aggressive: "Aggressive",
};

export const SHARED_SETTING_DISPLAY: {
  readonly [K in ShareableServerSettingKey]: SharedSettingDisplay<K>;
} = {
  runSetupScript: {
    section: "projects",
    title: "Worktree setup",
    format: (value) => projectPreferenceValueLabel("runSetupScript", value),
  },
  responseStreamingMode: {
    section: "chat",
    title: "Response streaming",
    format: (value) => STREAMING_LABELS[value] ?? value,
  },
  enableProviderUpdateChecks: {
    section: "updates",
    title: "Provider update checks",
    format: onOff,
  },
  automaticUpdates: { section: "updates", title: "Update automatically", format: onOff },
  continueThreadsAfterRestart: {
    section: "projects",
    title: "Continue after restart",
    format: onOff,
  },
  autoResumeLimitedThreads: {
    section: "usage",
    title: "Auto-resume limited threads",
    format: onOff,
  },
  snoozeLimitedThreads: { section: "usage", title: "Snooze limited threads", format: onOff },
  promptSuggestions: { section: "chat", title: "Suggest next prompt", format: onOff },
  storageRetention: {
    section: "data",
    title: "Retention policy",
    format: (value) =>
      `${value.automatic ? "Automatic" : "Manual"} · worktrees ${days(value.completedWorktreeDays, "forever")} · temporary data ${days(value.temporaryDataDays, "forever")}`,
  },
  lifecycleSuggestions: {
    section: "data",
    title: "Cleanup suggestions",
    format: (value) =>
      `Archive after ${days(value.archiveInactiveThreadsDays, "never")} · delete after ${days(value.removeArchivedCheckoutsDays, "never")}`,
  },
  worktreeRoot: { section: "projects", title: "Worktree root", format: text("Default") },
  chatsRoot: { section: "data", title: "Chats folder", format: text("Default") },
  chatFolderCleanupAfterDays: {
    section: "data",
    title: "Remove empty chat folders",
    format: (value) => days(value),
  },
  worktreeSubmodules: {
    section: "projects",
    title: "Worktree submodules",
    format: (value) => option(WORKTREE_SUBMODULE_OPTIONS, value),
  },
  worktreeBranchPrefix: {
    section: "projects",
    title: "Worktree branch prefix",
    format: text("No prefix"),
  },
  worktreeBranchChangeTypes: {
    section: "projects",
    title: "Name branches by change type",
    format: onOff,
  },
  defaultThreadEnvMode: {
    section: "projects",
    title: "New threads",
    format: (value) => projectPreferenceValueLabel("defaultThreadEnvMode", value),
  },
  defaultAgentTokenMode: {
    section: "plugins",
    title: "Default token mode",
    format: (value) => TOKEN_MODE_LABELS[value] ?? value,
  },
  addProjectBaseDirectory: {
    section: "projects",
    title: "Add project starts in",
    format: text("~/"),
  },
  commitMessageInstructions: {
    section: "source-control",
    title: "Commit message instructions",
    format: text("None"),
  },
  pullRequestInstructions: {
    section: "source-control",
    title: "Pull request instructions",
    format: text("None"),
  },
  gitWritingStyle: {
    section: "source-control",
    title: "Writing style",
    format: (value) => option(GIT_WRITING_STYLE_OPTIONS, value),
  },
  pullRequestTemplates: {
    section: "source-control",
    title: "Use pull request templates",
    format: onOff,
  },
  threadAutoSettleAfterDays: {
    section: "inbox",
    title: "Auto-settle inactive tasks",
    format: (value) => (value === null ? "Off" : `After ${days(value)}`),
  },
  usagePriceOverrides: {
    section: "usage",
    title: "Model prices",
    format: (value) => {
      const count = Object.keys(value).length;
      return count === 0
        ? "Default prices"
        : count === 1
          ? "1 custom price"
          : `${count} custom prices`;
    },
  },
  agentControl: {
    section: "agent-control",
    title: "Agent Control",
    format: (value) =>
      value.delegation.maxDepth === null && value.delegation.maxTasksPerTree === null
        ? onOff(value.enabled)
        : `${onOff(value.enabled)} · custom limits`,
  },
};

/** One value of a key as its rows read it. */
export function formatSharedSettingValue<K extends ShareableServerSettingKey>(
  key: K,
  value: ShareableSettingValue<K> | undefined,
): string {
  if (value === undefined) return "Unknown";
  return (SHARED_SETTING_DISPLAY[key] as SharedSettingDisplay<K>).format(value);
}

/** The settings element id of a shared row, which the compare table and Open buttons reveal. */
export function sharedSettingRowId(key: ShareableServerSettingKey): string {
  return `shared-setting-${key}`;
}

const SECTIONS_WITH_SHARED_ROWS: ReadonlySet<SettingsPageSectionId> = new Set(
  Object.values(SHARED_SETTING_DISPLAY).map((entry) => entry.section),
);

/** Whether a section has rows of shared device settings (it offers "All devices"). */
export function sectionHasSharedSettings(section: SettingsPageSectionId): boolean {
  return SECTIONS_WITH_SHARED_ROWS.has(section);
}
