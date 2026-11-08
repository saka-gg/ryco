import { useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { GlassSurface } from "../../components/GlassSurface";
import { secondClock } from "../../lib/secondClock";
import { useThemeColor } from "../../lib/useThemeColor";
import { resolveFloatingThreadControl } from "./floatingThreadControlModel";

const subscribeToNothing = () => () => {};
const readNoClock = () => 0;
const ENTERING = FadeIn.duration(180).reduceMotion(ReduceMotion.System);
const EXITING = FadeOut.duration(120).reduceMotion(ReduceMotion.System);

/**
 * Floats over the bottom of the feed: "Working · 1:05" while the agent runs,
 * "Jump to latest" once the reader scrolled back. Tapping scrolls to the end.
 */
export function FloatingThreadControl(props: {
  readonly runningSince: string | null;
  readonly followingLatest: boolean;
  readonly onJumpToLatest: () => void;
}) {
  const running = props.runningSince !== null;
  const nowMs = useSyncExternalStore(
    running ? secondClock.subscribe : subscribeToNothing,
    running ? secondClock.read : readNoClock,
  );
  const iconColor = useThemeColor("--color-icon");
  const control = resolveFloatingThreadControl({
    runningSince: props.runningSince,
    followingLatest: props.followingLatest,
    nowMs,
  });
  if (control === null) return null;
  return (
    <View pointerEvents="box-none" className="absolute bottom-3 left-0 right-0 items-center">
      <Animated.View key={control.kind} entering={ENTERING} exiting={EXITING}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={control.accessibilityLabel}
          onPress={props.onJumpToLatest}
          className="active:opacity-80"
        >
          <GlassSurface radius={18} style={{ borderRadius: 18 }}>
            <View className="h-9 flex-row items-center gap-2 px-3.5">
              {control.kind === "working" ? (
                <ActivityIndicator size="small" color={iconColor} />
              ) : (
                <SymbolView name="arrow.down" size={13} tintColor={iconColor} type="monochrome" />
              )}
              <Text
                className="font-ryco-medium text-sm text-foreground"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {control.label}
              </Text>
              {control.kind === "working" && !props.followingLatest ? (
                <SymbolView name="arrow.down" size={12} tintColor={iconColor} type="monochrome" />
              ) : null}
            </View>
          </GlassSurface>
        </Pressable>
      </Animated.View>
    </View>
  );
}
