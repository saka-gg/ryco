import { appMotion } from "../lib/motion";
import { useEffect, useState } from "react";
import { Pressable, useColorScheme } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";

import { AppText as Text } from "./AppText";
import { GlassSurface } from "./GlassSurface";
import { useThemeColor } from "../lib/useThemeColor";
import type { HomeMode } from "../features/home/homeMode";

const MODES: ReadonlyArray<{ readonly mode: HomeMode; readonly label: string }> = [
  { mode: "inbox", label: "Inbox" },
  { mode: "projects", label: "Projects" },
];

export function HomeModeControl(props: {
  readonly mode: HomeMode;
  readonly onSelect: (mode: HomeMode) => void;
}) {
  const [width, setWidth] = useState(0);
  const index = props.mode === "projects" ? 1 : 0;
  const position = useSharedValue(index);
  const dark = useColorScheme() === "dark";
  const selectedColor = useThemeColor(dark ? "--color-screen" : "--color-card");
  const segmentWidth = Math.max(0, (width - 8) / MODES.length);
  useEffect(() => {
    position.set(withSpring(index, appMotion.spring));
  }, [index, position]);
  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: position.get() * segmentWidth }],
  }));

  return (
    <GlassSurface
      accessibilityRole="tablist"
      radius={22}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{
        marginHorizontal: 16,
        marginTop: 8,
        padding: 4,
        flexDirection: "row",
        shadowOpacity: 0,
        elevation: 0,
      }}
    >
      {width > 0 ? (
        <Animated.View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            {
              position: "absolute",
              left: 3,
              top: 3,
              bottom: 3,
              width: segmentWidth,
              borderRadius: 18,
              backgroundColor: selectedColor,
            },
            indicatorStyle,
          ]}
        />
      ) : null}
      {MODES.map((item) => (
        <Pressable
          key={item.mode}
          accessibilityRole="tab"
          accessibilityState={{ selected: props.mode === item.mode }}
          onPress={() => props.onSelect(item.mode)}
          hitSlop={{ top: 6, bottom: 6 }}
          className="min-h-8 flex-1 items-center justify-center rounded-full px-2 active:opacity-70"
        >
          <Text className="text-base font-ryco-medium text-foreground">{item.label}</Text>
        </Pressable>
      ))}
    </GlassSurface>
  );
}
