import { MenuView, type MenuAction } from "@react-native-menu/menu";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  acpLocalCommandError,
  localCommandConfig,
  registryAgentConfig,
  type AcpAgentConfig,
} from "@ryco/client-runtime/state/settings/acpAgentConfig";
import {
  withProviderInstanceConfig,
  withProviderInstanceDisplayName,
  withProviderInstanceEnvironment,
} from "@ryco/client-runtime/state/settings/providerInstanceSettings";
import type { ProviderInstanceConfig, ProviderInstanceEnvironmentVariable } from "@ryco/contracts";
import { ACP_LOCAL_COMMAND_MAX_ARGS } from "@ryco/contracts/acp-registry";
import { EnvironmentId } from "@ryco/contracts/base-schemas";
import { ProviderInstanceId } from "@ryco/contracts/provider-instance";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { Alert, ScrollView } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { SettingsRow } from "../components/SettingsRow";
import { SettingsSection } from "../components/SettingsSection";
import { SettingsSwitchRow } from "../components/SettingsSwitchRow";
import { ProviderSignInSheet } from "../ProviderSignInSheet";
import { providerSignInAccess } from "../providerAccountsModel";
import { AcpAgentAuthenticationRows } from "./AcpAgentAuthenticationRows";
import { AcpRegistryPickerSheet, type AcpAgentInstallation } from "./AcpRegistryPickerSheet";
import { ChoiceSettingRow, TextSettingRow } from "./MachineSettingRows";
import {
  buildProviderInstanceDetail,
  configWithFieldText,
  configWithFieldValue,
  environmentNeedsValueForPlain,
  environmentWithAdded,
  environmentWithout,
  environmentWithSensitivity,
  environmentWithValue,
  instanceWithAddedModel,
  instanceWithoutModel,
  providerInstanceEditPatch,
  providerInstanceRemovePatch,
  providerInstanceResetPatch,
  type EnvironmentEdit,
  type ProviderEnvironmentRow,
  type ProviderFieldRow,
  type ProviderInstanceDetail,
} from "./providerInstancesModel";
import { useMachineSettings } from "./useMachineSettings";

type Props = StaticScreenProps<{ readonly environmentId: string; readonly instanceId: string }>;

const ENVIRONMENT_FOOTER =
  "Passed to this provider's CLI. Sensitive values are stored on the machine and never shown again, here or anywhere else.";

function promptText(value: string | undefined): string {
  return value === undefined ? "" : value;
}

/** A row that opens a native menu of actions; inert (and dimmed) without them. */
function MenuRow(props: {
  readonly actions: ReadonlyArray<MenuAction>;
  readonly onAction: (id: string) => void;
  readonly disabled: boolean;
  readonly children: ReactNode;
}) {
  if (props.disabled || props.actions.length === 0) return <>{props.children}</>;
  return (
    <MenuView
      shouldOpenOnLongPress={false}
      actions={[...props.actions]}
      onPressAction={({ nativeEvent }) => props.onAction(nativeEvent.event)}
    >
      {props.children}
    </MenuView>
  );
}

/**
 * One provider instance of a machine, after the web's provider card: on or off, its account
 * (with a sign-in where the provider takes one from Ryco), its name, custom models, environment
 * variables, an ACP agent's source, and the driver's own settings under Advanced. Secrets are
 * write-only: the phone shows whether one is saved and can replace or clear it, never read it.
 */
