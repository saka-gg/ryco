import { DEFAULT_UNIFIED_SETTINGS } from "@ryco/contracts/settings";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useServerConfigSelector } from "../../rpc/serverState";
import { useSettingsEditingScope, useSettingsTarget } from "../../settingsTarget";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { isNodeSettingsTargetReadOnly } from "./settingsSections.logic";
import {
  STATISTICS_OUTSIDE_SESSIONS_DESCRIPTION,
  STATISTICS_OUTSIDE_SESSIONS_TITLE,
} from "./statisticsOutsideSessionsTitle";

/**
 * Whether the device's Statistics may read its Claude Code and Codex session files outside
 * Ryco (`statisticsOutsideSessions`, kept per device: the files are that machine's). Hidden on
 * a node too old to read them.
 */
export function StatisticsOutsideSessionsSetting() {
  const enabled = useSettings((settings) => settings.statisticsOutsideSessions);
  const { updateSettings } = useUpdateSettings();
  const supported = useServerConfigSelector(
    (config) => config?.environment.capabilities.statisticsMachineScope === true,
  );
  const settingsTarget = useSettingsTarget();
  const editingScope = useSettingsEditingScope();
  if (!supported) return null;
  // Client-only editing, or an unreachable or read-only node, cannot change it.
  const disabled = isNodeSettingsTargetReadOnly(editingScope, settingsTarget);
  return (
    <SettingsRow
      title={STATISTICS_OUTSIDE_SESSIONS_TITLE}
      description={STATISTICS_OUTSIDE_SESSIONS_DESCRIPTION}
      owner="node"
      resetAction={
        !disabled && enabled !== DEFAULT_UNIFIED_SETTINGS.statisticsOutsideSessions ? (
          <SettingResetButton
            label="count sessions outside Ryco"
            onClick={() =>
              updateSettings({
                statisticsOutsideSessions: DEFAULT_UNIFIED_SETTINGS.statisticsOutsideSessions,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          disabled={disabled}
          onCheckedChange={(checked) =>
            updateSettings({ statisticsOutsideSessions: Boolean(checked) })
          }
          aria-label={STATISTICS_OUTSIDE_SESSIONS_TITLE}
        />
      }
    />
  );
}
