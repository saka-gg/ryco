// @effect-diagnostics nodeBuiltinImport:off - Effect has no OS release probe.
/**
 * nodeBrowserRuntime - Browser tabs that run on the node and stream to its
 * clients. One headless shell (Ryco's pinned build, `PreviewBrowser`) starts
 * with the first tab, driven over `--remote-debugging-pipe`
 * (`cdpPipeBrowser.ts`), with a persistent profile of its own. Loaded by
 * `NodeBrowser.ts` on first use, so the boot path carries none of it.
 *
 * Each viewer gets its own CDP session and screencast. Frames follow T3
 * Code's pacing: Chromium's acknowledgement of a frame is held until the
 * viewer acknowledged it and sent 100 ms after the frame arrived, one frame
 * at a time per viewer (`nodeBrowserViewerSocket.ts`); four frames within
 * 300 ms of a wheel restart the screencast at half size and quality 50, and
 * 200 ms after it settles a full-size still follows.
 *
 * Tabs suspend after 10 minutes nobody watched them (their address and title
 * stay), the browser exits 2 minutes after its last live tab, and three exits
 * within a minute pause it for five. Pages may load only http(s) and
 * about:blank; downloads, popups and file choosers are refused.
 *
 * @module nodeBrowserRuntime
 */
import * as NodeOS from "node:os";

import {
  NODE_BROWSER_STILL_MAX_BASE64,
  NODE_BROWSER_TAB_LIMIT,
  type NodeBrowserCapability,
  type NodeBrowserCommand,
  type NodeBrowserCommandResult,
  type NodeBrowserDialog,
  type NodeBrowserEvent,
  type NodeBrowserInputEvent,
  type NodeBrowserInputRequest,
  type NodeBrowserReadRequest,
  type NodeBrowserReadResponse,
  NodeBrowserRpcError,
  type NodeBrowserStill,
  type NodeBrowserTab,
  type NodeBrowserTabError,
} from "@ryco/contracts/node-browser";
import {
  encodeNodeBrowserFrame,
  NODE_BROWSER_FRAME_CLOSE,
  NODE_BROWSER_FRAME_PARAMS,
} from "@ryco/shared/nodeBrowserFrame";
import {
  Clock,
  Data,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  PubSub,
  Queue,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { Socket } from "effect/socket";

import { ServerConfig } from "../config.ts";
import {
  type CdpBrowserFailure,
  type CdpEvent,
  type CdpPipeBrowser,
  launchCdpPipeBrowser,
} from "../htmlRender/cdpPipeBrowser.ts";
import { PreviewBrowser, type PreviewBrowserError } from "../htmlRender/PreviewBrowser.ts";
import type { NodeBrowserRuntime } from "./NodeBrowser.ts";
import { serveViewerSocket, type ViewerOutput } from "./nodeBrowserViewerSocket.ts";

export const NODE_BROWSER_LIVE_TAB_LIMIT = 6;
export const NODE_BROWSER_VIEWERS_PER_TAB = 4;
export const NODE_BROWSER_SCREENCASTS = 8;
export const NODE_BROWSER_IDLE_SUSPEND_MS = 10 * 60_000;
export const NODE_BROWSER_IDLE_EXIT_MS = 2 * 60_000;
const IDLE_SWEEP_INTERVAL = "30 seconds";
const CRASH_LOOP_EXITS = 3;
const CRASH_LOOP_WINDOW_MS = 60_000;
const CRASH_LOOP_PAUSE_MS = 5 * 60_000;
// Screencasts ignore an emulated device scale, so the browser renders at 2x.
const RENDER_SCALE = 2;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
// Chromium allows three unacknowledged frames, so 100 ms pacing caps a viewer near 30 fps.
export const SCREENCAST_ACK_PACE_MS = 100;
export const SCREENCAST_SETTLE_MS = 200;
export const SCREENCAST_MOTION_FRAMES = 4;
export const SCREENCAST_MOTION_WINDOW_MS = 300;
export const SCREENCAST_MOTION_QUALITY = 50;
export const SCREENCAST_MOTION_SCALE = 0.5;
const DEFAULT_QUALITY = 70;
const MAX_FRAME_WIDTH = 3_840;
const MAX_FRAME_HEIGHT = 2_160;
const VIEWER_OUTPUT_LIMIT = 8;
/** Held keys and buttons are let go this long after the last input. */
export const INPUT_RELEASE_WATCHDOG_MS = 10_000;
const INPUT_TIMEOUT = "5 seconds";
const NAVIGATION_TIMEOUT = "15 seconds";
const MAX_URL_CHARS = 8_192;
const MAX_TITLE_CHARS = 512;
// A screencast frame is a JPEG of up to 3840 x 2160 in base64; other events
// are what a page logs or requests, which nothing here reads in full.
const MAX_SCREENCAST_EVENT_CHARS = 8 * 1024 * 1024;
const MAX_CDP_EVENT_CHARS = 1024 * 1024;
const MAX_CDP_REPLY_CHARS = 16 * 1024 * 1024;

export class NodeBrowserCdpError extends Data.TaggedError(
  "NodeBrowserCdpError",
)<CdpBrowserFailure> {}

export type NodeBrowserCdp = CdpPipeBrowser<NodeBrowserCdpError>;

export interface NodeBrowserLaunchInput {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly onEvent: (event: CdpEvent) => Effect.Effect<void>;
  readonly onOversizedEvent: (head: string, tail: string) => Effect.Effect<void>;
  readonly onExit: (error: NodeBrowserCdpError) => Effect.Effect<void>;
}

export interface NodeBrowserRuntimeOptions {
  /** What the node allows before anything runs: platform, sandbox and opt-out. */
  readonly baseCapability: NodeBrowserCapability;
  /** Only when the operator turned Chrome's sandbox off for this host. */
  readonly noSandbox: boolean;
  /** Tests swap the browser process for a scripted peer. */
  readonly launch?: (
    input: NodeBrowserLaunchInput,
  ) => Effect.Effect<
    NodeBrowserCdp,
    NodeBrowserCdpError,
    Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
  >;
}

const defaultLaunch = (input: NodeBrowserLaunchInput) =>
  launchCdpPipeBrowser({
    executable: input.executable,
    args: input.args,
    limits: {
      maxReplyChars: MAX_CDP_REPLY_CHARS,
      maxEventChars: MAX_CDP_EVENT_CHARS,
      maxEventCharsFor: (head) =>
        head.startsWith('{"method":"Page.screencastFrame"')
          ? MAX_SCREENCAST_EVENT_CHARS
          : undefined,
    },
    failure: (failure) => new NodeBrowserCdpError(failure),
    onEvent: input.onEvent,
    onOversizedEvent: input.onOversizedEvent,
    onExit: input.onExit,
  });

/** The node browser's flags: the debugging pipe, a persistent profile, no popups. */
export const nodeBrowserArguments = (input: {
  readonly noSandbox: boolean;
  readonly profileDirectory: string;
}) => [
  "--headless=new",
  "--remote-debugging-pipe",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--hide-scrollbars",
  "--mute-audio",
  "--block-new-web-contents",
  `--force-device-scale-factor=${RENDER_SCALE}`,
  "--disable-blink-features=AutomationControlled",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--use-mock-keychain",
  "--password-store=basic",
  ...(input.noSandbox ? ["--no-sandbox"] : []),
  `--user-data-dir=${input.profileDirectory}`,
  "about:blank",
];

// ── Addresses ────────────────────────────────────────────────────────

/**
 * An address the node browser may open: http(s) without credentials, or
 * about:blank. A bare host (`localhost:3000`) gets http. Never `file:`,
 * `javascript:`, `data:`, `chrome:`, `devtools:` or `view-source:`: those
 * would read the node's own files and state.
 */
export const normalizeNodeBrowserUrl = (raw: string): string | null => {
  const value = raw.trim();
  if (value === "about:blank") return value;
  if (value === "" || value.length > MAX_URL_CHARS) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//iu.test(value) ? value : `http://${value}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || !url.hostname) return null;
    return url.href.length <= MAX_URL_CHARS ? url.href : null;
  } catch {
    return null;
  }
};

