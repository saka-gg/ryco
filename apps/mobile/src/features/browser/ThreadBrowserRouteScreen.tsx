import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { normalizeBrowserUrl } from "@ryco/shared/browserUrl";
import { EnvironmentId, ThreadId } from "@ryco/contracts/base-schemas";
import type {
  NodeBrowserCommand,
  NodeBrowserInputEvent,
  NodeBrowserStill,
  NodeBrowserViewport,
} from "@ryco/contracts/node-browser";
import { Image } from "expo-image";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  PanResponder,
  Pressable,
  ScrollView,
  View,
  type LayoutChangeEvent,
} from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { firstRouteParam } from "../../lib/routeParams";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { cn } from "../../lib/cn";
import { errorMessageOr } from "../../lib/errorMessage";
import { useThemeColor } from "../../lib/useThemeColor";
import { useThreadWorkspaceCwd } from "../files/useThreadWorkspaceRoot";
import { useEnvironmentMutationReady } from "../home/useEnvironmentMutationReady";
import { ToolTextField } from "../sourceControl/gitToolsParts";
import {
  clickEvents,
  nodeBrowserUnavailableMessage,
  pagePoint,
  PREVIEW_STILL_INTERVAL_MS,
  PREVIEW_STILL_MAX_HEIGHT,
  PREVIEW_STILL_MAX_WIDTH,
  PREVIEW_STILL_QUALITY,
  previewViewport,
  viewportToRestore,
  scrollEvent,
  tabForUrl,
  tabLabel,
  tabsInScope,
  typingEvents,
  type ShownImage,
} from "./browserPreviewModel";
import { useNodeBrowserClient, useNodeBrowserTabs, type NodeBrowserClient } from "./useNodeBrowser";

type ThreadBrowserRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly url?: string;
}>;

function failureText(cause: unknown): string {
  return errorMessageOr(cause, "The machine's browser did not answer.");
}

/** Movement under this many points is a tap, not a scroll. */
const TAP_SLOP = 8;

/** The address bar's text as an address, or the reason it is not one. */
function parseAddress(value: string): { readonly url: string } | { readonly error: string } {
  try {
    return { url: normalizeBrowserUrl(value) };
  } catch (cause) {
    return { error: failureText(cause) };
  }
}

function sendInput(
  client: NodeBrowserClient | null,
  tabId: string | null,
  events: NodeBrowserInputEvent[],
  onError: (message: string) => void,
): void {
  if (!client || !tabId || events.length === 0) return;
  void client.input({ tabId, events }).catch((cause: unknown) => onError(failureText(cause)));
}

/** Taps click, drags scroll, on a still drawn at `image`'s size. */
function createPagePan(image: ShownImage | null, send: (events: NodeBrowserInputEvent[]) => void) {
  return PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_event, gesture) =>
      Math.abs(gesture.dx) > TAP_SLOP || Math.abs(gesture.dy) > TAP_SLOP,
    onPanResponderRelease: (event, gesture) => {
      if (!image) return;
      const { locationX, locationY } = event.nativeEvent;
      if (Math.abs(gesture.dx) <= TAP_SLOP && Math.abs(gesture.dy) <= TAP_SLOP) {
        send(clickEvents(pagePoint(image, locationX, locationY)));
        return;
      }
      const wheel = scrollEvent(
        image,
        { x: locationX - gesture.dx, y: locationY - gesture.dy },
        gesture.dx,
        gesture.dy,
      );
      if (wheel) send([wheel]);
    },
  });
}

function ToolbarButton(props: {
  readonly symbol: AppSymbolName;
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const color = useThemeColor("--color-icon");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={4}
      className={cn(
        "h-10 w-10 items-center justify-center rounded-full active:bg-subtle-strong",
        props.disabled ? "opacity-30" : "",
      )}
    >
      <SymbolView name={props.symbol} size={16} tintColor={color as string} type="monochrome" />
    </Pressable>
  );
}

