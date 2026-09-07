import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The thread message renderer, invoked as a plain function with react-native
// mocked (same shape as SettingsHubRouteScreen.test.tsx — no React renderer
// exists in this suite). What it proves: file attachments render a tappable
// row that hands the preview URL to the platform share sheet, video file
// attachments render an inline native video row that keeps a share affordance,
// image attachments reserve an aspect-ratio slot only when the server probed
// dimensions, while unknown attachments stay inert.

const hoisted = vi.hoisted(() => ({
  share: vi.fn(async (_input: unknown) => undefined),
  player: {
    replace: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    playing: false,
    duration: 20,
    currentTime: 0,
  },
}));

vi.mock("react-native", () => ({
  Image: "Image",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Share: { share: hoisted.share },
  View: "View",
}));
vi.mock("expo", () => ({ useEvent: () => null }));
vi.mock("expo-linking", () => ({ openURL: async () => undefined }));
vi.mock("expo-video", () => ({
  useVideoPlayer: () => hoisted.player,
  VideoView: "VideoView",
}));
vi.mock("../../components/AppText", () => ({ AppText: "AppText" }));
vi.mock("../../lib/appearancePreferences", () => ({
  resolveNativeMarkdownTypography: () => ({
    fontSize: 16,
    lineHeight: 22,
    headingFontSizes: {},
  }),
}));
vi.mock("../../lib/useFontFamily", () => ({ useFontFamily: () => "DMSans-Regular" }));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#ffffff" }));
vi.mock("../settings/appearance/useScaledTextRole", () => ({
  useScaledTextRole: () => ({ fontSize: 16 }),
}));
vi.mock("../../native/SelectableMarkdownText", () => ({
  hasNativeSelectableMarkdownText: () => false,
  SelectableMarkdownText: "SelectableMarkdownText",
}));

import { ThreadMessage } from "./ThreadMessage";
import type { ChatAttachment, ChatMessage } from "@ryco/client-runtime/state/threads";

function isElement(value: unknown): value is ReactElement {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "props" in value &&
    !Array.isArray(value)
  );
}

const MAX_WALK_DEPTH = 24;

function walkTree(node: unknown, visit: (element: ReactElement) => void, depth = 0): void {
  if (!isElement(node) || depth > MAX_WALK_DEPTH) return;
  visit(node);
  if (typeof node.type === "function") {
    walkTree((node.type as (props: unknown) => unknown)(node.props), visit, depth + 1);
    return;
  }
  const children = (node.props as { children?: unknown }).children;
  if (Array.isArray(children)) {
    for (const child of children) walkTree(child, visit, depth + 1);
  } else {
    walkTree(children, visit, depth + 1);
  }
}

function collectElements(
  tree: ReactElement,
  predicate: (element: ReactElement) => boolean,
): ReactElement[] {
  const found: ReactElement[] = [];
  walkTree(tree, (element) => {
    if (predicate(element)) found.push(element);
  });
  return found;
}

function findPressables(tree: ReactElement | null): ReactElement[] {
  if (tree === null) return [];
  return collectElements(tree, (element) => element.type === "Pressable");
}

function pressableLabel(pressable: ReactElement): string | undefined {
  return (pressable.props as { accessibilityLabel?: string }).accessibilityLabel;
}

function renderMessage(attachments: ChatAttachment[]): ReactElement {
  return ThreadMessage({
    message: {
      id: "m-1",
      role: "user",
      text: "here",
      attachments,
      streaming: false,
    } as unknown as ChatMessage,
  });
}

