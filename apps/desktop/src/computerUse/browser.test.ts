import type { ComputerUseResult } from "@ryco/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_DIALOG_SCOPE_SLACK_MS,
  BROWSER_MUTATING_ACTIONS,
  BROWSER_SNAPSHOT_SCRIPT,
  BrowserComputerDriver,
  REVIVED_TAB_ERROR,
  REVIVED_TAB_NOTE,
  RYCO_BROWSER_SNAPSHOT_SCRIPT,
  type BrowserDialogPolicy,
  type BrowserFileChooser,
  type BrowserHandledDialog,
  type BrowserPendingDialog,
  type BrowserTabAutomation,
  type BrowserTabRevival,
  type BrowserTransport,
  type BrowserUploads,
  type ExpectedAgentInput,
  type ResolvedBrowserUpload,
} from "./browser.ts";
import { result } from "./native.ts";
import type { ComputerOperationContext } from "./policy.ts";

it("requires a new observation when a replacement browser reuses tab and document ids", async () => {
  const makeTransport = (): BrowserTransport => ({
    tabs: vi.fn(async () => [{ id: "1", url: "https://example.com/", title: "Test" }]),
    open: vi.fn(),
    show: vi.fn(),
    close: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(async (_tab, method) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "frame", loaderId: "doc" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      return { result: { value: {} } };
    }),
  });
  const transports = new Map<"chrome", BrowserTransport>([["chrome", makeTransport()]]);
  const driver = new BrowserComputerDriver(transports);
  const context: ComputerOperationContext = {
    request: {
      sessionId: "session",
      threadId: "thread",
      turnId: "turn",
      tool: "browser",
      args: { action: "observe", tab: "1" },
    },
    signal: new AbortController().signal,
    check: vi.fn(),
    authorizeApp: vi.fn(),
    authorizeForeground: vi.fn(),
    claim: vi.fn(),
    activity: vi.fn(),
  };
  await driver.execute(context, "chrome");
  const replacement = makeTransport();
  transports.set("chrome", replacement);
  Object.assign(context.request.args, { action: "type", text: "Must not be typed" });
  await expect(driver.execute(context, "chrome")).rejects.toThrow("Observe this document");
  expect(replacement.send).not.toHaveBeenCalledWith(
    "1",
    "Input.insertText",
    expect.anything(),
    expect.anything(),
  );
});

it.each([
  { action: "open", url: "https://example.com", visible: true },
  { action: "show", tab: "1" },
])("requires foreground consent before presenting a browser: $action", async (args) => {
  const transport: BrowserTransport = {
    tabs: vi.fn(),
    open: vi.fn(),
    show: vi.fn(),
    close: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(),
  };
  const context: ComputerOperationContext = {
    request: { sessionId: "s", threadId: "t", turnId: "u", tool: "browser", args },
    signal: new AbortController().signal,
    check: vi.fn(),
    authorizeApp: vi.fn(),
    claim: vi.fn(),
    activity: vi.fn(),
    authorizeForeground: vi.fn(async () => {
      throw new Error("Foreground disabled");
    }),
  };
  const driver = new BrowserComputerDriver(new Map([["chrome", transport]]));
  await expect(driver.execute(context, "chrome")).rejects.toThrow("Foreground disabled");
  expect(transport.open).not.toHaveBeenCalled();
  expect(transport.show).not.toHaveBeenCalled();
});

it("opens and navigates background tabs without requesting foreground control", async () => {
  const tab = { id: "1", url: "https://example.com/", title: "Test" };
  const transport: BrowserTransport = {
    tabs: vi.fn(async () => [tab]),
    open: vi.fn(async () => tab),
    show: vi.fn(),
    close: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(async () => ({})),
  };
  const context: ComputerOperationContext = {
    request: {
      sessionId: "s",
      threadId: "t",
      turnId: "u",
      tool: "browser",
      args: { action: "open", url: tab.url },
    },
    signal: new AbortController().signal,
    check: vi.fn(),
    authorizeApp: vi.fn(),
    claim: vi.fn(),
    activity: vi.fn(),
    authorizeForeground: vi.fn(),
  };
  const driver = new BrowserComputerDriver(new Map([["chrome", transport]]));
  await driver.execute(context, "chrome");
  expect(transport.open).toHaveBeenCalledWith(tab.url, false, context.signal);
  Object.assign(context.request.args, { action: "navigate", tab: "1" });
  await driver.execute(context, "chrome");
  expect(transport.send).toHaveBeenCalledWith(
    "1",
    "Page.navigate",
    { url: tab.url },
    context.signal,
  );
  expect(context.authorizeForeground).not.toHaveBeenCalled();
  expect(transport.show).not.toHaveBeenCalled();
});

it("keeps Ryco visibility requests in the workspace without foreground consent", async () => {
  const tab = { id: "1", url: "https://example.com/", title: "Test" };
  const transport: BrowserTransport = {
    tabs: vi.fn(async () => [tab]),
    open: vi.fn(async () => tab),
    show: vi.fn(async () => {}),
    close: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(),
  };
  const context: ComputerOperationContext = {
    request: {
      sessionId: "s",
      threadId: "t",
      turnId: "u",
      tool: "browser",
      args: { action: "open", url: tab.url, visible: true },
    },
    signal: new AbortController().signal,
    check: vi.fn(),
    authorizeApp: vi.fn(),
    claim: vi.fn(),
    activity: vi.fn(),
    authorizeForeground: vi.fn(async () => {
      throw new Error("Foreground disabled");
    }),
  };
  const driver = new BrowserComputerDriver(new Map([["ryco", transport]]));
  await driver.execute(context, "ryco");
  expect(transport.open).toHaveBeenCalledWith(tab.url, false, context.signal);
  Object.assign(context.request.args, { action: "show", tab: tab.id });
  const shown = await driver.execute(context, "ryco");
  expect(shown.content).toContainEqual({
    type: "text",
    text: JSON.stringify({ shown: false, presentation: "workspace" }),
  });
  expect(context.authorizeForeground).not.toHaveBeenCalled();
  expect(context.activity).toHaveBeenLastCalledWith(
    expect.objectContaining({ mode: "background" }),
  );
});

