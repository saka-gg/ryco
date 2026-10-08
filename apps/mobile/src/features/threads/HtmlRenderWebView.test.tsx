import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The render WebView, invoked as a plain function with React's hooks, React
// Native, Reanimated and the WebView mocked (no React renderer exists in this
// suite; TurnstileChallenge.test.ts locks WebView props the same way). What it
// proves: the WebView keeps its containment props, refuses to leave the
// wrapper, opens a page's link only right after a tap (never while the reader
// scrolls across it), reports the page's height, and restarts a crashed page
// once. The feed row around it is covered in ThreadHtmlRender.test.tsx.

const hoisted = vi.hoisted(() => ({
  openURL: vi.fn(async (_url: string) => true),
  setters: [] as Array<ReturnType<typeof vi.fn>>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) => {
      const setter = vi.fn();
      hoisted.setters.push(setter);
      return [typeof initial === "function" ? (initial as () => T)() : initial, setter] as const;
    },
    useRef: <T,>(initial: T) => ({ current: initial }),
    useEffect: () => undefined,
    useMemo: <T,>(factory: () => T) => factory(),
  };
});
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  View: "View",
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: "AnimatedView" },
  useAnimatedStyle: (worklet: () => unknown) => worklet(),
  useSharedValue: <T,>(initial: T) => {
    let value = initial;
    return {
      get: () => value,
      set: (next: T) => {
        value = next;
      },
    };
  },
  withTiming: <T,>(value: T) => value,
}));
vi.mock("react-native-webview", () => ({ WebView: "WebView" }));
vi.mock("expo-linking", () => ({ openURL: hoisted.openURL }));
vi.mock("../../components/AppText", () => ({ AppText: "AppText" }));
vi.mock("../../lib/motion", () => ({ appMotion: { enter: {}, resize: {} } }));
vi.mock("../../lib/htmlRenderTheme", async () => {
  const { defaultHtmlRenderTheme } = await import("@ryco/shared/htmlRender");
  const theme = defaultHtmlRenderTheme("dark");
  return { useMobileHtmlRenderTheme: () => theme };
});

import { defaultHtmlRenderTheme, htmlRenderThemeWindowName } from "@ryco/shared/htmlRender";

import { escapeHtmlAttributeValue } from "../files/htmlPreview";
import { HtmlRenderLoadingIndicator, HtmlRenderWebView } from "./HtmlRenderWebView";

function isElement(value: unknown): value is ReactElement {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}

/** Host elements and function-component elements, without invoking components. */
function collect(node: unknown, predicate: (element: ReactElement) => boolean): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap((child) => collect(child, predicate));
  if (!isElement(node)) return [];
  const own = predicate(node) ? [node] : [];
  return [...own, ...collect((node.props as { children?: unknown }).children, predicate)];
}

function propsOf<T>(element: ReactElement | undefined): T {
  if (element === undefined) throw new Error("element not found");
  return element.props as T;
}

interface WebViewProps {
  readonly source: { readonly html: string };
  readonly ref: { current: { injectJavaScript: (script: string) => void } | null };
  readonly onShouldStartLoadWithRequest: (request: {
    url: string;
    isTopFrame?: boolean;
  }) => boolean;
  readonly onMessage: (event: { nativeEvent: { data: string } }) => void;
  readonly onContentProcessDidTerminate: () => void;
  readonly onRenderProcessGone: () => void;
  readonly onOpenWindow: (event: unknown) => void;
  readonly scrollEnabled: boolean;
  readonly nestedScrollEnabled: boolean;
}