/** What a page may show in the main frame; `chrome-error:` is Chromium's own load error page. */
const COMMITTED_SCHEMES = new Set(["http:", "https:", "about:", "blob:", "chrome-error:"]);
const committedSchemeAllowed = (url: string) => {
  try {
    return COMMITTED_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
};

/** An address as clients see it: no credentials, and no `data:` payload. */
export const displayNodeBrowserUrl = (raw: string): string => {
  if (raw.startsWith("data:")) return "data:";
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    return url.href.slice(0, MAX_URL_CHARS);
  } catch {
    return raw.slice(0, MAX_URL_CHARS);
  }
};

// ── Browser identity and input ───────────────────────────────────────

const UA_PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

/** The user agent and Sec-CH-UA of desktop Chrome; sites block a headless or mismatched one. */
export const chromeIdentity = (
  headlessUserAgent: string,
  host: { readonly platform: NodeJS.Platform; readonly arch: string; readonly release: string },
) => {
  const version = /HeadlessChrome\/((\d+)[\d.]*)/.exec(headlessUserAgent);
  const fullVersion = version?.[1];
  const major = version?.[2];
  if (!version || !fullVersion || !major) return null;
  const brands = (names: (version: string) => string) => [
    { brand: "Chromium", version: names(major) },
    { brand: "Google Chrome", version: names(major) },
    { brand: "Not A(Brand", version: names("99") },
  ];
  return {
    userAgent: headlessUserAgent.replace(version[0], `Chrome/${major}.0.0.0`),
    userAgentMetadata: {
      brands: brands((value) => value),
      fullVersionList: brands((value) => (value === major ? fullVersion : `${value}.0.0.0`)),
      platform: UA_PLATFORMS[host.platform] ?? "Unknown",
      platformVersion: host.platform === "linux" ? host.release : "",
      architecture: host.arch.startsWith("arm") ? "arm" : "x86",
      bitness: host.arch.endsWith("64") ? "64" : "32",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
};

/** Headless Chromium needs editing commands for Cmd shortcuts and for Ctrl copy and cut. */
export const editingCommand = (key: string, modifiers: number) => {
  const modifier = modifiers & 0b0111;
  if (modifier !== 2 && modifier !== 4) return null;
  const lower = key.toLowerCase();
  const command =
    lower === "c"
      ? "copy"
      : lower === "x"
        ? "cut"
        : modifier !== 4
          ? null
          : lower === "a"
            ? "selectAll"
            : lower === "z"
              ? modifiers & 8
                ? "redo"
                : "undo"
              : null;
  return command ? { commands: [command] } : null;
};

/** A mouse move with no button held, which a later one replaces. */
const isHover = (event: NodeBrowserInputEvent) =>
  event.type === "mouse" && event.action === "move" && event.buttons === 0;

/** Drops hovers a later hover in the same batch replaces, so clicks never wait behind them. */
export const coalesceInput = (events: ReadonlyArray<NodeBrowserInputEvent>) =>
  events.filter(
    (event, index) => !(isHover(event) && events[index + 1] && isHover(events[index + 1]!)),
  );

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);

/** The frame socket's query, clamped to what the node streams. */
export const viewerRequestFrom = (params: URLSearchParams) => {
  const tabId = params.get(NODE_BROWSER_FRAME_PARAMS.tab) ?? "";
  if (!/^[A-Za-z0-9-]{1,64}$/u.test(tabId)) return null;
  const number = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(params.get(name));
    return Number.isFinite(value) && value > 0
      ? Math.min(Math.max(Math.round(value), min), max)
      : fallback;
  };
  return {
    tabId,
    maxWidth: number(NODE_BROWSER_FRAME_PARAMS.maxWidth, 1_280, 64, MAX_FRAME_WIDTH),
    maxHeight: number(NODE_BROWSER_FRAME_PARAMS.maxHeight, 800, 64, MAX_FRAME_HEIGHT),
    quality: number(NODE_BROWSER_FRAME_PARAMS.quality, DEFAULT_QUALITY, 20, 80),
  };
};

// ── CDP shapes ───────────────────────────────────────────────────────

const Ignored = Schema.Unknown;
const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  Schema.decodeUnknownOption(schema);
const decodeFrame = decode(
  Schema.Struct({
    data: Schema.String,
    sessionId: Schema.Number,
    metadata: Schema.Struct({ deviceWidth: Schema.Number, deviceHeight: Schema.Number }),
  }),
);
const decodeFrameNavigated = decode(
  Schema.Struct({
    frame: Schema.Struct({
      id: Schema.String,
      parentId: Schema.optional(Schema.String),
      url: Schema.String,
      unreachableUrl: Schema.optional(Schema.String),
    }),
  }),
);
const decodeWithinDocument = decode(Schema.Struct({ frameId: Schema.String, url: Schema.String }));
const decodeFrameId = decode(Schema.Struct({ frameId: Schema.String }));
const decodeDialog = decode(
  Schema.Struct({
    type: Schema.Literals(["alert", "confirm", "prompt", "beforeunload"]),
    message: Schema.String,
    defaultPrompt: Schema.optional(Schema.String),
  }),
);
const decodeTargetInfo = decode(
  Schema.Struct({ targetInfo: Schema.Struct({ targetId: Schema.String, title: Schema.String }) }),
);
const decodeSessionId = decode(Schema.Struct({ sessionId: Schema.String }));
const TargetCreated = Schema.Struct({ targetId: Schema.String });
const Attached = Schema.Struct({ sessionId: Schema.String });
const Version = Schema.Struct({ userAgent: Schema.String });
const Navigated = Schema.Struct({ errorText: Schema.optional(Schema.String) });
const History = Schema.Struct({
  currentIndex: Schema.Number,
  entries: Schema.Array(
    Schema.Struct({ id: Schema.Number, title: Schema.optional(Schema.String) }),
  ),
});
const LayoutMetrics = Schema.Struct({
  cssVisualViewport: Schema.Struct({
    pageX: Schema.Number,
    pageY: Schema.Number,
    clientWidth: Schema.Number,
    clientHeight: Schema.Number,
  }),
});
const Screenshot = Schema.Struct({ data: Schema.String });

