import { StackActions, useNavigation } from "@react-navigation/native";
import {
  LegendList,
  type LegendListRef,
  type LegendListRenderItemProps,
} from "@legendapp/list/react-native";
import { Image } from "expo-image";
import * as Linking from "expo-linking";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";
import { SvgXml } from "react-native-svg";
import { WebView } from "react-native-webview";

import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  classifyWorkspaceFilePath,
  type WorkspaceFileUnavailableReason,
  type WorkspaceFileViewMode,
  type WorkspaceFileViewModeOverride,
} from "@ryco/client-runtime/state/files";
import { EnvironmentId, ThreadId } from "@ryco/contracts";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { NavigationHeaderButton } from "../../components/NavigationHeaderButton";
import { CopyTextButton } from "../../components/CopyTextButton";
import { EmptyState } from "../../components/EmptyState";
import { cn } from "../../lib/cn";
import {
  resolveMobileCodeSurface,
  resolveNativeMarkdownTypography,
} from "../../lib/appearancePreferences";
import { useFontFamily } from "../../lib/useFontFamily";
import { useThemeColor } from "../../lib/useThemeColor";
import { useProjectReadFile, useProjectReadFileBinary } from "../../rpc/useProjectFiles";
import {
  useWsConnectionStatusForEnvironment,
  wsUiStateForEnvironment,
} from "../../rpc/wsConnectionState";
import { useHomeWorkspaceData } from "../../state/homeData";
import {
  selectEnvironmentState,
  selectProjectByRef,
  selectThreadByRef,
  useStore,
} from "../../state/threadsRuntime";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
  type NativeMarkdownTextStyle,
} from "../../native/SelectableMarkdownText";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import {
  highlightSourceFile,
  type ReviewDiffTheme,
  type ReviewHighlightedToken,
} from "../review/shikiReviewHighlighter";
import { findThreadWorktree } from "../threads/threadHeaderModel";
import { buildSandboxedHtmlDocument, isAllowedHtmlPreviewNavigation } from "./htmlPreview";
import {
  buildThreadFileScreenModel,
  formatWorkspaceFileSize,
  shouldReadWorkspaceFile,
  shouldReadWorkspaceFileAsBinary,
  type ThreadFileRenderableKind,
  type ThreadFileScreenBody,
} from "./threadFileModel";
import { useThreadWorkspaceRoot } from "./useThreadWorkspaceRoot";

// One file, read-only. The states, the mode default and the line split come from
// threadFileModel; this file owns the renderings — a virtualized, highlighted
// source surface, the native Markdown preview, and the three M2 previews (raster
// image, SVG, sandboxed HTML) — and nothing else.
//
// None of these renderings fetches anything. The image bytes arrive base64 over
// the socket and become a data URI; the HTML document is handed to the WebView as
// a string inside the wrapper htmlPreview.ts builds. No node URL is ever
// constructed, and nothing is allowed to reach the disk.

/** Shiki's FontStyle bitmask; only italic and bold have a React Native analogue. */
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;

/**
 * Monospace advance as a fraction of the font size, for sizing the horizontal
 * scroll surface. Measuring the real advance would cost a layout pass per file
 * and the only consequence of being a little generous is trailing whitespace at
 * the far right of a long line.
 */
const MONOSPACE_ADVANCE_RATIO = 0.62;

const UNAVAILABLE_COPY: Record<
  WorkspaceFileUnavailableReason,
  { readonly title: string; readonly detail: string }
> = {
  oversized: {
    // The exact ceiling differs by read (512 KB of text, 4 MB of image bytes)
    // and the node's own message under this copy always names it.
    title: "Too large to preview",
    detail: "This file is past the node's preview limit.",
  },
  binary: {
    title: "Not a text file",
    detail: "The node reports this file as binary, so there is nothing to show.",
  },
  "unsupported-image": {
    title: "Unrecognized image",
    detail: "The node could not identify these bytes as an image format it can send.",
  },
  encoding: {
    title: "Not UTF-8",
    detail: "Only UTF-8 text files can be previewed.",
  },
  "not-file": {
    title: "Not a regular file",
    detail: "Only regular files can be previewed.",
  },
  missing: {
    title: "File not found",
    detail: "It may have moved or been deleted since this listing was taken.",
  },
  error: {
    title: "Could not read this file",
    detail: "The node refused the read.",
  },
};