function renderWebView(overrides: Partial<Parameters<typeof HtmlRenderWebView>[0]> = {}) {
  const onFailure = vi.fn();
  const onContentHeight = vi.fn();
  const tree = HtmlRenderWebView({
    html: "<!doctype html><p>Chart</p>",
    title: "Bundle size",
    variant: "inline",
    onFailure,
    onContentHeight,
    ...overrides,
  });
  const webView = collect(tree, (element) => element.type === "WebView")[0];
  const injectJavaScript = vi.fn();
  const props = propsOf<WebViewProps>(webView);
  props.ref.current = { injectJavaScript };
  const touches = tree.props as TouchHandlers;
  const at = (pageX: number, pageY: number, fingers: number) => ({
    nativeEvent: { pageX, pageY, touches: Array.from({ length: fingers }) },
  });
  /** A finger lands on the frame and lifts where it landed. */
  const tap = () => {
    touches.onTouchStart(at(120, 300, 1));
    touches.onTouchEnd(at(120, 300, 0));
  };
  /** A finger lands on the frame and drags the feed. */
  const scroll = (ending: "lift" | "cancel") => {
    touches.onTouchStart(at(120, 300, 1));
    touches.onTouchMove(at(120, 260, 1));
    if (ending === "cancel") touches.onTouchCancel();
    else touches.onTouchEnd(at(120, 180, 0));
  };
  return { tree, props, onFailure, onContentHeight, injectJavaScript, tap, scroll, touches, at };
}

interface TouchEvent {
  readonly nativeEvent: { pageX: number; pageY: number; touches: unknown[] };
}
interface TouchHandlers {
  readonly onTouchStart: (event: TouchEvent) => void;
  readonly onTouchMove: (event: TouchEvent) => void;
  readonly onTouchEnd: (event: TouchEvent) => void;
  readonly onTouchCancel: () => void;
}

const link = (url: string) =>
  JSON.stringify({ jsonrpc: "2.0", id: "ryco-link-1", method: "ui/open-link", params: { url } });

beforeEach(() => {
  hoisted.openURL.mockClear();
  hoisted.setters = [];
});

