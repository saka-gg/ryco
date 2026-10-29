import {
  BrowserWindow,
  WebContentsView,
  session,
  type NativeImage,
  type WebContents,
} from "electron";
import type {
  ProjectBrowserCommand,
  ProjectBrowserState,
  ProjectBrowserSurface,
} from "@ryco/contracts";
import {
  browserUrl,
  type BrowserTab,
  type BrowserTabRevival,
  type BrowserTransport,
} from "./browser.ts";
import {
  BROWSER_PREVIEW_HOLD_MS,
  BROWSER_REVIVE_WAIT_MS,
  BROWSER_TAB_LIMIT,
  planTabBudget,
} from "./browserTabBudget.ts";
import { COMPUTER_TARGET_CLAIM_MS } from "./policy.ts";
import { CdpLease } from "../browser/cdpLease.ts";
import { SignInPopups } from "../browser/signInPopups.ts";

/** One page of a tab: its view, hidden host window and shared debugger session. */
interface LivePage {
  readonly view: WebContentsView;
  readonly host: BrowserWindow;
  readonly cdp: CdpLease;
  /**
   * Chromium's focus emulation is on in the current debugger session. It counts as a capturer, so
   * it keeps a hidden page visible and painting whatever its throttling: the budget ends it with
   * the agent's hold (syncThrottling) and the agent's next command turns it on again.
   */
  focusEmulation: boolean;
}
interface TabEntry {
  /**
   * The tab's page, or null while the tab is suspended: its page, host window and debugger session
   * are gone, and showing or using the tab reloads `requestedUrl` under the same id.
   */
  live: LivePage | null;
  project: string;
  presentation: "background" | "panel" | "window";
  error: string | null;
  requestedUrl: string;
  /** Agent CDP calls in flight (withAgentCdp). browser-picker refuses to start a pick and the budget pins the tab while > 0. */
  agentBusy: number;
  /** The reload of a revived tab until its load settles. */
  reviving: Promise<void> | null;
  /**
   * BROWSER_REVIVE_WAIT_MS after a revival started (once per revival, not per command). Until then
   * agent commands wait for `reviving`, capture() refuses and the budget leaves the tab alone; a
   * load still running after that (a hanging subresource) no longer blocks any of them.
   */
  reviveDeadline: number;
  /** Suspended since the agent's last wake(): the page state the agent saw is gone; wake() reports it once. */
  reloadUnreported: boolean;
  /** Cached for a suspended tab's display. */
  title: string;
  /** Cached for a suspended tab's display (Chromium restores per-origin zoom on reload). */
  zoom: number;
  /** Last show/hide transition, user command, thumbnail capture or agent use. */
  lastActiveAt: number;
  /** Last agent use + COMPUTER_TARGET_CLAIM_MS: live and unthrottled until then. */
  agentUntil: number;
  /** Last thumbnail capture + BROWSER_PREVIEW_HOLD_MS: live and unthrottled until then. */
  previewUntil: number;
  /** open()'s page load in flight; the budget pins the tab while > 0 (a revival uses reviveDeadline). */
  busy: number;
}

/** Resolves when `promise` settles or after `ms`, whichever is first; rejects when `signal` aborts. */
function settleWithin(promise: Promise<unknown>, signal: AbortSignal, ms: number): Promise<void> {
  signal.throwIfAborted();
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(finish, finish);
  });
}

/** A capture of a page without a frame yet is retried this often, at most CAPTURE_ATTEMPTS times. */
const CAPTURE_RETRY_MS = 50;
const CAPTURE_ATTEMPTS = 20;

const SIGN_IN_NEEDS_FOCUS = "Show and focus this browser tab before allowing sign-in.";
const REVIVAL_STOPPED = "Loading was stopped. Reload to recover.";

function assertZoom(zoom: number | undefined): number {
  if (zoom === undefined || !Number.isFinite(zoom) || zoom < 0.25 || zoom > 3)
    throw new Error("Invalid zoom.");
  return zoom;
}

