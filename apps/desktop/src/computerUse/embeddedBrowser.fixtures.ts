// Fake Electron for the embedded-browser suites (this unit and browser-tab-budget, browser-picker,
// browser-agent-control, browser-agent-upload). It imports no Electron runtime. Siblings extend it by
// adding members only; never change an existing member's behaviour.
//
// Install in a suite:
//   vi.mock("electron", async () => (await import("./embeddedBrowser.fixtures.ts")).fakeElectronModule);
//   beforeEach(resetFakeElectron);
// Suites that only need a CdpLease use `new FakeWebContents()` directly, without vi.mock.
import { EventEmitter } from "node:events";
import { vi, type Mock } from "vite-plus/test";

type Listener = (...args: any[]) => void;
interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface FakeWebPreferences {
  readonly session?: unknown;
  readonly backgroundThrottling?: boolean;
  readonly [key: string]: unknown;
}
export interface FakeWindowOptions {
  readonly width?: number;
  readonly height?: number;
  readonly show?: boolean;
  readonly webPreferences?: FakeWebPreferences;
  readonly [key: string]: unknown;
}

/** Electron's `webContents.debugger`: one session, pending commands, "message" and "detach" events. */
export class FakeDebugger extends EventEmitter {
  /** Electron's `Debugger::Detach` emits "detach" ("target closed") for a self-initiated detach; false models a build that does not. */
  emitOnSelfDetach = true;
  /** Canned responses: a value, a thrown error, or a promise (one that never settles models a hung command). */
  respond: (method: string, params: unknown, sessionId?: string) => unknown = () => ({});
  /** Every command sent while attached, in order; `sessionId` only on a child target's command. */
  readonly commands: Array<{ method: string; params: unknown; sessionId?: string }> = [];
  private attached = false;
  private readonly pending = new Set<(error: Error) => void>();
  private readonly owner: { isDestroyed(): boolean };

  constructor(owner: { isDestroyed(): boolean }) {
    super();
    this.owner = owner;
  }

  readonly attach = vi.fn((_version?: string): void => {
    this.assertLive();
    if (this.attached) throw new Error("Debugger is already attached to the target");
    this.attached = true;
  });

  readonly detach = vi.fn((): void => {
    this.assertLive();
    if (!this.attached) return;
    this.close("target closed", this.emitOnSelfDetach);
  });

  isAttached(): boolean {
    this.assertLive();
    return this.attached;
  }

  readonly sendCommand = vi.fn(
    (method: string, params: unknown = {}, sessionId?: string): Promise<unknown> => {
      this.assertLive();
      if (!this.attached) return Promise.reject(new Error("No target available"));
      this.commands.push(
        sessionId === undefined ? { method, params } : { method, params, sessionId },
      );
      return new Promise<unknown>((resolve, reject) => {
        const fail = (error: Error) => reject(error);
        this.pending.add(fail);
        // A detach that already rejected this command wins over its response.
        const settle = (complete: () => void) => {
          if (this.pending.delete(fail)) complete();
        };
        queueMicrotask(() => {
          if (!this.pending.has(fail)) return;
          let response: unknown;
          try {
            response = this.respond(method, params, sessionId);
          } catch (error) {
            settle(() => reject(error));
            return;
          }
          Promise.resolve(response).then(
            (value) => settle(() => resolve(value)),
            (error: unknown) => settle(() => reject(error)),
          );
        });
      });
    },
  );

  /** Electron ending the session (DevTools opened, target closed): rejects pending commands, emits "detach". */
  externalDetach(reason = "target closed"): void {
    if (!this.attached) return;
    this.close(reason, true);
  }

  /** A CDP event, emitted like Electron: `(event, method, params, sessionId)`. */
  message(method: string, params: unknown = {}, sessionId?: string): void {
    this.emit("message", fakeEvent(), method, params, sessionId);
  }

  override on(eventName: string | symbol, listener: Listener): this {
    this.assertLive();
    return super.on(eventName, listener);
  }

  override off(eventName: string | symbol, listener: Listener): this {
    this.assertLive();
    return super.off(eventName, listener);
  }

  override removeListener(eventName: string | symbol, listener: Listener): this {
    this.assertLive();
    return super.removeListener(eventName, listener);
  }

  private close(reason: string, emit: boolean): void {
    this.attached = false;
    const pending = [...this.pending];
    this.pending.clear();
    for (const fail of pending) fail(new Error("target closed while handling command"));
    if (emit) this.emit("detach", fakeEvent(), reason);
  }

