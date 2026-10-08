import {
  defaultHtmlRenderTheme,
  HTML_RENDER_DOCUMENT_CSP,
  htmlRenderResult,
  htmlRenderThemeMessage,
  htmlRenderThemeWindowName,
} from "@ryco/shared/htmlRender";
import { describe, expect, it } from "vite-plus/test";

import { escapeHtmlAttributeValue } from "../files/htmlPreview";
import {
  buildHtmlRenderDocument,
  createHtmlRenderLinkGate,
  HTML_RENDER_FRAME_SANDBOX,
  HTML_RENDER_LINK_TAP_WINDOW_MS,
  HTML_RENDER_ORIGIN_WHITELIST,
  HTML_RENDER_TAP_MAX_MS,
  HTML_RENDER_TAP_SLOP,
  htmlRenderPostScript,
  isAllowedHtmlRenderNavigation,
  parseHtmlRenderBridgeMessage,
} from "./htmlRenderDocument";

const theme = defaultHtmlRenderTheme("dark");

function build(html: string, overrides: { title?: string; zoomable?: boolean } = {}) {
  return buildHtmlRenderDocument({
    html,
    title: overrides.title ?? "Bundle size",
    theme,
    zoomable: overrides.zoomable ?? false,
  });
}

describe("buildHtmlRenderDocument", () => {
  const document = build("<!doctype html><h1>Hi</h1><script>draw()</script>");

  it("frames the page with exactly the scripts-and-forms sandbox", () => {
    expect(HTML_RENDER_FRAME_SANDBOX).toBe("allow-scripts allow-forms");
    expect(document).toContain(' sandbox="allow-scripts allow-forms" ');
    expect(document.match(/sandbox="([^"]*)"/g)).toEqual(['sandbox="allow-scripts allow-forms"']);
    for (const token of [
      "allow-same-origin",
      "allow-popups",
      "allow-modals",
      "allow-top-navigation",
      "allow-downloads",
    ]) {
      expect(document).not.toContain(token);
    }
  });

  it("never lets the page be the top-level document", () => {
    expect(document).toContain(
      'srcdoc="&lt;!doctype html&gt;&lt;h1&gt;Hi&lt;/h1&gt;&lt;script&gt;draw()&lt;/script&gt;"',
    );
    expect(document).not.toContain("<h1>");
    // The relay is the only script of the wrapper.
    expect(document.split("<script>")).toHaveLength(2);
  });

  it("keeps a breakout attempt inside the srcdoc value", () => {
    const hostile = `"></iframe><script>parent.__rycoPost=1</script><iframe src="https://example.test">`;
    const wrapped = build(hostile);
    expect(wrapped.split("<iframe")).toHaveLength(2);
    expect(wrapped.split("</iframe>")).toHaveLength(2);
    expect(wrapped.split("<script>")).toHaveLength(2);
    expect(wrapped).toContain(`srcdoc="${escapeHtmlAttributeValue(hostile)}"`);
  });

  it("hands the page its theme in the escaped frame name", () => {
    const name = htmlRenderThemeWindowName(theme);
    expect(name).toContain('"');
    expect(document).toContain(` name="${escapeHtmlAttributeValue(name)}"`);
    const hostileTitle = `"><script>alert(1)</script>`;
    const titled = build("<p>x</p>", { title: hostileTitle });
    expect(titled).toContain(` title="${escapeHtmlAttributeValue(hostileTitle)}"`);
    expect(titled.split("<script>")).toHaveLength(2);
  });

  it("applies the render document policy, which a srcdoc frame inherits", () => {
    expect(document).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttributeValue(HTML_RENDER_DOCUMENT_CSP)}">`,
    );
  });

  it("matches the frame's color scheme to the theme so the frame never flashes", () => {
    expect(document).toContain('<meta name="color-scheme" content="dark">');
    const light = buildHtmlRenderDocument({
      html: "",
      title: "t",
      theme: defaultHtmlRenderTheme("light"),
      zoomable: false,
    });
    expect(light).toContain('<meta name="color-scheme" content="light">');
  });

  it("relays only the frame's size reports and link requests to native", () => {
    expect(document).toContain("window.__rycoPost=function(m)");
    expect(document).toContain("e.source!==w");
    expect(document).toContain('"ui/notifications/size-changed":1,"ui/open-link":1');
  });

  it("lets only the full-screen page zoom", () => {
    expect(document).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">',
    );
    expect(build("", { zoomable: true })).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
  });

  it("carries no base URL", () => {
    expect(document).not.toContain("<base");
  });
});