function ModeToggle(props: {
  readonly mode: WorkspaceFileViewMode;
  readonly iconColor: string;
  readonly activeIconColor: string;
  readonly onSelect: (mode: WorkspaceFileViewMode) => void;
}) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel="File view"
      className="flex-row items-center rounded-full bg-subtle p-0.5"
    >
      {(["preview", "source"] as const).map((mode) => {
        const selected = props.mode === mode;
        return (
          <Pressable
            key={mode}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            accessibilityLabel={mode === "preview" ? "Preview" : "Source"}
            onPress={() => props.onSelect(mode)}
            className={cn(
              "h-8 w-9 items-center justify-center rounded-full active:opacity-70",
              selected ? "bg-card" : "bg-transparent",
            )}
          >
            <SymbolView
              name={mode === "preview" ? "eye" : "doc.text"}
              size={14}
              tintColor={selected ? props.activeIconColor : props.iconColor}
              type="monochrome"
            />
          </Pressable>
        );
      })}
    </View>
  );
}

function SourceLineText(props: {
  readonly text: string;
  readonly tokens: ReadonlyArray<ReviewHighlightedToken> | null;
  readonly color: string;
}) {
  if (props.tokens === null) return <>{props.text}</>;
  // Keyed by the token's character offset in the line rather than by its index:
  // re-tokenizing can split a line differently, and the offset stays the same
  // piece of text where the index does not.
  let offset = 0;
  return (
    <>
      {props.tokens.map((token) => {
        const key = offset;
        offset += token.content.length;
        return (
          <Text
            key={key}
            style={{
              color: token.color ?? props.color,
              fontStyle: (token.fontStyle ?? 0) & FONT_STYLE_ITALIC ? "italic" : "normal",
              fontWeight: (token.fontStyle ?? 0) & FONT_STYLE_BOLD ? "700" : "400",
            }}
          >
            {token.content}
          </Text>
        );
      })}
    </>
  );
}

/**
 * Virtualized source view.
 *
 * A 512 KB file is up to half a million characters, so the lines are
 * virtualized vertically and the whole list rides inside ONE horizontal
 * ScrollView — a per-row scroll view would defeat both recycling and a shared
 * horizontal offset. The surface width is estimated from the longest line
 * because measuring every line would cost more than the slack it saves.
 */
