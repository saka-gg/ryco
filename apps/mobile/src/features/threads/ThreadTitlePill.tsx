import { useRef } from "react";
import { Pressable, useWindowDimensions, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { GlassSurface } from "../../components/GlassSurface";
import { ProjectBadge } from "../../components/ProjectBadge";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  threadTitlePillAccessibilityLabel,
  type ThreadTitlePillView,
} from "./threadContextSheetModel";

/**
 * Room the header keeps for the back button and the ⋯ menu on either side of the pill. The
 * pill sits centered in the slot between them (the native header lays the title view out from
 * the back button), as in the prototype.
 */
const SIDE_ROOM = 72;
const PILL_HEIGHT = 42;
const BADGE_SIZE = 26;

/**
 * The thread's title as a floating Liquid Glass pill in the header: the project's colored
 * badge, the title and, under it, the branch with a small chevron. The messages scroll under
 * it. Tapping it drops the chat's context card.
 */
export function ThreadTitlePill(props: {
  readonly model: ThreadTitlePillView;
  readonly expanded: boolean;
  /** With the pill's bottom edge in window points, where the context card hangs from. */
  readonly onPress: (pillBottom: number | null) => void;
}) {
  const pillRef = useRef<View>(null);
  const { width } = useWindowDimensions();
  const iconColor = useThemeColor("--color-icon-subtle");
  const { model } = props;
  const subline = model.branchLabel ?? model.worktreeLabel;
  return (
    <View className="items-center" style={{ width: Math.max(180, width - SIDE_ROOM * 2) }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={threadTitlePillAccessibilityLabel(model)}
        accessibilityState={{ expanded: props.expanded }}
        onPress={() => {
          const pill = pillRef.current;
          if (!pill) {
            props.onPress(null);
            return;
          }
          pill.measureInWindow((_x, y, _width, height) =>
            props.onPress(Number.isFinite(y) && height > 0 ? y + height : null),
          );
        }}
        hitSlop={{ top: 4, bottom: 4 }}
        className="max-w-full active:opacity-80"
      >
        <View ref={pillRef} collapsable={false}>
          <GlassSurface radius={PILL_HEIGHT / 2}>
            <View
              className="flex-row items-center"
              style={{ height: PILL_HEIGHT, paddingLeft: 8, paddingRight: 14, gap: 8 }}
            >
              <ProjectBadge
                environmentId={model.badge.environmentId}
                projectId={model.badge.projectId}
                customAvatarContentHash={model.badge.customAvatarContentHash}
                name={model.badge.name}
                size={BADGE_SIZE}
              />
              <View className="min-w-0 shrink">
                <Text
                  className="font-ryco-bold text-foreground"
                  style={{ fontSize: 13.5, lineHeight: 17 }}
                  numberOfLines={1}
                >
                  {model.title}
                </Text>
                <View className="min-w-0 flex-row items-center" style={{ gap: 4 }}>
                  <SymbolView
                    name={model.branchLabel ? "arrow.triangle.branch" : "folder"}
                    size={10}
                    tintColor={iconColor}
                    type="monochrome"
                  />
                  <Text
                    className="shrink text-foreground-muted"
                    style={{ fontSize: 11, lineHeight: 14 }}
                    numberOfLines={1}
                  >
                    {subline}
                  </Text>
                  <SymbolView
                    name="chevron.down"
                    size={8}
                    weight="semibold"
                    tintColor={iconColor}
                    type="monochrome"
                  />
                </View>
              </View>
            </View>
          </GlassSurface>
        </View>
      </Pressable>
    </View>
  );
}