it("brackets mutating actions with beginAgentMutation and leaves reads alone", async () => {
  const tab = { id: "1", url: "https://example.com/", title: "Test" };
  const log: string[] = [];
  let failNavigate = false;
  const transport: BrowserTransport = {
    tabs: vi.fn(async () => [tab]),
    open: vi.fn(),
    show: vi.fn(),
    close: vi.fn(async () => {
      log.push("close");
    }),
    stop: vi.fn(),
    send: vi.fn(async (_tab, method) => {
      log.push(method);
      if (method === "Page.navigate" && failNavigate) throw new Error("navigation failed");
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "frame", loaderId: "doc" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      if (method === "Page.captureScreenshot") return { data: "png" };
      return { result: { value: {} } };
    }),
    beginAgentMutation: vi.fn(async () => {
      log.push("begin");
      return () => {
        log.push("end");
      };
    }),
    // The Ryco browser; this test's tab has no live page automation.
    automation: vi.fn(() => undefined),
  };
  const context: ComputerOperationContext = {
    request: {
      sessionId: "s",
      threadId: "t",
      turnId: "u",
      tool: "browser",
      args: { action: "navigate", tab: "1", url: tab.url },
    },
    signal: new AbortController().signal,
    check: vi.fn(),
    authorizeApp: vi.fn(),
    authorizeForeground: vi.fn(),
    claim: vi.fn(),
    activity: vi.fn(async () => {
      log.push("activity");
    }),
  };
  const driver = new BrowserComputerDriver(new Map([["ryco", transport]]));
  const run = async (args: Record<string, unknown>) => {
    log.length = 0;
    return driver.execute(
      { ...context, request: { ...context.request, args: { tab: "1", ...args } } },
      "ryco",
    );
  };

  await run({ action: "navigate", url: tab.url });
  expect(log).toEqual(["activity", "begin", "Page.navigate", "end"]);
  expect(transport.beginAgentMutation).toHaveBeenCalledWith("1", context.signal);

  failNavigate = true;
  await expect(run({ action: "navigate", url: tab.url })).rejects.toThrow("navigation failed");
  expect(log).toEqual(["activity", "begin", "Page.navigate", "end"]);

  await run({ action: "observe" });
  expect(log).toEqual([
    "activity",
    "Page.getFrameTree",
    "Page.createIsolatedWorld",
    "Runtime.evaluate",
  ]);
  await run({ action: "screenshot" });
  expect(log).not.toContain("begin");
  expect(log).toContain("Page.captureScreenshot");
  await run({ action: "show" });
  expect(log).toEqual(["activity"]);

  await run({ action: "close" });
  expect(log).toEqual(["activity", "begin", "close", "end"]);
  expect(transport.beginAgentMutation).toHaveBeenCalledTimes(3);
});

it("checks the operation again after a mutation bracket", async () => {
  const tab = { id: "1", url: "https://example.com/", title: "Test" };
  const transport: BrowserTransport = {
    tabs: vi.fn(async () => [tab]),
    open: vi.fn(),
    show: vi.fn(),
    close: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(async () => ({})),
    beginAgentMutation: vi.fn(async () => () => {}),
  };
  let cancelled = false;
  const context: ComputerOperationContext = {
    request: {
      sessionId: "s",
      threadId: "t",
      turnId: "u",
      tool: "browser",
      args: { action: "reload", tab: "1" },
    },
    signal: new AbortController().signal,
    // Cancelled while the bracket waited (after the pre-activity check passed).
    check: vi.fn(() => {
      if (cancelled) throw new Error("Computer use was stopped.");
    }),
    authorizeApp: vi.fn(),
    authorizeForeground: vi.fn(),
    claim: vi.fn(),
    activity: vi.fn(async () => {
      cancelled = true;
    }),
  };
  const driver = new BrowserComputerDriver(new Map([["ryco", transport]]));
  await expect(driver.execute(context, "ryco")).rejects.toThrow("Computer use was stopped.");
  expect(transport.send).not.toHaveBeenCalled();
});

it("never lets the bracket's end replace the action's result or error", async () => {
  const tab = { id: "1", url: "https://example.com/", title: "Test" };
  let failNavigate = false;
  const end = vi.fn(() => {
    throw new Error("end failed");
  });
  const transport: BrowserTransport = {
    tabs: vi.fn(async () => [tab]),
    open: vi.fn(),
    show: vi.fn(),
    close: vi.fn(async () => {}),
    stop: vi.fn(),
    send: vi.fn(async (_tab, method) => {
      if (method === "Page.navigate" && failNavigate) throw new Error("navigation failed");
      return { frameId: "frame" };
    }),
    beginAgentMutation: vi.fn(async () => end),
  };
  const context: ComputerOperationContext = {
    request: { sessionId: "s", threadId: "t", turnId: "u", tool: "browser", args: {} },
    signal: new AbortController().signal,
    check: vi.fn(),
    authorizeApp: vi.fn(),
    authorizeForeground: vi.fn(),
    claim: vi.fn(),
    activity: vi.fn(),
  };
  const driver = new BrowserComputerDriver(new Map([["ryco", transport]]));
  const run = (args: Record<string, unknown>) =>
    driver.execute(
      { ...context, request: { ...context.request, args: { tab: "1", ...args } } },
      "ryco",
    );

  await expect(run({ action: "navigate", url: tab.url })).resolves.toEqual({
    content: [{ type: "text", text: JSON.stringify({ frameId: "frame" }) }],
  });
  failNavigate = true;
  await expect(run({ action: "navigate", url: tab.url })).rejects.toThrow("navigation failed");
  // It also runs after a close removed the tab.
  await expect(run({ action: "close" })).resolves.toEqual({
    content: [{ type: "text", text: JSON.stringify({ closed: true }) }],
  });
  expect(end).toHaveBeenCalledTimes(3);
});