// ── State ────────────────────────────────────────────────────────────

interface Viewer {
  readonly output: Queue.Queue<ViewerOutput>;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly quality: number;
  readonly screencastLock: Semaphore.Semaphore;
  sessionId: string | null;
  scale: number;
  motion: boolean;
  started: boolean;
  framesInFlight: number;
  mayHaveDropped: boolean;
  readonly recentFrames: Array<number>;
  settleGeneration: number;
  seq: number;
}

interface Tab {
  readonly id: string;
  readonly scope: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  state: "live" | "suspended" | "crashed";
  viewport: { width: number; height: number };
  dialog: NodeBrowserDialog | null;
  error: NodeBrowserTabError | null;
  page: { readonly targetId: string; readonly sessionId: string } | null;
  readonly viewers: Set<Viewer>;
  lastUsedAt: number;
  scrolledAt: number;
  lastInputAt: number;
  capturing: number;
  stillSeq: number;
  readonly captureLock: Semaphore.Semaphore;
  readonly inputLock: Semaphore.Semaphore;
  readonly pressedKeys: Map<string, { readonly key: string; readonly code: string }>;
  readonly pressedButtons: Map<string, { readonly x: number; readonly y: number }>;
}

type SessionOwner =
  | { readonly kind: "page"; readonly tab: Tab }
  | { readonly kind: "viewer"; readonly tab: Tab; readonly viewer: Viewer };

interface Running {
  readonly cdp: NodeBrowserCdp;
  readonly scope: Scope.Closeable;
  readonly identity: ReturnType<typeof chromeIdentity>;
}

const rpcError = (code: NodeBrowserRpcError["code"], message: string, retryable = false) =>
  new NodeBrowserRpcError({ code, message: message.slice(0, 1_024), retryable });

const installError = (error: PreviewBrowserError) =>
  error._tag === "PreviewBrowserInstallingError"
    ? rpcError(
        "installing",
        "Ryco is installing the browser for node tabs on this machine. Try again in a minute.",
        true,
      )
    : error._tag === "PreviewBrowserUnsupportedError"
      ? rpcError("unavailable", "Node browser tabs are not available on this platform.")
      : rpcError("failed", "Ryco could not install the browser for node tabs.", true);

const SANDBOX_FAILURE =
  /No usable sandbox|Running as root without --no-sandbox|Failed to move to new namespace/iu;

