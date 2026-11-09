import { useEffect, useSyncExternalStore } from "react";
import { AccessibilityInfo, Pressable, View } from "react-native";
import Animated, {
  Easing,
  FadeOut,
  ReduceMotion,
  withTiming,
  type EntryAnimationsValues,
} from "react-native-reanimated";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { GlassSurface } from "../../components/GlassSurface";
import { useThemeColor } from "../../lib/useThemeColor";
import { runTaskUndo, taskUndoNotices } from "./taskUndo";

const ENTER_TIMING = {
  duration: 220,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
};
const EXITING = FadeOut.duration(100).reduceMotion(ReduceMotion.System);

/** The Undo notice of the Tasks tab, risen from below like the thread actions' one. */
export function TaskUndoToast(props: { readonly bottom: number }) {
  const notice = useSyncExternalStore(taskUndoNotices.subscribe, taskUndoNotices.read);
  const icon = useThemeColor("--color-icon") as string;
  const message = notice?.message ?? null;
  useEffect(() => {
    if (message) AccessibilityInfo.announceForAccessibility(`${message}. Undo available.`);
  }, [message]);
  if (notice === null) return null;
  const entering = (values: EntryAnimationsValues) => {
    "worklet";
    return {
      initialValues: { originY: values.targetOriginY + values.targetHeight + 12 },
      animations: { originY: withTiming(values.targetOriginY, ENTER_TIMING) },
    };
  };
  return (
    <View
      pointerEvents="box-none"
      className="absolute left-4 right-4"
      style={{ bottom: props.bottom }}
    >
      <Animated.View key={notice.id} entering={entering} exiting={EXITING}>
        <GlassSurface radius={28} style={{ borderRadius: 28 }}>
          <View
            accessibilityLiveRegion="polite"
            className="min-h-12 flex-row items-center gap-3 py-1.5 pl-4 pr-1.5"
          >
            <SymbolView name="checkmark.circle" size={20} tintColor={icon} />
            <Text className="min-w-0 flex-1 font-ryco-medium text-sm" numberOfLines={1}>
              {notice.message}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Undo"
              onPress={() => runTaskUndo(notice.id)}
              className="min-h-11 min-w-16 items-center justify-center rounded-full bg-subtle-strong px-4 active:opacity-70"
            >
              <Text className="font-ryco-medium text-sm">Undo</Text>
            </Pressable>
          </View>
        </GlassSurface>
      </Animated.View>
    </View>
  );
}
