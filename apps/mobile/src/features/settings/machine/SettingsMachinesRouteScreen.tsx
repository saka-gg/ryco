import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useLayoutEffect } from "react";
import { ScrollView } from "react-native";

import { EmptyState } from "../../../components/EmptyState";
import { useHomeEnvironments } from "../../home/useHomeEnvironments";
import { SettingsRow } from "../components/SettingsRow";
import { SettingsSection } from "../components/SettingsSection";
import { machineStatusLabel } from "./machineSettingsModel";

type SettingsMachinesRouteScreenProps = StaticScreenProps<undefined>;

/**
 * The machines whose own settings this phone can open: providers, agents, work defaults and
 * the machine itself. With one machine, its page opens in place of this list.
 */
export function SettingsMachinesRouteScreen(_props: SettingsMachinesRouteScreenProps) {
  const navigation = useNavigation();
  const machines = useHomeEnvironments();
  const only = machines.length === 1 ? machines[0] : undefined;
  useLayoutEffect(() => {
    if (only)
      navigation.dispatch(
        StackActions.replace("SettingsMachine", { environmentId: only.environmentId }),
      );
  }, [navigation, only]);
  if (machines.length === 0) {
    return (
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1 bg-screen px-6 pt-16"
      >
        <EmptyState
          variant="plain"
          title="No machine yet"
          detail="Pair a machine or sign in to your Hub to change its settings here."
        />
      </ScrollView>
    );
  }
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-screen"
      contentContainerStyle={{ paddingTop: 4, paddingBottom: 40 }}
    >
      <SettingsSection footer="Each machine keeps its own providers, agents and folders. Shared settings follow you to every machine.">
        {machines.map((machine, index) => (
          <SettingsRow
            key={machine.environmentId}
            first={index === 0}
            icon="desktopcomputer"
            label={machine.label}
            value={machineStatusLabel(machine)}
            onPress={() =>
              navigation.navigate("SettingsMachine", { environmentId: machine.environmentId })
            }
          />
        ))}
      </SettingsSection>
    </ScrollView>
  );
}