export const makeNodeBrowserRuntime = Effect.fn("NodeBrowser.makeRuntime")(function* (
  options: NodeBrowserRuntimeOptions,
) {
  const previewBrowser = yield* PreviewBrowser;
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const clock = yield* Clock.Clock;
  const runtimeScope = yield* Effect.scope;
  const launchServices = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
  const launch = options.launch ?? defaultLaunch;
  const profileDirectory = path.join(config.stateDir, "node-browser", "profile");
  const now = () => clock.currentTimeMillisUnsafe();

  const tabs = new Map<string, Tab>();
  const sessions = new Map<string, SessionOwner>();
  const lifecycle = yield* Semaphore.make(1);
  const events = yield* PubSub.sliding<NodeBrowserEvent>(32);
  let running: Running | null = null;
  let exits: Array<number> = [];
  let pausedUntil: number | null = null;
  let sandboxBlocked = false;
  let idleSince: number | null = null;

  const fork = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.asVoid(Effect.forkIn(Effect.ignore(effect), runtimeScope));
  // For work started from plain callbacks, with this runtime's services (its clock included).
  const runFork = Effect.runForkWith(yield* Effect.context<never>());

  const capability = Effect.sync((): NodeBrowserCapability => {
    if (!options.baseCapability.available) return options.baseCapability;
    if (pausedUntil !== null && now() < pausedUntil) return { available: false, reason: "crashed" };
    if (sandboxBlocked) return { available: false, reason: "sandbox-blocked" };
    return { available: true };
  });

  const snapshot = (tab: Tab): NodeBrowserTab => ({
    id: tab.id,
    scope: tab.scope,
    url: tab.url,
    title: tab.title,
    loading: tab.loading,
    canGoBack: tab.canGoBack,
    canGoForward: tab.canGoForward,
    state: tab.state,
    viewport: tab.viewport,
    dialog: tab.dialog,
    error: tab.error,
  });
  const list = () => [...tabs.values()].map(snapshot);
  const publishTabs = () => {
    PubSub.publishUnsafe(events, { type: "tabs", tabs: list() });
  };
  const publishAvailability = Effect.flatMap(capability, (current) =>
    PubSub.publish(events, { type: "availability", capability: current }),
  );

  // ── Viewers ──

  const releaseFrame = (ack: Effect.Effect<void>) => {
    runFork(ack);
  };
  const push = (viewer: Viewer, next: ViewerOutput) => {
    if (Queue.offerUnsafe(viewer.output, next)) return;
    if (next._tag === "frame") return releaseFrame(next.ack);
    // A close must arrive; the frames before it never will.
    for (
      let taken = Queue.takeUnsafe(viewer.output);
      taken;
      taken = Queue.takeUnsafe(viewer.output)
    ) {
      if (Exit.isSuccess(taken) && taken.value._tag === "frame") releaseFrame(taken.value.ack);
    }
    Queue.offerUnsafe(viewer.output, next);
  };
  const closeViewers = (tab: Tab, code: number, reason: string) => {
    for (const viewer of tab.viewers) push(viewer, { _tag: "close", code, reason });
  };
  const screencastCount = () => {
    let count = 0;
    for (const tab of tabs.values()) count += tab.viewers.size;
    return count;
  };

  const startScreencast = (viewer: Viewer, tab: Tab, scale: number) => {
    viewer.scale = scale;
    return viewer.screencastLock.withPermit(
      Effect.gen(function* () {
        const cdp = running?.cdp;
        const sessionId = viewer.sessionId;
        if (!cdp || sessionId === null || tab.capturing > 0) return;
        yield* cdp.post("Page.stopScreencast", {}, sessionId);
        yield* cdp.send(
          "Page.startScreencast",
          {
            format: "jpeg",
            quality:
              viewer.scale < 1
                ? Math.min(viewer.quality, SCREENCAST_MOTION_QUALITY)
                : viewer.quality,
            maxWidth: Math.max(1, Math.round(viewer.maxWidth * viewer.scale)),
            maxHeight: Math.max(1, Math.round(viewer.maxHeight * viewer.scale)),
          },
          Ignored,
          sessionId,
        );
      }).pipe(Effect.ignore),
    );
  };

  /** The visible page as a JPEG no larger than the bounds, at device scale. */
  const captureStill = (
    sessionId: string,
    bounds: { readonly maxWidth: number; readonly maxHeight: number; readonly quality: number },
  ) =>
    Effect.gen(function* () {
      const cdp = running?.cdp;
      if (!cdp) return yield* rpcError("unavailable", "The node browser is not running.", true);
      const { cssVisualViewport: viewport } = yield* cdp.send(
        "Page.getLayoutMetrics",
        {},
        LayoutMetrics,
        sessionId,
      );
      const cssWidth = Math.max(1, Math.round(viewport.clientWidth));
      const cssHeight = Math.max(1, Math.round(viewport.clientHeight));
      const scale = Math.min(
        1,
        bounds.maxWidth / (cssWidth * RENDER_SCALE),
        bounds.maxHeight / (cssHeight * RENDER_SCALE),
      );
      const { data } = yield* cdp.send(
        "Page.captureScreenshot",
        {
          format: "jpeg",
          quality: bounds.quality,
          clip: {
            x: viewport.pageX,
            y: viewport.pageY,
            width: viewport.clientWidth,
            height: viewport.clientHeight,
            scale,
          },
        },
        Screenshot,
        sessionId,
      );
      return {
        data,
        cssWidth,
        cssHeight,
        width: Math.max(1, Math.round(cssWidth * RENDER_SCALE * scale)),
        height: Math.max(1, Math.round(cssHeight * RENDER_SCALE * scale)),
      };
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "NodeBrowserRpcError"
          ? error
          : rpcError("failed", "The page could not be captured.", true),
      ),
    );

  const pushStill = (viewer: Viewer, tab: Tab) =>
    tab.captureLock
      .withPermit(
        Effect.suspend(() =>
          viewer.sessionId === null ? Effect.succeed(null) : captureStill(viewer.sessionId, viewer),
        ),
      )
      .pipe(
        Effect.map((still) => {
          if (!still) return;
          push(viewer, {
            _tag: "frame",
            data: encodeNodeBrowserFrame({
              seq: viewer.seq++,
              cssWidth: still.cssWidth,
              cssHeight: still.cssHeight,
              jpeg: Buffer.from(still.data, "base64"),
            }),
            ack: Effect.void,
          });
        }),
        Effect.ignore,
      );

  const onScreencastFrame = (viewer: Viewer, tab: Tab, params: unknown) => {
    const cdp = running?.cdp;
    const sessionId = viewer.sessionId;
    const frame = Option.getOrUndefined(decodeFrame(params));
    if (!cdp || sessionId === null || !frame) return Effect.void;
    viewer.started = true;
    if (viewer.framesInFlight > 0) viewer.mayHaveDropped = true;
    viewer.framesInFlight += 1;
    const arrivedAt = now();
    viewer.recentFrames.push(arrivedAt);
    while (viewer.recentFrames[0]! < arrivedAt - SCREENCAST_MOTION_WINDOW_MS) {
      viewer.recentFrames.shift();
    }
    const work: Array<Effect.Effect<void>> = [];
    if (
      !viewer.motion &&
      viewer.recentFrames.length >= SCREENCAST_MOTION_FRAMES &&
      arrivedAt - tab.scrolledAt < SCREENCAST_MOTION_WINDOW_MS
    ) {
      viewer.motion = true;
      work.push(startScreencast(viewer, tab, SCREENCAST_MOTION_SCALE));
    } else if (viewer.motion && arrivedAt - tab.scrolledAt > SCREENCAST_SETTLE_MS) {
      viewer.motion = false;
      viewer.recentFrames.length = 0;
      work.push(startScreencast(viewer, tab, 1));
    }
    // Chromium may drop the last frame of a burst; a still follows once it settles.
    const generation = ++viewer.settleGeneration;
    work.push(
      Effect.gen(function* () {
        yield* Effect.sleep(SCREENCAST_SETTLE_MS);
        if (generation !== viewer.settleGeneration) return;
        if (!viewer.motion && !viewer.mayHaveDropped) return;
        viewer.mayHaveDropped = false;
        if (viewer.motion) {
          viewer.motion = false;
          viewer.recentFrames.length = 0;
          yield* startScreencast(viewer, tab, 1);
        }
        yield* pushStill(viewer, tab);
      }),
    );
    push(viewer, {
      _tag: "frame",
      data: encodeNodeBrowserFrame({
        seq: viewer.seq++,
        cssWidth: frame.metadata.deviceWidth,
        cssHeight: frame.metadata.deviceHeight,
        jpeg: Buffer.from(frame.data, "base64"),
      }),
      ack: Effect.gen(function* () {
        yield* Effect.sleep(Math.max(0, arrivedAt + SCREENCAST_ACK_PACE_MS - now()));
        viewer.framesInFlight -= 1;
        yield* cdp.post("Page.screencastFrameAck", { sessionId: frame.sessionId }, sessionId);
      }),
    });
    return Effect.forEach(work, fork, { discard: true });
  };

  // ── Pages ──

  const markUsed = (tab: Tab) => {
    tab.lastUsedAt = now();
  };

  const refreshHistory = (tab: Tab) =>
    Effect.gen(function* () {
      const page = tab.page;
      const cdp = running?.cdp;
      if (!page || !cdp) return;
      const history = yield* cdp.send("Page.getNavigationHistory", {}, History, page.sessionId);
      if (tab.page !== page) return;
      tab.canGoBack = history.currentIndex > 0;
      tab.canGoForward = history.currentIndex < history.entries.length - 1;
      // The headless shell reports no title changes as target info; history has them.
      const title = history.entries[history.currentIndex]?.title;
      if (title !== undefined) tab.title = title.slice(0, MAX_TITLE_CHARS);
      publishTabs();
    });

  /** Forgets the tab's page; its viewers are told why. */
  const dropPage = (
    tab: Tab,
    state: "suspended" | "crashed",
    close: { code: number; reason: string },
  ) => {
    if (tab.page) sessions.delete(tab.page.sessionId);
    for (const viewer of tab.viewers) {
      if (viewer.sessionId !== null) sessions.delete(viewer.sessionId);
      viewer.sessionId = null;
    }
    closeViewers(tab, close.code, close.reason);
    tab.page = null;
    tab.state = state;
    tab.loading = false;
    tab.dialog = null;
    tab.pressedKeys.clear();
    tab.pressedButtons.clear();
  };

  const onPageEvent = (tab: Tab, sessionId: string, method: string, params: unknown) => {
    const page = tab.page;
    if (!page || page.sessionId !== sessionId) return Effect.void;
    switch (method) {
      case "Page.frameNavigated": {
        const frame = Option.getOrUndefined(decodeFrameNavigated(params))?.frame;
        if (!frame || frame.parentId !== undefined) return Effect.void;
        if (!committedSchemeAllowed(frame.url)) {
          // Never reached through Ryco's own commands; leave whatever got there.
          tab.error = { code: "blocked-url", text: "The node browser does not open this address." };
          publishTabs();
          return running
            ? running.cdp.post("Page.navigate", { url: "about:blank" }, sessionId)
            : Effect.void;
        }
        tab.url = displayNodeBrowserUrl(frame.unreachableUrl ?? frame.url);
        // A refused address stays reported until the next navigation Ryco itself starts.
        if (frame.unreachableUrl === undefined && tab.error?.code !== "blocked-url") {
          tab.error = null;
        }
        publishTabs();
        return fork(refreshHistory(tab));
      }
      case "Page.navigatedWithinDocument": {
        const event = Option.getOrUndefined(decodeWithinDocument(params));
        if (!event || event.frameId !== page.targetId) return Effect.void;
        tab.url = displayNodeBrowserUrl(event.url);
        publishTabs();
        return fork(refreshHistory(tab));
      }
      case "Page.frameStartedLoading":
      case "Page.frameStoppedLoading": {
        if (Option.getOrUndefined(decodeFrameId(params))?.frameId !== page.targetId) {
          return Effect.void;
        }
        tab.loading = method === "Page.frameStartedLoading";
        publishTabs();
        return tab.loading ? Effect.void : fork(refreshHistory(tab));
      }
      case "Page.javascriptDialogOpening": {
        const dialog = Option.getOrUndefined(decodeDialog(params));
        if (!dialog) return Effect.void;
        tab.dialog = {
          type: dialog.type,
          message: dialog.message.slice(0, 4_000),
          defaultValue: (dialog.defaultPrompt ?? "").slice(0, 4_000),
        };
        publishTabs();
        return Effect.void;
      }
      case "Page.javascriptDialogClosed":
        tab.dialog = null;
        publishTabs();
        return Effect.void;
      case "Inspector.targetCrashed":
        dropPage(tab, "crashed", { code: NODE_BROWSER_FRAME_CLOSE.tabGone, reason: "crashed" });
        tab.error = { code: "crashed", text: "The page crashed. Reload to open it again." };
        publishTabs();
        return running
          ? running.cdp.post("Target.closeTarget", { targetId: page.targetId })
          : Effect.void;
    }
    return Effect.void;
  };

  const onEvent = ({ method, sessionId, params }: CdpEvent): Effect.Effect<void> => {
    if (sessionId === undefined) {
      if (method === "Target.targetInfoChanged") {
        const info = Option.getOrUndefined(decodeTargetInfo(params))?.targetInfo;
        const tab = info && [...tabs.values()].find((tab) => tab.page?.targetId === info.targetId);
        if (tab && info && info.title !== tab.title) {
          tab.title = info.title.slice(0, MAX_TITLE_CHARS);
          publishTabs();
        }
      } else if (method === "Target.detachedFromTarget") {
        // A page that closed itself: keep the tab, as a suspended one.
        const detached = Option.getOrUndefined(decodeSessionId(params))?.sessionId;
        const owner = detached === undefined ? undefined : sessions.get(detached);
        if (owner?.kind === "page" && owner.tab.page?.sessionId === detached) {
          dropPage(owner.tab, "suspended", {
            code: NODE_BROWSER_FRAME_CLOSE.restarted,
            reason: "page closed",
          });
          publishTabs();
        }
      }
      return Effect.void;
    }
    const owner = sessions.get(sessionId);
    if (!owner) return Effect.void;
    if (owner.kind === "viewer") {
      return method === "Page.screencastFrame"
        ? onScreencastFrame(owner.viewer, owner.tab, params)
        : Effect.void;
    }
    return onPageEvent(owner.tab, sessionId, method, params);
  };

  // A frame past its limit is dropped, but Chromium still waits for its acknowledgement.
  const onOversizedEvent = (head: string, tail: string) => {
    if (!head.startsWith('{"method":"Page.screencastFrame"')) return Effect.void;
    const match = /"sessionId":(\d+)\},"sessionId":"([^"]+)"\}$/u.exec(tail);
    if (!match || !running) return Effect.void;
    return running.cdp.post("Page.screencastFrameAck", { sessionId: Number(match[1]) }, match[2]);
  };

  const onExit = (error: NodeBrowserCdpError) =>
    Effect.gen(function* () {
      const exited = running;
      running = null;
      sessions.clear();
      for (const tab of tabs.values()) {
        if (tab.state === "live") {
          dropPage(tab, "suspended", {
            code: NODE_BROWSER_FRAME_CLOSE.restarted,
            reason: "browser restarted",
          });
        }
      }
      const at = now();
      exits = [...exits.filter((exit) => exit > at - CRASH_LOOP_WINDOW_MS), at];
      if (exits.length >= CRASH_LOOP_EXITS) {
        pausedUntil = at + CRASH_LOOP_PAUSE_MS;
        exits = [];
      }
      if (error.output !== undefined && SANDBOX_FAILURE.test(error.output)) sandboxBlocked = true;
      yield* Effect.logWarning("The node browser exited.", { output: error.output?.slice(-1_000) });
      publishTabs();
      yield* publishAvailability;
      // Last: closing its scope ends the fiber this runs on.
      if (exited) yield* fork(Scope.close(exited.scope, Exit.void));
    });

  /** The running browser, started if need be. Under `lifecycle`. */
  const ensureBrowser = Effect.gen(function* () {
    if (running) return running;
    if (!options.baseCapability.available) {
      return yield* rpcError("unavailable", "Node browser tabs are not available on this machine.");
    }
    // A sandbox failure is reported but tried again: the host may have been set up since.
    if (pausedUntil !== null && now() < pausedUntil) {
      return yield* rpcError(
        "unavailable",
        "The node browser exited several times in a row. Ryco will try again in a few minutes.",
        true,
      );
    }
    const executable = yield* previewBrowser.executable.pipe(Effect.mapError(installError));
    yield* fileSystem
      .makeDirectory(profileDirectory, { recursive: true, mode: 0o700 })
      .pipe(Effect.ignore);
    const scope = yield* Scope.fork(runtimeScope);
    const started = yield* Effect.gen(function* () {
      const cdp = yield* launch({
        executable,
        args: nodeBrowserArguments({ noSandbox: options.noSandbox, profileDirectory }),
        onEvent,
        onOversizedEvent,
        onExit,
      });
      // Nothing downloads to the node.
      yield* cdp.send("Browser.setDownloadBehavior", { behavior: "deny" }, Ignored);
      yield* cdp.send("Target.setDiscoverTargets", { discover: true }, Ignored);
      const { userAgent } = yield* cdp.send("Browser.getVersion", {}, Version);
      return {
        cdp,
        scope,
        identity: chromeIdentity(userAgent, {
          platform: process.platform,
          arch: process.arch,
          release: NodeOS.release(),
        }),
      } satisfies Running;
    }).pipe(Scope.provide(scope), Effect.provideContext(launchServices), Effect.exit);
    if (Exit.isFailure(started)) {
      yield* Scope.close(scope, Exit.void);
      return yield* rpcError("failed", "The node browser could not be started.", true);
    }
    sandboxBlocked = false;
    running = started.value;
    idleSince = null;
    return started.value;
  });

  /** A fresh page for the tab at its address. Under `lifecycle`. */
  const createPage = (tab: Tab) =>
    Effect.gen(function* () {
      const browser = yield* ensureBrowser;
      const { cdp } = browser;
      const { targetId } = yield* cdp.send(
        "Target.createTarget",
        { url: "about:blank" },
        TargetCreated,
      );
      const { sessionId } = yield* cdp.send(
        "Target.attachToTarget",
        { targetId, flatten: true },
        Attached,
      );
      tab.page = { targetId, sessionId };
      sessions.set(sessionId, { kind: "page", tab });
      const setup: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
        ["Page.enable", {}],
        ["Inspector.enable", {}],
        // The page's file pickers never open; uploads are not part of node tabs yet.
        ["Page.setInterceptFileChooserDialog", { enabled: true }],
        ...(browser.identity
          ? [["Emulation.setUserAgentOverride", browser.identity] as const]
          : []),
        [
          "Emulation.setDeviceMetricsOverride",
          { ...tab.viewport, deviceScaleFactor: RENDER_SCALE, mobile: false },
        ],
      ];
      for (const [method, params] of setup) yield* cdp.send(method, params, Ignored, sessionId);
      tab.state = "live";
      tab.error = null;
      markUsed(tab);
      if (tab.url !== "about:blank") yield* navigate(tab, tab.url);
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "NodeBrowserRpcError"
          ? error
          : rpcError("failed", "The node browser could not open the page.", true),
      ),
    );

  const closePage = (tab: Tab) =>
    Effect.suspend(() => {
      const page = tab.page;
      if (!page || !running) return Effect.void;
      return running.cdp.post("Target.closeTarget", { targetId: page.targetId });
    });

  /** Suspends the least recently used live tab nobody watches, to make room. */
  const makeLiveRoom = Effect.gen(function* () {
    const live = [...tabs.values()].filter((tab) => tab.state === "live");
    if (live.length < NODE_BROWSER_LIVE_TAB_LIMIT) return;
    const idle = live
      .filter((tab) => tab.viewers.size === 0)
      .toSorted((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
    if (!idle) {
      return yield* rpcError(
        "limit-reached",
        `The node browser keeps at most ${NODE_BROWSER_LIVE_TAB_LIMIT} tabs running while they are watched.`,
      );
    }
    yield* suspend(idle);
  });

  const suspend = (tab: Tab) =>
    Effect.gen(function* () {
      yield* closePage(tab);
      dropPage(tab, "suspended", { code: NODE_BROWSER_FRAME_CLOSE.restarted, reason: "suspended" });
      publishTabs();
    });

  /** The tab's page, re-created if it was suspended or crashed. */
  const ensureLive = (tab: Tab) =>
    tab.state === "live" && tab.page
      ? Effect.void
      : lifecycle.withPermit(
          Effect.gen(function* () {
            if (!tabs.has(tab.id)) return yield* rpcError("not-found", "The tab is closed.");
            if (tab.state === "live" && tab.page) return;
            yield* makeLiveRoom;
            yield* createPage(tab);
            publishTabs();
          }),
        );

  const navigate = (tab: Tab, url: string) =>
    Effect.gen(function* () {
      const page = tab.page;
      const cdp = running?.cdp;
      if (!page || !cdp) return;
      tab.loading = true;
      tab.error = null;
      // Followed in the background: a slow load never holds up input or other commands.
      yield* fork(
        cdp.send("Page.navigate", { url }, Navigated, page.sessionId).pipe(
          Effect.timeout(NAVIGATION_TIMEOUT),
          Effect.tap((result) =>
            Effect.sync(() => {
              if (!result.errorText || tab.page !== page) return;
              tab.error = { code: "navigation-failed", text: result.errorText.slice(0, 256) };
              tab.loading = false;
              publishTabs();
            }),
          ),
        ),
      );
    });

  const findTab = (tabId: string) =>
    Effect.suspend(() => {
      const tab = tabs.get(tabId);
      return tab ? Effect.succeed(tab) : Effect.fail(rpcError("not-found", "The tab is closed."));
    });

  const pageOf = (tab: Tab) =>
    Effect.suspend(() => {
      const page = tab.page;
      const cdp = running?.cdp;
      return page && cdp
        ? Effect.succeed({ page, cdp })
        : Effect.fail(rpcError("not-found", "The tab is not running.", true));
    });

  const open = (scope: string, rawUrl: string) =>
    Effect.gen(function* () {
      const url = normalizeNodeBrowserUrl(rawUrl);
      if (url === null) {
        return yield* rpcError(
          "invalid-url",
          "Enter an http or https address without credentials.",
        );
      }
      const tab: Tab = yield* lifecycle.withPermit(
        Effect.gen(function* () {
          // Counted before anything starts, so concurrent opens never pass the cap.
          if (tabs.size >= NODE_BROWSER_TAB_LIMIT) {
            return yield* rpcError(
              "limit-reached",
              `The node browser keeps at most ${NODE_BROWSER_TAB_LIMIT} tabs open.`,
            );
          }
          const tab: Tab = {
            id: crypto.randomUUID(),
            scope,
            url,
            title: "",
            loading: false,
            canGoBack: false,
            canGoForward: false,
            state: "suspended",
            viewport: { ...DEFAULT_VIEWPORT },
            dialog: null,
            error: null,
            page: null,
            viewers: new Set(),
            lastUsedAt: now(),
            scrolledAt: Number.NEGATIVE_INFINITY,
            lastInputAt: 0,
            capturing: 0,
            stillSeq: 0,
            captureLock: yield* Semaphore.make(1),
            inputLock: yield* Semaphore.make(1),
            pressedKeys: new Map(),
            pressedButtons: new Map(),
          };
          tabs.set(tab.id, tab);
          yield* makeLiveRoom;
          yield* createPage(tab).pipe(
            Effect.tapError(() =>
              Effect.andThen(
                closePage(tab),
                Effect.sync(() => tabs.delete(tab.id)),
              ),
            ),
          );
          return tab;
        }),
      );
      publishTabs();
      return tab;
    });

  const command = (
    input: NodeBrowserCommand,
  ): Effect.Effect<NodeBrowserCommandResult, NodeBrowserRpcError> =>
    Effect.gen(function* () {
      if (input.type === "open") return { tab: snapshot(yield* open(input.scope, input.url)) };
      const tab = yield* findTab(input.tabId);
      markUsed(tab);
      switch (input.type) {
        case "close":
          yield* lifecycle.withPermit(
            Effect.gen(function* () {
              yield* closePage(tab);
              dropPage(tab, "suspended", {
                code: NODE_BROWSER_FRAME_CLOSE.tabGone,
                reason: "closed",
              });
              tabs.delete(tab.id);
            }),
          );
          publishTabs();
          return { tab: null };
        case "wake":
          yield* ensureLive(tab);
          break;
        case "navigate": {
          const url = normalizeNodeBrowserUrl(input.url);
          if (url === null) {
            return yield* rpcError(
              "invalid-url",
              "Enter an http or https address without credentials.",
            );
          }
          yield* ensureLive(tab);
          yield* navigate(tab, url);
          break;
        }
        case "reload":
          if (tab.state !== "live") {
            yield* ensureLive(tab);
            break;
          }
          yield* Effect.flatMap(pageOf(tab), ({ page, cdp }) =>
            cdp.post("Page.reload", { ignoreCache: input.ignoreCache === true }, page.sessionId),
          );
          break;
        case "stop":
          yield* Effect.flatMap(pageOf(tab), ({ page, cdp }) =>
            cdp.post("Page.stopLoading", {}, page.sessionId),
          );
          break;
        case "history": {
          const { page, cdp } = yield* pageOf(tab);
          const history = yield* cdp
            .send("Page.getNavigationHistory", {}, History, page.sessionId)
            .pipe(
              Effect.mapError(() => rpcError("failed", "The tab's history is unavailable.", true)),
            );
          const entry = history.entries[history.currentIndex + input.delta];
          if (entry)
            yield* cdp.post("Page.navigateToHistoryEntry", { entryId: entry.id }, page.sessionId);
          break;
        }
        case "resize":
          // The newest size wins when several clients watch one tab.
          tab.viewport = { width: input.width, height: input.height };
          if (tab.page && running) {
            yield* running.cdp.post(
              "Emulation.setDeviceMetricsOverride",
              { ...tab.viewport, deviceScaleFactor: RENDER_SCALE, mobile: false },
              tab.page.sessionId,
            );
          }
          publishTabs();
          break;
        case "dialog": {
          if (!tab.dialog) break;
          const { page, cdp } = yield* pageOf(tab);
          yield* cdp.post(
            "Page.handleJavaScriptDialog",
            {
              accept: input.accept,
              ...(input.promptText === undefined ? {} : { promptText: input.promptText }),
            },
            page.sessionId,
          );
          break;
        }
      }
      return { tab: tabs.has(tab.id) ? snapshot(tab) : null };
    });

  // ── Input ──

  const releaseHeld = (tab: Tab) =>
    Effect.gen(function* () {
      const page = tab.page;
      const cdp = running?.cdp;
      const keys = [...tab.pressedKeys.values()];
      const buttons = [...tab.pressedButtons];
      tab.pressedKeys.clear();
      tab.pressedButtons.clear();
      if (!page || !cdp) return;
      for (const { key, code } of keys) {
        yield* cdp.post("Input.dispatchKeyEvent", { type: "keyUp", key, code }, page.sessionId);
      }
      for (const [button, point] of buttons) {
        yield* cdp.post(
          "Input.dispatchMouseEvent",
          { type: "mouseReleased", button, ...point, buttons: 0, clickCount: 1 },
          page.sessionId,
        );
      }
    });

  const dispatch = (
    tab: Tab,
    cdp: NodeBrowserCdp,
    sessionId: string,
    event: NodeBrowserInputEvent,
  ) => {
    const send = (method: string, params: Record<string, unknown>) =>
      cdp
        .send(method, params, Ignored, sessionId)
        .pipe(Effect.timeout(INPUT_TIMEOUT), Effect.ignore);
    switch (event.type) {
      case "mouse": {
        const x = clamp(event.x, tab.viewport.width);
        const y = clamp(event.y, tab.viewport.height);
        const type =
          event.action === "down"
            ? "mousePressed"
            : event.action === "up"
              ? "mouseReleased"
              : "mouseMoved";
        if (event.button !== "none") {
          if (event.action === "down") tab.pressedButtons.set(event.button, { x, y });
          else if (event.action === "up") tab.pressedButtons.delete(event.button);
        }
        return send("Input.dispatchMouseEvent", {
          type,
          x,
          y,
          button: event.button,
          buttons: event.buttons,
          clickCount: event.clickCount,
          modifiers: event.modifiers,
        });
      }
      case "wheel":
        tab.scrolledAt = now();
        return send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: clamp(event.x, tab.viewport.width),
          y: clamp(event.y, tab.viewport.height),
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          modifiers: event.modifiers,
        });
      case "key": {
        if (event.action === "up") {
          tab.pressedKeys.delete(event.code || event.key);
          return send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: event.key,
            code: event.code,
            modifiers: event.modifiers,
          });
        }
        tab.pressedKeys.set(event.code || event.key, { key: event.key, code: event.code });
        const text = event.text;
        return send("Input.dispatchKeyEvent", {
          type: text ? "keyDown" : "rawKeyDown",
          key: event.key,
          code: event.code,
          modifiers: event.modifiers,
          ...(text ? { text, unmodifiedText: text } : {}),
          ...editingCommand(event.key, event.modifiers),
          windowsVirtualKeyCode:
            event.keyCode ?? (event.key.length === 1 ? event.key.toUpperCase().charCodeAt(0) : 0),
        });
      }
      case "text":
        return send("Input.insertText", { text: event.text });
      case "release":
        return releaseHeld(tab);
    }
  };

  const input = (request: NodeBrowserInputRequest) =>
    Effect.gen(function* () {
      const tab = yield* findTab(request.tabId);
      markUsed(tab);
      // A page with a dialog open takes no input until the dialog is answered.
      if (tab.dialog !== null || tab.state !== "live") return;
      yield* tab.inputLock.withPermit(
        Effect.gen(function* () {
          const page = tab.page;
          const cdp = running?.cdp;
          if (!page || !cdp) return;
          for (const event of coalesceInput(request.events)) {
            yield* dispatch(tab, cdp, page.sessionId, event);
          }
        }),
      );
      const at = now();
      tab.lastInputAt = at;
      if (tab.pressedKeys.size === 0 && tab.pressedButtons.size === 0) return;
      // Held input a client never let go of (it went away mid-drag) is released.
      yield* fork(
        Effect.gen(function* () {
          yield* Effect.sleep(INPUT_RELEASE_WATCHDOG_MS);
          if (tab.lastInputAt === at) yield* tab.inputLock.withPermit(releaseHeld(tab));
        }),
      );
    });

  // ── Reads ──

  /** A still with every screencast of the tab paused, so they never compete for the page. */
  const still = (request: Extract<NodeBrowserReadRequest, { readonly type: "still" }>) =>
    Effect.gen(function* () {
      const tab = yield* findTab(request.tabId);
      markUsed(tab);
      yield* ensureLive(tab);
      const captured = yield* tab.captureLock.withPermit(
        Effect.gen(function* () {
          const { page } = yield* pageOf(tab);
          tab.capturing += 1;
          yield* Effect.forEach(
            [...tab.viewers],
            (viewer) =>
              viewer.sessionId === null || !running
                ? Effect.void
                : running.cdp.post("Page.stopScreencast", {}, viewer.sessionId),
            { discard: true },
          );
          return yield* captureStill(page.sessionId, request).pipe(
            Effect.ensuring(
              Effect.suspend(() => {
                tab.capturing -= 1;
                return Effect.forEach(
                  [...tab.viewers],
                  (viewer) => fork(startScreencast(viewer, tab, viewer.scale)),
                  { discard: true },
                );
              }),
            ),
          );
        }),
      );
      markUsed(tab);
      if (captured.data.length > NODE_BROWSER_STILL_MAX_BASE64) {
        return yield* rpcError("failed", "The still is too large; ask for a smaller one.", true);
      }
      return {
        mimeType: "image/jpeg",
        width: captured.width,
        height: captured.height,
        cssWidth: captured.cssWidth,
        cssHeight: captured.cssHeight,
        seq: tab.stillSeq++,
        bytesBase64: captured.data,
      } satisfies NodeBrowserStill;
    });

  const read = (
    request: NodeBrowserReadRequest,
  ): Effect.Effect<NodeBrowserReadResponse, NodeBrowserRpcError> =>
    request.type === "list"
      ? Effect.sync(() => ({ type: "list" as const, tabs: list() }))
      : Effect.map(still(request), (result) => ({ type: "still" as const, still: result }));

  const subscribe: Stream.Stream<NodeBrowserEvent> = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(events);
      return Stream.concat(
        Stream.make(
          { type: "availability", capability: yield* capability } satisfies NodeBrowserEvent,
          { type: "tabs", tabs: list() } satisfies NodeBrowserEvent,
        ),
        Stream.fromSubscription(subscription),
      );
    }),
  );

  // ── Frame sockets ──

  /** Attaches a viewer to the tab for the life of the scope. */
  const attachViewer = (request: NonNullable<ReturnType<typeof viewerRequestFrom>>) =>
    Effect.gen(function* () {
      const tab = tabs.get(request.tabId);
      if (!tab || tab.state === "crashed") return { _tag: "close", ...GONE } as const;
      if (
        tab.viewers.size >= NODE_BROWSER_VIEWERS_PER_TAB ||
        screencastCount() >= NODE_BROWSER_SCREENCASTS
      ) {
        return {
          _tag: "close",
          code: NODE_BROWSER_FRAME_CLOSE.capacity,
          reason: "capacity",
        } as const;
      }
      const viewer: Viewer = {
        output: yield* Queue.dropping<ViewerOutput>(VIEWER_OUTPUT_LIMIT),
        maxWidth: request.maxWidth,
        maxHeight: request.maxHeight,
        quality: request.quality,
        screencastLock: yield* Semaphore.make(1),
        sessionId: null,
        scale: 1,
        motion: false,
        started: false,
        framesInFlight: 0,
        mayHaveDropped: false,
        recentFrames: [],
        settleGeneration: 0,
        seq: 0,
      };
      tab.viewers.add(viewer);
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          tab.viewers.delete(viewer);
          viewer.settleGeneration += 1;
          markUsed(tab);
          const sessionId = viewer.sessionId;
          viewer.sessionId = null;
          if (sessionId === null) return;
          sessions.delete(sessionId);
          if (!running) return;
          yield* running.cdp.post("Page.stopScreencast", {}, sessionId);
          yield* running.cdp.post("Target.detachFromTarget", { sessionId });
        }),
      );
      const live = yield* ensureLive(tab).pipe(Effect.exit);
      if (Exit.isFailure(live)) {
        const current = yield* capability;
        return current.available
          ? ({
              _tag: "close",
              code: NODE_BROWSER_FRAME_CLOSE.capacity,
              reason: "not running",
            } as const)
          : ({
              _tag: "close",
              code: NODE_BROWSER_FRAME_CLOSE.unavailable,
              reason: current.reason ?? "unavailable",
            } as const);
      }
      const attached = yield* Effect.gen(function* () {
        const { page, cdp } = yield* pageOf(tab);
        const { sessionId } = yield* cdp.send(
          "Target.attachToTarget",
          { targetId: page.targetId, flatten: true },
          Attached,
        );
        viewer.sessionId = sessionId;
        sessions.set(sessionId, { kind: "viewer", tab, viewer });
      }).pipe(Effect.exit);
      if (Exit.isFailure(attached)) {
        return {
          _tag: "close",
          code: NODE_BROWSER_FRAME_CLOSE.capacity,
          reason: "not running",
        } as const;
      }
      yield* startScreencast(viewer, tab, 1);
      // An idle page never repaints for a new screencast, so the viewer starts from a still.
      if (!viewer.started) yield* pushStill(viewer, tab);
      return { _tag: "attached", viewer } as const;
    });

  const serveViewer: NodeBrowserRuntime["serveViewer"] = (socket, params) =>
    Effect.gen(function* () {
      const request = viewerRequestFrom(params);
      const attached = request
        ? yield* attachViewer(request)
        : ({ _tag: "close", ...GONE } as const);
      if (attached._tag === "close") {
        return yield* socket.write(new Socket.CloseEvent(attached.code, attached.reason));
      }
      return yield* serveViewerSocket(socket, attached.viewer.output);
    }).pipe(Effect.ignore);

  // ── Idle ──

  const sweep = lifecycle.withPermit(
    Effect.gen(function* () {
      const at = now();
      if (pausedUntil !== null && at >= pausedUntil) {
        pausedUntil = null;
        yield* publishAvailability;
      }
      for (const tab of tabs.values()) {
        if (
          tab.state === "live" &&
          tab.viewers.size === 0 &&
          at - tab.lastUsedAt >= NODE_BROWSER_IDLE_SUSPEND_MS
        ) {
          yield* suspend(tab);
        }
      }
      if (!running) return;
      if ([...tabs.values()].some((tab) => tab.state === "live")) {
        idleSince = null;
        return;
      }
      idleSince ??= at;
      if (at - idleSince < NODE_BROWSER_IDLE_EXIT_MS) return;
      const stopping = running;
      running = null;
      idleSince = null;
      sessions.clear();
      yield* Scope.close(stopping.scope, Exit.void);
    }),
  );
  yield* Effect.forkIn(Effect.repeat(sweep, Schedule.spaced(IDLE_SWEEP_INTERVAL)), runtimeScope);

  return {
    capability,
    read,
    command,
    input,
    subscribe,
    serveViewer,
  } satisfies NodeBrowserRuntime;
});

const GONE = { code: NODE_BROWSER_FRAME_CLOSE.tabGone, reason: "tab gone" } as const;