it("reports a revived Ryco tab and requires a fresh observation", async () => {
  const tab = { id: "1", url: "https://example.com/", title: "Test" };
  const note = { type: "text", text: REVIVED_TAB_NOTE };
  const log: string[] = [];
  let reload: BrowserTabRevival = null;
  const transport: BrowserTransport = {
    tabs: vi.fn(async () => [tab]),
    open: vi.fn(),
    show: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    stop: vi.fn(),
    send: vi.fn(async (_tab, method) => {
      log.push(method);
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "frame", loaderId: "doc" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      if (method === "Runtime.evaluate") return { result: { value: { x: 10, y: 20 } } };
      if (method === "Page.getNavigationHistory")
        return {
          currentIndex: 1,
          entries: [
            { id: 1, url: "https://example.com/" },
            { id: 2, url: "https://example.com/next" },
          ],
        };
      return { frameId: "frame" };
    }),
    // The tab was suspended (and reloaded) when `reload` is set, reported once.
    wake: vi.fn(async () => {
      log.push("wake");
      const revival = reload;
      reload = null;
      return revival;
    }),
    // The Ryco browser; this test's tab has no live page automation.
    automation: vi.fn(() => undefined),
  };
  const context: ComputerOperationContext = {
    request: { sessionId: "s", threadId: "t", turnId: "u", tool: "browser", args: {} },
    signal: new AbortController().signal,
    check: vi.fn(),
    authorizeApp: vi.fn(),
    authorizeForeground: vi.fn(),
    claim: vi.fn(),
    activity: vi.fn(),
  };
  const driver = new BrowserComputerDriver(new Map([["ryco", transport]]));
  const run = (args: Record<string, unknown>) => {
    log.length = 0;
    return driver.execute(
      { ...context, request: { ...context.request, args: { tab: "1", ...args } } },
      "ryco",
    );
  };

  // A revived tab's observation ends with the note; the wake runs before any command.
  reload = "now";
  const observed = await run({ action: "observe" });
  expect(observed.content.at(-1)).toEqual(note);
  expect(observed.content).toHaveLength(2);
  expect(log[0]).toBe("wake");
  expect(transport.wake).toHaveBeenCalledWith("1", context.signal);
  // A live tab's results carry no note.
  expect((await run({ action: "observe" })).content).not.toContainEqual(note);
  // Interactions after a reload need a new observation: refused before any input.
  reload = "now";
  await expect(run({ action: "click", ref: "e1" })).rejects.toThrow(REVIVED_TAB_ERROR);
  expect(log).toEqual(["wake"]);
  await expect(run({ action: "click", ref: "e1" })).rejects.toThrow("Observe this document");
  expect(log).not.toContain("Input.dispatchMouseEvent");
  // A page loaded just now has no history.
  reload = "now";
  await expect(run({ action: "back" })).rejects.toThrow("Observe it again");
  expect(log).toEqual(["wake"]);
  // A reload is not repeated.
  reload = "now";
  await expect(run({ action: "reload" })).resolves.toEqual({
    content: [{ type: "text", text: JSON.stringify({ reloaded: true }) }, note],
  });
  expect(log).toEqual(["wake"]);
  // A tab the user revived earlier may have reloaded stale content or built new history since:
  // reload and history go ahead (with the note), interactions still need a new observation.
  reload = "earlier";
  await expect(run({ action: "reload" })).resolves.toEqual({
    content: [{ type: "text", text: JSON.stringify({ frameId: "frame" }) }, note],
  });
  expect(log).toEqual(["wake", "Page.reload"]);
  reload = "earlier";
  await expect(run({ action: "back" })).resolves.toEqual({
    content: [{ type: "text", text: JSON.stringify({ frameId: "frame" }) }, note],
  });
  expect(log).toEqual(["wake", "Page.getNavigationHistory", "Page.navigateToHistoryEntry"]);
  await run({ action: "observe" });
  reload = "earlier";
  await expect(run({ action: "click", ref: "e1" })).rejects.toThrow(REVIVED_TAB_ERROR);
  expect(log).toEqual(["wake"]);
  // Navigation goes ahead and says so.
  reload = "now";
  const navigated = await run({ action: "navigate", url: "https://example.org/" });
  expect(navigated.content).toEqual([
    { type: "text", text: JSON.stringify({ frameId: "frame" }) },
    note,
  ]);
  // tabs, show and close never wake a tab.
  await run({ action: "show" });
  await run({ action: "close" });
  await driver.execute(
    { ...context, request: { ...context.request, args: { action: "tabs" } } },
    "ryco",
  );
  expect(transport.wake).toHaveBeenCalledTimes(11);

  // A transport without wake behaves as before.
  const { wake: _wake, ...plain } = transport;
  const plainDriver = new BrowserComputerDriver(new Map([["ryco", plain]]));
  const plainResult = await plainDriver.execute(
    { ...context, request: { ...context.request, args: { tab: "1", action: "observe" } } },
    "ryco",
  );
  expect(plainResult.content).toHaveLength(1);
});

interface RycoState {
  epoch: number;
  hold: number;
  pending: BrowserPendingDialog | null;
  backlog: BrowserHandledDialog[];
  dialogs: BrowserHandledDialog[];
  idle: { idle: boolean; inFlight: number; quietMs: number };
  loaders: string[];
  url: string;
  zoom: number;
  /** What `automation.emulation()` reports. */
  emulated: { viewport?: { width: number; height: number }; colorScheme?: "dark" | "light" };
  /** The page is live (false: suspended or gone, so `automation(tab)` has none). */
  live: boolean;
  /** The file chooser the page opened (intercepted), and whether a result mentioned it. */
  chooser: BrowserFileChooser | null;
  chooserReported: boolean;
  /** DOM.setFileInputFiles fails (after reaching the page, as far as the driver can tell). */
  failSetFiles: boolean;
}

/** A Ryco-like transport whose automation is a controllable stub; `evaluate` answers Runtime.evaluate. */
function rycoFixture(
  evaluate: (expression: string, state: RycoState) => unknown = () => true,
  options: { automation?: boolean; uploads?: boolean } = {},
) {
  const state: RycoState = {
    epoch: 0,
    hold: 0,
    pending: null,
    backlog: [],
    dialogs: [],
    idle: { idle: true, inFlight: 0, quietMs: 600 },
    loaders: [],
    url: "https://example.com/",
    zoom: 1,
    emulated: {},
    live: true,
    chooser: null,
    chooserReported: false,
    failSetFiles: false,
  };
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  let worlds = 0;
  let loader = "doc";
  const release = vi.fn();
  const end = vi.fn(async (_input?: { failed?: boolean }) => ({ dialogs: state.dialogs }));
  const automation = {
    get humanEpoch() {
      return state.epoch;
    },
    humanHoldMs: vi.fn(() => state.hold),
    pendingDialog: vi.fn(() => state.pending),
    begin: vi.fn(async (_policy: BrowserDialogPolicy, _signal: AbortSignal, _maxMs: number) => ({
      end,
    })),
    takeBacklog: vi.fn(() => state.backlog.splice(0)),
    expectInput: vi.fn((_input: ExpectedAgentInput) => release),
    zoomFactor: vi.fn(() => state.zoom),
    networkIdle: vi.fn(() => state.idle),
    diagnostics: vi.fn(async (_kind: "console" | "network", limit: number) => ({
      startedAt: "s",
      capturedAt: "c",
      droppedCount: 0,
      truncated: false,
      entries: [
        {
          kind: "console" as const,
          timestamp: "t",
          level: "error" as const,
          text: `limit ${limit}`,
        },
      ],
    })),
    recordEmulation: vi.fn(),
    emulation: vi.fn(() => state.emulated),
    peekFileChooser: vi.fn(() => state.chooser),
    takeFileChooser: vi.fn(() => {
      const chooser = state.chooser;
      state.chooser = null;
      return chooser;
    }),
    noteFileChooser: vi.fn((): { mode: BrowserFileChooser["mode"]; answerable?: false } | null => {
      if (!state.chooser || state.chooserReported) return null;
      state.chooserReported = true;
      return { mode: state.chooser.mode };
    }),
  } satisfies BrowserTabAutomation;
  // The desktop's upload store: accepts whatever the request carries.
  const uploads = {
    resolve: vi.fn(
      async (tab: string, uploadId: unknown, files: unknown): Promise<ResolvedBrowserUpload> => {
        const paths = files as string[];
        return {
          tab,
          dir: `/uploads/${String(uploadId)}`,
          files: paths,
          names: paths.map((file) => file.split("/").at(-1)!),
          bytes: 12 * paths.length,
        };
      },
    ),
    retain: vi.fn((_upload: ResolvedBrowserUpload) => undefined),
    discard: vi.fn(async (_dir: string) => undefined),
  } satisfies BrowserUploads;
  const transport: BrowserTransport = {
    tabs: vi.fn(async () => [{ id: "1", url: state.url, title: "Test" }]),
    open: vi.fn(),
    show: vi.fn(),
    close: vi.fn(async () => {}),
    stop: vi.fn(),
    send: vi.fn(async (_tab: string, method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
      if (method === "Page.getFrameTree") {
        loader = state.loaders.shift() ?? loader;
        return { frameTree: { frame: { id: "frame", loaderId: loader } } };
      }
      if (method === "Page.createIsolatedWorld") return { executionContextId: ++worlds };
      if (method === "Runtime.evaluate" && params.returnByValue === false) {
        // A remote object (upload's file input); an Error stands for the script throwing.
        const value = evaluate(String(params.expression), state);
        return value instanceof Error
          ? { exceptionDetails: { text: value.message } }
          : { result: { type: "object", subtype: "node", objectId: "input-1" } };
      }
      if (method === "Runtime.evaluate")
        return { result: { value: evaluate(String(params.expression), state) } };
      if (method === "Page.captureScreenshot") return { data: "png" };
      if (method === "DOM.setFileInputFiles" && state.failSetFiles)
        throw new Error("Browser command timed out.");
      return {};
    }),
    ...(options.automation === false
      ? {}
      : { automation: vi.fn(() => (state.live ? automation : undefined)) }),
  };
  const context: ComputerOperationContext = {
    request: { sessionId: "s", threadId: "t", turnId: "u", tool: "browser", args: {} },
    signal: new AbortController().signal,
    check: vi.fn(),
    authorizeApp: vi.fn(),
    authorizeForeground: vi.fn(),
    claim: vi.fn(),
    activity: vi.fn(),
  };
  const driver = new BrowserComputerDriver(
    new Map([["ryco", transport]]),
    options.uploads === false ? {} : { uploads: () => uploads },
  );
  const run = (args: Record<string, unknown>) =>
    driver.execute(
      { ...context, request: { ...context.request, args: { tab: "1", ...args } } },
      "ryco",
    );
  const methods = () => sent.map(({ method }) => method);
  return { state, sent, methods, automation, transport, context, run, release, end, uploads };
}
/** Answers the snapshot, the click's target point and every other evaluate. */
function page(expression: string): unknown {
  if (expression === BROWSER_SNAPSHOT_SCRIPT || expression === RYCO_BROWSER_SNAPSHOT_SCRIPT)
    return { title: "Test", elements: [] };
  if (expression.includes("const {x,y}=") && expression.includes("return {x,y}"))
    return { x: 50, y: 60 };
  return true;
}
const texts = (value: ComputerUseResult) =>
  value.content.flatMap((part) => (part.type === "text" ? [JSON.parse(part.text)] : []));

