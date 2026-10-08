/**
 * headlessChrome - Drives the pinned headless shell over the Chrome DevTools
 * Protocol to load an HTML page, measure it, and screenshot it.
 *
 * Each call launches its own browser with a fresh temporary profile, talks to
 * it over `--remote-debugging-pipe` (never a TCP port another process could
 * attach to), and kills its process group when the scope closes.
 *
 * @module headlessChrome
 */
import type { ThemeAppearance } from "@ryco/shared/themePalettes";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Path,
  Queue,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeCdpFrameReader } from "./cdpFrameReader.ts";
import type { HtmlRenderConsoleMessage } from "./HtmlRender.ts";
import { publicProxy } from "./publicProxy.ts";

export class HtmlRenderBrowserError extends Schema.TaggedError<HtmlRenderBrowserError>()(
  "HtmlRenderBrowserError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    /** The end of the browser's stderr when it exited, for diagnosing host setup. */
    output: Schema.optional(Schema.String),
    /** Where the main frame went when the page left itself, which no capture shows. */
    navigatedTo: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `The HTML preview browser could not render the page: ${this.reason}.`;
  }
}

type BrowserFailure = HtmlRenderBrowserError;

const MAX_CONSOLE_MESSAGES = 20;
const MAX_CONSOLE_TEXT_CHARS = 500;
// Where a page tried to navigate, as told to the agent.
const MAX_NAVIGATION_URL_CHARS = 200;
const MAX_NAVIGATIONS = 10;
// The browser's own replies are at most a screenshot: 1600 × 4000 px of
// incompressible PNG is about 34 MB of base64. Events carry what a page
// logged or requested, of which a preview keeps a few hundred characters, so
// one larger than this is dropped unread.
const MAX_CDP_REPLY_CHARS = 48 * 1024 * 1024;
const MAX_CDP_EVENT_CHARS = 1024 * 1024;
const VIEWPORT_HEIGHT = 800;
const MAX_CAPTURE_HEIGHT = 4_000;
export const CAPTURE_TIMEOUT = "20 seconds";
// Pages load from this made-up web origin, never from a file. Chrome refuses
// local files to every web page, frame, worker, and popup, so a page cannot
// read files the agent's provider withholds; local images reach it already
// inlined as data URIs. `.localhost` keeps it a secure context that may still
// load plain-http resources, and the request never leaves the browser.
// All of the browser's traffic goes through `publicProxy`, which only reaches
// public addresses, so a page cannot reach this machine's local network. The
// main frame also stays on the page and the browser opens no popups, so a
// capture shows the page itself or fails saying where the page went.
export const PAGE_ORIGIN = "http://ryco-page.localhost";
const PAGE_URL = `${PAGE_ORIGIN}/page.html`;
// Stack traces and load errors name the page this way instead of its URL.
const PAGE_NAME = "page.html";
// Each measuring load reads its own copy of the page off the pipe.
const MEASURE_CONCURRENCY = 3;

const textEncoder = new TextEncoder();

/**
 * A page as the base64 bytes `PAGE_URL` serves, encoded once however often it
 * loads. Node's encoder, since pages run to 25 MiB.
 */
const pageBody = (html: string) =>
  Buffer.from(Buffer.from(html, "utf8").toString("base64"), "latin1");

const CdpMessage = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optional(Schema.Number),
    method: Schema.optional(Schema.String),
    sessionId: Schema.optional(Schema.String),
    params: Schema.optional(Schema.Unknown),
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ message: Schema.String })),
  }),
);
const decodeCdpMessage = Schema.decodeUnknownOption(CdpMessage);
const encodeCdpCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const RemoteObject = Schema.Struct({
  type: Schema.String,
  value: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.String),
});
const decodeConsoleApiCalled = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.String, args: Schema.Array(RemoteObject) }),
);
const decodeExceptionThrown = Schema.decodeUnknownOption(
  Schema.Struct({
    exceptionDetails: Schema.Struct({
      text: Schema.String,
      exception: Schema.optional(RemoteObject),
    }),
  }),
);
const decodeRequestPaused = Schema.decodeUnknownOption(
  Schema.Struct({
    requestId: Schema.String,
    request: Schema.Struct({ url: Schema.String }),
    frameId: Schema.optional(Schema.String),
    resourceType: Schema.optional(Schema.String),
  }),
);
const decodeFrameEvent = Schema.decodeUnknownOption(Schema.Struct({ frameId: Schema.String }));
const decodeFrameNavigated = Schema.decodeUnknownOption(
  Schema.Struct({ frame: Schema.Struct({ id: Schema.String, url: Schema.String }) }),
);
const decodeBindingCalled = Schema.decodeUnknownOption(
  Schema.Struct({ name: Schema.String, payload: Schema.String }),
);
const decodeLogEntryAdded = Schema.decodeUnknownOption(
  Schema.Struct({
    entry: Schema.Struct({
      level: Schema.String,
      text: Schema.String,
      url: Schema.optional(Schema.String),
    }),
  }),
);

