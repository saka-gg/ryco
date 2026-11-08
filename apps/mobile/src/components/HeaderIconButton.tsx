import { Pressable, View } from "react-native";

import { useThemeColor } from "../lib/useThemeColor";
import { SymbolView, type AppSymbolName } from "./AppSymbol";

/**
 * A round icon button for a tab's header: search, filter. `active` marks a
 * filter that is on with a dot, so the header says the list is narrowed.
 */
export function HeaderIconButton(props: {
  readonly icon: AppSymbolName;
  readonly accessibilityLabel: string;
  readonly onPress?: () => void;
  readonly active?: boolean;
}) {
  const iconColor = useThemeColor("--color-icon");
  const accentColor = useThemeColor("--color-accent-strong");
  const content = (
    <View className="h-9 w-9 items-center justify-center">
      <SymbolView
        name={props.icon}
        size={19}
        tintColor={props.active ? accentColor : iconColor}
        type="monochrome"
      />
      {props.active ? (
        <View className="absolute right-1 top-1 h-2 w-2 rounded-full bg-accent" />
      ) : null}
    </View>
  );
  if (!props.onPress) return content;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ selected: props.active === true }}
      hitSlop={6}
      className="rounded-full active:opacity-60"
      onPress={props.onPress}
    >
      {content}
    </Pressable>
  );
}