function SourceFileView(props: {
  readonly path: string;
  readonly lines: readonly string[];
  readonly initialLineIndex: number | null;
  readonly maxLineLength: number;
  readonly highlightable: boolean;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
}) {
  const listRef = useRef<LegendListRef>(null);
  const [highlight, setHighlight] = useState<{
    readonly contents: string;
    readonly theme: ReviewDiffTheme;
    readonly tokenLines: ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>;
  } | null>(null);
  const [highlightFailed, setHighlightFailed] = useState(false);
  const [surfaceHeight, setSurfaceHeight] = useState(0);
  const theme: ReviewDiffTheme = useColorScheme() === "light" ? "light" : "dark";
  const { appearance } = useAppearancePreferences();
  const surface = useMemo(
    () => resolveMobileCodeSurface(appearance.codeFontSize),
    [appearance.codeFontSize],
  );
  const { width: windowWidth } = useWindowDimensions();
  const foregroundColor = String(useThemeColor("--color-foreground"));

  const contents = useMemo(() => props.lines.join("\n"), [props.lines]);

  // Plain text renders first and the tokens swap in when they resolve, so a big
  // file is readable long before it is colored. The resolved tokens carry the
  // contents and theme they were computed from, and the derivation below drops
  // them the SAME render those inputs change — an effect-time reset would leave
  // one frame showing the old file's text through the new file's lines.
  useEffect(() => {
    setHighlightFailed(false);
    if (!props.highlightable) return;
    let cancelled = false;
    void highlightSourceFile({ path: props.path, contents, theme })
      .then((resolved) => {
        if (!cancelled) setHighlight({ contents, theme, tokenLines: resolved });
      })
      .catch(() => {
        if (!cancelled) setHighlightFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [contents, props.highlightable, props.path, theme]);
  const tokenLines =
    highlight !== null && highlight.contents === contents && highlight.theme === theme
      ? highlight.tokenLines
      : null;

  // Anchoring waits for the measured height, because the list does not exist
  // before it, and runs once per file+line so a rotation does not yank the
  // reader back to the deep link.
  const anchoredRef = useRef<string | null>(null);
  const initialLineIndex = props.initialLineIndex;
  useEffect(() => {
    if (initialLineIndex === null || surfaceHeight === 0) return;
    const anchorKey = `${props.path}:${initialLineIndex}`;
    if (anchoredRef.current === anchorKey) return;
    anchoredRef.current = anchorKey;
    // One frame late: the list has to have laid out before an index means a
    // position.
    const frame = requestAnimationFrame(() => {
      void listRef.current?.scrollToIndex({ index: initialLineIndex, viewPosition: 0.3 });
    });
    return () => cancelAnimationFrame(frame);
  }, [initialLineIndex, props.path, surfaceHeight]);

  const contentWidth = Math.max(
    windowWidth,
    surface.gutterWidth +
      surface.codePadding * 2 +
      Math.ceil(props.maxLineLength * surface.fontSize * MONOSPACE_ADVANCE_RATIO),
  );

  const renderLine = ({ item, index }: LegendListRenderItemProps<string>) => (
    <View
      className={cn("flex-row", index === initialLineIndex && "bg-primary/10")}
      style={{ width: contentWidth, minHeight: surface.rowHeight }}
    >
      <Text
        className="text-right font-mono text-foreground-tertiary"
        style={{
          width: surface.gutterWidth,
          paddingRight: surface.codePadding,
          fontSize: surface.lineNumberFontSize,
          lineHeight: surface.rowHeight,
        }}
      >
        {index + 1}
      </Text>
      <Text
        className="flex-1 font-mono text-foreground"
        style={{
          paddingHorizontal: surface.codePadding,
          fontSize: surface.fontSize,
          lineHeight: surface.rowHeight,
        }}
        numberOfLines={1}
        // Clipped rather than ellipsized: the surface width is an estimate, and
        // a "…" in the middle of code would read as part of the file.
        ellipsizeMode="clip"
        selectable
      >
        <SourceLineText text={item} tokens={tokenLines?.[index] ?? null} color={foregroundColor} />
      </Text>
    </View>
  );

  return (
    <View className="flex-1">
      {highlightFailed || !props.highlightable ? (
        <View className="items-start px-4 py-1.5">
          <Text className="rounded-full bg-subtle px-2 py-0.5 text-2xs font-ryco-medium text-foreground-tertiary">
            Plain text
          </Text>
        </View>
      ) : null}
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
              content-driven, so a percentage would resolve against nothing and
              collapse the list to zero.
            */}
            <LegendList
              ref={listRef}
              data={props.lines}
              renderItem={renderLine}
              keyExtractor={(_line, index) => String(index)}
              // The lines array keeps its identity when the tokens resolve, so
              // without this the recycler never re-renders visible rows and the
              // highlight silently never appears (caught in simulator QA).
              extraData={tokenLines}
              recycleItems
              estimatedItemSize={surface.rowHeight}
              refreshing={props.refreshing}
              onRefresh={props.onRefresh}
              contentInsetAdjustmentBehavior="never"
              contentContainerStyle={{ paddingVertical: 8 }}
              style={{ width: contentWidth, height: surfaceHeight }}
            />
          </ScrollView>
        ) : null}
      </View>
    </View>
  );
}