  /** Electron's wrapper throws once its contents are destroyed. */
  private assertLive(): void {
    if (this.owner.isDestroyed()) throw new Error("Object has been destroyed");
  }
}

let nextContentsId = 1; // Never reset: Electron never reuses webContents ids.

/** Electron's WebContents: page state, navigation history, the debugger and lifecycle events. */
export class FakeWebContents extends EventEmitter {
  readonly id = nextContentsId++;
  readonly debugger: FakeDebugger = new FakeDebugger(this);
  readonly session: unknown;
  readonly webPreferences: FakeWebPreferences;
  url = "";
  title = "";
  loading = false;
  zoom = 1;
  focused = false;
  audible = false;
  devToolsOpened = false;
  backgroundThrottling: boolean;
  destroyed = false;
  /** The last handler given to setWindowOpenHandler. */
  windowOpenHandler: ((details: unknown) => unknown) | null = null;

  constructor(webPreferences: FakeWebPreferences = {}) {
    super();
    this.webPreferences = webPreferences;
    this.session = webPreferences.session ?? fakeSession;
    this.backgroundThrottling = webPreferences.backgroundThrottling ?? true;
  }

  get mainFrame(): {
    readonly frameTreeNodeId: number;
    readonly url: string;
    readonly executeJavaScript: (code: string) => Promise<unknown>;
  } {
    return {
      frameTreeNodeId: this.id,
      url: this.url,
      executeJavaScript: this.mainFrameExecuteJavaScript,
    };
  }
  /** The main frame's `executeJavaScript` (WebFrameMain); resolves at once unless a test holds it. */
  readonly mainFrameExecuteJavaScript = vi.fn(async (_code: string): Promise<unknown> => undefined);

  getURL(): string {
    return this.url;
  }
  getTitle(): string {
    return this.title;
  }
  isLoading(): boolean {
    return this.loading;
  }
  getZoomFactor(): number {
    return this.zoom;
  }
  setZoomFactor(zoom: number): void {
    this.zoom = zoom;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isFocused(): boolean {
    return this.focused;
  }
  isCurrentlyAudible(): boolean {
    return this.audible;
  }
  isDevToolsOpened(): boolean {
    return this.devToolsOpened;
  }
  getBackgroundThrottling(): boolean {
    return this.backgroundThrottling;
  }
  setBackgroundThrottling(allowed: boolean): void {
    this.backgroundThrottling = allowed;
  }

  readonly loadURL = vi.fn(async (url: string): Promise<void> => {
    this.url = url;
  });
  readonly close = vi.fn((_options?: { waitForBeforeUnload?: boolean }): void => this.destroy());
  readonly stop = vi.fn<() => void>();
  readonly reload = vi.fn<() => void>();
  readonly openDevTools = vi.fn<(options?: { mode?: string }) => void>();
  readonly focus = vi.fn<() => void>();
  readonly send = vi.fn<(channel: string, ...args: unknown[]) => void>();
  readonly setWindowOpenHandler = vi.fn((handler: (details: unknown) => unknown): void => {
    this.windowOpenHandler = handler;
  });
  readonly capturePage = vi.fn(async () => ({
    resize: (_size: { width?: number; height?: number }) => ({
      toDataURL: () => "data:image/png;base64,",
    }),
  }));
  readonly navigationHistory = {
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    goBack: vi.fn<() => void>(),
    goForward: vi.fn<() => void>(),
  };

  /** Destroys the contents once: an attached debugger gets Electron's target-closed detach first. */
  destroy(): void {
    if (this.destroyed) return;
    this.debugger.externalDetach("target closed");
    this.destroyed = true;
    this.emit("destroyed");
  }
}

/** Electron's WebContentsView: its contents and bounds. `firstParent` is the first window it was added to (its host). */
export class FakeWebContentsView {
  readonly options: { readonly webPreferences?: FakeWebPreferences };
  readonly webContents: FakeWebContents;
  bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
  firstParent: FakeBrowserWindow | null = null;
  readonly setBounds = vi.fn((bounds: Bounds): void => {
    this.bounds = { ...bounds };
  });

  constructor(options: { readonly webPreferences?: FakeWebPreferences } = {}) {
    this.options = options;
    this.webContents = new FakeWebContents(options.webPreferences);
    fakeElectronState.views.push(this);
    fakeElectronState.onView?.(this);
  }

