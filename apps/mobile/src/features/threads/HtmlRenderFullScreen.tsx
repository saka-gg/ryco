import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react-native";
import type { ChatFileAttachment } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { createContext, use, useCallback, useMemo, useState, type ReactNode } from "react";
import { Alert, Modal, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { resolveMobileCodeSurface } from "../../lib/appearancePreferences";
import { useMobileHtmlRenderTheme } from "../../lib/htmlRenderTheme";
import { useThemeColor } from "../../lib/useThemeColor";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  HtmlRenderLoadingIndicator,
  HtmlRenderPagePlaceholder,
  HtmlRenderWebView,
} from "./HtmlRenderWebView";
import { HTML_RENDER_SHARE_SUPPORTED, shareHtmlRender } from "./htmlRenderShare";
import { buildHtmlRenderSourceLines } from "./htmlRenderSourceLines";
import { useHtmlRenderSource, type HtmlRenderSource } from "./useHtmlRenderSource";

/** Pages have no horizontal padding of their own, so full screen adds the feed's gutter. */
const FULL_SCREEN_GUTTER = 16;

/** A render to show full screen. */
export interface HtmlRenderFullScreenRequest {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly attachment: ChatFileAttachment;
  readonly title: string;
  /** The page, when the caller already holds it (the inline frame it opens from). */
  readonly html?: string;
}

type OpenHtmlRenderFullScreen = (request: HtmlRenderFullScreenRequest) => void;

const HtmlRenderFullScreenContext = createContext<OpenHtmlRenderFullScreen | null>(null);

function HeaderButton(props: {
  readonly symbol: AppSymbolName;
  readonly accessibilityLabel: string;
  readonly selected?: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{
        disabled: props.disabled,
        ...(props.selected === undefined ? {} : { selected: props.selected }),
      }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={`h-11 w-11 items-center justify-center rounded-full ${
        props.selected ? "bg-subtle-strong" : ""
      } ${props.disabled ? "opacity-40" : "active:bg-subtle"}`}
    >
      <SymbolView name={props.symbol} size={17} tintColor={iconColor} type="monochrome" />
    </Pressable>
  );
}

/**
 * The page's source as the agent wrote it, in the code font the reader chose:
 * a virtualized list, because a page can carry hundreds of kilobytes of markup.
 */
function HtmlRenderSourceText(props: { readonly html: string }) {
  const { rows, truncated } = useMemo(() => buildHtmlRenderSourceLines(props.html), [props.html]);
  const { appearance } = useAppearancePreferences();
  const surface = resolveMobileCodeSurface(appearance.codeFontSize);
  const renderRow = ({ item }: LegendListRenderItemProps<string>) => (
    <Text
      selectable
      className="px-4 font-mono text-foreground"
      style={{ fontSize: surface.fontSize, lineHeight: surface.rowHeight }}
    >
      {/* An empty text has no height; a blank line keeps its own. */}
      {item === "" ? " " : item}
    </Text>
  );
  return (
    <LegendList
      data={rows}
      renderItem={renderRow}
      keyExtractor={(_row, index) => String(index)}
      recycleItems
      estimatedItemSize={surface.rowHeight}
      contentInsetAdjustmentBehavior="never"
      contentContainerStyle={{ paddingTop: 8, paddingBottom: 24 }}
      ListHeaderComponent={
        truncated ? (
          <Text accessibilityRole="text" className="px-4 pb-2 text-xs text-foreground-muted">
            {HTML_RENDER_SHARE_SUPPORTED
              ? "Showing the start of the source. Share the page for all of it."
              : "Showing the start of the source."}
          </Text>
        ) : null
      }
    />
  );
}

