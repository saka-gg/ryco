import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The thread message renderer, invoked as a plain function with react-native
// mocked (same shape as SettingsHubRouteScreen.test.tsx — no React renderer
// exists in this suite). What it proves: file attachments render a tappable
// row that hands the preview URL to the platform share sheet, video file
// attachments render an inline native video row that keeps a share affordance,
// image attachments reserve an aspect-ratio slot only when the server probed
// dimensions, while unknown attachments stay inert. An assistant's HTML render
// shows as the page itself (ThreadHtmlRender) instead of a share row, and a
// turn's settled reply lists the turn's pages at its foot (HtmlRenderCards).
// A message validates its render metadata once, not on every re-render.

const hoisted = vi.hoisted(() => ({
  /** The one `useMemo` slot ThreadMessage has, kept across renders like React keeps it. */
  memo: null as null | { deps: ReadonlyArray<unknown>; value: unknown },
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

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useMemo: <T,>(factory: () => T, deps: ReadonlyArray<unknown>): T => {
      const kept = hoisted.memo;
      if (
        kept !== null &&
        kept.deps.length === deps.length &&
        kept.deps.every((dep, index) => Object.is(dep, deps[index]))
      ) {
        return kept.value as T;
      }
      const value = factory();
      hoisted.memo = { deps, value };
      return value;
    },
  };
});
vi.mock("@ryco/shared/htmlRender", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ryco/shared/htmlRender")>();
  return { ...actual, htmlRenderOfAttachment: vi.fn(actual.htmlRenderOfAttachment) };
});
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
vi.mock("../../components/CopyTextButton", () => ({ CopyTextButton: "CopyTextButton" }));
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
vi.mock("./ThreadHtmlRender", () => ({ ThreadHtmlRender: "ThreadHtmlRender" }));
vi.mock("./HtmlRenderCards", () => ({ HtmlRenderCards: "HtmlRenderCards" }));

