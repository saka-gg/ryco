import * as Linking from "expo-linking";
import { AppState } from "react-native";

import { mobileCliProxyHubReads } from "../state/cliProxyHubReads";
import {
  getEnvironmentServerConfigsSnapshot,
  subscribeEnvironmentServerConfigs,
} from "../state/environmentServerConfigs";
import { rycoWidgetsNative } from "./rycoWidgetsNative";
import { startWidgetsRuntime } from "./widgetsRuntime";

/**
 * The app's widgets, for as long as the workspace is unlocked (`WidgetsBridge`). Nothing runs in
 * a build without them. The returned stop empties the widgets: the workspace locks when the
 * account signs out or its last credential goes.
 */
export function startMobileWidgets(): () => void {
  const native = rycoWidgetsNative();
  if (native === null) return () => undefined;
  const runtime = startWidgetsRuntime({
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
    appState: {
      isActive: () => AppState.currentState === "active",
      subscribe: (listener) => {
        const subscription = AppState.addEventListener("change", (state) =>
          listener(state === "active"),
        );
        return () => subscription.remove();
      },
    },
    url: Linking.createURL("settings/statistics", { queryParams: { tab: "limits" } }),
  });
  return () => {
    void runtime.stop({ clear: true });
  };
}
