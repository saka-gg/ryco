import type { SourceControlLabel } from "@ryco/contracts";
import { View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  pullRequestLabelColor,
  pullRequestReviewGlyph,
  type PullRequestGlyphTone,
  type PullRequestStateGlyph,
} from "./pullRequestGlyphModel";
import type { PullRequestRowReview } from "./pullRequestListModel";

// Small presentational pieces of the PRs tab and the pull request screen.

/** Merged pull requests read violet on every host, in both themes. */
export const PULL_REQUEST_MERGED_COLOR = "#8b5cf6";

export function usePullRequestToneColor(tone: PullRequestGlyphTone): string {
  const success = useThemeColor("--color-success") as string;
  const muted = useThemeColor("--color-icon-muted") as string;
  const danger = useThemeColor("--color-danger-foreground") as string;
  switch (tone) {
    case "open":
      return success;
    case "draft":
      return muted;
    case "merged":
      return PULL_REQUEST_MERGED_COLOR;
    case "closed":
      return danger;
  }
}

export function PullRequestStateIcon(props: {
  readonly glyph: PullRequestStateGlyph;
  readonly size?: number;
  /** A conflict with the base: a small warning mark on the glyph's corner. */
  readonly conflict?: boolean;
}) {
  const color = usePullRequestToneColor(props.glyph.tone);
  const danger = useThemeColor("--color-danger-foreground") as string;
  const size = props.size ?? 20;
  return (
    <View
      accessible
      accessibilityLabel={
        props.conflict ? `${props.glyph.label}, has conflicts` : props.glyph.label
      }
      style={{ width: size, height: size }}
    >
      <SymbolView name={props.glyph.symbol as never} size={size} tintColor={color} />
      {props.conflict ? (
        <View pointerEvents="none" className="absolute -bottom-1 -right-1 rounded-full bg-screen">
          <SymbolView name="exclamationmark.triangle.fill" size={11} tintColor={danger} />
        </View>
      ) : null}
    </View>
  );
}

export function PullRequestReviewMark(props: {
  readonly review: PullRequestRowReview;
  readonly size?: number;
}) {
  const glyph = pullRequestReviewGlyph(props.review);
  const success = useThemeColor("--color-success") as string;
  const warning = useThemeColor("--color-warning") as string;
  const muted = useThemeColor("--color-icon-muted") as string;
  const color = glyph.tone === "success" ? success : glyph.tone === "warning" ? warning : muted;
  return (
    <View accessible accessibilityLabel={glyph.label}>
      <SymbolView name={glyph.symbol as never} size={props.size ?? 14} tintColor={color} />
    </View>
  );
}

export function PullRequestDiffStats(props: {
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly size?: "xs" | "2xs";
}) {
  if (props.additions === null && props.deletions === null) return null;
  const text = props.size === "xs" ? "text-xs" : "text-2xs";
  return (
    <View
      accessible
      accessibilityLabel={`${props.additions ?? 0} additions, ${props.deletions ?? 0} deletions`}
      className="shrink-0 flex-row items-center gap-1.5"
    >
      <Text className={cn(text, "font-mono text-success")}>
        +{(props.additions ?? 0).toLocaleString()}
      </Text>
      <Text className={cn(text, "font-mono text-danger-foreground")}>
        −{(props.deletions ?? 0).toLocaleString()}
      </Text>
    </View>
  );
}

export function PullRequestLabelChip(props: { readonly label: SourceControlLabel }) {
  const color = pullRequestLabelColor(props.label.color);
  return (
    <View
      className="min-w-0 shrink flex-row items-center gap-1 rounded-md bg-subtle px-1.5 py-0.5"
      style={{ maxWidth: 150, ...(color ? { backgroundColor: `${color}26` } : {}) }}
    >
      {color ? (
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
      ) : null}
      <Text
        className="shrink text-2xs font-ryco-medium text-foreground-secondary"
        numberOfLines={1}
      >
        {props.label.name}
      </Text>
    </View>
  );
}
