import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId } from "@ryco/contracts/base-schemas";
import { useLayoutEffect } from "react";
import { ScrollView } from "react-native";

import { SettingsRow } from "../components/SettingsRow";
import { SettingsSection } from "../components/SettingsSection";
import { machineSettingsSummary, machineStatusLabel } from "./machineSettingsModel";
import { useMachineSettings } from "./useMachineSettings";

type SettingsMachineRouteScreenProps = StaticScreenProps<{ readonly environmentId: string }>;

/**
 * One machine's own settings in four calm groups — Providers, Agents, Work and Machine —
 * each a page of its own, like the desktop's settings for that machine.
 */
export function SettingsMachineRouteScreen(props: SettingsMachineRouteScreenProps) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const machine = useMachineSettings(environmentId);
  const summary = machineSettingsSummary(machine.config);
  useLayoutEffect(() => {
    navigation.setOptions({ title: machine.label });
  }, [machine.label, navigation]);
  const open = (
    route:
      | "SettingsMachineProviders"
      | "SettingsMachineAgents"
      | "SettingsMachineWork"
      | "SettingsMachineSystem"
      | "SettingsMachineImport",
  ) => navigation.navigate(route, { environmentId });
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-screen"
      contentContainerStyle={{ paddingTop: 4, paddingBottom: 40 }}
    >
      <SettingsSection {...(machine.readOnlyReason ? { footer: machine.readOnlyReason } : {})}>
        <SettingsRow
          first
          icon="desktopcomputer"
          label={machine.label}
          value={machine.node ? machineStatusLabel(machine.node) : "Not paired"}
        />
      </SettingsSection>
      <SettingsSection>
        <SettingsRow
          first
          icon="cpu"
          label="Providers"
          value={summary.providers}
          detail="Agent CLIs, models, sign-in and environment"
          onPress={() => open("SettingsMachineProviders")}
        />
        <SettingsRow
          icon="puzzlepiece.extension"
          label="Agents"
          value={summary.agents}
          detail="MCP servers, plugins and Agent Control"
          onPress={() => open("SettingsMachineAgents")}
        />
        <SettingsRow
          icon="folder"
          label="Work"
          detail="Chats folder, worktrees, commit writing, responses and usage"
          onPress={() => open("SettingsMachineWork")}
        />
        <SettingsRow
          icon="gearshape.2"
          label="Machine"
          detail="Simulators, power and restarts"
          onPress={() => open("SettingsMachineSystem")}
        />
      </SettingsSection>
      <SettingsSection>
        <SettingsRow
          first
          icon="square.and.arrow.down"
          label="Import conversations"
          detail="Bring Codex or Claude Code history into Ryco"
          onPress={() => open("SettingsMachineImport")}
        />
      </SettingsSection>
    </ScrollView>
  );
}
