import { useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import type { EnvironmentId } from "@ryco/contracts";
import {
  ENVIRONMENT_MACHINE_KINDS,
  type EnvironmentMachineKind,
} from "@ryco/contracts/environment";
import {
  ENVIRONMENT_MACHINE_LABELS,
  resolveEnvironmentMachineKind,
} from "@ryco/shared/environmentIcon";
import { AppText as Text } from "../../components/AppText";
import { EnvironmentMachineIcon } from "../../components/DeviceIcon";
import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";

/** The icon a machine shows: "Automatic", or the kind its owner picked. */
export function deviceIconChoiceLabel(choice: EnvironmentMachineKind | null | undefined): string {
  return choice ? ENVIRONMENT_MACHINE_LABELS[choice] : "Automatic";
}

/**
 * Whether this device may change a machine's icon now: `canEdit` (a connected owner) and a
 * machine that supports the setting.
 */
export function useDeviceIconEditable(environmentId: EnvironmentId, canEdit: boolean) {
  const config = useEnvironmentServerConfigs().get(environmentId);
  return {
    editable: canEdit && config?.environment.capabilities.environmentIcon === true,
    choice: config?.settings.environmentIcon ?? null,
  };
}

/** The machine's icon choices, in a page sheet opened from its page in the Machines sheet. */
export function DeviceIconPickerSheet({
  environmentId,
  label,
  canEdit,
  visible,
  onClose,
}: {
  environmentId: EnvironmentId;
  label: string;
  canEdit: boolean;
  visible: boolean;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const config = useEnvironmentServerConfigs().get(environmentId);
  const allowed = canEdit && config?.environment.capabilities.environmentIcon === true;
  const current = config?.settings.environmentIcon ?? null;
  const close = () => {
    setError(null);
    onClose();
  };
  const save = async (kind: EnvironmentMachineKind | null) => {
    if (!allowed || pending) return;
    setPending(true);
    setError(null);
    try {
      // The directory stays independent of connection bootstrap until an authorized edit.
      const { updateEnvironmentServerSettings } = await import("../../connection/environmentApi");
      await updateEnvironmentServerSettings(environmentId, { environmentIcon: kind });
      close();
    } catch {
      setError(`Could not save the icon for ${label}. Reconnect and try again.`);
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={close}
      >
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1 bg-screen"
          contentContainerStyle={{ padding: 20, gap: 12, paddingBottom: 44 }}
        >
          <View className="flex-row items-center gap-3">
            <Text className="flex-1 text-xl font-ryco-bold text-foreground">
              {label} · Device icon
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={close}
              className="min-h-11 justify-center px-3"
            >
              <Text className="text-base text-foreground">Done</Text>
            </Pressable>
          </View>
          <Text className="text-sm text-foreground-muted">
            Shown across mobile, desktop, and web.
          </Text>
          {!allowed && (
            <Text className="text-sm text-foreground-muted">
              Connect as the device owner to change its icon. The device must support icon
              selection.
            </Text>
          )}
          {error && (
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              {error}
            </Text>
          )}
          {[null, ...ENVIRONMENT_MACHINE_KINDS].map((kind) => (
            <Pressable
              key={kind ?? "automatic"}
              accessibilityRole="radio"
              accessibilityState={{ checked: current === kind, disabled: !allowed || pending }}
              disabled={!allowed || pending}
              onPress={() => void save(kind)}
              className="min-h-14 flex-row items-center gap-3 rounded-xl border border-border bg-card px-4 disabled:opacity-40"
            >
              <EnvironmentMachineIcon
                kind={
                  kind ??
                  resolveEnvironmentMachineKind(
                    config
                      ? { ...config, settings: { ...config.settings, environmentIcon: null } }
                      : null,
                  )
                }
              />
              <Text className="flex-1 text-base text-foreground">
                {kind === null ? "Automatic" : ENVIRONMENT_MACHINE_LABELS[kind]}
              </Text>
              {current === kind && <Text className="text-sm text-foreground">Selected</Text>}
            </Pressable>
          ))}
        </ScrollView>
      </Modal>
    </>
  );
}