describe("isAllowedHtmlRenderNavigation", () => {
  it("routes every load through the predicate instead of the system", () => {
    expect(HTML_RENDER_ORIGIN_WHITELIST).toEqual(["*"]);
  });

  it("keeps the top frame on the wrapper", () => {
    expect(isAllowedHtmlRenderNavigation({ url: "about:blank", isTopFrame: true })).toBe(true);
    expect(isAllowedHtmlRenderNavigation({ url: "", isTopFrame: true })).toBe(true);
    for (const url of [
      "https://example.test/",
      "http://127.0.0.1:4141/attachments/x",
      "data:text/html,<b>x</b>",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "ryco-dev://pair",
    ]) {
      expect(isAllowedHtmlRenderNavigation({ url, isTopFrame: true }), url).toBe(false);
      // Android reports no frame; an unknown frame is the top frame.
      expect(isAllowedHtmlRenderNavigation({ url }), url).toBe(false);
    }
  });

  it("lets the page and its embeds load in subframes, never custom schemes", () => {
    expect(isAllowedHtmlRenderNavigation({ url: "about:srcdoc", isTopFrame: false })).toBe(true);
    expect(
      isAllowedHtmlRenderNavigation({ url: "https://www.example.test/embed", isTopFrame: false }),
    ).toBe(true);
    expect(isAllowedHtmlRenderNavigation({ url: "data:text/html,x", isTopFrame: false })).toBe(
      true,
    );
    for (const url of [
      "tel:123",
      "itms-apps://x",
      "ryco://pair",
      "file:///etc/passwd",
      "javascript:1",
    ]) {
      expect(isAllowedHtmlRenderNavigation({ url, isTopFrame: false }), url).toBe(false);
    }
  });
});

describe("parseHtmlRenderBridgeMessage", () => {
  const size = (params: unknown) =>
    JSON.stringify({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params });
  const link = (id: unknown, url: unknown) =>
    JSON.stringify({ jsonrpc: "2.0", id, method: "ui/open-link", params: { url } });

  it.each([
    ["a size report", size({ height: 412.2 }), { kind: "content-height", height: 413 }],
    [
      "an http(s) link request",
      link("ryco-link-1", "https://example.test/a?b=1"),
      { kind: "open-link", id: "ryco-link-1", url: "https://example.test/a?b=1" },
    ],
    [
      "a numeric request id",
      link(7, "http://example.test"),
      { kind: "open-link", id: 7, url: "http://example.test" },
    ],
  ])("accepts %s", (_name, data, expected) => {
    expect(parseHtmlRenderBridgeMessage(data)).toEqual(expected);
  });

  it.each([
    ["non-JSON", "not json"],
    ["a non-string payload", { jsonrpc: "2.0" }],
    ["another method", JSON.stringify({ jsonrpc: "2.0", method: "ui/initialize", params: {} })],
    [
      "a missing jsonrpc version",
      JSON.stringify({ method: "ui/notifications/size-changed", params: { height: 10 } }),
    ],
    ["a zero height", size({ height: 0 })],
    ["a negative height", size({ height: -5 })],
    ["a non-numeric height", size({ height: "100" })],
    ["a javascript: link", link("x", "javascript:alert(1)")],
    ["a custom-scheme link", link("x", "ryco://pair")],
    ["a relative link", link("x", "/attachments/a")],
    ["a link with credentials", link("x", "https://user:pass@example.test/")],
    ["a link without an id", link(undefined, "https://example.test/")],
    ["an oversized request id", link("x".repeat(129), "https://example.test/")],
    ["an oversized payload", link("x", `https://example.test/${"a".repeat(20_000)}`)],
  ])("ignores %s", (_name, data) => {
    expect(parseHtmlRenderBridgeMessage(data)).toBeUndefined();
  });
});

