import { Schema } from "effect";
import { GitWritingStyle, WS_METHODS } from "@ryco/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@ryco/contracts/settings";
import {
  DEFAULT_GIT_WRITING_STYLE,
  GIT_WRITING_STYLE_OPTIONS,
  gitWritingStylePatch,
  selectGitWritingStyle,
} from "@ryco/shared/gitWritingStyle";

import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useSettingsTarget } from "../../settingsTarget";
import { DraftTextarea } from "../ui/draft-textarea";
import {
  ProjectOverrideSelectEditor,
  ProjectOverrideSelectSetting,
  type ProjectOverrideSelectSpec,
} from "./ProjectOverrideSelectSetting";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const GIT_WRITING_INSTRUCTION_ROWS = [
  {
    key: "commitMessageInstructions",
    title: "Commit message instructions",
    description:
      "Added to the prompt whenever a commit message is generated. They take precedence over the writing style.",
    placeholder: "e.g. Describe what changed, not file by file.",
  },
  {
    key: "pullRequestInstructions",
    title: "Pull request instructions",
    description:
      "Added to the prompt for generated pull request titles and descriptions. They take precedence over the writing style.",
    placeholder:
      "e.g. Use plain, human-readable language and focus on what really changed. If the UI changed, add a Before / After section.",
  },
] as const;

const GIT_WRITING_INSTRUCTIONS_MAX_LENGTH = 4_000;

function styleLabel(style: GitWritingStyle): string {
  return GIT_WRITING_STYLE_OPTIONS.find((option) => option.value === style)?.label ?? style;
}

const GIT_WRITING_STYLE_SETTING: ProjectOverrideSelectSpec<GitWritingStyle> = {
  title: "Writing style",
  description:
    "How generated commit messages and pull requests are written. Your instructions still take precedence.",
  ariaLabel: "Writing style",
  options: GIT_WRITING_STYLE_OPTIONS,
  // "Conventional Commits" is cut off at the standard width.
  controlWidth: "lg",
  isValue: Schema.is(GitWritingStyle),
  supported: (capabilities) => capabilities.gitWritingStyle === true,
  select: (settings, projectId) => {
    if (!settings) return { node: DEFAULT_GIT_WRITING_STYLE, override: null };
    const selected = selectGitWritingStyle({ settings, projectId });
    return {
      node: settings.gitWritingStyle,
      override: selected.source === "project" ? selected.style : null,
    };
  },
  patch: gitWritingStylePatch,
  unsupportedStatus: "Update this node to choose a writing style.",
  inheritStatus: (node) => `Uses the device default (${styleLabel(node)}).`,
  saveFailed: "Could not save the writing style. Try again.",
};

/** The writing style row: the node default (`projectId` empty) or one project's override. */
export function GitWritingStyleSettings(props: {
  readonly projectId: string;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}) {
  return <ProjectOverrideSelectSetting spec={GIT_WRITING_STYLE_SETTING} {...props} />;
}

export function GitWritingStyleEditor(props: {
  readonly projectId: string;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly disabled: boolean;
}) {
  return <ProjectOverrideSelectEditor spec={GIT_WRITING_STYLE_SETTING} {...props} />;
}

/**
 * Settings → Source Control: the node's writing style and the user's own commit and pull
 * request instructions. Rendered without waiting for the hosting provider scan.
 */
export function GitWritingSettingsSection() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const settingsTarget = useSettingsTarget();
  // Settings writes, gated by the settings-update method rather than by sensing the transport.
  const settingsCapability = useHostedRpcCapability(
    WS_METHODS.serverUpdateSettings,
    settingsTarget?.environmentId ?? null,
  );
  return (
    <SettingsSection title="Commit & pull request writing" owner="node">
      <GitWritingStyleSettings projectId="" projects={[]} />
      {GIT_WRITING_INSTRUCTION_ROWS.map((row) => (
        <SettingsRow
          key={row.key}
          title={row.title}
          description={row.description}
          resetAction={
            settings[row.key] !== DEFAULT_UNIFIED_SETTINGS[row.key] ? (
              <SettingResetButton
                label={row.title.toLowerCase()}
                onClick={() => updateSettings({ [row.key]: DEFAULT_UNIFIED_SETTINGS[row.key] })}
              />
            ) : null
          }
        >
          <DraftTextarea
            value={settings[row.key]}
            onCommit={(next) => updateSettings({ [row.key]: next.trim() })}
            placeholder={row.placeholder}
            maxLength={GIT_WRITING_INSTRUCTIONS_MAX_LENGTH}
            disabled={!settingsCapability.allowed}
            aria-label={row.title}
          />
        </SettingsRow>
      ))}
    </SettingsSection>
  );
}
