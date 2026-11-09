import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { useThemeColor } from "../../../lib/useThemeColor";

/**
 * One settings row, after t3code's `ListRowLayout`: an optional plain leading
 * symbol, the label (with a quiet detail line under it), the value on the
 * right and a chevron when the row opens something.
 */
export function SettingsRow(props: {
  readonly label: string;
  readonly value?: string;
  readonly detail?: string;
  /** A plain leading SF Symbol, tinted like the rest of the app's icons. */
  readonly icon?: AppSymbolName;
  /** A leading mark other than an SF Symbol, such as a provider's logo; wins over `icon`. */
  readonly leading?: ReactNode;
  readonly onPress?: () => void;
  readonly first?: boolean;
  readonly destructive?: boolean;
  /** Renders the row inert and dimmed. Pass `onPress` anyway; it is ignored. */
  readonly disabled?: boolean;
}) {
  const chevronColor = useThemeColor("--color-icon-subtle");
  const iconColor = useThemeColor(
    props.destructive ? "--color-danger-foreground" : "--color-icon-muted",
  );
  const content = (
    <View
      // The separator starts after the icon, as in a grouped iOS list.
      className={`flex-row items-center gap-3 pl-4 ${props.disabled ? "opacity-40" : ""}`}
    >
      {props.leading ? (
        <View className="h-6 w-6 items-center justify-center">{props.leading}</View>
      ) : props.icon ? (
        <View className="h-6 w-6 items-center justify-center">
          <SymbolView name={props.icon} size={20} tintColor={iconColor} type="monochrome" />
        </View>
      ) : null}
      <View
        className={`min-h-[52px] min-w-0 flex-1 flex-row items-center gap-3 py-3 pr-4 ${
          props.first ? "" : "border-t border-border-subtle"
        }`}
      >
        <View className="min-w-0 flex-1">
          <Text
            className={`font-sans text-[17px] ${props.destructive ? "text-danger-foreground" : "text-foreground"}`}
          >
            {props.label}
          </Text>
          {props.detail ? (
            <Text className="mt-0.5 font-sans text-xs leading-4 text-foreground-muted">
              {props.detail}
            </Text>
          ) : null}
        </View>
        {props.value ? (
          <Text
            className="max-w-[45%] shrink font-sans text-[15px] text-foreground-muted"
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {props.value}
          </Text>
        ) : null}
        {props.onPress && !props.disabled ? (
          <SymbolView
            name={{ ios: "chevron.right", android: "chevron_right" }}
            size={14}
            weight="semibold"
            tintColor={chevronColor}
            type="monochrome"
          />
        ) : null}
      </View>
    </View>
  );
  const label = [props.label, props.value, props.detail].filter(Boolean).join(", ");
  if (!props.onPress || props.disabled) {
    return (
      <View accessible accessibilityLabel={label}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={props.onPress}
      className="active:bg-subtle"
    >
      {content}
    </Pressable>
  );
}
