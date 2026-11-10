import * as Linking from "expo-linking";
import { useEffect } from "react";

import { useHomeEnvironments } from "../features/home/useHomeEnvironments";
import { isAppInFront, subscribeAppInFront } from "../platform/appInFront";
import { mobileCliProxyHubReads } from "../state/cliProxyHubReads";
import {
  getEnvironmentServerConfigsSnapshot,
  subscribeEnvironmentServerConfigs,
} from "../state/environmentServerConfigs";
import { rycoWidgetsNative } from "./rycoWidgetsNative";
import { startWidgetsRuntime, type WidgetsRuntime } from "./widgetsRuntime";

/**
 * The app's widgets, for as long as the workspace is unlocked (`WidgetsBridge`), or null in a
 * build without them. Its `stop({ clear: true })` empties the widgets: the workspace locks when
 * the account signs out or its last credential goes.
 */
export function startMobileWidgets(): WidgetsRuntime | null {
  const native = rycoWidgetsNative();
  if (native === null) return null;
  return startWidgetsRuntime({
    native,
    configs: {
      snapshot: getEnvironmentServerConfigsSnapshot,
      subscribe: subscribeEnvironmentServerConfigs,
    },
    hubs: {
      snapshot: () => mobileCliProxyHubReads.snapshot(),
      subscribe: (listener) => mobileCliProxyHubReads.subscribe(listener),
      read: (environmentId) => mobileCliProxyHubReads.read(environmentId),
    },
    // A Notification Center pull is no leaving the app (`isAppInFront`).
    appState: { isActive: isAppInFront, subscribe: subscribeAppInFront },
    url: Linking.createURL("usage", { queryParams: { tab: "limits" } }),
  });
}

/**
 * Hands the runtime the machines as Home lists them, with their connection and role, so the
 * widget shows only the machines whose limits the Limits tab reads.
 */
export function WidgetsFeed({ runtime }: { readonly runtime: WidgetsRuntime }) {
  const environments = useHomeEnvironments();
  useEffect(() => {
    runtime.setEnvironments(environments);
  }, [environments, runtime]);
  return null;
}