  getBounds(): Bounds {
    return { ...this.bounds };
  }
}

/** Electron's BrowserWindow: a content view, size, visibility, focus and the "closed" event. */
export class FakeBrowserWindow extends EventEmitter {
  readonly options: FakeWindowOptions;
  readonly webContents: FakeWebContents;
  readonly contentView: {
    readonly children: FakeWebContentsView[];
    readonly addChildView: Mock<(view: FakeWebContentsView) => void>;
    readonly removeChildView: Mock<(view: FakeWebContentsView) => void>;
  };
  size: [number, number];
  visible: boolean;
  focused = false;
  minimized = false;
  destroyed = false;

  constructor(options: FakeWindowOptions = {}) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents(options.webPreferences);
    this.size = [options.width ?? 1280, options.height ?? 850];
    this.visible = options.show !== false;
    const children: FakeWebContentsView[] = [];
    this.contentView = {
      children,
      addChildView: vi.fn((view: FakeWebContentsView) => {
        // Electron moves an existing child to the top instead of adding it twice.
        const index = children.indexOf(view);
        if (index >= 0) children.splice(index, 1);
        children.push(view);
        view.firstParent ??= this;
      }),
      removeChildView: vi.fn((view: FakeWebContentsView) => {
        const index = children.indexOf(view);
        if (index >= 0) children.splice(index, 1);
      }),
    };
    fakeElectronState.windows.push(this);
  }

  getContentSize(): number[] {
    return [...this.size];
  }
  isVisible(): boolean {
    return this.visible;
  }
  isFocused(): boolean {
    return this.focused;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  readonly show = vi.fn((): void => {
    this.visible = true;
  });
  readonly hide = vi.fn((): void => {
    this.visible = false;
  });
  readonly showInactive = vi.fn((): void => {
    this.visible = true;
  });
  readonly setTitle = vi.fn<(title: string) => void>();

  /** Destroys the window once: marked destroyed, emits "closed" (as Electron does), then destroys its own contents. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
    this.webContents.destroy();
  }
}

/** An Electron event object for emitted events. */
export function fakeEvent(): { defaultPrevented: boolean; preventDefault: () => void } {
  const event = {
    defaultPrevented: false,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
  };
  return event;
}

export const fakeSession = {
  setPermissionRequestHandler: vi.fn<(handler: unknown) => void>(),
  setPermissionCheckHandler: vi.fn<(handler: unknown) => void>(),
  on: vi.fn<(event: string, listener: unknown) => void>(),
};

export const fakeElectronState = {
  views: [] as FakeWebContentsView[],
  windows: [] as FakeBrowserWindow[],
  fromPartition: vi.fn((_partition: string) => fakeSession),
  /** Called with every new view before the code under test uses it (e.g. to hold its load open). */
  onView: null as ((view: FakeWebContentsView) => void) | null,
};

export const fakeElectronModule = {
  BrowserWindow: FakeBrowserWindow,
  WebContentsView: FakeWebContentsView,
  session: { fromPartition: (partition: string) => fakeElectronState.fromPartition(partition) },
};

/** Forgets every fake view and window and clears the storage mocks. Run it in `beforeEach`. */
export function resetFakeElectron(): void {
  fakeElectronState.views.length = 0;
  fakeElectronState.windows.length = 0;
  fakeElectronState.onView = null;
  fakeElectronState.fromPartition.mockClear();
  fakeSession.setPermissionRequestHandler.mockClear();
  fakeSession.setPermissionCheckHandler.mockClear();
  fakeSession.on.mockClear();
}

/** The view, contents and host window of the tab whose id is `String(view.webContents.id)`. */
export function fakeTab(id: string): {
  view: FakeWebContentsView;
  contents: FakeWebContents;
  host: FakeBrowserWindow;
} {
  const view = fakeElectronState.views.find((candidate) => String(candidate.webContents.id) === id);
  if (!view?.firstParent) throw new Error(`No fake browser tab ${id}.`);
  return { view, contents: view.webContents, host: view.firstParent };
}

/** A Ryco window to mount tabs in with `surface()`: visible and focused unless overridden. */
export function fakeOwnerWindow(
  init: {
    readonly width?: number;
    readonly height?: number;
    readonly visible?: boolean;
    readonly focused?: boolean;
    readonly minimized?: boolean;
  } = {},
): FakeBrowserWindow {
  const window = new FakeBrowserWindow({
    width: init.width ?? 1280,
    height: init.height ?? 850,
    show: init.visible ?? true,
  });
  window.focused = init.focused ?? true;
  window.minimized = init.minimized ?? false;
  return window;
}
