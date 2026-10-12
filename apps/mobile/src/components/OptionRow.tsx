import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { useThemeColor } from "../lib/useThemeColor";
import { SymbolView } from "./AppSymbol";
import { AppText as Text } from "./AppText";

/**
 * One choice in a single-choice list (a sheet's radio group): icon, label, a detail line and a
 * checkmark on the selected row. A disabled row stays readable at reduced opacity so its
 * detail can say why.
 */
export function OptionRow(props: {
  readonly icon?: ReactNode;
  readonly label: string;
  readonly detail: string;
  readonly selected: boolean;
  readonly disabled?: boolean;
  /** Lines the detail may wrap to; one by default, for short labels such as a branch. */
  readonly detailLines?: number;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  return (
    <Pressable
      accessibilityLabel={[props.label, props.detail].filter(Boolean).join(", ")}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={`min-h-14 flex-row items-center gap-3 rounded-2xl border px-4 py-3 active:bg-subtle ${
        props.selected ? "border-foreground bg-card-alt" : "border-border bg-card"
      } ${props.disabled ? "opacity-40" : ""}`}
    >
      {props.icon}
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-ryco-bold text-foreground" numberOfLines={1}>
          {props.label}
        </Text>
        <Text
          className="text-xs font-ryco-medium text-foreground-muted"
          numberOfLines={props.detailLines ?? 1}
        >
          {props.detail}
        </Text>
      </View>
      {props.selected ? (
        <SymbolView name="checkmark" size={16} tintColor={iconColor as string} type="monochrome" />
      ) : null}
    </Pressable>
  );
}
