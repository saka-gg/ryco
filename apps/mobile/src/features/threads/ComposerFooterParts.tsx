import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import Svg, { Circle } from "react-native-svg";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  reasoningToneColorVar,
  speedToneColorVar,
  type ComposerTriggerTraits,
} from "./composerFooterModel";

// Small pieces of the desktop composer footer, ported one to one: the model pill
// (ProviderModelPicker's trigger + ModelTriggerTraits) and the context-window ring
// (ContextWindowMeter's trigger).

/** The desktop pill: provider mark, model name, effort in its tone, bolt, context tag, chevron. */
export function ComposerModelTrigger(props: {
  readonly providerDriver: string | null;
  readonly label: string;
  readonly traits: ComposerTriggerTraits | null;
  readonly fastNotice?: { readonly icon: "bolt" | "bolt.slash"; readonly muted: boolean } | null;
  readonly accessibilityLabel: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const muted = useThemeColor("--color-foreground-muted");
  const subtle = useThemeColor("--color-icon-subtle");
  const toneColor = useThemeColor(reasoningToneColorVar(props.traits?.level?.tone ?? "low"));
  const speedVar = speedToneColorVar(props.traits?.speed ?? "standard");
  const speedColor = useThemeColor(speedVar ?? "--color-fast-mode");
  const fastColor = useThemeColor("--color-fast-mode");
  const traits = props.traits;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={{ top: 10, bottom: 10 }}
      className="h-6 min-w-0 shrink flex-row items-center gap-1.5 rounded-full px-1.5 active:bg-subtle-strong disabled:opacity-50"
    >
      <ProviderIcon provider={props.providerDriver} size={16} />
      <Text
        numberOfLines={1}
        className="min-w-0 shrink font-ryco-medium text-xs"
        style={{ color: muted }}
      >
        {props.label}
      </Text>
      {traits?.level ? (
        <Text className="shrink-0 font-ryco-medium text-xs" style={{ color: toneColor }}>
          {traits.level.label}
        </Text>
      ) : null}
      {props.fastNotice ? (
        <SymbolView
          name={props.fastNotice.icon}
          size={11}
          tintColor={props.fastNotice.muted ? subtle : fastColor}
          type="monochrome"
        />
      ) : traits && traits.speed !== "standard" ? (
        <SymbolView
          name={traits.speed === "ultrafast" ? "bolt.horizontal.fill" : "bolt.fill"}
          size={11}
          tintColor={speedColor}
          type="monochrome"
        />
      ) : null}
      {traits?.contextWindowLabel ? (
        <View className="rounded border border-border px-1">
          <Text className="font-ryco-medium text-[10px] text-foreground-muted">
            {traits.contextWindowLabel}
          </Text>
        </View>
      ) : null}
      <SymbolView name="chevron.down" size={9} tintColor={subtle} type="monochrome" />
    </Pressable>
  );
}

const RING_RADIUS = 9.75;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** The 24pt ring: how full the context window is, the percentage inside. Opens the details. */
export function ComposerContextMeter(props: {
  /** 0–1; null before the provider reported usage. */
  readonly fraction: number | null;
  readonly onPress?: (() => void) | undefined;
}) {
  const track = useThemeColor("--color-subtle-strong");
  const stroke = useThemeColor("--color-foreground-muted");
  const percent = Math.round(Math.max(0, Math.min(1, props.fraction ?? 0)) * 100);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Context window ${percent}% used`}
      disabled={props.onPress === undefined}
      onPress={props.onPress}
      hitSlop={{ top: 6, bottom: 6, left: 8, right: 4 }}
      className="h-8 w-6 items-center justify-center active:opacity-85"
    >
      <View className="size-6 items-center justify-center">
        <Svg
          width={24}
          height={24}
          style={{ position: "absolute", transform: [{ rotate: "-90deg" }] }}
        >
          <Circle
            cx={12}
            cy={12}
            r={RING_RADIUS}
            fill="none"
            stroke={track as string}
            strokeWidth={3}
          />
          <Circle
            cx={12}
            cy={12}
            r={RING_RADIUS}
            fill="none"
            stroke={stroke as string}
            strokeWidth={3}
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={RING_CIRCUMFERENCE - (percent / 100) * RING_CIRCUMFERENCE}
          />
        </Svg>
        <View className="size-[15px] items-center justify-center rounded-full bg-screen">
          <Text className="font-ryco-medium text-[8px] text-foreground-muted">{percent}</Text>
        </View>
      </View>
    </Pressable>
  );
}

/** The card's 32pt round button: send (also queues while a turn runs) or the rose stop. */
export function ComposerRoundButton(props: {
  readonly accessibilityLabel: string;
  readonly tone: "primary" | "stop";
  readonly disabled: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  const stop = useThemeColor("--color-stop");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={6}
      className={
        props.tone === "primary"
          ? "size-8 items-center justify-center rounded-full bg-primary/90 active:opacity-80 disabled:opacity-30"
          : "size-8 items-center justify-center rounded-full active:opacity-80 disabled:opacity-50"
      }
      style={props.tone === "stop" ? { backgroundColor: stop } : undefined}
    >
      {props.children}
    </Pressable>
  );
}

/**
 * The paper plane on the send button. Like the desktop's SendGlyph, its ink sits up and right of
 * its box, so it is nudged toward its tail until it reads centred.
 */
export function ComposerSendGlyph(props: { readonly size: number; readonly color: string }) {
  return (
    <View
      style={{ transform: [{ translateX: -props.size * 0.07 }, { translateY: props.size * 0.08 }] }}
    >
      <SymbolView
        name="paperplane"
        size={props.size}
        weight="medium"
        tintColor={props.color}
        type="monochrome"
      />
    </View>
  );
}
