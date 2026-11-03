import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { CdpLease } from "../browser/cdpLease.ts";

vi.mock("electron", async () => (await import("./embeddedBrowser.fixtures.ts")).fakeElectronModule);
import {
  fakeElectronState,
  fakeEvent,
  fakeOwnerWindow,
  fakeSession,
  fakeTab,
  resetFakeElectron,
} from "./embeddedBrowser.fixtures.ts";
import { EmbeddedComputerBrowser } from "./embeddedBrowser.ts";
import {
  BROWSER_IDLE_SUSPEND_MS,
  BROWSER_LIVE_TAB_LIMIT,
  BROWSER_PREVIEW_HOLD_MS,
  BROWSER_REVIVE_WAIT_MS,
  BROWSER_TAB_LIMIT,
} from "./browserTabBudget.ts";
import { BrowserComputerDriver } from "./browser.ts";
import { INSPECT_MODE_OFF, NO_AUTO_ATTACH } from "../browser/elementPicker.ts";
import { BROWSER_ELEMENT_PAGE_NODE_FUNCTION } from "@ryco/shared/browserElementPickScript";
import { COMPUTER_TARGET_CLAIM_MS, type ComputerOperationContext } from "./policy.ts";

const browsers: EmbeddedComputerBrowser[] = [];
function newBrowser(): EmbeddedComputerBrowser {
  const browser = new EmbeddedComputerBrowser();
  browsers.push(browser);
  return browser;
}
const signal = () => new AbortController().signal;
/**
 * Every session's ready steps: groundwork's focus emulation, then browser-agent-control's domains
 * with browser-agent-upload's file chooser interception right after Page.enable.
 */
const READY = [
  "Emulation.setFocusEmulationEnabled",
  "Page.enable",
  "Page.setInterceptFileChooserDialog",
  "Network.enable",
  "Runtime.enable",
  "Log.enable",
] as const;
/** Lets queued microtasks (the fake's command responses) run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
interface PageInternals {
  readonly cdp: CdpLease;
}
interface EntryInternals {
  live: PageInternals | null;
  agentBusy: number;
}
/** The browser's private tab state and page lifecycle, which the sibling units build on. */
function internals(browser: EmbeddedComputerBrowser) {
  return browser as unknown as {
    entries: Map<string, EntryInternals>;
    createPage(entry: EntryInternals, existingId?: string): { id: string; page: PageInternals };
    teardownPage(id: string, page: PageInternals): void;
  };
}
/** Agent calls in flight on a tab (private; read by browser-picker and browser-tab-budget). */
function agentBusy(browser: EmbeddedComputerBrowser, tab: string): number | undefined {
  return internals(browser).entries.get(tab)?.agentBusy;
}

beforeEach(resetFakeElectron);
afterEach(() => {
  for (const browser of browsers.splice(0)) browser.dispose();
  vi.useRealTimers();
});

it("does not initialize browser storage when starting or reading an unused browser", async () => {
  const browser = newBrowser();
  expect(browser.state().tabs).toEqual([]);
  await expect(browser.tabs(signal())).resolves.toEqual([]);
  browser.dispose();
  expect(fakeElectronState.fromPartition).not.toHaveBeenCalled();
});