function MarkdownFileView(props: {
  readonly contents: string;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
}) {
  const bodyText = useScaledTextRole("body");
  const typography = resolveNativeMarkdownTypography(bodyText.fontSize);
  const regularFont = useFontFamily("regular");
  const boldFont = useFontFamily("bold");
  const markdownStyle: NativeMarkdownTextStyle = {
    color: String(useThemeColor("--color-md-body")),
    strongColor: String(useThemeColor("--color-md-strong")),
    mutedColor: String(useThemeColor("--color-foreground-muted")),
    linkColor: String(useThemeColor("--color-md-link")),
    inlineCodeColor: String(useThemeColor("--color-md-code-text")),
    codeColor: String(useThemeColor("--color-md-code-text")),
    codeBackgroundColor: String(useThemeColor("--color-md-code-bg")),
    codeBlockBackgroundColor: String(useThemeColor("--color-card-alt")),
    fileTextColor: String(useThemeColor("--color-md-link")),
    skillTextColor: String(useThemeColor("--color-inline-skill-foreground")),
    quoteMarkerColor: String(useThemeColor("--color-md-blockquote-border")),
    dividerColor: String(useThemeColor("--color-md-hr")),
    fontSize: typography.fontSize,
    lineHeight: typography.lineHeight,
    fontFamily: regularFont,
    headingFontFamily: boldFont,
    boldFontFamily: boldFont,
    headingFontSizes: typography.headingFontSizes,
  };

  return (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior="never"
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40, paddingTop: 8 }}
      refreshControl={<RefreshControl refreshing={props.refreshing} onRefresh={props.onRefresh} />}
    >
      <SelectableMarkdownText
        markdown={props.contents}
        textStyle={markdownStyle}
        preserveSoftBreaks
        marginTop={0}
        marginBottom={0}
        onLinkPress={(href) => {
          // Only absolute web links leave the app. A relative link points into
          // the workspace, and resolving one would be a navigation this
          // read-only preview has deliberately not built.
          if (!/^https?:\/\//iu.test(href)) return;
          void Linking.openURL(href).catch(() => undefined);
        }}
      />
    </ScrollView>
  );
}

/**
 * Raster preview.
 *
 * `cachePolicy="none"` is load-bearing, not a performance knob: expo-image
 * writes to a disk cache by default, and node-owned bytes must not outlive the
 * process. The decoder is also the last check on what the node sent — a failure
 * here is reported up so the screen can say so instead of showing a blank box.
 */
function RasterImageView(props: {
  readonly dataUri: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly basename: string;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly onRenderFailure: () => void;
}) {
  const [loaded, setLoaded] = useState(false);

  return (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior="never"
      contentContainerStyle={{ flexGrow: 1 }}
      refreshControl={<RefreshControl refreshing={props.refreshing} onRefresh={props.onRefresh} />}
    >
      <View className="flex-1 items-center justify-center px-4 py-6">
        <Image
          source={{ uri: props.dataUri }}
          accessibilityLabel={props.basename}
          style={{ width: "100%", flex: 1, minHeight: 160 }}
          contentFit="contain"
          cachePolicy="none"
          onLoad={() => setLoaded(true)}
          onError={props.onRenderFailure}
        />
        {loaded ? null : (
          <View className="absolute">
            <ActivityIndicator size="small" />
          </View>
        )}
      </View>
      <Text className="px-4 pb-6 text-center font-mono text-2xs text-foreground-tertiary">
        {`${props.mimeType} · ${formatWorkspaceFileSize(props.sizeBytes)}`}
      </Text>
    </ScrollView>
  );
}

/**
 * Vector preview.
 *
 * `SvgXml` parses the document itself and never runs script, so the markup is
 * safe to hand over whole. It reports a parse failure from inside its own
 * render, which is why the report is deferred: React refuses a state update to
 * another component mid-render.
 */
function SvgFileView(props: {
  readonly markup: string;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly onRenderFailure: () => void;
}) {
  const onRenderFailure = props.onRenderFailure;
  const reportFailure = useCallback(() => {
    queueMicrotask(onRenderFailure);
  }, [onRenderFailure]);

  return (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior="never"
      contentContainerStyle={{ flexGrow: 1 }}
      refreshControl={<RefreshControl refreshing={props.refreshing} onRefresh={props.onRefresh} />}
    >
      <View className="flex-1 items-center justify-center px-4 py-6">
        <SvgXml xml={props.markup} width="100%" height="100%" onError={reportFailure} />
      </View>
    </ScrollView>
  );
}

