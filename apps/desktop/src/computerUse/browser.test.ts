import { expect, it, vi } from "vitest";
import {
  BrowserComputerDriver,
  REVIVED_TAB_ERROR,
  REVIVED_TAB_NOTE,
  type BrowserTabRevival,
  type BrowserTransport,
} from "./browser.ts";
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