export function SettingsMachineProviderRouteScreen(props: Props) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const instanceId = ProviderInstanceId.make(props.route.params.instanceId);
  const machine = useMachineSettings(environmentId);
  const [signingIn, setSigningIn] = useState(false);
  const [choosingAgent, setChoosingAgent] = useState(false);
  const detail =
    machine.config === null
      ? null
      : buildProviderInstanceDetail({
          node: machine.node,
          config: machine.config,
          instanceId,
          connected: machine.connected,
        });
  const title = detail === null ? "Provider" : detail.displayName;
  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);

  if (machine.config === null || detail === null) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" className="flex-1 bg-screen">
        <SettingsSection>
          <SettingsRow
            first
            label={
              machine.config !== null
                ? "Not on this machine"
                : machine.connected
                  ? "Loading settings…"
                  : "Not connected"
            }
            detail={
              machine.config !== null
                ? `${machine.label} has no provider instance ${instanceId} any more.`
                : machine.connected
                  ? undefined
                  : "Connect this machine to see its providers."
            }
          />
        </SettingsSection>
      </ScrollView>
    );
  }

  const settings = machine.config.settings;
  const off = !machine.editable || machine.saving;
  const save = (next: ProviderInstanceConfig) =>
    machine.write(providerInstanceEditPatch(settings, detail.row, next));
  const saveConfig = (config: Record<string, unknown> | undefined | null) =>
    config === null
      ? Promise.resolve(true)
      : save(withProviderInstanceConfig(detail.row.instance, config));
  const saveEnvironment = (edit: EnvironmentEdit) => {
    if (!edit.ok) {
      Alert.alert("Can't save this variable", edit.error);
      return;
    }
    void save(withProviderInstanceEnvironment(detail.row.instance, edit.environment));
  };
  const account = detail.account;
  const canSignIn = account !== undefined && account.canSignIn && machine.node !== null;

  const confirmRemove = () =>
    Alert.alert(
      `Remove ${detail.displayName}?`,
      "This removes the instance and its environment variables from the machine. Chats that use it may no longer start; text generation returns to its default if it used it.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void machine
              .write(providerInstanceRemovePatch(settings, detail.row))
              .then((removed) => {
                if (removed) navigation.goBack();
              });
          },
        },
      ],
    );
  const confirmReset = () => {
    const patch = providerInstanceResetPatch(settings, detail.row);
    if (patch === null) return;
    Alert.alert(
      `Reset ${detail.displayName}?`,
      "This restores the built-in settings, deletes its environment variables and stored secrets, and resets text generation if it uses this instance.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Reset", style: "destructive", onPress: () => void machine.write(patch) },
      ],
    );
  };

  return (
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1 bg-screen"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingTop: 4, paddingBottom: 48 }}
      >
        {machine.readOnlyReason ? (
          <Text className="px-6 pt-3 text-xs text-foreground-muted">{machine.readOnlyReason}</Text>
        ) : null}
        {machine.error ? (
          <Text className="px-6 pt-3 text-xs text-danger-foreground">{machine.error}</Text>
        ) : null}

        <SettingsSection>
          <SettingsSwitchRow
            first
            label="Enabled"
            detail={detail.enabled ? undefined : "New chats can't use it while it is off."}
            value={detail.enabled}
            disabled={off}
            onValueChange={(enabled) => void save({ ...detail.row.instance, enabled })}
          />
          <SettingsRow
            label="Status"
            value={detail.status}
            detail={detail.statusDetail}
            {...(canSignIn ? { onPress: () => setSigningIn(true) } : {})}
          />
          {detail.version !== undefined ? (
            <SettingsRow label="Version" value={detail.version} />
          ) : null}
          <TextSettingRow
            label="Display name"
            value={detail.row.instance.displayName ?? ""}
            emptyLabel={
              detail.definition === undefined ? String(detail.row.driver) : detail.definition.label
            }
            placeholder={detail.definition === undefined ? undefined : detail.definition.label}
            maxLength={120}
            disabled={off}
            onSave={(value) => save(withProviderInstanceDisplayName(detail.row.instance, value))}
          />
        </SettingsSection>

        {detail.definition === undefined ? (
          <SettingsSection>
            <SettingsRow
              first
              label="Driver not supported here"
              detail={`This instance uses a driver (${String(detail.row.driver)}) this version of Ryco does not ship. Its driver settings are kept, but can't be changed here.`}
            />
          </SettingsSection>
        ) : null}

        {detail.acp !== null ? (
          <AcpAgentSection
            acp={detail.acp}
            config={detail.row.instance.config}
            off={off}
            onChooseAgent={() => setChoosingAgent(true)}
            onSave={saveConfig}
          />
        ) : null}
        {detail.acp !== null ? (
          <AcpAgentAuthenticationRows
            // A new agent or command starts the check over.
            key={`${instanceId}:${JSON.stringify(detail.row.instance.config)}`}
            environmentId={environmentId}
            instanceId={instanceId}
            source={detail.acp.source}
            allowed={machine.editable}
            readOnlyReason={machine.readOnlyReason}
          />
        ) : null}

        {detail.definition !== undefined ? (
          <ModelsSection detail={detail} off={off} onSave={save} />
        ) : null}

        <EnvironmentSection
          rows={detail.environmentRows}
          environment={detail.environment}
          off={off}
          onEdit={saveEnvironment}
        />

        <SettingsSection title="Advanced">
          {detail.fields.map((row, index) => (
            <FieldRow
              key={row.field.key}
              row={row}
              first={index === 0}
              config={detail.row.instance.config}
              off={off}
              onSave={saveConfig}
            />
          ))}
          <SettingsRow
            first={detail.fields.length === 0}
            label="Instance ID"
            value={detail.row.instanceId}
          />
          <SettingsRow
            label="Driver"
            value={
              detail.definition === undefined ? String(detail.row.driver) : detail.definition.label
            }
            detail={detail.definition === undefined ? undefined : detail.definition.badgeLabel}
          />
        </SettingsSection>

        {detail.canRemove || detail.canReset ? (
          <SettingsSection>
            {detail.canRemove ? (
              <SettingsRow
                first
                destructive
                label="Remove provider"
                disabled={off}
                onPress={confirmRemove}
              />
            ) : (
              <SettingsRow
                first
                destructive
                label="Reset to defaults"
                disabled={off}
                onPress={confirmReset}
              />
            )}
          </SettingsSection>
        ) : null}
      </ScrollView>

      {signingIn && account !== undefined && machine.node !== null ? (
        <ProviderSignInSheet
          target={{
            environmentId,
            instanceId,
            nodeLabel: machine.label,
            displayName: detail.displayName,
          }}
          provider={account.provider}
          instanceEnabled={account.instanceEnabled}
          access={providerSignInAccess(machine.node)}
          onClose={() => setSigningIn(false)}
        />
      ) : null}
      {choosingAgent && detail.acp !== null ? (
        <AcpRegistryPickerSheet
          environmentId={environmentId}
          nodeLabel={machine.label}
          selected={
            detail.acp.agentId.length > 0
              ? { agentId: detail.acp.agentId, version: detail.acp.version }
              : null
          }
          canInstall={machine.editable}
          readOnlyReason={machine.readOnlyReason}
          onSelect={(installation: AcpAgentInstallation) => {
            setChoosingAgent(false);
            void saveConfig(registryAgentConfig(detail.row.instance.config, installation));
          }}
          onClose={() => setChoosingAgent(false)}
        />
      ) : null}
    </>
  );
}

