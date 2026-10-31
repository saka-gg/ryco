import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { NodeBrowserInputEvent } from "@ryco/contracts/node-browser";
import {
  decodeNodeBrowserFrame,
  NODE_BROWSER_FRAME_ACK,
  NODE_BROWSER_FRAME_CLOSE,
} from "@ryco/shared/nodeBrowserFrame";
import { Deferred, Effect, Exit, Layer, Queue, Schedule, Schema, Stream } from "effect";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../config.ts";
import { PreviewBrowser } from "../htmlRender/PreviewBrowser.ts";
import {
  coalesceInput,
  editingCommand,
  makeNodeBrowserRuntime,
  type NodeBrowserCdp,
  NodeBrowserCdpError,
  type NodeBrowserLaunchInput,
  normalizeNodeBrowserUrl,
} from "./nodeBrowserRuntime.ts";

interface Command {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: string | undefined;
}

/**
 * A scripted Chrome: records every command and answers the ones the runtime
 * awaits, except those in `hang` (never answered, like a page whose main thread
 * is busy) and `fail` (answered with an error). `failSession` fails a
 * session's unanswered commands, as the pipe does.
 */
const makeFakeChrome = () => {
  const commands: Array<Command> = [];
  const hang = new Set<string>();
  const fail = new Set<string>();
  const waiting: Array<{
    readonly sessionId: string | undefined;
    readonly reply: Deferred.Deferred<unknown, NodeBrowserCdpError>;
  }> = [];
  let hooks: NodeBrowserLaunchInput | undefined;
  let launches = 0;
  let stopped = 0;
  let targets = 0;
  let sessions = 0;
  const reply = (method: string): unknown => {
    switch (method) {
      case "Browser.getVersion":
        return { userAgent: "Mozilla/5.0 (Macintosh) HeadlessChrome/154.0.8037.92 Safari/537.36" };
      case "Target.createTarget":
        return { targetId: `T${++targets}` };
      case "Target.attachToTarget":
        return { sessionId: `S${++sessions}` };
      case "Page.getLayoutMetrics":
        return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800 } };
      case "Page.captureScreenshot":
        return { data: Buffer.from("still").toString("base64") };
      case "Page.getNavigationHistory":
        return { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }, { id: 3 }] };
      default:
        return {};
    }
  };
  const launch = (input: NodeBrowserLaunchInput) =>
    Effect.gen(function* () {
      hooks = input;
      launches += 1;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          stopped += 1;
        }),
      );
      const record = (method: string, params: Record<string, unknown>, sessionId?: string) =>
        Effect.sync(() => {
          commands.push({ method, params, sessionId });
        });
      return {
        send: <A>(
          method: string,
          params: Record<string, unknown>,
          result: Schema.Decoder<A>,
          sessionId?: string,
        ) =>
          record(method, params, sessionId).pipe(
            Effect.andThen(
              hang.has(method)
                ? Effect.flatMap(Deferred.make<unknown, NodeBrowserCdpError>(), (pending) => {
                    waiting.push({ sessionId, reply: pending });
                    return Deferred.await(pending);
                  })
                : fail.has(method)
                  ? Effect.fail(new NodeBrowserCdpError({ reason: `${method} failed` }))
                  : Effect.succeed(reply(method)),
            ),
            Effect.flatMap((value) =>
              Schema.decodeUnknownEffect(result)(value).pipe(
                Effect.mapError((cause) => new NodeBrowserCdpError({ reason: "bad reply", cause })),
              ),
            ),
          ),
        post: record,
        postParts: () => Effect.void,
        failSession: (sessionId: string) =>
          Effect.forEach(
            waiting.filter((entry) => entry.sessionId === sessionId),
            (entry) => Deferred.fail(entry.reply, new NodeBrowserCdpError({ reason: "ended" })),
            { discard: true },
          ),
        exited: Effect.never,
      } satisfies NodeBrowserCdp;
    });
  return {
    launch,
    commands,
    hang,
    fail,
    launches: () => launches,
    stopped: () => stopped,
    hooks: () => hooks!,
    sent: (method: string, sessionId?: string) =>
      commands.filter(
        (command) =>
          command.method === method && (sessionId === undefined || command.sessionId === sessionId),
      ),
    clear: () => {
      commands.length = 0;
    },
  };
};

