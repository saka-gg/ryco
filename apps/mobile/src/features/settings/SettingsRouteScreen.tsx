import { StackActions, useNavigation } from "@react-navigation/native";
import {
  SETTINGS_GROUP_TITLES,
  SETTINGS_SECTION_TITLES,
} from "@ryco/client-runtime/state/settings/settingsSections";
import { useLayoutEffect } from "react";
import { ScrollView } from "react-native";

import { NavigationHeaderButton } from "../../components/NavigationHeaderButton";
import { useHostedHubStore } from "../../hostedHub/state";
import { exactNodeRouteParams } from "../e2ee/exactNodeRouteModel";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { openMachinesFromSettings } from "./openMachinesFromSettings";

export function SettingsRouteScreen() {
  const navigation = useNavigation();
  const selectedNode = useHostedHubStore((state) => state.selectedNode);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: () => (
        <NavigationHeaderButton
          action="close"
          accessibilityLabel="Close Settings"
          onPress={() => {
            const parent = navigation.getParent();
            if (parent?.canGoBack()) parent.goBack();
            else parent?.dispatch(StackActions.replace("Home"));
          }}
        />
      ),
    });
  }, [navigation]);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-screen"
      contentContainerStyle={{ paddingTop: 4, paddingBottom: 40 }}
    >
      {/* Grouped and named as the web's settings (`settingsSections`) where a screen matches. */}
      <SettingsSection title={SETTINGS_GROUP_TITLES.you}>
        <SettingsRow
          first
          label="Hub and account"
          onPress={() => navigation.navigate("SettingsHub" as never)}
        />
        <SettingsRow
          label={SETTINGS_SECTION_TITLES.appearance}
          value="Text and code"
          onPress={() => navigation.navigate("SettingsAppearance" as never)}
        />
      </SettingsSection>

      <SettingsSection title={SETTINGS_GROUP_TITLES.work}>
        <SettingsRow
          first
          label={SETTINGS_SECTION_TITLES.inbox}
          onPress={() => navigation.navigate("SettingsInbox" as never)}
        />
        <SettingsRow
          label="Defaults"
          value="Per node"
          onPress={() => navigation.navigate("SettingsWorkspace" as never)}
        />
      </SettingsSection>

      <SettingsSection title={SETTINGS_GROUP_TITLES.agents}>
        <SettingsRow
          first
          label={SETTINGS_SECTION_TITLES.usage}
          value="Usage, activity, limits"
          onPress={() => navigation.navigate("SettingsStatistics" as never)}
        />
        <SettingsRow
          label="Provider accounts"
          onPress={() => navigation.navigate("SettingsProviderAccounts" as never)}
        />
      </SettingsSection>

      <SettingsSection title={SETTINGS_GROUP_TITLES.devices}>
        <SettingsRow
          first
          label="Node security"
          value="Advanced"
          onPress={() => {
            if (selectedNode) {
              navigation.dispatch(
                StackActions.push("SettingsNodeSecurity", exactNodeRouteParams(selectedNode)),
              );
              return;
            }
            openMachinesFromSettings(navigation);
          }}
        />
      </SettingsSection>

      <SettingsSection title={SETTINGS_GROUP_TITLES.system}>
        <SettingsRow
          first
          label="Storage & cache"
          onPress={() => navigation.navigate("SettingsClientStorage" as never)}
        />
        <SettingsRow
          label={SETTINGS_SECTION_TITLES.about}
          onPress={() => navigation.navigate("SettingsAbout" as never)}
        />
      </SettingsSection>
    </ScrollView>
  );
}
