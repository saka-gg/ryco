import type { EnvironmentId, EnvironmentMachineKind } from "@ryco/contracts";
import { View } from "react-native";

import type { MachineTone } from "../features/home/machinePickerModel";
import { MACHINE_KIND_SYMBOL } from "../features/nodes/machineKindModel";
import { useMachineKind } from "../features/nodes/useMachineKind";
import { useThemeColor } from "../lib/useThemeColor";
import { SymbolView } from "./AppSymbol";
import { MachineAvatar } from "./MachineAvatar";

/** A machine kind's SF Symbol, the same one the machine picker draws. */
export function EnvironmentMachineIcon({
  kind,
  size = 20,
}: {
  kind: EnvironmentMachineKind;
  size?: number;
}) {
  const color = useThemeColor("--color-icon");
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <SymbolView
        name={MACHINE_KIND_SYMBOL[kind]}
        size={size}
        tintColor={color}
        type="monochrome"
      />
    </View>
  );
}

/** A machine's icon, its kind resolved by the phone's one rule (`resolveMachineKind`). */
export function DeviceIcon({
  environmentId,
  label,
  platformOs,
  size,
}: {
  environmentId: EnvironmentId;
  label?: string | undefined;
  platformOs?: string | undefined;
  size?: number;
}) {
  const kind = useMachineKind(environmentId, label ?? "", platformOs);
  return <EnvironmentMachineIcon kind={kind} {...(size === undefined ? {} : { size })} />;
}

/**
 * A machine's avatar (`MachineAvatar`) with its kind resolved by the phone's one rule, as the
 * Machines sheet lists it: the status ring and dot, the dot cut out of `cutout`.
 */
export function DeviceAvatar(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly platformOs?: string | undefined;
  readonly tone: MachineTone;
  readonly size: number;
  readonly cutout: string;
}) {
  const kind = useMachineKind(props.environmentId, props.label, props.platformOs);
  return (
    <MachineAvatar
      symbol={MACHINE_KIND_SYMBOL[kind]}
      tone={props.tone}
      size={props.size}
      iconSize={Math.round(props.size * 0.5)}
      dot
      cutout={props.cutout}
    />
  );
}