/** One driver setting: an in-place text field, a choice, a switch, or a write-only secret. */
function FieldRow(props: {
  readonly row: ProviderFieldRow;
  readonly first: boolean;
  readonly config: unknown;
  readonly off: boolean;
  readonly onSave: (config: Record<string, unknown> | undefined | null) => Promise<boolean>;
}) {
  const { row, config } = props;
  const field = row.field;
  if (row.kind === "switch") {
    return (
      <SettingsSwitchRow
        first={props.first}
        label={field.label}
        detail={row.note}
        value={row.checked}
        disabled={props.off}
        onValueChange={(value) => void props.onSave(configWithFieldValue(config, field, value))}
      />
    );
  }
  if (row.kind === "select") {
    return (
      <ChoiceSettingRow
        first={props.first}
        label={field.label}
        detail={row.note}
        value={row.promptDefault === "" ? (field.defaultStringValue ?? "") : row.promptDefault}
        options={field.options ?? []}
        disabled={props.off}
        onPick={(value) => void props.onSave(configWithFieldValue(config, field, value))}
      />
    );
  }
  if (row.kind === "secret") {
    const replace = () =>
      Alert.prompt(
        field.label,
        row.saved ? "Enter a new value to replace the saved one." : "Enter the value to save.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Save",
            onPress: (value?: string) =>
              void props.onSave(configWithFieldText(config, row, promptText(value))),
          },
        ],
        "secure-text",
      );
    return (
      <MenuRow
        disabled={props.off}
        actions={[
          { id: "replace", title: row.saved ? "Replace…" : "Set…" },
          ...(row.saved
            ? [{ id: "clear", title: "Clear", attributes: { destructive: true } }]
            : []),
        ]}
        onAction={(id) => {
          if (id === "replace") replace();
          if (id === "clear") void props.onSave(configWithFieldValue(config, field, ""));
        }}
      >
        <SettingsRow
          first={props.first}
          label={field.label}
          value={row.value}
          detail={row.note}
          disabled={props.off}
        />
      </MenuRow>
    );
  }
  return (
    <TextSettingRow
      first={props.first}
      label={field.label}
      value={row.promptDefault}
      emptyLabel={row.value}
      detail={row.note}
      placeholder={field.placeholder}
      disabled={props.off}
      onSave={(value) => props.onSave(configWithFieldText(config, row, value))}
    />
  );
}

