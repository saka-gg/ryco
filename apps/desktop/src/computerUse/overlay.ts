import { BrowserWindow, globalShortcut, screen } from "electron";
import type { ComputerUseActivity } from "@ryco/contracts";
import { COMPUTER_CURSOR_HTML } from "./cursor.ts";
import type { ComputerActivityIndicator } from "./activityIndicator.ts";

const SHORTCUT = "CommandOrControl+Shift+Escape";
/** How long the on-screen badge stays readable after the status changes. */
const BADGE_MS = 5_000;
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;pointer-events:none}
#badge.faded{opacity:0}
#badge:empty{display:none}
#badge{transition:opacity 240ms ease-out;position:fixed;top:38px;left:50%;transform:translateX(-50%);padding:9px 15px;border:1px solid #b1a4ff88;border-radius:24px;background:#201d2bf0;color:#f7f5ff;font:12px system-ui;box-shadow:0 4px 18px #0004;max-width:70%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#cursor{position:absolute;left:0;top:0;transition:transform 160ms ease-out;filter:drop-shadow(0 2px 3px #0006)}
body.takeover{box-shadow:inset 0 0 0 3px #b1a4ff,inset 0 0 45px #b1a4ff28}
</style></head><body><div id="badge"></div><div id="cursor" hidden>${COMPUTER_CURSOR_HTML}</div></body></html>`;

export class ComputerUseOverlay {
  private readonly windows = new Map<
    number,
    { window: BrowserWindow; ready: Promise<void>; badge: string | null }
  >();
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private indicatorTimer: ReturnType<typeof setTimeout> | undefined;
  private badgeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onStop: () => void;
  private readonly onIdle: () => void;
  private readonly indicator: ComputerActivityIndicator;
  constructor(onStop: () => void, onIdle: () => void, indicator: ComputerActivityIndicator) {
    this.onStop = onStop;
    this.onIdle = onIdle;
    this.indicator = indicator;
  }

  setEnabled(enabled: boolean): boolean {
    if (!enabled) {
      globalShortcut.unregister(SHORTCUT);
      return true;
    }
    return globalShortcut.isRegistered(SHORTCUT) || globalShortcut.register(SHORTCUT, this.onStop);
  }

  async show(activity: ComputerUseActivity | null): Promise<void> {
    clearTimeout(this.timer);
    clearTimeout(this.indicatorTimer);
    const generation = ++this.generation;
    if (!activity) {
      this.hide();
      this.clearIndicator();
      return;
    }
    // The badge announces which app an agent uses, once per change: never each action.
    this.indicator.touch(
      `legacy:${activity.threadId}`,
      activity.app ?? activity.target,
      activity.mode,
    );
    const summary = this.indicator.summary;
    const point =
      activity.x === undefined || activity.y === undefined
        ? undefined
        : { x: Math.round(activity.x), y: Math.round(activity.y) };
    const displayPoint =
      point && process.platform === "win32" ? screen.screenToDipPoint(point) : point;
    const target = displayPoint
      ? screen.getDisplayNearestPoint(displayPoint)
      : screen.getPrimaryDisplay();
    const displays = activity.mode === "foreground" ? screen.getAllDisplays() : [target];
    const updates: Promise<void>[] = [];
    for (const [id, entry] of this.windows)
      if (!displays.some((display) => display.id === id)) entry.window.hide();
    for (const display of displays) {
      let entry = this.windows.get(display.id);
      if (!entry) {
        const window = new BrowserWindow({
          ...display.bounds,
          transparent: true,
          frame: false,
          focusable: false,
          ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
          show: false,
          hasShadow: false,
          skipTaskbar: true,
          resizable: false,
          title: "Ryco Computer Use Overlay",
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        window.setIgnoreMouseEvents(true);
        window.setAlwaysOnTop(true, "screen-saver");
        // macOS panels already span Spaces/fullscreen without transforming Ryco
        // between foreground/UIElement process types (which can disrupt focus).
        if (process.platform !== "darwin") window.setVisibleOnAllWorkspaces(true);
        window.setContentProtection(true);
        entry = {
          window,
          ready: window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`),
          badge: null,
        };
        this.windows.set(display.id, entry);
      }
      const current = entry;
      const { window, ready } = current;
      window.setBounds(display.bounds);
      const label = `${summary ?? "Ryco"} · ${process.platform === "darwin" ? "⌘" : "Ctrl"}+Shift+Esc to stop`;
      updates.push(
        ready.then(async () => {
          if (generation !== this.generation || window.isDestroyed()) return;
          // Each window tracks the line it shows, so an update that a newer one
          // superseded never counts as announced.
          const announce = current.badge !== label;
          current.badge = label;
          if (announce) this.scheduleBadgeFade();
          await window.webContents.executeJavaScript(
            `(() => { const badge=document.getElementById('badge'); ${announce ? `badge.textContent=${JSON.stringify(label)}; badge.classList.remove('faded');` : ""} document.body.classList.toggle('takeover',${activity.mode === "foreground"}); const cursor=document.getElementById('cursor'); cursor.hidden=${!displayPoint || display.id !== target.id}; ${displayPoint ? `cursor.style.transform='translate(${displayPoint.x - display.bounds.x}px,${displayPoint.y - display.bounds.y}px)';` : ""} })()`,
          );
          if (generation === this.generation && !window.isDestroyed()) window.showInactive();
        }),
      );
    }
    this.timer = setTimeout(() => {
      // Invalidate pending page loads so they cannot show an expired overlay.
      ++this.generation;
      this.hide();
    }, 8_000);
    // The menu-bar status keeps the app and Stop available between tool calls.
    this.indicatorTimer = setTimeout(() => {
      this.clearIndicator();
      this.onIdle();
    }, 60_000);
    await Promise.all(updates);
    if (displayPoint) await new Promise((resolve) => setTimeout(resolve, 160));
  }
  private hide(): void {
    for (const { window } of this.windows.values()) if (!window.isDestroyed()) window.hide();
  }
  private scheduleBadgeFade(): void {
    clearTimeout(this.badgeTimer);
    this.badgeTimer = setTimeout(() => this.fadeBadge(), BADGE_MS);
  }
  private fadeBadge(): void {
    for (const { window } of this.windows.values())
      if (!window.isDestroyed())
        void window.webContents
          .executeJavaScript(`document.getElementById('badge').classList.add('faded')`)
          .catch(() => undefined);
  }
  private clearIndicator(): void {
    // The next session announces itself again.
    for (const entry of this.windows.values()) entry.badge = null;
    this.indicator.endAll("legacy:");
  }
  dispose(): void {
    globalShortcut.unregister(SHORTCUT);
    ++this.generation;
    clearTimeout(this.timer);
    clearTimeout(this.indicatorTimer);
    clearTimeout(this.badgeTimer);
    this.clearIndicator();
    this.hide();
    for (const { window } of this.windows.values()) if (!window.isDestroyed()) window.destroy();
    this.windows.clear();
  }
}