describe("wait", () => {
  it("polls until the selector appears and reports the match", async () => {
    let polls = 0;
    const { run, automation, methods } = rycoFixture((expression) =>
      expression.includes("const input =")
        ? {
            selector: ++polls > 1,
            text: null,
            url: "https://example.com/",
            title: "T",
            readyState: "complete",
          }
        : true,
    );
    const value = await run({ action: "wait", selector: "#result", timeout: 2_000 });
    expect(texts(value)[0]).toEqual({
      matched: true,
      elapsedMs: expect.any(Number),
      url: "https://example.com/",
      title: "T",
      documentChanged: false,
    });
    expect(polls).toBe(2);
    // Model input reaches the page only as JSON data.
    expect(methods().filter((method) => method === "Page.createIsolatedWorld")).toHaveLength(1);
    expect(automation.begin).toHaveBeenCalledTimes(1);
  });

  it("reports an invalid selector", async () => {
    const { run } = rycoFixture(() => ({ invalidSelector: true }));
    await expect(run({ action: "wait", selector: "a[" })).rejects.toThrow("Invalid CSS selector.");
  });

  it("validates its conditions", async () => {
    const { run } = rycoFixture();
    await expect(run({ action: "wait" })).rejects.toThrow("Give wait a selector");
    await expect(run({ action: "wait", urlIncludes: "/done", gone: true })).rejects.toThrow(
      "gone applies to selector or text.",
    );
    await expect(run({ action: "wait", text: "x", timeout: 30_001 })).rejects.toThrow(
      "Invalid timeout.",
    );
    await expect(run({ action: "wait", text: "x", timeout: 99 })).rejects.toThrow(
      "Invalid timeout.",
    );
    await expect(run({ action: "wait", idle: "dom" })).rejects.toThrow("Invalid idle.");
  });

  it("waits for network idle only in the Ryco browser", async () => {
    const loaded = {
      selector: null,
      text: null,
      url: "https://example.com/",
      title: "T",
      readyState: "complete",
    };
    const external = rycoFixture(() => loaded, { automation: false });
    await expect(external.run({ action: "wait", idle: "network" })).rejects.toThrow(
      'wait idle:"network" is available only for browser "ryco".',
    );
    expect(external.context.claim).not.toHaveBeenCalled();
    // Load and URL waits only need Runtime.evaluate, so they work everywhere.
    await expect(
      external.run({ action: "wait", idle: "load", urlIncludes: "example" }),
    ).resolves.toBeDefined();

    const ryco = rycoFixture(() => ({
      selector: null,
      text: null,
      url: "u",
      title: "t",
      readyState: "loading",
    }));
    ryco.state.idle = { idle: false, inFlight: 2, quietMs: 0 };
    let calls = 0;
    ryco.automation.networkIdle.mockImplementation(() =>
      ++calls > 1 ? { idle: true, inFlight: 0, quietMs: 500 } : ryco.state.idle,
    );
    await expect(ryco.run({ action: "wait", idle: "network" })).resolves.toBeDefined();
    expect(ryco.automation.networkIdle).toHaveBeenCalledTimes(2);
  });

  it("gives its dialog shim the wait's timeout plus slack", async () => {
    const { run, automation } = rycoFixture(() => ({
      selector: true,
      text: null,
      url: "u",
      title: "t",
      readyState: "complete",
    }));
    await run({ action: "wait", selector: "#x", timeout: 2_000 });
    expect(automation.begin).toHaveBeenCalledWith(
      {},
      expect.any(AbortSignal),
      2_000 + BROWSER_DIALOG_SCOPE_SLACK_MS,
    );
  });

  it("stops when a page dialog starts waiting for the user", async () => {
    const { run } = rycoFixture((expression, state) => {
      if (!expression.includes("const input =")) return true;
      state.pending = { kind: "confirm", message: "yours", openedAt: "now" };
      return { selector: false, text: null, url: "u", title: "t", readyState: "complete" };
    });
    await expect(run({ action: "wait", selector: "#never", timeout: 1_000 })).rejects.toThrow(
      "A page dialog in this tab is waiting for the user.",
    );
  });

  it("follows a new document with a fresh isolated world and says so", async () => {
    const { run, state, methods, transport } = rycoFixture((expression) =>
      expression.includes("const input =")
        ? {
            selector: true,
            text: null,
            url: "https://example.com/next",
            title: "Next",
            readyState: "complete",
          }
        : true,
    );
    // The action's world is made for "doc"; the first poll already sees the next document.
    state.loaders = ["doc", "doc-2"];
    const value = await run({ action: "wait", selector: "#done" });
    expect(texts(value)[0]).toEqual(
      expect.objectContaining({
        matched: true,
        documentChanged: true,
        verify: "The document changed; observe again before interacting.",
      }),
    );
    expect(methods().filter((method) => method === "Page.createIsolatedWorld")).toHaveLength(2);
    expect(transport.tabs).toHaveBeenCalledTimes(2);
  });
});