/**
 * HTML preview.
 *
 * Everything that makes this safe is in the document htmlPreview.ts builds; the
 * props here are the second fence. JavaScript is off at the engine level, the
 * WebView keeps no persistent store, and any load that is not the wrapper's own
 * `about:` load is refused rather than handed to the system browser.
 */
function HtmlFileView(props: { readonly html: string; readonly onRenderFailure: () => void }) {
  const wrapperDocument = useMemo(() => buildSandboxedHtmlDocument(props.html), [props.html]);

  return (
    <View className="flex-1">
      {/*
        Said out loud, because a page that looks broken here may simply be a page
        whose scripts and remote assets were denied — and because the user should
        know what this preview will and will not do with a file they did not read.
      */}
      <View className="items-start px-4 py-1.5">
        <Text className="rounded-full bg-subtle px-2 py-0.5 text-2xs font-ryco-medium text-foreground-tertiary">
          Sandboxed · no scripts, no network
        </Text>
      </View>
      <WebView
        source={{ html: wrapperDocument }}
        originWhitelist={["about:*", "data:*"]}
        javaScriptEnabled={false}
        incognito
        cacheEnabled={false}
        domStorageEnabled={false}
        allowsInlineMediaPlayback={false}
        allowFileAccess={false}
        setSupportMultipleWindows={false}
        onShouldStartLoadWithRequest={(request) => isAllowedHtmlPreviewNavigation(request.url)}
        onError={props.onRenderFailure}
        onHttpError={props.onRenderFailure}
        style={{ flex: 1, backgroundColor: "transparent" }}
      />
    </View>
  );
}

const RENDER_FAILURE_COPY: Record<ThreadFileRenderableKind, string> = {
  image: "Could not render this image",
  svg: "Could not render this image",
  html: "Could not render this page",
};

function BodyEmptyState(props: {
  readonly title: string;
  readonly detail: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}) {
  return (
    <View className="px-4 py-16">
      <EmptyState
        variant="plain"
        title={props.title}
        detail={props.detail}
        actionLabel={props.actionLabel}
        onAction={props.onAction}
      />
    </View>
  );
}

