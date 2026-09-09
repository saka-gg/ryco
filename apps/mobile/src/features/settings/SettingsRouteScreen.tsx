import { StackActions, useNavigation } from "@react-navigation/native";
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
      <SettingsSection title="Connections">
        <SettingsRow
          first
          label="Hub and account"
          onPress={() => navigation.navigate("SettingsHub" as never)}
        />
        <SettingsRow
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

      <SettingsSection title="Workspace">
        <SettingsRow
          first
          label="Inbox and AI Focus"
          onPress={() => navigation.navigate("SettingsInbox" as never)}
        />
        <SettingsRow
          label="Defaults"
          onPress={() => navigation.navigate("SettingsWorkspace" as never)}
        />
      </SettingsSection>

      <SettingsSection title="Appearance">
        <SettingsRow
          first
          label="Text and code"
          onPress={() => navigation.navigate("SettingsAppearance" as never)}
        />
      </SettingsSection>

      <SettingsSection title="App">
        <SettingsRow
          first
          label="Local storage"
          onPress={() => navigation.navigate("SettingsClientStorage" as never)}
        />
        <SettingsRow
          label="About Ryco"
          onPress={() => navigation.navigate("SettingsAbout" as never)}
        />
      </SettingsSection>
    </ScrollView>
  );
}
