import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The feed row of an HTML render, invoked as a plain function with React's
// hooks, React Native, Reanimated, the page source and full screen mocked (no
// React renderer exists in this suite). What it proves: the row holds the
// frame's box in every state, shows the page once it is read, and its expand
// button opens the page full screen with the page it already holds. It reads
// the render metadata its message validated and never validates it again.

const hoisted = vi.hoisted(() => ({
  source: { status: "loading" } as Record<string, unknown>,
  windowWidth: 400,
  openFullScreen: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) =>
      [typeof initial === "function" ? (initial as () => T)() : initial, vi.fn()] as const,
    useRef: <T,>(initial: T) => ({ current: initial }),
    useEffect: () => undefined,
  };
});
vi.mock("react-native", () => ({
  Pressable: "Pressable",
  View: "View",
  useWindowDimensions: () => ({ width: hoisted.windowWidth, height: 800 }),
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
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../lib/motion", () => ({ appMotion: { enter: {}, resize: {} } }));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#ffffff" }));
vi.mock("./useHtmlRenderSource", () => ({ useHtmlRenderSource: () => hoisted.source }));
vi.mock("./HtmlRenderFullScreen", () => ({
  useHtmlRenderFullScreen: () => ({ open: hoisted.openFullScreen, modal: null }),
}));
vi.mock("@ryco/shared/htmlRender", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ryco/shared/htmlRender")>();
  return {
    ...actual,
    htmlRenderOfAttachment: vi.fn(actual.htmlRenderOfAttachment),
    readHtmlRenderMetadata: vi.fn(actual.readHtmlRenderMetadata),
  };
});
vi.mock("./HtmlRenderWebView", () => ({
  HtmlRenderWebView: "HtmlRenderWebView",
  HtmlRenderLoadingIndicator: "HtmlRenderLoadingIndicator",
  HtmlRenderPagePlaceholder: "HtmlRenderPagePlaceholder",
}));

import type { ChatFileAttachment } from "@ryco/client-runtime/state/threads";
import { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import {
  htmlRenderOfAttachment,
  readHtmlRenderMetadata,
  type HtmlRenderMetadata,
} from "@ryco/shared/htmlRender";

import { ThreadHtmlRender } from "./ThreadHtmlRender";

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

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");
const messageId = MessageId.make("message-1");

const attachment: ChatFileAttachment = {
  type: "file",
  id: "thread-1-abc-html",
  name: "Bundle size.html",
  mimeType: "text/html",
  sizeBytes: 4096,
  htmlRender: {
    title: "Bundle size",
    height: 900,
    heights: [
      [320, 520],
      [375, 480],
      [430, 440],
      [760, 360],
    ],
  },
};

function renderRow(
  input: Partial<ChatFileAttachment> = {},
  htmlRender = attachment.htmlRender as HtmlRenderMetadata,
) {
  return ThreadHtmlRender({
    environmentId,
    threadId,
    messageId,
    attachment: { ...attachment, ...input },
    htmlRender,
  });
}

function frameHeightOf(row: ReactElement) {
  const frame = collect(row, (element) => element.type === "AnimatedView")[0];
  const styles = propsOf<{ style: ReadonlyArray<Record<string, unknown>> }>(frame).style;
  return Object.assign({}, ...styles).height as number;
}

/** A tappable element (a Pressable or a placeholder wrapping one) by its accessibility label. */
function pressable(row: ReactElement, label: string) {
  return collect(row, (element) => {
    const props = element.props as { accessibilityLabel?: string; onPress?: unknown };
    return props.accessibilityLabel === label && typeof props.onPress === "function";
  })[0];
}

beforeEach(() => {
  hoisted.windowWidth = 400;
  hoisted.source = { status: "loading" };
  hoisted.openFullScreen.mockClear();
  vi.mocked(htmlRenderOfAttachment).mockClear();
  vi.mocked(readHtmlRenderMetadata).mockClear();
});

describe("ThreadHtmlRender", () => {
  it("shows the metadata its message validated, without validating it again", () => {
    hoisted.source = { status: "ready", html: "<p>page</p>" };
    const row = renderRow({}, { title: "Validated title", height: 300 });
    expect(frameHeightOf(row)).toBe(300);
    expect(pressable(row, "Open Validated title full size")).toBeDefined();
    expect(htmlRenderOfAttachment).not.toHaveBeenCalled();
    expect(readHtmlRenderMetadata).not.toHaveBeenCalled();
  });

  it("reserves the page's measured height at the column's width before it loads", () => {
    // A 400pt window less the 40pt message gutter is 360pt: the taller of the
    // 320 and 375 measurements around it.
    const row = renderRow();
    expect(frameHeightOf(row)).toBe(520);
    expect(collect(row, (element) => element.type === "HtmlRenderWebView")).toHaveLength(0);
    hoisted.windowWidth = 455;
    expect(frameHeightOf(renderRow())).toBe(480);
  });

  it("shows the page inline with a full-size button once it is read", () => {
    hoisted.source = { status: "ready", html: "<p>page</p>" };
    const row = renderRow();
    const frames = collect(row, (element) => element.type === "HtmlRenderWebView");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.props).toMatchObject({
      html: "<p>page</p>",
      title: "Bundle size",
      variant: "inline",
      scrollable: false,
    });
    expect(frameHeightOf(row)).toBe(520);
    expect(pressable(row, "Open Bundle size full size")).toBeDefined();
  });

  it("opens the page full screen with the page it already holds", () => {
    hoisted.source = { status: "ready", html: "<p>page</p>" };
    const row = renderRow();
    propsOf<{ onPress: () => void }>(pressable(row, "Open Bundle size full size")).onPress();
    expect(hoisted.openFullScreen).toHaveBeenCalledWith({
      environmentId,
      threadId,
      messageId,
      attachment,
      title: "Bundle size",
      html: "<p>page</p>",
    });
  });

  it("holds the box with a retry when the page cannot be read", () => {
    const retry = vi.fn();
    hoisted.source = { status: "failed", retry };
    const row = renderRow();
    expect(frameHeightOf(row)).toBe(520);
    const reload = pressable(row, "Reload Bundle size");
    expect(reload).toBeDefined();
    propsOf<{ onPress: () => void }>(reload).onPress();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(pressable(row, "Open Bundle size full size")).toBeUndefined();
  });

  it("asks before reading a large page", () => {
    const load = vi.fn();
    hoisted.source = { status: "idle", load };
    const row = renderRow({ sizeBytes: 12 * 1024 * 1024 });
    const button = pressable(row, "Load Bundle size");
    expect(button).toBeDefined();
    expect(propsOf<{ detail: string }>(button).detail).toBe("Tap to load 12.0 MB");
    propsOf<{ onPress: () => void }>(button).onPress();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("stays quiet while loading", () => {
    const row = renderRow();
    expect(
      collect(
        row,
        (element) => typeof (element.props as { onPress?: unknown }).onPress === "function",
      ),
    ).toHaveLength(0);
    expect(collect(row, (element) => element.type === "HtmlRenderLoadingIndicator")).toHaveLength(
      1,
    );
  });
});
