/**
 * Node browser: browser tabs that run on the node, in Ryco's pinned headless
 * shell, and stream to every client of it (`docs/project-browser.md`).
 *
 * Tabs, commands, input and stills ride the RPC socket; live JPEG frames ride
 * their own binary socket (`@ryco/shared/nodeBrowserFrame`). Every method
 * needs an operator session: a page is as private as a terminal.
 *
 * @module nodeBrowser
 */
import * as Schema from "effect/Schema";

import { ForwardCompatibleUnion } from "./baseSchemas.ts";

export const NODE_BROWSER_WS_METHODS = {
  read: "nodeBrowser.read",
  command: "nodeBrowser.command",
  input: "nodeBrowser.input",
  subscribe: "nodeBrowser.subscribe",
} as const;

/** Tabs open at once, live or suspended. */
export const NODE_BROWSER_TAB_LIMIT = 12;
/** Input events in one `input` call. */
export const NODE_BROWSER_INPUT_BATCH_LIMIT = 64;
/** Characters one `text` input event inserts. */
export const NODE_BROWSER_TEXT_LIMIT = 10_000;
/** The base64 of one still. */
export const NODE_BROWSER_STILL_MAX_BASE64 = 2 * 1024 * 1024;

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const int = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));
/** Page CSS pixels; the node clamps them to the tab's viewport. */
const coordinate = Schema.Finite.check(Schema.isBetween({ minimum: -100_000, maximum: 100_000 }));

export const NodeBrowserTabId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{1,64}$/));
export type NodeBrowserTabId = typeof NodeBrowserTabId.Type;

/** The page's size in CSS pixels. */
export const NodeBrowserViewport = Schema.Struct({ width: int(1, 3840), height: int(1, 2160) });
export type NodeBrowserViewport = typeof NodeBrowserViewport.Type;

export const NodeBrowserDialog = Schema.Struct({
  type: Schema.Literals(["alert", "confirm", "prompt", "beforeunload"]),
  message: text(4_000),
  defaultValue: text(4_000),
});
export type NodeBrowserDialog = typeof NodeBrowserDialog.Type;

export const NodeBrowserTabError = Schema.Struct({
  code: Schema.Literals(["blocked-url", "navigation-failed", "crashed"]),
  text: text(256),
});
export type NodeBrowserTabError = typeof NodeBrowserTabError.Type;

export const NodeBrowserTab = Schema.Struct({
  id: NodeBrowserTabId,
  /** The project or worktree directory the tab was opened for; clients show it there. */
  scope: text(4_096),
  /** Without credentials; a `data:` address shows only its scheme. */
  url: text(8_192),
  title: text(512),
  loading: Schema.Boolean,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  /** `suspended`: no page in memory, reloaded on the next view. `crashed`: reload brings it back. */
  state: Schema.Literals(["live", "suspended", "crashed"]),
  viewport: Schema.NullOr(NodeBrowserViewport),
  dialog: Schema.NullOr(NodeBrowserDialog),
  error: Schema.NullOr(NodeBrowserTabError),
});
export type NodeBrowserTab = typeof NodeBrowserTab.Type;

/** Why a node cannot run tabs, as this build knows the reasons. */
export const NODE_BROWSER_UNAVAILABLE_REASONS = [
  "unsupported-platform",
  "root-without-sandbox",
  "sandbox-blocked",
  "installing",
  "disabled",
  "crashed",
] as const;
export type NodeBrowserUnavailableReason = (typeof NODE_BROWSER_UNAVAILABLE_REASONS)[number];

/** Published as `ServerConfig.nodeBrowser`; absent on nodes without the feature. */
export const NodeBrowserCapability = Schema.Struct({
  available: Schema.Boolean,
  /**
   * One of `NODE_BROWSER_UNAVAILABLE_REASONS`, as a plain string: a reason a
   * newer node adds must not fail an older client's server config. One it
   * does not know still means unavailable.
   */
  reason: Schema.optionalKey(text(64)),
  /**
   * False while the node runs its tabs without Chrome's sandbox
   * (`RYCO_NODE_BROWSER_NO_SANDBOX`), so clients can warn. Absent means sandboxed.
   */
  sandbox: Schema.optionalKey(Schema.Boolean),
});
export type NodeBrowserCapability = typeof NodeBrowserCapability.Type;

export class NodeBrowserRpcError extends Schema.TaggedError<NodeBrowserRpcError>()(
  "NodeBrowserRpcError",
  {
    code: Schema.Literals([
      "unavailable",
      "installing",
      "not-found",
      "limit-reached",
      "invalid-url",
      "failed",
    ]),
    message: text(1_024),
    retryable: Schema.Boolean,
  },
) {}

const TabTarget = { tabId: NodeBrowserTabId };

export const NodeBrowserReadRequest = Schema.Union([
  Schema.Struct({ type: Schema.Literal("list") }),
  Schema.Struct({
    type: Schema.Literal("still"),
    ...TabTarget,
    maxWidth: int(64, 1920),
    maxHeight: int(64, 1200),
    quality: int(20, 80),
  }),
]);
export type NodeBrowserReadRequest = typeof NodeBrowserReadRequest.Type;