export function ThreadFileScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly path: string | null;
  readonly line: number | null;
}) {
  const { environmentId, threadId, path, line } = props;
  const navigation = useNavigation();
  const iconColor = String(useThemeColor("--color-icon"));
  const mutedIconColor = String(useThemeColor("--color-icon-muted"));

  useEffect(() => {
    useStore.getState().setActiveEnvironmentId(environmentId);
  }, [environmentId]);

  const thread = useStore((state) =>
    selectThreadByRef(state, scopeThreadRef(environmentId, threadId)),
  );
  const project = useStore((state) =>
    thread
      ? (selectProjectByRef(state, scopeProjectRef(environmentId, thread.projectId)) ?? null)
      : null,
  );
  // This route's environment, not the active one: the mount effect above flips
  // the active id only after the first render, and a cross-environment deep link
  // must not read the OLD node's completed bootstrap as this node's verdict.
  const bootstrapComplete = useStore(
    (state) => selectEnvironmentState(state, environmentId).bootstrapComplete,
  );
  const { worktrees } = useHomeWorkspaceData();
  const worktree = useMemo(
    () => (thread ? findThreadWorktree(thread, worktrees) : null),
    [thread, worktrees],
  );
  const workspaceRoot = useThreadWorkspaceRoot({ thread, worktree, project });
  // This screen renders one environment's content; its connection banner and
  // gating must track THAT node's socket, not whichever socket wrote the
  // global status last.
  const connectionUiState = wsUiStateForEnvironment(
    useWsConnectionStatusForEnvironment(environmentId),
  );

  const [viewModeOverride, setViewModeOverride] = useState<WorkspaceFileViewModeOverride | null>(
    null,
  );

  // A known binary is decided from the path alone and never costs the node a
  // read; every other kind reads over exactly one of the two RPCs, never both.
  const kind = path === null ? null : classifyWorkspaceFilePath(path);
  const readsBinary = kind !== null && shouldReadWorkspaceFileAsBinary(kind);
  const read = useProjectReadFile({
    environmentId,
    cwd: workspaceRoot,
    relativePath: path,
    enabled: kind !== null && shouldReadWorkspaceFile(kind) && !readsBinary,
  });
  const binaryRead = useProjectReadFileBinary({
    environmentId,
    cwd: workspaceRoot,
    relativePath: path,
    enabled: readsBinary,
  });

  // A renderer that could not draw what the node sent. Scoped to the file it
  // happened on so the next one starts clean, and cleared on a refresh so
  // "Try again" is not permanently poisoned by one bad frame.
  const [renderFailedPath, setRenderFailedPath] = useState<string | null>(null);
  const reportRenderFailure = useCallback(() => {
    if (path !== null) setRenderFailedPath(path);
  }, [path]);

  const markdownRendererAvailable = hasNativeSelectableMarkdownText();
  const model = useMemo(
    () =>
      buildThreadFileScreenModel({
        path,
        line,
        bootstrapComplete,
        thread: thread ?? null,
        project,
        worktree,
        readState: { data: read.data, error: read.error, isLoading: read.isLoading },
        binaryReadState: {
          data: binaryRead.data,
          error: binaryRead.error,
          isLoading: binaryRead.isLoading,
        },
        connectionUiState,
        markdownRendererAvailable,
        viewModeOverride,
        renderFailedPath,
      }),
    [
      binaryRead.data,
      binaryRead.error,
      binaryRead.isLoading,
      bootstrapComplete,
      connectionUiState,
      line,
      markdownRendererAvailable,
      path,
      project,
      read.data,
      read.error,
      read.isLoading,
      renderFailedPath,
      thread,
      viewModeOverride,
      worktree,
    ],
  );

  const [refreshing, setRefreshing] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const activeRefetch = readsBinary ? binaryRead.refetch : read.refetch;
  const refresh = useCallback(() => {
    setRefreshing(true);
    // A retry is also the user's way out of a render failure: re-reading may
    // hand the renderer a file that has since been fixed on the node.
    setRenderFailedPath(null);
    void activeRefetch().finally(() => {
      if (mountedRef.current) setRefreshing(false);
    });
  }, [activeRefetch]);

  const goToFiles = useCallback(
    () => navigation.dispatch(StackActions.replace("ThreadFiles", { environmentId, threadId })),
    [environmentId, navigation, threadId],
  );

  const selectMode = useCallback(
    (mode: WorkspaceFileViewMode) => {
      if (path === null) return;
      setViewModeOverride({ path, mode });
    },
    [path],
  );
  const viewSource = useCallback(() => selectMode("source"), [selectMode]);

  const toggle = model.header.toggle;
  const headerTitle = model.header.title;
  const pathLabel = model.header.pathLabel;
  useLayoutEffect(() => {
    navigation.setOptions({
      title: headerTitle,
      headerRight: () => (
        <View className="flex-row items-center gap-2">
          {toggle.visible ? (
            <ModeToggle
              mode={toggle.mode}
              iconColor={mutedIconColor}
              activeIconColor={iconColor}
              onSelect={selectMode}
            />
          ) : null}
          <CopyTextButton
            accessibilityLabel="Copy file path"
            text={pathLabel}
            tintColor={iconColor}
          />
        </View>
      ),
      // A deep link straight to a file has nothing beneath it; the browser is
      // where its "back" belongs.
      headerLeft: () => (
        <NavigationHeaderButton
          action="back"
          accessibilityLabel="Back to files"
          onPress={() => (navigation.canGoBack() ? navigation.goBack() : goToFiles())}
        />
      ),
    });
  }, [
    goToFiles,
    headerTitle,
    iconColor,
    mutedIconColor,
    navigation,
    pathLabel,
    selectMode,
    toggle.mode,
    toggle.visible,
  ]);

  return (
    <View className="flex-1 bg-screen">
      {pathLabel.length > 0 ? (
        <View className="border-b border-border-subtle px-4 py-2">
          <Text
            className="font-mono text-2xs text-foreground-tertiary"
            numberOfLines={1}
            ellipsizeMode="middle"
            selectable
          >
            {pathLabel}
          </Text>
        </View>
      ) : null}
      {model.offlineNotice && model.body.state !== "offline-empty" ? (
        <View
          accessibilityRole="alert"
          className="mx-4 mt-2 flex-row items-center gap-2.5 rounded-2xl border border-border bg-card px-3.5 py-2.5"
        >
          <SymbolView name="wifi.slash" size={14} tintColor={mutedIconColor} type="monochrome" />
          <Text className="flex-1 font-sans text-xs text-foreground-muted">
            Showing the last read from this node.
          </Text>
        </View>
      ) : null}
      <FileBody
        body={model.body}
        path={path}
        basename={headerTitle}
        refreshing={refreshing}
        onRefresh={refresh}
        onOpenFiles={goToFiles}
        onRenderFailure={reportRenderFailure}
        onViewSource={viewSource}
      />
    </View>
  );
}

