import { useEffect, useState, type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
  Easing,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useThemeColor } from "../lib/useThemeColor";

// iOS sheet motion: in over 300 ms ease-out, out over 220 ms; a drag past a quarter of the
// card (or a quick flick) dismisses it, anything less springs back.
const OPEN_TIMING = {
  duration: 300,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
};
const CLOSE_TIMING = {
  duration: 220,
  easing: Easing.in(Easing.cubic),
  reduceMotion: ReduceMotion.System,
};
const DISMISS_FRACTION = 0.25;
const MAX_CARD_WIDTH = 640;
const DISMISS_VELOCITY = 900;

/**
 * A card that slides up from the bottom over a dimmed screen, for short context the reader
 * glances at and closes (the thread's context sheet, the Claude cache details). Drag it down
 * or tap outside to close. Taller content scrolls inside the card, up to 85% of the screen.
 */
export function BottomSheet(props: {
  readonly visible: boolean;
  readonly onClose: () => void;
  /** Called once the card is fully gone, e.g. to open what a row chose. */
  readonly onDismissed?: () => void;
  readonly accessibilityLabel: string;
  readonly children: ReactNode;
}) {
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const sheetColor = useThemeColor("--color-screen");
  const [mounted, setMounted] = useState(props.visible);
  const [cardHeight, setCardHeight] = useState(windowHeight);
  const offset = useSharedValue(windowHeight);

  const { visible, onDismissed, onClose } = props;
  // Showing mounts at once (adjusted while rendering); hiding unmounts once the card slid out.
  if (visible && !mounted) setMounted(true);
  useEffect(() => {
    if (visible) {
      // From below the screen on first show, or from wherever a drag or a closing left it.
      offset.set(withTiming(0, OPEN_TIMING));
      return;
    }
    if (!mounted) return;
    offset.set(
      withTiming(cardHeight, CLOSE_TIMING, (finished) => {
        if (finished) {
          runOnJS(setMounted)(false);
          if (onDismissed) runOnJS(onDismissed)();
        }
      }),
    );
  }, [cardHeight, mounted, offset, onDismissed, visible]);

  const drag = Gesture.Pan()
    .activeOffsetY(8)
    .onChange((event) => {
      offset.set(Math.max(0, offset.value + event.changeY));
    })
    .onEnd((event) => {
      if (offset.value > cardHeight * DISMISS_FRACTION || event.velocityY > DISMISS_VELOCITY) {
        runOnJS(onClose)();
      } else {
        offset.set(withTiming(0, OPEN_TIMING));
      }
    });

  const cardStyle = useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }] }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: cardHeight > 0 ? Math.max(0, 1 - offset.value / cardHeight) * 0.45 : 0,
  }));

  if (!mounted) return null;
  return (
    <Modal
      visible
      transparent
      animationType="none"
      onRequestClose={props.onClose}
      statusBarTranslucent
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        {/* A field in the card stays above the keyboard (Android's modal window resizes itself). */}
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          className="flex-1 justify-end"
        >
          <Animated.View
            pointerEvents="none"
            className="absolute inset-0 bg-black"
            style={backdropStyle}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            className="absolute inset-0"
            onPress={props.onClose}
          />
          <Animated.View
            accessibilityViewIsModal
            accessibilityLabel={props.accessibilityLabel}
            onLayout={(event) => setCardHeight(event.nativeEvent.layout.height)}
            className="overflow-hidden border-t border-border"
            style={[
              {
                maxHeight: windowHeight * 0.85,
                // On a wide screen (iPad) the card keeps a readable width, centered.
                width: "100%",
                maxWidth: MAX_CARD_WIDTH,
                alignSelf: "center",
                borderTopLeftRadius: 28,
                borderTopRightRadius: 28,
                backgroundColor: sheetColor,
                paddingBottom: Math.max(insets.bottom, 16),
              },
              cardStyle,
            ]}
          >
            <GestureDetector gesture={drag}>
              <View className="items-center pb-2 pt-2.5">
                <View className="h-1.5 w-9 rounded-full bg-subtle-strong" />
              </View>
            </GestureDetector>
            <ScrollView
              bounces={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 6, gap: 14 }}
            >
              {props.children}
            </ScrollView>
          </Animated.View>
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
    </Modal>
  );
}