export const NodeBrowserStill = Schema.Struct({
  mimeType: Schema.Literal("image/jpeg"),
  width: int(1, 3840),
  height: int(1, 2400),
  cssWidth: int(1, 3840),
  cssHeight: int(1, 2160),
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  bytesBase64: text(NODE_BROWSER_STILL_MAX_BASE64),
});
export type NodeBrowserStill = typeof NodeBrowserStill.Type;

export const NodeBrowserReadResponse = Schema.Union([
  Schema.Struct({ type: Schema.Literal("list"), tabs: Schema.Array(NodeBrowserTab) }),
  Schema.Struct({ type: Schema.Literal("still"), still: NodeBrowserStill }),
]);
export type NodeBrowserReadResponse = typeof NodeBrowserReadResponse.Type;

export const NodeBrowserCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("open"), scope: text(4_096), url: text(8_192) }),
  Schema.Struct({ type: Schema.Literal("close"), ...TabTarget }),
  Schema.Struct({ type: Schema.Literal("navigate"), ...TabTarget, url: text(8_192) }),
  Schema.Struct({ type: Schema.Literal("history"), ...TabTarget, delta: Schema.Literals([-1, 1]) }),
  Schema.Struct({
    type: Schema.Literal("reload"),
    ...TabTarget,
    ignoreCache: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("stop"), ...TabTarget }),
  Schema.Struct({
    type: Schema.Literal("resize"),
    ...TabTarget,
    width: int(320, 3840),
    height: int(240, 2160),
  }),
  Schema.Struct({
    type: Schema.Literal("dialog"),
    ...TabTarget,
    accept: Schema.Boolean,
    promptText: Schema.optionalKey(text(4_096)),
  }),
  /** Re-creates a suspended or crashed tab's page. */
  Schema.Struct({ type: Schema.Literal("wake"), ...TabTarget }),
]);
export type NodeBrowserCommand = typeof NodeBrowserCommand.Type;

/** The tab after the command; `null` once closed. */
export const NodeBrowserCommandResult = Schema.Struct({ tab: Schema.NullOr(NodeBrowserTab) });
export type NodeBrowserCommandResult = typeof NodeBrowserCommandResult.Type;

/** Bit flags: alt 1, ctrl 2, meta 4, shift 8. */
const modifiers = int(0, 15);

export const NodeBrowserInputEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("mouse"),
    action: Schema.Literals(["move", "down", "up"]),
    x: coordinate,
    y: coordinate,
    button: Schema.Literals(["none", "left", "middle", "right"]),
    /** Held buttons: left 1, right 2, middle 4. */
    buttons: int(0, 7),
    clickCount: int(0, 3),
    modifiers,
  }),
  Schema.Struct({
    type: Schema.Literal("wheel"),
    x: coordinate,
    y: coordinate,
    deltaX: Schema.Finite.check(Schema.isBetween({ minimum: -10_000, maximum: 10_000 })),
    deltaY: Schema.Finite.check(Schema.isBetween({ minimum: -10_000, maximum: 10_000 })),
    modifiers,
  }),
  Schema.Struct({
    type: Schema.Literal("key"),
    action: Schema.Literals(["down", "up"]),
    key: text(32),
    code: text(32),
    /** Windows virtual key code (DOM `keyCode`); Enter, Backspace and arrows need it. */
    keyCode: Schema.optionalKey(int(0, 255)),
    /** Only for printable keys without Ctrl or Meta. */
    text: Schema.optionalKey(text(8)),
    modifiers,
  }),
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String.check(Schema.isBetweenLength(1, NODE_BROWSER_TEXT_LIMIT)),
  }),
  /** Lets go of every key and button still held. */
  Schema.Struct({ type: Schema.Literal("release") }),
]);
export type NodeBrowserInputEvent = typeof NodeBrowserInputEvent.Type;

export const NodeBrowserInputRequest = Schema.Struct({
  ...TabTarget,
  events: Schema.Array(NodeBrowserInputEvent).check(
    Schema.isMaxLength(NODE_BROWSER_INPUT_BATCH_LIMIT),
  ),
});
export type NodeBrowserInputRequest = typeof NodeBrowserInputRequest.Type;

/** Every tab after each change, and whether the browser can run, first of all on subscribe. */
export const NodeBrowserEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("tabs"), tabs: Schema.Array(NodeBrowserTab) }),
  Schema.Struct({ type: Schema.Literal("availability"), capability: NodeBrowserCapability }),
]);
export type NodeBrowserEvent = typeof NodeBrowserEvent.Type;

/** An event as a client decodes it: one a newer node adds decodes to a placeholder it skips. */
export const NodeBrowserWireEvent = ForwardCompatibleUnion(NodeBrowserEvent.members, "type");
export type NodeBrowserWireEvent = typeof NodeBrowserWireEvent.Type;
