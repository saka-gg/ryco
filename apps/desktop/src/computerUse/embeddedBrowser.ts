import { BrowserWindow, WebContentsView, session } from "electron";
import type {
  ProjectBrowserCommand,
  ProjectBrowserState,
  ProjectBrowserSurface,
} from "@ryco/contracts";
import { browserUrl, type BrowserTab, type BrowserTransport } from "./browser.ts";

interface TabEntry {
  view: WebContentsView;
  host: BrowserWindow;
  project: string;
  presentation: "background" | "panel" | "window";
  error: string | null;
  requestedUrl: string;
}

/** One tab owner shared by manual preview and the consent-gated agent transport. */
export class EmbeddedComputerBrowser implements BrowserTransport {
  private readonly entries = new Map<string, TabEntry>();
  private readonly listeners = new Set<(state: ProjectBrowserState) => void>();
  private readonly profile = session.fromPartition("persist:ryco-computer-browser");
  private readonly owners = new WeakSet<BrowserWindow>();
  private readonly focusListeners = new Set<(tab: string) => void>();
  onFocusAddress(listener: (tab: string) => void): () => void {
    this.focusListeners.add(listener);
    return () => this.focusListeners.delete(listener);
  }
  private mounted: { owner: string; tab: string; window: BrowserWindow } | null = null;
  private fitHost(entry: TabEntry): void {
    const [width = 1280, height = 850] = entry.host.getContentSize();
    entry.view.setBounds({ x: 0, y: 0, width, height });
  }
  constructor() {
    this.profile.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.profile.setPermissionCheckHandler(() => false);
    this.profile.on("will-download", (event) => event.preventDefault());
  }
  onState(listener: (state: ProjectBrowserState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  state(): ProjectBrowserState {
    return {
      tabs: [...this.entries].map(([id, entry]) => {
        const wc = entry.view.webContents;
        return {
          id,
          project: entry.project,
          title: wc.getTitle(),
          url: entry.error ? entry.requestedUrl : wc.getURL() || entry.requestedUrl,
          loading: wc.isLoading(),
          canGoBack: wc.navigationHistory.canGoBack(),
          canGoForward: wc.navigationHistory.canGoForward(),
          zoom: wc.getZoomFactor(),
          presentation: entry.presentation,
          error: entry.error,
        };
      }),
    };
  }
  private publish(): void {
    const state = this.state();
    for (const listener of this.listeners) listener(state);
  }
  async tabs(signal: AbortSignal): Promise<BrowserTab[]> {
    signal.throwIfAborted();
    return this.state().tabs.map(({ id, title, url }) => ({ id, title, url }));
  }
  async open(
    url: string,
    visible: boolean,
    signal: AbortSignal,
    project = "",
  ): Promise<BrowserTab> {
    signal.throwIfAborted();
    const target = browserUrl(url);
    if (this.entries.size >= 24)
      throw new Error("Close a browser tab before opening another (24 tab limit).");
    const host = new BrowserWindow({
      width: 1280,
      height: 850,
      show: false,
      title: "Ryco Browser",
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    const view = new WebContentsView({
      webPreferences: {
        session: this.profile,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        focusOnNavigation: false,
      },
    });
    const wc = view.webContents;
    const id = String(wc.id);
    const entry: TabEntry = {
      view,
      host,
      project,
      presentation: visible ? "window" : "background",
      error: null,
      requestedUrl: target,
    };
    this.entries.set(id, entry);
    host.once("closed", () => this.destroy(id, "host"));
    wc.once("destroyed", () => this.destroy(id, "guest"));
    host.contentView.addChildView(view);
    this.fitHost(entry);
    host.on("resize", () => {
      if (entry.presentation === "panel") return;
      this.fitHost(entry);
    });
    host.on("close", (event) => {
      // Closing a detached preview returns it to the browser's tab strip.
      event.preventDefault();
      host.hide();
      entry.presentation = "background";
      this.publish();
    });
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("did-start-navigation", (_event, url, _inPlace, mainFrame) => {
      if (mainFrame && /^https?:/u.test(url)) entry.requestedUrl = url;
    });
    wc.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const commandKey = process.platform === "darwin" ? input.meta : input.control;
      if (commandKey && !input.alt && input.key.toLowerCase() === "l") {
        event.preventDefault();
        for (const listener of this.focusListeners) listener(id);
      } else if (commandKey && !input.alt && input.key.toLowerCase() === "r") {
        event.preventDefault();
        wc.reload();
      } else if (commandKey && !input.alt && input.key.toLowerCase() === "w") {
        event.preventDefault();
        this.destroy(id);
      }
    });
    const validateNavigation = (event: Electron.Event, navigation: string) => {
      try {
        browserUrl(navigation);
      } catch {
        event.preventDefault();
      }
    };
    wc.on("will-navigate", validateNavigation);
    wc.on("will-redirect", validateNavigation);
    wc.on("did-start-loading", () => {
      entry.error = null;
      this.publish();
    });
    wc.on("did-stop-loading", () => this.publish());
    wc.on("did-navigate", () => this.publish());
    wc.on("did-navigate-in-page", () => this.publish());
    wc.on("page-title-updated", () => this.publish());
    wc.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) {
        entry.error = description;
        this.publish();
      }
    });
    wc.on("render-process-gone", () => {
      entry.error = "This page stopped responding. Reload to recover.";
      this.publish();
    });
    const abort = () => this.destroy(id);
    signal.addEventListener("abort", abort, { once: true });
    this.publish();
    try {
      await wc.loadURL(target);
      signal.throwIfAborted();
      if (visible) host.showInactive();
      return { id, title: wc.getTitle(), url: wc.getURL() };
    } catch (error) {
      if (signal.aborted) {
        abort();
        throw error;
      }
      if (!this.entries.has(id)) throw error;
      // Keep failed manual pages visible so the user can retry/edit the URL.
      if (!project) {
        abort();
        throw error;
      }
      return { id, title: "Could not load page", url: target };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  private entry(id: string): TabEntry {
    const entry = this.entries.get(id);
    if (!entry || entry.view.webContents.isDestroyed()) throw new Error("Browser tab closed.");
    return entry;
  }
  private unmount(): void {
    const mounted = this.mounted;
    this.mounted = null;
    if (!mounted) return;
    const entry = this.entries.get(mounted.tab);
    if (!entry) return;
    if (!mounted.window.isDestroyed()) mounted.window.contentView.removeChildView(entry.view);
    if (!entry.host.isDestroyed()) entry.host.contentView.addChildView(entry.view);
    const { width, height } = entry.view.getBounds();
    entry.view.setBounds({ x: 0, y: 0, width, height });
    entry.presentation = "background";
  }
  surface(input: ProjectBrowserSurface, ownerWindow: BrowserWindow): void {
    if (input.tab === null) {
      if (this.mounted?.owner === input.owner) {
        this.unmount();
        this.publish();
      }
      return;
    }
    if (!this.owners.has(ownerWindow)) {
      this.owners.add(ownerWindow);
      const detach = () => {
        if (this.mounted?.window === ownerWindow) {
          this.unmount();
          this.publish();
        }
      };
      ownerWindow.on("closed", detach);
      ownerWindow.webContents.on("render-process-gone", detach);
      ownerWindow.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) detach();
      });
    }
    const entry = this.entry(input.tab);
    if (entry.presentation === "window") return;
    const [windowWidth = 0, windowHeight = 0] = ownerWindow.getContentSize();
    // Renderer rectangles use CSS pixels; native view bounds use device-independent pixels.
    const scale = ownerWindow.webContents.getZoomFactor();
    const x = input.x * scale,
      y = input.y * scale,
      width = input.width * scale,
      height = input.height * scale;
    if (
      ![x, y, width, height].every(Number.isFinite) ||
      x < 0 ||
      y < 0 ||
      width < 1 ||
      height < 1 ||
      x + width > windowWidth + 1 ||
      y + height > windowHeight + 1
    )
      throw new Error("Invalid browser surface bounds.");
    const changed = this.mounted?.tab !== input.tab || this.mounted?.owner !== input.owner;
    if (changed) {
      this.unmount();
      entry.host.hide();
      entry.host.contentView.removeChildView(entry.view);
      ownerWindow.contentView.addChildView(entry.view);
      this.mounted = { owner: input.owner, tab: input.tab, window: ownerWindow };
      entry.presentation = "panel";
    }
    entry.view.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    });
    if (changed) this.publish();
  }
  async show(tab: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const entry = this.entry(tab);
    if (entry.presentation === "panel") return;
    entry.presentation = "window";
    this.fitHost(entry);
    entry.host.showInactive();
    this.publish();
  }
  private destroy(tab: string, destroyed?: "guest" | "host"): void {
    const entry = this.entries.get(tab);
    if (!entry) return;
    // Remove ownership before Electron emits nested close/destroy events. A closing guest
    // must never be reparented or asked to close again from its own destroyed callback.
    this.entries.delete(tab);
    if (this.mounted?.tab === tab) {
      const { window } = this.mounted;
      this.mounted = null;
      if (!window.isDestroyed()) window.contentView.removeChildView(entry.view);
    }
    if (destroyed !== "guest" && !entry.view.webContents.isDestroyed())
      entry.view.webContents.close({ waitForBeforeUnload: false });
    if (destroyed !== "host" && !entry.host.isDestroyed()) entry.host.destroy();
    this.publish();
  }
  async close(tab: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.destroy(tab);
  }
  async command(input: ProjectBrowserCommand): Promise<void> {
    const entry = this.entry(input.tab),
      wc = entry.view.webContents;
    switch (input.action) {
      case "navigate":
        await wc.loadURL(browserUrl(input.url ?? ""));
        break;
      case "back":
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        break;
      case "forward":
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
        break;
      case "reload":
        wc.reload();
        break;
      case "stop":
        wc.stop();
        break;
      case "close":
        this.destroy(input.tab);
        break;
      case "zoom":
        if (!Number.isFinite(input.zoom) || input.zoom! < 0.25 || input.zoom! > 3)
          throw new Error("Invalid zoom.");
        wc.setZoomFactor(input.zoom!);
        break;
      case "devtools":
        wc.openDevTools({ mode: "detach" });
        break;
      case "popout":
        if (this.mounted?.tab === input.tab) this.unmount();
        entry.presentation = "window";
        this.fitHost(entry);
        entry.host.show();
        break;
      case "dock":
        entry.host.hide();
        entry.presentation = "background";
        break;
    }
    this.publish();
  }
  async capture(tab: string): Promise<string> {
    const image = await this.entry(tab).view.webContents.capturePage();
    return image.resize({ width: 640 }).toDataURL();
  }
  async send(
    tab: string,
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const wc = this.entry(tab).view.webContents;
    const debuggerApi = wc.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
    const abort = () => {
      if (!wc.isDestroyed() && debuggerApi.isAttached()) debuggerApi.detach();
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
    for (const { view } of this.entries.values()) {
      const wc = view.webContents;
      if (wc.isDestroyed()) continue;
      wc.stop();
      if (wc.debugger.isAttached()) wc.debugger.detach();
    }
  }
  dispose(): void {
    this.listeners.clear();
    this.focusListeners.clear();
    for (const id of this.entries.keys()) this.destroy(id);
  }
}
