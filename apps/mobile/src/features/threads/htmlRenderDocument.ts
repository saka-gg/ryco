// The wrapper document an agent HTML render's WebView loads, the bridge between
// the page and React Native, and the navigation rule that keeps the WebView on
// the wrapper. Pure string work, free of React Native, so the containment
// argument below can be checked in node.
//
// The page runs scripts (charts, interaction), so this is not the no-script
// shell `features/files/htmlPreview.ts` builds for workspace files. Its locks:
//
//   1. The page is never the top-level document. It is the `srcdoc` of an
//      iframe sandboxed with exactly `allow-scripts allow-forms`, so it gets a
//      unique opaque origin: no cookies, no storage, nothing of the wrapper's.
//      Without `allow-same-origin` it cannot reach into the wrapper, without
//      `allow-popups` it cannot open windows, and without
//      `allow-top-navigation*` it cannot navigate the WebView away.
//   2. The WebView keeps no credentials (incognito, no shared cookies, no file
//      access) and refuses every top-frame load except the wrapper's own
//      `about:` load, so nothing the page does can leave the app's control.
//   3. Everything the page says over the bridge is untrusted. The relay below
//      forwards only the two message shapes the client acts on, and the client
//      validates them again: a sandboxed frame can post to native directly on
//      both platforms (iOS registers the message handler in every frame,
//      Android's listener matches every origin).
//
// The page's bytes reach the WebView only as an attribute value, entity-escaped
// in one pass, so no payload can close the attribute and add markup.

import {
  HTML_RENDER_DOCUMENT_CSP,
  htmlRenderThemeWindowName,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
  type HtmlRenderTheme,
} from "@ryco/shared/htmlRender";

import { escapeHtmlAttributeValue, isAllowedHtmlPreviewNavigation } from "../files/htmlPreview";

/** The page's sandbox tokens. Never add allow-same-origin, allow-popups, or allow-top-navigation. */
export const HTML_RENDER_FRAME_SANDBOX = "allow-scripts allow-forms";

const FRAME_ID = "ryco-render";

// Size reports and link requests from the frame go to native; theme changes and
// link results from native go to the frame through `window.__rycoPost`. The
// frame is looked up when a message arrives, so the listener can sit in <head>
// before the frame exists and never miss a fast page's first report. A theme
// message also updates the wrapper's color scheme: a frame whose scheme differs
// from its embedder's paints an opaque canvas.
const RELAY_SCRIPT = `(function(){var h={"ui/notifications/size-changed":1,"ui/open-link":1};function f(){var e=document.getElementById(${JSON.stringify(FRAME_ID)});return e&&e.contentWindow;}window.__rycoPost=function(m){var t=m&&m.params&&m.params.theme,w=f();if(t==="light"||t==="dark")document.documentElement.style.colorScheme=t;if(w)w.postMessage(m,"*");};window.addEventListener("message",function(e){var d=e.data,w=f(),n=window.ReactNativeWebView;if(!w||e.source!==w||!d||typeof d!=="object"||d.jsonrpc!=="2.0"||!h.hasOwnProperty(d.method)||!n)return;try{n.postMessage(JSON.stringify({jsonrpc:"2.0",id:d.id,method:d.method,params:d.params}));}catch(x){}});})();`;

export interface HtmlRenderDocumentInput {
  /** The stored page, bootstrap included, exactly as the server stored it. */
  readonly html: string;
  readonly title: string;
  /** Handed to the page through the frame's name, so its first paint is already themed. */
  readonly theme: HtmlRenderTheme;
  /** Full screen lets the reader pinch-zoom; an inline frame in the feed does not. */
  readonly zoomable: boolean;
}

