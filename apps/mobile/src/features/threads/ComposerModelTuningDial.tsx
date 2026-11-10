import {
  getTuningScale,
  nextSpeedTier,
  reasoningTone,
  SPEED_TIER_LABELS,
  type ModelTuning,
  type TuningStop,
} from "@ryco/client-runtime/state/composer/modelTuning";
import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import Animated, {
  Easing,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  reasoningToneColorVar,
  speedToneColorVar,
  type ComposerTuningChange,
} from "./composerFooterModel";

// The model picker's footer, ported from the desktop's ModelTuningDial (apps/web
// ModelTuningDial.tsx + the .model-dial-* rules in index.css): speed bolt, the effort in its tone,
// the active model, the context-window switch, thinking and reset on one 28pt row, and below it
// the snapping dial — a 26pt track whose fill runs to a 30pt thumb, one 4pt notch per stop.

/** Half the thumb: the track insets its travel by this so the thumb never overhangs. */
const THUMB_RADIUS = 15;
const TRACK_HEIGHT = 26;
// The desktop thumb rides `--app-motion-spring-snappy` for 1.9 × the stack duration.
const SNAP = {
  duration: 494,
  easing: Easing.bezier(0.3, 1.36, 0.44, 1),
  reduceMotion: ReduceMotion.System,
} as const;
const CHIP = { duration: 120, reduceMotion: ReduceMotion.System } as const;

function DialTrack(props: {
  readonly stops: ReadonlyArray<TuningStop>;
  readonly index: number;
  readonly toneColor: string;
  readonly kind: "effort" | "thinking";
  readonly disabled: boolean;
  readonly onCommit: (index: number) => void;
}) {
  const count = props.stops.length;
  const notchColor = useThemeColor("--color-dial-notch");
  const trackColor = useThemeColor("--color-dial-track");
  const thumbColor = useThemeColor("--color-dial-thumb");
  const [width, setWidth] = useState(0);
  const target = count > 1 ? props.index / (count - 1) : 0;
  const position = useSharedValue(target);
  const dragging = useSharedValue(false);
  const committed = useSharedValue(props.index);
  const span = useSharedValue(0);

  useEffect(() => {
    committed.set(props.index);
    if (!dragging.get()) position.set(withTiming(target, SNAP));
  }, [committed, dragging, position, props.index, target]);

  const commit = (index: number) => {
    void Haptics.selectionAsync();
    props.onCommit(index);
  };

  const pan = Gesture.Pan()
    .enabled(!props.disabled && count > 1)
    .minDistance(0)
    .onBegin((event) => {
      dragging.set(true);
      const travel = span.get();
      const t = travel > 0 ? Math.min(1, Math.max(0, (event.x - THUMB_RADIUS) / travel)) : 0;
      position.set(t);
      const next = Math.round(t * (count - 1));
      if (next !== committed.get()) {
        committed.set(next);
        runOnJS(commit)(next);
      }
    })
    .onUpdate((event) => {
      const travel = span.get();
      const t = travel > 0 ? Math.min(1, Math.max(0, (event.x - THUMB_RADIUS) / travel)) : 0;
      position.set(t);
      const next = Math.round(t * (count - 1));
      if (next !== committed.get()) {
        committed.set(next);
        runOnJS(commit)(next);
      }
    })
    .onFinalize(() => {
      dragging.set(false);
      position.set(withTiming(count > 1 ? committed.get() / (count - 1) : 0, SNAP));
    });

  const fillStyle = useAnimatedStyle(() => ({
    width: 2 * THUMB_RADIUS + span.get() * Math.min(1, Math.max(0, position.get())),
  }));
  const thumbStyle = useAnimatedStyle(() => ({
    left: span.get() * Math.min(1, Math.max(0, position.get())),
    transform: [{ scale: withTiming(dragging.get() ? 0.94 : 1, CHIP) }],
  }));

  const label = props.stops[props.index]?.label ?? "";
  return (
    <GestureDetector gesture={pan}>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={props.kind === "effort" ? "Reasoning effort" : "Thinking"}
        accessibilityValue={{ text: label }}
        accessibilityState={{ disabled: props.disabled }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event) => {
          const step = event.nativeEvent.actionName === "increment" ? 1 : -1;
          const next = Math.min(count - 1, Math.max(0, props.index + step));
          if (next !== props.index) props.onCommit(next);
        }}
        onLayout={(event) => {
          const next = event.nativeEvent.layout.width;
          setWidth(next);
          span.set(Math.max(0, next - 2 * THUMB_RADIUS));
        }}
        className={cn("mt-2 rounded-full", props.disabled && "opacity-55")}
        style={{ height: TRACK_HEIGHT, backgroundColor: trackColor }}
      >
        <Animated.View
          className="absolute inset-y-0 left-0 overflow-hidden rounded-full"
          style={fillStyle}
        >
          {/* The desktop fill: the tone at 45% rising to the full tone. */}
          <Svg width={Math.max(width, 2 * THUMB_RADIUS)} height={TRACK_HEIGHT}>
            <Defs>
              <LinearGradient
                id="dialFill"
                gradientUnits="userSpaceOnUse"
                x1="0"
                y1="0"
                // The desktop gradient spans the fill, which ends at the thumb's far edge.
                x2={2 * THUMB_RADIUS + Math.max(0, width - 2 * THUMB_RADIUS) * target}
                y2="0"
              >
                <Stop offset="0" stopColor={props.toneColor} stopOpacity={0.45} />
                <Stop offset="1" stopColor={props.toneColor} stopOpacity={1} />
              </LinearGradient>
            </Defs>
            <Rect
              x="0"
              y="0"
              width={Math.max(width, 2 * THUMB_RADIUS)}
              height={TRACK_HEIGHT}
              fill="url(#dialFill)"
            />
          </Svg>
        </Animated.View>
        {width > 0
          ? props.stops.map((stop, index) => (
              <View
                key={stop.id}
                pointerEvents="none"
                className="absolute rounded-full"
                style={{
                  width: 4,
                  height: 4,
                  top: TRACK_HEIGHT / 2 - 2,
                  left:
                    THUMB_RADIUS -
                    2 +
                    (width - 2 * THUMB_RADIUS) * (count > 1 ? index / (count - 1) : 0),
                  backgroundColor:
                    index <= props.index ? "rgba(255, 255, 255, 0.72)" : (notchColor as string),
                }}
              />
            ))
          : null}
        <Animated.View
          pointerEvents="none"
          className="absolute rounded-full"
          style={[
            {
              top: TRACK_HEIGHT / 2 - THUMB_RADIUS,
              width: 2 * THUMB_RADIUS,
              height: 2 * THUMB_RADIUS,
              backgroundColor: thumbColor,
              boxShadow: "0 1px 2px rgba(0, 0, 0, 0.5), 0 6px 18px rgba(0, 0, 0, 0.45)",
            },
            thumbStyle,
          ]}
        />
      </View>
    </GestureDetector>
  );
}

function DialButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
  readonly onPress: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled ?? false, selected: props.pressed }}
      disabled={props.disabled}
      hitSlop={8}
      onPress={props.onPress}
      className="size-7 items-center justify-center rounded-md active:bg-subtle-strong disabled:opacity-30"
    >
      {props.children}
    </Pressable>
  );
}

export function ComposerModelTuningDial(props: {
  readonly tuning: ModelTuning;
  readonly modelLabel: string;
  readonly disabled: boolean;
  readonly onChange: (change: ComposerTuningChange) => void;
  /** Opens the active model's tab and brings its row into view. */
  readonly onRevealModel: () => void;
}) {
  const { tuning } = props;
  const scale = getTuningScale(tuning);
  const effortLocked = scale?.kind === "effort" && tuning.ultrathinkInBodyText;
  const scaleDisabled = props.disabled || effortLocked;
  const stop = scale ? scale.stops[scale.index] : undefined;
  const tone =
    scale?.kind === "thinking" ? (stop?.id === "on" ? "thinking" : "off") : reasoningTone(stop?.id);
  const toneColor = useThemeColor(reasoningToneColorVar(tone)) as string;
  const muted = useThemeColor("--color-icon-muted");
  const speed = tuning.speed;
  const speedIsOn = speed !== "standard";
  const speedVar = speedToneColorVar(speed);
  const speedColor = useThemeColor(speedVar ?? "--color-icon-muted");
  const thinkingColor = useThemeColor("--color-reasoning-thinking");
  const next = nextSpeedTier(tuning.descriptors);
  const contextWindow = tuning.contextWindow;
  const contextValue =
    typeof contextWindow?.currentValue === "string"
      ? contextWindow.currentValue
      : (contextWindow?.options.find((option) => option.isDefault)?.id ?? "");

  const commitStop = (index: number) => {
    if (!scale || scaleDisabled) return;
    const target = scale.stops[index];
    if (!target || index === scale.index) return;
    if (scale.kind === "effort") props.onChange({ kind: "effort", value: target.id });
    else props.onChange({ kind: "thinking", enabled: target.id === "on" });
  };

  return (
    <View className="px-3 pb-2.5 pt-2">
      <View className="h-7 flex-row items-center gap-1">
        {tuning.speedTiers.length > 1 ? (
          <DialButton
            label={`Speed: ${SPEED_TIER_LABELS[speed]}. Tap for ${SPEED_TIER_LABELS[next]}`}
            pressed={speedIsOn}
            disabled={props.disabled}
            onPress={() => props.onChange({ kind: "speed", tier: next })}
          >
            <SymbolView
              name={
                speed === "ultrafast" ? "bolt.horizontal.fill" : speedIsOn ? "bolt.fill" : "bolt"
              }
              size={15}
              tintColor={speedIsOn ? speedColor : muted}
              type="monochrome"
            />
          </DialButton>
        ) : null}
        <View className="min-w-0 flex-1 flex-row items-center gap-1.5 pl-0.5">
          {stop ? (
            <Text className="shrink-0 font-ryco-bold text-sm" style={{ color: toneColor }}>
              {stop.label}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Show ${props.modelLabel} in the list`}
            hitSlop={6}
            onPress={props.onRevealModel}
            className="min-w-0 shrink flex-row items-center gap-0.5 px-0.5 active:opacity-60"
          >
            <Text numberOfLines={1} className="shrink text-xs text-foreground-muted">
              {props.modelLabel}
            </Text>
            <SymbolView name="chevron.right" size={9} tintColor={muted} type="monochrome" />
          </Pressable>
        </View>
        {contextWindow ? (
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel="Context window"
            className="h-7 flex-row items-center rounded-full bg-subtle-strong p-0.5"
          >
            {contextWindow.options.map((option) => {
              const selected = option.id === contextValue;
              return (
                <Pressable
                  key={option.id}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected, disabled: props.disabled }}
                  disabled={props.disabled}
                  onPress={() => {
                    if (!selected) props.onChange({ kind: "contextWindow", value: option.id });
                  }}
                  className={cn(
                    "h-6 justify-center rounded-full px-2",
                    selected && "bg-subtle-strong",
                  )}
                >
                  <Text
                    className={cn(
                      "text-xs font-ryco-medium",
                      selected ? "text-foreground" : "text-foreground-muted",
                    )}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        {tuning.thinking && scale?.kind === "effort" ? (
          <DialButton
            label={tuning.thinking.currentValue === true ? "Thinking on" : "Thinking off"}
            pressed={tuning.thinking.currentValue === true}
            disabled={props.disabled}
            onPress={() =>
              props.onChange({ kind: "thinking", enabled: tuning.thinking?.currentValue !== true })
            }
          >
            <SymbolView
              name="brain"
              size={15}
              tintColor={tuning.thinking.currentValue === true ? thinkingColor : muted}
              type="monochrome"
            />
          </DialButton>
        ) : null}
        <DialButton
          label="Reset to model defaults"
          disabled={props.disabled || tuning.isDefault}
          onPress={() => props.onChange({ kind: "reset" })}
        >
          <SymbolView name="arrow.counterclockwise" size={14} tintColor={muted} type="monochrome" />
        </DialButton>
      </View>
      {scale && scale.stops.length > 1 ? (
        <DialTrack
          stops={scale.stops}
          index={scale.index}
          toneColor={toneColor}
          kind={scale.kind}
          disabled={scaleDisabled}
          onCommit={commitStop}
        />
      ) : null}
      {effortLocked ? (
        <Text className="mt-1 text-[11px] text-foreground-muted">
          Your prompt contains “ultrathink”. Remove it to change effort.
        </Text>
      ) : null}
    </View>
  );
}