it("opens each tab in its own hidden host with today's isolation settings", async () => {
  const browser = newBrowser();
  const first = await browser.open("https://example.com/", false, signal(), "project");
  const second = await browser.open("https://example.org/", false, signal(), "project");
  for (const [tab, url] of [
    [first, "https://example.com/"],
    [second, "https://example.org/"],
  ] as const) {
    const { view, contents, host } = fakeTab(tab.id);
    expect(tab).toEqual({ id: String(contents.id), title: "", url });
    expect(view.options.webPreferences).toEqual({
      session: fakeSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // A user's hidden tab is throttled in the background (browser-tab-budget).
      backgroundThrottling: true,
      focusOnNavigation: false,
    });
    expect(host.options).toEqual({
      width: 1280,
      height: 850,
      show: false,
      title: "Ryco Browser",
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    expect(host.isVisible()).toBe(false);
    expect(host.contentView.children).toEqual([view]);
    expect(view.getBounds()).toEqual({ x: 0, y: 0, width: 1280, height: 850 });
    expect(contents.loadURL).toHaveBeenCalledWith(url);
  }
  expect(fakeTab(first.id).host).not.toBe(fakeTab(second.id).host);
  expect(fakeElectronState.fromPartition).toHaveBeenCalledTimes(1);
  expect(fakeElectronState.fromPartition).toHaveBeenCalledWith("persist:ryco-computer-browser");
  expect(browser.state().tabs.map(({ id, presentation }) => ({ id, presentation }))).toEqual([
    { id: first.id, presentation: "background" },
    { id: second.id, presentation: "background" },
  ]);
});

describe("agent CDP", () => {
  it("attaches once per session and enables focus emulation once, before the first command", async () => {
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    const { debugger: api } = fakeTab(tab.id).contents;
    await expect(browser.send(tab.id, "Page.getFrameTree", {}, signal())).resolves.toEqual({});
    await browser.send(tab.id, "Runtime.evaluate", { expression: "1" }, signal());
    expect(api.attach).toHaveBeenCalledTimes(1);
    expect(api.attach).toHaveBeenCalledWith("1.3");
    expect(api.commands).toEqual([
      { method: "Emulation.setFocusEmulationEnabled", params: { enabled: true } },
      { method: "Page.enable", params: {} },
      // A background tab: its file choosers wait for the agent.
      { method: "Page.setInterceptFileChooserDialog", params: { enabled: true } },
      {
        method: "Network.enable",
        params: {
          maxTotalBufferSize: 1_048_576,
          maxResourceBufferSize: 262_144,
          maxPostDataSize: 0,
        },
      },
      { method: "Runtime.enable", params: {} },
      { method: "Log.enable", params: {} },
      { method: "Page.getFrameTree", params: {} },
      { method: "Runtime.evaluate", params: { expression: "1" } },
    ]);
    expect(api.isAttached()).toBe(true);
  });

  it("detaches when the command that attached fails, and the next command starts a fresh session with focus emulation again", async () => {
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    const { debugger: api } = fakeTab(tab.id).contents;
    let failing = "Page.navigate";
    api.respond = (method) => {
      if (method === failing) throw new Error(`${method} failed`);
      return {};
    };
    await expect(browser.send(tab.id, "Page.navigate", {}, signal())).rejects.toThrow(
      "Page.navigate failed",
    );
    expect(api.detach).toHaveBeenCalledTimes(1);
    expect(api.isAttached()).toBe(false);
    await browser.send(tab.id, "Page.reload", {}, signal());
    expect(api.attach).toHaveBeenCalledTimes(2);
    // A failing command on a session the agent already held keeps it.
    failing = "Runtime.evaluate";
    await expect(browser.send(tab.id, "Runtime.evaluate", {}, signal())).rejects.toThrow(
      "Runtime.evaluate failed",
    );
    expect(api.isAttached()).toBe(true);
    expect(api.detach).toHaveBeenCalledTimes(1);
    expect(api.commands.map(({ method }) => method)).toEqual([
      ...READY,
      "Page.navigate",
      ...READY,
      "Page.reload",
      "Runtime.evaluate",
    ]);
  });

  it("fails the command and detaches when focus emulation fails", async () => {
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    const { debugger: api } = fakeTab(tab.id).contents;
    api.respond = (method) => {
      if (method === "Emulation.setFocusEmulationEnabled") throw new Error("emulation failed");
      return {};
    };
    await expect(browser.send(tab.id, "Page.reload", {}, signal())).rejects.toThrow(
      "emulation failed",
    );
    expect(api.isAttached()).toBe(false);
    expect(api.commands.map(({ method }) => method)).toEqual([
      "Emulation.setFocusEmulationEnabled",
    ]);
  });

  it.each(["abort", "timeout"] as const)(
    "an aborted or timed-out command ends the session (%s)",
    async (kind) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const browser = newBrowser();
      const tab = await browser.open("https://example.com/", false, signal(), "project");
      const { debugger: api } = fakeTab(tab.id).contents;
      api.respond = (method) => (method === "Runtime.evaluate" ? new Promise(() => {}) : {});
      const controller = new AbortController();
      const pending = browser.send(tab.id, "Runtime.evaluate", {}, controller.signal);
      const settled = expect(pending).rejects.toThrow(
        kind === "abort" ? "target closed while handling command" : "Browser command timed out.",
      );
      await flush();
      expect(api.commands.at(-1)?.method).toBe("Runtime.evaluate");
      if (kind === "abort") controller.abort();
      else await vi.advanceTimersByTimeAsync(15_000);
      await settled;
      expect(api.isAttached()).toBe(false);
      expect(api.detach).toHaveBeenCalledTimes(1);
      await browser.send(tab.id, "Page.reload", {}, signal());
      expect(api.attach).toHaveBeenCalledTimes(2);
      expect(api.commands.slice(-READY.length - 1).map(({ method }) => method)).toEqual([
        ...READY,
        "Page.reload",
      ]);
      // The memory budget's timer and the automation's idle quiesce timer; dispose() clears both.
      browser.dispose();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("starts a fresh session when the old one ended without a detach event", async () => {
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    const { debugger: api } = fakeTab(tab.id).contents;
    await browser.send(tab.id, "Page.reload", {}, signal());
    api.emitOnSelfDetach = false;
    api.detach();
    await expect(browser.send(tab.id, "Runtime.evaluate", {}, signal())).resolves.toEqual({});
    expect(api.attach).toHaveBeenCalledTimes(2);
    expect(api.commands.map(({ method }) => method)).toEqual([
      ...READY,
      "Page.reload",
      ...READY,
      "Runtime.evaluate",
    ]);
  });

  it("does not keep failing agent commands behind a hung ready step while another holder keeps the session", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    const { debugger: api } = fakeTab(tab.id).contents;
    let focusCalls = 0;
    api.respond = (method) =>
      method === "Emulation.setFocusEmulationEnabled" && ++focusCalls === 1
        ? new Promise(() => {})
        : {};
    const { cdp } = internals(browser).entries.get(tab.id)!.live!;
    cdp.acquire("picker"); // A user's element pick (browser-picker).
    const first = browser.send(tab.id, "Page.reload", {}, signal());
    const timedOut = expect(first).rejects.toThrow("Browser command timed out.");
    await vi.advanceTimersByTimeAsync(15_000);
    await timedOut;
    expect(cdp.holds("picker")).toBe(true);
    await expect(browser.send(tab.id, "Page.reload", {}, signal())).resolves.toEqual({});
    expect(api.attach).toHaveBeenCalledTimes(1);
    expect(api.commands.map(({ method }) => method)).toEqual([
      "Emulation.setFocusEmulationEnabled",
      ...READY,
      "Page.reload",
    ]);
    // The memory budget's timer and the automation's idle quiesce timer; dispose() clears both.
    cdp.release("picker");
    browser.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses an aborted signal before touching the debugger", async () => {
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    const { debugger: api } = fakeTab(tab.id).contents;
    const controller = new AbortController();
    controller.abort();
    await expect(browser.send(tab.id, "Page.reload", {}, controller.signal)).rejects.toThrow();
    expect(api.attach).not.toHaveBeenCalled();
    await expect(browser.send("missing", "Page.reload", {}, signal())).rejects.toThrow(
      "Browser tab closed.",
    );
  });

  it("counts agent calls in flight", async () => {
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    const { debugger: api } = fakeTab(tab.id).contents;
    let answer!: (value: unknown) => void;
    api.respond = (method) =>
      method === "Runtime.evaluate"
        ? new Promise((resolve) => {
            answer = resolve;
          })
        : {};
    expect(agentBusy(browser, tab.id)).toBe(0);
    const first = browser.send(tab.id, "Runtime.evaluate", {}, signal());
    const second = browser.send(tab.id, "Page.reload", {}, signal());
    expect(agentBusy(browser, tab.id)).toBe(2);
    await second;
    expect(agentBusy(browser, tab.id)).toBe(1);
    await flush();
    answer({ result: { value: 1 } });
    await expect(first).resolves.toEqual({ result: { value: 1 } });
    expect(agentBusy(browser, tab.id)).toBe(0);
    expect(api.attach).toHaveBeenCalledTimes(1);
    // Failed and aborted calls count down too.
    const controller = new AbortController();
    const aborted = browser.send(tab.id, "Runtime.evaluate", {}, controller.signal);
    expect(agentBusy(browser, tab.id)).toBe(1);
    await flush();
    controller.abort();
    await expect(aborted).rejects.toThrow("target closed while handling command");
    expect(agentBusy(browser, tab.id)).toBe(0);
    await expect(browser.send(tab.id, "Page.reload", {}, controller.signal)).rejects.toThrow();
    expect(agentBusy(browser, tab.id)).toBe(0);
  });

  it("stop() stops loading and ends the agent's session", async () => {
    const browser = newBrowser();
    const used = await browser.open("https://example.com/", false, signal(), "project");
    const unused = await browser.open("https://example.org/", false, signal(), "project");
    await browser.send(used.id, "Page.reload", {}, signal());
    const a = fakeTab(used.id).contents;
    const b = fakeTab(unused.id).contents;
    browser.stop();
    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(a.debugger.detach).toHaveBeenCalledTimes(1);
    expect(a.debugger.isAttached()).toBe(false);
    expect(b.stop).toHaveBeenCalledTimes(1);
    expect(b.debugger.attach).not.toHaveBeenCalled();
    expect(b.debugger.detach).not.toHaveBeenCalled();
    browser.stop();
    expect(a.debugger.detach).toHaveBeenCalledTimes(1);
    expect(a.stop).toHaveBeenCalledTimes(2);
    // The next agent command starts a fresh session.
    await browser.send(used.id, "Page.reload", {}, signal());
    expect(a.debugger.attach).toHaveBeenCalledTimes(2);
  });

  it("agent commands apply the sign-in rules first", async () => {
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    const { contents } = fakeTab(tab.id);
    browser.surface(
      { owner: "owner", tab: tab.id, x: 0, y: 0, width: 800, height: 600 },
      fakeOwnerWindow() as unknown as BrowserWindow,
    );
    const signIn = () => browser.state().tabs[0]?.signInPopup;
    // An armed grant is cancelled, then the command runs.
    await browser.command({ tab: tab.id, action: "allow-sign-in" });
    expect(signIn()).toBe("armed");
    await browser.send(tab.id, "Page.reload", {}, signal());
    expect(signIn()).toBe("idle");
    expect(contents.debugger.attach).toHaveBeenCalledTimes(1);
    expect(contents.debugger.commands.at(-1)?.method).toBe("Page.reload");
    // An open popup refuses agent control before the debugger is touched.
    browser.stop();
    await browser.command({ tab: tab.id, action: "allow-sign-in" });
    contents.windowOpenHandler?.({
      url: "https://id.example/login",
      disposition: "foreground-tab",
      frameName: "",
      features: "",
      referrer: { url: "", policy: "default" },
    });
    expect(signIn()).toBe("open");
    await expect(browser.send(tab.id, "Page.reload", {}, signal())).rejects.toThrow(
      "Finish or close the sign-in popup before agent browser control resumes.",
    );
    expect(contents.debugger.attach).toHaveBeenCalledTimes(1);
    expect(contents.debugger.isAttached()).toBe(false);
    expect(signIn()).toBe("open");
  });
});

it("presented() reports a tab shown in a visible, non-minimized window", async () => {
  const browser = newBrowser();
  const tab = await browser.open("https://example.com/", false, signal(), "project");
  expect(browser.presented(tab.id)).toBe(false);
  expect(browser.presented("missing")).toBe(false);
  const owner = fakeOwnerWindow({ focused: false });
  browser.surface(
    { owner: "owner", tab: tab.id, x: 0, y: 0, width: 800, height: 600 },
    owner as unknown as BrowserWindow,
  );
  expect(browser.presented(tab.id)).toBe(true);
  owner.minimized = true;
  expect(browser.presented(tab.id)).toBe(false);
  owner.minimized = false;
  owner.visible = false;
  expect(browser.presented(tab.id)).toBe(false);
  owner.visible = true;
  expect(browser.presented(tab.id)).toBe(true);
  await browser.command({ tab: tab.id, action: "popout" });
  expect(browser.state().tabs[0]?.presentation).toBe("window");
  expect(fakeTab(tab.id).host.isVisible()).toBe(true);
  expect(browser.presented(tab.id)).toBe(true);
  await browser.command({ tab: tab.id, action: "dock" });
  expect(browser.state().tabs[0]?.presentation).toBe("background");
  expect(browser.presented(tab.id)).toBe(false);
});

it("mounts a tab in the owner window and returns it to its host when hidden", async () => {
  const browser = newBrowser();
  const tab = await browser.open("https://example.com/", false, signal(), "project");
  const { view, host } = fakeTab(tab.id);
  const owner = fakeOwnerWindow();
  browser.surface(
    { owner: "owner", tab: tab.id, x: 10, y: 20, width: 300, height: 200 },
    owner as unknown as BrowserWindow,
  );
  expect(owner.contentView.children).toEqual([view]);
  expect(host.contentView.children).toEqual([]);
  expect(view.getBounds()).toEqual({ x: 10, y: 20, width: 300, height: 200 });
  expect(browser.state().tabs[0]?.presentation).toBe("panel");
  browser.surface(
    { owner: "owner", tab: null, x: 0, y: 0, width: 0, height: 0 },
    owner as unknown as BrowserWindow,
  );
  expect(owner.contentView.children).toEqual([]);
  expect(host.contentView.children).toEqual([view]);
  expect(view.getBounds()).toEqual({ x: 0, y: 0, width: 300, height: 200 });
  expect(browser.state().tabs[0]?.presentation).toBe("background");
});

it.each(["guest", "host"] as const)(
  "closing a tab's %s removes it once and tears its page down",
  async (side) => {
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    await browser.send(tab.id, "Page.reload", {}, signal());
    const { contents, host } = fakeTab(tab.id);
    const destroyHost = vi.spyOn(host, "destroy");
    const published = vi.fn();
    browser.onState(published);
    if (side === "guest") contents.destroy();
    else host.destroy();
    expect(browser.state().tabs).toEqual([]);
    expect(published).toHaveBeenCalledTimes(1);
    expect(contents.isDestroyed()).toBe(true);
    expect(host.isDestroyed()).toBe(true);
    if (side === "host") {
      expect(contents.close).toHaveBeenCalledTimes(1);
      expect(contents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
      expect(destroyHost).toHaveBeenCalledTimes(1);
      expect(contents.debugger.listenerCount("message")).toBe(0);
      expect(contents.debugger.listenerCount("detach")).toBe(0);
    } else {
      // The destroyed debugger was never touched (the fake throws if it is).
      expect(contents.close).not.toHaveBeenCalled();
      expect(contents.debugger.detach).not.toHaveBeenCalled();
      expect(destroyHost).toHaveBeenCalledTimes(1);
    }
    host.emit("closed");
    contents.emit("destroyed");
    expect(browser.state().tabs).toEqual([]);
    expect(published).toHaveBeenCalledTimes(1);
    await expect(browser.send(tab.id, "Page.reload", {}, signal())).rejects.toThrow(
      "Browser tab closed.",
    );
  },
);

it.each(["close", "dispose"] as const)(
  "ends a page's debugger session before closing its contents (%s)",
  async (how) => {
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    await browser.send(tab.id, "Page.reload", {}, signal());
    const { contents, host } = fakeTab(tab.id);
    if (how === "close") await browser.close(tab.id, signal());
    else browser.dispose();
    expect(browser.state().tabs).toEqual([]);
    expect(contents.isDestroyed()).toBe(true);
    expect(host.isDestroyed()).toBe(true);
    // The page's lease detached and dropped its listeners first, so no listener outlives the page.
    expect(contents.debugger.detach).toHaveBeenCalledTimes(1);
    expect(contents.debugger.detach.mock.invocationCallOrder[0]).toBeLessThan(
      contents.close.mock.invocationCallOrder[0] ?? 0,
    );
    expect(contents.debugger.listenerCount("message")).toBe(0);
    expect(contents.debugger.listenerCount("detach")).toBe(0);
  },
);

it("ignores the late events of a page the tab no longer shows", async () => {
  const browser = newBrowser();
  const tab = await browser.open("https://example.com/", false, signal(), "project");
  const old = fakeTab(tab.id);
  // What browser-tab-budget's suspend() and revive() do: tear the page down, then give the tab a
  // new page under the same id.
  const inner = internals(browser);
  const entry = inner.entries.get(tab.id)!;
  const page = entry.live!;
  entry.live = null;
  inner.teardownPage(tab.id, page);
  entry.live = inner.createPage(entry, tab.id).page;
  const fresh = fakeElectronState.views.at(-1)!.webContents;
  expect(fresh).not.toBe(old.contents);
  const published = vi.fn();
  browser.onState(published);
  // Electron destroys contents asynchronously, so the old page can still emit events.
  const stale = old.contents;
  stale.emit("did-start-navigation", fakeEvent(), "https://stale.example/", false, true);
  stale.emit("did-start-loading");
  stale.emit("did-fail-load", fakeEvent(), -105, "Stale failure", "https://stale.example/", true);
  stale.emit("render-process-gone", fakeEvent(), { reason: "crashed" });
  stale.emit("page-title-updated", fakeEvent(), "Stale");
  stale.emit("did-stop-loading");
  stale.emit("before-input-event", fakeEvent(), {
    type: "keyDown",
    key: "w",
    meta: true,
    control: true,
    alt: false,
  });
  old.host.emit("close", fakeEvent());
  old.host.emit("resize");
  old.host.emit("closed");
  stale.emit("destroyed");
  expect(published).not.toHaveBeenCalled();
  expect(browser.state().tabs).toEqual([
    expect.objectContaining({
      id: tab.id,
      url: "https://example.com/",
      error: null,
      presentation: "background",
    }),
  ]);
  // The tab's current page still reaches it.
  fresh.emit("did-fail-load", fakeEvent(), -105, "Fresh failure", "https://example.com/", true);
  expect(published).toHaveBeenCalledTimes(1);
  expect(browser.state().tabs[0]?.error).toBe("Fresh failure");
  await browser.send(tab.id, "Page.reload", {}, signal());
  expect(fresh.debugger.commands.map(({ method }) => method)).toEqual([...READY, "Page.reload"]);
});

describe("agent automation", () => {
  /** The tab's per-page automation (browser-agent-control). */
  const automationOf = (browser: EmbeddedComputerBrowser, tab: string) => browser.automation(tab)!;

  it("creates one automation per page and disposes it with the page", async () => {
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    const first = automationOf(browser, tab.id);
    const { contents } = fakeTab(tab.id);
    expect(contents.listenerCount("before-mouse-event")).toBe(1);
    // What browser-tab-budget's suspend() and revive() do: a new page gets a fresh automation.
    const inner = internals(browser);
    const entry = inner.entries.get(tab.id)!;
    const page = entry.live!;
    entry.live = null;
    inner.teardownPage(tab.id, page);
    expect(contents.listenerCount("before-mouse-event")).toBe(0);
    entry.live = inner.createPage(entry, tab.id).page;
    expect(automationOf(browser, tab.id)).not.toBe(first);
    await browser.close(tab.id, signal());
    expect(browser.automation(tab.id)).toBeUndefined();
  });

  it("opens agent tabs whose page answers CDP only once it starts loading", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const browser = newBrowser();
    const opening = browser.open("https://example.com/", false, signal());
    const { contents } = fakeTab(String(fakeElectronState.views.at(-1)!.webContents.id));
    // Like Chromium: a WebContents that has not started loading has no renderer to answer CDP.
    contents.debugger.respond = () =>
      contents.loadURL.mock.calls.length > 0 ? {} : new Promise(() => {});
    const outcome = opening.then(
      () => "opened",
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(outcome).resolves.toBe("opened");
    expect(contents.debugger.commands.map(({ method }) => method)).toEqual([
      "Emulation.setFocusEmulationEnabled",
      "Network.enable",
      "Page.enable",
      "Page.setInterceptFileChooserDialog",
      "Runtime.enable",
      "Log.enable",
    ]);
    expect(contents.debugger.isAttached()).toBe(true);
  });

  it("turns capture back on for every agent call after the ready steps", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const browser = newBrowser();
    const agentTab = await browser.open("https://example.com/", false, signal());
    const userTab = await browser.open("https://example.org/", false, signal(), "project");
    const agentApi = fakeTab(agentTab.id).contents.debugger;
    const userApi = fakeTab(userTab.id).contents.debugger;
    await browser.send(agentTab.id, "Page.reload", {}, signal());
    await browser.send(userTab.id, "Page.reload", {}, signal());
    await vi.advanceTimersByTimeAsync(60_000);
    const quiesce = [
      "Runtime.disable",
      "Log.disable",
      "Runtime.discardConsoleEntries",
      "Log.clear",
    ];
    // The agent's tab keeps Network for idle tracking; the user's own tab stops recording it.
    expect(agentApi.commands.slice(-4).map(({ method }) => method)).toEqual(quiesce);
    expect(userApi.commands.slice(-5).map(({ method }) => method)).toEqual([
      ...quiesce,
      "Network.disable",
    ]);
    await browser.send(agentTab.id, "Runtime.evaluate", {}, signal());
    expect(agentApi.commands.slice(-3).map(({ method }) => method)).toEqual([
      "Runtime.enable",
      "Log.enable",
      "Runtime.evaluate",
    ]);
    await browser.send(userTab.id, "Runtime.evaluate", {}, signal());
    expect(userApi.commands.slice(-4).map(({ method }) => method)).toEqual([
      "Network.enable",
      "Runtime.enable",
      "Log.enable",
      "Runtime.evaluate",
    ]);
  });

  it("opens agent tabs with the session and network capture on before the page loads", async () => {
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal());
    const { contents } = fakeTab(tab.id);
    // Network.enable goes out with the focus step, ahead of the other ready steps, which wait for
    // it instead of sending their own.
    expect(contents.debugger.commands.map(({ method }) => method)).toEqual([
      "Emulation.setFocusEmulationEnabled",
      "Network.enable",
      "Page.enable",
      "Page.setInterceptFileChooserDialog",
      "Runtime.enable",
      "Log.enable",
    ]);
    expect(contents.debugger.attach.mock.invocationCallOrder[0]).toBeLessThan(
      contents.loadURL.mock.invocationCallOrder[0] ?? 0,
    );
    expect(contents.debugger.sendCommand.mock.invocationCallOrder[1]).toBeLessThan(
      contents.loadURL.mock.invocationCallOrder[0] ?? 0,
    );
    // Project tabs stay detached until an agent uses them.
    const manual = await browser.open("https://example.org/", false, signal(), "project");
    expect(fakeTab(manual.id).contents.debugger.attach).not.toHaveBeenCalled();
    expect(await browser.tabs(signal())).toEqual([
      expect.objectContaining({ id: tab.id, presented: false, userActive: false, agentTab: true }),
      expect.objectContaining({
        id: manual.id,
        presented: false,
        userActive: false,
        agentTab: false,
      }),
    ]);
  });

  it("reports a tab the user is working in", async () => {
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    const { contents } = fakeTab(tab.id);
    browser.surface(
      { owner: "owner", tab: tab.id, x: 0, y: 0, width: 800, height: 600 },
      fakeOwnerWindow() as unknown as BrowserWindow,
    );
    contents.focused = true;
    contents.emit("before-mouse-event", fakeEvent(), {
      type: "mouseDown",
      x: 5,
      y: 5,
      button: "left",
    });
    expect(automationOf(browser, tab.id).humanEpoch).toBe(1);
    expect(await browser.tabs(signal())).toEqual([
      expect.objectContaining({ id: tab.id, presented: true, userActive: true, agentTab: false }),
    ]);
    // Focus elsewhere (the composer) ends the hold at once; the epoch stays.
    contents.focused = false;
    expect((await browser.tabs(signal()))[0]?.userActive).toBe(false);
    // Toolbar navigation counts as the user's input too.
    await browser.command({ tab: tab.id, action: "reload" });
    expect(automationOf(browser, tab.id).humanEpoch).toBe(2);
    await browser.command({ tab: tab.id, action: "zoom", zoom: 1.5 });
    expect(automationOf(browser, tab.id).humanEpoch).toBe(2);
  });

  it("clears the agent's emulation when the user shows, resizes or pops out the tab", async () => {
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    const { debugger: api } = fakeTab(tab.id).contents;
    await browser.send(tab.id, "Page.reload", {}, signal());
    const automation = automationOf(browser, tab.id);
    const clears = () =>
      api.commands.filter(({ method }) => method === "Emulation.clearDeviceMetricsOverride").length;
    const owner = fakeOwnerWindow() as unknown as BrowserWindow;
    const show = (width: number) =>
      browser.surface({ owner: "owner", tab: tab.id, x: 0, y: 0, width, height: 600 }, owner);
    automation.recordEmulation({ viewport: { width: 390, height: 844 } });
    show(800);
    await flush();
    expect(clears()).toBe(1);
    automation.recordEmulation({ colorScheme: "dark" });
    show(800); // Same bounds: nothing changes.
    await flush();
    expect(clears()).toBe(1);
    show(700);
    await flush();
    expect(clears()).toBe(2);
    // Hiding keeps it; showing in a pop-out clears it.
    automation.recordEmulation({ colorScheme: "dark" });
    browser.surface({ owner: "owner", tab: null, x: 0, y: 0, width: 0, height: 0 }, owner);
    await flush();
    expect(clears()).toBe(2);
    await browser.command({ tab: tab.id, action: "popout" });
    await flush();
    expect(clears()).toBe(3);
  });

  it("stop() clears the agent's emulation before it releases the agent's hold", async () => {
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    const { debugger: api } = fakeTab(tab.id).contents;
    await browser.send(tab.id, "Page.reload", {}, signal());
    const { cdp } = internals(browser).entries.get(tab.id)!.live!;
    cdp.acquire("picker"); // A user's pick keeps the session after the stop.
    automationOf(browser, tab.id).recordEmulation({ viewport: { width: 390, height: 844 } });
    browser.stop();
    await flush();
    expect(api.isAttached()).toBe(true);
    expect(cdp.holds("agent")).toBe(false);
    // The memory budget then ends focus emulation with the agent's hold (syncThrottling).
    expect(api.commands.slice(-3).map(({ method }) => method)).toEqual([
      "Emulation.clearDeviceMetricsOverride",
      "Emulation.setEmulatedMedia",
      "Emulation.setFocusEmulationEnabled",
    ]);
  });

  it("applies the sign-in rules to diagnostics reads and the dialog shim", async () => {
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    const { contents } = fakeTab(tab.id);
    browser.surface(
      { owner: "owner", tab: tab.id, x: 0, y: 0, width: 800, height: 600 },
      fakeOwnerWindow() as unknown as BrowserWindow,
    );
    await browser.command({ tab: tab.id, action: "allow-sign-in" });
    contents.windowOpenHandler?.({
      url: "https://id.example/login",
      disposition: "foreground-tab",
      frameName: "",
      features: "",
      referrer: { url: "", policy: "default" },
    });
    expect(browser.state().tabs[0]?.signInPopup).toBe("open");
    const automation = automationOf(browser, tab.id);
    await expect(automation.diagnostics("console", 10, signal())).rejects.toThrow(
      "Finish or close the sign-in popup before agent browser control resumes.",
    );
    // The shim's install is refused too; the scope still works without it.
    const scope = await automation.begin({}, signal(), 15_000);
    await expect(scope.end()).resolves.toEqual({ dialogs: [] });
    expect(contents.debugger.attach).not.toHaveBeenCalled();
  });

  describe("gives the page its dialogs back before the agent's hold ends", () => {
    const RESTORE = "function () { return this.restore(); }";
    /** A project tab with an agent action's shim installed; the agent is the only holder. */
    async function scoped() {
      const browser = newBrowser();
      const tab = await browser.open("https://example.com/", false, signal(), "project");
      const { contents } = fakeTab(tab.id);
      const api = contents.debugger;
      api.respond = (method) =>
        method === "Runtime.evaluate" ? { result: { type: "object", objectId: "shim" } } : {};
      const scope = await automationOf(browser, tab.id).begin({}, signal(), 15_000);
      const restoredBeforeDetach = () => {
        const index = api.commands.findIndex(
          ({ method, params }) =>
            method === "Runtime.callFunctionOn" &&
            (params as { functionDeclaration?: string }).functionDeclaration === RESTORE,
        );
        expect(index).toBeGreaterThanOrEqual(0);
        expect(api.sendCommand.mock.invocationCallOrder[index]).toBeLessThan(
          api.detach.mock.invocationCallOrder.at(-1) ?? 0,
        );
        expect(api.isAttached()).toBe(false);
        expect(contents.listenerCount("will-prevent-unload")).toBe(0);
      };
      return { browser, tab, api, scope, restoredBeforeDetach };
    }

    it("on stop", async () => {
      const { browser, scope, restoredBeforeDetach } = await scoped();
      browser.stop();
      restoredBeforeDetach();
      await expect(scope.end({ failed: true })).resolves.toEqual({ dialogs: [] });
    });

    it("when the action is aborted mid-command", async () => {
      const { browser, tab, api, restoredBeforeDetach } = await scoped();
      api.respond = () => new Promise<never>(() => undefined);
      const controller = new AbortController();
      const command = browser.send(
        tab.id,
        "Runtime.evaluate",
        { expression: "1" },
        controller.signal,
      );
      await flush();
      controller.abort();
      await expect(command).rejects.toThrow();
      restoredBeforeDetach();
    });

    it("when a command times out", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { browser, tab, api, restoredBeforeDetach } = await scoped();
      api.respond = () => new Promise<never>(() => undefined);
      const command = browser.send(tab.id, "Runtime.evaluate", { expression: "1" }, signal());
      const outcome = expect(command).rejects.toThrow("Browser command timed out.");
      await vi.advanceTimersByTimeAsync(15_000);
      await outcome;
      restoredBeforeDetach();
    });
  });

  it("lets Electron answer every page dialog in the agent's tabs, and only there", async () => {
    const browser = newBrowser();
    const agentTab = await browser.open("https://example.com/", false, signal());
    const userTab = await browser.open("https://example.org/", false, signal(), "project");
    // Electron then never shows a native box for the agent's tabs; the user's keep theirs.
    expect(fakeTab(agentTab.id).view.options.webPreferences?.disableDialogs).toBe(true);
    expect(fakeTab(userTab.id).view.options.webPreferences).not.toHaveProperty("disableDialogs");
    // The agent's tab is shown in the panel: its dialog is still reported, never left pending.
    browser.surface(
      { owner: "owner", tab: agentTab.id, x: 0, y: 0, width: 800, height: 600 },
      fakeOwnerWindow() as unknown as BrowserWindow,
    );
    expect(browser.presented(agentTab.id)).toBe(true);
    await browser.send(userTab.id, "Runtime.evaluate", { expression: "1" }, signal());
    await browser.send(agentTab.id, "Runtime.evaluate", { expression: "1" }, signal());
    for (const { id } of [agentTab, userTab])
      fakeTab(id).contents.debugger.message("Page.javascriptDialogOpening", {
        type: "confirm",
        message: "timer",
      });
    await flush();
    const answered = (id: string) =>
      fakeTab(id).contents.debugger.commands.some(
        ({ method }) => method === "Page.handleJavaScriptDialog",
      );
    expect(answered(agentTab.id)).toBe(false);
    expect(automationOf(browser, agentTab.id).pendingDialog()).toBeNull();
    expect(automationOf(browser, agentTab.id).takeBacklog()).toEqual([
      expect.objectContaining({ message: "timer", action: "dismissed", during: "background" }),
    ]);
    expect(answered(userTab.id)).toBe(false);
    expect(automationOf(browser, userTab.id).pendingDialog()).toEqual(
      expect.objectContaining({ message: "timer" }),
    );
  });
});

