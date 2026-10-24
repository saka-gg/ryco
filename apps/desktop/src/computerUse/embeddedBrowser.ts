import { BrowserWindow, WebContentsView, session } from "electron";
import type {
  ProjectBrowserCommand,
  ProjectBrowserState,
  ProjectBrowserSurface,
} from "@ryco/contracts";
import { browserUrl, type BrowserTab, type BrowserTransport } from "./browser.ts";
import { CdpLease } from "../browser/cdpLease.ts";
import { SignInPopups } from "../browser/signInPopups.ts";

/** One page of a tab: its view, hidden host window and shared debugger session. */
interface LivePage {
  readonly view: WebContentsView;
  readonly host: BrowserWindow;
  readonly cdp: CdpLease;
}
interface TabEntry {
  /** The tab's page. Null only while it is created or torn down (browser-tab-budget adds suspension). */
  live: LivePage | null;
  project: string;
  presentation: "background" | "panel" | "window";
  error: string | null;
  requestedUrl: string;
  /** Agent CDP calls in flight (withAgentCdp). browser-picker refuses to start a pick and browser-tab-budget pins the tab while > 0. */
  agentBusy: number;
}

/** One tab owner shared by manual preview and the consent-gated agent transport. */
export class EmbeddedComputerBrowser implements BrowserTransport {
  private readonly signIn = new SignInPopups(() => this.publish());
  private readonly entries = new Map<string, TabEntry>();
  private readonly listeners = new Set<(state: ProjectBrowserState) => void>();
  private profile: Electron.Session | null = null;
  private readonly owners = new WeakSet<BrowserWindow>();
  private readonly focusListeners = new Set<(tab: string) => void>();
  onFocusAddress(listener: (tab: string) => void): () => void {
    this.focusListeners.add(listener);
    return () => this.focusListeners.delete(listener);
  }
  private mounted: { owner: string; tab: string; window: BrowserWindow } | null = null;
  private fitHost(page: LivePage): void {
    const [width = 1280, height = 850] = page.host.getContentSize();
    page.view.setBounds({ x: 0, y: 0, width, height });
  }
  private getProfile(): Electron.Session {
    if (this.profile) return this.profile;
    const profile = session.fromPartition("persist:ryco-computer-browser");
    profile.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    profile.setPermissionCheckHandler(() => false);
    profile.on("will-download", (event) => event.preventDefault());
    this.profile = profile;
    return profile;
  }
  onState(listener: (state: ProjectBrowserState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  state(): ProjectBrowserState {
    return {
      tabs: [...this.entries].map(([id, entry]) => {
        const wc = this.liveOf(entry).view.webContents;
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
          signInPopup: this.signIn.state(id),
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
  /**
   * Creates a page for `entry`: its hidden host window, its view with the isolated profile, its
   * debugger session and every per-page listener. Every unit creates its per-page objects here, and
   * every per-page listener that touches the tab returns early unless this page is still current.
   */
  private createPage(entry: TabEntry, existingId?: string): { id: string; page: LivePage } {
    const host = new BrowserWindow({
      width: 1280,
      height: 850,
      show: false,
      title: "Ryco Browser",
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    const view = new WebContentsView({
      webPreferences: {
        session: this.getProfile(),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        focusOnNavigation: false,
      },
    });
    const wc = view.webContents;
    // Tab ids are the tab's first page's webContents id: the smoke scripts call
    // webContents.fromId(Number(tab.id)), and Electron never reuses ids. existingId keeps the id
    // when a tab gets a new page (browser-tab-budget's revival); open() never passes it.
    const id = existingId ?? String(wc.id);
    const cdp = new CdpLease(wc);
    // Activate the page inside Chromium, without focusing its host window or changing the
    // user's selected tab/application. Once per debugger session, whoever opened it.
    cdp.onReady((send) =>
      send("Emulation.setFocusEmulationEnabled", { enabled: true }).then(() => undefined),
    );
    const page: LivePage = { view, host, cdp };
    // Only the tab's current page may change the tab. Electron destroys contents asynchronously, so
    // a page that was torn down (closed, or replaced when the tab gets a new page) can still emit
    // events; every listener below that touches the tab starts with this check.
    const current = () => entry.live === page;
    const publish = () => {
      if (current()) this.publish();
    };
    host.once("closed", () => {
      if (current()) this.destroy(id, "host");
    });
    wc.once("destroyed", () => {
      if (current()) this.destroy(id, "guest");
    });
    host.contentView.addChildView(view);
    this.fitHost(page);
    host.on("resize", () => {
      if (!current() || entry.presentation === "panel") return;
      this.fitHost(page);
    });
    host.on("close", (event) => {
      // Closing a detached preview returns it to the browser's tab strip.
      event.preventDefault();
      if (!current()) return;
      this.signIn.cancel(id);
      host.hide();
      entry.presentation = "background";
      this.publish();
    });
    this.signIn.install(id, wc, () => this.foreground(id));
    wc.on("did-start-navigation", (_event, url, inPlace, mainFrame) => {
      if (!current()) return;
      if (mainFrame && !inPlace) this.signIn.cancel(id);
      if (mainFrame && /^https?:/u.test(url)) entry.requestedUrl = url;
    });
    wc.on("before-input-event", (event, input) => {
      if (!current() || input.type !== "keyDown") return;
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
    // Navigation validation guards every page, current or not; it changes nothing on the tab.
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
      if (!current()) return;
      entry.error = null;
      this.publish();
    });
    wc.on("did-stop-loading", publish);
    wc.on("did-navigate", publish);
    wc.on("did-navigate-in-page", publish);
    wc.on("page-title-updated", publish);
    wc.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
      if (current() && mainFrame && code !== -3) {
        entry.error = description;
        this.publish();
      }
    });
    wc.on("render-process-gone", () => {
      if (!current()) return;
      this.signIn.fail(id);
      entry.error = "This page stopped responding. Reload to recover.";
      this.publish();
    });
    return { id, page };
  }
  async open(
    url: string,
    _visible: boolean,
    signal: AbortSignal,
    project = "",
  ): Promise<BrowserTab> {
    signal.throwIfAborted();
    const target = browserUrl(url);
    if (this.entries.size >= 24)
      throw new Error("Close a browser tab before opening another (24 tab limit).");
    const entry: TabEntry = {
      live: null,
      project,
      presentation: "background",
      error: null,
      requestedUrl: target,
      agentBusy: 0,
    };
    // No Electron event can fire before the entry is registered.
    const { id, page } = this.createPage(entry);
    entry.live = page;
    this.entries.set(id, entry);
    const wc = page.view.webContents;
    const abort = () => this.destroy(id);
    signal.addEventListener("abort", abort, { once: true });
    this.publish();
    try {
      await wc.loadURL(target);
      signal.throwIfAborted();
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
  /** The window showing this tab: the Ryco window it is mounted in, or its popped-out host. */
  private presentedWindow(id: string): BrowserWindow | null {
    const entry = this.entries.get(id);
    if (!entry?.live) return null;
    if (entry.presentation === "panel" && this.mounted?.tab === id) return this.mounted.window;
    return entry.presentation === "window" ? entry.live.host : null;
  }
  /** Shown to the user: mounted in a visible, non-minimized Ryco window, or a visible pop-out. */
  presented(id: string): boolean {
    const window = this.presentedWindow(id);
    return Boolean(window && !window.isDestroyed() && window.isVisible() && !window.isMinimized());
  }
  private foreground(id: string): boolean {
    const window = this.presentedWindow(id);
    return Boolean(window && !window.isDestroyed() && window.isVisible() && window.isFocused());
  }
  private entry(id: string): TabEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Browser tab closed.");
    this.liveOf(entry);
    return entry;
  }
  /** The tab's live page, or "Browser tab closed." when it has none or its contents are gone. */
  private liveOf(entry: TabEntry): LivePage {
    const page = entry.live;
    if (!page || page.view.webContents.isDestroyed()) throw new Error("Browser tab closed.");
    return page;
  }
  private unmount(): void {
    const mounted = this.mounted;
    this.mounted = null;
    if (!mounted) return;
    this.signIn.cancel(mounted.tab);
    const entry = this.entries.get(mounted.tab);
    if (!entry) return;
    const page = entry.live;
    if (page) {
      if (!mounted.window.isDestroyed()) mounted.window.contentView.removeChildView(page.view);
      if (!page.host.isDestroyed()) page.host.contentView.addChildView(page.view);
      const { width, height } = page.view.getBounds();
      page.view.setBounds({ x: 0, y: 0, width, height });
    }
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
    const page = this.liveOf(entry);
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
      page.host.hide();
      page.host.contentView.removeChildView(page.view);
      ownerWindow.contentView.addChildView(page.view);
      this.mounted = { owner: input.owner, tab: input.tab, window: ownerWindow };
      entry.presentation = "panel";
    }
    page.view.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    });
    if (changed) this.publish();
  }
  async show(tab: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    // Agent presentation never creates a native window. The user can view
    // this retained tab in the workspace panel or explicitly choose Pop out.
    this.entry(tab);
  }
  private destroy(tab: string, destroyed?: "guest" | "host"): void {
    const entry = this.entries.get(tab);
    if (!entry) return;
    // Remove ownership before Electron emits nested close/destroy events. A closing guest
    // must never be reparented or asked to close again from its own destroyed callback.
    this.entries.delete(tab);
    this.signIn.cancel(tab);
    const page = entry.live;
    entry.live = null;
    if (this.mounted?.tab === tab) {
      const { window } = this.mounted;
      this.mounted = null;
      if (page && !window.isDestroyed()) window.contentView.removeChildView(page.view);
    }
    if (page) this.teardownPage(tab, page, destroyed);
    this.publish();
  }
  /**
   * The single place a page's per-page state ends: every unit's per-page teardown, then its
   * debugger session, then the page itself. `destroyed` names the side Electron already destroyed.
   */
  private teardownPage(id: string, page: LivePage, destroyed?: "guest" | "host"): void {
    page.cdp.dispose();
    const wc = page.view.webContents;
    if (destroyed !== "guest" && !wc.isDestroyed()) wc.close({ waitForBeforeUnload: false });
    if (destroyed !== "host" && !page.host.isDestroyed()) page.host.destroy();
  }
  async close(tab: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.destroy(tab);
  }
  async command(input: ProjectBrowserCommand): Promise<void> {
    const entry = this.entry(input.tab),
      page = this.liveOf(entry),
      wc = page.view.webContents;
    switch (input.action) {
      case "allow-sign-in":
        if (!this.foreground(input.tab))
          throw new Error("Show and focus this browser tab before allowing sign-in.");
        this.signIn.arm(input.tab);
        break;
      case "cancel-sign-in":
        this.signIn.cancel(input.tab);
        break;
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
        this.fitHost(page);
        page.host.show();
        break;
      case "dock":
        this.signIn.cancel(input.tab);
        if (entry.presentation === "window") {
          page.host.hide();
          entry.presentation = "background";
        }
        break;
    }
    this.publish();
  }
  async capture(tab: string): Promise<string> {
    const image = await this.liveOf(this.entry(tab)).view.webContents.capturePage();
    return image.resize({ width: 640 }).toDataURL();
  }
  /** Sign-in rules for agent control: an open popup refuses it; an armed grant is cancelled. */
  private guard(tab: string): void {
    if (this.signIn.state(tab) === "open")
      throw new Error("Finish or close the sign-in popup before agent browser control resumes.");
    if (this.signIn.state(tab) === "armed") this.signIn.cancel(tab);
  }
  /**
   * Agent CDP work on one tab: sign-in rules, the page's shared session held as "agent", its ready
   * steps, the 15 s guard and abort. Every agent path into a page's debugger goes through here.
   */
  private async withAgentCdp<T>(
    tab: string,
    signal: AbortSignal,
    run: (cdp: CdpLease) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    this.guard(tab);
    const entry = this.entry(tab);
    const { cdp } = this.liveOf(entry);
    const first = cdp.acquire("agent");
    // Only the agent's own hold ends: another holder (a user's pick) keeps the session.
    const release = () => cdp.release("agent");
    signal.addEventListener("abort", release, { once: true });
    entry.agentBusy++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        (async () => {
          await cdp.ready(); // Focus emulation (and other units' steps), once per attachment.
          signal.throwIfAborted();
          return run(cdp);
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            release();
            reject(new Error("Browser command timed out."));
          }, 15_000);
        }),
      ]);
      signal.throwIfAborted();
      return value;
    } catch (error) {
      if (first) release();
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", release);
      entry.agentBusy--;
    }
  }
  async send(
    tab: string,
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.withAgentCdp(tab, signal, (cdp) => cdp.send(method, params));
  }
  stop(): void {
    for (const [id, entry] of this.entries) {
      this.signIn.cancel(id);
      const page = entry.live;
      if (!page || page.view.webContents.isDestroyed()) continue;
      page.view.webContents.stop();
      // Emergency stop ends the agent's hold only; another holder keeps its session.
      page.cdp.release("agent");
    }
  }
  dispose(): void {
    this.listeners.clear();
    this.focusListeners.clear();
    for (const id of this.entries.keys()) this.destroy(id);
  }
}
