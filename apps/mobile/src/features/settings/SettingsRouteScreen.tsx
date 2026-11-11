import { useNavigation } from "@react-navigation/native";
import Constants from "expo-constants";
import { useMemo, useSyncExternalStore } from "react";
import { ScrollView } from "react-native";

import { readCachedMobileHubProfile, subscribeMobileHubProfile } from "../../hostedHub/hubProfile";
import { MAIN_TABS } from "../../navigation/tabs/mainTabsModel";
import {
  TabLargeTitle,
  useLargeTitleCollapse,
  useTabStackHeader,
} from "../../navigation/tabs/TabScreenChrome";
import { readMobileHostedConfig } from "../../platform/config";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import {
  buildSettingsSections,
  buildSettingsSummary,
  settingsSummaryHub,
  type SettingsListTarget,
} from "./settingsListModel";

/**
 * The Settings tab, after t3code's phone Settings: who and what this phone is
 * connected to at the top, then the settings pages in calm groups, the rarely
 * used ones last. Each page pushes above the tabs.
 */
export function SettingsTabScreen() {
  const navigation = useNavigation();
  const environments = useHomeEnvironments();
  // Follows the saved Hub profile: the tab stays mounted while Hub and account changes it.
  const cachedHub = useSyncExternalStore(subscribeMobileHubProfile, readCachedMobileHubProfile);
  const buildHubOrigin = useMemo(() => readMobileHostedConfig()?.hubOrigin ?? null, []);
  const hub = settingsSummaryHub(cachedHub, buildHubOrigin);
  const summary = buildSettingsSummary({
    hub,
    machines: {
      total: environments.length,
      connected: environments.filter((environment) => environment.connectionState === "connected")
        .length,
    },
  });
  const sections = useMemo(
    () => buildSettingsSections({ version: Constants.expoConfig?.version ?? null }),
    [],
  );
  const { collapsed, onScroll } = useLargeTitleCollapse();
  useTabStackHeader({ title: collapsed ? MAIN_TABS.Settings.title : "" });

  const open = (target: SettingsListTarget) => navigation.navigate(target as never);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-screen"
      contentContainerStyle={{ paddingTop: 4, paddingBottom: 40 }}
      onScroll={onScroll}
      scrollEventThrottle={16}
    >
      <TabLargeTitle title={MAIN_TABS.Settings.title} />
      <SettingsSection>
        <SettingsRow
          first
          icon="person.crop.circle"
          label={summary.hubLabel}
          detail={summary.hubDetail ?? undefined}
          onPress={() => open("SettingsHub")}
        />
        {/* The one way into machines: each machine's page holds its connection, its own
            settings, its access and security. */}
        <SettingsRow
          icon="desktopcomputer"
          label="Machines"
          value={summary.machinesValue}
          onPress={() => open("Connections")}
        />
      </SettingsSection>
      {sections.map((section) => (
        <SettingsSection key={section.key} title={section.title}>
          {section.rows.map((row, index) => (
            <SettingsRow
              key={row.id}
              first={index === 0}
              icon={row.icon}
              label={row.label}
              value={row.value}
              onPress={() => open(row.id)}
            />
          ))}
        </SettingsSection>
      ))}
    </ScrollView>
  );
}
