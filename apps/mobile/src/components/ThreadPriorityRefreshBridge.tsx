import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { mobileAppLifecycle } from "../platform/appLifecycle";
import { useConnectionRegistry } from "../providers/ConnectionRegistryProvider";
import { useWsConnectionStatusesForEnvironments } from "../rpc/wsConnectionState";
import { useEnvironmentServerConfigs } from "../state/environmentServerConfigs";
import { usePreferences } from "../state/preferencesStore";
import { selectSidebarThreadsAcrossEnvironments, useStore } from "../state/threadsRuntime";
import {
  configureMobileThreadPriorityRefresh,
  notifyMobileThreadPriorityEnvironmentsChanged,
  notifyMobileThreadPriorityInputChanged,
  setMobileThreadPriorityForeground,
  setMobileThreadPriorityRefreshEnvironments,
} from "../threadPriorityRefreshRuntime";

export function ThreadPriorityRefreshBridge() {
  const { driver } = useConnectionRegistry();
  const [connections, setConnections] = useState(() => driver.supervisor.list());
  const configs = useEnvironmentServerConfigs();
  const preferences = usePreferences();
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));

  useEffect(
    () =>
      driver.supervisor.subscribe(() => {
        setConnections(driver.supervisor.list());
      }),
    [driver],
  );

  // Each connection's own socket, subscribed, so a socket that reopens or drops
  // without the connection list changing still reaches the coordinator. (A
  // `void openedCount` version key here was dropped by React Compiler, which
  // keys a memo on what its callback reads.)
  const statuses = useWsConnectionStatusesForEnvironments(
    connections.map((connection) => connection.environmentId),
  );
  const environments = useMemo(
    () =>
      connections.map((connection) => {
        const status = statuses.get(connection.environmentId);
        return {
          environmentId: connection.environmentId,
          generation: status?.attemptCount ?? 0,
          connected: status?.phase === "connected",
          supported:
            configs.get(connection.environmentId)?.environment.capabilities
              .threadPriorityRanking === true,
        };
      }),
    [configs, connections, statuses],
  );

  // `environments` is rebuilt on every status write of a listed socket (retry
  // timers, errors, online flips); the coordinator only hears about the ones
  // that change what it decides on.
  useEffect(() => {
    if (setMobileThreadPriorityRefreshEnvironments(environments)) {
      void notifyMobileThreadPriorityEnvironmentsChanged();
    }
  }, [environments]);

  useEffect(() => {
    void configureMobileThreadPriorityRefresh({
      enabled: preferences.aiFocusEnabled ?? false,
      intervalMs: preferences.aiFocusRefreshIntervalMs ?? 600_000,
    });
  }, [preferences.aiFocusEnabled, preferences.aiFocusRefreshIntervalMs]);

  useEffect(() => {
    notifyMobileThreadPriorityInputChanged();
  }, [threads]);

  useEffect(() => {
    void setMobileThreadPriorityForeground(mobileAppLifecycle.isForeground());
    return mobileAppLifecycle.subscribe((event) => {
      if (event === "background") void setMobileThreadPriorityForeground(false);
      if (event === "foreground" || event === "resume") {
        void setMobileThreadPriorityForeground(true);
      }
    });
  }, []);

  return null;
}
