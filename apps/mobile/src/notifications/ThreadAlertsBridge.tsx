import { useEffect, useState } from "react";

import { useConnectionRegistry } from "../providers/ConnectionRegistryProvider";
import {
  getPreferencesSnapshot,
  subscribePreferences,
  usePreferences,
} from "../state/preferencesStore";
import { selectEnvironmentState, useStore } from "../state/threadsRuntime";
import { readVisibleThread } from "./visibleThread";

type ThreadAlertsModule = typeof import("./threadAlerts");

/**
 * Loads thread alerts the first time they are on, which keeps
 * expo-notifications off the launch path, then keeps them for the unlocked
 * workspace: a notification opened after alerts were turned off still opens
 * its thread.
 */
export function ThreadAlertsBridge() {
  const { driver } = useConnectionRegistry();
  const enabled = usePreferences().threadAlerts === true;
  const [alertsModule, setAlertsModule] = useState<ThreadAlertsModule | null>(null);

  useEffect(() => {
    if (!enabled || alertsModule !== null) return;
    let active = true;
    void import("./threadAlerts")
      .then((loaded) => {
        if (active) setAlertsModule(loaded);
      })
      .catch((error: unknown) => console.warn("Thread alerts failed to load.", error));
    return () => {
      active = false;
    };
  }, [alertsModule, enabled]);

  useEffect(() => {
    if (alertsModule === null) return;
    const alerts = alertsModule.startMobileThreadAlerts({
      source: driver.supervisor,
      readEnvironmentThreads: (environmentId) =>
        Object.values(
          selectEnvironmentState(useStore.getState(), environmentId).sidebarThreadSummaryById,
        ),
      readPreferences: getPreferencesSnapshot,
      subscribePreferences,
      readVisibleThread,
    });
    return () => alerts.stop();
  }, [alertsModule, driver]);

  return null;
}