const remoteObjectText = (value: typeof RemoteObject.Type) =>
  typeof value.value === "string"
    ? value.value
    : (value.description ?? (value.value === undefined ? value.type : String(value.value)));

const CONSOLE_LEVELS: Readonly<Record<string, HtmlRenderConsoleMessage["level"]>> = {
  log: "log",
  debug: "log",
  dir: "log",
  dirxml: "log",
  table: "log",
  trace: "log",
  info: "info",
  warning: "warning",
  error: "error",
  assert: "error",
};

/**
 * Whether a raw CDP message is console output a preview reports (true), console
 * output it ignores (false), or something else (undefined), read from its
 * start alone, where Chrome writes the method and these first parameters.
 */
export const consoleEventReported = (head: string): boolean | undefined => {
  const logged = /^\{"method":"Runtime\.consoleAPICalled","params":\{"type":"(\w+)"/.exec(head);
  if (logged) return Object.hasOwn(CONSOLE_LEVELS, logged[1]!);
  if (head.startsWith('{"method":"Runtime.exceptionThrown"')) return true;
  const entry =
    /^\{"method":"Log\.entryAdded","params":\{"entry":\{"source":"[\w-]+","level":"(\w+)"/.exec(
      head,
    );
  return entry ? entry[1] === "error" || entry[1] === "warning" : undefined;
};

/** Joined argument text, cut well before its whole length is ever built. */
const boundedText = (parts: ReadonlyArray<string>) => {
  const limit = MAX_CONSOLE_TEXT_CHARS + PAGE_URL.length + 1;
  let text = "";
  for (const part of parts) {
    text += (text === "" ? "" : " ") + part.slice(0, limit);
    if (text.length >= limit) break;
  }
  return text;
};

/** Everything the page logs, uncaught exceptions, and the browser's own load errors. */
const consoleMessageFromEvent = (
  method: string,
  params: unknown,
): HtmlRenderConsoleMessage | undefined => {
  if (method === "Runtime.consoleAPICalled") {
    const event = Option.getOrUndefined(decodeConsoleApiCalled(params));
    const level = event === undefined ? undefined : CONSOLE_LEVELS[event.type];
    return event && level
      ? { level, text: boundedText(event.args.map(remoteObjectText)) }
      : undefined;
  }
  if (method === "Runtime.exceptionThrown") {
    const details = Option.getOrUndefined(decodeExceptionThrown(params))?.exceptionDetails;
    return details
      ? { level: "error", text: details.exception?.description ?? details.text }
      : undefined;
  }
  if (method === "Log.entryAdded") {
    const entry = Option.getOrUndefined(decodeLogEntryAdded(params))?.entry;
    return entry && (entry.level === "error" || entry.level === "warning")
      ? { level: entry.level, text: entry.url ? `${entry.text} ${entry.url}` : entry.text }
      : undefined;
  }
  return undefined;
};

/**
 * What to do with a request the browser paused: serve the page itself, let a
 * frame inside the page show another site or a plain-http resource load (still
 * through the proxy), or refuse it. The main frame never leaves the page.
 * `PAGE_SETUP_SCRIPT` cancels its navigations before they start; any that
 * still reach the network are aborted, which leaves the page in place where a
 * failure would replace it with an error page. Ryco's made-up origin serves
 * nothing but the page.
 */
export const pausedRequestAction = (input: {
  readonly url: string;
  readonly frameId: string | undefined;
  readonly resourceType: string | undefined;
  readonly mainFrameId: string;
  readonly hasPage: boolean;
}): "fulfill" | "continue" | "abort" | "fail" => {
  const url = input.url.split("#", 1)[0]!;
  const document = input.resourceType === "Document";
  const mainFrame = input.frameId === input.mainFrameId;
  if (url === PAGE_URL && input.hasPage && (!document || mainFrame)) return "fulfill";
  if (document && mainFrame) return "abort";
  return url.startsWith(`${PAGE_ORIGIN}/`) ? "fail" : "continue";
};

/**
 * The origin of a plain-http request the page makes to anywhere but Ryco's
 * own origin. The preview is a secure context that may still load these, but
 * readers on HTTPS clients block them as mixed content.
 */
export const plainHttpOrigin = (url: string): string | undefined => {
  if (!url.startsWith("http:") || url.startsWith(`${PAGE_ORIGIN}/`)) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

// Resolves after web fonts load and two frames paint, so late layout lands in the capture.
const SETTLE_EXPRESSION =
  "document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))";
// The root's scroll height never drops below the viewport, so a short page
// reports its own box height instead. The bootstrap reports the same number
// to clients.
const MEASURE_EXPRESSION =
  "(() => { const root = document.documentElement; return root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height; })()";
// Called by `PAGE_SETUP_SCRIPT` with where the main frame tried to go.
const NAVIGATION_BINDING = "__rycoPreviewNavigation";
// Runs before page scripts in every frame. Previews have no use for WebRTC,
// whose ICE servers can make the browser resolve names outside the proxy.
// Readers show the page in a sandboxed frame with an opaque origin, where
// storage and cookies throw a SecurityError (these are Chromium's own
// messages), so the preview throws the same and the agent sees it in the
// console instead of a page that works only here.
// The main frame's navigations to other documents are cancelled before they
// start, so the page keeps loading as written: a navigation that started
// would stop the parser, and one started in <head> leaves a document Chrome
// never renders. Only history traversals cannot be cancelled; the main frame
// committing anything but the page fails the load instead. Ryco hears of each
// attempt through a binding the page's own scripts never see.
export const PAGE_SETUP_SCRIPT = `(() => {
  const report = globalThis[${JSON.stringify(NAVIGATION_BINDING)}];
  delete globalThis[${JSON.stringify(NAVIGATION_BINDING)}];
  delete window.RTCPeerConnection;
  delete window.webkitRTCPeerConnection;
  const sandboxed = "The document is sandboxed and lacks the 'allow-same-origin' flag.";
  const denied = (message) => new DOMException(message, "SecurityError");
  const deny = (target, name, descriptor) => {
    try {
      Object.defineProperty(target, name, { configurable: true, enumerable: true, ...descriptor });
    } catch {}
  };
  for (const name of ["localStorage", "sessionStorage"]) {
    deny(window, name, { get() { throw denied("Failed to read the '" + name + "' property from 'Window': " + sandboxed); } });
  }
  deny(window, "caches", { get() { throw denied("Failed to read the 'caches' property from 'Window': Cache storage is disabled because the context is sandboxed and lacks the 'allow-same-origin' flag."); } });
  deny(Document.prototype, "cookie", {
    get() { throw denied("Failed to read the 'cookie' property from 'Document': " + sandboxed); },
    set() { throw denied("Failed to set the 'cookie' property on 'Document': " + sandboxed); },
  });
  if (typeof IDBFactory === "function") {
    for (const name of ["open", "deleteDatabase"]) {
      deny(IDBFactory.prototype, name, { writable: true, value() { throw denied("Failed to execute '" + name + "' on 'IDBFactory': access to the Indexed Database API is denied in this context."); } });
    }
  }
  if (window !== window.top || !window.navigation) return;
  window.navigation.addEventListener("navigate", (event) => {
    if (event.destination.sameDocument) return;
    if (event.cancelable) event.preventDefault();
    if (typeof report === "function") report(String(event.destination.url).slice(0, ${MAX_NAVIGATION_URL_CHARS}));
  });
})();`;

const Ignored = Schema.Unknown;
const Navigation = Schema.Struct({ errorText: Schema.optional(Schema.String) });
const Measured = Schema.Struct({ result: Schema.Struct({ value: Schema.Finite }) });

interface PageEvents {
  /** The page's main frame, which only ever shows `PAGE_URL`. */
  readonly mainFrameId: string;
  /** The page served for `PAGE_URL`, from `pageBody`. */
  body: Uint8Array | undefined;
  loaded: Deferred.Deferred<void, BrowserFailure> | undefined;
  /** Whether the current load has committed the page in the main frame. */
  committed: boolean;
  /** What the main frame committed instead of the page, if it ever did. */
  leftFor: string | undefined;
  readonly consoleMessages: Array<HtmlRenderConsoleMessage>;
  omittedConsoleMessages: number;
  /** Where the page tried to take its main frame, first attempts first. */
  readonly navigations: Set<string>;
  /** Origins the page loaded plain-http resources from; each is warned about once. */
  readonly plainHttpOrigins: Set<string>;
}

const shortUrl = (url: string) => {
  const bare = url.split("#", 1)[0]!;
  return bare === PAGE_URL
    ? PAGE_NAME
    : bare.length > MAX_NAVIGATION_URL_CHARS
      ? `${bare.slice(0, MAX_NAVIGATION_URL_CHARS)}…`
      : bare;
};

const recordNavigation = (page: PageEvents, url: string) => {
  if (page.navigations.size < MAX_NAVIGATIONS) page.navigations.add(shortUrl(url));
};

/** Records console output, counting what comes past the cap instead of keeping it. */
const pushConsoleMessage = (page: PageEvents, message: HtmlRenderConsoleMessage) => {
  if (page.consoleMessages.length >= MAX_CONSOLE_MESSAGES) {
    page.omittedConsoleMessages += 1;
    return;
  }
  const text = message.text.replaceAll(PAGE_URL, PAGE_NAME);
  page.consoleMessages.push({
    level: message.level,
    text: text.length > MAX_CONSOLE_TEXT_CHARS ? `${text.slice(0, MAX_CONSOLE_TEXT_CHARS)}…` : text,
  });
};

/** Warns once per origin that readers on HTTPS clients will block a plain-http load. */
const recordPlainHttpLoad = (page: PageEvents, url: string) => {
  const origin = plainHttpOrigin(url);
  if (origin === undefined || page.plainHttpOrigins.has(origin)) return;
  page.plainHttpOrigins.add(origin);
  pushConsoleMessage(page, {
    level: "warning",
    text: `The page loads ${shortUrl(url)} over plain http; readers on HTTPS clients block it. Use https.`,
  });
};

/** Tells the agent where its page tried to go, which the capture alone would hide. */
const navigationWarning = (navigations: ReadonlySet<string>): HtmlRenderConsoleMessage => {
  const [first, ...others] = navigations;
  const more =
    others.length === 0
      ? ""
      : ` and ${others.length} other address${others.length === 1 ? "" : "es"}`;
  return {
    level: "warning",
    text: `The page tried to navigate to ${first}${more}. The preview kept the page, but for readers that navigation can replace the page or cut it short, so remove it.`,
  };
};

const leftPage = (url: string) =>
  new HtmlRenderBrowserError({
    reason: `the page navigated away from itself to ${shortUrl(url)}`,
    navigatedTo: shortUrl(url),
  });

export interface BrowserLaunchInput {
  readonly executable: string;
  /** Only when the operator turned Chrome's sandbox off for this host. */
  readonly noSandbox: boolean;
}

/** Browser flags; the debugging pipe, the public-only proxy, and no WebRTC UDP outside it. */
export const browserArguments = (input: {
  readonly noSandbox: boolean;
  readonly proxyPort: number;
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
  // No background requests of the browser's own, and no OS keychain prompts.
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--use-mock-keychain",
  "--password-store=basic",
  `--proxy-server=socks5://127.0.0.1:${input.proxyPort}`,
  // Loopback would otherwise skip the proxy.
  "--proxy-bypass-list=<-loopback>",
  // WebRTC would otherwise send UDP, which no proxy carries.
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ...(input.noSandbox ? ["--no-sandbox"] : []),
  `--user-data-dir=${input.profileDirectory}`,
  "about:blank",
];

/**
 * Starts the headless shell for the life of the scope, speaking CDP over
 * `--remote-debugging-pipe` (fd 3 in, fd 4 out, NUL-delimited JSON). Scope
 * close kills the process group. Each page is its own target, so pages load
 * in parallel.
 */
const launchBrowser = Effect.fnUntraced(function* (
  input: BrowserLaunchInput & { readonly profileDirectory: string },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const proxyPort = yield* publicProxy.pipe(
    Effect.mapError(
      (cause) => new HtmlRenderBrowserError({ reason: "the preview proxy could not start", cause }),
    ),
  );
  const outgoing = yield* Queue.unbounded<Uint8Array>();
  const child = yield* spawner
    .spawn(
      ChildProcess.make(
        input.executable,
        browserArguments({
          noSandbox: input.noSandbox,
          proxyPort,
          profileDirectory: input.profileDirectory,
        }),
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
          forceKillAfter: "2 seconds",
          additionalFds: {
            fd3: { type: "input", stream: Stream.fromQueue(outgoing) },
            fd4: { type: "output" },
          },
        },
      ),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new HtmlRenderBrowserError({ reason: "the browser could not be started", cause }),
      ),
    );

  let stderrTail = "";
  const stderrReader = yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((text) =>
      Effect.sync(() => {
        stderrTail = (stderrTail + text).slice(-4_096);
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );

  const pending = new Map<
    number,
    { readonly method: string; readonly reply: Deferred.Deferred<unknown, BrowserFailure> }
  >();
  const pages = new Map<string, PageEvents>();
  let disconnected: BrowserFailure | undefined;
  let nextId = 0;

  // A command whose reply nobody awaits; `receive` drops replies without a waiter.
  const post = (method: string, params: Record<string, unknown>, sessionId?: string) =>
    Queue.offer(
      outgoing,
      textEncoder.encode(
        `${encodeCdpCommand({ id: ++nextId, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
      ),
    ).pipe(Effect.asVoid);

  // Chrome ends every message for a page with that page's session.
  const pageOf = (tail: string) => {
    const sessionId = /"sessionId":"([^"]+)"\}$/.exec(tail)?.[1];
    const page = sessionId === undefined ? undefined : pages.get(sessionId);
    return page && sessionId !== undefined ? { page, sessionId } : undefined;
  };

  // Serves the page. Its body is shared bytes between two small JSON halves,
  // queued together, so loading a page of up to 25 MiB at several widths never
  // copies it on this side.
  const fulfillPage = (sessionId: string, requestId: string, body: Uint8Array) =>
    Queue.offerAll(outgoing, [
      textEncoder.encode(
        `{"id":${++nextId},"sessionId":${JSON.stringify(sessionId)},"method":"Fetch.fulfillRequest","params":{"requestId":${JSON.stringify(requestId)},"responseCode":200,"responseHeaders":[{"name":"Content-Type","value":"text/html; charset=utf-8"},{"name":"Cache-Control","value":"no-store"}],"body":"`,
      ),
      body,
      textEncoder.encode('"}}\0'),
    ]).pipe(Effect.asVoid);

  /** A message past its limit, known only by its start and end. */
  const receiveOversized = (head: string, tail: string) => {
    const id = /^\{"id":(\d+)/.exec(head)?.[1];
    if (id !== undefined) {
      const waiter = pending.get(Number(id));
      pending.delete(Number(id));
      return waiter
        ? Deferred.fail(
            waiter.reply,
            new HtmlRenderBrowserError({ reason: `${waiter.method} replied with too much data` }),
          )
        : Effect.void;
    }
    const target = pageOf(tail);
    if (!target) return Effect.void;
    if (consoleEventReported(head)) {
      target.page.omittedConsoleMessages += 1;
      return Effect.void;
    }
    // A request is paused until answered, and a sync XHR waits on it.
    const requestId = /^\{"method":"Fetch\.requestPaused","params":\{"requestId":"([^"]+)"/.exec(
      head,
    )?.[1];
    return requestId === undefined
      ? Effect.void
      : post("Fetch.failRequest", { requestId, errorReason: "Aborted" }, target.sessionId);
  };

  const receive = (raw: string) => {
    // Console output past the cap is only counted, never parsed.
    const reported = consoleEventReported(raw.slice(0, 128));
    if (reported !== undefined) {
      const page = pageOf(raw.slice(-128))?.page;
      if (page && page.consoleMessages.length >= MAX_CONSOLE_MESSAGES) {
        if (reported) page.omittedConsoleMessages += 1;
        return Effect.void;
      }
    }
    const message = Option.getOrUndefined(decodeCdpMessage(raw));
    if (message?.id !== undefined) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (!waiter) return Effect.void;
      return message.error
        ? Deferred.fail(
            waiter.reply,
            new HtmlRenderBrowserError({
              reason: `${waiter.method} failed`,
              cause: message.error.message,
            }),
          )
        : Deferred.succeed(waiter.reply, message.result);
    }
    const sessionId = message?.sessionId;
    const page = sessionId === undefined ? undefined : pages.get(sessionId);
    if (sessionId === undefined || !page || !message?.method) return Effect.void;
    switch (message.method) {
      case "Page.loadEventFired":
        return page.loaded ? Deferred.succeed(page.loaded, undefined) : Effect.void;
      // A load the page stops itself, such as with window.stop(), ends without
      // a load event. Only a stop after the page committed counts; the target's
      // first about:blank stops loading too.
      case "Page.frameStoppedLoading":
        return page.loaded &&
          page.committed &&
          Option.getOrUndefined(decodeFrameEvent(message.params))?.frameId === page.mainFrameId
          ? Deferred.succeed(page.loaded, undefined)
          : Effect.void;
      case "Page.frameNavigated": {
        const frame = Option.getOrUndefined(decodeFrameNavigated(message.params))?.frame;
        if (!frame || frame.id !== page.mainFrameId) return Effect.void;
        if (frame.url.split("#", 1)[0] === PAGE_URL) {
          page.committed = true;
          return Effect.void;
        }
        // A history traversal, which no page script can be stopped from making.
        page.leftFor ??= frame.url;
        return page.loaded ? Deferred.fail(page.loaded, leftPage(page.leftFor)) : Effect.void;
      }
      case "Runtime.bindingCalled": {
        const call = Option.getOrUndefined(decodeBindingCalled(message.params));
        if (call?.name === NAVIGATION_BINDING) recordNavigation(page, call.payload);
        return Effect.void;
      }
      // alert(), confirm(), prompt(), and beforeunload would otherwise stall the page until timeout.
      case "Page.javascriptDialogOpening":
        return post("Page.handleJavaScriptDialog", { accept: false }, sessionId);
      case "Fetch.requestPaused": {
        const paused = Option.getOrUndefined(decodeRequestPaused(message.params));
        if (!paused) return Effect.void;
        const action = pausedRequestAction({
          url: paused.request.url,
          frameId: paused.frameId,
          resourceType: paused.resourceType,
          mainFrameId: page.mainFrameId,
          hasPage: page.body !== undefined,
        });
        if (action === "fulfill" && page.body !== undefined) {
          return fulfillPage(sessionId, paused.requestId, page.body);
        }
        if (action === "abort") recordNavigation(page, paused.request.url);
        if (action === "continue") recordPlainHttpLoad(page, paused.request.url);
        return action === "continue"
          ? post("Fetch.continueRequest", { requestId: paused.requestId }, sessionId)
          : post(
              "Fetch.failRequest",
              {
                requestId: paused.requestId,
                errorReason: action === "abort" ? "Aborted" : "AccessDenied",
              },
              sessionId,
            );
      }
    }
    const consoleMessage = consoleMessageFromEvent(message.method, message.params);
    if (consoleMessage) pushConsoleMessage(page, consoleMessage);
    return Effect.void;
  };

  // The pipe closes when the browser exits. A startup abort, such as a missing
  // sandbox or shared library, says why on stderr, which may still be
  // draining, so give it a moment.
  const disconnect = Effect.gen(function* () {
    yield* Fiber.await(stderrReader).pipe(Effect.timeout("1 second"), Effect.ignore);
    const error = new HtmlRenderBrowserError({
      reason: "the browser exited unexpectedly",
      output: stderrTail,
    });
    disconnected = error;
    const waiters = [...pending.values()];
    pending.clear();
    yield* Effect.forEach(waiters, ({ reply }) => Deferred.fail(reply, error), { discard: true });
    yield* Effect.forEach(
      pages.values(),
      (page) => (page.loaded ? Deferred.fail(page.loaded, error) : Effect.void),
      { discard: true },
    );
  });

  // Decoded text chunks may split a message anywhere, and a screenshot reply spans many.
  const frames = makeCdpFrameReader({
    maxReplyChars: MAX_CDP_REPLY_CHARS,
    maxEventChars: MAX_CDP_EVENT_CHARS,
  });
  yield* child.getOutputFd(4).pipe(
    Stream.decodeText(),
    Stream.runForEach((text) =>
      Effect.forEach(
        frames.push(text),
        (frame) =>
          frame._tag === "Message" ? receive(frame.text) : receiveOversized(frame.head, frame.tail),
        { discard: true },
      ),
    ),
    Effect.ignore,
    // Interruption means the scope is closing on purpose; only an exit disconnects.
    Effect.andThen(disconnect),
    Effect.forkScoped,
  );

  const send = <A>(
    method: string,
    params: Record<string, unknown>,
    result: Schema.Decoder<A>,
    sessionId?: string,
  ) =>
    Effect.gen(function* () {
      if (disconnected) return yield* disconnected;
      const id = ++nextId;
      const reply = yield* Deferred.make<unknown, BrowserFailure>();
      pending.set(id, { method, reply });
      const message = encodeCdpCommand({ id, method, params, ...(sessionId ? { sessionId } : {}) });
      yield* Queue.offer(outgoing, textEncoder.encode(`${message}\0`));
      return yield* Deferred.await(reply).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(result)),
        Effect.mapError((error) =>
          error._tag === "HtmlRenderBrowserError"
            ? error
            : new HtmlRenderBrowserError({
                reason: `${method} returned an unexpected result`,
                cause: error,
              }),
        ),
      );
    });

  // Pages never download anything to this machine.
  yield* send("Browser.setDownloadBehavior", { behavior: "deny" }, Ignored);

  /**
   * A fresh page at `width`; each `load` navigates it and measures the settled
   * layout. Only a page that reports its console listens to it: a page can
   * log faster than this side reads.
   */
  const openPage = Effect.fnUntraced(function* (
    width: number,
    colorScheme: ThemeAppearance,
    options: { readonly reportConsole: boolean },
  ) {
    const { targetId } = yield* send(
      "Target.createTarget",
      { url: "about:blank" },
      Schema.Struct({ targetId: Schema.String }),
    );
    const { sessionId } = yield* send(
      "Target.attachToTarget",
      { targetId, flatten: true },
      Schema.Struct({ sessionId: Schema.String }),
    );
    const events: PageEvents = {
      // A page target's id is its main frame's id.
      mainFrameId: targetId,
      body: undefined,
      loaded: undefined,
      committed: false,
      leftFor: undefined,
      consoleMessages: [],
      omittedConsoleMessages: 0,
      navigations: new Set(),
      plainHttpOrigins: new Set(),
    };
    pages.set(sessionId, events);
    yield* send("Page.enable", {}, Ignored, sessionId);
    if (options.reportConsole) {
      yield* send("Runtime.enable", {}, Ignored, sessionId);
      yield* send("Log.enable", {}, Ignored, sessionId);
      yield* send("Runtime.addBinding", { name: NAVIGATION_BINDING }, Ignored, sessionId);
    }
    yield* send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: PAGE_SETUP_SCRIPT, runImmediately: true },
      Ignored,
      sessionId,
    );
    // Pauses Ryco's own origin, to serve the page, every document, to keep
    // the main frame on it, and plain-http loads, which readers on HTTPS
    // clients block, to warn about them.
    yield* send(
      "Fetch.enable",
      {
        patterns: [
          { urlPattern: `${PAGE_ORIGIN}/*` },
          { urlPattern: "*", resourceType: "Document" },
          ...(options.reportConsole ? [{ urlPattern: "http://*" }] : []),
        ],
      },
      Ignored,
      sessionId,
    );
    yield* send(
      "Emulation.setDeviceMetricsOverride",
      { width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false },
      Ignored,
      sessionId,
    );
    // A client frame's preferred color scheme follows the theme it wears.
    yield* send(
      "Emulation.setEmulatedMedia",
      { features: [{ name: "prefers-color-scheme", value: colorScheme }] },
      Ignored,
      sessionId,
    );

    // Whatever the main frame shows once it has left the page is not the page.
    const onPage = Effect.suspend(() =>
      events.leftFor === undefined ? Effect.void : Effect.fail(leftPage(events.leftFor)),
    );

    /** Loads a page from `pageBody`, so callers loading it often encode it once. */
    const load = Effect.fnUntraced(function* (body: Uint8Array, urlFragment: string) {
      const loaded = yield* Deferred.make<void, BrowserFailure>();
      events.body = body;
      events.loaded = loaded;
      events.committed = false;
      const navigation = yield* send(
        "Page.navigate",
        { url: `${PAGE_URL}${urlFragment}` },
        Navigation,
        sessionId,
      );
      if (navigation.errorText) {
        return yield* new HtmlRenderBrowserError({
          reason: `the page could not be opened (${navigation.errorText})`,
        });
      }
      yield* Deferred.await(loaded);
      yield* send(
        "Runtime.evaluate",
        { expression: SETTLE_EXPRESSION, awaitPromise: true },
        Ignored,
        sessionId,
      );
      const measured = yield* send(
        "Runtime.evaluate",
        { expression: MEASURE_EXPRESSION, returnByValue: true },
        Measured,
        sessionId,
      );
      yield* onPage;
      return Math.max(0, Math.ceil(measured.result.value));
    });

    const screenshot = (height: number) =>
      send(
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width, height, scale: 1 },
        },
        Schema.Struct({ data: Schema.String }),
        sessionId,
      ).pipe(Effect.flatMap(({ data }) => Effect.as(onPage, data)));

    const consoleMessages = (): ReadonlyArray<HtmlRenderConsoleMessage> => [
      ...(events.navigations.size === 0 ? [] : [navigationWarning(events.navigations)]),
      ...events.consoleMessages,
      ...(events.omittedConsoleMessages === 0
        ? []
        : [
            {
              level: "warning" as const,
              text: `${events.omittedConsoleMessages} more console messages were omitted.`,
            },
          ]),
    ];

    // Frees the page in the browser once it is no longer needed. Nothing waits
    // for the reply, which may queue behind whatever the page sent before it;
    // closing the browser frees every page anyway.
    const close = post("Target.closeTarget", { targetId }).pipe(
      Effect.ensuring(Effect.sync(() => pages.delete(sessionId))),
    );

    return { load, screenshot, consoleMessages, close };
  });

  return { openPage };
});

type BrowserPage = Effect.Success<
  ReturnType<Effect.Success<ReturnType<typeof launchBrowser>>["openPage"]>
>;

/** A temporary directory for the browser profile, removed with the scope. */
const scratchDirectory = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Effect.acquireRelease(
    fileSystem.makeTempDirectory({ prefix: "ryco-html-preview-" }),
    (directory) => fileSystem.remove(directory, { recursive: true }).pipe(Effect.ignore),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new HtmlRenderBrowserError({ reason: "a temporary directory could not be created", cause }),
    ),
  );
});

