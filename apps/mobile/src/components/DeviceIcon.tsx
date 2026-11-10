import type { EnvironmentId, EnvironmentMachineKind } from "@ryco/contracts";
import { View } from "react-native";

import { MACHINE_KIND_SYMBOL } from "../features/nodes/machineKindModel";
import { useMachineKind } from "../features/nodes/useMachineKind";
import { useThemeColor } from "../lib/useThemeColor";
import { SymbolView } from "./AppSymbol";

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
