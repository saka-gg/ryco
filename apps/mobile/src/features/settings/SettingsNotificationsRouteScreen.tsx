import { ScrollView } from "react-native";

import { usePreferences } from "../../state/preferencesStore";
import { AlertKindSettings } from "./AlertKindSettings";
import { LiveActivitySettings } from "./LiveActivitySettings";
import { ThreadAlertSettings } from "./ThreadAlertSettings";

/**
 * Settings → Notifications: thread alerts (in front and, through the Hub, while Ryco is closed),
 * which kinds alert, and the Live Activity.
 */
export function SettingsNotificationsRouteScreen() {
  const preferences = usePreferences();
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-screen"
      contentContainerStyle={{ paddingTop: 4, paddingBottom: 40 }}
    >
      <ThreadAlertSettings />
      {preferences.threadAlerts === true ? <AlertKindSettings /> : null}
      <LiveActivitySettings />
    </ScrollView>
  );
}
