import {
  htmlRenderResult,
  htmlRenderThemeMessage,
  type HtmlRenderTheme,
} from "@ryco/shared/htmlRender";
import * as Linking from "expo-linking";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { AppText as Text } from "../../components/AppText";
import { useMobileHtmlRenderTheme } from "../../lib/htmlRenderTheme";
import { appMotion } from "../../lib/motion";
import {
  buildHtmlRenderDocument,
  createHtmlRenderLinkGate,
  HTML_RENDER_ORIGIN_WHITELIST,
  htmlRenderPostScript,
  isAllowedHtmlRenderNavigation,
  parseHtmlRenderBridgeMessage,
} from "./htmlRenderDocument";

/** A read that finishes this fast shows no spinner at all. */
const LOADING_INDICATOR_DELAY_MS = 250;

// The page cannot open windows (its sandbox has no allow-popups), so a window
// request reaching native is never the reader's; it is dropped rather than
// loaded into the WebView or handed to the system.
const dropWindowRequest = () => undefined;

/**
 * An agent's HTML page, themed before first paint and kept in step with the
 * app theme. The page lives in a sandboxed frame inside a wrapper document
 * (see htmlRenderDocument.ts); this component owns the WebView around it and
 * the bridge: size reports, theme changes, and link requests the reader made.
 */
