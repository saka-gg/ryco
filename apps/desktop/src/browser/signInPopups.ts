import { BrowserWindow, type WebContents } from "electron";

export type SignInPopupState = "idle" | "armed" | "open" | "blocked" | "failed";

export function isSignInNavigation(url: string): boolean {
  if (url === "about:blank") return true;
  try {
    const parsed = new URL(url);
    return (
      !parsed.username &&
      !parsed.password &&
      (parsed.protocol === "https:" ||
        (parsed.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)))
    );
  } catch {
    return false;
  }
}

/** A main-process, one-use grant. Page content and agent transport cannot arm it. */
export class SignInPopups {
  private grant: { tab: string; timer: ReturnType<typeof setTimeout> } | undefined;
  private pending: { tab: string; timer: ReturnType<typeof setTimeout> } | undefined;
  private popup: { tab: string; window: BrowserWindow } | undefined;
  private readonly states = new Map<string, SignInPopupState>();
  private readonly changed: () => void;
  constructor(changed: () => void) {
    this.changed = changed;
  }
  state(tab: string): SignInPopupState {
    return this.states.get(tab) ?? "idle";
  }
  private set(tab: string, state: SignInPopupState): void {
    if (this.state(tab) === state) return;
    this.states.set(tab, state);
    // Never publish synchronously from Electron's window-open handler.
    queueMicrotask(this.changed);
  }
  arm(tab: string): void {
    if (this.popup || this.pending) throw new Error("Close the current sign-in popup first.");
    if (this.grant) this.cancel(this.grant.tab);
    this.grant = { tab, timer: setTimeout(() => this.cancel(tab), 30_000) };
    this.set(tab, "armed");
  }
  fail(tab: string): void {
    if (this.state(tab) !== "armed" && this.state(tab) !== "open") return;
    this.cancel(tab);
    this.set(tab, "failed");
  }
  cancel(tab: string): void {
    if (this.pending?.tab === tab) {
      clearTimeout(this.pending.timer);
      this.pending = undefined;
    }
    if (this.grant?.tab === tab) {
      clearTimeout(this.grant.timer);
      this.grant = undefined;
    }
    if (this.popup?.tab === tab) {
      const { window } = this.popup;
      this.popup = undefined;
      if (!window.isDestroyed()) window.destroy();
    }
    this.states.delete(tab);
    queueMicrotask(this.changed);
  }
  install(tab: string, opener: WebContents, foreground: () => boolean): void {
    opener.setWindowOpenHandler((details) => {
      if (
        this.grant?.tab !== tab ||
        this.popup ||
        this.pending ||
        !foreground() ||
        !isSignInNavigation(details.url) ||
        details.disposition === "background-tab"
      ) {
        if (this.state(tab) !== "open") {
          if (this.grant?.tab === tab) this.cancel(tab);
          this.set(tab, "blocked");
        }
        return { action: "deny" };
      }
      clearTimeout(this.grant.timer);
      this.grant = undefined;
      this.set(tab, "open");
      const pending = {
        tab,
        timer: setTimeout(() => {
          if (this.pending === pending) {
            this.cancel(tab);
            this.set(tab, "failed");
          }
        }, 5_000),
      };
      this.pending = pending;
      const popupOptions: Electron.BrowserWindowConstructorOptions = {
        show: false,
        width: 520,
        height: 720,
        minWidth: 320,
        minHeight: 400,
        frame: true,
        transparent: false,
        alwaysOnTop: false,
        fullscreen: false,
        fullscreenable: false,
        kiosk: false,
        skipTaskbar: false,
        modal: false,
        focusable: true,
        title: "Ryco · Sign in",
        autoHideMenuBar: true,
        webPreferences: {
          session: opener.session,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          nodeIntegrationInWorker: false,
          contextIsolation: true,
          sandbox: true,
          webviewTag: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          navigateOnDragDrop: false,
          focusOnNavigation: false,
          safeDialogs: true,
        },
      };
      return {
        action: "allow",
        outlivesOpener: false,
        overrideBrowserWindowOptions: popupOptions,
        createWindow: (options) => {
          // Retain Electron's native child contents, but never inherit feature-supplied
          // preload, parent, display or security options at the construction boundary.
          const safeOptions = {
            ...options,
            ...popupOptions,
            webPreferences: popupOptions.webPreferences!,
          };
          delete safeOptions.parent;
          delete safeOptions.x;
          delete safeOptions.y;
          let window: BrowserWindow;
          try {
            window = new BrowserWindow(safeOptions);
          } catch (error) {
            if (this.pending === pending) {
              this.cancel(tab);
              this.set(tab, "failed");
            }
            throw error;
          }
          if (this.pending !== pending) {
            queueMicrotask(() => {
              if (!window.isDestroyed()) window.destroy();
            });
            return window.webContents;
          }
          clearTimeout(pending.timer);
          this.pending = undefined;
          const child = window.webContents;
          this.popup = { tab, window };
          const updateTitle = () => {
            if (window.isDestroyed()) return;
            let origin = "Sign in";
            try {
              origin = new URL(child.getURL()).origin;
            } catch {
              /* Initial blank page. */
            }
            window.setTitle(`Ryco sign-in · ${origin}`);
          };
          child.on("page-title-updated", (event) => {
            event.preventDefault();
            updateTitle();
          });
          child.on("did-navigate", updateTitle);
          child.setWindowOpenHandler(() => ({ action: "deny" }));
          const validate = (event: Electron.Event, url: string) => {
            if (!isSignInNavigation(url)) event.preventDefault();
          };
          child.on("will-navigate", validate);
          child.on("will-redirect", validate);
          child.on("will-frame-navigate", (event) => validate(event, event.url));
          child.on("before-input-event", (event, input) => {
            if (
              input.type === "keyDown" &&
              (input.key === "Escape" ||
                (input.key.toLowerCase() === "w" && (input.meta || input.control)))
            ) {
              event.preventDefault();
              this.cancel(tab);
            }
          });
          window.on("close", (event) => {
            event.preventDefault();
            this.cancel(tab);
          });
          window.once("closed", () => {
            if (this.popup?.window === window) {
              this.popup = undefined;
              this.set(tab, "idle");
            }
          });
          const failed = () => {
            if (this.popup?.window !== window) return;
            this.cancel(tab);
            this.set(tab, "failed");
          };
          child.once("render-process-gone", failed);
          child.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
            if (mainFrame && code !== -3) failed();
          });
          child.once("destroyed", () => {
            if (this.popup?.window === window) this.cancel(tab);
          });
          window.once("ready-to-show", () => {
            if (this.popup?.window !== window || window.isDestroyed()) return;
            if (!foreground()) {
              this.cancel(tab);
              return;
            }
            window.showInactive();
          });
          return child;
        },
      };
    });
  }
}