describe("memory budget", () => {
  const MINUTE = 60_000;
  /** Fake time and timeouts; setImmediate and microtasks stay real (the fake debugger and flush use them). */
  const fakeTime = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const tabState = (browser: EmbeddedComputerBrowser, id: string) =>
    browser.state().tabs.find((tab) => tab.id === id);
  const suspended = (browser: EmbeddedComputerBrowser, id: string) =>
    tabState(browser, id)?.suspended === true;
  const surface = (
    browser: EmbeddedComputerBrowser,
    owner: ReturnType<typeof fakeOwnerWindow>,
    tab: string | null,
  ) =>
    browser.surface(
      { owner: "owner", tab, x: 0, y: 0, width: 800, height: 600 },
      owner as unknown as BrowserWindow,
    );
  /** The newest page's view: a revived tab's page (fakeTab() finds a tab's first page). */
  const newestView = () => fakeElectronState.views.at(-1)!;

  it("suspends an idle hidden tab after 10 minutes and keeps its id, title and address", async () => {
    fakeTime();
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/page", false, signal(), "project");
    const { contents, host } = fakeTab(tab.id);
    contents.title = "Example";
    contents.emit("page-title-updated", fakeEvent(), "Example");
    const destroyHost = vi.spyOn(host, "destroy");
    await advance(BROWSER_IDLE_SUSPEND_MS - 1);
    expect(suspended(browser, tab.id)).toBe(false);
    const published = vi.fn();
    browser.onState(published);
    await advance(1);
    expect(browser.state().tabs).toEqual([
      {
        id: tab.id,
        project: "project",
        title: "Example",
        url: "https://example.com/page",
        loading: false,
        canGoBack: false,
        canGoForward: false,
        zoom: 1,
        presentation: "background",
        error: null,
        signInPopup: "idle",
        suspended: true,
      },
    ]);
    expect(published).toHaveBeenCalledTimes(1);
    expect(contents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
    expect(destroyHost).toHaveBeenCalledTimes(1);
    await expect(browser.tabs(signal())).resolves.toEqual([
      {
        id: tab.id,
        title: "Example",
        url: "https://example.com/page",
        presented: false,
        userActive: false,
        agentTab: false,
        suspended: true,
      },
    ]);
    // The old page's late events cannot remove the tab.
    host.emit("closed");
    contents.emit("destroyed");
    expect(browser.state().tabs.map(({ id, suspended }) => ({ id, suspended }))).toEqual([
      { id: tab.id, suspended: true },
    ]);
    // Nothing is left to plan.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("suspends the least recently used hidden tab past the live limit", async () => {
    fakeTime();
    const browser = newBrowser();
    const tabs = [];
    for (let index = 0; index <= BROWSER_LIVE_TAB_LIMIT; index++) {
      tabs.push(await browser.open(`https://example.com/${index}`, false, signal(), `p${index}`));
      await advance(10);
    }
    expect(tabs.map((tab) => suspended(browser, tab.id))).toEqual([
      true,
      ...Array.from({ length: BROWSER_LIVE_TAB_LIMIT }, () => false),
    ]);
  });

  it.each([
    [
      "mounted",
      (browser: EmbeddedComputerBrowser, id: string) => {
        surface(browser, fakeOwnerWindow(), id);
        // surface() also makes it the last-shown tab; clear that to test the mounted exemption alone.
        (browser as unknown as { lastShown: string | null }).lastShown = null;
      },
    ],
    [
      "last-shown",
      (browser: EmbeddedComputerBrowser, id: string) => {
        // Ryco hid the panel (window hidden or covered): the tab is unmounted but still the one shown.
        const owner = fakeOwnerWindow();
        surface(browser, owner, id);
        surface(browser, owner, null);
      },
    ],
    [
      "popped-out",
      async (browser: EmbeddedComputerBrowser, id: string) => {
        await browser.command({ tab: id, action: "popout" });
      },
    ],
    [
      "DevTools",
      (_browser: EmbeddedComputerBrowser, id: string) => {
        fakeTab(id).contents.devToolsOpened = true;
      },
    ],
    [
      "audible",
      (_browser: EmbeddedComputerBrowser, id: string) => {
        fakeTab(id).contents.audible = true;
      },
    ],
  ] as const)("never suspends a %s tab", async (kind, pin) => {
    fakeTime();
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    const other = await browser.open("https://example.org/", false, signal(), "project");
    await pin(browser, tab.id);
    await advance(11 * MINUTE);
    expect(suspended(browser, tab.id)).toBe(false);
    expect(suspended(browser, other.id)).toBe(true);
    if (kind === "DevTools" || kind === "audible") {
      // Closing DevTools or going silent makes the tab eligible again at once.
      const { contents } = fakeTab(tab.id);
      contents.devToolsOpened = false;
      contents.audible = false;
      contents.emit(kind === "DevTools" ? "devtools-closed" : "audio-state-changed", fakeEvent());
      await advance(0);
      expect(suspended(browser, tab.id)).toBe(true);
    }
  });

  it("never suspends a tab while its sign-in grant is armed", async () => {
    fakeTime();
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    await advance(BROWSER_IDLE_SUSPEND_MS - 10_000);
    // The grant itself needs a focused tab (command "allow-sign-in"); arm it directly here.
    (browser as unknown as { signIn: { arm(tab: string): void } }).signIn.arm(tab.id);
    await advance(20_000);
    expect(tabState(browser, tab.id)?.signInPopup).toBe("armed");
    expect(suspended(browser, tab.id)).toBe(false);
    // The grant expires after 30 s; the idle tab is then suspended.
    await advance(10_000);
    // The expiry notifies on a microtask; a timeout set during a fake tick runs 1 ms later.
    await advance(1);
    expect(tabState(browser, tab.id)?.signInPopup).toBe("idle");
    expect(suspended(browser, tab.id)).toBe(true);
  });

  it("keeps a tab an agent used live for the claim window and idle time", async () => {
    fakeTime();
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    await advance(9 * MINUTE);
    await browser.send(tab.id, "Page.reload", {}, signal());
    // The agent's use restarts the idle clock.
    await advance(BROWSER_IDLE_SUSPEND_MS - 1);
    expect(suspended(browser, tab.id)).toBe(false);
    await advance(1);
    expect(suspended(browser, tab.id)).toBe(true);
  });

  it("suspends the least recently used agent tab past the warm limit once its hold ends", async () => {
    fakeTime();
    const browser = newBrowser();
    // Agent-opened tabs (no project) form their own scope and start inside the claim window.
    const tabs = [];
    for (let index = 0; index < 7; index++) {
      tabs.push(await browser.open(`https://example.com/${index}`, false, signal()));
      await advance(10);
    }
    await advance(COMPUTER_TARGET_CLAIM_MS - 70 - 1);
    expect(tabs.map((tab) => suspended(browser, tab.id))).toEqual(Array(7).fill(false));
    await advance(1);
    expect(tabs.map((tab) => suspended(browser, tab.id))).toEqual([true, ...Array(6).fill(false)]);
    // Back at the warm limit, the other six wait for the idle time.
    await advance(5 * MINUTE);
    expect(tabs.filter((tab) => suspended(browser, tab.id))).toHaveLength(1);
  });

  it("keeps an agent-held tab over the live limit and suspends the next one instead", async () => {
    fakeTime();
    const browser = newBrowser();
    const held = await browser.open("https://example.com/held", false, signal(), "p-held");
    await browser.send(held.id, "Page.reload", {}, signal());
    await advance(10);
    const others = [];
    for (let index = 0; index < BROWSER_LIVE_TAB_LIMIT; index++) {
      others.push(await browser.open(`https://example.com/${index}`, false, signal(), `p${index}`));
      await advance(10);
    }
    expect(suspended(browser, held.id)).toBe(false);
    expect(others.map((tab) => suspended(browser, tab.id))).toEqual([
      true,
      ...Array.from({ length: BROWSER_LIVE_TAB_LIMIT - 1 }, () => false),
    ]);
  });

  it("throttles hidden tabs unless an agent used them in the last 60 s", async () => {
    fakeTime();
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    const { contents } = fakeTab(tab.id);
    expect(contents.getBackgroundThrottling()).toBe(true);
    await browser.send(tab.id, "Page.reload", {}, signal());
    expect(contents.getBackgroundThrottling()).toBe(false);
    await advance(COMPUTER_TARGET_CLAIM_MS - 1);
    expect(contents.getBackgroundThrottling()).toBe(false);
    await advance(1);
    expect(contents.getBackgroundThrottling()).toBe(true);
    await browser.send(tab.id, "Page.reload", {}, signal());
    expect(contents.getBackgroundThrottling()).toBe(false);
    // Emergency stop drops the agent's hold at once.
    browser.stop();
    expect(contents.getBackgroundThrottling()).toBe(true);
    // An agent-opened tab starts unthrottled.
    const agentTab = await browser.open("https://example.org/", false, signal());
    expect(fakeTab(agentTab.id).view.options.webPreferences?.backgroundThrottling).toBe(false);
    expect(fakeTab(agentTab.id).contents.getBackgroundThrottling()).toBe(false);
  });

  it("ends the agent's focus emulation with its hold and turns it on again for its next command", async () => {
    fakeTime();
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    const { contents } = fakeTab(tab.id);
    const focus = (enabled: boolean) => ({
      method: "Emulation.setFocusEmulationEnabled",
      params: { enabled },
    });
    const evaluate = { method: "Runtime.evaluate", params: {} };
    // The agent automation's ready steps and idle quiesce (Page, Network, Runtime, Log) are not
    // this test's concern.
    const commands = () =>
      contents.debugger.commands.filter(
        ({ method }) =>
          method === "Emulation.setFocusEmulationEnabled" || method === evaluate.method,
      );
    await browser.send(tab.id, "Runtime.evaluate", {}, signal());
    await advance(COMPUTER_TARGET_CLAIM_MS - 1);
    expect(commands()).toEqual([focus(true), evaluate]);
    // In Chromium, focus emulation keeps a hidden page visible and painting whatever its
    // throttling, so it ends with the hold. The session stays (other units keep state in it).
    await advance(1);
    await flush();
    expect(contents.getBackgroundThrottling()).toBe(true);
    expect(commands()).toEqual([focus(true), evaluate, focus(false)]);
    expect(contents.debugger.isAttached()).toBe(true);
    await browser.send(tab.id, "Runtime.evaluate", {}, signal());
    expect(commands()).toEqual([focus(true), evaluate, focus(false), focus(true), evaluate]);
    // A thumbnail hold on a page without a session sends nothing when it ends.
    const other = await browser.open("https://example.org/", false, signal(), "project");
    await browser.capture(other.id);
    await advance(BROWSER_PREVIEW_HOLD_MS);
    expect(fakeTab(other.id).contents.getBackgroundThrottling()).toBe(true);
    expect(fakeTab(other.id).contents.debugger.commands).toEqual([]);
  });

  it("surface() revives a suspended tab at its last address and mounts it", async () => {
    fakeTime();
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/a", false, signal(), "project");
    const old = fakeTab(tab.id);
    old.contents.url = "https://example.com/b"; // The page navigated since.
    await advance(BROWSER_IDLE_SUSPEND_MS);
    expect(suspended(browser, tab.id)).toBe(true);
    const owner = fakeOwnerWindow();
    const views = fakeElectronState.views.length;
    surface(browser, owner, tab.id);
    expect(fakeElectronState.views).toHaveLength(views + 1);
    const fresh = newestView();
    expect(fresh.webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(fresh.webContents.loadURL).toHaveBeenCalledWith("https://example.com/b");
    expect(fresh.options.webPreferences).toMatchObject({
      session: fakeSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      focusOnNavigation: false,
    });
    expect(owner.contentView.children).toEqual([fresh]);
    expect(fresh.firstParent?.isVisible()).toBe(false);
    expect(tabState(browser, tab.id)).toMatchObject({ id: tab.id, presentation: "panel" });
    expect(tabState(browser, tab.id)).not.toHaveProperty("suspended");
    // The old page's late events reach neither the tab nor its new page.
    old.host.emit("closed");
    old.contents.emit("destroyed");
    await flush();
    expect(tabState(browser, tab.id)).toMatchObject({ id: tab.id, presentation: "panel" });
    expect(owner.contentView.children).toEqual([fresh]);
    expect(fresh.webContents.isDestroyed()).toBe(false);
    // The agent hears about a reload the user caused, once. It had finished: "earlier".
    await expect(browser.wake(tab.id, signal())).resolves.toBe("earlier");
    await expect(browser.wake(tab.id, signal())).resolves.toBe(null);
    expect(fakeElectronState.views).toHaveLength(views + 1);
  });

  it("send revives a suspended tab before the CDP command and keeps its id", async () => {
    fakeTime();
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/f", false, signal(), "project");
    await browser.send(tab.id, "Page.reload", {}, signal());
    const old = fakeTab(tab.id).contents;
    await advance(BROWSER_IDLE_SUSPEND_MS);
    expect(suspended(browser, tab.id)).toBe(true);
    // Suspension tears the page down through teardownPage: its session ended first.
    expect(old.debugger.detach).toHaveBeenCalledTimes(1);
    expect(old.debugger.detach.mock.invocationCallOrder[0]).toBeLessThan(
      old.close.mock.invocationCallOrder[0] ?? 0,
    );
    expect(old.debugger.listenerCount("message")).toBe(0);
    expect(old.debugger.listenerCount("detach")).toBe(0);
    expect(old.isDestroyed()).toBe(true);
    await expect(browser.send(tab.id, "Runtime.evaluate", {}, signal())).resolves.toEqual({});
    const fresh = newestView().webContents;
    expect(fresh).not.toBe(old);
    expect(fresh.loadURL).toHaveBeenCalledWith("https://example.com/f");
    expect(fresh.loadURL.mock.invocationCallOrder[0]).toBeLessThan(
      fresh.debugger.attach.mock.invocationCallOrder[0] ?? 0,
    );
    // The new page's session gets focus emulation (and the agent automation's ready steps) again;
    // it started unthrottled.
    expect(fresh.debugger.commands.map(({ method }) => method)).toEqual([
      ...READY,
      "Runtime.evaluate",
    ]);
    expect(fresh.webPreferences.backgroundThrottling).toBe(false);
    expect(browser.state().tabs.map(({ id }) => id)).toEqual([tab.id]);
    expect(suspended(browser, tab.id)).toBe(false);
    // The driver's wake() reports the reload once (send itself reports nothing); the reload had
    // finished before this wake.
    await expect(browser.wake(tab.id, signal())).resolves.toBe("earlier");
    await expect(browser.wake(tab.id, signal())).resolves.toBe(null);
  });

  it("wake() waits for the reload, then reports it", async () => {
    fakeTime();
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    await advance(BROWSER_IDLE_SUSPEND_MS);
    let finish!: () => void;
    fakeElectronState.onView = (view) =>
      view.webContents.loadURL.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
    let woke = false;
    const waking = browser.wake(tab.id, signal()).then((revived) => {
      woke = true;
      return revived;
    });
    await flush();
    expect(woke).toBe(false);
    expect(tabState(browser, tab.id)).not.toHaveProperty("suspended");
    finish();
    await expect(waking).resolves.toBe("now");
    // Reported once.
    await expect(browser.wake(tab.id, signal())).resolves.toBe(null);
    // An abort ends the wait without failing the reload or losing the report.
    await advance(BROWSER_IDLE_SUSPEND_MS);
    expect(suspended(browser, tab.id)).toBe(true);
    fakeElectronState.onView = (view) =>
      view.webContents.loadURL.mockImplementationOnce(() => new Promise<void>(() => {}));
    const controller = new AbortController();
    const aborted = browser.wake(tab.id, controller.signal);
    controller.abort(new Error("stopped"));
    await expect(aborted).rejects.toThrow("stopped");
    // A load that never ends stops being waited for after 30 s in total.
    const slow = browser.wake(tab.id, signal());
    await advance(BROWSER_REVIVE_WAIT_MS);
    await expect(slow).resolves.toBe("now");
    let again: string | null | undefined;
    void browser.wake(tab.id, signal()).then((revived) => {
      again = revived;
    });
    await flush();
    expect(again).toBe(null);
  });

  it("wake() reports a reload the user started and that is still running as now", async () => {
    fakeTime();
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    await advance(BROWSER_IDLE_SUSPEND_MS);
    let finish!: () => void;
    fakeElectronState.onView = (view) =>
      view.webContents.loadURL.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
    surface(browser, fakeOwnerWindow(), tab.id);
    const waking = browser.wake(tab.id, signal());
    await flush();
    finish();
    // The page was just loaded from its address: the driver skips a reload and refuses history.
    await expect(waking).resolves.toBe("now");
  });

  it("re-checks the sign-in rules after waiting for a revival", async () => {
    fakeTime();
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    await advance(BROWSER_IDLE_SUSPEND_MS);
    let finish!: () => void;
    fakeElectronState.onView = (view) =>
      view.webContents.loadURL.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
    const sending = browser.send(tab.id, "Runtime.evaluate", {}, signal());
    await flush();
    // The user shows the reloading tab and allows a sign-in while the agent's command waits.
    (browser as unknown as { signIn: { arm(tab: string): void } }).signIn.arm(tab.id);
    await flush();
    expect(tabState(browser, tab.id)?.signInPopup).toBe("armed");
    finish();
    await sending;
    await flush();
    // The agent's command cancelled the grant before it reached the page.
    expect(tabState(browser, tab.id)?.signInPopup).toBe("idle");
  });

  it("capture keeps a previewed tab live and revives a suspended one", async () => {
    fakeTime();
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    const { contents } = fakeTab(tab.id);
    await expect(browser.capture(tab.id)).resolves.toBe("data:image/png;base64,");
    expect(contents.getBackgroundThrottling()).toBe(false);
    await advance(BROWSER_PREVIEW_HOLD_MS - 1);
    expect(contents.getBackgroundThrottling()).toBe(false);
    await advance(1);
    expect(contents.getBackgroundThrottling()).toBe(true);
    await advance(BROWSER_IDLE_SUSPEND_MS);
    expect(suspended(browser, tab.id)).toBe(true);
    await expect(browser.capture(tab.id)).rejects.toThrow("This browser tab is reloading.");
    const fresh = newestView().webContents;
    expect(fresh.loadURL).toHaveBeenCalledWith("https://example.com/");
    expect(fresh.getBackgroundThrottling()).toBe(false);
    expect(suspended(browser, tab.id)).toBe(false);
    await flush();
    await expect(browser.capture(tab.id)).resolves.toBe("data:image/png;base64,");
    expect(fresh.capturePage).toHaveBeenCalledTimes(1);
  });

  it("capture stops refusing a revival whose load never settles after the revival wait", async () => {
    fakeTime();
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    await advance(BROWSER_IDLE_SUSPEND_MS);
    // A hanging subresource: Electron's loadURL never settles.
    fakeElectronState.onView = (view) =>
      view.webContents.loadURL.mockImplementationOnce(() => new Promise<void>(() => {}));
    await expect(browser.capture(tab.id)).rejects.toThrow("This browser tab is reloading.");
    fakeElectronState.onView = null;
    const fresh = newestView().webContents;
    await advance(BROWSER_REVIVE_WAIT_MS - 1);
    await expect(browser.capture(tab.id)).rejects.toThrow("This browser tab is reloading.");
    await advance(1);
    // The preview shows whatever the page has painted so far.
    await expect(browser.capture(tab.id)).resolves.toBe("data:image/png;base64,");
    expect(fresh.capturePage).toHaveBeenCalledTimes(1);
  });

  it("capture waits for the first frame of a hidden page it unthrottles", async () => {
    fakeTime();
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    const { contents } = fakeTab(tab.id);
    // Electron: a hidden page that unthrottling shows has no frame for a few frames.
    contents.capturePage.mockRejectedValueOnce(new Error("UnknownVizError"));
    const throttling = vi.spyOn(contents, "setBackgroundThrottling");
    const capturing = browser.capture(tab.id);
    await advance(50);
    await expect(capturing).resolves.toBe("data:image/png;base64,");
    expect(contents.capturePage).toHaveBeenCalledTimes(2);
    expect(throttling.mock.calls).toEqual([[false]]);
  });

  it("capture shows a hidden page that loaded unthrottled, and gives up on one that never paints", async () => {
    fakeTime();
    const browser = newBrowser();
    // An agent-opened tab loads inside the agent's hold: unthrottled, so Electron never showed it.
    const tab = await browser.open("https://example.com/", false, signal());
    const { contents } = fakeTab(tab.id);
    const noFrame = new Error("Current display surface not available for capture");
    contents.capturePage.mockRejectedValueOnce(noFrame);
    const throttling = vi.spyOn(contents, "setBackgroundThrottling");
    const capturing = browser.capture(tab.id);
    await advance(50);
    await expect(capturing).resolves.toBe("data:image/png;base64,");
    // Throttling and unthrottling it again shows it.
    expect(throttling.mock.calls).toEqual([[true], [false]]);
    expect(contents.getBackgroundThrottling()).toBe(false);
    contents.capturePage.mockClear();
    contents.capturePage.mockRejectedValue(noFrame);
    const failing = expect(browser.capture(tab.id)).rejects.toThrow(noFrame.message);
    await advance(19 * 50);
    await failing;
    expect(contents.capturePage).toHaveBeenCalledTimes(20);
  });

  it("a revival whose load never settles is protected only for the revival wait", async () => {
    fakeTime();
    const browser = newBrowser();
    for (let index = 0; index < BROWSER_LIVE_TAB_LIMIT; index++) {
      const tab = await browser.open(`https://example.com/${index}`, false, signal(), `p${index}`);
      await browser.command({ tab: tab.id, action: "popout" });
    }
    const tab = await browser.open("https://example.com/hang", false, signal(), "p-hang");
    await advance(0);
    // The only eligible tab past the live limit.
    expect(suspended(browser, tab.id)).toBe(true);
    fakeElectronState.onView = (view) =>
      view.webContents.loadURL.mockImplementationOnce(() => new Promise<void>(() => {}));
    await browser.command({ tab: tab.id, action: "reload" });
    fakeElectronState.onView = null;
    await advance(BROWSER_REVIVE_WAIT_MS - 1);
    expect(suspended(browser, tab.id)).toBe(false);
    await advance(1);
    // Still loading, but no longer pinned: the live limit applies again.
    expect(suspended(browser, tab.id)).toBe(true);
  });

  it("an emergency stop during a revival reports the blank page instead of a loaded one", async () => {
    fakeTime();
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    await advance(BROWSER_IDLE_SUSPEND_MS);
    fakeElectronState.onView = (view) =>
      view.webContents.loadURL.mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            // Electron rejects the stopped load with ERR_ABORTED, and did-fail-load (-3) is ignored.
            view.webContents.stop.mockImplementationOnce(() =>
              reject(Object.assign(new Error("ERR_ABORTED (-3)"), { errno: -3 })),
            );
          }),
      );
    surface(browser, fakeOwnerWindow(), tab.id);
    fakeElectronState.onView = null;
    const fresh = newestView().webContents;
    const published = vi.fn();
    browser.onState(published);
    browser.stop();
    expect(fresh.stop).toHaveBeenCalledTimes(1);
    expect(published).toHaveBeenCalled();
    await flush();
    expect(tabState(browser, tab.id)).toMatchObject({
      url: "https://example.com/",
      loading: false,
      error: "Loading was stopped. Reload to recover.",
    });
    expect(suspended(browser, tab.id)).toBe(false);
    // The user's reload clears it.
    fresh.emit("did-start-loading");
    expect(tabState(browser, tab.id)?.error).toBeNull();
  });

  it("zooms a suspended tab once its revived page commits", async () => {
    fakeTime();
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    await advance(BROWSER_IDLE_SUSPEND_MS);
    await browser.command({ tab: tab.id, action: "zoom", zoom: 1.5 });
    const fresh = newestView().webContents;
    expect(fresh.loadURL).toHaveBeenCalledWith("https://example.com/");
    // Chromium drops a zoom set before the new page's frame is live.
    expect(fresh.getZoomFactor()).toBe(1);
    const published = vi.fn();
    browser.onState(published);
    fresh.emit("did-navigate", fakeEvent(), "https://example.com/", 200, "OK");
    expect(fresh.getZoomFactor()).toBe(1.5);
    expect(tabState(browser, tab.id)?.zoom).toBe(1.5);
    expect(published.mock.calls.at(-1)?.[0].tabs[0].zoom).toBe(1.5);
  });

  it("an agent action's commands cost no budget pass while its hold lasts", async () => {
    fakeTime();
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    await advance(0);
    const passes = vi.spyOn(browser as unknown as { applyBudget(): void }, "applyBudget");
    for (let index = 0; index < 4; index++)
      await browser.send(tab.id, "Runtime.evaluate", {}, signal());
    await advance(0);
    expect(passes).not.toHaveBeenCalled();
    const { contents } = fakeTab(tab.id);
    expect(contents.getBackgroundThrottling()).toBe(false);
    // One pass when the hold ends, which throttles the page again.
    await advance(COMPUTER_TARGET_CLAIM_MS);
    expect(passes).toHaveBeenCalledTimes(1);
    expect(contents.getBackgroundThrottling()).toBe(true);
  });

  it("a tab still loading is not the LRU victim", async () => {
    fakeTime();
    const browser = newBrowser();
    for (let index = 0; index < BROWSER_LIVE_TAB_LIMIT; index++) {
      const tab = await browser.open(`https://example.com/${index}`, false, signal(), `p${index}`);
      await browser.command({ tab: tab.id, action: "popout" });
    }
    let finish!: () => void;
    fakeElectronState.onView = (view) =>
      view.webContents.loadURL.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
    const opening = browser.open("https://example.com/loading", false, signal(), "p-loading");
    fakeElectronState.onView = null;
    await advance(0);
    const id = String(newestView().webContents.id);
    expect(suspended(browser, id)).toBe(false);
    finish();
    await opening;
    await advance(0);
    // The only eligible tab past the live limit once its load settled.
    expect(suspended(browser, id)).toBe(true);
    expect(browser.state().tabs.filter((tab) => tab.suspended)).toHaveLength(1);
  });

  it("showing another tab ends the last-shown exemption", async () => {
    fakeTime();
    const browser = newBrowser();
    const a = await browser.open("https://example.com/a", false, signal(), "project");
    const b = await browser.open("https://example.com/b", false, signal(), "project");
    const owner = fakeOwnerWindow();
    surface(browser, owner, a.id);
    surface(browser, owner, b.id);
    surface(browser, owner, null);
    await advance(BROWSER_IDLE_SUSPEND_MS);
    expect(suspended(browser, a.id)).toBe(true);
    expect(suspended(browser, b.id)).toBe(false);
    // Closing the last-shown tab clears it.
    await browser.close(b.id, signal());
    expect(browser.state().tabs.map(({ id }) => id)).toEqual([a.id]);
  });

  it("handles commands on a suspended tab", async () => {
    fakeTime();
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    await advance(BROWSER_IDLE_SUSPEND_MS);
    const views = fakeElectronState.views.length;
    for (const action of ["back", "forward", "stop", "dock", "cancel-sign-in"] as const)
      await browser.command({ tab: tab.id, action });
    expect(fakeElectronState.views).toHaveLength(views);
    expect(suspended(browser, tab.id)).toBe(true);
    await expect(browser.command({ tab: tab.id, action: "zoom", zoom: 9 })).rejects.toThrow(
      "Invalid zoom.",
    );
    // A suspended tab is never the focused tab a sign-in grant needs: refused without a reload.
    await expect(browser.command({ tab: tab.id, action: "allow-sign-in" })).rejects.toThrow(
      "Show and focus this browser tab before allowing sign-in.",
    );
    expect(fakeElectronState.views).toHaveLength(views);
    // navigate reloads at the new address with one page and one load.
    await browser.command({ tab: tab.id, action: "navigate", url: "https://example.org/next" });
    expect(fakeElectronState.views).toHaveLength(views + 1);
    const fresh = newestView().webContents;
    expect(fresh.loadURL).toHaveBeenCalledTimes(1);
    expect(fresh.loadURL).toHaveBeenCalledWith("https://example.org/next");
    await flush();
    expect(tabState(browser, tab.id)).toMatchObject({ url: "https://example.org/next" });
    expect(suspended(browser, tab.id)).toBe(false);
    // popout revives, then pops the new page out.
    await advance(BROWSER_IDLE_SUSPEND_MS);
    expect(suspended(browser, tab.id)).toBe(true);
    await browser.command({ tab: tab.id, action: "popout" });
    expect(tabState(browser, tab.id)?.presentation).toBe("window");
    expect(newestView().firstParent?.isVisible()).toBe(true);
    await browser.command({ tab: tab.id, action: "dock" });
    await flush();
    // close removes a suspended tab.
    await advance(BROWSER_IDLE_SUSPEND_MS);
    expect(suspended(browser, tab.id)).toBe(true);
    await browser.command({ tab: tab.id, action: "close" });
    expect(browser.state().tabs).toEqual([]);
    await expect(browser.send(tab.id, "Page.reload", {}, signal())).rejects.toThrow(
      "Browser tab closed.",
    );
  });

  it("the 24-tab limit counts suspended tabs", async () => {
    fakeTime();
    const browser = newBrowser();
    for (let index = 0; index < BROWSER_TAB_LIMIT; index++)
      await browser.open(`https://example.com/${index}`, false, signal(), `p${index}`);
    await advance(0);
    expect(browser.state().tabs.filter((tab) => tab.suspended)).toHaveLength(
      BROWSER_TAB_LIMIT - BROWSER_LIVE_TAB_LIMIT,
    );
    await expect(browser.open("https://example.com/25", false, signal(), "p25")).rejects.toThrow(
      "Close a browser tab before opening another (24 tab limit).",
    );
  });

  it("dispose clears the budget timer", async () => {
    fakeTime();
    const browser = newBrowser();
    await browser.open("https://example.com/", false, signal(), "project");
    expect(vi.getTimerCount()).toBe(1);
    browser.dispose();
    expect(vi.getTimerCount()).toBe(0);
    const views = fakeElectronState.views.length;
    await advance(11 * MINUTE);
    expect(fakeElectronState.views).toHaveLength(views);
    expect(browser.state().tabs).toEqual([]);
  });
});

