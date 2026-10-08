import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The page cards at the foot of a turn's reply, invoked as plain functions with
// React Native, expo-image and full screen mocked. What it proves: one card per
// page, in order, each showing the thumbnail for the app's appearance (from the
// validated data URL, kept out of the disk cache, whole and on the background
// it was captured on, so a wide or short page is never cropped) or a
// placeholder icon, and
// opening its page full screen without a page in hand, so full screen reads it.

const hoisted = vi.hoisted(() => ({
  scheme: "dark" as "dark" | "light" | null,
  open: vi.fn(),
}));

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  View: "View",
  useColorScheme: () => hoisted.scheme,
}));
vi.mock("expo-image", () => ({ Image: "Image" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../components/AppText", () => ({ AppText: "AppText" }));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#ffffff" }));
vi.mock("./HtmlRenderFullScreen", () => ({
  useHtmlRenderFullScreen: () => ({ open: hoisted.open, modal: "own-modal" }),
}));

import type { ChatFileAttachment } from "@ryco/client-runtime/state/threads";
import { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { defaultHtmlRenderTheme, readHtmlRenderMetadata } from "@ryco/shared/htmlRender";

import {
  HTML_RENDER_CARD_THUMBNAIL,
  HTML_RENDER_CARD_THUMBNAIL_BACKGROUND,
  HtmlRenderCards,
} from "./HtmlRenderCards";
import type { TurnHtmlRender } from "./threadActivityFold";

function isElement(value: unknown): value is ReactElement {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}

function expand(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expand);
  if (!isElement(node)) return node;
  if (typeof node.type === "function") {
    return expand((node.type as (props: unknown) => unknown)(node.props));
  }
  const props = node.props as { children?: unknown };
  return { ...node, props: { ...props, children: expand(props.children) } };
}

function collect(node: unknown, predicate: (element: ReactElement) => boolean): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap((child) => collect(child, predicate));
  if (!isElement(node)) return [];
  const own = predicate(node) ? [node] : [];
  return [...own, ...collect((node.props as { children?: unknown }).children, predicate)];
}

const DARK = "data:image/webp;base64,ZGFyaw==";
const LIGHT = "data:image/png;base64,bGlnaHQ=";

function turnRender(
  messageId: string,
  attachmentId: string,
  htmlRender: Record<string, unknown>,
): TurnHtmlRender {
  const attachment: ChatFileAttachment = {
    type: "file",
    id: attachmentId,
    name: `${attachmentId}.html`,
    mimeType: "text/html",
    sizeBytes: 4096,
    htmlRender: htmlRender as ChatFileAttachment["htmlRender"],
  };
  return {
    messageId: MessageId.make(messageId),
    attachment,
    htmlRender: readHtmlRenderMetadata(htmlRender)!,
  };
}

const renders = [
  turnRender("render-1", "chart-html", {
    title: "Bundle size",
    height: 420,
    thumbnails: { dark: DARK, light: LIGHT },
  }),
  turnRender("render-2", "mock-html", { title: "Settings mockup", height: 600 }),
];

function renderCards() {
  return expand(
    HtmlRenderCards({
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      renders,
    }),
  );
}

function cards(tree: unknown) {
  return collect(tree, (element) => element.type === "Pressable");
}

beforeEach(() => {
  hoisted.scheme = "dark";
  hoisted.open.mockClear();
});