function ModelsSection(props: {
  readonly detail: ProviderInstanceDetail;
  readonly off: boolean;
  readonly onSave: (instance: ProviderInstanceConfig) => Promise<boolean>;
}) {
  const { detail } = props;
  const addModel = () =>
    Alert.prompt(
      "Add a model",
      "Its slug, as the provider names it.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Add",
          onPress: (value?: string) => {
            const edit = instanceWithAddedModel(detail, promptText(value));
            if (!edit.ok) {
              Alert.alert("Can't add this model", edit.error);
              return;
            }
            void props.onSave(edit.instance);
          },
        },
      ],
      "plain-text",
    );
  const count = detail.builtInModelCount;
  return (
    <SettingsSection
      title="Custom models"
      footer={
        count === 0
          ? "Models this provider doesn't list itself. They show in the model picker."
          : `${count === 1 ? "1 built-in model" : `${count} built-in models`}, and these after them in the model picker.`
      }
    >
      {detail.customModels.map((slug, index) => (
        <MenuRow
          key={slug}
          disabled={props.off}
          actions={[{ id: "remove", title: "Remove", attributes: { destructive: true } }]}
          onAction={() => void props.onSave(instanceWithoutModel(detail, slug))}
        >
          <SettingsRow first={index === 0} label={slug} disabled={props.off} />
        </MenuRow>
      ))}
      <SettingsRow
        first={detail.customModels.length === 0}
        icon={{ ios: "plus", android: "add" }}
        label="Add model"
        disabled={props.off}
        onPress={addModel}
      />
    </SettingsSection>
  );
}

function EnvironmentSection(props: {
  readonly rows: ReadonlyArray<ProviderEnvironmentRow>;
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly off: boolean;
  readonly onEdit: (edit: EnvironmentEdit) => void;
}) {
  const { environment } = props;
  const promptValue = (
    title: string,
    message: string,
    secure: boolean,
    initial: string,
    onValue: (value: string) => void,
  ) =>
    Alert.prompt(
      title,
      message,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Save", onPress: (value?: string) => onValue(promptText(value)) },
      ],
      secure ? "secure-text" : "plain-text",
      initial,
    );
  const addVariable = () =>
    Alert.prompt(
      "Add a variable",
      "Its name, such as ANTHROPIC_BASE_URL.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Next",
          onPress: (value?: string) => {
            const name = promptText(value).trim();
            Alert.prompt(
              name,
              "Its value. A sensitive one is never shown again.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Save as plain text",
                  onPress: (text?: string) =>
                    props.onEdit(
                      environmentWithAdded(environment, {
                        name,
                        value: promptText(text),
                        sensitive: false,
                      }),
                    ),
                },
                {
                  text: "Save sensitive",
                  onPress: (text?: string) =>
                    props.onEdit(
                      environmentWithAdded(environment, {
                        name,
                        value: promptText(text),
                        sensitive: true,
                      }),
                    ),
                },
              ],
              "secure-text",
            );
          },
        },
      ],
      "plain-text",
    );
  const act = (row: ProviderEnvironmentRow, id: string) => {
    if (id === "value") {
      promptValue(
        row.name,
        row.sensitive
          ? "Enter a new value. The saved one stays if you leave it empty."
          : "Its value.",
        row.sensitive,
        row.promptDefault,
        (value) => props.onEdit(environmentWithValue(environment, row.name, value)),
      );
    }
    if (id === "plain") {
      if (environmentNeedsValueForPlain(row)) {
        promptValue(
          row.name,
          "Enter the value again to store it as plain text. It will be visible in settings.",
          false,
          "",
          (value) => props.onEdit(environmentWithSensitivity(environment, row.name, false, value)),
        );
      } else {
        props.onEdit(environmentWithSensitivity(environment, row.name, false));
      }
    }
    if (id === "sensitive") props.onEdit(environmentWithSensitivity(environment, row.name, true));
    if (id === "remove")
      props.onEdit({ ok: true, environment: environmentWithout(environment, row.name) });
  };
  return (
    <SettingsSection title="Environment variables" footer={ENVIRONMENT_FOOTER}>
      {props.rows.map((row, index) => (
        <MenuRow
          key={row.name}
          disabled={props.off}
          actions={[
            { id: "value", title: row.sensitive ? "Replace value…" : "Edit value…" },
            row.sensitive
              ? { id: "plain", title: "Store as plain text" }
              : { id: "sensitive", title: "Mark sensitive" },
            { id: "remove", title: "Remove", attributes: { destructive: true } },
          ]}
          onAction={(id) => act(row, id)}
        >
          <SettingsRow
            first={index === 0}
            label={row.name}
            value={row.value}
            detail={row.sensitive ? "Sensitive" : undefined}
            disabled={props.off}
          />
        </MenuRow>
      ))}
      <SettingsRow
        first={props.rows.length === 0}
        icon={{ ios: "plus", android: "add" }}
        label="Add variable"
        detail={
          props.rows.length === 0
            ? "API keys, base URLs and other settings of this instance's CLI."
            : undefined
        }
        disabled={props.off}
        onPress={addVariable}
      />
    </SettingsSection>
  );
}

