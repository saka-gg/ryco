import { Pressable, View } from "react-native";

import { useThemeColor } from "../lib/useThemeColor";
import { SymbolView, type AppSymbolName } from "./AppSymbol";

/** The round button that floats over a tab's list above the tab bar: New task in Chats. */
export function FloatingActionButton(props: {
  readonly icon: AppSymbolName;
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
  /** Distance from the screen's bottom edge: the tab bar's inset plus a gap. */
  readonly bottom: number;
}) {
  const iconColor = useThemeColor("--color-primary-foreground");
  return (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", right: 20, bottom: props.bottom }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        onPress={props.onPress}
        className="h-14 w-14 items-center justify-center rounded-full bg-primary active:opacity-80"
        style={FAB_SHADOW}
      >
        <SymbolView name={props.icon} size={22} tintColor={iconColor} type="monochrome" />
      </Pressable>
    </View>
  );
}

const FAB_SHADOW = {
  shadowColor: "#000",
  shadowOpacity: 0.45,
  shadowRadius: 14,
  shadowOffset: { width: 0, height: 4 },
  elevation: 6,
} as const;
