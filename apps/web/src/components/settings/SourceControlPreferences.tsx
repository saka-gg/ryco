import {
  DEFAULT_UNIFIED_SETTINGS,
  type GitStatusPollIntervalMs,
  type SourceControlRefreshMode,
} from "@ryco/contracts/settings";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useAppPreferencesLabel } from "../../deviceName";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsSection, SettingsRow, SettingResetButton } from "./settingsLayout";
const GIT_STATUS_POLL_INTERVAL_LABELS = {
  0: "Off",
  10000: "10 seconds",
  30000: "30 seconds",
  60000: "1 minute",
  300000: "5 minutes",
} satisfies Record<GitStatusPollIntervalMs, string>;

const GIT_STATUS_POLL_INTERVAL_OPTIONS = [
  0, 10_000, 30_000, 60_000, 300_000,
] as const satisfies readonly GitStatusPollIntervalMs[];

const SOURCE_CONTROL_REFRESH_MODE_LABELS = {
  automatic: "Automatic",
  reduced: "Reduced",
  manual: "Manual",
} satisfies Record<SourceControlRefreshMode, string>;

const SOURCE_CONTROL_REFRESH_MODE_OPTIONS = [
  "automatic",
  "reduced",
  "manual",
] as const satisfies readonly SourceControlRefreshMode[];

function parseGitStatusPollInterval(value: string | null): GitStatusPollIntervalMs | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return GIT_STATUS_POLL_INTERVAL_OPTIONS.includes(parsed as GitStatusPollIntervalMs)
    ? (parsed as GitStatusPollIntervalMs)
    : null;
}

function parseSourceControlRefreshMode(value: string | null): SourceControlRefreshMode | null {
  return SOURCE_CONTROL_REFRESH_MODE_OPTIONS.find((mode) => mode === value) ?? null;
}

export function SourceControlPreferences() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const localScopeLabel = useAppPreferencesLabel();
  return (
    <>
      <SettingsSection title="Diff display">
        <SettingsRow
          title="Diff line wrapping"
          description="Set the default wrap state when the diff panel opens."
          scope={localScopeLabel}
          resetAction={
            settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap ? (
              <SettingResetButton
                label="diff line wrapping"
                onClick={() =>
                  updateSettings({
                    diffWordWrap: DEFAULT_UNIFIED_SETTINGS.diffWordWrap,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffWordWrap}
              onCheckedChange={(checked) => updateSettings({ diffWordWrap: Boolean(checked) })}
              aria-label="Wrap diff lines by default"
            />
          }
        />

        <SettingsRow
          title="Hide whitespace changes"
          description="Set whether the diff panel ignores whitespace-only edits by default."
          scope={localScopeLabel}
          resetAction={
            settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace ? (
              <SettingResetButton
                label="diff whitespace changes"
                onClick={() =>
                  updateSettings({
                    diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffIgnoreWhitespace}
              onCheckedChange={(checked) =>
                updateSettings({ diffIgnoreWhitespace: Boolean(checked) })
              }
              aria-label="Hide whitespace changes by default"
            />
          }
        />
      </SettingsSection>
      <SettingsSection title="Git & pull requests">
        <SettingsRow
          title="Remote Git status"
          description="Refresh remote branch and pull request metadata while a repository is open."
          scope={localScopeLabel}
          resetAction={
            settings.gitStatusPollIntervalMs !==
            DEFAULT_UNIFIED_SETTINGS.gitStatusPollIntervalMs ? (
              <SettingResetButton
                label="git status polling"
                onClick={() =>
                  updateSettings({
                    gitStatusPollIntervalMs: DEFAULT_UNIFIED_SETTINGS.gitStatusPollIntervalMs,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.gitStatusPollIntervalMs)}
              onValueChange={(value) => {
                const interval = parseGitStatusPollInterval(value);
                if (interval !== null) {
                  updateSettings({ gitStatusPollIntervalMs: interval });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Git status polling interval">
                <SelectValue>
                  {GIT_STATUS_POLL_INTERVAL_LABELS[settings.gitStatusPollIntervalMs]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {GIT_STATUS_POLL_INTERVAL_OPTIONS.map((interval) => (
                  <SelectItem key={interval} hideIndicator value={String(interval)}>
                    {GIT_STATUS_POLL_INTERVAL_LABELS[interval]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="PR & workflow updates"
          description="Control automatic pull request and workflow refreshes. Automatic is fast after pushes and stops when checks settle."
          scope={localScopeLabel}
          resetAction={
            settings.sourceControlRefreshMode !==
            DEFAULT_UNIFIED_SETTINGS.sourceControlRefreshMode ? (
              <SettingResetButton
                label="PR and workflow updates"
                onClick={() =>
                  updateSettings({
                    sourceControlRefreshMode: DEFAULT_UNIFIED_SETTINGS.sourceControlRefreshMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.sourceControlRefreshMode}
              onValueChange={(value) => {
                const mode = parseSourceControlRefreshMode(value);
                if (mode !== null) updateSettings({ sourceControlRefreshMode: mode });
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="PR and workflow update mode">
                <SelectValue>
                  {SOURCE_CONTROL_REFRESH_MODE_LABELS[settings.sourceControlRefreshMode]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {SOURCE_CONTROL_REFRESH_MODE_OPTIONS.map((mode) => (
                  <SelectItem key={mode} hideIndicator value={mode}>
                    {SOURCE_CONTROL_REFRESH_MODE_LABELS[mode]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
    </>
  );
}
