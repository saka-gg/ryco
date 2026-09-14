import { DeviceCacheStorage } from "./DeviceCacheStorage";
import { ScrollView } from "react-native";

import { LoadingScreen } from "../../components/LoadingScreen";
import {
  updatePreferences,
  useIsPreferencesHydrated,
  usePreferences,
} from "../../state/preferencesStore";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

// Device-local client settings (mobileKV). Server-owned settings live under the
// active environment; these are the client-only preferences (§3-2, R6).
export function SettingsClientStorageRouteScreen() {
  const preferences = usePreferences();
  const hydrated = useIsPreferencesHydrated();

  // Gate on hydration: the store starts empty, so an un-hydrated read would show
  // (and a toggle would persist) a default the device never chose.
  if (!hydrated) return <LoadingScreen message="Loading settings…" />;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-screen"
      contentContainerStyle={{ paddingVertical: 12 }}
    >
      <SettingsSection title="Stored on this device">
        {/* Drives the cross-machine merge in the Projects list: on, one repository
            checked out on two machines is one row; off, every checkout is its own. */}
        <SettingsSwitchRow
          first
          label="Group by repository"
          value={preferences.projectGroupingEnabled !== false}
          onValueChange={(value) => updatePreferences({ projectGroupingEnabled: value })}
        />
        <SettingsRow
          label="Base font size"
          value={preferences.baseFontSize ? `${preferences.baseFontSize}pt` : "Default"}
        />
      </SettingsSection>
      <DeviceCacheStorage />
    </ScrollView>
  );
}
