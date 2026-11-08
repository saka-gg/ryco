import { useEffect, useRef, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { GlassSurface } from "../../components/GlassSurface";
import { cn } from "../../lib/cn";
import { secondClock } from "../../lib/secondClock";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  resolveFloatingThreadControl,
  type FloatingThreadAttention,
  type FloatingThreadStatus,
} from "./floatingThreadControlModel";
import type { ThreadAgentsEntry } from "./threadAgentsSheetModel";

const subscribeToNothing = () => () => {};
const readNoClock = () => 0;

// t3code's floating working control: one glass capsule and a round scroll button that slides
// out from behind it, 240 ms ease-out, labels cross-fading 160 ms in (after 80) and 100 ms out.
const CONTROL_HEIGHT = 38;
const CONTROL_ROW_GAP = 14;
const CONTROL_SEPARATION = (CONTROL_ROW_GAP + CONTROL_HEIGHT) / 2;
const CONTROL_TIMING = {
  duration: 240,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const;
const CONTROL_ENTERING = FadeIn.duration(180).reduceMotion(ReduceMotion.System);
const CONTROL_EXITING = FadeOut.duration(120).reduceMotion(ReduceMotion.System);
const LABEL_ENTERING = FadeIn.duration(160).delay(80).reduceMotion(ReduceMotion.System);
const LABEL_EXITING = FadeOut.duration(100).reduceMotion(ReduceMotion.System);

const STATUS_TEXT: Readonly<Record<FloatingThreadStatus["kind"], string>> = {
  working: "text-foreground",
  attention: "text-warning",
  "child-attention": "text-warning",
};

function StatusLead(props: { readonly status: FloatingThreadStatus }) {
  const iconColor = useThemeColor("--color-icon");
  const warningColor = useThemeColor("--color-warning");
  if (props.status.kind === "working") {
    return <ActivityIndicator size="small" color={iconColor} />;
  }
  return (
    <SymbolView
      name={props.status.kind === "attention" ? "hand.raised.fill" : "arrow.turn.down.right"}
      size={13}
      tintColor={warningColor}
      type="monochrome"
    />
  );
}

/**
 * The thread's live status over the bottom of the feed, above the composer: "Working · 1:24",
 * what the chat (or a chat it delegated) waits on, and how many of its agents are active. A
 * round button to the newest message slides out beside it once the reader scrolled back.
 */
export function FloatingThreadControl(props: {
  readonly runningSince: string | null;
  readonly followingLatest: boolean;
  readonly attention: FloatingThreadAttention;
  readonly childAttention: { readonly threadId: string; readonly title: string } | null;
  readonly agents: ThreadAgentsEntry | null;
  readonly onJumpToLatest: () => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly onOpenAgents: () => void;
}) {
  const running = props.runningSince !== null && props.attention === null;
  const nowMs = useSyncExternalStore(
    running ? secondClock.subscribe : subscribeToNothing,
    running ? secondClock.read : readNoClock,
  );
  const iconColor = useThemeColor("--color-icon");
  const { status, jump } = resolveFloatingThreadControl({
    runningSince: props.runningSince,
    followingLatest: props.followingLatest,
    nowMs,
    attention: props.attention,
    childAttention: props.childAttention,
  });
  // Only an active roster rides along; a finished one lives in the context sheet.
  const agents = props.agents?.live ? props.agents : null;
  const hasCapsule = status !== null || agents !== null;

  const separation = useSharedValue(jump ? 1 : 0);
  useEffect(() => {
    separation.set(withTiming(jump ? 1 : 0, CONTROL_TIMING));
  }, [jump, separation]);
  const capsuleStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: CONTROL_SEPARATION * (1 - separation.value) }],
  }));
  const arrowStyle = useAnimatedStyle(() => ({
    opacity: separation.value,
    transform: [{ translateX: -CONTROL_SEPARATION * (1 - separation.value) }],
  }));

  // The status segment grows and shrinks with its label instead of jumping.
  const labelWidth = useSharedValue<number | null>(null);
  const measured = useRef<number | null>(null);
  const onLabelLayout = (event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    // Sub-point changes (a ticking clock) would only retarget the animation.
    if (measured.current !== null && Math.abs(measured.current - width) < 1) return;
    const first = measured.current === null;
    measured.current = width;
    labelWidth.set(first ? width : withTiming(width, CONTROL_TIMING));
  };
  const hasStatus = status !== null;
  useEffect(() => {
    if (!hasStatus) {
      measured.current = null;
      labelWidth.set(null);
    }
  }, [hasStatus, labelWidth]);
  const sizerStyle = useAnimatedStyle(() => ({ width: labelWidth.value ?? 0 }));

  const jumpButton = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Jump to latest message"
      onPress={props.onJumpToLatest}
      disabled={!jump}
      className="active:opacity-80"
    >
      <GlassSurface radius={CONTROL_HEIGHT / 2}>
        <View
          className="items-center justify-center"
          style={{ width: CONTROL_HEIGHT, height: CONTROL_HEIGHT }}
        >
          <SymbolView name="arrow.down" size={14} tintColor={iconColor} type="monochrome" />
        </View>
      </GlassSurface>
    </Pressable>
  );

  if (!hasCapsule) {
    return jump ? (
      <View pointerEvents="box-none" className="absolute bottom-2 left-0 right-0 items-center">
        <Animated.View entering={CONTROL_ENTERING} exiting={CONTROL_EXITING}>
          {jumpButton}
        </Animated.View>
      </View>
    ) : null;
  }

  const onStatusPress = () => {
    if (status?.kind === "child-attention") props.onOpenThread(status.threadId);
    else props.onJumpToLatest();
  };

  return (
    <View pointerEvents="box-none" className="absolute bottom-2 left-0 right-0 items-center">
      <Animated.View
        entering={CONTROL_ENTERING}
        exiting={CONTROL_EXITING}
        pointerEvents="box-none"
        className="flex-row items-center"
        style={{ gap: CONTROL_ROW_GAP }}
      >
        <Animated.View style={capsuleStyle}>
          <GlassSurface radius={CONTROL_HEIGHT / 2}>
            <View className="flex-row items-center" style={{ height: CONTROL_HEIGHT }}>
              {agents ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={agents.accessibilityLabel}
                  onPress={props.onOpenAgents}
                  className="h-full flex-row items-center gap-1.5 px-3.5 active:opacity-70"
                >
                  <View className="h-1.5 w-1.5 rounded-full bg-accent" />
                  <Text className="font-ryco-medium text-sm text-accent-strong">
                    {agents.label}
                  </Text>
                </Pressable>
              ) : null}
              {agents && status ? <View className="h-4 w-px bg-border" /> : null}
              {status ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={status.accessibilityLabel}
                  onPress={onStatusPress}
                  className="h-full justify-center overflow-hidden px-3.5 active:opacity-70"
                >
                  <Animated.View style={[{ height: CONTROL_HEIGHT }, sizerStyle]} />
                  <View className="absolute left-3.5 h-full justify-center">
                    <Animated.View
                      key={`${status.kind}:${status.kind === "working" ? "" : status.label}`}
                      entering={LABEL_ENTERING}
                      exiting={LABEL_EXITING}
                      onLayout={onLabelLayout}
                      className="flex-row items-center gap-2"
                    >
                      <StatusLead status={status} />
                      <Text
                        className={cn("font-ryco-medium text-sm", STATUS_TEXT[status.kind])}
                        style={{ fontVariant: ["tabular-nums"] }}
                        numberOfLines={1}
                      >
                        {status.label}
                      </Text>
                    </Animated.View>
                  </View>
                </Pressable>
              ) : null}
            </View>
          </GlassSurface>
        </Animated.View>
        <Animated.View style={arrowStyle} pointerEvents={jump ? "auto" : "none"}>
          {jumpButton}
        </Animated.View>
      </Animated.View>
    </View>
  );
}
