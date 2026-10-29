import type { WebContents } from "electron";
import {
  BROWSER_ELEMENT_DESCRIBE_FUNCTION,
  BROWSER_ELEMENT_PAGE_NODE_FUNCTION,
} from "@ryco/shared/browserElementPickScript";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CdpLease } from "./cdpLease.ts";
import {
  BrowserElementPicker,
  FRAME_AUTO_ATTACH,
  INSPECT_MODE_OFF,
  NO_AUTO_ATTACH,
  PICKED_HIGHLIGHT,
  PICKER_HIGHLIGHT,
  PICKING_TIMEOUT_MS,
} from "./elementPicker.ts";
import { FakeWebContents } from "../computerUse/embeddedBrowser.fixtures.ts";

type Responder = (params: Record<string, unknown>, sessionId?: string) => unknown;

const DESCRIBED = {
  // A page cannot choose the URL or title: these two are ignored.
  url: "https://evil.example/",
  pageTitle: "Spoofed",
  selector: "#save",
  tagName: "BUTTON",
  role: "button",
  name: "Save",
  text: "Save",
  box: { x: 10.4, y: 20, width: 80, height: 32 },
};

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Lets queued microtasks (the fake's command responses) run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(overrides: Record<string, Responder> = {}) {
  const contents = new FakeWebContents();
  contents.url = "https://app.example.com/users/alice%40example.com/settings?token=abc#billing";
  contents.title = "Account settings";
  const lease = new CdpLease(contents as unknown as WebContents);
  // The page's focus step (browser-groundwork registers it in createPage).
  lease.onReady((send) =>
    send("Emulation.setFocusEmulationEnabled", { enabled: true }).then(() => undefined),
  );
  const responders: Record<string, Responder> = {
    // Like Chromium: every inspect mode, "none" included, needs a highlight config.
    "Overlay.setInspectMode": (params) => {
      if (params.highlightConfig === undefined)
        throw new Error("Internal error: highlight configuration parameter is missing");
      return {};
    },
    "Page.getFrameTree": () => ({ frameTree: { frame: { id: "frame-1", loaderId: "loader-1" } } }),
    "Page.getNavigationHistory": () => ({ currentIndex: 0, entries: [{ title: contents.title }] }),
    "Page.createIsolatedWorld": () => ({ executionContextId: 7 }),
    "DOM.resolveNode": () => ({ object: { objectId: "node-object" } }),
    "Runtime.callFunctionOn": () => ({ result: { type: "object", value: DESCRIBED } }),
    // BROWSER_ELEMENT_PAGE_NODE_FUNCTION: undefined for a node of the page itself.
    pageNode: () => ({ result: { type: "undefined" } }),
    ...overrides,
  };
  const api = contents.debugger;
  api.respond = (method, params, sessionId) => {
    const isPageNode =
      method === "Runtime.callFunctionOn" &&
      (params as { functionDeclaration?: unknown }).functionDeclaration ===
        BROWSER_ELEMENT_PAGE_NODE_FUNCTION;
    return (
      responders[isPageNode ? "pageNode" : method]?.(
        params as Record<string, unknown>,
        sessionId,
      ) ?? {}
    );
  };
  const publish = vi.fn();
  const picker = new BrowserElementPicker({ publish });
  const methods = () => api.commands.map(({ method }) => method);
  /** Commands sent since `from` (an index into `api.commands`). */
  const sentSince = (from: number) => api.commands.slice(from);
  const pick = () => picker.pick("tab", lease, contents as unknown as WebContents);
  // Electron gives the page's own events an empty sessionId (the lease reports them without one).
  const inspect = (backendNodeId = 42) =>
    api.message("Overlay.inspectNodeRequested", { backendNodeId }, "");
  /** Chromium auto-attaching an out-of-process iframe (from `parent`, the page when empty). */
  const attachFrame = (session: string, frameId: string, parent = "", type = "iframe") =>
    api.message(
      "Target.attachedToTarget",
      { sessionId: session, targetInfo: { targetId: frameId, type }, waitingForDebugger: false },
      parent,
    );
  return {
    contents,
    api,
    lease,
    publish,
    picker,
    responders,
    methods,
    sentSince,
    pick,
    inspect,
    attachFrame,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("BrowserElementPicker", () => {
  it("opens the shared session and turns on Chromium's inspect mode", async () => {
    const { api, lease, picker, publish, pick } = setup();
    const result = pick();
    expect(picker.state("tab")).toBe("picking");
    await flush();
    expect(api.attach).toHaveBeenCalledWith("1.3");
    expect(lease.holds("picker")).toBe(true);
    expect(api.commands).toEqual([
      { method: "Emulation.setFocusEmulationEnabled", params: { enabled: true } },
      { method: "DOM.enable", params: {} },
      { method: "Overlay.enable", params: {} },
      {
        method: "Overlay.setInspectMode",
        params: { mode: "searchForNode", highlightConfig: PICKER_HIGHLIGHT },
      },
      // Out-of-process iframes get their own inspect mode (see the frame tests below).
      { method: "Target.setAutoAttach", params: FRAME_AUTO_ATTACH },
    ]);
    expect(picker.state("tab")).toBe("picking");
    expect(publish).toHaveBeenCalled();
    void picker.end("tab", "user");
    await expect(result).resolves.toEqual({ kind: "cancelled", reason: "user" });
  });

  it("describes the requested node in its isolated world and highlights it", async () => {
    const { api, picker, pick, inspect, sentSince } = setup();
    const result = pick();
    await flush();
    const from = api.commands.length;
    inspect();
    await expect(result).resolves.toEqual({
      kind: "picked",
      element: {
        // From the contents, sanitized: no query, hash or email segment.
        url: "https://app.example.com/users/REDACTED/settings",
        pageTitle: "Account settings",
        selector: "#save",
        tagName: "button",
        role: "button",
        name: "Save",
        text: "Save",
        box: { x: 10, y: 20, width: 80, height: 32 },
      },
    });
    expect(sentSince(from)).toEqual([
      { method: "Target.setAutoAttach", params: NO_AUTO_ATTACH },
      { method: "Overlay.setInspectMode", params: INSPECT_MODE_OFF },
      { method: "Page.getFrameTree", params: {} },
      {
        method: "Page.createIsolatedWorld",
        params: { frameId: "frame-1", worldName: "ryco-element-picker" },
      },
      { method: "DOM.resolveNode", params: { backendNodeId: 42, executionContextId: 7 } },
      // A node of the page itself (not of a same-process frame).
      {
        method: "Runtime.callFunctionOn",
        params: {
          objectId: "node-object",
          functionDeclaration: BROWSER_ELEMENT_PAGE_NODE_FUNCTION,
        },
      },
      {
        method: "Runtime.callFunctionOn",
        params: {
          objectId: "node-object",
          functionDeclaration: BROWSER_ELEMENT_DESCRIBE_FUNCTION,
          returnByValue: true,
        },
      },
      { method: "Runtime.releaseObject", params: { objectId: "node-object" } },
      { method: "Page.getNavigationHistory", params: {} },
      {
        method: "Overlay.highlightNode",
        params: { backendNodeId: 42, highlightConfig: PICKED_HIGHLIGHT },
      },
    ]);
    expect(picker.state("tab")).toBe("picked");
  });

  it("picks a same-process frame's element in the page for a node inside that frame", async () => {
    const { api, pick, inspect, sentSince } = setup({
      pageNode: () => ({ result: { type: "object", subtype: "node", objectId: "frame-object" } }),
      "DOM.describeNode": () => ({ node: { nodeId: 0, backendNodeId: 9 } }),
      "Runtime.callFunctionOn": (params) =>
        params.objectId === "frame-object"
          ? {
              result: {
                type: "object",
                value: { ...DESCRIBED, selector: "#widget", tagName: "IFRAME" },
              },
            }
          : { result: { type: "object", value: DESCRIBED } },
    });
    const result = pick();
    await flush();
    inspect(42);
    await expect(result).resolves.toMatchObject({
      kind: "picked",
      element: { selector: "#widget", tagName: "iframe" },
    });
    const from = api.commands.findIndex(({ method }) => method === "DOM.resolveNode");
    expect(sentSince(from)).toEqual([
      { method: "DOM.resolveNode", params: { backendNodeId: 42, executionContextId: 7 } },
      {
        method: "Runtime.callFunctionOn",
        params: {
          objectId: "node-object",
          functionDeclaration: BROWSER_ELEMENT_PAGE_NODE_FUNCTION,
        },
      },
      // The node inside the frame goes; the frame element is described and highlighted.
      { method: "Runtime.releaseObject", params: { objectId: "node-object" } },
      { method: "DOM.describeNode", params: { objectId: "frame-object" } },
      {
        method: "Runtime.callFunctionOn",
        params: {
          objectId: "frame-object",
          functionDeclaration: BROWSER_ELEMENT_DESCRIBE_FUNCTION,
          returnByValue: true,
        },
      },
      { method: "Runtime.releaseObject", params: { objectId: "frame-object" } },
      { method: "Page.getNavigationHistory", params: {} },
      {
        method: "Overlay.highlightNode",
        params: { backendNodeId: 9, highlightConfig: PICKED_HIGHLIGHT },
      },
    ]);
  });

  it("rejects a node inside a frame it cannot reach with the frame-or-removed message", async () => {
    const { api, pick, inspect, methods } = setup({
      pageNode: () => ({ result: { type: "object", subtype: "null", value: null } }),
    });
    const result = pick();
    await flush();
    inspect(42);
    await expect(result).rejects.toThrow(
      "This element can't be picked. It may be inside an embedded frame, or the page removed it.",
    );
    expect(api.commands.filter(({ method }) => method === "Runtime.releaseObject")).toEqual([
      { method: "Runtime.releaseObject", params: { objectId: "node-object" } },
    ]);
    expect(methods()).not.toContain("Overlay.highlightNode");
  });

  it("never returns a form field's text", async () => {
    const { pick, inspect } = setup({
      "Runtime.callFunctionOn": () => ({
        result: {
          value: {
            selector: "#name",
            tagName: "INPUT",
            role: "textbox",
            name: null,
            text: "hunter2",
          },
        },
      }),
    });
    const result = pick();
    await flush();
    inspect();
    await expect(result).resolves.toMatchObject({
      kind: "picked",
      element: { selector: "#name", tagName: "input", text: null },
    });
  });

  it("ignores a second inspectNodeRequested while describing", async () => {
    const resolveNode = deferred();
    const { methods, pick, inspect } = setup({ "DOM.resolveNode": () => resolveNode.promise });
    const result = pick();
    await flush();
    inspect(42);
    await flush();
    inspect(43);
    await flush();
    resolveNode.resolve({ object: { objectId: "node-object" } });
    await expect(result).resolves.toMatchObject({ kind: "picked" });
    expect(methods().filter((method) => method === "DOM.resolveNode")).toHaveLength(1);
    expect(methods().filter((method) => method === "Overlay.highlightNode")).toHaveLength(1);
  });

  it("ends a pick while describing without drawing a highlight afterwards", async () => {
    const resolveNode = deferred();
    const { api, lease, picker, pick, inspect, sentSince } = setup({
      "DOM.resolveNode": () => resolveNode.promise,
    });
    lease.acquire("agent"); // The agent keeps the session open, so the late answer arrives.
    const result = pick();
    await flush();
    inspect();
    await flush();
    expect(api.commands.at(-1)?.method).toBe("DOM.resolveNode");
    await picker.end("tab", "user");
    await expect(result).resolves.toEqual({ kind: "cancelled", reason: "user" });
    const from = api.commands.length;
    resolveNode.resolve({ object: { objectId: "late-object" } });
    await flush();
    // The late object is released; nothing else reaches the session the agent now uses.
    expect(sentSince(from)).toEqual([
      { method: "Runtime.releaseObject", params: { objectId: "late-object" } },
    ]);
    expect(picker.state("tab")).toBeUndefined();
    expect(lease.holds("picker")).toBe(false);
  });

  it("ends a pick while starting without turning inspect mode on", async () => {
    const enable = deferred();
    const { api, lease, picker, pick, methods } = setup({ "DOM.enable": () => enable.promise });
    lease.acquire("agent");
    const result = pick();
    await flush();
    expect(methods().at(-1)).toBe("DOM.enable");
    await picker.end("tab", "agent");
    await expect(result).resolves.toEqual({ kind: "cancelled", reason: "agent" });
    enable.resolve({});
    await flush();
    expect(methods()).not.toContain("Overlay.enable");
    expect(
      api.commands.some(
        ({ method, params }) =>
          method === "Overlay.setInspectMode" &&
          (params as { mode?: string }).mode === "searchForNode",
      ),
    ).toBe(false);
  });

  it("keeps the cleanup behind an enable that still waits for the session's ready steps", async () => {
    const focus = deferred();
    const { api, lease, picker, pick, methods } = setup({
      "Emulation.setFocusEmulationEnabled": () => focus.promise,
    });
    lease.acquire("agent");
    const result = pick();
    await flush();
    expect(methods()).toEqual(["Emulation.setFocusEmulationEnabled"]);
    const ended = picker.end("tab", "user");
    await expect(result).resolves.toEqual({ kind: "cancelled", reason: "user" });
    focus.resolve({});
    await ended;
    // DOM.enable was already queued; the disables follow it, and inspect mode never started.
    expect(methods()).toEqual([
      "Emulation.setFocusEmulationEnabled",
      "DOM.enable",
      "Overlay.setInspectMode",
      "Overlay.hideHighlight",
      "Overlay.disable",
      "DOM.disable",
    ]);
    expect(api.commands[2]?.params).toEqual(INSPECT_MODE_OFF);
    expect(api.isAttached()).toBe(true);
  });

  it("creates the isolated world once per document and recreates a lost context once", async () => {
    let resolveCalls = 0;
    const { methods, pick, inspect } = setup({
      "DOM.resolveNode": () => {
        resolveCalls += 1;
        // What Blink's DOM.resolveNode answers for an executionContextId whose context is gone.
        if (resolveCalls === 2)
          throw new Error("Node with given id does not belong to the document");
        return { object: { objectId: `node-${resolveCalls}` } };
      },
    });
    const first = pick();
    await flush();
    inspect();
    await expect(first).resolves.toMatchObject({ kind: "picked" });
    expect(methods().filter((method) => method === "Page.createIsolatedWorld")).toHaveLength(1);
    // Same document: the cached world is used; its context is gone, so it is recreated once.
    const second = pick();
    await flush();
    inspect();
    await expect(second).resolves.toMatchObject({ kind: "picked" });
    expect(methods().filter((method) => method === "Page.createIsolatedWorld")).toHaveLength(2);
    expect(methods().filter((method) => method === "DOM.resolveNode")).toHaveLength(3);
    // A third pick on the same document reuses the recreated world.
    const third = pick();
    await flush();
    inspect();
    await expect(third).resolves.toMatchObject({ kind: "picked" });
    expect(methods().filter((method) => method === "Page.createIsolatedWorld")).toHaveLength(2);
  });

  it("creates a new world for a new document", async () => {
    let loaderId = "loader-1";
    const { methods, pick, inspect } = setup({
      "Page.getFrameTree": () => ({ frameTree: { frame: { id: "frame-1", loaderId } } }),
    });
    const first = pick();
    await flush();
    inspect();
    await first;
    loaderId = "loader-2";
    const second = pick();
    await flush();
    inspect();
    await second;
    expect(methods().filter((method) => method === "Page.createIsolatedWorld")).toHaveLength(2);
  });

  it("does not recreate a cached world for a node that is gone", async () => {
    let resolveCalls = 0;
    const { methods, pick, inspect } = setup({
      "DOM.resolveNode": () => {
        resolveCalls += 1;
        if (resolveCalls === 2) throw new Error("No node with given id found");
        return { object: { objectId: `node-${resolveCalls}` } };
      },
    });
    const first = pick();
    await flush();
    inspect();
    await first;
    const second = pick();
    await flush();
    inspect();
    await expect(second).rejects.toThrow(
      "It may be inside an embedded frame, or the page removed it.",
    );
    expect(methods().filter((method) => method === "Page.createIsolatedWorld")).toHaveLength(1);
  });

  it("creates no isolated world once the pick ended while the frame tree was asked for", async () => {
    const tree = deferred();
    const { lease, picker, pick, inspect, methods } = setup({
      "Page.getFrameTree": () => tree.promise,
    });
    lease.acquire("agent"); // The agent keeps the session open, so the late answer arrives.
    const result = pick();
    await flush();
    inspect();
    await flush();
    expect(methods().at(-1)).toBe("Page.getFrameTree");
    await picker.end("tab", "agent");
    await expect(result).resolves.toEqual({ kind: "cancelled", reason: "agent" });
    tree.resolve({ frameTree: { frame: { id: "frame-1", loaderId: "loader-1" } } });
    await flush();
    expect(methods()).not.toContain("Page.createIsolatedWorld");
    expect(methods()).not.toContain("DOM.resolveNode");
  });

  it("keeps a described element when the cosmetic highlight fails", async () => {
    const { picker, pick, inspect } = setup({
      "Overlay.highlightNode": () => {
        throw new Error("No node with given id found");
      },
    });
    const result = pick();
    await flush();
    inspect();
    await expect(result).resolves.toMatchObject({
      kind: "picked",
      element: { selector: "#save", tagName: "button" },
    });
    expect(picker.state("tab")).toBe("picked");
  });

  it("takes the page's own title, never Chromium's URL stand-in for an untitled page", async () => {
    const { contents, pick, inspect } = setup({
      "Page.getNavigationHistory": () => ({
        currentIndex: 1,
        entries: [{ title: "Home" }, { title: "" }],
      }),
    });
    contents.url = "http://localhost:3000/users/42/reset?token=abc#x";
    // What webContents.getTitle() returns for a page without a <title>.
    contents.title = "localhost:3000/users/42/reset?token=abc#x";
    const result = pick();
    await flush();
    inspect();
    await expect(result).resolves.toMatchObject({
      kind: "picked",
      element: { url: "http://localhost:3000/users/REDACTED/reset", pageTitle: "" },
    });
  });

  it("keeps the pick with an empty title when the title cannot be read", async () => {
    const { pick, inspect } = setup({
      "Page.getNavigationHistory": () => {
        throw new Error("Not attached to an active page");
      },
    });
    const result = pick();
    await flush();
    inspect();
    await expect(result).resolves.toMatchObject({
      kind: "picked",
      element: { selector: "#save", pageTitle: "" },
    });
  });

  it("cleans up in order and detaches when the picker held the session alone", async () => {
    const { api, lease, picker, publish, pick, sentSince } = setup();
    const result = pick();
    await flush();
    const from = api.commands.length;
    publish.mockClear();
    const ended = picker.end("tab", "user");
    // The pick settles and the state changes at once; the cleanup follows.
    expect(picker.state("tab")).toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(1);
    await expect(result).resolves.toEqual({ kind: "cancelled", reason: "user" });
    await ended;
    expect(sentSince(from)).toEqual([
      { method: "Target.setAutoAttach", params: NO_AUTO_ATTACH },
      { method: "Overlay.setInspectMode", params: INSPECT_MODE_OFF },
      { method: "Overlay.hideHighlight", params: {} },
      { method: "Overlay.disable", params: {} },
      { method: "DOM.disable", params: {} },
    ]);
    expect(lease.isAttached()).toBe(false);
    expect(api.isAttached()).toBe(false);
    await expect(picker.end("tab", "user")).resolves.toBeUndefined();
  });

  it("skips the inspect-mode command when the element was already picked", async () => {
    const { api, lease, picker, pick, inspect, sentSince } = setup();
    lease.acquire("agent");
    const result = pick();
    await flush();
    inspect();
    await result;
    const from = api.commands.length;
    await picker.end("tab", "user");
    expect(sentSince(from).map(({ method }) => method)).toEqual([
      "Overlay.hideHighlight",
      "Overlay.disable",
      "DOM.disable",
    ]);
    // The agent's hold keeps the session.
    expect(api.isAttached()).toBe(true);
    expect(lease.holds("picker")).toBe(false);
  });

  it("lets every caller of end() wait for a cleanup still running", async () => {
    const disable = deferred();
    const { picker, pick } = setup({ "DOM.disable": () => disable.promise });
    void pick();
    await flush();
    let firstDone = false;
    let secondDone = false;
    void picker.end("tab", "user").then(() => (firstDone = true));
    void picker.end("tab", "agent").then(() => (secondDone = true));
    await flush();
    expect([firstDone, secondDone]).toEqual([false, false]);
    disable.resolve({});
    await flush();
    expect([firstDone, secondDone]).toEqual([true, true]);
  });

  it("gives up on a hung cleanup command after 2 s and releases", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { api, lease, picker, pick } = setup({ "Overlay.disable": () => new Promise(() => {}) });
    void pick();
    await flush();
    const ended = picker.end("tab", "user");
    await vi.advanceTimersByTimeAsync(2_000);
    await ended;
    expect(lease.isAttached()).toBe(false);
    expect(api.isAttached()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends on a detach, on Chromium's inspect-mode cancel, and ignores child-session events", async () => {
    const detached = setup();
    const first = detached.pick();
    await flush();
    const from = detached.api.commands.length;
    detached.api.externalDetach("canceled_by_user");
    await expect(first).resolves.toEqual({ kind: "cancelled", reason: "detached" });
    // Nothing to clean up on a session that is gone.
    expect(detached.sentSince(from)).toEqual([]);
    expect(detached.picker.state("tab")).toBeUndefined();

    const cancelled = setup();
    const second = cancelled.pick();
    await flush();
    cancelled.api.message("Overlay.inspectNodeRequested", { backendNodeId: 1 }, "child-session");
    await flush();
    expect(cancelled.picker.state("tab")).toBe("picking");
    expect(cancelled.methods()).not.toContain("DOM.resolveNode");
    cancelled.api.message("Overlay.inspectModeCanceled");
    await expect(second).resolves.toEqual({ kind: "cancelled", reason: "user" });
  });

  it("settles a pending pick with the reason it ended", async () => {
    for (const reason of ["navigation", "hidden", "destroyed"] as const) {
      const { picker, pick } = setup();
      const result = pick();
      await flush();
      void picker.end("tab", reason);
      await expect(result).resolves.toEqual({ kind: "cancelled", reason });
    }
  });

  it("resolves the previous pick as replaced and keeps its session for the next one", async () => {
    const { api, lease, picker, pick, inspect, sentSince } = setup();
    const first = pick();
    await flush();
    inspect();
    await expect(first).resolves.toMatchObject({ kind: "picked" });
    const from = api.commands.length;
    const second = pick();
    expect(picker.state("tab")).toBe("picking");
    await flush();
    // No detach and attach again: the highlight goes and inspect mode comes back on the same session.
    expect(api.attach).toHaveBeenCalledTimes(1);
    expect(api.detach).not.toHaveBeenCalled();
    expect(lease.holds("picker")).toBe(true);
    expect(sentSince(from)).toEqual([
      { method: "Overlay.hideHighlight", params: {} },
      { method: "DOM.enable", params: {} },
      { method: "Overlay.enable", params: {} },
      {
        method: "Overlay.setInspectMode",
        params: { mode: "searchForNode", highlightConfig: PICKER_HIGHLIGHT },
      },
      { method: "Target.setAutoAttach", params: FRAME_AUTO_ATTACH },
    ]);
    // A third pick replaces a pick that is still choosing.
    const third = pick();
    await expect(second).resolves.toEqual({ kind: "cancelled", reason: "replaced" });
    await flush();
    expect(api.attach).toHaveBeenCalledTimes(1);
    expect(picker.state("tab")).toBe("picking");
    await picker.end("tab", "user");
    await expect(third).resolves.toEqual({ kind: "cancelled", reason: "user" });
    expect(api.isAttached()).toBe(false);
  });

  it("waits for a running cleanup before a new pick, and lets an end() meanwhile cancel it", async () => {
    for (const reason of ["user", "navigation", "agent"] as const) {
      const disable = deferred();
      const { api, picker, publish, pick, methods } = setup({
        "DOM.disable": () => disable.promise,
      });
      void pick();
      await flush();
      void picker.end("tab", "user");
      await flush();
      publish.mockClear();
      const waiting = pick();
      // The user sees the new pick at once (Escape and "Cancel picking" work while it waits).
      expect(picker.state("tab")).toBe("picking");
      expect(publish).toHaveBeenCalled();
      void picker.end("tab", reason);
      const enables = methods().filter((method) => method === "DOM.enable").length;
      disable.resolve({});
      await expect(waiting).resolves.toEqual({ kind: "cancelled", reason });
      await flush();
      expect(picker.state("tab")).toBeUndefined();
      // The cancelled pick never opened: no new session, no inspect mode.
      expect(methods().filter((method) => method === "DOM.enable")).toHaveLength(enables);
      expect(api.isAttached()).toBe(false);
    }
  });

  it("resolves a pick still waiting for a cleanup as replaced when another pick starts", async () => {
    const disable = deferred();
    const { picker, pick } = setup({ "DOM.disable": () => disable.promise });
    void pick();
    await flush();
    void picker.end("tab", "user");
    const waiting = pick();
    const latest = pick();
    disable.resolve({});
    await expect(waiting).resolves.toEqual({ kind: "cancelled", reason: "replaced" });
    await flush();
    expect(picker.state("tab")).toBe("picking");
    await picker.end("tab", "user");
    await expect(latest).resolves.toEqual({ kind: "cancelled", reason: "user" });
  });

  it("refuses a pick that admit() rejects after an earlier cleanup", async () => {
    const disable = deferred();
    const { contents, lease, picker, publish, pick } = setup({
      "DOM.disable": () => disable.promise,
    });
    void pick();
    await flush();
    void picker.end("tab", "user");
    const refused = picker.pick("tab", lease, contents as unknown as WebContents, () => {
      throw new Error("Browser tab closed.");
    });
    expect(picker.state("tab")).toBe("picking");
    publish.mockClear();
    disable.resolve({});
    await expect(refused).rejects.toThrow("Browser tab closed.");
    expect(picker.state("tab")).toBeUndefined();
    expect(publish).toHaveBeenCalled();
    expect(lease.isAttached()).toBe(false);
  });

  it("keeps the current pick when admit() refuses its replacement", async () => {
    const { contents, lease, picker, pick } = setup();
    const current = pick();
    await flush();
    await expect(
      picker.pick("tab", lease, contents as unknown as WebContents, () => {
        throw new Error("Browser tab closed.");
      }),
    ).rejects.toThrow("Browser tab closed.");
    expect(picker.state("tab")).toBe("picking");
    await picker.end("tab", "user");
    await expect(current).resolves.toEqual({ kind: "cancelled", reason: "user" });
  });

  it("waits for the previous cleanup when the page's session changed", async () => {
    const { lease, picker, pick, api } = setup();
    const first = pick();
    await flush();
    const other = new FakeWebContents();
    other.url = "https://app.example.com/";
    const otherLease = new CdpLease(other as unknown as WebContents);
    const second = picker.pick("tab", otherLease, other as unknown as WebContents);
    await expect(first).resolves.toEqual({ kind: "cancelled", reason: "replaced" });
    await flush();
    // The old page's session was turned off and released before the new one opened.
    expect(lease.isAttached()).toBe(false);
    expect(api.isAttached()).toBe(false);
    expect(otherLease.holds("picker")).toBe(true);
    expect(picker.state("tab")).toBe("picking");
    await picker.end("tab", "user");
    await expect(second).resolves.toEqual({ kind: "cancelled", reason: "user" });
  });

  it("rejects when the node cannot be resolved", async () => {
    const { lease, picker, pick, inspect, methods } = setup({
      "DOM.resolveNode": () => {
        throw new Error("Node with given id does not belong to the document");
      },
    });
    const result = pick();
    await flush();
    inspect();
    await expect(result).rejects.toThrow(
      "This element can't be picked. It may be inside an embedded frame, or the page removed it.",
    );
    expect(picker.state("tab")).toBeUndefined();
    await flush();
    expect(lease.isAttached()).toBe(false);
    expect(methods()).not.toContain("Runtime.callFunctionOn");
  });

  it.each([
    ["a null description", { result: { value: null } }],
    ["a description without a selector", { result: { value: { ...DESCRIBED, selector: "" } } }],
    ["an exception", { exceptionDetails: { text: "boom" }, result: {} }],
  ])("rejects %s with the can't-be-picked message", async (_label, response) => {
    const { pick, inspect, methods } = setup({ "Runtime.callFunctionOn": () => response });
    const result = pick();
    await flush();
    inspect();
    await expect(result).rejects.toThrow("This element can't be picked. Try one next to it.");
    expect(methods()).toContain("Runtime.releaseObject");
    expect(methods()).not.toContain("Overlay.highlightNode");
  });

  it("rejects a pick whose page URL is not http(s)", async () => {
    const { contents, pick, inspect } = setup();
    contents.url = "about:blank";
    const result = pick();
    await flush();
    inspect();
    await expect(result).rejects.toThrow("This element can't be picked. Try one next to it.");
  });

  it("rejects when inspect mode cannot start", async () => {
    const { lease, picker, pick } = setup({
      "Overlay.enable": () => {
        throw new Error("DOM should be enabled first");
      },
    });
    await expect(pick()).rejects.toThrow("Couldn't start picking on this page.");
    expect(picker.state("tab")).toBeUndefined();
    await flush();
    expect(lease.isAttached()).toBe(false);
  });

  it("ends a pick that found no element after 120 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { picker, pick } = setup();
    const result = pick();
    await flush();
    await vi.advanceTimersByTimeAsync(PICKING_TIMEOUT_MS - 1);
    expect(picker.state("tab")).toBe("picking");
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ kind: "cancelled", reason: "timeout" });
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a picked element past the picking cap", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { picker, pick, inspect } = setup();
    const result = pick();
    await flush();
    inspect();
    await result;
    await vi.advanceTimersByTimeAsync(PICKING_TIMEOUT_MS * 2);
    expect(picker.state("tab")).toBe("picked");
  });

  it("dispose() ends every pick as destroyed", async () => {
    const { picker, pick } = setup();
    const result = pick();
    await flush();
    picker.dispose();
    await expect(result).resolves.toEqual({ kind: "cancelled", reason: "destroyed" });
  });

  describe("out-of-process iframes", () => {
    const IFRAME = {
      ...DESCRIBED,
      selector: "#checkout",
      tagName: "IFRAME",
      role: null,
      name: "Payment",
      text: null,
    };
    function frameSetup() {
      const context = setup({
        "Runtime.callFunctionOn": () => ({ result: { value: IFRAME } }),
        "DOM.getFrameOwner": ({ frameId }) => {
          if (frameId !== "FRAME-B") throw new Error("Frame with the given id was not found.");
          return { backendNodeId: 77 };
        },
      });
      const forSession = (session: string) =>
        context.api.commands
          .filter(({ sessionId }) => sessionId === session)
          .map(({ method, params }) => ({ method, params }));
      return { ...context, forSession };
    }
    const ARMED = [
      { method: "DOM.enable", params: {} },
      { method: "Overlay.enable", params: {} },
      {
        method: "Overlay.setInspectMode",
        params: { mode: "searchForNode", highlightConfig: PICKER_HIGHLIGHT },
      },
      { method: "Target.setAutoAttach", params: FRAME_AUTO_ATTACH },
    ];

    it("gives an attached frame its own inspect mode and picks its element in the page", async () => {
      const { api, picker, pick, attachFrame, forSession, sentSince } = frameSetup();
      const result = pick();
      await flush();
      attachFrame("frame-b", "FRAME-B");
      await flush();
      expect(forSession("frame-b")).toEqual(ARMED);
      const from = api.commands.length;
      // The click inside the frame reaches the frame's inspect tool, not the page.
      api.message("Overlay.inspectNodeRequested", { backendNodeId: 5 }, "frame-b");
      await expect(result).resolves.toEqual({
        kind: "picked",
        element: expect.objectContaining({ selector: "#checkout", tagName: "iframe" }),
      });
      expect(sentSince(from)).toEqual([
        { method: "Target.setAutoAttach", params: NO_AUTO_ATTACH },
        { method: "Target.detachFromTarget", params: { sessionId: "frame-b" } },
        { method: "Overlay.setInspectMode", params: INSPECT_MODE_OFF },
        { method: "DOM.getFrameOwner", params: { frameId: "FRAME-B" } },
        { method: "Page.getFrameTree", params: {} },
        {
          method: "Page.createIsolatedWorld",
          params: { frameId: "frame-1", worldName: "ryco-element-picker" },
        },
        { method: "DOM.resolveNode", params: { backendNodeId: 77, executionContextId: 7 } },
        {
          method: "Runtime.callFunctionOn",
          params: {
            objectId: "node-object",
            functionDeclaration: BROWSER_ELEMENT_PAGE_NODE_FUNCTION,
          },
        },
        {
          method: "Runtime.callFunctionOn",
          params: {
            objectId: "node-object",
            functionDeclaration: BROWSER_ELEMENT_DESCRIBE_FUNCTION,
            returnByValue: true,
          },
        },
        { method: "Runtime.releaseObject", params: { objectId: "node-object" } },
        { method: "Page.getNavigationHistory", params: {} },
        {
          method: "Overlay.highlightNode",
          params: { backendNodeId: 77, highlightConfig: PICKED_HIGHLIGHT },
        },
      ]);
      expect(picker.state("tab")).toBe("picked");
      // The frame is let go once the user chose; a late event of it is ignored.
      api.message("Overlay.inspectNodeRequested", { backendNodeId: 6 }, "frame-b");
      await flush();
      expect(api.commands.filter(({ method }) => method === "DOM.getFrameOwner")).toHaveLength(1);
    });

    it("picks the outermost frame for a click in a nested one", async () => {
      const { api, pick, attachFrame, forSession, methods } = frameSetup();
      const result = pick();
      await flush();
      attachFrame("frame-b", "FRAME-B");
      await flush();
      attachFrame("frame-c", "FRAME-C", "frame-b");
      await flush();
      expect(forSession("frame-c")).toEqual(ARMED);
      api.message("Overlay.inspectNodeRequested", { backendNodeId: 9 }, "frame-c");
      await expect(result).resolves.toMatchObject({ kind: "picked" });
      expect(
        api.commands
          .filter(({ method }) => method === "DOM.getFrameOwner")
          .map(({ params }) => params),
      ).toEqual([{ frameId: "FRAME-B" }]);
      expect(
        api.commands
          .filter(({ method }) => method === "Target.detachFromTarget")
          .map(({ params }) => params),
      ).toEqual([{ sessionId: "frame-b" }, { sessionId: "frame-c" }]);
      expect(methods()).toContain("Overlay.highlightNode");
    });

    it("lets go of targets that are not frames, frames attached after the choice, and unknown sessions", async () => {
      const { api, pick, inspect, attachFrame, forSession } = frameSetup();
      const result = pick();
      await flush();
      attachFrame("worker", "WORKER", undefined, "worker");
      // A target attached by a session this pick does not know.
      attachFrame("stray", "FRAME-X", "someone-else");
      await flush();
      expect(forSession("worker")).toEqual([]);
      expect(api.commands.filter(({ method }) => method === "Target.detachFromTarget")).toEqual([
        { method: "Target.detachFromTarget", params: { sessionId: "worker" } },
      ]);
      inspect();
      await result;
      attachFrame("late", "FRAME-L");
      await flush();
      expect(forSession("late")).toEqual([]);
      expect(api.commands.at(-1)).toEqual({
        method: "Target.detachFromTarget",
        params: { sessionId: "late" },
      });
    });

    it("lets go of its frames and turns auto-attach off when the pick ends", async () => {
      const { api, lease, picker, pick, attachFrame, sentSince } = frameSetup();
      lease.acquire("agent"); // Another holder keeps the session, so the frames must be let go.
      const result = pick();
      await flush();
      attachFrame("frame-b", "FRAME-B");
      await flush();
      const from = api.commands.length;
      await picker.end("tab", "user");
      await expect(result).resolves.toEqual({ kind: "cancelled", reason: "user" });
      expect(sentSince(from)).toEqual([
        { method: "Target.setAutoAttach", params: NO_AUTO_ATTACH },
        { method: "Target.detachFromTarget", params: { sessionId: "frame-b" } },
        { method: "Overlay.setInspectMode", params: INSPECT_MODE_OFF },
        { method: "Overlay.hideHighlight", params: {} },
        { method: "Overlay.disable", params: {} },
        { method: "DOM.disable", params: {} },
      ]);
      expect(api.isAttached()).toBe(true);
    });

    it("forgets a detached frame and ends on a frame's inspect-mode cancel", async () => {
      const { api, pick, attachFrame, methods } = frameSetup();
      const result = pick();
      await flush();
      attachFrame("frame-b", "FRAME-B");
      attachFrame("frame-d", "FRAME-D");
      await flush();
      api.message("Target.detachedFromTarget", { sessionId: "frame-b" });
      // A detached frame's late click is not a pick.
      api.message("Overlay.inspectNodeRequested", { backendNodeId: 5 }, "frame-b");
      await flush();
      expect(methods()).not.toContain("DOM.getFrameOwner");
      api.message("Overlay.inspectModeCanceled", {}, "frame-d");
      await expect(result).resolves.toEqual({ kind: "cancelled", reason: "user" });
      expect(api.commands.filter(({ method }) => method === "Target.detachFromTarget")).toEqual([
        { method: "Target.detachFromTarget", params: { sessionId: "frame-d" } },
      ]);
    });

    it("keeps picking when auto-attach or arming a frame fails", async () => {
      const failing = frameSetup();
      failing.responders["Target.setAutoAttach"] = () => {
        throw new Error("Not allowed");
      };
      failing.responders["Overlay.enable"] = (_params, sessionId) => {
        if (sessionId) throw new Error("DOM should be enabled first");
        return {};
      };
      const result = failing.pick();
      await flush();
      expect(failing.picker.state("tab")).toBe("picking");
      failing.attachFrame("frame-b", "FRAME-B");
      await flush();
      expect(failing.forSession("frame-b").map(({ method }) => method)).toEqual([
        "DOM.enable",
        "Overlay.enable",
      ]);
      failing.inspect();
      await expect(result).resolves.toMatchObject({ kind: "picked" });
    });

    it("rejects a click in a frame whose element cannot be found", async () => {
      const { api, pick, attachFrame } = frameSetup();
      const result = pick();
      await flush();
      attachFrame("frame-z", "FRAME-Z");
      await flush();
      api.message("Overlay.inspectNodeRequested", { backendNodeId: 5 }, "frame-z");
      await expect(result).rejects.toThrow(
        "This element can't be picked. It may be inside an embedded frame, or the page removed it.",
      );
    });
  });
});
