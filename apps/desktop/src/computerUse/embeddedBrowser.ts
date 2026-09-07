import { BrowserWindow, session } from "electron";
import type { BrowserTab, BrowserTransport } from "./browser.ts";

/** Own browser profile, no Ryco preload or IPC, and no automatic external-protocol launches. */
export class EmbeddedComputerBrowser implements BrowserTransport {
  private windows = new Map<string, BrowserWindow>();
  private profile = session.fromPartition("persist:ryco-computer-browser");
  constructor() {
    this.profile.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.profile.setPermissionCheckHandler(() => false);
    this.profile.on("will-download", (event) => event.preventDefault());
  }
  async tabs(_signal: AbortSignal): Promise<BrowserTab[]> {
    return [...this.windows]
      .filter(([, window]) => !window.isDestroyed())
      .map(([id, window]) => ({
        id,
        title: window.webContents.getTitle(),
        url: window.webContents.getURL(),
      }));
  }
  async open(url: string, visible: boolean, signal: AbortSignal): Promise<BrowserTab> {
    signal.throwIfAborted();
    const window = new BrowserWindow({
      width: 1280,
      height: 850,
      show: false,
      title: "Ryco Browser",
      webPreferences: {
        session: this.profile,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    const id = String(window.webContents.id);
    this.windows.set(id, window);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, target) => {
      if (!/^https?:\/\//iu.test(target)) event.preventDefault();
    });
    window.webContents.on("will-redirect", (event, target) => {
      if (!/^https?:\/\//iu.test(target)) event.preventDefault();
    });
    window.on("closed", () => this.windows.delete(id));
    const abort = () => {
      if (!window.isDestroyed()) window.destroy();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await window.loadURL(url);
      signal.throwIfAborted();
      if (visible) window.showInactive();
      return { id, title: window.webContents.getTitle(), url: window.webContents.getURL() };
    } catch (error) {
      abort();
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  private window(id: string): BrowserWindow {
    const window = this.windows.get(id);
    if (!window || window.isDestroyed()) throw new Error("Browser tab closed.");
    return window;
  }
  async show(tab: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.window(tab).showInactive();
  }
  async close(tab: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.window(tab).destroy();
  }
  async send(
    tab: string,
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const window = this.window(tab);
    const debuggerApi = window.webContents.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
    const abort = () => {
      if (!window.isDestroyed() && debuggerApi.isAttached()) debuggerApi.detach();
    };
    signal.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        debuggerApi.sendCommand(method, params),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            abort();
            reject(new Error("Browser command timed out."));
          }, 15_000);
        }),
      ]);
      signal.throwIfAborted();
      return value;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  stop(): void {
    for (const window of this.windows.values()) {
      if (window.isDestroyed()) continue;
      window.webContents.stop();
      if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
    }
  }
  dispose(): void {
    for (const window of this.windows.values()) if (!window.isDestroyed()) window.destroy();
    this.windows.clear();
  }
}
