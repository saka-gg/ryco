import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { AccessibilityInfo, Pressable, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  Easing,
  FadeOut,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type EntryAnimationsValues,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { HOME_TOOLBAR_HEIGHT, HOME_TOOLBAR_INSET } from "../features/home/homeChromeModel";
import { useThemeColor } from "../lib/useThemeColor";
import { sidebarUndo, sidebarUndoNotices } from "../state/sidebarUndo";
import { AppText } from "./AppText";
import { SymbolView } from "./AppSymbol";
import { GlassSurface } from "./GlassSurface";
import {
  presentUndoNotice,
  shouldDismissToast,
  type UndoNoticePresentation,
} from "./sidebarUndoNoticeModel";

const SWIPE_TIMING = { duration: 160, reduceMotion: ReduceMotion.System };
const ENTER_TIMING = {
  duration: 220,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
};
const TOAST_EXITING = FadeOut.duration(100).reduceMotion(ReduceMotion.System);

/**
 * The Undo toast for thread actions (archive, settle, snooze, hide, unpin).
 * One at a time, the newest; it rises from below, lapses after five seconds
 * (the shared history's), and a sideways swipe dismisses it.
 */
export function SidebarUndoNoticeHost() {
  const notices = useSyncExternalStore(sidebarUndoNotices.subscribe, sidebarUndoNotices.read);
  const insets = useSafeAreaInsets();
  const notice = presentUndoNotice(notices);
  const announcement = notice?.announcement ?? null;
  // Announces the notice to VoiceOver once its Undo can run.
  useEffect(() => {
    if (announcement) AccessibilityInfo.announceForAccessibility(announcement);
  }, [announcement]);
  if (notice === null) return null;
  return (
    <View
      pointerEvents="box-none"
      className="absolute left-4 right-4"
      // Above Home's bottom toolbar, which every screen's bottom chrome is no taller than.
      style={{ bottom: insets.bottom + HOME_TOOLBAR_INSET + HOME_TOOLBAR_HEIGHT + 8 }}
    >
      <UndoToast key={notice.id} notice={notice} />
    </View>
  );
}

function UndoToast(props: { readonly notice: UndoNoticePresentation }) {
  const { notice } = props;
  const translation = useSharedValue(0);
  const width = useSharedValue(0);
  const iconColor = useThemeColor("--color-icon");
  // Cancels the swipe animation on unmount.
  useLayoutEffect(() => () => cancelAnimation(translation), [translation]);
  const dismiss = () => sidebarUndo.dismiss(notice.id);
  const gesture = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .failOffsetY([-12, 12])
    .onUpdate((event) => {
      translation.set(event.translationX);
    })
    .onEnd((event) => {
      if (
        shouldDismissToast({
          translationX: event.translationX,
          velocityX: event.velocityX,
          width: width.value,
        })
      ) {
        const direction = Math.sign(event.translationX || event.velocityX);
        translation.set(
          withTiming(direction * (width.value + 24), SWIPE_TIMING, (finished) => {
            if (finished) runOnJS(dismiss)();
          }),
        );
      } else {
        translation.set(withTiming(0, SWIPE_TIMING));
      }
    });
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translation.value }],
  }));
  const entering = (values: EntryAnimationsValues) => {
    "worklet";
    return {
      initialValues: { originY: values.targetOriginY + values.targetHeight + 12 },
      animations: { originY: withTiming(values.targetOriginY, ENTER_TIMING) },
    };
  };
  return (
    <Animated.View
      pointerEvents="box-none"
      exiting={TOAST_EXITING}
      onAccessibilityEscape={dismiss}
      onLayout={(event) => width.set(event.nativeEvent.layout.width)}
    >
      <GestureDetector gesture={gesture}>
        <Animated.View collapsable={false} entering={entering} style={animatedStyle}>
          <GlassSurface radius={28} style={{ borderRadius: 28 }}>
            <View
              accessibilityLiveRegion="polite"
              className="min-h-12 flex-row items-center gap-3 py-1.5 pl-4 pr-1.5"
            >
              <SymbolView name="checkmark.circle" size={20} tintColor={iconColor} />
              <View className="min-w-0 flex-1">
                <AppText className="font-ryco-medium text-sm" numberOfLines={1}>
                  {notice.message}
                </AppText>
                {notice.detail ? (
                  <AppText className="text-xs text-foreground-muted" numberOfLines={1}>
                    {notice.detail}
                  </AppText>
                ) : null}
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={notice.undoLabel}
                accessibilityState={{ disabled: notice.undoDisabled }}
                disabled={notice.undoDisabled}
                className="min-h-11 min-w-16 items-center justify-center rounded-full bg-subtle-strong px-4 active:opacity-70"
                onPress={() => void sidebarUndo.undo(notice.id)}
              >
                <AppText className="font-ryco-medium text-sm">
                  {notice.undoDisabled ? "Undoing…" : "Undo"}
                </AppText>
              </Pressable>
            </View>
          </GlassSurface>
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}
