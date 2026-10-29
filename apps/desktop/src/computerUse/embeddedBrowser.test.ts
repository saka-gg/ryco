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

const browsers: EmbeddedComputerBrowser[] = [];
function newBrowser(): EmbeddedComputerBrowser {
  const browser = new EmbeddedComputerBrowser();
  browsers.push(browser);
  return browser;
}
const signal = () => new AbortController().signal;
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
      backgroundThrottling: false,
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
      "Emulation.setFocusEmulationEnabled",
      "Page.navigate",
      "Emulation.setFocusEmulationEnabled",
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
      expect(api.commands.slice(-2).map(({ method }) => method)).toEqual([
        "Emulation.setFocusEmulationEnabled",
        "Page.reload",
      ]);
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
      "Emulation.setFocusEmulationEnabled",
      "Page.reload",
      "Emulation.setFocusEmulationEnabled",
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
      "Emulation.setFocusEmulationEnabled",
      "Page.reload",
    ]);
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
  expect(fresh.debugger.commands.map(({ method }) => method)).toEqual([
    "Emulation.setFocusEmulationEnabled",
    "Page.reload",
  ]);
});
