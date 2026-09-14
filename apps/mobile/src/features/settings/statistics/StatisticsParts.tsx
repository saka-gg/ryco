import { appMotion } from "../../../lib/motion";
import { useEffect, useState, type ReactNode } from "react";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useThemeColor } from "../../../lib/useThemeColor";
import { Pressable, useColorScheme, View } from "react-native";
import { AppText as Text } from "../../../components/AppText";
import { MenuView } from "@react-native-menu/menu";

// Hermes does not consistently implement Intl compact notation across iOS runtimes.
export const compact = (value: number) => {
  const tier =
    Math.abs(value) >= 1e9
      ? ([1e9, "B"] as const)
      : Math.abs(value) >= 1e6
        ? ([1e6, "M"] as const)
        : Math.abs(value) >= 1e3
          ? ([1e3, "K"] as const)
          : ([1, ""] as const);
  return `${Number((value / tier[0]).toFixed(1))}${tier[1]}`;
};
export const money = (value: number | null) =>
  value === null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(value);
export const integer = (value: number) => Math.round(value).toLocaleString("en-US");
export const duration = (ms: number) => {
  if (ms <= 0) return "0m";
  if (Math.round(ms / 1000) < 60) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.round(ms / 60000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};
export const dayLabel = (date: string) => {
  const [, month, day] = date.split("-");
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(month) - 1]} ${Number(day)}`;
};
export function useStatisticsPalette() {
  const dark = useColorScheme() === "dark";
  return {
    background: dark ? "#0b0b0c" : "#ffffff",
    card: dark ? "#151516" : "#ffffff",
    foreground: dark ? "#ececed" : "#262626",
    muted: dark ? "#b4b4b4" : "#676767",
    border: dark ? "#ffffff17" : "#0000001a",
    accent: dark ? "#ffffff0f" : "#0000000b",
    primary: dark ? "#e4e4e5" : "#171717",
    success: "#10b981",
    danger: dark ? "#f15757" : "#ef4444",
  };
}
export function Choice(props: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <MenuView
      title={props.label}
      actions={props.options.map((option) => ({
        id: option.value,
        title: option.label,
        state: option.value === props.value ? "on" : "off",
      }))}
      onPressAction={({ nativeEvent }) => props.onChange(nativeEvent.event)}
    >
      <View
        accessibilityRole="button"
        accessibilityLabel={`${props.label}: ${props.options.find((option) => option.value === props.value)?.label ?? props.value}`}
        className="rounded-lg border border-border bg-card px-3 py-2"
      >
        <Text numberOfLines={1} className="text-xs text-foreground">
          {props.options.find((option) => option.value === props.value)?.label ?? props.value} ▾
        </Text>
      </View>
    </MenuView>
  );
}
export function Tabs<T extends string>(props: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const [width, setWidth] = useState(0);
  const index = props.options.findIndex((option) => option.value === props.value);
  const position = useSharedValue(index);
  const color = useThemeColor("--color-screen");
  const segmentWidth = Math.max(0, (width - 8) / props.options.length);
  useEffect(() => {
    position.set(withSpring(index, appMotion.spring));
  }, [index, position]);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: position.get() * segmentWidth }],
  }));
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      accessibilityRole="tablist"
      className="flex-row rounded-full bg-card p-1 border border-border"
    >
      {width > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              left: 3,
              top: 3,
              bottom: 3,
              width: segmentWidth,
              borderRadius: 30,
              backgroundColor: color,
            },
            style,
          ]}
        />
      ) : null}
      {props.options.map((option) => (
        <Pressable
          key={option.value}
          accessibilityRole="tab"
          accessibilityState={{ selected: props.value === option.value }}
          onPress={() => props.onChange(option.value)}
          className="flex-1 items-center rounded-full py-2"
        >
          <Text className="text-sm font-ryco-medium text-foreground">{option.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}
export function Panel(props: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  flush?: boolean;
}) {
  const colors = useStatisticsPalette();
  return (
    <View style={{ gap: 10 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          paddingHorizontal: 4,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 }}>
          <View style={{ height: 1, width: 12, backgroundColor: colors.border }} />
          {props.icon}
          <Text
            className="font-ryco-bold"
            style={{
              fontSize: 11,
              letterSpacing: 0.88,
              color: colors.muted,
              textTransform: "uppercase",
              flexShrink: 1,
            }}
          >
            {props.title}
          </Text>
        </View>
        {props.action}
      </View>
      <View
        style={{
          borderRadius: 16,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.card,
          padding: props.flush ? 0 : 20,
          gap: props.flush ? 0 : 16,
          overflow: "hidden",
        }}
      >
        {props.children}
      </View>
    </View>
  );
}
export function Note(props: { children: ReactNode }) {
  const colors = useStatisticsPalette();
  return (
    <Text style={{ fontSize: 12, lineHeight: 19.5, color: colors.muted }}>{props.children}</Text>
  );
}
export function Toggle(props: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const colors = useStatisticsPalette();
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={props.label}
      style={{
        flexDirection: "row",
        padding: 2,
        borderRadius: 6,
        backgroundColor: colors.accent,
        alignSelf: "flex-start",
      }}
    >
      {props.options.map((option) => (
        <Pressable
          key={option.value}
          accessibilityRole="tab"
          accessibilityState={{ selected: props.value === option.value }}
          onPress={() => props.onChange(option.value)}
          hitSlop={4}
          style={{
            minHeight: 28,
            paddingHorizontal: 8,
            justifyContent: "center",
            borderRadius: 4,
            backgroundColor: props.value === option.value ? colors.background : "transparent",
          }}
        >
          <Text
            className="font-ryco-medium"
            style={{
              fontSize: 11,
              color: props.value === option.value ? colors.foreground : colors.muted,
            }}
          >
            {option.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
export function MiniMetric(props: {
  label: string;
  value: string;
  detail?: string;
  tone?: "positive" | "negative";
}) {
  const colors = useStatisticsPalette();
  return (
    <View style={{ flex: 1, gap: 4 }}>
      <Text
        style={{
          fontSize: 10,
          letterSpacing: 0.8,
          color: colors.muted,
          textTransform: "uppercase",
        }}
      >
        {props.label}
      </Text>
      <Text
        className="font-ryco-bold"
        style={{
          fontSize: 16,
          color:
            props.tone === "positive"
              ? colors.success
              : props.tone === "negative"
                ? colors.danger
                : colors.foreground,
        }}
      >
        {props.value}
      </Text>
      {props.detail ? <Note>{props.detail}</Note> : null}
    </View>
  );
}
export function Metrics(props: { values: readonly [string, string][] }) {
  return (
    <View className="flex-row flex-wrap gap-y-4">
      {props.values.map(([label, value]) => (
        <View key={label} className="w-1/2 gap-1 pr-2">
          <Text
            className="text-2xl font-ryco-medium text-foreground"
            selectable
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.65}
          >
            {value}
          </Text>
          <Note>{label}</Note>
        </View>
      ))}
    </View>
  );
}
export function Row(props: { label: string; value: string; detail?: string }) {
  return (
    <View className="flex-row items-center gap-3">
      <View className="flex-1 gap-1">
        <Text className="text-sm text-foreground" selectable>
          {props.label}
        </Text>
        {props.detail ? <Note>{props.detail}</Note> : null}
      </View>
      <Text className="text-sm font-ryco-medium text-foreground" selectable>
        {props.value}
      </Text>
    </View>
  );
}