function FileBody(props: {
  readonly body: ThreadFileScreenBody;
  readonly path: string | null;
  readonly basename: string;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly onOpenFiles: () => void;
  readonly onRenderFailure: () => void;
  readonly onViewSource: () => void;
}) {
  const { body } = props;

  switch (body.state) {
    case "invalid-path":
      return (
        <BodyEmptyState
          title="Unreadable path"
          detail="That link does not point at a file inside this workspace."
          actionLabel="Browse files"
          onAction={props.onOpenFiles}
        />
      );
    case "no-workspace":
      return (
        <BodyEmptyState
          title="No workspace"
          detail="This task has no checkout on the node, so the file cannot be read."
        />
      );
    case "loading":
      return (
        <View className="flex-1 items-center justify-center py-16">
          <ActivityIndicator size="small" />
        </View>
      );
    case "offline-empty":
      return (
        <BodyEmptyState
          title="Node unreachable"
          detail="This file is not cached on the device. Try again once the node is back."
          actionLabel="Try again"
          onAction={props.onRefresh}
        />
      );
    case "unsupported":
      return (
        <BodyEmptyState
          title="Not a text file"
          detail="Ryco previews text, Markdown, images and HTML. Open this one on the node."
        />
      );
    case "unavailable":
      return (
        <View>
          <BodyEmptyState
            title={UNAVAILABLE_COPY[body.reason].title}
            detail={UNAVAILABLE_COPY[body.reason].detail}
            actionLabel="Try again"
            onAction={props.onRefresh}
          />
          <Text className="px-8 text-center font-mono text-2xs text-foreground-tertiary">
            {body.detail}
          </Text>
        </View>
      );
    case "empty-file":
      return <BodyEmptyState title="Empty file" detail="This file has no contents." />;
    case "render-failed":
      return (
        <BodyEmptyState
          title={RENDER_FAILURE_COPY[body.kind]}
          detail={
            body.canViewSource
              ? "The file arrived, but nothing could be drawn from it."
              : "The file arrived, but the image decoder rejected it."
          }
          actionLabel={body.canViewSource ? "View source" : "Try again"}
          onAction={body.canViewSource ? props.onViewSource : props.onRefresh}
        />
      );
    case "image":
      return (
        <RasterImageView
          dataUri={body.dataUri}
          mimeType={body.mimeType}
          sizeBytes={body.sizeBytes}
          basename={props.basename}
          refreshing={props.refreshing}
          onRefresh={props.onRefresh}
          onRenderFailure={props.onRenderFailure}
        />
      );
    case "svg":
      return (
        <SvgFileView
          markup={body.markup}
          refreshing={props.refreshing}
          onRefresh={props.onRefresh}
          onRenderFailure={props.onRenderFailure}
        />
      );
    case "html":
      return <HtmlFileView html={body.html} onRenderFailure={props.onRenderFailure} />;
    case "markdown":
      return (
        <MarkdownFileView
          contents={body.contents}
          refreshing={props.refreshing}
          onRefresh={props.onRefresh}
        />
      );
    case "source":
      return (
        <SourceFileView
          path={props.path ?? ""}
          lines={body.lines}
          initialLineIndex={body.initialLineIndex}
          maxLineLength={body.maxLineLength}
          highlightable={body.highlightable}
          refreshing={props.refreshing}
          onRefresh={props.onRefresh}
        />
      );
  }
}
