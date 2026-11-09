import { Pressable, View } from "react-native";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { GlassSurface } from "../../components/GlassSurface";
import { useThemeColor } from "../../lib/useThemeColor";

export const COMPOSER_BUBBLE_HEIGHT = 44;
/** The capsule's own inset from the screen edge, so the bubble lands where it shrank. */
export const COMPOSER_SIDE_INSET = 10;

/**
 * The composer shrunk away while the reader scrolls back: a small glass "Message" bubble at
 * the bottom right of the feed. Tapping it brings the composer back, focused.
 */
export function ComposerShrunkBubble(props: {
  readonly progress: SharedValue<number>;
  readonly visible: boolean;
  readonly label?: string | undefined;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  const style = useAnimatedStyle(() => {
    const value = props.progress.get();
    return {
      opacity: Math.min(1, Math.max(0, value * 1.6 - 0.3)),
      transform: [{ scale: 0.6 + 0.4 * value }],
    };
  });
  return (
    <Animated.View
      pointerEvents={props.visible ? "auto" : "none"}
      style={[
        {
          position: "absolute",
          right: COMPOSER_SIDE_INSET,
          bottom: 0,
          transformOrigin: "bottom right",
        },
        style,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Write a message"
        accessibilityElementsHidden={!props.visible}
        importantForAccessibility={props.visible ? "auto" : "no-hide-descendants"}
        onPress={props.onPress}
        className="active:opacity-80"
      >
        <GlassSurface radius={COMPOSER_BUBBLE_HEIGHT / 2}>
          <View
            className="flex-row items-center"
            style={{ height: COMPOSER_BUBBLE_HEIGHT, paddingLeft: 12, paddingRight: 16, gap: 8 }}
          >
            <SymbolView name="pencil" size={15} tintColor={iconColor} type="monochrome" />
            <Text className="text-foreground-muted" style={{ fontSize: 14 }}>
              {props.label ?? "Message"}
            </Text>
          </View>
        </GlassSurface>
      </Pressable>
    </Animated.View>
  );
}

/** The prototype's fade under the bubble: the feed dissolves into the screen at the bottom. */
const FADE_HEIGHT = 110;

/**
 * While the composer is shrunk, the feed's last lines fade out under the bubble instead of
 * running into the home indicator.
 */
export function ComposerShrinkFade(props: { readonly progress: SharedValue<number> }) {
  const screen = useThemeColor("--color-screen");
  const style = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.max(0, props.progress.get())),
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[{ position: "absolute", left: 0, right: 0, bottom: 0, height: FADE_HEIGHT }, style]}
    >
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id="composer-shrink-fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={screen as string} stopOpacity={0} />
            <Stop offset="0.55" stopColor={screen as string} stopOpacity={1} />
            <Stop offset="1" stopColor={screen as string} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#composer-shrink-fade)" />
      </Svg>
    </Animated.View>
  );
}