describe("human guard", () => {
  it("refuses input after the user touched the observed tab", async () => {
    const { run, state, methods } = rycoFixture(page);
    await run({ action: "observe" });
    state.epoch = 1;
    await expect(run({ action: "click", ref: "e1" })).rejects.toThrow("Observe it again");
    expect(methods()).not.toContain("Input.dispatchMouseEvent");
    // The observation is spent: even with the epoch back, observe first.
    await expect(run({ action: "type", text: "x" })).rejects.toThrow("Observe this document");
    await run({ action: "observe" });
    await expect(run({ action: "type", text: "x" })).resolves.toBeDefined();
  });

  it("checks again right before dispatching input", async () => {
    let bumpOn = "target moved"; // The click's last validation, right before mousePressed.
    const fixture = rycoFixture((expression, state) => {
      if (expression.includes(bumpOn)) state.epoch += 1; // The user clicked meanwhile.
      return page(expression);
    });
    await fixture.run({ action: "observe" });
    await expect(fixture.run({ action: "click", ref: "e1" })).rejects.toThrow("Observe it again");
    const mouse = fixture.sent.filter(({ method }) => method === "Input.dispatchMouseEvent");
    expect(mouse.map(({ params }) => params.type)).toEqual(["mouseMoved"]);
    // fill: the value evaluate is the dispatch, so the check runs before it.
    bumpOn = "cursor.animate";
    await fixture.run({ action: "observe" });
    const evaluations = () =>
      fixture.sent.filter(({ method }) => method === "Runtime.evaluate").length;
    const before = evaluations();
    await expect(fixture.run({ action: "fill", ref: "e1", text: "x" })).rejects.toThrow(
      "Observe it again",
    );
    expect(evaluations() - before).toBe(2); // Target point and cursor; never the value.
  });

  it("keeps the agent out of a tab the user is working in, before claiming it", async () => {
    const { run, state, context, methods, transport } = rycoFixture(page);
    await run({ action: "observe" });
    state.hold = 12_300;
    vi.mocked(context.claim).mockClear();
    for (const args of [
      { action: "click", ref: "e1" },
      { action: "navigate", url: "https://example.com/" },
      { action: "close" },
      { action: "resize", width: 400, height: 400 },
    ])
      await expect(run(args)).rejects.toThrow(
        'The user is working in this tab. Open your own background tab with action "open" (same URL), or wait 13 s and observe again.',
      );
    expect(context.claim).not.toHaveBeenCalled();
    expect(transport.close).not.toHaveBeenCalled();
    expect(methods()).not.toContain("Page.navigate");
    // Reads still work.
    await expect(run({ action: "observe" })).resolves.toBeDefined();
    await expect(run({ action: "screenshot" })).resolves.toBeDefined();
    await expect(run({ action: "console" })).resolves.toBeDefined();
  });

  it("checks the hold again on the page the action runs on", async () => {
    const { run, automation, context, methods } = rycoFixture(page);
    let calls = 0;
    // The user starts working in the tab while the action claims it.
    automation.humanHoldMs.mockImplementation(() => (++calls > 1 ? 4_000 : 0));
    await expect(run({ action: "navigate", url: "https://example.com/" })).rejects.toThrow(
      "The user is working in this tab.",
    );
    expect(context.claim).toHaveBeenCalled();
    expect(methods()).not.toContain("Page.navigate");
    expect(automation.begin).not.toHaveBeenCalled();
  });

  it("tells the tab which input is the agent's", async () => {
    const { run, automation, release } = rycoFixture(page);
    await run({ action: "observe" });
    await run({ action: "click", ref: "e1" });
    expect(automation.expectInput).toHaveBeenLastCalledWith({
      kind: "mouse",
      type: "mouseDown",
      x: 50,
      y: 60,
      button: "left",
    });
    await run({ action: "scroll", x: 10, y: 20, scrollY: 300 });
    expect(automation.expectInput).toHaveBeenLastCalledWith({
      kind: "mouse",
      type: "mouseWheel",
      x: 10,
      y: 20,
    });
    await run({ action: "key", key: "Enter" });
    expect(automation.expectInput).toHaveBeenLastCalledWith({
      kind: "key",
      key: "Enter",
      alt: false,
      control: false,
      meta: false,
      shift: false,
    });
    expect(automation.expectInput).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledTimes(3);
  });

  it("refuses every action but close while a page dialog waits for the user", async () => {
    const { run, state, context, transport } = rycoFixture(page);
    state.pending = { kind: "alert", message: "for you", openedAt: "now" };
    for (const action of ["observe", "click", "wait", "console"])
      await expect(run({ action, ref: "e1", text: "x" })).rejects.toThrow(
        "A page dialog in this tab is waiting for the user.",
      );
    expect(context.claim).not.toHaveBeenCalled();
    await expect(run({ action: "close" })).resolves.toEqual(result({ closed: true }));
    expect(transport.close).toHaveBeenCalledTimes(1);
  });
});