describe("HtmlRenderCards", () => {
  it("lists each page by title, in order", () => {
    const tree = renderCards();
    expect(
      cards(tree).map((card) => (card.props as { accessibilityLabel: string }).accessibilityLabel),
    ).toEqual(["Open Bundle size", "Open Settings mockup"]);
    expect(
      collect(tree, (element) => (element.props as { children?: unknown }).children === "Open"),
    ).toHaveLength(2);
  });

  it("shows the thumbnail for the app's appearance, sized before it loads", () => {
    const images = () => collect(renderCards(), (element) => element.type === "Image");
    expect(images()).toHaveLength(1);
    expect(images()[0]?.props).toMatchObject({
      source: { uri: DARK },
      style: HTML_RENDER_CARD_THUMBNAIL,
      cachePolicy: "none",
    });
    hoisted.scheme = "light";
    expect(images()[0]?.props).toMatchObject({ source: { uri: LIGHT } });
  });

  it("shows a thumbnail whole, from its top-left corner, on the background it was captured on", () => {
    // Thumbnails are as wide as the box's ratio or wider (a page shorter than
    // the tallest capture), so filling the box would crop the page's sides.
    const boxes = () =>
      collect(
        renderCards(),
        (element) =>
          element.type === "View" &&
          collect((element.props as { children?: unknown }).children, (child) =>
            ["Image", "SymbolView"].includes(String(child.type)),
          ).length > 0 &&
          (element.props as { className?: string }).className?.includes("rounded-lg") === true,
      ).map((box) => box.props as { style: unknown; className: string });
    const image = collect(renderCards(), (element) => element.type === "Image")[0];
    expect(image?.props).toMatchObject({ contentFit: "contain", contentPosition: "top left" });

    const [withThumbnail, placeholder] = boxes();
    expect(Object.assign({}, ...[withThumbnail?.style].flat())).toEqual({
      ...HTML_RENDER_CARD_THUMBNAIL,
      backgroundColor: defaultHtmlRenderTheme("dark").variables["--background"],
    });
    expect(placeholder?.className).toContain("bg-subtle");
    expect(Object.assign({}, ...[placeholder?.style].flat())).toEqual(HTML_RENDER_CARD_THUMBNAIL);

    hoisted.scheme = "light";
    expect(Object.assign({}, ...[boxes()[0]?.style].flat())).toMatchObject({
      backgroundColor: HTML_RENDER_CARD_THUMBNAIL_BACKGROUND.light,
    });
    expect(HTML_RENDER_CARD_THUMBNAIL_BACKGROUND.light).toBe(
      defaultHtmlRenderTheme("light").variables["--background"],
    );
  });

  it("falls back to the other appearance's thumbnail, then to an icon", () => {
    const onlyDark = turnRender("render-3", "dark-html", {
      title: "Dark only",
      height: 300,
      thumbnails: { dark: DARK },
    });
    hoisted.scheme = "light";
    const tree = expand(
      HtmlRenderCards({
        environmentId: EnvironmentId.make("env-1"),
        threadId: ThreadId.make("thread-1"),
        renders: [onlyDark, renders[1]!],
      }),
    );
    expect(
      collect(tree, (element) => element.type === "Image").map(
        (image) => (image.props as { source: { uri: string } }).source.uri,
      ),
    ).toEqual([DARK]);
    expect(collect(tree, (element) => element.type === "SymbolView")).toHaveLength(1);
  });

  it("never shows a thumbnail that is not a validated image data URL", () => {
    const hostile = turnRender("render-4", "x-html", {
      title: "Hostile",
      height: 300,
      thumbnails: { dark: "https://tracker.example/pixel.png", light: "javascript:alert(1)" },
    });
    const tree = expand(
      HtmlRenderCards({
        environmentId: EnvironmentId.make("env-1"),
        threadId: ThreadId.make("thread-1"),
        renders: [hostile],
      }),
    );
    expect(collect(tree, (element) => element.type === "Image")).toHaveLength(0);
    expect(collect(tree, (element) => element.type === "SymbolView")).toHaveLength(1);
  });

  it("opens the page full screen, which reads it", () => {
    const [first, second] = cards(renderCards());
    (second!.props as { onPress: () => void }).onPress();
    expect(hoisted.open).toHaveBeenCalledWith({
      environmentId: "env-1",
      threadId: "thread-1",
      messageId: "render-2",
      attachment: renders[1]!.attachment,
      title: "Settings mockup",
    });
    (first!.props as { onPress: () => void }).onPress();
    expect(hoisted.open.mock.calls[1]?.[0]).toMatchObject({ messageId: "render-1" });
  });

  it("hosts full screen itself outside the feed's provider", () => {
    expect(JSON.stringify(renderCards())).toContain("own-modal");
  });
});
