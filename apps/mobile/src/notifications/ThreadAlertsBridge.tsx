import { useEffect, useRef, useState } from "react";

import { useConnectionRegistry } from "../providers/ConnectionRegistryProvider";
import {
  getPreferencesSnapshot,
  subscribePreferences,
  usePreferences,
} from "../state/preferencesStore";
import { selectEnvironmentState, useStore } from "../state/threadsRuntime";
import { readVisibleThread } from "./visibleThread";

type ThreadAlertsModule = typeof import("./threadAlerts");
type BackgroundAlertsModule = typeof import("./push/backgroundAlertsRuntime");

// At module scope: the React Compiler cannot compile a component that calls import() itself.
const loadThreadAlerts = (): Promise<ThreadAlertsModule> => import("./threadAlerts");
const loadBackgroundAlerts = (): Promise<BackgroundAlertsModule> =>
  import("./push/backgroundAlertsRuntime");

/**
 * Loads thread alerts once they have ever been turned on, which keeps
 * expo-notifications off the launch path of everyone else, then keeps them for
 * the unlocked workspace: a notification posted before alerts were turned off
 * still opens its thread, also after a relaunch.
 *
 * Background alerts (push through the Hub) load the same way once their switch
 * was ever touched, and keep running after it is turned off so they can remove
 * the registration again.
 */
export function ThreadAlertsBridge() {
  const { driver } = useConnectionRegistry();
  const preferences = usePreferences();
  // Unset until the switch is first turned on; off afterwards is `false`.
  const enabled = preferences.threadAlerts !== undefined;
  const backgroundEnabled = preferences.backgroundAlerts !== undefined;
  const [alertsModule, setAlertsModule] = useState<ThreadAlertsModule | null>(null);
  const [backgroundModule, setBackgroundModule] = useState<BackgroundAlertsModule | null>(null);
  const backgroundRef = useRef<BackgroundAlertsModule | null>(null);

  useEffect(() => {
    if (!enabled || alertsModule !== null) return;
    let active = true;
    void loadThreadAlerts()
      .then((loaded) => {
        if (active) setAlertsModule(loaded);
      })
      .catch((error: unknown) => console.warn("Thread alerts failed to load.", error));
    return () => {
      active = false;
    };
  }, [alertsModule, enabled]);

  useEffect(() => {
    if (!backgroundEnabled || backgroundModule !== null) return;
    let active = true;
    void loadBackgroundAlerts()
      .then((loaded) => {
        if (active) setBackgroundModule(loaded);
      })
      .catch((error: unknown) => console.warn("Background alerts failed to load.", error));
    return () => {
      active = false;
    };
  }, [backgroundEnabled, backgroundModule]);

  useEffect(() => {
    if (backgroundModule === null) return;
    backgroundRef.current = backgroundModule;
    return backgroundModule.getMobileBackgroundAlerts().start();
  }, [backgroundModule]);

  useEffect(() => {
    if (alertsModule === null) return;
    const alerts = alertsModule.startMobileThreadAlerts(
      {
        source: driver.supervisor,
        readEnvironmentThreads: (environmentId) =>
          Object.values(
            selectEnvironmentState(useStore.getState(), environmentId).sidebarThreadSummaryById,
          ),
        readPreferences: getPreferencesSnapshot,
        subscribePreferences,
        readVisibleThread,
        isBackgroundPushActive: (environmentId, kind) =>
          backgroundRef.current?.getMobileBackgroundAlerts().isConfirmed(environmentId, kind) ??
          false,
      },
      alertsModule.createExpoThreadAlertsPlatform({
        isEnvironmentLive: (environmentId) =>
          driver.supervisor.read(environmentId)?.shellSnapshotReadiness.read() != null,
      }),
    );
    return () => alerts.stop();
  }, [alertsModule, driver]);

  return null;
}
