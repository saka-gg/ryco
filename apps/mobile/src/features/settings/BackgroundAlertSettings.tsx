import { useEffect, useRef, useState } from "react";

import { useHostedHubStore } from "../../hostedHub/state";
import {
  describeBackgroundAlerts,
  type BackgroundAlertsSnapshot,
} from "../../notifications/push/backgroundAlertsModel";
import { updatePreferences, usePreferences } from "../../state/preferencesStore";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const loadBackgroundAlerts = () => import("../../notifications/push/backgroundAlertsRuntime");
const loadThreadAlerts = () => import("../../notifications/threadAlerts");

/**
 * Thread alerts while Ryco is closed, through the Hub (`docs/push-alerts.md`).
 * Shown under thread alerts on an iPhone; the detail says why it cannot turn
 * on (a Hub without push, an older machine, a Personal Team build) or where it
 * is on. Opening the screen reads the Hub's capability, nothing more.
 */
export function BackgroundAlertSettings() {
  const preferences = usePreferences();
  const on = preferences.backgroundAlerts === true;
  const nodes = useHostedHubStore((state) => state.nodes);
  const [snapshot, setSnapshot] = useState<BackgroundAlertsSnapshot | null>(null);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void loadBackgroundAlerts()
      .then(({ getMobileBackgroundAlerts }) => {
        if (!active) return;
        const loaded = getMobileBackgroundAlerts();
        setSnapshot(loaded.getSnapshot());
        unsubscribe = loaded.subscribe(() => setSnapshot(loaded.getSnapshot()));
        void loaded.checkAvailability();
      })
      .catch((error: unknown) => console.warn("Background alerts failed to load.", error));
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  // The last flip of the switch wins over a permission answer still on its way.
  const latestChange = useRef(0);
  if (snapshot === null) return null;
  const row = describeBackgroundAlerts(
    snapshot,
    (environmentId) =>
      nodes.find((node) => node.environmentId === environmentId)?.label ?? "a machine",
  );
  if (!row.visible) return null;

  const setBackgroundAlerts = (enabled: boolean) => {
    const change = (latestChange.current += 1);
    if (!enabled) {
      updatePreferences({ backgroundAlerts: false });
      return;
    }
    // Thread alerts asked for permission already; this covers it being withdrawn since.
    void loadThreadAlerts()
      .then(({ requestThreadAlertPermission }) => requestThreadAlertPermission())
      .catch(() => false)
      .then((granted) => {
        if (change === latestChange.current && granted) {
          updatePreferences({ backgroundAlerts: true });
        }
      });
  };

  return (
    <SettingsSwitchRow
      label="When Ryco is closed"
      detail={row.detail}
      value={on}
      disabled={!on && !row.canEnable}
      onValueChange={setBackgroundAlerts}
    />
  );
}