export function HtmlRenderWebView(props: {
  readonly html: string;
  readonly title: string;
  /** Inline in the feed the frame is sized to the page; full screen the page scrolls. */
  readonly variant: "inline" | "fullScreen";
  /** Inline only: the page is taller than its frame (the agent capped it), so it scrolls inside. */
  readonly scrollable?: boolean;
  readonly onContentHeight?: (height: number) => void;
  /** The page failed to load, or its web process died again after one restart. */
  readonly onFailure: () => void;
}) {
  const inline = props.variant === "inline";
  const theme = useMobileHtmlRenderTheme();
  // The page keeps its first document for its lifetime; a theme change is
  // posted into it rather than reloading it. A restart takes the theme then.
  const [page, setPage] = useState(() => ({
    generation: 0,
    theme,
    document: buildHtmlRenderDocument({
      html: props.html,
      title: props.title,
      theme,
      zoomable: !inline,
    }),
  }));
  const webView = useRef<WebView>(null);
  // The theme the running page shows; null until it has loaded.
  const shownTheme = useRef<HtmlRenderTheme | null>(null);
  const crashes = useRef(0);
  // Only the reader's tap on the frame lets the page open a link.
  const [linkGate] = useState(createHtmlRenderLinkGate);
  const revealed = useRef(false);
  const opacity = useSharedValue(0);
  const fadeStyle = useAnimatedStyle(() => ({ opacity: opacity.get() }));

  const post = (message: unknown) => {
    webView.current?.injectJavaScript(htmlRenderPostScript(message));
  };
  // A live theme change goes into the running page; one before load is
  // handled when it loads.
  useEffect(() => {
    if (shownTheme.current === null || shownTheme.current === theme) return;
    shownTheme.current = theme;
    webView.current?.injectJavaScript(htmlRenderPostScript(htmlRenderThemeMessage(theme)));
  }, [theme]);

  // The page fades in once it has laid out (its first size report) or loaded,
  // whichever comes first, so the reader never sees it assemble.
  const reveal = () => {
    if (revealed.current) return;
    revealed.current = true;
    opacity.set(withTiming(1, appMotion.enter));
  };
  const restart = () => {
    // A page that keeps killing its web process is not reloaded forever.
    crashes.current += 1;
    if (crashes.current > 1) {
      props.onFailure();
      return;
    }
    shownTheme.current = null;
    revealed.current = false;
    opacity.set(0);
    setPage((current) => ({
      generation: current.generation + 1,
      theme,
      document: buildHtmlRenderDocument({
        html: props.html,
        title: props.title,
        theme,
        zoomable: !inline,
      }),
    }));
  };
  const onMessage = (event: WebViewMessageEvent) => {
    const message = parseHtmlRenderBridgeMessage(event.nativeEvent.data);
    if (message === undefined) return;
    if (message.kind === "content-height") {
      reveal();
      props.onContentHeight?.(message.height);
      return;
    }
    if (!linkGate.consume(Date.now())) return;
    void Linking.openURL(message.url).catch(() => undefined);
    post(htmlRenderResult(message.id));
  };
  const scrollable = !inline || props.scrollable === true;

  return (
    <View
      style={{ flex: 1 }}
      onTouchStart={(event) => linkGate.touchStart(event.nativeEvent, Date.now())}
      onTouchMove={(event) => linkGate.touchMove(event.nativeEvent, Date.now())}
      onTouchEnd={(event) => linkGate.touchEnd(event.nativeEvent, Date.now())}
      // The feed's scroll view taking the gesture cancels it.
      onTouchCancel={linkGate.touchCancel}
    >
      <Animated.View style={[{ flex: 1 }, fadeStyle]}>
        <WebView
          key={page.generation}
          ref={webView}
          source={{ html: page.document }}
          accessibilityLabel={props.title}
          style={{ flex: 1, backgroundColor: "transparent" }}
          // Containment (see htmlRenderDocument.ts): scripts run only inside the
          // sandboxed frame; the WebView keeps no credentials or storage and
          // never leaves the wrapper.
          javaScriptEnabled
          incognito
          cacheEnabled={false}
          domStorageEnabled={false}
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          javaScriptCanOpenWindowsAutomatically={false}
          setSupportMultipleWindows={false}
          mixedContentMode="never"
          geolocationEnabled={false}
          mediaCapturePermissionGrantType="deny"
          allowsLinkPreview={false}
          dataDetectorTypes="none"
          allowsBackForwardNavigationGestures={false}
          allowsInlineMediaPlayback
          allowsAirPlayForMediaPlayback={false}
          originWhitelist={[...HTML_RENDER_ORIGIN_WHITELIST]}
          onShouldStartLoadWithRequest={isAllowedHtmlRenderNavigation}
          onOpenWindow={dropWindowRequest}
          onMessage={onMessage}
          onLoad={() => {
            reveal();
            // Covers a theme change that landed while the page was loading.
            if (page.theme !== theme) post(htmlRenderThemeMessage(theme));
            shownTheme.current = theme;
          }}
          onError={restart}
          onHttpError={restart}
          onContentProcessDidTerminate={restart}
          onRenderProcessGone={restart}
          // Inline, the frame is the page's height and the feed takes the
          // reader's scroll; only a page taller than its frame scrolls itself.
          scrollEnabled={scrollable}
          nestedScrollEnabled={inline && scrollable}
          bounces={!inline}
          overScrollMode={inline ? "never" : "always"}
          showsVerticalScrollIndicator={!inline}
          showsHorizontalScrollIndicator={false}
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          setBuiltInZoomControls={!inline}
          setDisplayZoomControls={false}
        />
      </Animated.View>
    </View>
  );
}

/** A page on its way: nothing at first, a spinner if the read takes a while. */
export function HtmlRenderLoadingIndicator(props: { readonly title: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), LOADING_INDICATOR_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return visible ? (
    <View className="flex-1 items-center justify-center">
      <ActivityIndicator accessibilityLabel={`Loading ${props.title}`} />
    </View>
  ) : null;
}

/** A tappable stand-in holding a page's box: load it, or try again. */
export function HtmlRenderPagePlaceholder(props: {
  readonly accessibilityLabel: string;
  readonly label: string;
  readonly detail: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      onPress={props.onPress}
      className="flex-1 items-center justify-center rounded-2xl bg-subtle px-4 active:opacity-70"
    >
      <Text className="font-ryco-medium text-sm text-foreground-muted">
        {props.label} · {props.detail}
      </Text>
    </Pressable>
  );
}
