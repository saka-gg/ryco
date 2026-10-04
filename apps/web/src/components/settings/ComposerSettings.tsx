import { DEFAULT_UNIFIED_SETTINGS, type FollowUpBehavior } from "@ryco/contracts/settings";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useUiStateStore } from "../../uiStateStore";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsSection, SettingsRow, SettingResetButton } from "./settingsLayout";

const FOLLOW_UP_BEHAVIOR_LABELS = {
  queue: "Queue",
  steer: "Steer",
} satisfies Record<FollowUpBehavior, string>;

const FOLLOW_UP_BEHAVIOR_OPTIONS = [
  "queue",
  "steer",
] as const satisfies readonly FollowUpBehavior[];

function parseFollowUpBehavior(value: string | null): FollowUpBehavior | null {
  return value === "queue" || value === "steer" ? value : null;
}

export function ComposerSettings() {
  const wideComposerControlsAutoCollapse = useUiStateStore(
    (state) => state.wideComposerControlsAutoCollapse,
  );
  const setWideComposerControlsAutoCollapse = useUiStateStore(
    (state) => state.setWideComposerControlsAutoCollapse,
  );
  const alwaysUseBuildMode = useUiStateStore((state) => state.alwaysUseBuildMode);
  const setAlwaysUseBuildMode = useUiStateStore((state) => state.setAlwaysUseBuildMode);
  const followUpBehavior = useSettings((settings) => settings.followUpBehavior);
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsSection title="Composer controls">
      <SettingsRow
        title="Messages sent while a turn runs"
        description="Queue waits for the turn to finish. Steer adds the message to the running turn when the provider supports it. ⌘↵ / Ctrl+Enter does the opposite."
        resetAction={
          followUpBehavior !== DEFAULT_UNIFIED_SETTINGS.followUpBehavior ? (
            <SettingResetButton
              label="follow-up behaviour"
              onClick={() =>
                updateSettings({ followUpBehavior: DEFAULT_UNIFIED_SETTINGS.followUpBehavior })
              }
            />
          ) : null
        }
        control={
          <Select
            value={followUpBehavior}
            onValueChange={(value) => {
              const behavior = parseFollowUpBehavior(value);
              if (behavior !== null) updateSettings({ followUpBehavior: behavior });
            }}
          >
            <SelectTrigger className="w-full sm:w-40" aria-label="Messages sent while a turn runs">
              <SelectValue>{FOLLOW_UP_BEHAVIOR_LABELS[followUpBehavior]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {FOLLOW_UP_BEHAVIOR_OPTIONS.map((behavior) => (
                <SelectItem key={behavior} hideIndicator value={behavior}>
                  {FOLLOW_UP_BEHAVIOR_LABELS[behavior]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Auto-collapse wide composer labels"
        description="Show long composer mode labels only on hover or focus."
        resetAction={
          !wideComposerControlsAutoCollapse ? (
            <SettingResetButton
              label="wide composer labels"
              onClick={() => setWideComposerControlsAutoCollapse(true)}
            />
          ) : null
        }
        control={
          <Switch
            checked={wideComposerControlsAutoCollapse}
            onCheckedChange={(checked) => setWideComposerControlsAutoCollapse(Boolean(checked))}
            aria-label="Auto-collapse wide composer labels"
          />
        }
      />
      <SettingsRow
        title="Always use Build mode"
        description="Hide the mode selector in the composer and send every turn in Build mode."
        resetAction={
          !alwaysUseBuildMode ? (
            <SettingResetButton
              label="always use Build mode"
              onClick={() => setAlwaysUseBuildMode(true)}
            />
          ) : null
        }
        control={
          <Switch
            checked={alwaysUseBuildMode}
            onCheckedChange={(checked) => setAlwaysUseBuildMode(Boolean(checked))}
            aria-label="Always use Build mode"
          />
        }
      />
    </SettingsSection>
  );
}
