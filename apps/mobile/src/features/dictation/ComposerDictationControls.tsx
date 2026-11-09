import { memo, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text as SystemText, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  ReduceMotion,
  useAnimatedStyle,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import { DICTATION_LEVEL_SAMPLES, formatDictationElapsed } from "./dictationModel";
import type { ComposerDictation } from "./useComposerDictation";

// The composer's dictation UI (attribution in NOTICE.md): the
// toolbar row turns into cancel · level meter + elapsed time · confirm while
// listening, and the mic answers a tap (start, then confirm or cancel) or a
// hold (talk while pressed, release to finish).

const BAR_HEIGHT = 28;
const MIN_BAR_HEIGHT = 2;
const BAR_TIMING = {
  duration: 100,
  easing: Easing.out(Easing.quad),
  reduceMotion: ReduceMotion.System,
};
/** A press longer than this is push-to-talk: releasing it finishes. */
const HOLD_TO_TALK_DELAY_MS = 300;

const LevelBar = memo(function LevelBar(props: {
  readonly levels: SharedValue<ReadonlyArray<number>>;
  readonly index: number;
}) {
  const { levels, index } = props;
  const style = useAnimatedStyle(() => {
    const samples = levels.value;
    const level = samples[samples.length - DICTATION_LEVEL_SAMPLES + index] ?? 0;
    return {
      opacity: withTiming(0.25 + level * 0.75, BAR_TIMING),
      transform: [
        {
          scaleY: withTiming(
            (MIN_BAR_HEIGHT + level * (BAR_HEIGHT - MIN_BAR_HEIGHT)) / BAR_HEIGHT,
            BAR_TIMING,
          ),
        },
      ],
    };
  });
  return (
    <Animated.View
      className="w-[3px] rounded-full bg-foreground"
      style={[{ height: BAR_HEIGHT }, style]}
    />
  );
});

function DictationRoundButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: "xmark" | "checkmark";
  readonly primary?: boolean;
  readonly busy?: boolean;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  const primaryFg = useThemeColor("--color-primary-foreground");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ busy: props.busy === true, disabled: props.busy === true }}
      disabled={props.busy}
      onPress={props.onPress}
      className={`h-11 w-11 items-center justify-center rounded-full active:opacity-70 ${
        props.primary ? "bg-primary" : "active:bg-subtle-strong"
      }`}
    >
      {props.busy ? (
        <ActivityIndicator size="small" color={primaryFg as string} />
      ) : (
        <SymbolView
          name={props.icon}
          size={props.primary ? 16 : 18}
          tintColor={(props.primary ? primaryFg : iconColor) as string}
          type="monochrome"
        />
      )}
    </Pressable>
  );
}

/**
 * Seconds since `startedAt`, ticking in this component only, so the composer
 * around the bar does not re-render with the timer.
 */
function useElapsedSeconds(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, (now - startedAt) / 1000);
}

/** Cancel · level meter and elapsed time · confirm, in place of the composer's toolbar row. */
export function ComposerDictationBar(props: { readonly dictation: ComposerDictation }) {
  const { dictation } = props;
  const listening = dictation.state.phase === "listening";
  const elapsedSeconds = useElapsedSeconds(dictation.startedAt);
  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(140)}
      className="h-11 flex-row items-center gap-2"
    >
      <DictationRoundButton
        accessibilityLabel="Cancel dictation"
        icon="xmark"
        onPress={dictation.cancel}
      />
      <View
        accessible
        accessibilityLabel={
          listening
            ? `Listening, ${formatDictationElapsed(elapsedSeconds)}`
            : dictation.state.phase === "finishing"
              ? "Finishing dictation"
              : "Preparing dictation"
        }
        className="min-w-0 flex-1 flex-row items-center gap-2"
      >
        <View
          className="min-w-0 flex-1 flex-row items-center justify-between overflow-hidden"
          style={{ height: BAR_HEIGHT }}
        >
          {Array.from({ length: DICTATION_LEVEL_SAMPLES }, (_, index) => (
            <LevelBar key={index} levels={dictation.levels} index={index} />
          ))}
        </View>
        <SystemText
          className="text-xs text-foreground-muted"
          // DM Sans has no tabular figures; the system font keeps the timer still.
          style={{ fontVariant: ["tabular-nums"], minWidth: 30 }}
        >
          {listening ? formatDictationElapsed(elapsedSeconds) : "…"}
        </SystemText>
      </View>
      <DictationRoundButton
        accessibilityLabel="Finish dictation"
        icon="checkmark"
        primary
        busy={!listening}
        onPress={dictation.finish}
      />
    </Animated.View>
  );
}

/** The mic: tap to start (then confirm or cancel in the bar), or hold to talk and release to finish. */
export function ComposerDictationButton(props: {
  readonly dictation: ComposerDictation;
  readonly disabled: boolean;
  /** The round target's diameter; 44 by default. */
  readonly size?: number;
}) {
  const size = props.size ?? 44;
  const { dictation } = props;
  const iconColor = useThemeColor("--color-icon");
  const accentColor = useThemeColor("--color-primary");
  const holding = useRef(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={dictation.active ? "Dictating" : "Dictate"}
      accessibilityHint="Tap to dictate, or hold to talk and release to finish."
      disabled={props.disabled}
      delayLongPress={HOLD_TO_TALK_DELAY_MS}
      onPress={() => {
        if (!dictation.active) dictation.start();
      }}
      onLongPress={() => {
        if (dictation.active) return;
        holding.current = true;
        dictation.start();
      }}
      onPressOut={() => {
        if (!holding.current) return;
        holding.current = false;
        dictation.finish();
      }}
      className="items-center justify-center rounded-full active:bg-subtle-strong disabled:opacity-40"
      style={{ width: size, height: size }}
    >
      <SymbolView
        name={dictation.active ? "mic.fill" : "mic"}
        size={size < 44 ? 17 : 18}
        tintColor={(dictation.active ? accentColor : iconColor) as string}
        type="monochrome"
      />
    </Pressable>
  );
}

/** A dictation failure above the composer, with Settings when a permission is missing. */
export function ComposerDictationError(props: { readonly dictation: ComposerDictation }) {
  const { state } = props.dictation;
  const iconColor = useThemeColor("--color-icon-muted");
  if (state.phase !== "error" || !state.error) return null;
  return (
    <View className="flex-row items-center gap-2 px-3 pb-1.5">
      <Text accessibilityRole="alert" className="min-w-0 flex-1 text-xs text-danger-foreground">
        {state.error}
      </Text>
      {state.errorAction === "settings" ? (
        <Pressable accessibilityRole="button" hitSlop={8} onPress={props.dictation.openSettings}>
          <Text className="text-xs font-ryco-medium text-foreground">Settings</Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss dictation error"
        hitSlop={8}
        onPress={props.dictation.dismissError}
      >
        <SymbolView name="xmark" size={11} tintColor={iconColor as string} type="monochrome" />
      </Pressable>
    </View>
  );
}
