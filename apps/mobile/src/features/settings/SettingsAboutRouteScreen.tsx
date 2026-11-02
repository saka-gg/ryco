import { useNavigation } from "@react-navigation/native";
import Constants from "expo-constants";
import { ScrollView } from "react-native";

import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";

function buildStageLabel(): string {
  const variant = Constants.expoConfig?.extra?.appVariant;
  if (variant === "development") return "Development";
  if (variant === "preview") return "Preview";
  return "Production";
}

export function SettingsAboutRouteScreen() {
  const navigation = useNavigation();
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-screen"
      contentContainerStyle={{ paddingTop: 4, paddingBottom: 40 }}
    >
      <SettingsSection title="Ryco">
        <SettingsRow first label="Version" value={Constants.expoConfig?.version ?? "Unknown"} />
        <SettingsRow label="Build" value={buildStageLabel()} />
      </SettingsSection>

      <SettingsSection title="Information">
        <SettingsRow
          first
          label="Diagnostics"
          value="On device"
          onPress={() => navigation.navigate("SettingsDiagnostics" as never)}
        />
        <SettingsRow label="Privacy" value="Node-owned workspace data" />
        <SettingsRow label="Licenses" value="Open source" />
      </SettingsSection>
    </ScrollView>
  );
}
