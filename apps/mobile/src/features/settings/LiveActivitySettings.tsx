import { updatePreferences, usePreferences } from "../../state/preferencesStore";
import { rycoWidgetsNative } from "../../widgets/rycoWidgetsNative";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

export const LIVE_ACTIVITY_DETAIL =
  "Show running and waiting tasks on the Lock Screen and in the Dynamic Island. It stays current only while Ryco runs, and task titles show on a locked phone.";

/**
 * The agent Live Activity's switch, off until turned on. Only in a build with the widget
 * extension; iOS's own Live Activities switch for Ryco is respected.
 */
export function LiveActivitySettings() {
  const preferences = usePreferences();
  const native = rycoWidgetsNative();
  if (native === null) return null;
  const allowed = native.activitiesEnabled();
  const on = preferences.liveActivitiesEnabled === true;
  return (
    <SettingsSwitchRow
      label="Live Activity"
      detail={allowed ? LIVE_ACTIVITY_DETAIL : "Allow Live Activities for Ryco in iOS Settings."}
      value={on && allowed}
      disabled={!allowed && !on}
      onValueChange={(liveActivitiesEnabled) => updatePreferences({ liveActivitiesEnabled })}
    />
  );
}