describe("createHtmlRenderLinkGate", () => {
  const finger = (pageX: number, pageY: number, fingers: number) => ({
    pageX,
    pageY,
    touches: Array.from({ length: fingers }),
  });
  /** One finger down at (x, y) at `at`, up at (x + dx, y + dy) after `heldFor`. */
  function tap(
    gate: ReturnType<typeof createHtmlRenderLinkGate>,
    at: number,
    { dx = 0, dy = 0, heldFor = 80 } = {},
  ) {
    gate.touchStart(finger(100, 200, 1), at);
    gate.touchEnd(finger(100 + dx, 200 + dy, 0), at + heldFor);
    return at + heldFor;
  }

  it("lets a page open one link right after the reader's tap", () => {
    const gate = createHtmlRenderLinkGate();
    expect(gate.consume(5_000)).toBe(false);
    const upAt = tap(gate, 5_000);
    expect(gate.consume(upAt + 50)).toBe(true);
    // One tap, one link.
    expect(gate.consume(upAt + 60)).toBe(false);

    const again = tap(gate, 9_000);
    expect(gate.consume(again + HTML_RENDER_LINK_TAP_WINDOW_MS)).toBe(true);
    const late = tap(gate, 12_000);
    expect(gate.consume(late + HTML_RENDER_LINK_TAP_WINDOW_MS + 1)).toBe(false);
    // A clock that went backwards is not a recent tap.
    const skewed = tap(gate, 15_000);
    expect(gate.consume(skewed - 1_000)).toBe(false);
  });

  it("grants nothing for a touch that only starts", () => {
    const gate = createHtmlRenderLinkGate();
    gate.touchStart(finger(100, 200, 1), 5_000);
    expect(gate.consume(5_050)).toBe(false);
  });

  it("grants nothing for a scroll or a drag that starts on the page", () => {
    const moved = createHtmlRenderLinkGate();
    moved.touchStart(finger(100, 200, 1), 5_000);
    moved.touchMove(finger(100, 200 - HTML_RENDER_TAP_SLOP - 1, 1), 5_030);
    // Even a finger that comes back to where it landed.
    moved.touchEnd(finger(100, 200, 0), 5_090);
    expect(moved.consume(5_100)).toBe(false);

    const lifted = createHtmlRenderLinkGate();
    tap(lifted, 5_000, { dy: -40 });
    expect(lifted.consume(5_100)).toBe(false);

    // The feed's scroll view takes the gesture.
    const cancelled = createHtmlRenderLinkGate();
    cancelled.touchStart(finger(100, 200, 1), 5_000);
    cancelled.touchCancel();
    expect(cancelled.consume(5_050)).toBe(false);
  });

  it("allows a tap's small wobble", () => {
    const gate = createHtmlRenderLinkGate();
    gate.touchStart(finger(100, 200, 1), 5_000);
    gate.touchMove(finger(104, 203, 1), 5_030);
    gate.touchEnd(finger(106, 206, 0), 5_080);
    expect(gate.consume(5_100)).toBe(true);
  });

  it("grants nothing for a long press", () => {
    const gate = createHtmlRenderLinkGate();
    const upAt = tap(gate, 5_000, { heldFor: HTML_RENDER_TAP_MAX_MS + 1 });
    expect(gate.consume(upAt + 10)).toBe(false);
  });

  it("grants nothing for a pinch", () => {
    const gate = createHtmlRenderLinkGate();
    gate.touchStart(finger(100, 200, 1), 5_000);
    gate.touchStart(finger(160, 260, 2), 5_010);
    gate.touchEnd(finger(160, 260, 1), 5_060);
    gate.touchEnd(finger(100, 200, 0), 5_070);
    expect(gate.consume(5_080)).toBe(false);
  });

  it("withdraws a tap when the next touch starts", () => {
    const gate = createHtmlRenderLinkGate();
    const upAt = tap(gate, 5_000);
    // A scroll starts before the page asks.
    gate.touchStart(finger(100, 200, 1), upAt + 20);
    expect(gate.consume(upAt + 40)).toBe(false);
  });

  it("recovers from a touch whose end never arrived", () => {
    const gate = createHtmlRenderLinkGate();
    gate.touchStart(finger(100, 200, 1), 5_000);
    const upAt = tap(gate, 8_000);
    expect(gate.consume(upAt + 10)).toBe(true);
  });
});

describe("htmlRenderPostScript", () => {
  it("posts the message through the wrapper's relay", () => {
    const message = htmlRenderThemeMessage(theme);
    expect(htmlRenderPostScript(message)).toBe(
      `window.__rycoPost&&window.__rycoPost(${JSON.stringify(message)});true;`,
    );
  });

  it("keeps a page-chosen request id a string literal", () => {
    const script = htmlRenderPostScript(htmlRenderResult(`");alert(1);//\u2028`));
    expect(script).toBe(
      'window.__rycoPost&&window.__rycoPost({"jsonrpc":"2.0","id":"\\");alert(1);//\\u2028","result":{}});true;',
    );
  });
});