describe("dialogs", () => {
  it("answers dialogs during actions that can run page code and reports them", async () => {
    const { run, state, automation, end } = rycoFixture(page);
    await run({ action: "observe" });
    const dialog: BrowserHandledDialog = {
      kind: "confirm",
      message: "sure?",
      action: "accepted",
      openedAt: "now",
      during: "command",
    };
    state.dialogs = [dialog];
    const clicked = await run({ action: "click", ref: "e1", dialog: "accept", promptText: "Ada" });
    // An input action's shim answers for one CDP command's guard at most.
    expect(automation.begin).toHaveBeenCalledWith(
      { dialog: "accept", promptText: "Ada" },
      expect.any(AbortSignal),
      BROWSER_DIALOG_SCOPE_SLACK_MS,
    );
    expect(end).toHaveBeenCalledWith();
    expect(texts(clicked)).toEqual([
      { delivered: "background", verify: "Observe the page to verify the result." },
      { dialogs: [dialog] },
    ]);
    await expect(run({ action: "click", ref: "e1", dialog: "maybe" })).rejects.toThrow(
      "Invalid dialog.",
    );
    // Reads, show and close open no scope.
    automation.begin.mockClear();
    for (const action of ["observe", "screenshot", "console", "network", "show", "close"])
      await run({ action });
    await run({ action: "tabs" });
    expect(automation.begin).not.toHaveBeenCalled();
  });

  it("ends the scope as failed when the action fails", async () => {
    const { run, end } = rycoFixture(page);
    await expect(run({ action: "click", ref: "e1" })).rejects.toThrow("Observe this document");
    expect(end).toHaveBeenCalledWith({ failed: true });
  });

  it("reports background dialogs with the next read", async () => {
    const { run, state } = rycoFixture(page);
    const dialog: BrowserHandledDialog = {
      kind: "alert",
      message: "timer",
      action: "accepted",
      openedAt: "now",
      during: "background",
    };
    state.backlog = [dialog];
    const observed = await run({ action: "observe" });
    expect(texts(observed)).toEqual([{ title: "Test", elements: [] }, { dialogs: [dialog] }]);
    expect(texts(await run({ action: "observe" }))).toHaveLength(1);
  });

  it("answers a paired browser's dialogs inside the page during actions that can run page code", async () => {
    // The page's records claim an answer; the driver recomputes it from the action's policy.
    let drained: unknown = [
      { kind: "confirm", message: "sure?", action: "dismissed", openedAt: "2026-10-31T10:00:00Z" },
    ];
    const finishes = (expression: string) => expression.includes("delete window[");
    const { run, sent, methods } = rycoFixture(
      (expression) => (finishes(expression) ? drained : page(expression)),
      { automation: false },
    );
    await run({ action: "observe" });
    sent.length = 0;
    const clicked = await run({ action: "click", ref: "e1", dialog: "accept" });
    // A main-world shim (no isolated world) goes in before the input and is finished after it.
    const shim = sent.filter(
      ({ method, params }) => method === "Runtime.evaluate" && params.contextId === undefined,
    );
    expect(shim).toHaveLength(2);
    const install = String(shim[0]!.params.expression);
    const key = /__rycoDialogs[0-9a-f]{32}/u.exec(install)?.[0];
    expect(key).toBeDefined();
    expect(install).toContain('"accept":true');
    expect(String(shim[1]!.params.expression)).toContain(JSON.stringify(key));
    expect(methods().indexOf("Input.dispatchMouseEvent")).toBeGreaterThan(sent.indexOf(shim[0]!));
    expect(methods().lastIndexOf("Input.dispatchMouseEvent")).toBeLessThan(sent.indexOf(shim[1]!));
    expect(texts(clicked).at(-1)).toEqual({
      dialogs: [
        {
          kind: "confirm",
          message: "sure?",
          openedAt: "2026-10-31T10:00:00.000Z",
          action: "accepted",
          during: "command",
        },
      ],
    });
    // Each action gets its own key; reads open no scope.
    sent.length = 0;
    await run({ action: "click", ref: "e1" });
    expect(String(sent[0]!.params.expression)).not.toContain(key!);
    sent.length = 0;
    await run({ action: "observe" });
    await run({ action: "screenshot" });
    expect(sent.some(({ params }) => String(params.expression).includes("__rycoDialogs"))).toBe(
      false,
    );
  });

  it("reports a paired browser's dialogs from a failed action with the tab's next result", async () => {
    const drained = [{ kind: "alert", message: "before failing" }];
    const { run } = rycoFixture(
      (expression) => (expression.includes("delete window[") ? drained : page(expression)),
      { automation: false },
    );
    // Not observed yet: the click fails after its shim went in.
    await expect(run({ action: "click", ref: "e1" })).rejects.toThrow("Observe this document");
    drained.length = 0;
    const observed = await run({ action: "observe" });
    expect(texts(observed).at(-1)).toEqual({
      dialogs: [
        expect.objectContaining({ kind: "alert", message: "before failing", action: "accepted" }),
      ],
    });
    expect(texts(await run({ action: "observe" }))).toHaveLength(1);
  });

  it("still runs a paired browser's action when its shim cannot go in", async () => {
    const { run, transport } = rycoFixture(page, { automation: false });
    await run({ action: "observe" });
    const send = vi.mocked(transport.send);
    const base = send.getMockImplementation()!;
    send.mockImplementation(async (tab, method, params, signal) => {
      if (String(params.expression).includes("__rycoDialogs")) throw new Error("Action failed");
      return base(tab, method, params, signal);
    });
    await expect(run({ action: "click", ref: "e1" })).resolves.toBeDefined();
    // Nothing went in, so nothing is finished.
    expect(
      send.mock.calls.filter(([, , params]) =>
        String(params.expression).includes("delete window["),
      ),
    ).toEqual([]);
  });

  it("has no dialog action", async () => {
    const { run } = rycoFixture(page);
    await run({ action: "observe" });
    await expect(run({ action: "dialog" })).rejects.toThrow("Unknown browser action.");
  });
});