export function buildHtmlRenderDocument(input: HtmlRenderDocumentInput): string {
  const scheme = input.theme.appearance === "light" ? "light" : "dark";
  const viewport = input.zoomable
    ? "width=device-width, initial-scale=1"
    : "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no";
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8">',
    // A srcdoc frame inherits its embedder's policy, so the page is bound by
    // this one as well as its own: the same policy web gives a render.
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttributeValue(HTML_RENDER_DOCUMENT_CSP)}">`,
    `<meta name="viewport" content="${viewport}">`,
    '<meta name="referrer" content="no-referrer">',
    `<meta name="color-scheme" content="${scheme}">`,
    `<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:transparent;color-scheme:${scheme}}`,
    "iframe{display:block;width:100%;height:100%;border:0;background:transparent}</style>",
    `<script>${RELAY_SCRIPT}</script>`,
    "</head>",
    "<body>",
    `<iframe id="${FRAME_ID}" title="${escapeHtmlAttributeValue(input.title)}"`,
    ` sandbox="${HTML_RENDER_FRAME_SANDBOX}" referrerpolicy="no-referrer"`,
    ` name="${escapeHtmlAttributeValue(htmlRenderThemeWindowName(input.theme))}"`,
    ` srcdoc="${escapeHtmlAttributeValue(input.html)}"></iframe>`,
    "</body>",
    "</html>",
  ].join("");
}

/**
 * Every load reaches `onShouldStartLoadWithRequest`: react-native-webview hands
 * a URL outside `originWhitelist` straight to the system (`Linking.openURL`),
 * which would let a page open apps and browsers without a tap.
 */
export const HTML_RENDER_ORIGIN_WHITELIST: ReadonlyArray<string> = ["*"];

const SUBFRAME_LOAD_PATTERN = /^(?:https?|data|blob):/i;

/**
 * Whether the WebView may start a load. The top frame stays on the wrapper.
 * A subframe may load what a sandboxed page could load on web (an embedded
 * map or video), never a custom scheme. iOS reports subframe loads with
 * `isTopFrame: false`. Android marks what it reports as the top frame or
 * leaves the flag unset, so an unknown frame is treated as the top frame.
 */
export function isAllowedHtmlRenderNavigation(request: {
  readonly url: string;
  readonly isTopFrame?: boolean | undefined;
}): boolean {
  if (isAllowedHtmlPreviewNavigation(request.url)) return true;
  return request.isTopFrame === false && SUBFRAME_LOAD_PATTERN.test(request.url);
}

/** A bridge message the client acts on. */
export type HtmlRenderBridgeMessage =
  | { readonly kind: "content-height"; readonly height: number }
  | { readonly kind: "open-link"; readonly id: string | number; readonly url: string };

// A link request is at most an 8 KiB URL plus its envelope; anything larger is
// not one, and is dropped before it is parsed.
const MAX_BRIDGE_MESSAGE_CHARS = 16 * 1024;
const MAX_REQUEST_ID_CHARS = 128;

/**
 * Reads one `onMessage` payload. Anything other than a size report or an
 * http(s) link request is ignored, whoever sent it.
 */
export function parseHtmlRenderBridgeMessage(data: unknown): HtmlRenderBridgeMessage | undefined {
  if (typeof data !== "string" || data.length > MAX_BRIDGE_MESSAGE_CHARS) return undefined;
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return undefined;
  }
  const height = readHtmlRenderContentHeight(message);
  if (height !== undefined) return { kind: "content-height", height: Math.ceil(height) };
  const link = readHtmlRenderLinkRequest(message);
  if (link === undefined) return undefined;
  const idFits =
    typeof link.id === "number" ? Number.isFinite(link.id) : link.id.length <= MAX_REQUEST_ID_CHARS;
  return idFits ? { kind: "open-link", id: link.id, url: link.url } : undefined;
}

/** How soon after the reader's tap the page must ask, for it to open a link. */
export const HTML_RENDER_LINK_TAP_WINDOW_MS = 1_000;
/** A touch that travels farther than this, in points, is a scroll or a drag. */
export const HTML_RENDER_TAP_SLOP = 10;
/** A touch held longer than this is a press, not a tap. */
export const HTML_RENDER_TAP_MAX_MS = 700;

