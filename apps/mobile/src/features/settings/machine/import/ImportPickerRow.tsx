import { MenuView } from "@react-native-menu/menu";
import * as Haptics from "expo-haptics";
import { View } from "react-native";

import { SymbolView } from "../../../../components/AppSymbol";
import { AppText as Text } from "../../../../components/AppText";
import { cn } from "../../../../lib/cn";
import { useThemeColor } from "../../../../lib/useThemeColor";

export interface ImportPickerOption {
  readonly value: string;
  readonly label: string;
  readonly subtitle?: string;
}

/**
 * A row whose value is picked from a native menu, with a placeholder while nothing is chosen
 * (no project yet, no store answered yet). Inert while disabled or without choices.
 */
export function ImportPickerRow(props: {
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly options: ReadonlyArray<ImportPickerOption>;
  readonly first?: boolean;
  readonly disabled?: boolean;
  readonly onPick: (value: string) => void;
}) {
  const chevron = useThemeColor("--color-icon-subtle") as string;
  const current = props.options.find((option) => option.value === props.value);
  const shown = current ? current.label : props.placeholder;
  const inert = props.disabled === true || props.options.length === 0;
  const row = (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${props.label}: ${shown}`}
      accessibilityState={{ disabled: inert }}
      className={cn(
        "min-h-[52px] flex-row items-center gap-3 px-4 py-3",
        !props.first && "border-t border-border-subtle",
        inert && "opacity-40",
      )}
    >
      <Text className="min-w-0 flex-1 text-[17px] text-foreground">{props.label}</Text>
      <Text
        className={cn(
          "max-w-[60%] shrink text-[15px]",
          current ? "text-foreground-muted" : "text-foreground-tertiary",
        )}
        numberOfLines={1}
      >
        {shown}
      </Text>
      <SymbolView name="chevron.up.chevron.down" size={12} tintColor={chevron} />
    </View>
  );
  if (inert) return row;
  return (
    <MenuView
      shouldOpenOnLongPress={false}
      actions={props.options.map((option) => ({
        id: option.value,
        title: option.label,
        ...(option.subtitle ? { subtitle: option.subtitle } : {}),
        state: option.value === props.value ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === props.value) return;
        void Haptics.selectionAsync();
        props.onPick(nativeEvent.event);
      }}
    >
      {row}
    </MenuView>
  );
}