describe("Ryco-only actions", () => {
  it.each(["console", "network", "resize", "appearance", "upload"])(
    "refuses %s for other browsers before claiming the tab",
    async (action) => {
      const { run, context } = rycoFixture(() => true, { automation: false });
      await expect(run({ action, width: 400, height: 400, scheme: "dark" })).rejects.toThrow(
        `${action} is available only for browser "ryco".`,
      );
      expect(context.claim).not.toHaveBeenCalled();
    },
  );

  it("decides by the transport and uses the page as it is when the action runs", async () => {
    const { run, state, automation, context } = rycoFixture((expression) =>
      expression.includes("innerWidth")
        ? { width: 400, height: 400, devicePixelRatio: 1 }
        : page(expression),
    );
    // A suspended tab has no page until the action revives it (browser-tab-budget's wake).
    state.live = false;
    vi.mocked(context.claim).mockImplementation(() => {
      state.live = true;
    });
    await expect(run({ action: "console" })).resolves.toBeDefined();
    expect(automation.diagnostics).toHaveBeenCalledTimes(1);
    state.live = false;
    await run({ action: "resize", width: 400, height: 400 });
    expect(automation.recordEmulation).toHaveBeenCalledTimes(1);
    expect(automation.begin).toHaveBeenCalledTimes(1);
    // The revived page's guards apply.
    state.live = false;
    state.pending = { kind: "alert", message: "for you", openedAt: "now" };
    await expect(run({ action: "observe" })).rejects.toThrow("waiting for the user");
    state.pending = null;
    // A page that never came back.
    vi.mocked(context.claim).mockImplementation(() => undefined);
    state.live = false;
    await expect(run({ action: "network" })).rejects.toThrow("Browser tab closed.");
    await expect(run({ action: "observe" })).resolves.toBeDefined();
  });

  it("records an override before sending it, so a later clear still undoes it", async () => {
    const fixture = rycoFixture(() => ({ width: 390, height: 844, devicePixelRatio: 2 }));
    const send = vi.mocked(fixture.transport.send);
    const original = send.getMockImplementation()!;
    // The command took effect, then the operation was aborted (withAgentCdp's last check).
    send.mockImplementation(async (tab, method, params, signal) => {
      if (method.startsWith("Emulation.set")) throw new Error("This operation was aborted");
      return original(tab, method, params, signal);
    });
    await expect(fixture.run({ action: "resize", width: 390, height: 844 })).rejects.toThrow(
      "aborted",
    );
    expect(fixture.automation.recordEmulation).toHaveBeenCalledWith({
      viewport: { width: 390, height: 844 },
    });
    await expect(fixture.run({ action: "appearance", scheme: "dark" })).rejects.toThrow("aborted");
    expect(fixture.automation.recordEmulation).toHaveBeenLastCalledWith({ colorScheme: "dark" });
    // Going back to the system's scheme is recorded only once it was sent.
    await expect(fixture.run({ action: "appearance", scheme: "system" })).rejects.toThrow(
      "aborted",
    );
    expect(fixture.automation.recordEmulation).toHaveBeenCalledTimes(2);
  });

  it("settles a resize at the page's zoom without extra polls", async () => {
    let viewportReads = 0;
    const { run, state } = rycoFixture((expression) => {
      if (!expression.includes("innerWidth")) return true;
      viewportReads += 1;
      // 390 device-independent pixels at 150 % zoom.
      return { width: 260, height: 563, devicePixelRatio: 3 };
    });
    state.zoom = 1.5;
    await run({ action: "resize", width: 390, height: 844 });
    expect(viewportReads).toBe(1);
  });

  it("reports a reset viewport once the page no longer shows the override", async () => {
    // Chromium applies a cleared override on a later frame, like a new one.
    const reads = [
      { width: 390, height: 844, devicePixelRatio: 2 },
      { width: 390, height: 844, devicePixelRatio: 2 },
      { width: 1280, height: 850, devicePixelRatio: 2 },
    ];
    let viewportReads = 0;
    const { run, state } = rycoFixture((expression) => {
      if (!expression.includes("innerWidth")) return true;
      viewportReads += 1;
      return reads.shift() ?? { width: 1280, height: 850, devicePixelRatio: 2 };
    });
    state.emulated = { viewport: { width: 390, height: 844 } };
    expect(texts(await run({ action: "resize", reset: true }))[0].viewport.width).toBe(1280);
    expect(viewportReads).toBe(3);
    // Without a recorded override there is nothing to wait for.
    state.emulated = {};
    viewportReads = 0;
    await run({ action: "resize", reset: true });
    expect(viewportReads).toBe(1);
  });

  it("reads bounded console and network diagnostics", async () => {
    const { run, automation, methods } = rycoFixture();
    expect(texts(await run({ action: "network" }))[0].entries[0].text).toBe("limit 100");
    expect(texts(await run({ action: "console", limit: 7 }))[0].entries[0].text).toBe("limit 7");
    expect(automation.diagnostics).toHaveBeenCalledWith("network", 100, expect.any(AbortSignal));
    for (const limit of [0, 201, 1.5])
      await expect(run({ action: "console", limit })).rejects.toThrow("Invalid limit.");
    expect(methods()).toEqual([]);
  });

  it("emulates a viewport within bounds and resets it", async () => {
    const { run, sent, automation } = rycoFixture((expression) =>
      expression.includes("innerWidth") ? { width: 390, height: 844, devicePixelRatio: 2 } : true,
    );
    const value = await run({ action: "resize", width: 390, height: 844 });
    expect(sent.find(({ method }) => method.startsWith("Emulation."))).toEqual({
      method: "Emulation.setDeviceMetricsOverride",
      params: {
        width: 390,
        height: 844,
        deviceScaleFactor: 0,
        mobile: false,
        screenWidth: 390,
        screenHeight: 844,
      },
    });
    expect(automation.recordEmulation).toHaveBeenCalledWith({
      viewport: { width: 390, height: 844 },
    });
    expect(texts(value)[0]).toEqual({
      viewport: { width: 390, height: 844, devicePixelRatio: 2 },
      note: "Lasts until the user shows or resizes this tab, you reset it, control stops, or the tab is suspended to save memory.",
    });
    for (const [width, height] of [
      [319, 600],
      [3841, 600],
      [390.5, 600],
      [400, 239],
      [400, 2161],
    ])
      await expect(run({ action: "resize", width, height })).rejects.toThrow(
        /Invalid (width|height)\./,
      );
    await run({ action: "resize", reset: true });
    expect(sent.at(-2)?.method).toBe("Emulation.clearDeviceMetricsOverride");
    expect(automation.recordEmulation).toHaveBeenLastCalledWith({ viewport: null });
  });

  it("emulates the color scheme and goes back to the system's", async () => {
    const { run, sent, automation } = rycoFixture((expression) =>
      expression.includes("matchMedia"),
    );
    expect(texts(await run({ action: "appearance", scheme: "dark" }))[0]).toEqual(
      expect.objectContaining({ scheme: "dark", prefersDark: true, note: expect.any(String) }),
    );
    expect(sent.find(({ method }) => method === "Emulation.setEmulatedMedia")?.params).toEqual({
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    await run({ action: "appearance", scheme: "system" });
    expect(sent.findLast(({ method }) => method === "Emulation.setEmulatedMedia")?.params).toEqual({
      features: [{ name: "prefers-color-scheme", value: "" }],
    });
    expect(automation.recordEmulation).toHaveBeenLastCalledWith({ colorScheme: null });
    await expect(run({ action: "appearance", scheme: "sepia" })).rejects.toThrow("Invalid scheme.");
  });
});

describe("upload", () => {
  const files = ["/uploads/u-0123456789abcdef/0/a.txt"];
  const upload = { action: "upload", files, uploadId: "u-0123456789abcdef" };
  const resolved = (paths = files): ResolvedBrowserUpload => ({
    tab: "1",
    dir: "/uploads/u-0123456789abcdef",
    files: paths,
    names: paths.map((file) => file.split("/").at(-1)!),
    bytes: 12 * paths.length,
  });

  it("puts the copies into an observed file input by ref and keeps them with the page", async () => {
    const { run, sent, methods, uploads, automation } = rycoFixture(page);
    await run({ action: "observe" });
    const value = await run({ ...upload, ref: "e2" });
    expect(texts(value)).toEqual([
      { uploaded: ["a.txt"], verify: "Observe the page to verify the selection." },
    ]);
    expect(uploads.resolve).toHaveBeenCalledWith("1", "u-0123456789abcdef", files);
    expect(methods().slice(-3)).toEqual([
      "Runtime.evaluate",
      "DOM.setFileInputFiles",
      "Runtime.releaseObject",
    ]);
    const [target, setFiles, releaseObject] = sent.slice(-3);
    // The element itself, from the observed world, never a value copy.
    expect(target?.params).toMatchObject({ contextId: 1, returnByValue: false });
    expect(String(target?.params.expression)).toContain('get("e2")');
    expect(String(target?.params.expression)).toContain("el.type !== 'file'");
    expect(setFiles?.params).toEqual({ files, objectId: "input-1" });
    expect(releaseObject?.params).toEqual({ objectId: "input-1" });
    expect(uploads.retain).toHaveBeenCalledWith(resolved());
    expect(uploads.discard).not.toHaveBeenCalled();
    // A mutating action: its change handlers' dialogs are answered.
    expect(BROWSER_MUTATING_ACTIONS.has("upload")).toBe(true);
    expect(automation.begin).toHaveBeenCalledTimes(1);
  });

  it("refuses an unobserved document before it validates the copies", async () => {
    const { run, uploads, methods } = rycoFixture(page);
    await expect(run({ ...upload, ref: "e2" })).rejects.toThrow("Observe this document");
    // The desktop removes them when the request ends (settle).
    expect(uploads.resolve).not.toHaveBeenCalled();
    expect(methods()).not.toContain("DOM.setFileInputFiles");
  });

  it("drops the copies when the target is wrong or the user used the tab meanwhile", async () => {
    let target: unknown = true;
    const fixture = rycoFixture((expression, state) => {
      if (!expression.includes("not a file input")) return page(expression);
      if (target === "user") state.epoch += 1; // The user clicked while the target was checked.
      return target;
    });
    await fixture.run({ action: "observe" });
    target = new Error("not a file input");
    await expect(fixture.run({ ...upload, ref: "e2" })).rejects.toThrow(
      "That element is not an enabled file input for these files. Observe again.",
    );
    expect(fixture.uploads.discard).toHaveBeenLastCalledWith("/uploads/u-0123456789abcdef");
    target = "user";
    await expect(fixture.run({ ...upload, ref: "e2" })).rejects.toThrow("Observe it again");
    expect(fixture.uploads.discard).toHaveBeenCalledTimes(2);
    expect(fixture.methods()).not.toContain("DOM.setFileInputFiles");
    expect(fixture.methods().at(-1)).toBe("Runtime.releaseObject");
    // An epoch that changed after observe refuses before the copies are validated.
    target = true;
    await fixture.run({ action: "observe" });
    fixture.state.epoch += 1;
    await expect(fixture.run({ ...upload, ref: "e2" })).rejects.toThrow("Observe it again");
    expect(fixture.uploads.resolve).toHaveBeenCalledTimes(2);
    expect(fixture.uploads.retain).not.toHaveBeenCalled();
  });

  it("keeps the copies with the page when setting the files failed after dispatch", async () => {
    const { run, state, uploads } = rycoFixture(page);
    await run({ action: "observe" });
    state.failSetFiles = true;
    await expect(run({ ...upload, ref: "e2" })).rejects.toThrow("Browser command timed out.");
    expect(uploads.retain).toHaveBeenCalledWith(resolved());
    expect(uploads.discard).not.toHaveBeenCalled();
  });

  it("answers the file chooser the page opened in the hidden tab when no ref is given", async () => {
    const { run, state, sent, uploads, automation } = rycoFixture(page);
    const two = ["/uploads/u-0123456789abcdef/0/a.txt", "/uploads/u-0123456789abcdef/1/b.png"];
    state.chooser = { backendNodeId: 42, mode: "selectMultiple" };
    const value = await run({ ...upload, files: two });
    expect(texts(value)).toEqual([
      { uploaded: ["a.txt", "b.png"], verify: "Observe the page to verify the selection." },
    ]);
    expect(sent.at(-1)).toEqual({
      method: "DOM.setFileInputFiles",
      params: { files: two, backendNodeId: 42 },
    });
    expect(automation.takeFileChooser).toHaveBeenCalledTimes(1);
    expect(state.chooser).toBeNull();
    expect(uploads.retain).toHaveBeenCalledWith(resolved(two));
    // Only one upload answers a chooser; nothing to answer refuses before the copies are checked.
    await expect(run(upload)).rejects.toThrow(
      "Pass the file input's ref, or click its upload button first",
    );
    state.chooser = { backendNodeId: 43, mode: "selectSingle" };
    await expect(run({ ...upload, files: two })).rejects.toThrow(
      "This file chooser accepts one file.",
    );
    expect(uploads.resolve).toHaveBeenCalledTimes(1);
    expect(state.chooser).toEqual({ backendNodeId: 43, mode: "selectSingle" });
  });

  it("tells the agent once about a file chooser its click opened", async () => {
    const { run, state } = rycoFixture(page);
    await run({ action: "observe" });
    state.chooser = { backendNodeId: 42, mode: "selectSingle" };
    const clicked = await run({ action: "click", ref: "e1" });
    expect(texts(clicked)).toEqual([
      { delivered: "background", verify: "Observe the page to verify the result." },
      {
        fileChooser: { mode: "selectSingle" },
        next: "Call upload with paths and no ref to answer it.",
      },
    ]);
    expect(texts(await run({ action: "observe" }))).toHaveLength(1);
    // A chooser a page opens late is mentioned by the next read.
    state.chooser = { backendNodeId: 44, mode: "selectMultiple" };
    state.chooserReported = false;
    expect(texts(await run({ action: "observe" }))[1]).toMatchObject({
      fileChooser: { mode: "selectMultiple" },
    });
  });

  it("tells the agent when the picker its click opened cannot be answered by upload", async () => {
    const { run, automation } = rycoFixture(page);
    await run({ action: "observe" });
    automation.noteFileChooser.mockReturnValueOnce({ mode: "selectSingle", answerable: false });
    const clicked = await run({ action: "click", ref: "e1" });
    expect(texts(clicked)[1]).toEqual({
      fileChooser: { mode: "selectSingle", answerable: false },
      next: "This picker has no file input, so upload cannot answer it. Upload into an <input type=file> from observe by ref, or tell the user this site's picker is not supported.",
    });
  });

  it("is refused while the user works in the tab and without the desktop's upload directory", async () => {
    const held = rycoFixture(page);
    held.state.hold = 5_000;
    await expect(held.run({ ...upload, ref: "e2" })).rejects.toThrow(
      "The user is working in this tab.",
    );
    expect(held.context.claim).not.toHaveBeenCalled();
    const { run, state } = rycoFixture(page, { uploads: false });
    state.chooser = { backendNodeId: 42, mode: "selectSingle" };
    await expect(run(upload)).rejects.toThrow(
      "Browser upload is unavailable in this desktop session.",
    );
  });

  it("lists hidden file inputs only where upload works: the Ryco browser", async () => {
    const { run, sent } = rycoFixture(page);
    await run({ action: "observe" });
    expect(sent.find(({ method }) => method === "Runtime.evaluate")?.params.expression).toBe(
      RYCO_BROWSER_SNAPSHOT_SCRIPT,
    );
    expect(RYCO_BROWSER_SNAPSHOT_SCRIPT).toContain("(!visible(el) && !file)");
    expect(RYCO_BROWSER_SNAPSHOT_SCRIPT).toContain("type: 'file'");
    const expressions: string[] = [];
    const chrome: BrowserTransport = {
      tabs: vi.fn(async () => [{ id: "1", url: "https://example.com/", title: "Test" }]),
      open: vi.fn(),
      show: vi.fn(),
      close: vi.fn(),
      stop: vi.fn(),
      send: vi.fn(async (_tab: string, method: string, params: Record<string, unknown>) => {
        if (method === "Page.getFrameTree")
          return { frameTree: { frame: { id: "frame", loaderId: "doc" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
        expressions.push(String(params.expression));
        return { result: { value: { title: "Test", elements: [] } } };
      }),
    };
    const driver = new BrowserComputerDriver(new Map([["chrome", chrome]]));
    await driver.execute(
      {
        request: {
          sessionId: "s",
          threadId: "t",
          turnId: "u",
          tool: "browser",
          args: { action: "observe", tab: "1" },
        },
        signal: new AbortController().signal,
        check: vi.fn(),
        authorizeApp: vi.fn(),
        authorizeForeground: vi.fn(),
        claim: vi.fn(),
        activity: vi.fn(),
      },
      "chrome",
    );
    expect(expressions).toEqual([BROWSER_SNAPSHOT_SCRIPT]);
    expect(BROWSER_SNAPSHOT_SCRIPT).not.toContain("type: 'file'");
    expect(BROWSER_SNAPSHOT_SCRIPT).toContain("if (!visible(el) ||");
  });
});
