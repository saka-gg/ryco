import { useEffect } from "react";
import { useColorScheme, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import type { MachineTone } from "../features/home/machinePickerModel";
import { useThemeColor } from "../lib/useThemeColor";
import { type AppSymbolName, SymbolView } from "./AppSymbol";

// The machine avatar of the approved machine-picker mockup ("Icon + name"): the machine
// kind's symbol in a disc, a 1.5 pt status ring that pulses amber while it connects, and a
// status dot. The picker, the Machines sheet and a machine's page all draw it.

export const TONE_COLOR: Readonly<Record<MachineTone, string>> = {
  connected: "#34c759",
  connecting: "#ffb43c",
  offline: "#6e6e78",
};
const RING_COLOR: Readonly<Record<MachineTone, string>> = {
  connected: "rgba(52,199,89,0.85)",
  connecting: "rgba(255,180,60,0.85)",
  offline: "rgba(142,142,152,0.4)",
};
const RING_PULSE_FADED = "rgba(255,180,60,0.18)";
const RING_WIDTH = 1.5;
export const RING_PULSE_WIDTH = 4;

const CSS_EASE = Easing.bezier(0.25, 0.1, 0.25, 1);

const CSS_EASE_IN_OUT = Easing.bezier(0.42, 0, 0.58, 1);

const TONE_FADE = { duration: 350, easing: CSS_EASE };

const PULSE_HALF = { duration: 650, easing: CSS_EASE_IN_OUT };

const AVATAR_PALETTE = {
  dark: { avatar: "rgba(255,255,255,0.08)", icon: "#f2f2f4" },
  light: { avatar: "rgba(0,0,0,0.06)", icon: "#262626" },
} as const;

/** The machine's ring: steady, or pulsing amber while it connects. */
function ToneRing(props: { readonly tone: MachineTone; readonly size: number }) {
  const reduceMotion = useReducedMotion();
  const pulsing = props.tone === "connecting" && !reduceMotion;
  const pulse = useSharedValue(0);
  const color = useSharedValue(RING_COLOR[props.tone]);
  useEffect(() => {
    color.set(withTiming(RING_COLOR[props.tone], reduceMotion ? { duration: 0 } : TONE_FADE));
  }, [color, props.tone, reduceMotion]);
  useEffect(() => {
    if (!pulsing) {
      cancelAnimation(pulse);
      pulse.set(0);
      return;
    }
    pulse.set(withRepeat(withTiming(1, PULSE_HALF), -1, true));
    return () => cancelAnimation(pulse);
  }, [pulse, pulsing]);
  const radius = props.size / 2;
  const style = useAnimatedStyle(() => {
    const progress = pulse.get();
    const spread = RING_WIDTH + (RING_PULSE_WIDTH - RING_WIDTH) * progress;
    return {
      top: -spread,
      left: -spread,
      right: -spread,
      bottom: -spread,
      borderWidth: spread,
      borderRadius: radius + spread,
      borderColor: pulsing
        ? interpolateColor(progress, [0, 1], [RING_COLOR.connecting, RING_PULSE_FADED])
        : color.get(),
    };
  });
  return <Animated.View pointerEvents="none" style={[{ position: "absolute" }, style]} />;
}

function ToneDot(props: { readonly tone: MachineTone; readonly cutout: string }) {
  const reduceMotion = useReducedMotion();
  const color = useSharedValue(TONE_COLOR[props.tone]);
  useEffect(() => {
    color.set(withTiming(TONE_COLOR[props.tone], reduceMotion ? { duration: 0 } : TONE_FADE));
  }, [color, props.tone, reduceMotion]);
  const style = useAnimatedStyle(() => ({ backgroundColor: color.get() }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          right: -1,
          bottom: -1,
          width: 10,
          height: 10,
          borderRadius: 5,
          borderWidth: 2,
          borderColor: props.cutout,
        },
        style,
      ]}
    />
  );
}

/** A round machine avatar: its kind's symbol, a status ring and, optionally, a status dot. */
export function MachineAvatar(props: {
  readonly symbol: AppSymbolName;
  readonly tone: MachineTone | null;
  readonly size: number;
  readonly iconSize?: number;
  readonly dot?: boolean;
  /** A screen-colored rim, so stacked avatars read as separate discs. */
  readonly rim?: boolean;
  /** What the dot is cut out of; the screen by default, a card's colour inside a card. */
  readonly cutout?: string;
}) {
  const palette = useColorScheme() === "light" ? AVATAR_PALETTE.light : AVATAR_PALETTE.dark;
  const screen = useThemeColor("--color-screen") as string;
  const cutout = props.cutout ?? screen;
  return (
    <View
      style={{ width: props.size, height: props.size }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {props.tone === null ? null : <ToneRing tone={props.tone} size={props.size} />}
      <View
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: props.size / 2,
          backgroundColor: palette.avatar,
          alignItems: "center",
          justifyContent: "center",
          ...(props.rim ? { borderWidth: 2, borderColor: cutout } : {}),
        }}
      >
        <SymbolView
          name={props.symbol}
          size={props.iconSize ?? 17}
          tintColor={palette.icon}
          type="monochrome"
        />
      </View>
      {props.dot && props.tone !== null ? <ToneDot tone={props.tone} cutout={cutout} /> : null}
    </View>
  );
}