/** Reads the shown tab's still while the screen is in front and the app active. */
function useTabStill(client: NodeBrowserClient | null, tabId: string | null, active: boolean) {
  const [still, setStill] = useState<NodeBrowserStill | null>(null);
  const [appActive, setAppActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setAppActive(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    setStill(null);
  }, [tabId]);
  useEffect(() => {
    if (!client || !tabId || !active || !appActive) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      void client
        .read({
          type: "still",
          tabId,
          maxWidth: PREVIEW_STILL_MAX_WIDTH,
          maxHeight: PREVIEW_STILL_MAX_HEIGHT,
          quality: PREVIEW_STILL_QUALITY,
        })
        .then(
          (response) => {
            if (!stopped && response.type === "still") setStill(response.still);
          },
          () => {},
        )
        .finally(() => {
          if (!stopped) timer = setTimeout(read, PREVIEW_STILL_INTERVAL_MS);
        });
    };
    read();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [active, appActive, client, tabId]);
  return still;
}

/**
 * A page running in the machine's browser: a still of the tab refreshed while
 * you look, tap to click, drag to scroll, a field to type, and back / forward /
 * reload. Tabs belong to the thread's workspace, as on the desktop.
 */
export function ThreadBrowserRouteScreen(props: ThreadBrowserRouteProps) {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const environmentId = EnvironmentId.make(firstRouteParam(props.route.params.environmentId) ?? "");
  const threadId = ThreadId.make(firstRouteParam(props.route.params.threadId) ?? "");
  const requestedUrl = firstRouteParam(props.route.params.url);
  const scope = useThreadWorkspaceCwd(environmentId, threadId);
  const client = useNodeBrowserClient(environmentId);
  // Reading the page needs the connection; acting on it also needs the node to take changes.
  const mutable = useEnvironmentMutationReady(environmentId);
  const actingClient = mutable ? client : null;
  const { tabs, capability, failed } = useNodeBrowserTabs(client);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [typing, setTyping] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [layoutWidth, setLayoutWidth] = useState(0);
  const [layoutHeight, setLayoutHeight] = useState(0);

  const scoped = useMemo(() => (tabs && scope ? tabsInScope(tabs, scope) : []), [scope, tabs]);
  const selected = scoped.find((tab) => tab.id === selectedId) ?? scoped.at(-1) ?? null;
  const still = useTabStill(client, selected ? selected.id : null, focused);

  const command = async (next: NodeBrowserCommand) => {
    if (!actingClient) return null;
    setError(null);
    try {
      const result = await actingClient.command(next);
      return result.tab;
    } catch (cause) {
      setError(failureText(cause));
      return null;
    }
  };

  const open = async (url: string) => {
    if (!scope) return;
    const existing = tabForUrl(scoped, url);
    if (existing) {
      setSelectedId(existing.id);
      if (existing.url !== url) void command({ type: "navigate", tabId: existing.id, url });
      return;
    }
    setBusy(true);
    const tab = await command({ type: "open", scope, url });
    setBusy(false);
    if (!tab) return;
    setSelectedId(tab.id);
  };

  // The address the route was opened for, once the node listed its tabs.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!requestedUrl || !tabs || !scope || openedFor === requestedUrl) return;
    setOpenedFor(requestedUrl);
    void open(requestedUrl);
  });

  const selectedUrl = selected ? selected.url : null;
  useEffect(() => {
    if (selectedUrl !== null) setAddress(selectedUrl);
  }, [selectedUrl]);

  useLayoutEffect(() => {
    navigation.setOptions({ title: selected ? tabLabel(selected) : "Preview" });
  }, [navigation, selected]);

  const tabId = selected ? selected.id : null;
  // The tab lays out at the phone's preview size, as the desktop sizes it to its panel.
  const viewport = previewViewport(layoutWidth, layoutHeight);
  const viewportWidth = viewport ? viewport.width : 0;
  const viewportHeight = viewport ? viewport.height : 0;
  const tabViewport = selected ? selected.viewport : null;
  // The size the tab had before the phone sized it, per tab: the node shares tabs between
  // clients (the newest size wins), so the phone gives it back when it stops showing it.
  const viewportBefore = useRef(new Map<string, NodeBrowserViewport | null>());
  // Recorded once per tab, before the phone's own size reaches it (this runs before the resize).
  useEffect(() => {
    if (tabId && !viewportBefore.current.has(tabId)) viewportBefore.current.set(tabId, tabViewport);
  }, [tabId, tabViewport]);
  useEffect(() => {
    if (!actingClient || !tabId || viewportWidth === 0 || !focused) return;
    void actingClient
      .command({ type: "resize", tabId, width: viewportWidth, height: viewportHeight })
      .catch(() => undefined);
  }, [actingClient, focused, tabId, viewportHeight, viewportWidth]);
  // Leaving the tab (blur, another tab, unmount) gives it back; a resize alone does not.
  const ownWidth = useRef(0);
  const ownHeight = useRef(0);
  useEffect(() => {
    ownWidth.current = viewportWidth;
    ownHeight.current = viewportHeight;
  }, [viewportHeight, viewportWidth]);
  useEffect(() => {
    if (!actingClient || !tabId || !focused) return;
    const before = viewportBefore.current;
    return () => {
      const restore = viewportToRestore(before.get(tabId) ?? null, {
        width: ownWidth.current,
        height: ownHeight.current,
      });
      before.delete(tabId);
      if (restore)
        void actingClient.command({ type: "resize", tabId, ...restore }).catch(() => undefined);
    };
  }, [actingClient, focused, tabId]);
  const input = (events: NodeBrowserInputEvent[]) =>
    sendInput(actingClient, tabId, events, setError);

  const cssWidth = still ? still.cssWidth : 0;
  const cssHeight = still ? still.cssHeight : 0;
  const shown: ShownImage | null =
    cssWidth > 0 && layoutWidth > 0
      ? {
          cssWidth,
          cssHeight,
          viewWidth: layoutWidth,
          viewHeight: (layoutWidth * cssHeight) / cssWidth,
        }
      : null;
  const pan = useMemo(
    () =>
      createPagePan(
        cssWidth > 0 && layoutWidth > 0
          ? {
              cssWidth,
              cssHeight,
              viewWidth: layoutWidth,
              viewHeight: (layoutWidth * cssHeight) / cssWidth,
            }
          : null,
        (events) => sendInput(actingClient, tabId, events, setError),
      ),
    [actingClient, cssHeight, cssWidth, layoutWidth, tabId],
  );

  const go = () => {
    const parsed = parseAddress(address);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    if (selected) void command({ type: "navigate", tabId: selected.id, url: parsed.url });
    else void open(parsed.url);
  };

  if (!client || failed || (capability && !capability.available)) {
    return (
      <View className="flex-1 bg-screen px-5 py-16">
        <EmptyState
          variant="plain"
          title="Preview unavailable"
          detail={
            !client || failed
              ? "Reconnect to this machine to preview pages."
              : nodeBrowserUnavailableMessage(capability)
          }
        />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-screen">
      <View className="flex-row items-center gap-1 border-b border-border-subtle px-2 py-1.5">
        <ToolbarButton
          symbol="chevron.left"
          label="Back"
          disabled={!selected?.canGoBack}
          onPress={() =>
            selected && void command({ type: "history", tabId: selected.id, delta: -1 })
          }
        />
        <ToolbarButton
          symbol="chevron.right"
          label="Forward"
          disabled={!selected?.canGoForward}
          onPress={() =>
            selected && void command({ type: "history", tabId: selected.id, delta: 1 })
          }
        />
        <ToolTextField
          mono
          value={address}
          onChangeText={setAddress}
          onSubmitEditing={go}
          returnKeyType="go"
          keyboardType="url"
          placeholder="localhost:3000"
          accessibilityLabel="Address"
          className="min-h-10 flex-1 rounded-full px-3.5 py-2 text-[13px]"
        />
        {selected?.loading || busy ? (
          <View className="h-10 w-10 items-center justify-center">
            <ActivityIndicator size="small" />
          </View>
        ) : (
          <ToolbarButton
            symbol="arrow.clockwise"
            label="Reload"
            disabled={!selected}
            onPress={() => selected && void command({ type: "reload", tabId: selected.id })}
          />
        )}
      </View>
      {scoped.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="max-h-11 grow-0 border-b border-border-subtle"
          contentContainerStyle={{ paddingHorizontal: 8, gap: 6, alignItems: "center" }}
        >
          {scoped.map((tab) => (
            <Pressable
              key={tab.id}
              onPress={() => setSelectedId(tab.id)}
              onLongPress={() => void command({ type: "close", tabId: tab.id })}
              accessibilityHint="Long-press to close the tab"
              className={cn(
                "max-w-48 rounded-full px-3 py-1.5",
                tab.id === selected?.id ? "bg-subtle-strong" : "active:bg-subtle",
              )}
            >
              <Text className="text-[12px] font-ryco-medium text-foreground" numberOfLines={1}>
                {tabLabel(tab)}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {error || !mutable ? (
        <View className="px-3 pt-2">
          <ErrorBanner
            message={error ?? "This machine is not ready for changes; the page is view-only."}
          />
        </View>
      ) : null}
      {selected?.dialog ? (
        <View className="mx-3 mt-2 flex-row items-center gap-2 rounded-2xl bg-card px-3 py-2">
          <Text className="flex-1 text-[13px] text-foreground" numberOfLines={3}>
            {selected.dialog.message}
          </Text>
          <Pressable
            onPress={() => void command({ type: "dialog", tabId: selected.id, accept: false })}
            className="rounded-full bg-subtle-strong px-3 py-1.5"
          >
            <Text className="text-[12px] font-ryco-bold text-foreground">Cancel</Text>
          </Pressable>
          <Pressable
            onPress={() => void command({ type: "dialog", tabId: selected.id, accept: true })}
            className="rounded-full bg-primary px-3 py-1.5"
          >
            <Text className="text-[12px] font-ryco-bold text-primary-foreground">OK</Text>
          </Pressable>
        </View>
      ) : null}
      <ScrollView
        className="flex-1"
        scrollEnabled={false}
        onLayout={(event: LayoutChangeEvent) => {
          setLayoutWidth(event.nativeEvent.layout.width);
          setLayoutHeight(event.nativeEvent.layout.height);
        }}
      >
        {!selected ? (
          <View className="px-5 py-16">
            <EmptyState
              variant="plain"
              title={tabs ? "No page open" : "Connecting to the browser…"}
              detail="Enter an address above, or preview a server from the thread's Servers."
            />
          </View>
        ) : shown && still ? (
          <View {...pan.panHandlers} style={{ width: shown.viewWidth, height: shown.viewHeight }}>
            <Image
              source={{ uri: `data:${still.mimeType};base64,${still.bytesBase64}` }}
              style={{ width: shown.viewWidth, height: shown.viewHeight }}
              contentFit="fill"
              transition={0}
              // Page screenshots stay in memory: never on disk.
              cachePolicy="none"
              accessibilityLabel={`Page: ${tabLabel(selected)}`}
            />
          </View>
        ) : (
          <View className="items-center py-16">
            <ActivityIndicator />
          </View>
        )}
      </ScrollView>
      {selected ? (
        <View className="flex-row items-center gap-2 border-t border-border-subtle px-3 py-2">
          <ToolTextField
            value={typing}
            onChangeText={setTyping}
            placeholder="Type into the page"
            accessibilityLabel="Type into the page"
            returnKeyType="send"
            onSubmitEditing={() => {
              input(typingEvents(typing, true));
              setTyping("");
            }}
            className="min-h-10 flex-1 rounded-full px-3.5 py-2 text-[14px]"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send text"
            disabled={typing.length === 0}
            onPress={() => {
              input(typingEvents(typing, false));
              setTyping("");
            }}
            className="h-10 justify-center rounded-full bg-primary px-4 active:opacity-75 disabled:opacity-35"
          >
            <Text className="text-[13px] font-ryco-bold text-primary-foreground">Send</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