describe("HtmlRenderWebView", () => {
  it("keeps the WebView free of credentials, storage, files and windows", () => {
    const { props } = renderWebView();
    expect(props).toMatchObject({
      javaScriptEnabled: true,
      incognito: true,
      cacheEnabled: false,
      domStorageEnabled: false,
      sharedCookiesEnabled: false,
      thirdPartyCookiesEnabled: false,
      allowFileAccess: false,
      allowFileAccessFromFileURLs: false,
      allowUniversalAccessFromFileURLs: false,
      javaScriptCanOpenWindowsAutomatically: false,
      setSupportMultipleWindows: false,
      mixedContentMode: "never",
      geolocationEnabled: false,
      mediaCapturePermissionGrantType: "deny",
      allowsLinkPreview: false,
      dataDetectorTypes: "none",
      originWhitelist: ["*"],
      accessibilityLabel: "Bundle size",
    });
    // A window request is dropped, never loaded or handed to the system.
    expect(props.onOpenWindow({ nativeEvent: { targetUrl: "https://example.test" } })).toBe(
      undefined,
    );
    expect(hoisted.openURL).not.toHaveBeenCalled();
  });

  it("loads the page only inside the sandboxed wrapper, themed by the frame name", () => {
    const { props } = renderWebView();
    expect(props.source.html).toContain(' sandbox="allow-scripts allow-forms" ');
    expect(props.source.html).not.toContain("allow-same-origin");
    expect(props.source.html).toContain(
      `name="${escapeHtmlAttributeValue(htmlRenderThemeWindowName(defaultHtmlRenderTheme("dark")))}"`,
    );
    expect(props.source.html).toContain('srcdoc="&lt;!doctype html&gt;&lt;p&gt;Chart&lt;/p&gt;"');
  });

  it("refuses to leave the wrapper", () => {
    const { props } = renderWebView();
    expect(props.onShouldStartLoadWithRequest({ url: "about:blank", isTopFrame: true })).toBe(true);
    expect(
      props.onShouldStartLoadWithRequest({ url: "https://example.test/", isTopFrame: true }),
    ).toBe(false);
    expect(props.onShouldStartLoadWithRequest({ url: "https://example.test/" })).toBe(false);
    expect(props.onShouldStartLoadWithRequest({ url: "tel:123", isTopFrame: false })).toBe(false);
  });

  it("reports the page's content height", () => {
    const { props, onContentHeight } = renderWebView();
    props.onMessage({
      nativeEvent: {
        data: JSON.stringify({
          jsonrpc: "2.0",
          method: "ui/notifications/size-changed",
          params: { height: 318.4 },
        }),
      },
    });
    expect(onContentHeight).toHaveBeenCalledWith(319);
    props.onMessage({ nativeEvent: { data: "garbage" } });
    expect(onContentHeight).toHaveBeenCalledTimes(1);
  });

  it("opens a page's link only right after the reader tapped it", () => {
    const { props, injectJavaScript, tap } = renderWebView();
    props.onMessage({ nativeEvent: { data: link("https://example.test/docs") } });
    expect(hoisted.openURL).not.toHaveBeenCalled();
    expect(injectJavaScript).not.toHaveBeenCalled();

    tap();
    props.onMessage({ nativeEvent: { data: link("https://example.test/docs") } });
    expect(hoisted.openURL).toHaveBeenCalledWith("https://example.test/docs");
    expect(injectJavaScript).toHaveBeenCalledWith(
      'window.__rycoPost&&window.__rycoPost({"jsonrpc":"2.0","id":"ryco-link-1","result":{}});true;',
    );

    // One tap opens one link.
    props.onMessage({ nativeEvent: { data: link("https://example.test/again") } });
    expect(hoisted.openURL).toHaveBeenCalledTimes(1);
  });

  it("opens nothing while the reader scrolls across the page", () => {
    const { props, injectJavaScript, scroll, touches, at } = renderWebView();
    // A page can post a link request the moment a finger lands; a touch that
    // only starts grants nothing.
    touches.onTouchStart(at(120, 300, 1));
    props.onMessage({ nativeEvent: { data: link("https://phish.example/") } });
    // Nor does a touch that moves, or that the feed's scroll view takes.
    scroll("lift");
    props.onMessage({ nativeEvent: { data: link("https://phish.example/") } });
    scroll("cancel");
    props.onMessage({ nativeEvent: { data: link("https://phish.example/") } });
    expect(hoisted.openURL).not.toHaveBeenCalled();
    expect(injectJavaScript).not.toHaveBeenCalled();
  });

  it("ignores a link after the tap has gone stale, and non-http links always", () => {
    const { props, tap } = renderWebView();
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(10_000);
      tap();
      now.mockReturnValue(11_500);
      props.onMessage({ nativeEvent: { data: link("https://example.test/") } });
      now.mockReturnValue(20_000);
      tap();
      props.onMessage({ nativeEvent: { data: link("ryco-dev://pair") } });
      props.onMessage({ nativeEvent: { data: link("javascript:alert(1)") } });
    } finally {
      now.mockRestore();
    }
    expect(hoisted.openURL).not.toHaveBeenCalled();
  });

  it("restarts a crashed page once, then reports it unavailable", () => {
    const { props, onFailure } = renderWebView();
    props.onContentProcessDidTerminate();
    expect(onFailure).not.toHaveBeenCalled();
    // The page state is rebuilt under a new key.
    const restarted = hoisted.setters.find((setter) => setter.mock.calls.length > 0);
    expect(restarted).toBeDefined();
    props.onRenderProcessGone();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("lets an inline page scroll only when it is taller than its frame", () => {
    expect(renderWebView().props).toMatchObject({
      scrollEnabled: false,
      nestedScrollEnabled: false,
    });
    expect(renderWebView({ scrollable: true }).props).toMatchObject({
      scrollEnabled: true,
      nestedScrollEnabled: true,
    });
    expect(renderWebView({ variant: "fullScreen" }).props).toMatchObject({
      scrollEnabled: true,
      nestedScrollEnabled: false,
    });
    expect(renderWebView({ variant: "fullScreen" }).props.source.html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
  });
});

describe("HtmlRenderLoadingIndicator", () => {
  it("shows nothing at first, so a fast read never flashes a spinner", () => {
    expect(HtmlRenderLoadingIndicator({ title: "Bundle size" })).toBeNull();
  });
});
