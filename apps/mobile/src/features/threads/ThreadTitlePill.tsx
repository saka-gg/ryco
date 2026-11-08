import { Pressable, useWindowDimensions, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { GlassSurface } from "../../components/GlassSurface";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  threadStatusTone,
  threadTitlePillAccessibilityLabel,
  type ThreadStatusTone,
} from "./threadContextSheetModel";
import type { ThreadHeaderModel } from "./threadHeaderModel";

const DOT_CLASS: Readonly<Record<ThreadStatusTone, string>> = {
  working: "bg-accent",
  attention: "bg-warning",
  ready: "bg-success",
  muted: "bg-foreground-tertiary",
};

/** Room the header keeps for the back button and the ⋯ menu on either side of the pill. */
const SIDE_ROOM = 70;
const PILL_HEIGHT = 40;

/**
 * The thread's title as a floating Liquid Glass pill in the header: a status dot, the title and
 * a small project hint. The messages scroll under it. Tapping it opens the context sheet.
 */
export function ThreadTitlePill(props: {
  readonly model: ThreadHeaderModel;
  readonly onPress: () => void;
}) {
  const { width } = useWindowDimensions();
  const iconColor = useThemeColor("--color-icon-subtle");
  const tone = threadStatusTone(props.model.statusLabel);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={threadTitlePillAccessibilityLabel(props.model)}
      onPress={props.onPress}
      hitSlop={{ top: 4, bottom: 4 }}
      className="active:opacity-80"
      style={{ maxWidth: Math.max(160, width - SIDE_ROOM * 2) }}
    >
      <GlassSurface radius={PILL_HEIGHT / 2}>
        <View className="flex-row items-center gap-2 px-3.5" style={{ height: PILL_HEIGHT }}>
          <View className={cn("h-2 w-2 rounded-full", DOT_CLASS[tone])} />
          <Text className="shrink font-ryco-bold text-[15px] text-foreground" numberOfLines={1}>
            {props.model.title}
          </Text>
          <View className="shrink flex-row items-center gap-0.5" style={{ maxWidth: 84 }}>
            <Text className="shrink text-xs text-foreground-tertiary" numberOfLines={1}>
              {props.model.projectLabel}
            </Text>
            <SymbolView name="chevron.down" size={8} tintColor={iconColor} type="monochrome" />
          </View>
        </View>
      </GlassSurface>
    </Pressable>
  );
}