/** One tab owner shared by manual preview and the consent-gated agent transport. */
export class EmbeddedComputerBrowser implements BrowserTransport {
  private readonly signIn = new SignInPopups(() => {
    this.publish();
    this.scheduleBudget();
  });
  private readonly entries = new Map<string, TabEntry>();
  /** The memory budget's single timer (see browserTabBudget.ts) and when it fires. */
  private budgetTimer: ReturnType<typeof setTimeout> | undefined;
  private budgetDueAt = Number.POSITIVE_INFINITY;
  private disposed = false;
  /**
   * The tab most recently mounted in a Ryco window. It stays live (though throttled) until another
   * tab is shown or it is closed: Ryco unmounts the tab whenever its window is hidden or covered,
   * which is not the user leaving it.
   */
  private lastShown: string | null = null;
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
        if (!entry.live)
          return {
            id,
            project: entry.project,
            title: entry.title,
            url: entry.requestedUrl,
            loading: false,
            canGoBack: false,
            canGoForward: false,
            zoom: entry.zoom,
            presentation: entry.presentation,
            error: entry.error,
            signInPopup: "idle",
            suspended: true,
          };
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
    return this.state().tabs.map(({ id, title, url, suspended }) => {
      const tab: BrowserTab = { id, title, url };
      if (suspended) tab.suspended = true;
      return tab;
    });
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
        // Hidden pages are throttled unless an agent or the thumbnail preview is using them
        // (syncThrottling keeps this current).
        backgroundThrottling: this.heldUntil(entry) <= Date.now(),
        focusOnNavigation: false,
      },
    });
    const wc = view.webContents;
    // Tab ids are the tab's first page's webContents id: the smoke scripts call
    // webContents.fromId(Number(tab.id)), and Electron never reuses ids. existingId keeps the id
    // when a tab gets a new page (browser-tab-budget's revival); open() never passes it.
    const id = existingId ?? String(wc.id);
    const cdp = new CdpLease(wc);
    const page: LivePage = { view, host, cdp, focusEmulation: false };
    // Activate the page inside Chromium, without focusing its host window or changing the
    // user's selected tab/application. Once per debugger session, whoever opened it. The flag is
    // set first so that the budget's "off" (endFocusEmulation) is always sent after this "on".
    cdp.onReady((send) => {
      page.focusEmulation = true;
      return send("Emulation.setFocusEmulationEnabled", { enabled: true }).then(() => undefined);
    });
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
      entry.lastActiveAt = Date.now();
      this.publish();
      this.scheduleBudget();
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
    wc.on("page-title-updated", () => {
      if (!current()) return;
      entry.title = wc.getTitle();
      this.publish();
    });
    // Closing DevTools or going silent can make the tab eligible for suspension again.
    const rebudget = () => {
      if (current()) this.scheduleBudget();
    };
    wc.on("devtools-closed", rebudget);
    wc.on("audio-state-changed", rebudget);
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
    // Suspended tabs count toward the limit: they keep their place in the tab strip.
    if (this.entries.size >= BROWSER_TAB_LIMIT)
      throw new Error(
        `Close a browser tab before opening another (${BROWSER_TAB_LIMIT} tab limit).`,
      );
    const now = Date.now();
    const entry: TabEntry = {
      live: null,
      project,
      presentation: "background",
      error: null,
      requestedUrl: target,
      agentBusy: 0,
      reviving: null,
      reviveDeadline: 0,
      reloadUnreported: false,
      title: "",
      zoom: 1,
      lastActiveAt: now,
      // Agent-opened tabs (no project) start inside the agent's claim window: live and unthrottled.
      agentUntil: project ? 0 : now + COMPUTER_TARGET_CLAIM_MS,
      previewUntil: 0,
      busy: 0,
    };
    // No Electron event can fire before the entry is registered.
    const { id, page } = this.createPage(entry);
    entry.live = page;
    this.entries.set(id, entry);
    const wc = page.view.webContents;
    const abort = () => this.destroy(id);
    signal.addEventListener("abort", abort, { once: true });
    // A loading tab is never the budget's victim; another tab may be suspended to make room.
    entry.busy++;
    this.publish();
    this.scheduleBudget();
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
      entry.busy--;
      this.scheduleBudget();
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
  /** The tab, live or suspended; "Browser tab closed." when it is gone. */
  private entry(id: string): TabEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Browser tab closed.");
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
    // Hidden from now on: the idle clock starts.
    entry.lastActiveAt = Date.now();
    this.scheduleBudget();
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
      // Showing a suspended tab reloads it at its last address.
      if (!entry.live) this.revive(input.tab, entry);
      const page = this.liveOf(entry);
      page.host.hide();
      page.host.contentView.removeChildView(page.view);
      ownerWindow.contentView.addChildView(page.view);
      this.mounted = { owner: input.owner, tab: input.tab, window: ownerWindow };
      entry.presentation = "panel";
      this.lastShown = input.tab;
    }
    const page = this.liveOf(entry);
    page.view.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    });
    entry.lastActiveAt = Date.now();
    if (changed) {
      this.publish();
      // The previously shown tab has just lost its exemption.
      this.scheduleBudget();
    }
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
    if (this.lastShown === tab) this.lastShown = null;
    this.publish();
    this.scheduleBudget();
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
    const entry = this.entry(input.tab);
    entry.lastActiveAt = Date.now();
    if (!entry.live && !this.commandSuspended(input, entry)) return;
    const page = this.liveOf(entry),
      wc = page.view.webContents;
    switch (input.action) {
      case "allow-sign-in":
        if (!this.foreground(input.tab)) throw new Error(SIGN_IN_NEEDS_FOCUS);
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
        wc.setZoomFactor(assertZoom(input.zoom));
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
    this.scheduleBudget();
  }
  /**
   * A command on a suspended tab. Returns true when the command needs the tab's page, which it has
   * then revived; otherwise the command is complete (navigate and reload are the revival's load,
   * and zoom applies once the revived page commits).
   */
  private commandSuspended(input: ProjectBrowserCommand, entry: TabEntry): boolean {
    switch (input.action) {
      case "close":
        this.destroy(input.tab);
        return false;
      case "navigate":
        entry.requestedUrl = browserUrl(input.url ?? "");
        this.revive(input.tab, entry);
        return false;
      case "reload":
        this.revive(input.tab, entry);
        return false;
      case "zoom": {
        const zoom = assertZoom(input.zoom);
        this.revive(input.tab, entry);
        // The new page has no live frame yet: Chromium would drop a zoom set now (or store it for
        // the blank document). Apply it once the page commits, after Chromium's per-site zoom.
        const page = entry.live;
        if (!page) return false;
        const wc = page.view.webContents;
        wc.once("did-navigate", () => {
          if (entry.live !== page || wc.isDestroyed()) return;
          wc.setZoomFactor(zoom);
          this.publish();
        });
        return false;
      }
      case "allow-sign-in":
        // A suspended tab is never shown, so it cannot be the focused tab a grant needs.
        throw new Error(SIGN_IN_NEEDS_FOCUS);
      case "devtools":
      case "popout":
        this.revive(input.tab, entry);
        return true;
      case "cancel-sign-in":
        this.signIn.cancel(input.tab);
        return false;
      case "back":
      case "forward":
      case "stop":
      case "dock":
        return false; // Nothing to do without a page.
    }
  }
  async capture(tab: string): Promise<string> {
    const entry = this.entry(tab);
    const now = Date.now();
    // The thumbnail preview counts as showing the tab: it stays live and unthrottled while previewed.
    entry.previewUntil = now + BROWSER_PREVIEW_HOLD_MS;
    entry.lastActiveAt = now;
    if (!entry.live) this.revive(tab, entry);
    // Extending the hold changes nothing before it ends (a revival plans its own pass).
    this.scheduleBudget(entry.previewUntil);
    if (!entry.live || this.reloading(entry, now))
      throw new Error("This browser tab is reloading.");
    const wc = this.liveOf(entry).view.webContents;
    const loadedUnthrottled = !wc.getBackgroundThrottling();
    this.syncThrottling(entry, now);
    const image = await this.capturePainted(entry, wc, loadedUnthrottled);
    return image.resize({ width: 640 }).toDataURL();
  }
  /**
   * capturePage once the page has a frame. A hidden page paints only after Electron shows it: when
   * throttling is switched off on a throttled page (capture() just did, or a hold did earlier), its
   * first frame follows within a few frames. A hidden page that loaded while unthrottled (a tab
   * revived by the preview, or opened or revived by an agent) was never shown and never paints, so
   * when `unthrottled` it is throttled and unthrottled once, which shows it.
   */
  private async capturePainted(
    entry: TabEntry,
    wc: WebContents,
    unthrottled: boolean,
  ): Promise<NativeImage> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await wc.capturePage();
      } catch (error) {
        if (attempt >= CAPTURE_ATTEMPTS || entry.live?.view.webContents !== wc || wc.isDestroyed())
          throw error;
        if (attempt === 1 && unthrottled && !wc.getBackgroundThrottling()) {
          wc.setBackgroundThrottling(true);
          wc.setBackgroundThrottling(false);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, CAPTURE_RETRY_MS));
      }
    }
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
    // A suspended tab reloads first, outside the 15 s guard; the agent's use holds it live. A live
    // tab goes on without yielding.
    const { loading } = this.startWake(tab, signal);
    if (loading) {
      await loading;
      // While it reloaded, the user may have armed a sign-in grant or a popup may have opened.
      this.guard(tab);
    }
    const entry = this.entry(tab);
    const page = this.liveOf(entry);
    const { cdp } = page;
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
          // The budget ends focus emulation when the agent's hold ends (syncThrottling).
          if (!page.focusEmulation) {
            page.focusEmulation = true;
            try {
              await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
            } catch (error) {
              page.focusEmulation = false;
              throw error;
            }
          }
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
      // No longer pinned. While the agent's hold lasts nothing changes, and a check is already due
      // at its end; plan at once only when the hold is gone (emergency stop during the call).
      if (entry.agentBusy === 0) this.scheduleBudget(this.heldUntil(entry));
    }
  }
  /**
   * Makes a suspended tab live before agent CDP use and holds it for the agent's claim window.
   * Reports each suspension once, whoever revived the tab (BrowserTabRevival): "now" when this wake
   * revived it or waited for its reload, "earlier" when that reload had already finished. Waits for
   * the reload until BROWSER_REVIVE_WAIT_MS after it started (so the commands of one action wait
   * once in total); a page still loading after that is used as it is.
   */
  async wake(tab: string, signal: AbortSignal): Promise<BrowserTabRevival> {
    const { entry, loading, fresh } = this.startWake(tab, signal);
    if (loading) await loading;
    if (!entry.reloadUnreported) return null;
    entry.reloadUnreported = false;
    return fresh ? "now" : "earlier";
  }
  /**
   * wake() up to the wait, without reporting: `loading` is set while the tab's reload still runs
   * within its wait, and `fresh` when the page is (being) loaded from its address right now.
   */
  private startWake(
    tab: string,
    signal: AbortSignal,
  ): { entry: TabEntry; loading: Promise<void> | null; fresh: boolean } {
    signal.throwIfAborted();
    const entry = this.entry(tab);
    const fresh = !entry.live || this.reloading(entry);
    this.touchAgent(entry); // Before reviving: the new page must start unthrottled.
    if (!entry.live) this.revive(tab, entry);
    const loading =
      entry.reviving && this.reloading(entry)
        ? settleWithin(entry.reviving, signal, entry.reviveDeadline - Date.now())
        : null;
    return { entry, loading, fresh };
  }
  /** A revival's load still runs and is within its wait (BROWSER_REVIVE_WAIT_MS). */
  private reloading(entry: TabEntry, now = Date.now()): boolean {
    return entry.reviving !== null && now < entry.reviveDeadline;
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
    const now = Date.now();
    let stoppedRevival = false;
    for (const [id, entry] of this.entries) {
      this.signIn.cancel(id);
      // Released tabs are throttled and can be suspended again.
      entry.agentUntil = 0;
      const page = entry.live;
      if (!page || page.view.webContents.isDestroyed()) continue;
      // Stopping a revival leaves a blank page under the tab's address (an aborted load reports no
      // error): say so instead of showing it as loaded. The next load clears it.
      if (entry.reviving) {
        entry.error = REVIVAL_STOPPED;
        stoppedRevival = true;
      }
      page.view.webContents.stop();
      this.syncThrottling(entry, now);
      // Emergency stop ends the agent's hold only; another holder keeps its session.
      page.cdp.release("agent");
    }
    if (stoppedRevival) this.publish();
    this.scheduleBudget();
  }
  /** Mounted, last shown, popped out, signing in, DevTools open, audible, or opening/running agent CDP. */
  private pinned(id: string, entry: TabEntry): boolean {
    const page = entry.live;
    if (!page) return false;
    if (
      this.mounted?.tab === id ||
      this.lastShown === id ||
      entry.presentation === "window" ||
      entry.busy > 0 ||
      entry.agentBusy > 0
    )
      return true;
    const signIn = this.signIn.state(id);
    if (signIn === "armed" || signIn === "open") return true;
    const wc = page.view.webContents;
    return !wc.isDestroyed() && (wc.isDevToolsOpened() || wc.isCurrentlyAudible());
  }
  /** The agent claim window or the thumbnail hold, whichever ends later. */
  private heldUntil(entry: TabEntry): number {
    return Math.max(entry.agentUntil, entry.previewUntil);
  }
  private touchAgent(entry: TabEntry): void {
    const now = Date.now();
    entry.agentUntil = now + COMPUTER_TARGET_CLAIM_MS;
    entry.lastActiveAt = now;
    this.syncThrottling(entry, now);
    // Starting or extending a hold makes nothing suspendable: plan at its end (a no-op while a
    // check is due earlier, so an action's many CDP commands cost no budget pass).
    this.scheduleBudget(entry.agentUntil);
  }
  /**
   * Throttles a hidden page in the background unless it is held. Chromium never throttles a
   * visible page (mounted or popped out), so this only affects hidden ones. Electron 44's
   * setBackgroundThrottling(true) hides a widget that throttling kept shown when the page is
   * hidden (WebContents::SetBackgroundThrottling), so a page is throttled again when its hold ends,
   * once the agent's focus emulation, which would keep it shown, has ended too.
   */
  private syncThrottling(entry: TabEntry, now: number): void {
    const page = entry.live;
    const wc = page?.view.webContents;
    if (!page || !wc || wc.isDestroyed()) return;
    const allowed = this.heldUntil(entry) <= now;
    if (wc.getBackgroundThrottling() === allowed) return;
    wc.setBackgroundThrottling(allowed);
    if (allowed) this.endFocusEmulation(page);
  }
  /** Ends focus emulation in the page's open session (see LivePage.focusEmulation); keeps the session. */
  private endFocusEmulation(page: LivePage): void {
    if (!page.focusEmulation || !page.cdp.isAttached()) return;
    page.focusEmulation = false;
    page.cdp
      .send("Emulation.setFocusEmulationEnabled", { enabled: false }, { skipReady: true })
      .catch(() => undefined); // A session that ended took the emulation with it.
  }
  /** Plans the budget at `at` (default: on the next tick). One coalesced, unref'd timer. */
  private scheduleBudget(at = Date.now()): void {
    if (this.disposed || at >= this.budgetDueAt) return;
    clearTimeout(this.budgetTimer);
    this.budgetDueAt = at;
    this.budgetTimer = setTimeout(
      () => {
        this.budgetTimer = undefined;
        this.budgetDueAt = Number.POSITIVE_INFINITY;
        this.applyBudget();
      },
      Math.max(0, at - Date.now()),
    );
    this.budgetTimer.unref?.();
  }
  private applyBudget(): void {
    if (this.disposed) return;
    const now = Date.now();
    const plan = planTabBudget(
      [...this.entries].map(([id, entry]) => ({
        id,
        scope: entry.project,
        live: entry.live !== null,
        pinned: this.pinned(id, entry),
        // A revival's load is left alone until its wait ends; then it is planned again.
        heldUntil: Math.max(this.heldUntil(entry), entry.reviving ? entry.reviveDeadline : 0),
        lastActiveAt: entry.lastActiveAt,
      })),
      now,
    );
    for (const id of plan.suspend) this.suspend(id, false);
    if (plan.suspend.length > 0) this.publish();
    for (const entry of this.entries.values()) this.syncThrottling(entry, now);
    if (plan.nextCheckAt !== null) this.scheduleBudget(plan.nextCheckAt);
  }
  /**
   * Unloads a hidden tab to save memory: its page, host window and debugger session go, while the
   * tab keeps its id, project, address, title and zoom. Closes without beforeunload, as Chrome's
   * Memory Saver does.
   */
  private suspend(id: string, publish = true): void {
    const entry = this.entries.get(id);
    const page = entry?.live;
    if (!entry || !page || this.pinned(id, entry)) return;
    const wc = page.view.webContents;
    if (!wc.isDestroyed()) {
      entry.title = wc.getTitle();
      entry.zoom = wc.getZoomFactor();
      try {
        entry.requestedUrl = browserUrl(wc.getURL());
      } catch {
        // An error page or a blank page keeps the last requested address.
      }
    }
    entry.error = null;
    entry.reloadUnreported = true;
    // Only a leftover "blocked"/"failed" hint can remain (pinned excludes armed and open); cancel
    // notifies on every call, so skip it otherwise to keep one publish per budget pass.
    if (this.signIn.state(id) !== "idle") this.signIn.cancel(id);
    // Detach the page from the tab first, so none of its late events reach the tab.
    entry.live = null;
    this.teardownPage(id, page);
    if (publish) this.publish();
  }
  /** Gives a suspended tab a new page under the same id and reloads its address. */
  private revive(id: string, entry: TabEntry): void {
    if (entry.live || this.entries.get(id) !== entry) return;
    const now = Date.now();
    entry.error = null;
    entry.lastActiveAt = now;
    // A new document starts without a hint left by the old one (e.g. a popup blocked during unload).
    if (this.signIn.state(id) !== "idle") this.signIn.cancel(id);
    const page = this.createPage(entry, id).page;
    entry.live = page;
    let url: string;
    try {
      url = browserUrl(entry.requestedUrl);
    } catch (error) {
      entry.error = error instanceof Error ? error.message : "Invalid browser address.";
      this.publish();
      return;
    }
    // Bounded by reviveDeadline rather than counted in `busy`: Electron settles loadURL only when
    // the page finishes or fails loading, which a hanging subresource can delay indefinitely.
    entry.reviveDeadline = now + BROWSER_REVIVE_WAIT_MS;
    const reviving: Promise<void> = page.view.webContents
      .loadURL(url)
      .then(
        () => undefined,
        () => undefined, // did-fail-load already set entry.error.
      )
      .finally(() => {
        if (entry.reviving === reviving) entry.reviving = null;
        this.publish();
        this.scheduleBudget();
      });
    entry.reviving = reviving;
    this.publish();
    this.scheduleBudget();
  }
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.budgetTimer);
    this.budgetTimer = undefined;
    this.listeners.clear();
    this.focusListeners.clear();
    for (const id of this.entries.keys()) this.destroy(id);
  }
}