const startBrowser = Effect.fnUntraced(function* (input: BrowserLaunchInput) {
  const path = yield* Path.Path;
  const directory = yield* scratchDirectory;
  return yield* launchBrowser({ ...input, profileDirectory: path.join(directory, "profile") });
});

export interface HtmlScreenshot {
  readonly png: string;
  readonly contentHeight: number;
  readonly capturedHeight: number;
  readonly consoleMessages: ReadonlyArray<HtmlRenderConsoleMessage>;
}

/** Loads `html` at `width` and returns a PNG of the top of the page. */
export const captureHtmlScreenshot = Effect.fn("headlessChrome.captureHtmlScreenshot")(
  function* (
    input: BrowserLaunchInput & {
      readonly html: string;
      readonly width: number;
      readonly urlFragment: string;
      readonly colorScheme: ThemeAppearance;
    },
  ) {
    const browser = yield* startBrowser(input);
    const page = yield* browser.openPage(input.width, input.colorScheme, { reportConsole: true });
    const contentHeight = yield* page.load(pageBody(input.html), input.urlFragment);
    const capturedHeight = Math.max(1, Math.min(contentHeight, MAX_CAPTURE_HEIGHT));
    const png = yield* page.screenshot(capturedHeight);
    return {
      png,
      contentHeight,
      capturedHeight,
      consoleMessages: page.consoleMessages(),
    } satisfies HtmlScreenshot;
  },
  Effect.scoped,
  Effect.timeoutOrElse({
    duration: CAPTURE_TIMEOUT,
    orElse: () =>
      Effect.fail(
        new HtmlRenderBrowserError({
          reason: `the page did not finish loading within ${CAPTURE_TIMEOUT}`,
        }),
      ),
  }),
);