/** The full-screen view: the page, its source, and a share of it. */
function HtmlRenderFullScreenView(props: {
  readonly title: string;
  readonly source: HtmlRenderSource;
  readonly onClose: () => void;
}) {
  const { source, title } = props;
  const theme = useMobileHtmlRenderTheme();
  const insets = useSafeAreaInsets();
  const [showSource, setShowSource] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [pageFailed, setPageFailed] = useState(false);
  const [pageAttempt, setPageAttempt] = useState(0);
  const html = source.status === "ready" ? source.html : undefined;
  /** The source shown over the page, while the reader has it open. */
  const sourceHtml = showSource ? html : undefined;
  const coveredBySource = sourceHtml !== undefined;

  const share = () => {
    if (html === undefined || sharing) return;
    setSharing(true);
    shareHtmlRender({ html, title }).then(
      () => setSharing(false),
      () => {
        setSharing(false);
        Alert.alert("Could not share the page", "Ryco could not save a copy of it to share.");
      },
    );
  };

  return (
    <View
      style={{
        flex: 1,
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        backgroundColor: theme.variables["--background"],
      }}
    >
      <View className="flex-row items-center gap-2 px-3 pb-1">
        {/* Both sides take the same width, so the title sits in the middle. */}
        <View className="w-24 flex-row">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Close ${title}`}
            onPress={props.onClose}
            className="h-11 min-w-11 items-center justify-center rounded-full px-2 active:bg-subtle"
          >
            <Text className="text-base font-ryco-medium text-foreground">Done</Text>
          </Pressable>
        </View>
        <Text
          numberOfLines={1}
          className="flex-1 text-center text-base font-ryco-bold text-foreground"
        >
          {title}
        </Text>
        <View className="w-24 flex-row items-center justify-end gap-1">
          <HeaderButton
            symbol="chevron.left.forwardslash.chevron.right"
            accessibilityLabel="Source"
            selected={showSource}
            disabled={html === undefined}
            onPress={() => setShowSource((shown) => !shown)}
          />
          {HTML_RENDER_SHARE_SUPPORTED ? (
            <HeaderButton
              symbol="square.and.arrow.up"
              accessibilityLabel={`Share ${title}`}
              disabled={html === undefined || sharing}
              onPress={share}
            />
          ) : null}
        </View>
      </View>
      <View style={{ flex: 1 }}>
        {/* The gutter is painted in the page's own background, so the page reads edge to edge.
            Under the source, the page is out of a screen reader's reach as well as out of sight. */}
        <View
          style={{ flex: 1, paddingHorizontal: FULL_SCREEN_GUTTER }}
          accessibilityElementsHidden={coveredBySource}
          importantForAccessibility={coveredBySource ? "no-hide-descendants" : "auto"}
        >
          {html !== undefined ? (
            pageFailed ? (
              <HtmlRenderPagePlaceholder
                accessibilityLabel={`Reload ${title}`}
                label="Page unavailable"
                detail="Tap to retry"
                onPress={() => {
                  setPageFailed(false);
                  setPageAttempt((value) => value + 1);
                }}
              />
            ) : (
              <HtmlRenderWebView
                key={pageAttempt}
                html={html}
                title={title}
                variant="fullScreen"
                onFailure={() => setPageFailed(true)}
              />
            )
          ) : source.status === "failed" ? (
            <HtmlRenderPagePlaceholder
              accessibilityLabel={`Reload ${title}`}
              label="Page unavailable"
              detail="Tap to retry"
              onPress={source.retry}
            />
          ) : source.status === "idle" ? (
            <HtmlRenderPagePlaceholder
              accessibilityLabel={`Load ${title}`}
              label={title}
              detail="Tap to load"
              onPress={source.load}
            />
          ) : (
            <HtmlRenderLoadingIndicator title={title} />
          )}
        </View>
        {/* The source covers the page rather than replacing it, so the page keeps its state. */}
        {sourceHtml !== undefined ? (
          <View
            accessibilityViewIsModal
            className="absolute inset-0"
            style={{ backgroundColor: theme.variables["--background"] }}
          >
            <HtmlRenderSourceText html={sourceHtml} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** Full screen for a page the caller does not hold: it reads it, whatever its size. */
function HtmlRenderFullScreenReader(props: {
  readonly request: HtmlRenderFullScreenRequest;
  readonly onClose: () => void;
}) {
  const { request } = props;
  const source = useHtmlRenderSource({
    environmentId: request.environmentId,
    threadId: request.threadId,
    messageId: request.messageId,
    attachmentId: request.attachment.id,
    sizeBytes: request.attachment.sizeBytes,
    requested: true,
  });
  return <HtmlRenderFullScreenView title={request.title} source={source} onClose={props.onClose} />;
}

function HtmlRenderFullScreen(props: {
  readonly request: HtmlRenderFullScreenRequest;
  readonly onClose: () => void;
}) {
  const { request } = props;
  return request.html === undefined ? (
    <HtmlRenderFullScreenReader request={request} onClose={props.onClose} />
  ) : (
    <HtmlRenderFullScreenView
      title={request.title}
      source={{ status: "ready", html: request.html }}
      onClose={props.onClose}
    />
  );
}

export interface HtmlRenderFullScreenHandle {
  readonly open: OpenHtmlRenderFullScreen;
  /** The full-screen modal; render it wherever its owner lives. */
  readonly modal: ReactNode;
}

function useOwnHtmlRenderFullScreen(): HtmlRenderFullScreenHandle {
  const [state, setState] = useState<{
    readonly request: HtmlRenderFullScreenRequest | null;
    readonly open: boolean;
    /** Each opening starts fresh: the page, not its source, with nothing shared yet. */
    readonly generation: number;
  }>({ request: null, open: false, generation: 0 });
  const open = useCallback<OpenHtmlRenderFullScreen>(
    (request) =>
      setState((current) => ({ request, open: true, generation: current.generation + 1 })),
    [],
  );
  // On iOS the page stays through the closing slide and is let go once the
  // modal reports it is gone. Android never reports that (React Native fires
  // `onDismiss` on iOS only) and drops the view as it closes, so the page is
  // let go at once there: a page read past the cache, kept here, would stay in
  // memory for as long as the thread is open.
  const close = useCallback(
    () =>
      setState((current) =>
        Platform.OS === "ios"
          ? { ...current, open: false }
          : { ...current, open: false, request: null },
      ),
    [],
  );
  const dismissed = useCallback(
    () => setState((current) => (current.open ? current : { ...current, request: null })),
    [],
  );
  // The owner re-renders with the feed (every streamed token); the open page
  // re-renders only when full screen itself changes.
  const modal = useMemo(
    () => (
      <Modal
        visible={state.open && state.request !== null}
        animationType="slide"
        presentationStyle="fullScreen"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={close}
        onDismiss={dismissed}
      >
        {state.request === null ? null : (
          <HtmlRenderFullScreen key={state.generation} request={state.request} onClose={close} />
        )}
      </Modal>
    ),
    [close, dismissed, state],
  );
  return { open, modal };
}

/**
 * Owns full screen for every render beneath it, so it outlives the row that
 * opened it: the feed unmounts rows as they scroll away and as the thread
 * streams, and the inline page and the reply's card open the same view.
 */
export function HtmlRenderFullScreenProvider({ children }: { readonly children: ReactNode }) {
  const { open, modal } = useOwnHtmlRenderFullScreen();
  return (
    <HtmlRenderFullScreenContext value={open}>
      {children}
      {modal}
    </HtmlRenderFullScreenContext>
  );
}

/**
 * Opens a render full screen through the nearest provider, or through a modal
 * of the caller's own (returned as `modal`) when it renders outside one.
 */
export function useHtmlRenderFullScreen(): HtmlRenderFullScreenHandle {
  const provided = use(HtmlRenderFullScreenContext);
  const own = useOwnHtmlRenderFullScreen();
  return provided === null ? own : { open: provided, modal: null };
}
