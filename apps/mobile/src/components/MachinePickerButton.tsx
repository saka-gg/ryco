import { MenuView } from "@react-native-menu/menu";
import type { EnvironmentId } from "@ryco/contracts";
import { View } from "react-native";

import {
  buildMachinePickerModel,
  machinePickerSelection,
  type MachinePickerDot,
} from "../features/home/machinePickerModel";
import type { InboxEnvironment } from "../features/inbox/inboxModel";
import { useThemeColor } from "../lib/useThemeColor";
import { AppText as Text } from "./AppText";
import { SymbolView } from "./AppSymbol";

const DOT_CLASS: Readonly<Record<MachinePickerDot, string>> = {
  connected: "bg-success",
  partial: "bg-warning",
  offline: "border border-foreground-tertiary",
};

/** The machine picker at a tab's top left: narrows the list, or opens Machines. */
export function MachinePickerButton(props: {
  readonly environments: ReadonlyArray<
    Pick<InboxEnvironment, "environmentId" | "label" | "connectionState" | "stale">
  >;
  readonly selected: EnvironmentId | null;
  readonly onSelect: (environmentId: EnvironmentId | null) => void;
  readonly onManage: () => void;
}) {
  const chevronColor = useThemeColor("--color-icon-muted");
  const model = buildMachinePickerModel({
    environments: props.environments,
    selected: props.selected,
  });
  return (
    <MenuView
      title="Show work from"
      actions={model.actions.map((action) => ({ ...action }))}
      onPressAction={({ nativeEvent }) => {
        const selection = machinePickerSelection(nativeEvent.event);
        if (selection === undefined) props.onManage();
        else props.onSelect(selection);
      }}
    >
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={model.accessibilityLabel}
        className="h-9 max-w-[200px] flex-row items-center gap-1.5 px-2"
      >
        <View className={`h-2 w-2 rounded-full ${DOT_CLASS[model.dot]}`} />
        <Text className="shrink font-ryco-medium text-[15px] text-foreground" numberOfLines={1}>
          {model.label}
        </Text>
        <SymbolView name="chevron.down" size={11} tintColor={chevronColor} type="monochrome" />
      </View>
    </MenuView>
  );
}
