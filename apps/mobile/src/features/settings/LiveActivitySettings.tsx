import { useSyncExternalStore } from "react";

import {
  readLiveActivityStartOffered,
  subscribeLiveActivityPushToken,
} from "../../liveActivity/liveActivityTokenStore";
import { updatePreferences, usePreferences } from "../../state/preferencesStore";
import { rycoWidgetsNative } from "../../widgets/rycoWidgetsNative";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

export const LIVE_ACTIVITY_DETAIL =
  "Show running and waiting tasks on the Lock Screen and in the Dynamic Island. It stays current only while Ryco runs, and task titles show on a locked phone.";

export const LIVE_ACTIVITY_START_DETAIL =
  "When a task begins on a machine while Ryco is closed, the Lock Screen shows the count of running tasks, without titles. Off by default.";

/**
 * The agent Live Activity's switch, off until turned on. Only in a build with the widget
 * extension; iOS's own Live Activities switch for Ryco is respected. Starting a card by push
 * (iOS 17.2+) is offered only once the Hub does it, and stays off until turned on.
 */
export function LiveActivitySettings() {
  const preferences = usePreferences();
  const startOffered = useSyncExternalStore(
    subscribeLiveActivityPushToken,
    readLiveActivityStartOffered,
    readLiveActivityStartOffered,
  );
  const native = rycoWidgetsNative();
  if (native === null) return null;
  const allowed = native.activitiesEnabled();
  const on = preferences.liveActivitiesEnabled === true;
  return (
    <SettingsSection title="Lock Screen">
      <SettingsSwitchRow
        first
        label="Live Activity"
        detail={allowed ? LIVE_ACTIVITY_DETAIL : "Allow Live Activities for Ryco in iOS Settings."}
        value={on && allowed}
        disabled={!allowed && !on}
        onValueChange={(liveActivitiesEnabled) => updatePreferences({ liveActivitiesEnabled })}
      />
      {on && allowed && startOffered ? (
        <SettingsSwitchRow
          label="Start when a task begins"
          detail={LIVE_ACTIVITY_START_DETAIL}
          value={preferences.liveActivityStartByPush === true}
          onValueChange={(liveActivityStartByPush) =>
            updatePreferences({ liveActivityStartByPush })
          }
        />
      ) : null}
    </SettingsSection>
  );
}
