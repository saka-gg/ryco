import { Schema } from "effect";
import { useEffect, useRef } from "react";
import { GitWritingStyle, WS_METHODS, type ServerConfig } from "@ryco/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type ServerSettings } from "@ryco/contracts/settings";
import type { NodeSettingsConfig } from "@ryco/client-runtime/state/settings/nodeSettingsFanOut";
import {
  DEFAULT_GIT_WRITING_STYLE,
  GIT_WRITING_STYLE_OPTIONS,
  gitWritingStylePatch,
  selectGitWritingStyle,
} from "@ryco/shared/gitWritingStyle";

import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useServerConfigSelector } from "../../rpc/serverState";
import { useSettingsTarget } from "../../settingsTarget";
import { DraftTextarea } from "../ui/draft-textarea";
import { Switch } from "../ui/switch";
import { ApplyToAllNodes } from "./ApplyToAllNodes";
import {
  ProjectOverrideSelectEditor,
  ProjectOverrideSelectSetting,
  type ProjectOverrideSelectSpec,
} from "./ProjectOverrideSelectSetting";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

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

/**
 * One instructions row. "Apply to all nodes" sends the text committed last, even while this
 * node's save is still on its way: clicking the button commits the text first, and a node other
 * than the primary one shows it only once the node answers.
 */
function GitWritingInstructionsRow(props: {
  readonly row: (typeof GIT_WRITING_INSTRUCTION_ROWS)[number];
  readonly value: string;
  readonly onCommit: (next: string) => void;
  readonly allowed: boolean;
}) {
  const { row, value } = props;
  const committed = useRef<string | null>(null);
  // A value from the node (this save's answer, or a change made elsewhere) replaces it.
  useEffect(() => {
    committed.current = null;
  }, [value]);
  return (
    <SettingsRow
      title={row.title}
      description={row.description}
      status={
        <ApplyToAllNodes
          label={row.title.toLowerCase()}
          select={row.select}
          format={formatInstructions}
          patch={() => ({ [row.key]: committed.current ?? value })}
          disabled={!props.allowed}
        />
      }
      resetAction={
        value !== DEFAULT_UNIFIED_SETTINGS[row.key] ? (
          <SettingResetButton
            label={row.title.toLowerCase()}
            onClick={() => props.onCommit(DEFAULT_UNIFIED_SETTINGS[row.key])}
          />
        ) : null
      }
    >
      <DraftTextarea
        value={value}
        onCommit={(next) => {
          committed.current = next.trim();
          props.onCommit(next.trim());
        }}
        placeholder={row.placeholder}
        maxLength={GIT_WRITING_INSTRUCTIONS_MAX_LENGTH}
        disabled={!props.allowed}
        aria-label={row.title}
      />
    </SettingsRow>
  );
}

/** Instructions as the "Mixed" list shows them: the start of the text, or None. */
function formatInstructions(text: string): string {
  const line = text.trim().replace(/\s+/g, " ");
  if (!line) return "None";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

const selectPullRequestTemplates = (settings: ServerSettings): boolean =>
  settings.pullRequestTemplates;
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
  applyToAllNodesLabel: "writing style",
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

// Module level, so unrelated config pushes (provider probes) never re-render.
const selectChangeRequestTemplatesSupported = (config: ServerConfig | null): boolean =>
  config?.environment.capabilities.changeRequestTemplates === true;

/**
 * Settings → Source Control: the node's writing style, the user's own commit and pull
 * request instructions, and pull request templates. Rendered without waiting for the hosting
 * provider scan.
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
  // Older nodes drop the setting; their dialog never offers templates either.
  const templatesSupported = useServerConfigSelector(selectChangeRequestTemplatesSupported);
  return (
    <SettingsSection title="Commit & pull request writing" owner="node">
      <GitWritingStyleSettings projectId="" projects={[]} />
      {GIT_WRITING_INSTRUCTION_ROWS.map((row) => (
        <GitWritingInstructionsRow
          key={row.key}
          row={row}
          value={settings[row.key]}
          onCommit={(next) => updateSettings({ [row.key]: next })}
          allowed={settingsCapability.allowed}
        />
      ))}
      <SettingsRow
        title="Pull request templates"
        description="Fill generated pull request descriptions from the repository's template, and offer its templates when you open a pull request."
        status={
          templatesSupported ? (
            <ApplyToAllNodes
              label="pull request templates"
              select={selectPullRequestTemplates}
              format={(on) => (on ? "On" : "Off")}
              patch={{ pullRequestTemplates: settings.pullRequestTemplates }}
              supported={nodeKeepsPullRequestTemplates}
              disabled={!settingsCapability.allowed}
            />
          ) : (
            "Update this node to use pull request templates."
          )
        }
        resetAction={
          templatesSupported &&
          settings.pullRequestTemplates !== DEFAULT_UNIFIED_SETTINGS.pullRequestTemplates ? (
            <SettingResetButton
              label="pull request templates"
              onClick={() =>
                updateSettings({
                  pullRequestTemplates: DEFAULT_UNIFIED_SETTINGS.pullRequestTemplates,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.pullRequestTemplates}
            disabled={!settingsCapability.allowed || !templatesSupported}
            onCheckedChange={(checked) =>
              updateSettings({ pullRequestTemplates: Boolean(checked) })
            }
            aria-label="Use pull request templates"
          />
        }
      />
    </SettingsSection>
  );
}