const fakePreviewBrowser = Layer.succeed(
  PreviewBrowser,
  PreviewBrowser.of({
    executable: Effect.succeed("/fake/chrome-headless-shell"),
    installed: Effect.succeedSome("/fake/chrome-headless-shell"),
  }),
);

const TestLayer = Layer.mergeAll(
  fakePreviewBrowser,
  ServerConfig.layerTest(process.cwd(), { prefix: "ryco-node-browser-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const makeRuntime = Effect.gen(function* () {
  const chrome = makeFakeChrome();
  const runtime = yield* makeNodeBrowserRuntime({
    baseCapability: { available: true },
    noSandbox: false,
    launch: chrome.launch,
  });
  return { chrome, runtime };
});

// Lets forked work (acknowledgements, settle timers, screencast restarts) run.
const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, {
  discard: true,
});

/** A frame socket driven by the test. */
const makeViewer = Effect.gen(function* () {
  const incoming = yield* Queue.unbounded<string>();
  const left = yield* Deferred.make<void>();
  const written: Array<Uint8Array | Socket.CloseEvent> = [];
  return {
    socket: {
      write: (chunk: Uint8Array | Socket.CloseEvent) =>
        Effect.sync(() => {
          written.push(chunk);
        }),
      // Fails once the viewer leaves, as a closed socket's reader does.
      pull: Effect.raceFirst(
        Effect.map(Queue.take(incoming), (message) => [message]),
        Effect.andThen(
          Deferred.await(left),
          Effect.fail(
            new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1001 }) }),
          ),
        ),
      ),
      bufferedBytes: () => 0,
      cut: Effect.void,
    },
    ack: Queue.offer(incoming, NODE_BROWSER_FRAME_ACK),
    leave: Deferred.succeed(left, undefined),
    written,
    closes: () =>
      written.flatMap((chunk) => (chunk instanceof Socket.CloseEvent ? [chunk.code] : [])),
    frames: () =>
      written.flatMap((chunk) => {
        if (chunk instanceof Socket.CloseEvent) return [];
        const decoded = decodeNodeBrowserFrame(chunk);
        return decoded.ok ? [decoded.frame] : [];
      }),
  };
});

const frameParams = (tabId: string) =>
  new URLSearchParams({ tab: tabId, maxWidth: "1600", maxHeight: "1000", quality: "70" });

const screencastFrame = (sessionId: string, ack: number) => ({
  method: "Page.screencastFrame",
  sessionId,
  params: {
    data: Buffer.from(`frame ${ack}`).toString("base64"),
    sessionId: ack,
    metadata: { deviceWidth: 1280, deviceHeight: 800 },
  },
});

const openTab = (runtime: Effect.Success<typeof makeRuntime>["runtime"], url = "localhost:3000") =>
  runtime
    .command({ type: "open", scope: "/work/app", url })
    .pipe(Effect.map((result) => result.tab!));

describe("node browser addresses", () => {
  it("opens http(s) and about:blank only, without credentials", () => {
    expect(normalizeNodeBrowserUrl("localhost:3000")).toBe("http://localhost:3000/");
    expect(normalizeNodeBrowserUrl(" https://example.com/a ")).toBe("https://example.com/a");
    expect(normalizeNodeBrowserUrl("about:blank")).toBe("about:blank");
    for (const refused of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "view-source:http://localhost:3000",
      "data:text/html,<p>hi</p>",
      "https://user:secret@example.com",
      "ftp://example.com",
    ]) {
      expect(normalizeNodeBrowserUrl(refused), refused).toBeNull();
    }
  });
});

describe("node browser input mapping", () => {
  it("adds the editing commands headless Chromium needs", () => {
    expect(editingCommand("a", 4)).toEqual({ commands: ["selectAll"] });
    expect(editingCommand("z", 4 | 8)).toEqual({ commands: ["redo"] });
    expect(editingCommand("c", 2)).toEqual({ commands: ["copy"] });
    // Ctrl+A is a plain key on Linux; Alt combinations are never commands.
    expect(editingCommand("a", 2)).toBeNull();
    expect(editingCommand("c", 1 | 2)).toBeNull();
  });

  it("keeps only the last of consecutive hovers", () => {
    const mouse = (action: "move" | "down", x: number): NodeBrowserInputEvent => ({
      type: "mouse",
      action,
      x,
      y: 0,
      button: action === "down" ? "left" : "none",
      buttons: action === "down" ? 1 : 0,
      clickCount: 0,
      modifiers: 0,
    });
    const move = (x: number) => mouse("move", x);
    const down = mouse("down", 3);
    expect(coalesceInput([move(1), move(2), down, move(4)])).toEqual([move(2), down, move(4)]);
  });
});