import { ThreadMessage } from "./ThreadMessage";
import type { ChatAttachment, ChatMessage } from "@ryco/client-runtime/state/threads";
import { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { htmlRenderOfAttachment } from "@ryco/shared/htmlRender";
import type { TurnHtmlRender } from "./threadActivityFold";

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");

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

function renderMessage(
  attachments: ChatAttachment[],
  overrides: Partial<Pick<ChatMessage, "role" | "text">> = {},
): ReactElement {
  return ThreadMessage({
    environmentId,
    threadId,
    message: {
      id: "m-1",
      role: "user",
      text: "here",
      attachments,
      streaming: false,
      ...overrides,
    } as unknown as ChatMessage,
  });
}

beforeEach(() => {
  hoisted.memo = null;
  vi.mocked(htmlRenderOfAttachment).mockClear();
});

describe("ThreadMessage attachment rows", () => {
  it("shows the sent timestamp and copies the original user text", () => {
    const text = "  Keep this text\nexactly as sent.  ";
    const createdAt = "2026-09-12T15:00:00.000Z";
    const tree = ThreadMessage({
      environmentId,
      threadId,
      message: {
        role: "user",
        text,
        createdAt,
        updatedAt: "2026-09-13T18:00:00.000Z",
      } as unknown as ChatMessage,
    });
    const copy = collectElements(tree, (element) => element.type === "CopyTextButton");
    expect(copy).toHaveLength(1);
    expect(copy[0]?.props).toMatchObject({ text, accessibilityLabel: "Copy message" });
    const sentLabel = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(createdAt));
    expect(
      collectElements(
        tree,
        (element) =>
          (element.props as { accessibilityLabel?: string }).accessibilityLabel ===
          `Sent ${sentLabel}`,
      ),
    ).toHaveLength(1);
  });

  it("does not add user-message controls to assistant messages", () => {
    const tree = ThreadMessage({
      environmentId,
      threadId,
      message: {
        role: "assistant",
        text: "Reply",
        createdAt: "2026-09-12T15:00:00.000Z",
      } as unknown as ChatMessage,
    });
    expect(collectElements(tree, (element) => element.type === "CopyTextButton")).toHaveLength(0);
    expect(
      collectElements(
        tree,
        (element) =>
          (element.props as { accessibilityLabel?: string }).accessibilityLabel?.startsWith(
            "Sent ",
          ) === true,
      ),
    ).toHaveLength(0);
  });

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

describe("ThreadMessage HTML renders", () => {
  const render: ChatAttachment = {
    type: "file",
    id: "thread-1-abc-html",
    name: "Bundle size.html",
    mimeType: "text/html",
    sizeBytes: 4096,
    previewUrl: "http://node.local/attachments/thread-1-abc-html",
    htmlRender: { title: "Bundle size", height: 420 },
  };

  beforeEach(() => {
    hoisted.share.mockClear();
  });

  it("shows an assistant's render as the page, not a share row", () => {
    const tree = renderMessage([render], { role: "assistant", text: " " });
    const renders = collectElements(tree, (element) => element.type === "ThreadHtmlRender");
    expect(renders).toHaveLength(1);
    expect(renders[0]?.props).toMatchObject({
      environmentId,
      threadId,
      messageId: "m-1",
      attachment: render,
      htmlRender: { title: "Bundle size", height: 420 },
    });
    expect(findPressables(tree)).toHaveLength(0);
    expect(collectElements(tree, (element) => element.type === "ScrollView")).toHaveLength(0);
    expect(hoisted.share).not.toHaveBeenCalled();
  });

  it("drops the placeholder body of an attachment delivery", () => {
    const tree = renderMessage([render], { role: "assistant", text: " " });
    expect(collectElements(tree, (element) => element.type === "AppText")).toHaveLength(0);
  });

  it("keeps a real reply next to the render", () => {
    const tree = renderMessage([render], { role: "assistant", text: "Here it is" });
    const texts = collectElements(tree, (element) => element.type === "AppText");
    expect(
      texts.some((text) => (text.props as { children?: unknown }).children === "Here it is"),
    ).toBe(true);
    expect(collectElements(tree, (element) => element.type === "ThreadHtmlRender")).toHaveLength(1);
  });

  it("keeps the other attachments of the message in their own rows", () => {
    const tree = renderMessage(
      [
        render,
        {
          type: "file",
          id: "att-1",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2048,
          previewUrl: "http://node.local/attachments/att-1",
        },
      ],
      { role: "assistant", text: " " },
    );
    expect(collectElements(tree, (element) => element.type === "ThreadHtmlRender")).toHaveLength(1);
    expect(findPressables(tree).map(pressableLabel)).toEqual(["Open report.pdf"]);
  });

  it("leaves an HTML file without render metadata as a file row", () => {
    const tree = renderMessage(
      [
        {
          type: "file",
          id: "att-4",
          name: "page.html",
          mimeType: "text/html",
          sizeBytes: 4096,
          previewUrl: "http://node.local/attachments/att-4",
        },
      ],
      { role: "assistant", text: " " },
    );
    expect(collectElements(tree, (element) => element.type === "ThreadHtmlRender")).toHaveLength(0);
    expect(findPressables(tree).map(pressableLabel)).toEqual(["Open page.html"]);
  });

  it("validates a render's metadata once, and not again while the message is unchanged", () => {
    // Fresh objects: reads are remembered per attachment object across tests.
    const page = { ...render } as ChatAttachment;
    const pdf: ChatAttachment = {
      type: "file",
      id: "att-1",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
      previewUrl: "http://node.local/attachments/att-1",
    };
    const message = {
      id: "m-1",
      role: "assistant",
      text: " ",
      attachments: [page, pdf],
      streaming: false,
    } as unknown as ChatMessage;
    const validationsOf = (attachment: ChatAttachment) =>
      vi.mocked(htmlRenderOfAttachment).mock.calls.filter(([input]) => input === attachment).length;

    ThreadMessage({ environmentId, threadId, message });
    expect(validationsOf(page)).toBe(1);
    expect(validationsOf(pdf)).toBe(1);

    // The feed re-renders the row as another message streams.
    const tree = ThreadMessage({ environmentId, threadId, message });
    expect(validationsOf(page)).toBe(1);
    expect(validationsOf(pdf)).toBe(1);
    expect(collectElements(tree, (element) => element.type === "ThreadHtmlRender")).toHaveLength(1);
    expect(findPressables(tree).map(pressableLabel)).toEqual(["Open report.pdf"]);
  });

  it("never runs a page attached to a user message", () => {
    const tree = renderMessage([render], { role: "user", text: "look" });
    expect(collectElements(tree, (element) => element.type === "ThreadHtmlRender")).toHaveLength(0);
    expect(findPressables(tree).map(pressableLabel)).toEqual(["Open Bundle size.html"]);
  });
});

describe("ThreadMessage page cards", () => {
  const turnHtmlRenders: ReadonlyArray<TurnHtmlRender> = [
    {
      messageId: MessageId.make("render-1"),
      attachment: {
        type: "file",
        id: "thread-1-abc-html",
        name: "Bundle size.html",
        mimeType: "text/html",
        sizeBytes: 4096,
        htmlRender: { title: "Bundle size", height: 420 },
      },
      htmlRender: { title: "Bundle size", height: 420 },
    },
  ];

  function renderReply(role: "assistant" | "user", renders = turnHtmlRenders) {
    return ThreadMessage({
      environmentId,
      threadId,
      message: { id: "m-1", role, text: "Here is the breakdown.", streaming: false } as never,
      turnHtmlRenders: renders,
    });
  }

  it("lists the turn's pages under the reply's text", () => {
    const tree = renderReply("assistant");
    const cards = collectElements(tree, (element) => element.type === "HtmlRenderCards");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.props).toEqual({ environmentId, threadId, renders: turnHtmlRenders });
    // The cards close the reply: they come after its text.
    const order: string[] = [];
    walkTree(tree, (element) => {
      if (element.type === "HtmlRenderCards") order.push("cards");
      if ((element.props as { children?: unknown }).children === "Here is the breakdown.") {
        order.push("text");
      }
    });
    expect(order).toEqual(["text", "cards"]);
  });

  it("lists nothing without pages, and never under a user's message", () => {
    expect(
      collectElements(
        renderReply("assistant", []),
        (element) => element.type === "HtmlRenderCards",
      ),
    ).toHaveLength(0);
    expect(
      collectElements(
        ThreadMessage({
          environmentId,
          threadId,
          message: { id: "m-1", role: "assistant", text: "Hi", streaming: false } as never,
        }),
        (element) => element.type === "HtmlRenderCards",
      ),
    ).toHaveLength(0);
    expect(
      collectElements(renderReply("user"), (element) => element.type === "HtmlRenderCards"),
    ).toHaveLength(0);
  });
});