describe("element picker", () => {
  /** A tab docked in a visible Ryco window, as the Browser panel shows it. */
  async function dockedTab(browser: EmbeddedComputerBrowser, owner = fakeOwnerWindow()) {
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    browser.surface(
      { owner: "owner", tab: tab.id, x: 0, y: 0, width: 800, height: 600 },
      owner as unknown as BrowserWindow,
    );
    return { id: tab.id, owner, ...fakeTab(tab.id) };
  }
  const picker = (browser: EmbeddedComputerBrowser, id: string) =>
    browser.state().tabs.find((tab) => tab.id === id)?.picker;
  const overlayCommands = (commands: ReadonlyArray<{ method: string }>) =>
    commands.filter(({ method }) => method.startsWith("Overlay.") || method.startsWith("DOM."));
  function agentContext(args: Record<string, unknown>): ComputerOperationContext {
    return {
      request: { sessionId: "session", threadId: "thread", turnId: "turn", tool: "browser", args },
      signal: signal(),
      check: vi.fn(),
      authorizeApp: vi.fn(async () => undefined),
      authorizeForeground: vi.fn(async () => undefined),
      claim: vi.fn(),
      activity: vi.fn(async () => undefined),
    };
  }

  it("gives a session the picker opened focus emulation first, and the agent shares it", async () => {
    const browser = newBrowser();
    const { id, contents } = await dockedTab(browser);
    const pending = browser.pick(id);
    await flush();
    expect(picker(browser, id)).toBe("picking");
    expect(
      contents.debugger.commands.slice(0, READY.length + 1).map(({ method }) => method),
    ).toEqual([...READY, "DOM.enable"]);
    await browser.send(id, "Runtime.evaluate", { expression: "1" }, signal());
    expect(contents.debugger.attach).toHaveBeenCalledTimes(1);
    expect(
      contents.debugger.commands.filter(
        ({ method }) => method === "Emulation.setFocusEmulationEnabled",
      ),
    ).toHaveLength(1);
    await browser.command({ tab: id, action: "end-pick" });
    await expect(pending).resolves.toEqual({ kind: "cancelled", reason: "user" });
  });

  it("keeps a user's pick through stop()", async () => {
    const browser = newBrowser();
    const { id, contents } = await dockedTab(browser);
    void browser.pick(id);
    await flush();
    await browser.send(id, "Page.reload", {}, signal());
    browser.stop();
    expect(contents.stop).toHaveBeenCalled();
    expect(contents.debugger.isAttached()).toBe(true);
    expect(contents.debugger.detach).not.toHaveBeenCalled();
    expect(picker(browser, id)).toBe("picking");
  });

  it("keeps a pick while the agent reads the page", async () => {
    const browser = newBrowser();
    const { id, contents } = await dockedTab(browser);
    void browser.pick(id);
    await flush();
    const before = overlayCommands(contents.debugger.commands).length;
    await browser.send(id, "Page.getFrameTree", {}, signal());
    await browser.send(id, "Runtime.evaluate", { expression: "document.title" }, signal());
    await browser.send(id, "Page.captureScreenshot", { format: "png" }, signal());
    expect(picker(browser, id)).toBe("picking");
    expect(overlayCommands(contents.debugger.commands)).toHaveLength(before);
  });

  it("ends a pick before a mutating agent action and refuses new picks until it settles", async () => {
    const browser = newBrowser();
    const { id, contents } = await dockedTab(browser);
    let releaseDisable!: (value: unknown) => void;
    contents.debugger.respond = (method) =>
      method === "DOM.disable"
        ? new Promise((resolve) => {
            releaseDisable = resolve;
          })
        : {};
    const pending = browser.pick(id);
    await flush();
    const from = contents.debugger.commands.length;
    let begun = false;
    const bracket = browser.beginAgentMutation(id, signal()).then((end) => {
      begun = true;
      return end;
    });
    await expect(pending).resolves.toEqual({ kind: "cancelled", reason: "agent" });
    await flush();
    // The action's first command waits until inspect mode is off.
    expect(begun).toBe(false);
    expect(contents.debugger.commands.slice(from)).toEqual([
      { method: "Target.setAutoAttach", params: NO_AUTO_ATTACH },
      { method: "Overlay.setInspectMode", params: INSPECT_MODE_OFF },
      { method: "Overlay.hideHighlight", params: {} },
      { method: "Overlay.disable", params: {} },
      { method: "DOM.disable", params: {} },
    ]);
    releaseDisable({});
    const end = await bracket;
    expect(begun).toBe(true);
    expect(picker(browser, id)).toBeUndefined();
    await expect(browser.pick(id)).rejects.toThrow(
      "The agent is using this tab right now. Try again in a moment.",
    );
    end();
    end(); // Idempotent.
    const next = browser.pick(id);
    await flush();
    expect(picker(browser, id)).toBe("picking");
    await browser.command({ tab: id, action: "end-pick" });
    await expect(next).resolves.toEqual({ kind: "cancelled", reason: "user" });
  });

  it("brackets an action on a tab that closed meanwhile without failing", async () => {
    const browser = newBrowser();
    const end = await browser.beginAgentMutation("missing", signal());
    expect(() => end()).not.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(browser.beginAgentMutation("missing", controller.signal)).rejects.toThrow();
  });

  it("lets agent reads through the driver keep a pick, and ends it before a mutating action's first command", async () => {
    const browser = newBrowser();
    const { id, contents } = await dockedTab(browser);
    contents.debugger.respond = (method) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "frame", loaderId: "loader" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 3 };
      if (method === "Runtime.evaluate")
        return { result: { value: { title: "", url: "", text: "", elements: [] } } };
      return {};
    };
    const driver = new BrowserComputerDriver(new Map([["ryco", browser]]));
    const pending = browser.pick(id);
    await flush();
    await driver.execute(agentContext({ action: "observe", tab: id }), "ryco");
    expect(picker(browser, id)).toBe("picking");
    await driver.execute(
      agentContext({ action: "navigate", tab: id, url: "https://example.com/next" }),
      "ryco",
    );
    await expect(pending).resolves.toEqual({ kind: "cancelled", reason: "agent" });
    const methods = contents.debugger.commands.map(({ method }) => method);
    expect(methods.lastIndexOf("DOM.disable")).toBeLessThan(methods.indexOf("Page.navigate"));
    expect(methods.indexOf("Page.navigate")).toBeGreaterThan(-1);
    // The bracket ended with the action.
    const next = browser.pick(id);
    await flush();
    expect(picker(browser, id)).toBe("picking");
    void browser.command({ tab: id, action: "end-pick" });
    await next;
  });

  it("refuses a tab that is not docked in a visible panel, not loaded, or in use by the agent", async () => {
    const browser = newBrowser();
    const background = await browser.open("https://example.com/", false, signal(), "project");
    await expect(browser.pick(background.id)).rejects.toThrow(
      "Show this tab in the Browser panel to pick an element.",
    );
    const owner = fakeOwnerWindow({ minimized: true });
    const { id, contents } = await dockedTab(browser, owner);
    await expect(browser.pick(id)).rejects.toThrow(
      "Show this tab in the Browser panel to pick an element.",
    );
    owner.minimized = false;
    contents.url = "about:blank";
    await expect(browser.pick(id)).rejects.toThrow("Load a page before picking an element.");
    contents.url = "https://example.com/";
    contents.emit("did-fail-load", fakeEvent(), -105, "Name not resolved", contents.url, true);
    await expect(browser.pick(id)).rejects.toThrow("Load a page before picking an element.");
    contents.emit("did-start-loading");
    let answer!: (value: unknown) => void;
    contents.debugger.respond = (method) =>
      method === "Runtime.evaluate"
        ? new Promise((resolve) => {
            answer = resolve;
          })
        : {};
    const agent = browser.send(id, "Runtime.evaluate", {}, signal());
    await expect(browser.pick(id)).rejects.toThrow(
      "The agent is using this tab right now. Try again in a moment.",
    );
    await flush();
    answer({});
    await agent;
    const pending = browser.pick(id);
    await flush();
    expect(picker(browser, id)).toBe("picking");
    void browser.command({ tab: id, action: "end-pick" });
    await pending;
    expect(contents.debugger.attach).toHaveBeenCalledTimes(1);
  });

  it("shows the pick in state() and settles it when the tab closes", async () => {
    const browser = newBrowser();
    const { id, contents } = await dockedTab(browser);
    expect(browser.state().tabs[0]).not.toHaveProperty("picker");
    contents.debugger.respond = (method, params) =>
      method === "Runtime.callFunctionOn"
        ? (params as { functionDeclaration?: unknown }).functionDeclaration ===
          BROWSER_ELEMENT_PAGE_NODE_FUNCTION
          ? { result: { type: "undefined" } }
          : { result: { value: { selector: "#save", tagName: "BUTTON", role: "button" } } }
        : method === "Page.getFrameTree"
          ? { frameTree: { frame: { id: "frame", loaderId: "loader" } } }
          : method === "Page.createIsolatedWorld"
            ? { executionContextId: 3 }
            : method === "DOM.resolveNode"
              ? { object: { objectId: "object" } }
              : {};
    const published: Array<string | undefined> = [];
    browser.onState((state) => published.push(state.tabs[0]?.picker));
    const pending = browser.pick(id);
    await flush();
    expect(picker(browser, id)).toBe("picking");
    contents.debugger.message("Overlay.inspectNodeRequested", { backendNodeId: 5 });
    await expect(pending).resolves.toMatchObject({
      kind: "picked",
      element: { url: "https://example.com/", selector: "#save", tagName: "button" },
    });
    expect(picker(browser, id)).toBe("picked");
    expect(published).toContain("picking");
    expect(published.at(-1)).toBe("picked");
    const next = browser.pick(id);
    await flush();
    await browser.close(id, signal());
    await expect(next).resolves.toEqual({ kind: "cancelled", reason: "destroyed" });
    expect(browser.state().tabs).toEqual([]);
  });

  it.each([
    ["Escape in the page", "user"],
    ["a navigation", "navigation"],
    ["a renderer crash", "destroyed"],
    ["hiding the surface", "hidden"],
    ["popping the tab out", "hidden"],
    ["end-pick", "user"],
  ] as const)("ends a pick on %s", async (trigger, reason) => {
    const browser = newBrowser();
    const { id, contents } = await dockedTab(browser);
    const pending = browser.pick(id);
    await flush();
    if (trigger === "Escape in the page") {
      const event = fakeEvent();
      contents.emit("before-input-event", event, { type: "keyDown", key: "Escape" });
      expect(event.defaultPrevented).toBe(true);
    } else if (trigger === "a navigation") {
      // A same-document navigation keeps the pick.
      contents.emit("did-start-navigation", fakeEvent(), "https://example.com/#a", true, true);
      expect(picker(browser, id)).toBe("picking");
      contents.emit("did-start-navigation", fakeEvent(), "https://example.com/next", false, true);
    } else if (trigger === "a renderer crash") {
      contents.emit("render-process-gone", fakeEvent(), { reason: "crashed" });
    } else if (trigger === "hiding the surface") {
      browser.surface(
        { owner: "owner", tab: null, x: 0, y: 0, width: 0, height: 0 },
        fakeOwnerWindow() as unknown as BrowserWindow,
      );
    } else if (trigger === "popping the tab out") {
      await browser.command({ tab: id, action: "popout" });
    } else {
      await browser.command({ tab: id, action: "end-pick" });
      // The picker held the session alone, so ending it detached.
      expect(contents.debugger.isAttached()).toBe(false);
    }
    await expect(pending).resolves.toEqual({ kind: "cancelled", reason });
    expect(picker(browser, id)).toBeUndefined();
  });

  it("leaves Escape to the page when no pick is choosing", async () => {
    const browser = newBrowser();
    const { contents } = await dockedTab(browser);
    const event = fakeEvent();
    contents.emit("before-input-event", event, { type: "keyDown", key: "Escape" });
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("uploaded files", () => {
  it("resets a tab when its main frame commits a new document or its page is torn down", async () => {
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    const reset = vi.fn<(tab: string) => void>();
    browser.onTabReset(reset);
    const old = fakeTab(tab.id).contents;
    // Same document: the page keeps the files its inputs hold.
    old.emit("did-navigate-in-page", fakeEvent(), "https://example.com/#step-2", true);
    expect(reset).not.toHaveBeenCalled();
    old.emit("did-navigate", fakeEvent(), "https://example.com/next", 200, "OK");
    expect(reset).toHaveBeenLastCalledWith(tab.id);
    // browser-tab-budget's suspension tears the page down: after the automation is disposed,
    // before the debugger session ends.
    const inner = internals(browser);
    const entry = inner.entries.get(tab.id)!;
    const page = entry.live!;
    const automationDispose = vi.spyOn(browser.automation(tab.id)!, "dispose");
    const cdpDispose = vi.spyOn(page.cdp, "dispose");
    entry.live = null;
    inner.teardownPage(tab.id, page);
    expect(reset).toHaveBeenCalledTimes(2);
    expect(automationDispose.mock.invocationCallOrder[0]).toBeLessThan(
      reset.mock.invocationCallOrder[1]!,
    );
    expect(reset.mock.invocationCallOrder[1]).toBeLessThan(cdpDispose.mock.invocationCallOrder[0]!);
    entry.live = inner.createPage(entry, tab.id).page;
    // The torn-down page's late events reach nothing; the new page's do.
    old.emit("did-navigate", fakeEvent(), "https://stale.example/", 200, "OK");
    expect(reset).toHaveBeenCalledTimes(2);
    fakeElectronState.views
      .at(-1)!
      .webContents.emit("did-navigate", fakeEvent(), "https://x/", 200);
    expect(reset).toHaveBeenCalledTimes(3);
    await browser.close(tab.id, signal());
    expect(reset).toHaveBeenCalledTimes(4);
    // Every remaining tab is reset when the browser goes away; unsubscribed listeners hear nothing.
    const other = await browser.open("https://example.org/", false, signal(), "project");
    const late = vi.fn();
    browser.onTabReset(late)();
    browser.dispose();
    expect(reset).toHaveBeenLastCalledWith(other.id);
    expect(late).not.toHaveBeenCalled();
  });

  it("resets a tab whose renderer crashed, so its copies stop counting against the quotas", async () => {
    const browser = newBrowser();
    const tab = await browser.open("https://example.com/", false, signal(), "project");
    const reset = vi.fn<(tab: string) => void>();
    browser.onTabReset(reset);
    fakeTab(tab.id).contents.emit("render-process-gone", fakeEvent(), {
      reason: "crashed",
      exitCode: 1,
    });
    expect(reset).toHaveBeenCalledExactlyOnceWith(tab.id);
    // The tab itself stays (the user can reload it).
    expect((await browser.tabs(signal())).map(({ id }) => id)).toContain(tab.id);
  });
});
