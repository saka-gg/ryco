import type { StaticScreenProps } from "@react-navigation/native";
import {
  EMPTY_DRAFT,
  hostFromDraft,
  toDraft,
  type Draft,
} from "@ryco/client-runtime/state/settings/deviceHosts";
import { EnvironmentId } from "@ryco/contracts/base-schemas";
import { DEVICE_SSH_HOST_LIMIT, type DeviceSshHost } from "@ryco/contracts/device";
import { useState } from "react";
import { Alert, Pressable, ScrollView, TextInput, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { cn } from "../../../lib/cn";
import { useThemeColor } from "../../../lib/useThemeColor";
import { SettingsRow } from "../components/SettingsRow";
import { SettingsSection } from "../components/SettingsSection";
import { SettingsSwitchRow } from "../components/SettingsSwitchRow";
import { useMachineSettings, type MachineSettings } from "./useMachineSettings";

type SettingsMachineSystemRouteScreenProps = StaticScreenProps<{ readonly environmentId: string }>;

const HOST_FIELDS: ReadonlyArray<{
  readonly key: keyof Draft;
  readonly label: string;
  readonly placeholder: string;
  readonly numeric?: boolean;
}> = [
  { key: "target", label: "SSH destination", placeholder: "me@studio.local or an alias" },
  { key: "name", label: "Name", placeholder: "Studio (optional)" },
  { key: "port", label: "Port", placeholder: "22", numeric: true },
  { key: "identityFile", label: "Key file", placeholder: "/Users/me/.ssh/id_ed25519 (optional)" },
  { key: "executable", label: "ryco on the Mac", placeholder: "/opt/homebrew/bin/ryco" },
];

/** The SSH host editor: a Mac whose simulators this machine reaches over SSH. */
function HostEditor(props: {
  readonly initial: Draft;
  readonly onCancel: () => void;
  readonly onSave: (host: DeviceSshHost) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(props.initial);
  const [saving, setSaving] = useState(false);
  const placeholder = useThemeColor("--color-placeholder") as string;
  const foreground = useThemeColor("--color-foreground") as string;
  const host = hostFromDraft(draft);
  const problem = typeof host === "string" ? host : null;
  return (
    <View className="gap-2 border-t border-border-subtle px-4 py-3">
      {HOST_FIELDS.map((field) => (
        <View key={field.key} className="gap-1">
          <Text className="text-xs text-foreground-muted">{field.label}</Text>
          <TextInput
            value={draft[field.key]}
            onChangeText={(value) => setDraft({ ...draft, [field.key]: value })}
            placeholder={field.placeholder}
            placeholderTextColor={placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType={field.numeric ? "number-pad" : "default"}
            className="h-10 rounded-xl bg-subtle px-3 font-sans text-[15px]"
            style={{ color: foreground }}
          />
        </View>
      ))}
      {problem && draft.target.trim() ? (
        <Text className="text-xs text-danger-foreground">{problem}</Text>
      ) : null}
      <View className="flex-row justify-end gap-2 pt-1">
        <Pressable
          accessibilityRole="button"
          onPress={props.onCancel}
          className="h-9 justify-center rounded-full bg-card-alt px-4 active:opacity-70"
        >
          <Text className="text-[14px] font-ryco-bold text-foreground">Cancel</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={typeof host === "string" || saving}
          onPress={() => {
            if (typeof host === "string") return;
            setSaving(true);
            void props.onSave(host).then(() => setSaving(false));
          }}
          className={cn(
            "h-9 justify-center rounded-full bg-primary px-4 active:opacity-70",
            (typeof host === "string" || saving) && "opacity-50",
          )}
        >
          <Text className="text-[14px] font-ryco-bold text-primary-foreground">
            {saving ? "Saving…" : "Save"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function DeviceHosts(props: {
  readonly machine: MachineSettings;
  readonly hosts: ReadonlyArray<DeviceSshHost>;
}) {
  const { machine, hosts } = props;
  const [editing, setEditing] = useState<{ readonly index: number | null } | null>(null);
  const off = !machine.editable;
  const save = async (next: ReadonlyArray<DeviceSshHost>) => {
    const ok = await machine.write({ deviceHosts: [...next] });
    if (ok) setEditing(null);
    return ok;
  };
  const remove = (index: number) => {
    const host = hosts[index];
    if (!host) return;
    Alert.alert(`Remove ${host.name}?`, "Its simulators stop showing on this machine.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => void save(hosts.filter((_, at) => at !== index)),
      },
    ]);
  };
  return (
    <SettingsSection
      title="Macs over SSH"
      footer="Simulators on another Mac, reached over SSH. This machine runs ryco there; it installs nothing."
    >
      {hosts.length === 0 && editing === null ? <SettingsRow first label="No Macs added" /> : null}
      {hosts.map((host, index) =>
        editing?.index === index ? (
          <HostEditor
            key={`${host.name}:${host.target}`}
            initial={toDraft(host)}
            onCancel={() => setEditing(null)}
            onSave={(next) => save(hosts.map((current, at) => (at === index ? next : current)))}
          />
        ) : (
          <SettingsRow
            key={`${host.name}:${host.target}`}
            first={index === 0}
            icon="laptopcomputer"
            label={host.name}
            value={host.target}
            disabled={off}
            onPress={() =>
              Alert.alert(host.name, host.target, [
                { text: "Edit", onPress: () => setEditing({ index }) },
                { text: "Remove", style: "destructive", onPress: () => remove(index) },
                { text: "Cancel", style: "cancel" },
              ])
            }
          />
        ),
      )}
      {editing?.index === null ? (
        <HostEditor
          initial={EMPTY_DRAFT}
          onCancel={() => setEditing(null)}
          onSave={(host) => save([...hosts, host])}
        />
      ) : (
        <SettingsRow
          icon="plus"
          label="Add a Mac"
          disabled={off || hosts.length >= DEVICE_SSH_HOST_LIMIT}
          onPress={() => setEditing({ index: null })}
        />
      )}
    </SettingsSection>
  );
}

/**
 * The machine itself: its simulators (and Macs reached over SSH), how agents run on it, and
 * what happens after a restart. Keep awake and Computer Use belong to the desktop app on the
 * machine and are changed there.
 */
export function SettingsMachineSystemRouteScreen(props: SettingsMachineSystemRouteScreenProps) {
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const machine = useMachineSettings(environmentId);
  const settings = machine.config?.settings ?? null;
  const capabilities = machine.config?.environment.capabilities ?? null;
  if (settings === null) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" className="flex-1 bg-screen">
        <SettingsSection>
          <SettingsRow
            first
            label={machine.connected ? "Loading settings…" : "Not connected"}
            detail={machine.connected ? undefined : "Connect this machine to see its settings."}
          />
        </SettingsSection>
      </ScrollView>
    );
  }
  const off = !machine.editable;
  return (
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

      <SettingsSection title="Simulators">
        <SettingsSwitchRow
          first
          label="Simulators and emulators"
          detail="List this machine's iOS Simulators and Android Emulators in Ryco."
          value={settings.devicesEnabled}
          disabled={off}
          onValueChange={(value) => void machine.write({ devicesEnabled: value })}
        />
        <SettingsSwitchRow
          label="Agents can use them"
          detail="Agents may boot, drive and screenshot a simulator after you approve it."
          value={settings.agentDevicesEnabled}
          disabled={off || !settings.devicesEnabled}
          onValueChange={(value) => void machine.write({ agentDevicesEnabled: value })}
        />
      </SettingsSection>
      {capabilities?.deviceSetup === true ? (
        <DeviceHosts machine={machine} hosts={settings.deviceHosts} />
      ) : null}

      <SettingsSection title="Agents on this machine">
        <SettingsSwitchRow
          first
          label="Lower agent priority"
          detail="Agent processes yield to the apps you use on this machine."
          value={settings.lowerAgentProcessPriority}
          disabled={off}
          onValueChange={(value) => void machine.write({ lowerAgentProcessPriority: value })}
        />
        <SettingsSwitchRow
          label="Continue after a restart"
          detail="Threads that were working when Ryco stopped continue when it starts again."
          value={settings.continueThreadsAfterRestart}
          disabled={off}
          onValueChange={(value) => void machine.writeShared("continueThreadsAfterRestart", value)}
        />
      </SettingsSection>

      <SettingsSection
        title="On the desktop app"
        footer="These belong to the Ryco desktop app running on this machine and are changed there."
      >
        <SettingsRow first icon="cup.and.saucer" label="Keep awake" value="On the desktop" />
        <SettingsRow icon="cursorarrow.rays" label="Computer Use" value="On the desktop" />
      </SettingsSection>
    </ScrollView>
  );
}
