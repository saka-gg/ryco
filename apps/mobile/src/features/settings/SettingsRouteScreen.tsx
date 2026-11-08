import { StackActions, useNavigation } from "@react-navigation/native";
import {
  SETTINGS_GROUP_TITLES,
  SETTINGS_SECTION_TITLES,
} from "@ryco/client-runtime/state/settings/settingsSections";
import { ScrollView } from "react-native";

import { useHostedHubStore } from "../../hostedHub/state";
import { MAIN_TABS } from "../../navigation/tabs/mainTabsModel";
import { openMainTab } from "../../navigation/tabs/openMainTab";
import {
  TabLargeTitle,
  useLargeTitleCollapse,
  useTabStackHeader,
} from "../../navigation/tabs/TabScreenChrome";
import { exactNodeRouteParams } from "../e2ee/exactNodeRouteModel";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";

/** The Settings tab: the list of settings pages, each pushed above the tabs. */
export function SettingsTabScreen() {
  const navigation = useNavigation();
  const selectedNode = useHostedHubStore((state) => state.selectedNode);
  const { collapsed, onScroll } = useLargeTitleCollapse();
  useTabStackHeader({ title: collapsed ? MAIN_TABS.Settings.title : "" });

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-screen"
      contentContainerStyle={{ paddingTop: 4, paddingBottom: 40 }}
      onScroll={onScroll}
      scrollEventThrottle={16}
    >
      <TabLargeTitle title={MAIN_TABS.Settings.title} />
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
        <SettingsRow
          label={SETTINGS_SECTION_TITLES.notifications}
          value="Alerts, Live Activity"
          onPress={() => navigation.navigate("SettingsNotifications" as never)}
        />
      </SettingsSection>

      <SettingsSection title={SETTINGS_GROUP_TITLES.work}>
        <SettingsRow
          first
          label={SETTINGS_SECTION_TITLES.inbox}
          onPress={() => navigation.navigate("SettingsInbox" as never)}
        />
        <SettingsRow
          label="Archived tasks"
          onPress={() => navigation.navigate("SettingsArchived" as never)}
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
          value="In the Usage tab"
          onPress={() => openMainTab(navigation, "Usage")}
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
            navigation.navigate("Connections");
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