/** The parts of a React Native touch event the link gate reads. */
export interface HtmlRenderTouchEvent {
  readonly pageX: number;
  readonly pageY: number;
  /** Every finger on the screen: this one included as it lands, the rest as it lifts. */
  readonly touches?: ReadonlyArray<unknown> | undefined;
}

/**
 * The mobile counterpart of web's user-activation check, fed the touches on
 * the frame. The page's own script can skip the bootstrap's click check and
 * post a link request whenever it likes, so only a tap grants a link: one
 * finger, down and up within `HTML_RENDER_TAP_MAX_MS`, never farther than
 * `HTML_RENDER_TAP_SLOP` from where it landed. A scroll or drag that starts on
 * the page (moved, or cancelled as the feed takes the gesture) and a pinch
 * grant nothing, so a page cannot send the reader to a site on load, on a
 * timer, or while they scroll past it. The request must follow the tap within
 * `HTML_RENDER_LINK_TAP_WINDOW_MS` and before the next touch, and a tap opens
 * at most one link. As on web, a page can still turn the reader's tap anywhere
 * on it into a link.
 */
export interface HtmlRenderLinkGate {
  readonly touchStart: (event: HtmlRenderTouchEvent, now: number) => void;
  readonly touchMove: (event: HtmlRenderTouchEvent, now: number) => void;
  readonly touchEnd: (event: HtmlRenderTouchEvent, now: number) => void;
  readonly touchCancel: () => void;
  /** Whether the page may open a link now. Spends the tap either way. */
  readonly consume: (now: number) => boolean;
}

interface Press {
  readonly x: number;
  readonly y: number;
  readonly at: number;
}

function withinTapSlop(press: Press, event: HtmlRenderTouchEvent): boolean {
  return Math.hypot(event.pageX - press.x, event.pageY - press.y) <= HTML_RENDER_TAP_SLOP;
}

export function createHtmlRenderLinkGate(): HtmlRenderLinkGate {
  // The touch in progress: null between touches, "rejected" once it cannot be a tap.
  let press: Press | "rejected" | null = null;
  let tappedAt = 0;
  return {
    touchStart: (event, now) => {
      // A new touch withdraws an earlier tap. The first finger down starts a
      // fresh press even if an earlier touch never reported its end; a second
      // finger makes the gesture a pinch.
      tappedAt = 0;
      press =
        (event.touches?.length ?? 1) <= 1
          ? { x: event.pageX, y: event.pageY, at: now }
          : "rejected";
    },
    touchMove: (event) => {
      if (press !== null && press !== "rejected" && !withinTapSlop(press, event))
        press = "rejected";
    },
    touchEnd: (event, now) => {
      const started = press;
      if ((event.touches?.length ?? 0) > 0) {
        // A finger is still down: this was more than one finger.
        if (started !== null) press = "rejected";
        return;
      }
      press = null;
      if (started === null || started === "rejected") return;
      const heldFor = now - started.at;
      if (withinTapSlop(started, event) && heldFor >= 0 && heldFor <= HTML_RENDER_TAP_MAX_MS) {
        tappedAt = now;
      }
    },
    touchCancel: () => {
      press = null;
      tappedAt = 0;
    },
    consume: (now) => {
      const allowed =
        tappedAt > 0 && now >= tappedAt && now - tappedAt <= HTML_RENDER_LINK_TAP_WINDOW_MS;
      tappedAt = 0;
      return allowed;
    },
  };
}

/** Script for `injectJavaScript` that posts one message into the page. */
export function htmlRenderPostScript(message: unknown): string {
  // JSON is a JS expression; the line separators are escaped for engines that predate ES2019.
  const literal = JSON.stringify(message)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `window.__rycoPost&&window.__rycoPost(${literal});true;`;
}
