import { useEffect } from "react";
import { AppState } from "react-native";

import { updateEnvironmentServerSettings } from "../../../connection/environmentApi";
import { useEnvironmentServerConfigs } from "../../../state/environmentServerConfigs";
import { useHomeEnvironments } from "../../home/useHomeEnvironments";
import { homeNodeSettingsTargets } from "../nodeSettingsTargets";
import { mobileSettingsSharing, publishSettingsSharingTargets } from "./mobileSettingsSharing";
import {
  runSettingsSharingInForeground,
  type SettingsSharingAppState,
} from "./settingsSharingForeground";

const reactNativeAppState: SettingsSharingAppState = {
  isForeground: () => AppState.currentState !== "background",
  subscribe: (listener) => {
    const subscription = AppState.addEventListener("change", (state) =>
      listener(state !== "background"),
    );
    return () => subscription.remove();
  },
};

/**
 * Keeps shared device settings converged from the phone while it is in the foreground: hands
 * the runtime the nodes as Home lists them (each with its connection and whether this phone may
 * change it now) and runs it only while the app is in the foreground.
 */
export function SettingsSharingFeed() {
  const nodes = useHomeEnvironments();
  const configs = useEnvironmentServerConfigs();
  useEffect(() => {
    publishSettingsSharingTargets(
      homeNodeSettingsTargets({ nodes, configs, write: updateEnvironmentServerSettings }),
    );
  }, [configs, nodes]);
  useEffect(
    () => runSettingsSharingInForeground(reactNativeAppState, mobileSettingsSharing.start),
    [],
  );
  return null;
}
