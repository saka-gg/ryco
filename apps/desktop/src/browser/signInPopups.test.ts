import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { HandlerDetails, WebContents, WindowOpenHandlerResponse } from "electron";
const construction = vi.hoisted(() => ({ fail: false }));
const windows = vi.hoisted(() => [] as unknown[]);
vi.mock("electron", () => ({
  BrowserWindow: class extends EventEmitter {
    options: unknown;
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      getURL: () => "https://id.example/login",
    });
    showInactive = vi.fn();
    setTitle = vi.fn();
    constructor(options: unknown) {
      super();
      if (construction.fail) throw new Error("fixture construction failed");
      this.options = options;
      windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
  },
}));
import { SignInPopups, isSignInNavigation } from "./signInPopups.ts";
function setup() {
  let handler: (details: HandlerDetails) => WindowOpenHandlerResponse = () => ({ action: "deny" });
  const session = {};
  const opener = {
    session,
    setWindowOpenHandler: (fn: typeof handler) => {
      handler = fn;
    },
  };
  const foreground = vi.fn(() => true);
  const popups = new SignInPopups(vi.fn());
  popups.install("tab", opener as unknown as WebContents, foreground);
  const request = (url = "https://id.example/login", disposition = "new-window") =>
    handler({ url, disposition } as HandlerDetails);
  const create = () => {
    const response = request();
    expect(response.action).toBe("allow");
    const contents = response.createWindow!(response.overrideBrowserWindowOptions!);
    const window = windows.at(-1) as EventEmitter & {
      options: { webPreferences: Record<string, unknown>; show: boolean };
      showInactive: ReturnType<typeof vi.fn>;
      isDestroyed: () => boolean;
    };
    return { contents, window, response };
  };
  return { popups, foreground, request, create, session };
}
afterEach(() => {
  construction.fail = false;
  vi.useRealTimers();
  windows.length = 0;
});
describe("sign-in popup boundary", () => {
  it.each([
    "file:///tmp/a",
    "javascript:alert(1)",
    "data:text/html,x",
    "ryco://auth",
    "http://id.example",
    "https://user:password@id.example",
    "about:blank#x",
  ])("denies %s", (url) => expect(isSignInNavigation(url)).toBe(false));
  it.each([
    "about:blank",
    "https://id.example/auth",
    "http://127.0.0.1:1234/callback",
    "http://localhost:1234",
    "http://[::1]:1234",
  ])("allows %s", (url) => expect(isSignInNavigation(url)).toBe(true));
  it("requires a one-use grant, rejects background attempts and expires", () => {
    vi.useFakeTimers();
    const { popups, request, foreground } = setup();
    expect(request().action).toBe("deny");
    popups.arm("tab");
    foreground.mockReturnValue(false);
    expect(request().action).toBe("deny");
    foreground.mockReturnValue(true);
    expect(request().action).toBe("deny");
    popups.arm("tab");
    expect(request(undefined, "background-tab").action).toBe("deny");
    popups.arm("tab");
    vi.advanceTimersByTime(30_000);
    expect(popups.state("tab")).toBe("idle");
    expect(request().action).toBe("deny");
  });
  it("preserves Electron creation, profile isolation and sandbox while limiting children", () => {
    const { popups, create, request, session } = setup();
    popups.arm("tab");
    const { contents, window, response } = create();
    expect(response.outlivesOpener).toBe(false);
    expect(window.options.show).toBe(false);
    expect(window.options.webPreferences).toMatchObject({
      session,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: false,
      webSecurity: true,
    });
    expect(window.options.webPreferences).not.toHaveProperty("preload");
    expect(request().action).toBe("deny");
    expect(() => popups.arm("other")).toThrow("Close");
    const nested = vi.mocked(contents.setWindowOpenHandler).mock.calls[0]![0];
    expect(nested({} as HandlerDetails).action).toBe("deny");
    window.emit("ready-to-show");
    expect(window.showInactive).toHaveBeenCalledOnce();
    popups.cancel("tab");
    expect(window.isDestroyed()).toBe(true);
    expect(popups.state("tab")).toBe("idle");
  });
  it("blocks redirects and child frames to external schemes before navigation", () => {
    const { popups, create } = setup();
    popups.arm("tab");
    const { contents } = create();
    for (const name of ["will-navigate", "will-redirect", "will-frame-navigate"]) {
      const event = { preventDefault: vi.fn(), url: "ryco://unsafe" };
      contents.emit(name, event, event.url);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
    popups.cancel("tab");
  });
  it("does not show late windows after a focus change or cancellation", () => {
    const { popups, create, foreground } = setup();
    popups.arm("tab");
    const { window } = create();
    foreground.mockReturnValue(false);
    window.emit("ready-to-show");
    expect(window.showInactive).not.toHaveBeenCalled();
    expect(window.isDestroyed()).toBe(true);
    popups.arm("tab");
    foreground.mockReturnValue(true);
    const next = create();
    popups.cancel("tab");
    window.emit("closed");
    next.window.emit("ready-to-show");
    expect(next.window.showInactive).not.toHaveBeenCalled();
  });
  it("recovers after renderer crash and ignores old close events", () => {
    const { popups, create } = setup();
    popups.arm("tab");
    const first = create();
    first.contents.emit("render-process-gone");
    expect(popups.state("tab")).toBe("failed");
    popups.arm("tab");
    const second = create();
    first.window.emit("closed");
    expect(popups.state("tab")).toBe("open");
    expect(second.window.isDestroyed()).toBe(false);
    popups.cancel("tab");
  });
});

it("clears a native creation reservation that Electron never completes", () => {
  vi.useFakeTimers();
  const { popups, request } = setup();
  popups.arm("tab");
  expect(request().action).toBe("allow");
  vi.advanceTimersByTime(5_000);
  expect(popups.state("tab")).toBe("failed");
  popups.arm("tab");
  expect(popups.state("tab")).toBe("armed");
  popups.cancel("tab");
});
it("reapplies sandbox options and removes inherited preload/parent", () => {
  const { popups, request, session } = setup();
  popups.arm("tab");
  const response = request();
  response.createWindow!({
    show: true,
    parent: {} as never,
    webPreferences: { preload: "/untrusted.js", nodeIntegration: true, sandbox: false },
  });
  const window = windows.at(-1) as { options: Record<string, unknown> };
  expect(window.options).not.toHaveProperty("parent");
  expect(window.options).toMatchObject({
    show: false,
    webPreferences: { session, sandbox: true, nodeIntegration: false },
  });
  expect(window.options.webPreferences).not.toHaveProperty("preload");
  popups.cancel("tab");
});
it("closes a failed main-frame load and ignores aborted/subframe loads", () => {
  const { popups, create } = setup();
  popups.arm("tab");
  const { contents, window } = create();
  contents.emit("did-fail-load", {}, -3, "aborted", "", true);
  contents.emit("did-fail-load", {}, -105, "dns", "", false);
  expect(popups.state("tab")).toBe("open");
  contents.emit("did-fail-load", {}, -105, "dns", "", true);
  expect(window.isDestroyed()).toBe(true);
  expect(popups.state("tab")).toBe("failed");
});

it("clears state when native window construction throws", () => {
  const { popups, request } = setup();
  popups.arm("tab");
  const response = request();
  construction.fail = true;
  expect(() => response.createWindow!({})).toThrow("fixture construction failed");
  expect(popups.state("tab")).toBe("failed");
  construction.fail = false;
  popups.arm("tab");
  popups.cancel("tab");
});

it("closes active sign-in on opener failure without overwriting the recovery state", () => {
  const { popups, create } = setup();
  popups.arm("tab");
  const { window, contents } = create();
  popups.fail("tab");
  expect(window.isDestroyed()).toBe(true);
  expect(popups.state("tab")).toBe("failed");
  contents.emit("render-process-gone");
  expect(popups.state("tab")).toBe("failed");
  popups.fail("tab");
  expect(popups.state("tab")).toBe("failed");
});
