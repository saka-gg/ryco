import { Schema } from "effect";
import { GitWritingStyle, WS_METHODS } from "@ryco/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type ServerSettings } from "@ryco/contracts/settings";
import type { NodeSettingsConfig } from "@ryco/client-runtime/state/settings/nodeSettingsTargets";
import {
  DEFAULT_GIT_WRITING_STYLE,
  GIT_WRITING_STYLE_OPTIONS,
  gitWritingStylePatch,
  selectGitWritingStyle,
} from "@ryco/shared/gitWritingStyle";

import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useSettingsTarget } from "../../settingsTarget";
import { DraftTextarea } from "../ui/draft-textarea";
import { Switch } from "../ui/switch";
import {
  ProjectOverrideSelectEditor,
  ProjectOverrideSelectSetting,
  type ProjectOverrideSelectSpec,
} from "./ProjectOverrideSelectSetting";
import { SettingsSection } from "./settingsLayout";
import { SharedSettingRow, sharedControlLabel } from "./sharedSettings/SharedSettingRow";

const GIT_WRITING_INSTRUCTION_ROWS = [
  {
    key: "commitMessageInstructions",
    select: (settings: ServerSettings) => settings.commitMessageInstructions,
    title: "Commit message instructions",
    description:
      "Added to the prompt whenever a commit message is generated. They take precedence over the writing style.",
    placeholder: "e.g. Describe what changed, not file by file.",
  },
  {
    key: "pullRequestInstructions",
    select: (settings: ServerSettings) => settings.pullRequestInstructions,
    title: "Pull request instructions",
    description:
      "Added to the prompt for generated pull request titles and descriptions. They take precedence over the writing style.",
    placeholder:
      "e.g. Use plain, human-readable language and focus on what really changed. If the UI changed, add a Before / After section.",
  },
] as const;

const GIT_WRITING_INSTRUCTIONS_MAX_LENGTH = 4_000;

/** One instructions row, shared across devices: a text area, committed on blur. */
function GitWritingInstructionsRow(props: {
  readonly row: (typeof GIT_WRITING_INSTRUCTION_ROWS)[number];
  readonly allowed: boolean;
}) {
  const { row } = props;
  return (
    <SharedSettingRow
      settingKey={row.key}
      description={row.description}
      layout="block"
      defaultValue={DEFAULT_UNIFIED_SETTINGS[row.key]}
      resetLabel={row.title.toLowerCase()}
      render={(control) => (
        <DraftTextarea
          value={control.value}
          onCommit={(next) => control.onChange(next.trim())}
          placeholder={row.placeholder}
          maxLength={GIT_WRITING_INSTRUCTIONS_MAX_LENGTH}
          disabled={!props.allowed || control.disabled}
          aria-label={sharedControlLabel(row.title, control)}
        />
      )}
    />
  );
}

const nodeKeepsPullRequestTemplates = (config: NodeSettingsConfig): boolean =>
  config.environment.capabilities.changeRequestTemplates === true;

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
  sharedKey: "gitWritingStyle",
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
 * Settings → Git & pull requests: the device's writing style, the user's own commit and pull
 * request instructions, and pull request templates, each shared across devices. Rendered
 * without waiting for the hosting provider scan.
 */
export function GitWritingSettingsSection() {
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
        <GitWritingInstructionsRow key={row.key} row={row} allowed={settingsCapability.allowed} />
      ))}
      <SharedSettingRow
        settingKey="pullRequestTemplates"
        title="Pull request templates"
        description="Fill generated pull request descriptions from the repository's template, and offer its templates when you open a pull request."
        knowsSetting={nodeKeepsPullRequestTemplates}
        unknownSettingStatus="Update this node to use pull request templates."
        defaultValue={DEFAULT_UNIFIED_SETTINGS.pullRequestTemplates}
        resetLabel="pull request templates"
        render={(control) => (
          <Switch
            checked={control.value}
            disabled={!settingsCapability.allowed || control.disabled}
            onCheckedChange={(checked) => control.onChange(Boolean(checked))}
            aria-label={sharedControlLabel("Use pull request templates", control)}
          />
        )}
      />
    </SettingsSection>
  );
}