/** A theme a page loads in: its URL fragment and the preferred color scheme. */
export interface HtmlPageTheme {
  readonly urlFragment: string;
  readonly colorScheme: ThemeAppearance;
}

/** Screenshots of the top of a page that a measurement takes along the way. */
export interface HtmlPageScreenshots {
  /** The width to screenshot at, one of the measured widths: its measuring load is reused. */
  readonly width: number;
  /**
   * How much of the page's top each screenshot shows, in CSS pixels. Always
   * this much, so every screenshot has the same shape: below a shorter page
   * it shows the page's own background.
   */
  readonly height: number;
  /** Another theme to screenshot, from a load of its own beside the measuring ones. */
  readonly alsoIn?: HtmlPageTheme;
  /** Gets each screenshot, a base64 PNG, as it is taken. */
  readonly onScreenshot: (colorScheme: ThemeAppearance, png: string) => Effect.Effect<void>;
}

/**
 * Content heights of the page at each width, each from a fresh load, since
 * pages often lay themselves out from the width once at load. One browser,
 * a few widths at a time. `onHeights` gets them as soon as every width is
 * measured: no screenshot holds them up. The measuring load at the
 * screenshot width stays open for its own theme's screenshot, and the other
 * theme's load runs beside the measuring ones. A screenshot that fails is
 * only missing; one that never comes (a page that keeps its main thread busy
 * after load) keeps the measurement running until the caller stops it.
 */
