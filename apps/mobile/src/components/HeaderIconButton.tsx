import { Pressable, View } from "react-native";

import { AppText as Text } from "./AppText";
import { useThemeColor } from "../lib/useThemeColor";
import { SymbolView, type AppSymbolName } from "./AppSymbol";

/** The side of a header button and of its touch target: Apple's minimum hit target. */
export const HEADER_ICON_BUTTON_SIZE = 44;

/**
 * A navigation bar button's glyph as UIKit draws it: the 17 pt body size at the large symbol
 * scale (the native "⋯" of the thread header measures the same), so `magnifyingglass` and the
 * filter circle come out at UIKit's 26 pt image box. `SymbolView` scales its image into a
 * `size` box, so the box is the image's own size at that configuration.
 */
const HEADER_SYMBOL_SIZE = 26;

/**
 * A round icon button for a tab's header: search, filter. `active` marks a filter that is on
 * with a dot, `badge` counts the filters that are on, so the header says the list is narrowed.
 * `filled` gives it its own round background, for a header the screen draws itself; in the
 * navigation bar the system's glass already holds it.
 */
export function HeaderIconButton(props: {
  readonly icon: AppSymbolName;
  readonly accessibilityLabel: string;
  readonly onPress?: () => void;
  readonly active?: boolean;
  readonly badge?: number;
  readonly filled?: boolean;
}) {
  const iconColor = useThemeColor("--color-icon");
  const accentColor = useThemeColor("--color-accent-strong");
  const content = (
    <View
      className={
        props.filled
          ? "items-center justify-center rounded-full bg-subtle"
          : "items-center justify-center"
      }
      style={{ width: HEADER_ICON_BUTTON_SIZE, height: HEADER_ICON_BUTTON_SIZE }}
    >
      <SymbolView
        name={props.icon}
        size={HEADER_SYMBOL_SIZE}
        scale="large"
        resizeMode="scaleAspectFit"
        tintColor={props.active ? accentColor : iconColor}
        type="monochrome"
      />
      {props.badge ? (
        <View className="absolute -right-0.5 -top-0.5 h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1">
          <Text className="text-[10px] font-ryco-bold text-primary-foreground">{props.badge}</Text>
        </View>
      ) : props.active ? (
        <View className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-accent" />
      ) : null}
    </View>
  );
  if (!props.onPress) return content;
  const label = props.badge
    ? `${props.accessibilityLabel}, ${props.badge} on`
    : props.accessibilityLabel;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: props.active === true }}
      className="rounded-full active:opacity-60"
      onPress={props.onPress}
    >
      {content}
    </Pressable>
  );
}
