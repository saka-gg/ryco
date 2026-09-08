import { useUiStateStore } from "../../uiStateStore";
import { Switch } from "../ui/switch";
import { SettingsSection, SettingsRow, SettingResetButton } from "./settingsLayout";

export function ComposerSettings() {
  const wideComposerControlsAutoCollapse = useUiStateStore(
    (state) => state.wideComposerControlsAutoCollapse,
  );
  const setWideComposerControlsAutoCollapse = useUiStateStore(
    (state) => state.setWideComposerControlsAutoCollapse,
  );
  const alwaysUseBuildMode = useUiStateStore((state) => state.alwaysUseBuildMode);
  const setAlwaysUseBuildMode = useUiStateStore((state) => state.setAlwaysUseBuildMode);
  return (
    <SettingsSection title="Composer controls">
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