/** Keys for values that may repeat: each value with how many times it came before. */
function occurrenceKeys(values: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Map<string, number>();
  return values.map((value) => {
    const count = (seen.get(value) ?? 0) + 1;
    seen.set(value, count);
    return `${count}:${value}`;
  });
}

/**
 * An ACP agent's source, fixed once the instance is added: a registry install (pick another
 * version or agent) or a local command with its literal arguments.
 */
function AcpAgentSection(props: {
  readonly acp: AcpAgentConfig;
  readonly config: unknown;
  readonly off: boolean;
  readonly onChooseAgent: () => void;
  readonly onSave: (config: Record<string, unknown>) => Promise<boolean>;
}) {
  const { acp, config } = props;
  if (acp.source === "registry") {
    return (
      <SettingsSection title="Agent" footer="Installed from the ACP registry at a pinned version.">
        <SettingsRow
          first
          label="Registry agent"
          value={acp.agentId.length > 0 ? `${acp.agentId}@${acp.version}` : "None"}
          disabled={props.off}
          onPress={props.onChooseAgent}
        />
      </SettingsSection>
    );
  }
  const argumentKeys = occurrenceKeys(acp.args);
  const saveArgs = (args: ReadonlyArray<string>) =>
    props.onSave(localCommandConfig(config, { command: acp.command, args }));
  const promptArgument = (index: number | null) =>
    Alert.prompt(
      index === null ? "Add an argument" : `Argument ${index + 1}`,
      "One literal argument. Quotes, variables and globs are passed as typed.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Save",
          onPress: (value?: string) => {
            const text = promptText(value);
            void saveArgs(
              index === null
                ? [...acp.args, text]
                : acp.args.map((argument, at) => (at === index ? text : argument)),
            );
          },
        },
      ],
      "plain-text",
      index === null ? "" : acp.args[index],
    );
  return (
    <SettingsSection
      title="Agent"
      footer="Ryco starts this command on the machine without a shell. Arguments are visible to anyone who can view settings; keep credentials in sensitive environment variables."
    >
      <TextSettingRow
        first
        label="Executable"
        value={acp.command}
        emptyLabel="Not set"
        placeholder="gemini or /usr/local/bin/agent"
        maxLength={4096}
        disabled={props.off}
        validate={(draft) =>
          draft.length === 0 ? "Enter the executable." : acpLocalCommandError(draft)
        }
        onSave={(command) => props.onSave(localCommandConfig(config, { command, args: acp.args }))}
      />
      {acp.args.map((argument, index) => (
        <MenuRow
          key={argumentKeys[index]}
          disabled={props.off}
          actions={[
            { id: "edit", title: "Edit…" },
            { id: "remove", title: "Remove", attributes: { destructive: true } },
          ]}
          onAction={(id) => {
            if (id === "edit") promptArgument(index);
            if (id === "remove") void saveArgs(acp.args.filter((_, at) => at !== index));
          }}
        >
          <SettingsRow label={`Argument ${index + 1}`} value={argument} disabled={props.off} />
        </MenuRow>
      ))}
      <SettingsRow
        icon={{ ios: "plus", android: "add" }}
        label="Add argument"
        disabled={props.off || acp.args.length >= ACP_LOCAL_COMMAND_MAX_ARGS}
        onPress={() => promptArgument(null)}
      />
    </SettingsSection>
  );
}
