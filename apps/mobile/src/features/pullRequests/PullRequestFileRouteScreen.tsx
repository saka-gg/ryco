import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react-native";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { relativePathToRouteSegments, routeFilePathParam } from "@ryco/client-runtime/state/files";
import {
  adjacentFilePath,
  FILE_STATUS_LABEL,
  splitFilePath,
} from "@ryco/client-runtime/state/pull-request-review";
import { resolveChangeRequestPresentationForKind } from "@ryco/shared/sourceControl";
import { EnvironmentId, ProjectId } from "@ryco/contracts/base-schemas";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, useColorScheme, useWindowDimensions, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { LoadingStrip } from "../../components/LoadingStrip";
import { resolveMobileCodeSurface } from "../../lib/appearancePreferences";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  highlightSourceFile,
  type ReviewDiffTheme,
  type ReviewHighlightedToken,
} from "../review/shikiReviewHighlighter";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { parsePullRequestNumberParam } from "./pullRequestDetailModel";
import {
  buildPullRequestFileView,
  formatPullRequestDiffStat,
  pullRequestDiffRowMarker,
  pullRequestDiffRowTokens,
  pullRequestTokenSpans,
  type PullRequestDiffRow,
} from "./pullRequestDiffModel";
import { openPullRequestLink } from "./PullRequestParts";
import {
  usePullRequest,
  usePullRequestCheckout,
  usePullRequestDiff,
  useSourceControlProvider,
} from "./usePullRequestData";

type PullRequestFileRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
  readonly number: string;
  readonly path: string | readonly string[];
}>;

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** Monospace glyph advance as a share of the font size (the file viewer's estimate). */
const MONOSPACE_ADVANCE_RATIO = 0.62;
/** Two line-number columns and the marker. */
const DIFF_GUTTER_WIDTH = 84;

const ROW_BACKGROUND: Readonly<Record<PullRequestDiffRow["kind"], string>> = {
  hunk: "bg-accent-bg",
  context: "",
  addition: "bg-success-bg",
  deletion: "bg-danger",
  notice: "",
};

function RowText(props: {
  readonly text: string;
  readonly tokens: ReadonlyArray<ReviewHighlightedToken> | null;
  readonly color: string;
}) {
  if (props.tokens === null) return <>{props.text}</>;
  return (
    <>
      {pullRequestTokenSpans(props.tokens).map((span) => (
        <Text
          key={span.key}
          style={{
            color: span.color ?? props.color,
            fontStyle: span.italic ? "italic" : "normal",
            fontWeight: span.bold ? "700" : "400",
          }}
        >
          {span.content}
        </Text>
      ))}
    </>
  );
}

interface HighlightedSides {
  readonly source: string;
  readonly theme: ReviewDiffTheme;
  readonly old: ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>;
  readonly new: ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>;
}

/** One file of a pull request: its diff, highlighted, or a plain excerpt when very large. */
export function PullRequestFileRouteScreen(props: PullRequestFileRouteProps) {
  const navigation = useNavigation();
  const environmentIdRaw = firstParam(props.route.params.environmentId);
  const projectIdRaw = firstParam(props.route.params.projectId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const projectId = projectIdRaw ? ProjectId.make(projectIdRaw) : null;
  const number = parsePullRequestNumberParam(props.route.params.number);
  const path = routeFilePathParam(props.route.params.path);
  const checkout = usePullRequestCheckout(environmentId, projectId);
  const provider = useSourceControlProvider(environmentId, checkout.cwd);
  const pullRequest = usePullRequest({ environmentId, cwd: checkout.cwd, number, provider });
  const detail = pullRequest.detail.data;
  const diff = usePullRequestDiff({
    environmentId,
    cwd: checkout.cwd,
    number,
    detail,
    enabled: pullRequest.capabilities.diff,
  });
  const file = path === null ? undefined : diff.files?.find((entry) => entry.path === path);
  // Keyed on the file alone: its object is stable for as long as the patch is.
  const view = useMemo(() => (file === undefined ? null : buildPullRequestFileView(file)), [file]);
  const presentation = view?.presentation ?? null;
  const parsed = view?.rows ?? null;
  const sides = view?.sides ?? null;

  const theme: ReviewDiffTheme = useColorScheme() === "light" ? "light" : "dark";
  const { appearance } = useAppearancePreferences();
  const surface = resolveMobileCodeSurface(appearance.codeFontSize);
  const { width: windowWidth } = useWindowDimensions();
  const foregroundColor = String(useThemeColor("--color-foreground"));
  const [highlight, setHighlight] = useState<HighlightedSides | null>(null);
  const [surfaceHeight, setSurfaceHeight] = useState(0);

  // Plain rows render first; the tokens swap in when both sides resolve. The
  // result carries the patch and theme it was computed from, so a stale one is
  // dropped the same render they change.
  const source = file?.patch ?? null;
  useEffect(() => {
    if (sides === null || path === null || source === null) return;
    let cancelled = false;
    void Promise.all([
      highlightSourceFile({ path, contents: sides.oldLines.join("\n"), theme }),
      highlightSourceFile({ path, contents: sides.newLines.join("\n"), theme }),
    ])
      .then(([oldTokens, newTokens]) => {
        if (!cancelled) setHighlight({ source, theme, old: oldTokens, new: newTokens });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [path, sides, source, theme]);
  const tokens =
    highlight !== null && highlight.source === source && highlight.theme === theme
      ? highlight
      : null;

  useEffect(() => {
    if (path !== null) navigation.setOptions({ title: splitFilePath(path).name });
  }, [navigation, path]);

  if (environmentId === null || projectId === null || number === null || path === null) {
    return (
      <View className="flex-1 bg-screen px-5 py-16">
        <EmptyState variant="plain" title="File unavailable" detail="This link is not complete." />
      </View>
    );
  }

  const hostName = resolveChangeRequestPresentationForKind(
    detail?.provider ?? "github",
  ).providerName;
  const filesUrl = detail?.url ? `${detail.url.replace(/\/+$/u, "")}/files` : null;
  const paths = diff.files?.map((entry) => entry.path) ?? [];
  const previous = adjacentFilePath(paths, path, -1);
  const next = adjacentFilePath(paths, path, 1);
  const openSibling = (sibling: string) =>
    navigation.setParams({ path: [...relativePathToRouteSegments(sibling)] });

  const contentWidth = Math.max(
    windowWidth,
    DIFF_GUTTER_WIDTH +
      surface.codePadding * 2 +
      Math.ceil((parsed?.maxLineLength ?? 0) * surface.fontSize * MONOSPACE_ADVANCE_RATIO),
  );

  const renderRow = ({ item, index }: LegendListRenderItemProps<PullRequestDiffRow>) => {
    const rowTokens =
      tokens === null
        ? null
        : pullRequestDiffRowTokens(sides?.sources[index], tokens.old, tokens.new);
    const muted = item.kind === "hunk" || item.kind === "notice";
    return (
      <View
        className={cn("flex-row", ROW_BACKGROUND[item.kind])}
        style={{ width: contentWidth, minHeight: surface.rowHeight }}
      >
        <Text
          className="text-right font-mono text-foreground-tertiary"
          style={{ width: 34, fontSize: surface.lineNumberFontSize, lineHeight: surface.rowHeight }}
        >
          {item.oldLine ?? ""}
        </Text>
        <Text
          className="text-right font-mono text-foreground-tertiary"
          style={{ width: 34, fontSize: surface.lineNumberFontSize, lineHeight: surface.rowHeight }}
        >
          {item.newLine ?? ""}
        </Text>
        <Text
          className="text-center font-mono text-foreground-muted"
          style={{ width: 16, fontSize: surface.fontSize, lineHeight: surface.rowHeight }}
        >
          {pullRequestDiffRowMarker(item.kind)}
        </Text>
        <Text
          className={cn("flex-1 font-mono", muted ? "text-foreground-muted" : "text-foreground")}
          style={{
            paddingHorizontal: surface.codePadding,
            fontSize: surface.fontSize,
            lineHeight: surface.rowHeight,
          }}
          numberOfLines={1}
          // Clipped rather than ellipsized: a "…" in the middle of code would read as code.
          ellipsizeMode="clip"
          selectable
        >
          <RowText text={item.text} tokens={rowTokens} color={foregroundColor} />
        </Text>
      </View>
    );
  };

  return (
    <View className="flex-1 bg-screen">
      <View className="gap-1 border-b border-border px-4 py-2.5">
        <Text className="font-mono text-xs text-foreground" numberOfLines={2} selectable>
          {path}
        </Text>
        <View className="flex-row items-center gap-3">
          {file ? (
            <Text className="text-2xs text-foreground-muted">
              {FILE_STATUS_LABEL[file.status]}
              {file.previousPath ? ` from ${file.previousPath}` : ""}
              {file.binary ? "" : ` · ${formatPullRequestDiffStat(file.additions, file.deletions)}`}
            </Text>
          ) : null}
          <View className="ml-auto flex-row gap-4">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Previous file"
              disabled={previous === null}
              onPress={() => previous !== null && openSibling(previous)}
              className="active:opacity-70 disabled:opacity-30"
            >
              <Text className="text-xs font-ryco-bold text-primary">Previous</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Next file"
              disabled={next === null}
              onPress={() => next !== null && openSibling(next)}
              className="active:opacity-70 disabled:opacity-30"
            >
              <Text className="text-xs font-ryco-bold text-primary">Next</Text>
            </Pressable>
          </View>
        </View>
        {presentation?.kind === "excerpt" && parsed?.truncated ? (
          <Pressable
            accessibilityRole="link"
            disabled={filesUrl === null}
            onPress={() => openPullRequestLink(filesUrl)}
          >
            <Text className="text-2xs text-foreground-muted">
              A very large change: showing the first {parsed.rows.length} of {parsed.totalRows}{" "}
              lines, without colours.
              {filesUrl ? (
                <Text className="font-ryco-bold text-primary"> Open on {hostName}</Text>
              ) : null}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {diff.status === "loading" || diff.status === "waiting" ? <LoadingStrip /> : null}
      {diff.status === "oversized" ? (
        <EmptyState
          variant="plain"
          title="Too large to show"
          detail={`${hostName} refused to send this pull request's diff.`}
          {...(filesUrl
            ? { actionLabel: `Open on ${hostName}`, onAction: () => openPullRequestLink(filesUrl) }
            : {})}
        />
      ) : diff.status === "error" ? (
        <EmptyState variant="plain" title="Diff unavailable" detail={diff.error ?? "Try again."} />
      ) : diff.status === "ready" && file === undefined ? (
        <EmptyState
          variant="plain"
          title="Not in this pull request"
          detail="The file is not part of the pull request's current diff."
        />
      ) : presentation?.kind === "binary" ? (
        <EmptyState variant="plain" title="Binary file" detail="There is no text diff to show." />
      ) : parsed !== null && parsed.rows.length === 0 ? (
        <EmptyState
          variant="plain"
          title="No changes to show"
          detail="Only the file's name or mode changed."
        />
      ) : parsed !== null ? (
        <View
          className="flex-1"
          onLayout={(event) => setSurfaceHeight(event.nativeEvent.layout.height)}
        >
          {surfaceHeight > 0 ? (
            <ScrollView
              horizontal
              className="flex-1"
              contentContainerStyle={{ minWidth: "100%" }}
              showsHorizontalScrollIndicator
            >
              {/*
                The list's height is measured rather than "100%": inside a
                horizontal ScrollView the content container's own height is
                content-driven, so a percentage would resolve against nothing.
              */}
              <LegendList
                data={parsed.rows}
                renderItem={renderRow}
                keyExtractor={(_row, index) => String(index)}
                // The rows keep their identity when the tokens resolve; without
                // this the recycler never re-renders visible rows.
                extraData={tokens}
                recycleItems
                estimatedItemSize={surface.rowHeight}
                contentInsetAdjustmentBehavior="never"
                contentContainerStyle={{ paddingVertical: 8 }}
                style={{ width: contentWidth, height: surfaceHeight }}
              />
            </ScrollView>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
