import { MenuView } from "@react-native-menu/menu";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  acpLocalCommandError,
  localCommandConfig,
  registryAgentConfig,
} from "@ryco/client-runtime/state/settings/acpAgentConfig";
import type { ProviderInstanceId } from "@ryco/contracts";
import { EnvironmentId } from "@ryco/contracts/base-schemas";
import type { ProviderDriverKind } from "@ryco/contracts/provider-instance";
import { useState } from "react";
import { Alert, ScrollView } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { ProviderIcon } from "../../../components/ProviderIcon";
import { SettingsRow } from "../components/SettingsRow";
import { SettingsSection } from "../components/SettingsSection";
import { AcpRegistryPickerSheet, type AcpAgentInstallation } from "./AcpRegistryPickerSheet";
import {
  ADD_PROVIDER_CHOICES,
  buildAddProviderInstance,
  buildProviderInstancesList,
  type AddProviderChoice,
} from "./providerInstancesModel";
import { useMachineSettings } from "./useMachineSettings";

type Props = StaticScreenProps<{ readonly environmentId: string }>;

const ACP_DRIVER = "acpRegistry";

function promptText(value: string | undefined): string {
  return value === undefined ? "" : value;
}

/**
 * One machine's provider instances, as its Settings → Providers lists them: every built-in
 * driver's instance and the ones added beside it, with their state. Tapping one opens its
 * settings; "Add provider" adds another instance of a driver (a second Codex for another account,
 * an ACP agent), only from the machine's owner.
 */
export function SettingsMachineProvidersRouteScreen(props: Props) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const machine = useMachineSettings(environmentId);
  const view = buildProviderInstancesList({
    node: machine.node,
    config: machine.config,
    connected: machine.connected,
  });
  // The name of an ACP instance waiting for its registry agent.
  const [pendingAcp, setPendingAcp] = useState<{ readonly label: string } | null>(null);

  const openInstance = (instanceId: ProviderInstanceId) =>
    navigation.navigate("SettingsMachineProvider", { environmentId, instanceId });
  const add = async (
    driver: ProviderDriverKind,
    label: string,
    config: Record<string, unknown> | undefined,
  ) => {
    if (machine.config === null) return false;
    const { instanceId, patch } = buildAddProviderInstance({
      settings: machine.config.settings,
      takenIds: view.takenIds,
      driver,
      label,
      config,
    });
    const saved = await machine.write(patch);
    if (saved) openInstance(instanceId);
    return saved;
  };

  const promptLocalCommand = (driver: ProviderDriverKind, label: string) =>
    Alert.prompt(
      "Local command",
      `An absolute path or a command name on ${machine.label}'s PATH. Ryco starts it without a shell.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Add",
          onPress: (value?: string) => {
            const command = promptText(value).trim();
            const problem =
              command.length === 0 ? "Enter the executable." : acpLocalCommandError(command);
            if (problem !== null) {
              Alert.alert("Can't add this agent", problem);
              return;
            }
            void add(driver, label, localCommandConfig({}, { command, args: [] }));
          },
        },
      ],
      "plain-text",
    );

  const chooseAcpSource = (driver: ProviderDriverKind, label: string) =>
    Alert.alert(
      "Agent source",
      "Install an agent from the ACP registry, or run one already on the machine.",
      [
        { text: "Registry agent", onPress: () => setPendingAcp({ label }) },
        { text: "Local command", onPress: () => promptLocalCommand(driver, label) },
        { text: "Cancel", style: "cancel" },
      ],
    );

  const startAdd = (choice: AddProviderChoice) =>
    Alert.prompt(
      `Add ${choice.label}`,
      "Name this instance, such as Work. The name tells it apart in pickers.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: choice.driver === ACP_DRIVER ? "Next" : "Add",
          onPress: (value?: string) => {
            const label = promptText(value).trim();
            if (choice.driver === ACP_DRIVER) chooseAcpSource(choice.driver, label);
            else void add(choice.driver, label, undefined);
          },
        },
      ],
      "plain-text",
    );

  const pickRegistryAgent = (installation: AcpAgentInstallation) => {
    const label = pendingAcp === null ? "" : pendingAcp.label;
    setPendingAcp(null);
    void add(ACP_DRIVER as ProviderDriverKind, label, registryAgentConfig({}, installation));
  };

  const canAdd = machine.editable && machine.config !== null && !machine.saving;
  const addRow = (
    <SettingsRow
      first={view.rows === null || view.rows.length === 0}
      icon={{ ios: "plus", android: "add" }}
      label="Add provider"
      disabled={!canAdd}
    />
  );

  return (
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1 bg-screen"
        contentContainerStyle={{ paddingTop: 4, paddingBottom: 48 }}
      >
        {machine.readOnlyReason ? (
          <Text className="px-6 pt-3 text-xs text-foreground-muted">{machine.readOnlyReason}</Text>
        ) : null}
        {machine.error ? (
          <Text className="px-6 pt-3 text-xs text-danger-foreground">{machine.error}</Text>
        ) : null}
        <SettingsSection
          title="Providers"
          footer="Each instance runs its provider's CLI on this machine with its own settings, account and environment."
        >
          {view.rows === null ? (
            <SettingsRow
              first
              label={machine.connected ? "Loading providers…" : "Not connected"}
              detail={machine.connected ? undefined : "Connect this machine to see its providers."}
            />
          ) : (
            view.rows.map((row, index) => (
              <SettingsRow
                key={row.instanceId}
                first={index === 0}
                leading={<ProviderIcon provider={row.driver} size={18} />}
                label={row.label}
                value={row.status}
                detail={row.detail}
                onPress={() => openInstance(row.instanceId)}
              />
            ))
          )}
        </SettingsSection>
        <SettingsSection>
          {canAdd ? (
            <MenuView
              shouldOpenOnLongPress={false}
              title="Add an instance of"
              actions={ADD_PROVIDER_CHOICES.map((choice) => ({
                id: choice.driver,
                title: choice.label,
                ...(choice.badge ? { subtitle: choice.badge } : {}),
              }))}
              onPressAction={({ nativeEvent }) => {
                const choice = ADD_PROVIDER_CHOICES.find(
                  (candidate) => candidate.driver === nativeEvent.event,
                );
                if (choice !== undefined) startAdd(choice);
              }}
            >
              {addRow}
            </MenuView>
          ) : (
            addRow
          )}
        </SettingsSection>
      </ScrollView>
      {pendingAcp !== null ? (
        <AcpRegistryPickerSheet
          environmentId={environmentId}
          nodeLabel={machine.label}
          selected={null}
          canInstall={machine.editable}
          readOnlyReason={machine.readOnlyReason}
          onSelect={pickRegistryAgent}
          onClose={() => setPendingAcp(null)}
        />
      ) : null}
    </>
  );
}
