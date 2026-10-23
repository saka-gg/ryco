import { useEffect, useRef, useState } from "react";

import { updatePreferences, usePreferences } from "../../state/preferencesStore";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const loadThreadAlerts = () => import("../../notifications/threadAlerts");

/**
 * Thread alerts on this device. Turning them on asks to post notifications and
 * stays off when that is refused.
 */
export function ThreadAlertSettings() {
  const preferences = usePreferences();
  const alertsOn = preferences.threadAlerts === true;
  const [requesting, setRequesting] = useState(false);
  const [blocked, setBlocked] = useState(false);

  // Notifications can be turned off in the system settings while alerts are on.
  useEffect(() => {
    if (!alertsOn) return;
    let active = true;
    void loadThreadAlerts()
      .then(({ readThreadAlertPermission }) => readThreadAlertPermission())
      .then((granted) => {
        if (active) setBlocked(!granted);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [alertsOn]);

  // The last flip of the switch wins over a permission answer still on its way.
  const latestChange = useRef(0);
  const setAlerts = (enabled: boolean) => {
    const change = (latestChange.current += 1);
    if (!enabled) {
      setRequesting(false);
      setBlocked(false);
      updatePreferences({ threadAlerts: false });
      return;
    }
    setRequesting(true);
    void loadThreadAlerts()
      .then(({ requestThreadAlertPermission }) => requestThreadAlertPermission())
      .catch(() => false)
      .then((granted) => {
        if (change !== latestChange.current) return;
        setRequesting(false);
        setBlocked(!granted);
        if (granted) updatePreferences({ threadAlerts: true });
      });
  };

  return (
    <SettingsSection title="Alerts">
      <SettingsSwitchRow
        first
        label="Thread alerts"
        detail={
          blocked
            ? "Allow notifications for Ryco in Settings."
            : "Get alerted when a thread finishes, fails, or needs you while Ryco is open."
        }
        value={alertsOn || requesting}
        onValueChange={setAlerts}
      />
      {alertsOn ? (
        <SettingsSwitchRow
          label="Alert sound"
          value={preferences.threadAlertSound === true}
          onValueChange={(threadAlertSound) => updatePreferences({ threadAlertSound })}
        />
      ) : null}
    </SettingsSection>
  );
}