describe("ThreadMessage attachment rows", () => {
  beforeEach(() => {
    hoisted.share.mockClear();
  });

  it("renders audio playback controls and a share fallback", () => {
    const tree = renderMessage([
      {
        type: "file",
        id: "audio",
        name: "voice.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: 30,
        previewUrl: "http://node.local/attachments/audio",
      },
    ]);
    const buttons = findPressables(tree);
    const play = buttons.find((button) => pressableLabel(button) === "Play audio");
    expect(play).toBeDefined();
    (play!.props as { onPress: () => void }).onPress();
    expect(hoisted.player.play).toHaveBeenCalledTimes(1);
    expect(buttons.some((button) => pressableLabel(button) === "Share voice.mp3")).toBe(true);
  });

  it("renders a tappable row for a file attachment that shares its preview URL", async () => {
    const previewUrl = "http://node.local/attachments/att-1";
    const tree = renderMessage([
      {
        type: "file",
        id: "att-1",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2048,
        previewUrl,
      },
    ]);

    const pressables = findPressables(tree);
    const openRow = pressables.find((p) => pressableLabel(p) === "Open report.pdf");
    expect(openRow).toBeDefined();

    const onPress = (openRow!.props as { onPress: () => Promise<void> }).onPress;
    await onPress();
    expect(hoisted.share).toHaveBeenCalledWith({ url: previewUrl });
  });

  it("renders an inert row when a file attachment has no preview URL", () => {
    const tree = renderMessage([
      {
        type: "file",
        id: "att-1",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2048,
      },
    ]);
    expect(
      findPressables(tree).find((p) => pressableLabel(p) === "Open report.pdf"),
    ).toBeUndefined();
  });

  it("renders an unknown attachment without a tappable row", () => {
    const tree = renderMessage([
      {
        type: "future-kind",
        name: "mystery",
        mimeType: "application/x-mystery",
        sizeBytes: 12,
      },
    ]);
    expect(findPressables(tree)).toHaveLength(0);
  });

  it("renders an image attachment without a pressable row", () => {
    const tree = renderMessage([
      {
        type: "image",
        id: "att-2",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 2048,
        previewUrl: "http://node.local/attachments/att-2",
      },
    ]);
    expect(findPressables(tree)).toHaveLength(0);
  });

  it("reserves an aspect-ratio slot for an image with probed dimensions", () => {
    const tree = renderMessage([
      {
        type: "image",
        id: "att-2",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 2048,
        previewUrl: "http://node.local/attachments/att-2",
        width: 640,
        height: 480,
      },
    ]);
    const images = collectElements(tree, (element) => element.type === "Image");
    expect(images).toHaveLength(1);
    const style = (images[0]!.props as { style?: Record<string, number> }).style;
    expect(style).toEqual({ width: 144, aspectRatio: 640 / 480 });
  });

  it("keeps the fixed-size image slot when dimensions are absent", () => {
    const tree = renderMessage([
      {
        type: "image",
        id: "att-2",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 2048,
        previewUrl: "http://node.local/attachments/att-2",
      },
    ]);
    const images = collectElements(tree, (element) => element.type === "Image");
    expect(images).toHaveLength(1);
    expect((images[0]!.props as { style?: unknown }).style).toBeUndefined();
  });

  it("renders an inline video row with native controls and a share affordance", async () => {
    const previewUrl = "http://node.local/attachments/att-3";
    const tree = renderMessage([
      {
        type: "file",
        id: "att-3",
        name: "demo.mp4",
        mimeType: "video/mp4",
        sizeBytes: 4096,
        previewUrl,
      },
    ]);

    const videoViews = collectElements(tree, (element) => element.type === "VideoView");
    expect(videoViews).toHaveLength(1);
    expect((videoViews[0]!.props as { player: unknown }).player).toBe(hoisted.player);
    expect((videoViews[0]!.props as { nativeControls?: boolean }).nativeControls).toBe(true);

    const openRow = findPressables(tree).find((p) => pressableLabel(p) === "Open demo.mp4");
    expect(openRow).toBeDefined();
    const onPress = (openRow!.props as { onPress: () => Promise<void> }).onPress;
    await onPress();
    expect(hoisted.share).toHaveBeenCalledWith({ url: previewUrl });
  });

  it("falls back to a 16:9 video slot when dimensions are unknown", () => {
    const tree = renderMessage([
      {
        type: "file",
        id: "att-3",
        name: "demo.mp4",
        mimeType: "video/mp4",
        sizeBytes: 4096,
        previewUrl: "http://node.local/attachments/att-3",
      },
    ]);
    const videoViews = collectElements(tree, (element) => element.type === "VideoView");
    expect(videoViews).toHaveLength(1);
    const slots = collectElements(
      tree,
      (element) =>
        element.type === "View" &&
        typeof (element.props as { style?: { aspectRatio?: number } }).style?.aspectRatio ===
          "number",
    );
    expect(slots).toHaveLength(1);
    expect((slots[0]!.props as { style: { aspectRatio: number } }).style.aspectRatio).toBeCloseTo(
      16 / 9,
    );
  });

  it("uses probed dimensions for the video slot when present", () => {
    const tree = renderMessage([
      {
        type: "file",
        id: "att-3",
        name: "demo.mp4",
        mimeType: "video/mp4",
        sizeBytes: 4096,
        previewUrl: "http://node.local/attachments/att-3",
        width: 1920,
        height: 1080,
      },
    ]);
    const slots = collectElements(
      tree,
      (element) =>
        element.type === "View" &&
        typeof (element.props as { style?: { aspectRatio?: number } }).style?.aspectRatio ===
          "number",
    );
    expect(slots).toHaveLength(1);
    expect((slots[0]!.props as { style: { aspectRatio: number } }).style.aspectRatio).toBeCloseTo(
      1920 / 1080,
    );
  });

  it("keeps a non-video file attachment out of the video rows", () => {
    const tree = renderMessage([
      {
        type: "file",
        id: "att-1",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2048,
        previewUrl: "http://node.local/attachments/att-1",
      },
    ]);
    expect(collectElements(tree, (element) => element.type === "VideoView")).toHaveLength(0);
    expect(findPressables(tree).find((p) => pressableLabel(p) === "Open report.pdf")).toBeDefined();
  });
});
