import { MenuView, type NativeActionEvent } from "@react-native-menu/menu";
import type {
  PullRequestRowSpine,
  StackFootPartTone,
  StackSpineTone,
} from "@ryco/client-runtime/state/pull-request-review";
import { memo } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";
import { PullRequestCheckRing } from "./PullRequestCheckRing";
import { PULL_REQUEST_STACK_SYMBOL, pullRequestStateGlyph } from "./pullRequestGlyphModel";
import type { PullRequestListRow } from "./pullRequestListModel";
import {
  PULL_REQUEST_MERGED_COLOR,
  PullRequestDiffStats,
  PullRequestLabelChip,
  PullRequestReviewMark,
  PullRequestStateIcon,
} from "./PullRequestPresentation";
import { readinessTextClass } from "./PullRequestParts";

export type PullRequestRowAction = "open-host" | "copy-link" | "copy-branch";

const ROW_ACTIONS = [
  { id: "open-host", title: "Open on the host", image: "safari" },
  { id: "copy-link", title: "Copy link", image: "link" },
  { id: "copy-branch", title: "Copy branch name", image: "arrow.triangle.branch" },
] as const;

/** The glyph column's width: the stack spine runs down its middle. */
const GLYPH_COLUMN = 24;
const SPINE_WIDTH = 2;

function useSpineColor(tone: StackSpineTone): string {
  const border = useThemeColor("--color-border") as string;
  const success = useThemeColor("--color-success") as string;
  return tone === "landable" ? success : tone === "merged" ? PULL_REQUEST_MERGED_COLOR : border;
}

function Spine(props: { readonly tone: StackSpineTone; readonly position: "up" | "down" }) {
  const color = useSpineColor(props.tone);
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: (GLYPH_COLUMN - SPINE_WIDTH) / 2,
        width: SPINE_WIDTH,
        backgroundColor: color,
        opacity: props.tone === "none" ? 1 : 0.6,
        ...(props.position === "up" ? { top: 0, height: 12 } : { top: 34, bottom: 0 }),
      }}
    />
  );
}

/**
 * One pull request in the PRs tab, like the host's own list: state glyph
 * (with a conflict mark), number, author and age, the title, then readiness,
 * labels, the checks ring, the review verdict and the diff size. Layers of a
 * stack sit on a spine. Touch and hold for quick actions.
 */
export const PullRequestTabRow = memo(function PullRequestTabRow(props: {
  readonly row: PullRequestListRow;
  readonly spine: PullRequestRowSpine | null;
  readonly onPress: (row: PullRequestListRow) => void;
  readonly onAction: (row: PullRequestListRow, action: PullRequestRowAction) => void;
}) {
  const { row, spine } = props;
  const glyph = pullRequestStateGlyph(row);
  const muted = useThemeColor("--color-icon-muted") as string;
  const time =
    row.updatedAtMs === null ? null : relativeTime(new Date(row.updatedAtMs).toISOString());
  const onPressAction = (event: NativeActionEvent) =>
    props.onAction(row, event.nativeEvent.event as PullRequestRowAction);
  return (
    <MenuView
      shouldOpenOnLongPress
      title={`#${row.number}`}
      actions={ROW_ACTIONS.map((action) => ({ ...action }))}
      onPressAction={onPressAction}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Pull request ${row.number}, ${row.title}, ${row.readinessLabel}${row.stack ? `, stack layer ${row.stack.position} of ${row.stack.size}` : ""}`}
        accessibilityHint="Touch and hold for quick actions."
        onPress={() => props.onPress(row)}
        className="flex-row gap-3 px-4 active:bg-subtle"
      >
        <View style={{ width: GLYPH_COLUMN }} className="items-center pt-3.5">
          {spine && spine.edge !== "top" ? <Spine tone={spine.up} position="up" /> : null}
          {spine ? <Spine tone={spine.down} position="down" /> : null}
          <PullRequestStateIcon glyph={glyph} conflict={row.conflict} />
        </View>
        <View className="min-w-0 flex-1 gap-1 border-b border-border-subtle py-3">
          <View className="flex-row items-center gap-1.5">
            <Text className="font-mono text-xs text-foreground-muted">#{row.number}</Text>
            {row.author ? (
              <Text className="min-w-0 shrink text-xs text-foreground-tertiary" numberOfLines={1}>
                @{row.author}
              </Text>
            ) : null}
            {row.stack ? (
              <View className="flex-row items-center gap-0.5">
                <SymbolView name={PULL_REQUEST_STACK_SYMBOL as never} size={11} tintColor={muted} />
                <Text className="font-mono text-2xs text-foreground-muted">
                  {row.stack.position}/{row.stack.size}
                </Text>
              </View>
            ) : null}
            <View className="flex-1" />
            {time ? <Text className="text-2xs text-foreground-tertiary">{time}</Text> : null}
          </View>
          <Text className="text-base leading-5 font-ryco-medium text-foreground" numberOfLines={2}>
            {row.title}
          </Text>
          <View className="flex-row items-center gap-2">
            <View className="min-w-0 flex-1 flex-row items-center gap-1.5">
              <Text
                className={cn(
                  "shrink-0 text-xs font-ryco-bold",
                  readinessTextClass(row.readinessTone),
                )}
                numberOfLines={1}
              >
                {row.readinessLabel}
              </Text>
              {row.labels.map((label) => (
                <PullRequestLabelChip key={label.name} label={label} />
              ))}
              {row.moreLabels > 0 ? (
                <Text className="text-2xs text-foreground-tertiary">+{row.moreLabels}</Text>
              ) : null}
            </View>
            {row.commentsCount > 0 ? (
              <View className="flex-row items-center gap-0.5">
                <SymbolView name="bubble.left" size={11} tintColor={muted} />
                <Text className="font-mono text-2xs text-foreground-muted">
                  {row.commentsCount}
                </Text>
              </View>
            ) : null}
            {row.checkCounts ? <PullRequestCheckRing counts={row.checkCounts} size={15} /> : null}
            {row.review ? <PullRequestReviewMark review={row.review} size={13} /> : null}
            <PullRequestDiffStats additions={row.additions} deletions={row.deletions} />
          </View>
        </View>
      </Pressable>
    </MenuView>
  );
});

const FOOT_TONE: Readonly<Record<StackFootPartTone, string>> = {
  merged: "text-violet-500",
  landable: "text-success",
  blocked: "text-warning",
};

/** The base a stack lands on, closing its spine: "main · 1 merged · #701 can land". */
export function PullRequestStackFoot(props: {
  readonly baseRefName: string;
  readonly parts: ReadonlyArray<{ readonly text: string; readonly tone: StackFootPartTone }>;
}) {
  const border = useThemeColor("--color-border") as string;
  return (
    <View className="flex-row items-center gap-3 px-4 pb-3">
      <View style={{ width: GLYPH_COLUMN, height: 22 }} className="items-center">
        <View
          style={{ width: SPINE_WIDTH, height: 10, backgroundColor: border }}
          pointerEvents="none"
        />
        <View
          style={{ width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: border }}
        />
      </View>
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        <Text className="font-mono text-foreground-secondary">{props.baseRefName}</Text>
        {props.parts.map((part) => (
          <Text key={part.text} className={FOOT_TONE[part.tone]}>
            {` · ${part.text}`}
          </Text>
        ))}
      </Text>
    </View>
  );
}