export const measureHtmlPage = Effect.fn("headlessChrome.measureHtmlPage")(function* (
  input: BrowserLaunchInput & {
    readonly html: string;
    readonly widths: ReadonlyArray<number>;
    readonly theme: HtmlPageTheme;
    readonly screenshots?: HtmlPageScreenshots;
    readonly onHeights: (heights: ReadonlyArray<readonly [number, number]>) => Effect.Effect<void>;
  },
) {
  const browser = yield* startBrowser(input);
  const body = pageBody(input.html);
  const shots = input.screenshots;

  /** A fresh page at `width` in `theme`, loaded and measured; closed if that fails. */
  const loadPage = (width: number, theme: HtmlPageTheme) =>
    browser.openPage(width, theme.colorScheme, { reportConsole: false }).pipe(
      Effect.flatMap((page) =>
        page.load(body, theme.urlFragment).pipe(
          Effect.map((contentHeight) => ({ page, contentHeight })),
          Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : page.close)),
        ),
      ),
    );

  /** Screenshots a loaded page's top, then closes it. */
  const screenshot = (
    page: BrowserPage,
    colorScheme: ThemeAppearance,
    screenshots: HtmlPageScreenshots,
  ) =>
    page.screenshot(screenshots.height).pipe(
      Effect.flatMap((png) => screenshots.onScreenshot(colorScheme, png)),
      Effect.catch((cause) =>
        Effect.logDebug("Could not screenshot an HTML render.", { cause: cause.reason }),
      ),
      Effect.ensuring(page.close),
    );

  // The measuring load at the screenshot width, kept open for its screenshot.
  const kept = yield* Deferred.make<BrowserPage | undefined>();
  const heights = Effect.forEach(
    input.widths,
    (width) =>
      loadPage(width, input.theme).pipe(
        Effect.tap(({ page }) =>
          shots !== undefined && width === shots.width ? Deferred.succeed(kept, page) : page.close,
        ),
        Effect.map(({ contentHeight }) => [width, contentHeight] as const),
      ),
    { concurrency: MEASURE_CONCURRENCY },
  ).pipe(
    Effect.flatMap(input.onHeights),
    // Without that load there is nothing to screenshot.
    Effect.onExit(() => Deferred.succeed(kept, undefined)),
  );

  const ownTheme =
    shots === undefined
      ? Effect.void
      : Deferred.await(kept).pipe(
          Effect.flatMap((page) =>
            page === undefined ? Effect.void : screenshot(page, input.theme.colorScheme, shots),
          ),
        );

  const alsoIn = shots?.alsoIn;
  const otherTheme =
    shots === undefined || alsoIn === undefined
      ? Effect.void
      : loadPage(shots.width, alsoIn).pipe(
          Effect.flatMap(({ page }) => screenshot(page, alsoIn.colorScheme, shots)),
          Effect.catch((cause) =>
            Effect.logDebug("Could not load an HTML render for its screenshot.", {
              cause: cause.reason,
            }),
          ),
        );

  // The other theme's load runs beside the measuring ones rather than after
  // them, so it adds a page to the browser instead of a round of loads.
  yield* Effect.all([heights, ownTheme, otherTheme], { concurrency: "unbounded", discard: true });
}, Effect.scoped);
