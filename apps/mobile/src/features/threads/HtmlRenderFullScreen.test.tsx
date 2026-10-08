import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Full screen for an HTML render, rendered through a minimal hook runtime
// (state slots that survive re-renders; no React renderer exists in this
// suite) with React Native, the WebView, the page source and the share sheet
// mocked. What it proves: a row opens full screen through the feed's provider
// or a modal of its own; a page the row holds shows at once and one it does not
// is read whatever its size; Source shows the agent's markup over the page,
// which stays mounted and out of a screen reader's reach under it; Share hands
// the shown page to the share sheet once at a time and says so when it fails;
// and Done closes, letting the page go once the modal is gone (at once on
// Android, which never reports that).

const hoisted = vi.hoisted(() => ({
  os: "ios" as "ios" | "android",
  runtime: { slots: [] as unknown[], index: 0 },
  provided: null as null | ((request: unknown) => void),
  source: { status: "loading" } as Record<string, unknown>,
  sourceInputs: [] as unknown[],
  share: vi.fn(async (_input: { html: string; title: string }) => undefined),
  alert: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { runtime } = hoisted;
  return {
    ...actual,
    use: () => hoisted.provided,
    useState: <T,>(initial: T | (() => T)) => {
      const slot = runtime.index++;
      if (!(slot in runtime.slots)) {
        runtime.slots[slot] = typeof initial === "function" ? (initial as () => T)() : initial;
      }
      const set = (next: T | ((current: T) => T)) => {
        runtime.slots[slot] =
          typeof next === "function" ? (next as (current: T) => T)(runtime.slots[slot] as T) : next;
      };
      return [runtime.slots[slot] as T, set] as const;
    },
    useCallback: <T,>(callback: T) => callback,
    useMemo: <T,>(factory: () => T) => factory(),
  };
});
vi.mock("react-native", () => ({
  Alert: { alert: hoisted.alert },
  Platform: {
    get OS() {
      return hoisted.os;
    },
  },
  Modal: "Modal",
  Pressable: "Pressable",
  View: "View",
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("@legendapp/list/react-native", () => ({ LegendList: "LegendList" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../components/AppText", () => ({ AppText: "AppText" }));
vi.mock("../../lib/appearancePreferences", () => ({
  resolveMobileCodeSurface: (fontSize: number) => ({ fontSize, rowHeight: fontSize + 6 }),
}));
vi.mock("../../lib/htmlRenderTheme", async () => {
  const { defaultHtmlRenderTheme } = await import("@ryco/shared/htmlRender");
  const theme = defaultHtmlRenderTheme("dark");
  return { useMobileHtmlRenderTheme: () => theme };
});
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#ffffff" }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ appearance: { codeFontSize: 12 } }),
}));
vi.mock("./HtmlRenderWebView", () => ({
  HtmlRenderWebView: "HtmlRenderWebView",
  HtmlRenderLoadingIndicator: "HtmlRenderLoadingIndicator",
  HtmlRenderPagePlaceholder: "HtmlRenderPagePlaceholder",
}));
vi.mock("./htmlRenderShare", () => ({
  HTML_RENDER_SHARE_SUPPORTED: true,
  shareHtmlRender: hoisted.share,
}));
vi.mock("./useHtmlRenderSource", () => ({
  useHtmlRenderSource: (input: unknown) => {
    hoisted.sourceInputs.push(input);
    return hoisted.source;
  },
}));

import type { ChatFileAttachment } from "@ryco/client-runtime/state/threads";
import { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { injectHtmlRenderBootstrap } from "@ryco/shared/htmlRender";

import {
  HtmlRenderFullScreenProvider,
  useHtmlRenderFullScreen,
  type HtmlRenderFullScreenRequest,
} from "./HtmlRenderFullScreen";
import { HTML_RENDER_SOURCE_MAX_CHARS } from "./htmlRenderSourceLines";

function isElement(value: unknown): value is ReactElement {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}

/** The tree with every function component rendered, as a shallow renderer would. */
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

function byLabel(tree: unknown, label: string) {
  const found = collect(
    tree,
    (element) => (element.props as { accessibilityLabel?: string }).accessibilityLabel === label,
  )[0];
  if (found === undefined) throw new Error(`nothing labelled ${label}`);
  return found.props as {
    onPress: () => void;
    disabled?: boolean;
    accessibilityState?: { selected?: boolean; disabled?: boolean };
  };
}

/** Renders the hook's owner once; the slots carry state between calls. */
function renderOwner() {
  hoisted.runtime.index = 0;
  const handle = useHtmlRenderFullScreen();
  return { handle, modal: expand(handle.modal) as ReactElement | null };
}

const attachment: ChatFileAttachment = {
  type: "file",
  id: "thread-1-abc-html",
  name: "Bundle size.html",
  mimeType: "text/html",
  sizeBytes: 12 * 1024 * 1024,
  htmlRender: { title: "Bundle size", height: 420 },
};

const page = "<!doctype html>\n<html><head><title>t</title></head>\n<body>chart</body></html>";

function request(extra: Partial<HtmlRenderFullScreenRequest> = {}): HtmlRenderFullScreenRequest {
  return {
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make("message-1"),
    attachment,
    title: "Bundle size",
    ...extra,
  };
}

/** Opens full screen for `input` and returns a function rendering the modal again. */
function openFullScreen(input: HtmlRenderFullScreenRequest) {
  renderOwner().handle.open(input);
  return () => renderOwner().modal!;
}

beforeEach(() => {
  hoisted.os = "ios";
  hoisted.runtime.slots = [];
  hoisted.provided = null;
  hoisted.source = { status: "loading" };
  hoisted.sourceInputs = [];
  hoisted.share.mockReset();
  hoisted.share.mockResolvedValue(undefined);
  hoisted.alert.mockClear();
});

describe("useHtmlRenderFullScreen", () => {
  it("opens through the feed's provider when there is one", () => {
    const provided = vi.fn();
    hoisted.provided = provided;
    const { handle } = renderOwner();
    expect(handle.open).toBe(provided);
    expect(handle.modal).toBeNull();
  });

  it("brings a modal of its own outside a provider, closed until opened", () => {
    const closed = renderOwner().modal!;
    expect(closed.type).toBe("Modal");
    expect(closed.props).toMatchObject({ visible: false, presentationStyle: "fullScreen" });

    const render = openFullScreen(request({ html: injectHtmlRenderBootstrap(page) }));
    expect(render().props).toMatchObject({ visible: true });
  });

  it("closes on Done, and on the system back gesture", () => {
    const render = openFullScreen(request({ html: page }));
    byLabel(render(), "Close Bundle size").onPress();
    expect(render().props).toMatchObject({ visible: false });

    renderOwner().handle.open(request({ html: page }));
    (render().props as { onRequestClose: () => void }).onRequestClose();
    expect(render().props).toMatchObject({ visible: false });
  });

  it("keeps the page through the closing slide, then lets it go", () => {
    const render = openFullScreen(request({ html: page }));
    const dismiss = () => (render().props as { onDismiss: () => void }).onDismiss();
    // Reopened before the last close finished: the page stays.
    dismiss();
    expect(collect(render(), (element) => element.type === "HtmlRenderWebView")).toHaveLength(1);

    byLabel(render(), "Close Bundle size").onPress();
    expect(collect(render(), (element) => element.type === "HtmlRenderWebView")).toHaveLength(1);
    dismiss();
    expect((render().props as { children: unknown }).children).toBeNull();
  });

  it("lets the page go as it closes on Android, which never reports the modal gone", () => {
    hoisted.os = "android";
    const render = openFullScreen(request({ html: page }));
    expect(collect(render(), (element) => element.type === "HtmlRenderWebView")).toHaveLength(1);
    byLabel(render(), "Close Bundle size").onPress();
    expect(render().props).toMatchObject({ visible: false, children: null });
    expect(hoisted.runtime.slots).not.toContainEqual(
      expect.objectContaining({ request: expect.anything() }),
    );

    // Reopened, it shows the page again.
    renderOwner().handle.open(request({ html: page }));
    expect(collect(render(), (element) => element.type === "HtmlRenderWebView")).toHaveLength(1);
  });
});

describe("HtmlRenderFullScreenProvider", () => {
  it("hands its rows the opener and hosts the one modal", () => {
    const element = HtmlRenderFullScreenProvider({ children: "feed" }) as ReactElement;
    const props = element.props as { value: unknown; children: unknown[] };
    expect(typeof props.value).toBe("function");
    expect(props.children[0]).toBe("feed");
    expect((props.children[1] as ReactElement).type).toBe("Modal");
  });
});

describe("HtmlRenderFullScreen", () => {
  it("shows a page the row holds at once, without reading it again", () => {
    const tree = openFullScreen(request({ html: page }))();
    const frames = collect(tree, (element) => element.type === "HtmlRenderWebView");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.props).toMatchObject({
      html: page,
      title: "Bundle size",
      variant: "fullScreen",
    });
    expect(hoisted.sourceInputs).toEqual([]);
  });

  it("reads a page it was not handed, however large", () => {
    const render = openFullScreen(request());
    let tree = render();
    expect(hoisted.sourceInputs.at(-1)).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
      messageId: "message-1",
      attachmentId: attachment.id,
      sizeBytes: attachment.sizeBytes,
      requested: true,
    });
    expect(collect(tree, (element) => element.type === "HtmlRenderLoadingIndicator")).toHaveLength(
      1,
    );
    // Source and Share wait for the page.
    expect(byLabel(tree, "Source").disabled).toBe(true);
    expect(byLabel(tree, "Share Bundle size").disabled).toBe(true);

    hoisted.source = { status: "ready", html: page };
    tree = render();
    expect(collect(tree, (element) => element.type === "HtmlRenderWebView")).toHaveLength(1);
    expect(byLabel(tree, "Source").disabled).toBe(false);
  });

  it("offers a retry when the page cannot be read", () => {
    const retry = vi.fn();
    hoisted.source = { status: "failed", retry };
    const tree = openFullScreen(request())();
    byLabel(tree, "Reload Bundle size").onPress();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("shows the agent's markup over the page, which stays mounted", () => {
    const render = openFullScreen(request({ html: injectHtmlRenderBootstrap(page) }));
    expect(collect(render(), (element) => element.type === "LegendList")).toHaveLength(0);

    byLabel(render(), "Source").onPress();
    const tree = render();
    expect(byLabel(tree, "Source").accessibilityState?.selected).toBe(true);
    expect(collect(tree, (element) => element.type === "HtmlRenderWebView")).toHaveLength(1);
    const list = collect(tree, (element) => element.type === "LegendList")[0]!;
    const { data, renderItem, ListHeaderComponent } = list.props as {
      data: string[];
      renderItem: (input: { item: string }) => ReactElement;
      ListHeaderComponent: unknown;
    };
    expect(data).toEqual(page.split("\n"));
    expect(ListHeaderComponent).toBeNull();
    const row = renderItem({ item: "<body>chart</body></html>" });
    expect(row.props).toMatchObject({
      selectable: true,
      style: { fontSize: 12, lineHeight: 18 },
      children: "<body>chart</body></html>",
    });
    expect((renderItem({ item: "" }).props as { children: string }).children).toBe(" ");

    byLabel(tree, "Source").onPress();
    expect(collect(render(), (element) => element.type === "LegendList")).toHaveLength(0);
  });

  it("keeps the page under the source out of a screen reader's reach", () => {
    const render = openFullScreen(request({ html: page }));
    const pageContainer = (tree: unknown) =>
      collect(
        tree,
        (element) =>
          collect((element.props as { children?: unknown }).children, (child) =>
            ["HtmlRenderWebView", "HtmlRenderPagePlaceholder"].includes(String(child.type)),
          ).length > 0 && "importantForAccessibility" in (element.props as object),
      )[0]?.props as Record<string, unknown> | undefined;
    expect(pageContainer(render())).toMatchObject({
      accessibilityElementsHidden: false,
      importantForAccessibility: "auto",
    });

    byLabel(render(), "Source").onPress();
    const tree = render();
    expect(pageContainer(tree)).toMatchObject({
      accessibilityElementsHidden: true,
      importantForAccessibility: "no-hide-descendants",
    });
    const overlay = collect(
      tree,
      (element) =>
        collect(
          (element.props as { children?: unknown }).children,
          (child) => child.type === "LegendList",
        ).length > 0 && (element.props as { className?: string }).className === "absolute inset-0",
    )[0];
    expect(overlay?.props).toMatchObject({ accessibilityViewIsModal: true });
  });

  it("says when the source shown is only the start of it", () => {
    const long = `<p>${"x".repeat(HTML_RENDER_SOURCE_MAX_CHARS)}</p>`;
    const render = openFullScreen(request({ html: long }));
    byLabel(render(), "Source").onPress();
    const list = collect(render(), (element) => element.type === "LegendList")[0]!;
    const header = (list.props as { ListHeaderComponent: ReactElement }).ListHeaderComponent;
    expect((header.props as { children: string }).children).toBe(
      "Showing the start of the source. Share the page for all of it.",
    );
  });

  it("shares the page shown, one share at a time", async () => {
    let finish: () => void = () => undefined;
    hoisted.share.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const html = injectHtmlRenderBootstrap(page);
    const render = openFullScreen(request({ html }));
    byLabel(render(), "Share Bundle size").onPress();
    expect(hoisted.share).toHaveBeenCalledWith({ html, title: "Bundle size" });
    expect(byLabel(render(), "Share Bundle size").disabled).toBe(true);
    byLabel(render(), "Share Bundle size").onPress();
    expect(hoisted.share).toHaveBeenCalledTimes(1);

    finish();
    await vi.waitFor(() => expect(byLabel(render(), "Share Bundle size").disabled).toBe(false));
    expect(hoisted.alert).not.toHaveBeenCalled();
  });

  it("says so when the page cannot be shared", async () => {
    hoisted.share.mockRejectedValueOnce(new Error("disk full"));
    const render = openFullScreen(request({ html: page }));
    byLabel(render(), "Share Bundle size").onPress();
    await vi.waitFor(() => expect(hoisted.alert).toHaveBeenCalledTimes(1));
    expect(hoisted.alert.mock.calls[0]?.[0]).toBe("Could not share the page");
    expect(byLabel(render(), "Share Bundle size").disabled).toBe(false);
  });
});