describe("node browser runtime", () => {
  it.effect("opens a tab in a fresh page with downloads denied and file pickers held back", () =>
    Effect.gen(function* () {
      const { chrome, runtime } = yield* makeRuntime;
      const tab = yield* openTab(runtime);
      expect(tab).toMatchObject({ scope: "/work/app", state: "live" });
      expect(chrome.sent("Browser.setDownloadBehavior")[0]?.params).toEqual({ behavior: "deny" });
      expect(chrome.sent("Page.setInterceptFileChooserDialog", "S1")[0]?.params).toEqual({
        enabled: true,
      });
      expect(chrome.sent("Network.setBypassServiceWorker", "S1")[0]?.params).toEqual({
        bypass: true,
      });
      const identity = chrome.sent("Emulation.setUserAgentOverride", "S1")[0]?.params;
      expect(identity?.userAgent).toBe("Mozilla/5.0 (Macintosh) Chrome/154.0.0.0 Safari/537.36");
      yield* settle;
      expect(chrome.sent("Page.navigate", "S1")[0]?.params).toEqual({
        url: "http://localhost:3000/",
      });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("refuses addresses outside http(s) without starting the browser", () =>
    Effect.gen(function* () {
      const { chrome, runtime } = yield* makeRuntime;
      for (const url of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings"]) {
        const error = yield* Effect.flip(openTab(runtime, url));
        expect(error.code).toBe("invalid-url");
      }
      expect(chrome.launches()).toBe(0);
      const tab = yield* openTab(runtime);
      const navigate = yield* Effect.flip(
        runtime.command({ type: "navigate", tabId: tab.id, url: "file:///etc/passwd" }),
      );
      expect(navigate.code).toBe("invalid-url");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("sends a page that reached another scheme back to about:blank", () =>
    Effect.gen(function* () {
      const { chrome, runtime } = yield* makeRuntime;
      const tab = yield* openTab(runtime);
      chrome.clear();
      yield* chrome.hooks().onEvent({
        method: "Page.frameNavigated",
        sessionId: "S1",
        params: { frame: { id: "T1", url: "file:///etc/passwd" } },
      });
      expect(chrome.sent("Page.navigate", "S1")[0]?.params).toEqual({ url: "about:blank" });
      const listed = yield* runtime.read({ type: "list" });
      expect(listed.type === "list" && listed.tabs[0]).toMatchObject({
        id: tab.id,
        url: "http://localhost:3000/",
        error: { code: "blocked-url" },
      });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("refuses the thirteenth tab", () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeRuntime;
      for (let index = 0; index < 12; index += 1) yield* openTab(runtime);
      const error = yield* Effect.flip(openTab(runtime));
      expect(error.code).toBe("limit-reached");
      const listed = yield* runtime.read({ type: "list" });
      // Past six, the least recently used tabs nobody watches are suspended.
      expect(
        listed.type === "list" && listed.tabs.filter((tab) => tab.state === "live"),
      ).toHaveLength(6);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "suspends an unwatched tab after 10 minutes and stops the browser 2 minutes later",
    () =>
      Effect.gen(function* () {
        const { chrome, runtime } = yield* makeRuntime;
        const tab = yield* openTab(runtime);
        yield* TestClock.adjust("9 minutes");
        expect(chrome.sent("Target.closeTarget")).toEqual([]);
        yield* TestClock.adjust("90 seconds");
        expect(chrome.sent("Target.closeTarget")[0]?.params).toEqual({ targetId: "T1" });
        const listed = yield* runtime.read({ type: "list" });
        expect(listed.type === "list" && listed.tabs[0]).toMatchObject({
          id: tab.id,
          state: "suspended",
          url: "http://localhost:3000/",
        });
        expect(chrome.stopped()).toBe(0);
        yield* TestClock.adjust("2 minutes");
        yield* TestClock.adjust("30 seconds");
        expect(chrome.stopped()).toBe(1);
        // Waking it starts a browser again, at its address.
        yield* runtime.command({ type: "wake", tabId: tab.id });
        expect(chrome.launches()).toBe(2);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("streams frames to a viewer and slows the screencast while it scrolls", () =>
    Effect.gen(function* () {
      const { chrome, runtime } = yield* makeRuntime;
      const tab = yield* openTab(runtime);
      const viewer = yield* makeViewer;
      yield* Effect.forkScoped(runtime.serveViewer(viewer.socket, frameParams(tab.id)));
      yield* settle;
      // The viewer's own session; an idle page never repaints, so it starts from a still.
      expect(chrome.sent("Page.startScreencast", "S2").map((command) => command.params)).toEqual([
        { format: "jpeg", quality: 70, maxWidth: 1600, maxHeight: 1000 },
      ]);
      expect(viewer.frames()).toMatchObject([{ seq: 0, cssWidth: 1280, cssHeight: 800 }]);
      yield* viewer.ack;

      yield* runtime.input({
        tabId: tab.id,
        events: [{ type: "wheel", x: 10, y: 10, deltaX: 0, deltaY: 120, modifiers: 0 }],
      });
      for (let ack = 1; ack <= 4; ack += 1) {
        yield* chrome.hooks().onEvent(screencastFrame("S2", ack));
        yield* TestClock.adjust("50 millis");
        yield* viewer.ack;
        yield* settle;
      }
      // Four frames within 300 ms of a wheel: half size at quality 50.
      expect(chrome.sent("Page.startScreencast", "S2").map((command) => command.params)).toEqual([
        { format: "jpeg", quality: 70, maxWidth: 1600, maxHeight: 1000 },
        { format: "jpeg", quality: 50, maxWidth: 800, maxHeight: 500 },
      ]);
      // Each acknowledgement reaches Chromium 100 ms after its frame arrived: not yet the last.
      expect(chrome.sent("Page.screencastFrameAck", "S2").map((command) => command.params)).toEqual(
        [{ sessionId: 1 }, { sessionId: 2 }, { sessionId: 3 }],
      );
      const stills = chrome.sent("Page.captureScreenshot", "S2").length;
      yield* TestClock.adjust("200 millis");
      yield* settle;
      // Settled: full size again, and a sharp still.
      expect(chrome.sent("Page.startScreencast", "S2").at(-1)?.params).toEqual({
        format: "jpeg",
        quality: 70,
        maxWidth: 1600,
        maxHeight: 1000,
      });
      expect(chrome.sent("Page.captureScreenshot", "S2")).toHaveLength(stills + 1);
      expect(chrome.sent("Page.screencastFrameAck", "S2")).toHaveLength(4);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("acknowledges a frame too large to read", () =>
    Effect.gen(function* () {
      const { chrome, runtime } = yield* makeRuntime;
      yield* openTab(runtime);
      yield* chrome
        .hooks()
        .onOversizedEvent(
          '{"method":"Page.screencastFrame","params":{"data":"/9j/4AAQ',
          'AAAA","metadata":{"deviceWidth":1280,"deviceHeight":800},"sessionId":7},"sessionId":"S9"}',
        );
      expect(chrome.sent("Page.screencastFrameAck", "S9").map((command) => command.params)).toEqual(
        [{ sessionId: 7 }],
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("tells viewers of an unknown tab it is gone", () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeRuntime;
      const viewer = yield* makeViewer;
      yield* runtime.serveViewer(viewer.socket, frameParams("no-such-tab"));
      expect(viewer.closes()).toEqual([NODE_BROWSER_FRAME_CLOSE.tabGone]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("suspends every tab and reconnects viewers when the browser exits", () =>
    Effect.gen(function* () {
      const { chrome, runtime } = yield* makeRuntime;
      const tab = yield* openTab(runtime);
      const viewer = yield* makeViewer;
      const served = yield* Deferred.make<void>();
      yield* Effect.forkScoped(
        runtime
          .serveViewer(viewer.socket, frameParams(tab.id))
          .pipe(Effect.ensuring(Deferred.succeed(served, undefined))),
      );
      yield* settle;
      yield* chrome.hooks().onExit(new NodeBrowserCdpError({ reason: "exited", output: "" }));
      yield* Deferred.await(served);
      expect(viewer.closes()).toEqual([NODE_BROWSER_FRAME_CLOSE.restarted]);
      const listed = yield* runtime.read({ type: "list" });
      expect(listed.type === "list" && listed.tabs[0]?.state).toBe("suspended");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("pauses the browser after three exits within a minute", () =>
    Effect.gen(function* () {
      const { chrome, runtime } = yield* makeRuntime;
      const tab = yield* openTab(runtime);
      for (let exit = 0; exit < 3; exit += 1) {
        yield* runtime.command({ type: "wake", tabId: tab.id });
        yield* chrome.hooks().onExit(new NodeBrowserCdpError({ reason: "exited", output: "" }));
      }
      expect(yield* runtime.capability).toEqual({ available: false, reason: "crashed" });
      const error = yield* Effect.flip(runtime.command({ type: "wake", tabId: tab.id }));
      expect(error.code).toBe("unavailable");
      yield* TestClock.adjust("5 minutes");
      yield* TestClock.adjust("30 seconds");
      expect(yield* runtime.capability).toEqual({ available: true });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("marks a crashed page and brings it back on wake", () =>
    Effect.gen(function* () {
      const { chrome, runtime } = yield* makeRuntime;
      const tab = yield* openTab(runtime);
      const viewer = yield* makeViewer;
      yield* Effect.forkScoped(runtime.serveViewer(viewer.socket, frameParams(tab.id)));
      yield* settle;
      yield* chrome
        .hooks()
        .onEvent({ method: "Inspector.targetCrashed", sessionId: "S1", params: {} });
      yield* settle;
      expect(viewer.closes()).toEqual([NODE_BROWSER_FRAME_CLOSE.tabGone]);
      const crashed = yield* runtime.read({ type: "list" });
      expect(crashed.type === "list" && crashed.tabs[0]).toMatchObject({
        state: "crashed",
        error: { code: "crashed" },
      });
      const woken = yield* runtime.command({ type: "wake", tabId: tab.id });
      expect(woken.tab).toMatchObject({ state: "live", error: null });
      expect(chrome.sent("Target.createTarget")).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("maps input to the page, clamped to its viewport", () =>
    Effect.gen(function* () {
      const { chrome, runtime } = yield* makeRuntime;
      const tab = yield* openTab(runtime);
      chrome.clear();
      yield* runtime.input({
        tabId: tab.id,
        events: [
          { type: "key", action: "down", key: "a", code: "KeyA", modifiers: 4 },
          { type: "key", action: "up", key: "a", code: "KeyA", modifiers: 4 },
          {
            type: "mouse",
            action: "move",
            x: 5_000,
            y: -20,
            button: "none",
            buttons: 0,
            clickCount: 0,
            modifiers: 0,
          },
          { type: "text", text: "héllo" },
        ],
      });
      expect(chrome.commands.map(({ method, params }) => [method, params])).toEqual([
        [
          "Input.dispatchKeyEvent",
          {
            type: "rawKeyDown",
            key: "a",
            code: "KeyA",
            modifiers: 4,
            commands: ["selectAll"],
            windowsVirtualKeyCode: 65,
          },
        ],
        ["Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 4 }],
        [
          "Input.dispatchMouseEvent",
          {
            type: "mouseMoved",
            x: 1280,
            y: 0,
            button: "none",
            buttons: 0,
            clickCount: 0,
            modifiers: 0,
          },
        ],
        ["Input.insertText", { text: "héllo" }],
      ]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("lets go of held keys and buttons on release and after 10 seconds without input", () =>
    Effect.gen(function* () {
      const { chrome, runtime } = yield* makeRuntime;
      const tab = yield* openTab(runtime);
      const press = (events: ReadonlyArray<NodeBrowserInputEvent>) =>
        runtime.input({ tabId: tab.id, events });
      const buttonDown: NodeBrowserInputEvent = {
        type: "mouse",
        action: "down",
        x: 10,
        y: 20,
        button: "left",
        buttons: 1,
        clickCount: 1,
        modifiers: 0,
      };
      yield* press([
        { type: "key", action: "down", key: "Shift", code: "ShiftLeft", modifiers: 8 },
      ]);
      chrome.clear();
      yield* press([{ type: "release" }]);
      expect(chrome.sent("Input.dispatchKeyEvent").map((command) => command.params)).toEqual([
        { type: "keyUp", key: "Shift", code: "ShiftLeft" },
      ]);

      yield* press([buttonDown]);
      chrome.clear();
      yield* TestClock.adjust("9 seconds");
      expect(chrome.sent("Input.dispatchMouseEvent")).toEqual([]);
      yield* TestClock.adjust("1 second");
      yield* settle;
      expect(chrome.sent("Input.dispatchMouseEvent").map((command) => command.params)).toEqual([
        { type: "mouseReleased", button: "left", x: 10, y: 20, buttons: 0, clickCount: 1 },
      ]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("holds input while a page dialog is open and answers it only through a command", () =>
    Effect.gen(function* () {
      const { chrome, runtime } = yield* makeRuntime;
      const tab = yield* openTab(runtime);
      yield* chrome.hooks().onEvent({
        method: "Page.javascriptDialogOpening",
        sessionId: "S1",
        params: { type: "prompt", message: "Name?", defaultPrompt: "Ada" },
      });
      chrome.clear();
      yield* runtime.input({ tabId: tab.id, events: [{ type: "text", text: "typed" }] });
      expect(chrome.commands).toEqual([]);
      const result = yield* runtime.command({
        type: "dialog",
        tabId: tab.id,
        accept: true,
        promptText: "Grace",
      });
      expect(result.tab?.dialog).toEqual({ type: "prompt", message: "Name?", defaultValue: "Ada" });
      expect(chrome.sent("Page.handleJavaScriptDialog", "S1")[0]?.params).toEqual({
        accept: true,
        promptText: "Grace",
      });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("publishes availability and every tab change to subscribers", () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeRuntime;
      const events = yield* Queue.unbounded<string>();
      yield* Effect.forkScoped(
        runtime.subscribe.pipe(
          Stream.runForEach((event) =>
            Queue.offer(
              events,
              event.type === "tabs"
                ? `tabs:${event.tabs.length}`
                : `available:${event.capability.available}`,
            ),
          ),
        ),
      );
      yield* settle;
      yield* openTab(runtime);
      yield* settle;
      const seen = yield* Queue.takeAll(events);
      expect(seen.slice(0, 2)).toEqual(["available:true", "tabs:0"]);
      expect(seen.at(-1)).toBe("tabs:1");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("node browser runtime with a page that does not answer", () => {
  it.effect("fails a still within its bound", () =>
    Effect.gen(function* () {
      const { chrome, runtime } = yield* makeRuntime;
      const tab = yield* openTab(runtime);
      chrome.hang.add("Page.getLayoutMetrics");
      const still = yield* Effect.forkChild(
        runtime.read({ type: "still", tabId: tab.id, maxWidth: 640, maxHeight: 480, quality: 50 }),
      );
      yield* TestClock.adjust("9 seconds");
      expect(still.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");
      yield* settle;
      const exit = still.pollUnsafe();
      expect(exit && Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("ends a suspended tab's capture at once and frees the tab for the next one", () =>
    Effect.gen(function* () {
      const { chrome, runtime } = yield* makeRuntime;
      const first = yield* openTab(runtime);
      chrome.hang.add("Page.getLayoutMetrics");
      const still = yield* Effect.forkChild(
        runtime.read({
          type: "still",
          tabId: first.id,
          maxWidth: 640,
          maxHeight: 480,
          quality: 50,
        }),
      );
      yield* settle;
      // Six more tabs suspend the least recently used one nobody watches: the first.
      for (let index = 0; index < 6; index += 1) yield* openTab(runtime);
      yield* settle;
      const exit = still.pollUnsafe();
      expect(exit && Exit.isFailure(exit)).toBe(true);
      chrome.hang.delete("Page.getLayoutMetrics");
      const next = yield* runtime
        .read({ type: "still", tabId: first.id, maxWidth: 640, maxHeight: 480, quality: 50 })
        .pipe(Effect.timeout("1 second"));
      expect(next.type).toBe("still");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("serves a viewer at once although its first still never comes", () =>
    Effect.gen(function* () {
      const { chrome, runtime } = yield* makeRuntime;
      const tab = yield* openTab(runtime);
      chrome.hang.add("Page.getLayoutMetrics");
      const viewer = yield* makeViewer;
      yield* Effect.forkScoped(runtime.serveViewer(viewer.socket, frameParams(tab.id)));
      yield* settle;
      yield* chrome.hooks().onEvent(screencastFrame("S2", 1));
      yield* settle;
      expect(viewer.frames().map((frame) => frame.seq)).toEqual([0]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("ends a viewer that leaves while its tab is still attaching", () =>
    Effect.gen(function* () {
      const { chrome, runtime } = yield* makeRuntime;
      const tab = yield* openTab(runtime);
      chrome.hang.add("Target.attachToTarget");
      const viewer = yield* makeViewer;
      const served = yield* Effect.forkChild(
        Effect.scoped(runtime.serveViewer(viewer.socket, frameParams(tab.id))),
      );
      yield* settle;
      expect(served.pollUnsafe()).toBeUndefined();
      yield* viewer.leave;
      yield* settle;
      expect(served.pollUnsafe()).toBeDefined();
      // Its place is free again: four more viewers fit.
      chrome.hang.delete("Target.attachToTarget");
      for (let index = 0; index < 4; index += 1) {
        const other = yield* makeViewer;
        yield* Effect.forkScoped(runtime.serveViewer(other.socket, frameParams(tab.id)));
        yield* settle;
        expect(other.closes()).toEqual([]);
      }
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("stops an input batch at the first event the page does not take", () =>
    Effect.gen(function* () {
      const { chrome, runtime } = yield* makeRuntime;
      const tab = yield* openTab(runtime);
      chrome.hang.add("Input.dispatchMouseEvent");
      chrome.clear();
      const click = (action: "down" | "up"): NodeBrowserInputEvent => ({
        type: "mouse",
        action,
        x: 1,
        y: 1,
        button: "left",
        buttons: action === "down" ? 1 : 0,
        clickCount: 1,
        modifiers: 0,
      });
      const batch = yield* Effect.forkChild(
        runtime.input({ tabId: tab.id, events: [click("down"), click("up"), click("down")] }),
      );
      yield* TestClock.adjust("5 seconds");
      yield* settle;
      expect(batch.pollUnsafe()).toBeDefined();
      expect(chrome.sent("Input.dispatchMouseEvent")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("closes a page that fails its setup, so none outlives the caps", () =>
    Effect.gen(function* () {
      const { chrome, runtime } = yield* makeRuntime;
      const tab = yield* openTab(runtime);
      yield* chrome
        .hooks()
        .onEvent({ method: "Inspector.targetCrashed", sessionId: "S1", params: {} });
      chrome.fail.add("Emulation.setDeviceMetricsOverride");
      chrome.clear();
      const error = yield* Effect.flip(runtime.command({ type: "wake", tabId: tab.id }));
      expect(error.code).toBe("failed");
      expect(chrome.sent("Target.closeTarget").map((command) => command.params)).toEqual([
        { targetId: "T2" },
      ]);
      // The failed page's session is forgotten too.
      yield* chrome.hooks().onEvent({
        method: "Page.javascriptDialogOpening",
        sessionId: "S2",
        params: { type: "alert", message: "late" },
      });
      const listed = yield* runtime.read({ type: "list" });
      expect(listed.type === "list" && listed.tabs[0]).toMatchObject({
        state: "crashed",
        dialog: null,
      });
      chrome.fail.delete("Emulation.setDeviceMetricsOverride");
      const woken = yield* runtime.command({ type: "wake", tabId: tab.id });
      expect(woken.tab?.state).toBe("live");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

// Real-browser checks run only when this names a chrome-headless-shell, for
// example one Ryco installed under <baseDir>/tools/chrome-headless-shell.
const liveBrowser = process.env.RYCO_TEST_HEADLESS_SHELL;

describe.skipIf(liveBrowser === undefined)("node browser runtime with a real browser", () => {
  const LiveLayer = Layer.mergeAll(
    Layer.succeed(
      PreviewBrowser,
      PreviewBrowser.of({
        executable: Effect.succeed(liveBrowser!),
        installed: Effect.succeedSome(liveBrowser!),
      }),
    ),
    ServerConfig.layerTest(process.cwd(), { prefix: "ryco-node-browser-live-" }),
  ).pipe(Layer.provideMerge(NodeServices.layer));

  const servePage = Effect.acquireRelease(
    Effect.promise(async () => {
      const { createServer } = await import("node:http");
      const server = createServer((_request, response) => {
        response.setHeader("content-type", "text/html");
        response.end(
          "<title>Fixture</title><body style='margin:0;background:#2a6'><h1>Node tab</h1></body>",
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return server;
    }),
    (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );

  it.live(
    "never lets one app's service worker answer for the pages after it",
    () =>
      Effect.gen(function* () {
        let workerFetched = false;
        const server = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const { createServer } = await import("node:http");
            const listening = createServer((request, response) => {
              if (request.url === "/sw.js") {
                workerFetched = true;
                response.setHeader("content-type", "text/javascript");
                response.end(
                  "self.addEventListener('install', () => self.skipWaiting());" +
                    "self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));" +
                    "self.addEventListener('fetch', (event) => { if (event.request.mode === 'navigate') " +
                    "event.respondWith(new Response('<title>worker</title>', { headers: { 'content-type': 'text/html' } })); });",
                );
                return;
              }
              response.setHeader("content-type", "text/html");
              response.end(
                "<title>server</title><script>navigator.serviceWorker.register('/sw.js')</script>",
              );
            });
            await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
            return listening;
          }),
          (listening) =>
            Effect.promise(() => new Promise<void>((resolve) => listening.close(() => resolve()))),
        );
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        const runtime = yield* makeNodeBrowserRuntime({
          baseCapability: { available: true },
          noSandbox: false,
        });
        const opened = yield* runtime.command({
          type: "open",
          scope: "/work/app",
          url: `127.0.0.1:${port}`,
        });
        const title = Effect.map(runtime.read({ type: "list" }), (listed) =>
          listed.type === "list" ? listed.tabs[0]?.title : undefined,
        );
        yield* Effect.repeat(title, {
          until: (value) => value === "server" && workerFetched,
          schedule: Schedule.spaced("50 millis"),
        }).pipe(Effect.timeout("10 seconds"));
        // Long enough for the worker to install, activate and claim the page.
        yield* Effect.sleep("1500 millis");
        yield* runtime.command({ type: "reload", tabId: opened.tab!.id });
        yield* Effect.sleep("1500 millis");
        expect(yield* title).toBe("server");
      }).pipe(Effect.scoped, Effect.provide(LiveLayer)),
    30_000,
  );

  it.live(
    "loads a local page, streams it and captures stills that fit the bounds",
    () =>
      Effect.gen(function* () {
        const server = yield* servePage;
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        const runtime = yield* makeNodeBrowserRuntime({
          baseCapability: { available: true },
          noSandbox: false,
        });
        const opened = yield* runtime.command({
          type: "open",
          scope: "/work/app",
          url: `127.0.0.1:${port}`,
        });
        const tab = opened.tab!;
        yield* runtime.command({ type: "resize", tabId: tab.id, width: 800, height: 600 });
        const viewer = yield* makeViewer;
        yield* Effect.forkScoped(runtime.serveViewer(viewer.socket, frameParams(tab.id)));
        const titled = yield* Effect.repeat(runtime.read({ type: "list" }), {
          until: (listed) => listed.type === "list" && listed.tabs[0]?.title === "Fixture",
          schedule: Schedule.spaced("50 millis"),
        }).pipe(Effect.timeout("10 seconds"));
        expect(titled.type === "list" && titled.tabs[0]).toMatchObject({
          url: `http://127.0.0.1:${port}/`,
          state: "live",
        });
        yield* Effect.repeat(
          Effect.sync(() => viewer.frames().length),
          {
            until: (count) => count > 0,
            schedule: Schedule.spaced("50 millis"),
          },
        ).pipe(Effect.timeout("10 seconds"));
        expect(viewer.frames()[0]).toMatchObject({ cssWidth: 800, cssHeight: 600 });
        expect([...viewer.frames()[0]!.jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);

        const read = yield* runtime.read({
          type: "still",
          tabId: tab.id,
          maxWidth: 400,
          maxHeight: 400,
          quality: 50,
        });
        if (read.type !== "still") throw new Error("expected a still");
        expect(read.still).toMatchObject({
          cssWidth: 800,
          cssHeight: 600,
          width: 400,
          height: 300,
        });
        const jpeg = Buffer.from(read.still.bytesBase64, "base64");
        // The JPEG's own size, from its SOF0 marker.
        const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
        expect([jpeg.readUInt16BE(sof + 7), jpeg.readUInt16BE(sof + 5)]).toEqual([400, 300]);

        const error = yield* Effect.flip(
          runtime.command({ type: "navigate", tabId: tab.id, url: "file:///etc/passwd" }),
        );
        expect(error.code).toBe("invalid-url");
        yield* runtime.command({ type: "close", tabId: tab.id });
        yield* Effect.repeat(Effect.sync(viewer.closes), {
          until: (closes) => closes.length > 0,
          schedule: Schedule.spaced("20 millis"),
        }).pipe(Effect.timeout("5 seconds"));
        expect(viewer.closes()).toEqual([NODE_BROWSER_FRAME_CLOSE.tabGone]);
      }).pipe(Effect.scoped, Effect.provide(LiveLayer)),
    30_000,
  );
});
