import { BrowserWindow, globalShortcut, screen } from "electron";
import type { ComputerUseActivity } from "@ryco/contracts";

const SHORTCUT = "CommandOrControl+Shift+Escape";
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;pointer-events:none}
#badge{position:fixed;top:38px;left:50%;transform:translateX(-50%);padding:9px 15px;border:1px solid #b1a4ff88;border-radius:24px;background:#201d2bf0;color:#f7f5ff;font:12px system-ui;box-shadow:0 4px 18px #0004;max-width:70%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#cursor{position:absolute;left:0;top:0;transition:transform 160ms ease-out;filter:drop-shadow(0 2px 3px #0006)}
#cursor span{position:absolute;top:25px;left:21px;background:#201d2b;color:white;border-radius:5px;padding:2px 6px;font:11px system-ui}
body.takeover{box-shadow:inset 0 0 0 3px #b1a4ff,inset 0 0 45px #b1a4ff28}
</style></head><body><div id="badge"></div><div id="cursor" hidden><svg width="28" height="32" viewBox="0 0 28 32"><path d="M3 2L23 17L14 18L10 28Z" fill="#b1a4ff" stroke="white" stroke-width="2"/></svg><span>Ryco</span></div></body></html>`;

export class ComputerUseOverlay {
  private readonly windows = new Map<number, { window: BrowserWindow; ready: Promise<void> }>();
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly onStop: () => void;
  private readonly onIdle: () => void;
  constructor(onStop: () => void, onIdle: () => void) {
    this.onStop = onStop;
    this.onIdle = onIdle;
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
    const generation = ++this.generation;
    if (!activity) {
      this.hide();
      return;
    }
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
          show: false,
          hasShadow: false,
          skipTaskbar: true,
          resizable: false,
          title: "Ryco Computer Use Overlay",
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        window.setIgnoreMouseEvents(true);
        window.setAlwaysOnTop(true, "screen-saver");
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        window.setContentProtection(true);
        entry = {
          window,
          ready: window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`),
        };
        this.windows.set(display.id, entry);
      }
      const { window, ready } = entry;
      window.setBounds(display.bounds);
      const label = `${activity.mode === "foreground" ? "Ryco is using" : "Ryco is working in"} ${activity.target} · ${process.platform === "darwin" ? "⌘" : "Ctrl"}+Shift+Esc to stop`;
      updates.push(
        ready.then(async () => {
          if (generation !== this.generation || window.isDestroyed()) return;
          await window.webContents.executeJavaScript(
            `(() => { document.getElementById('badge').textContent=${JSON.stringify(label)}; document.body.classList.toggle('takeover',${activity.mode === "foreground"}); const cursor=document.getElementById('cursor'); cursor.hidden=${!displayPoint || display.id !== target.id}; ${displayPoint ? `cursor.style.transform='translate(${displayPoint.x - display.bounds.x}px,${displayPoint.y - display.bounds.y}px)';` : ""} })()`,
          );
          if (generation === this.generation && !window.isDestroyed()) window.showInactive();
        }),
      );
    }
    this.timer = setTimeout(() => {
      this.hide();
      this.onIdle();
    }, 8_000);
    await Promise.all(updates);
    if (displayPoint) await new Promise((resolve) => setTimeout(resolve, 160));
  }
  private hide(): void {
    for (const { window } of this.windows.values()) if (!window.isDestroyed()) window.hide();
  }
  dispose(): void {
    globalShortcut.unregister(SHORTCUT);
    ++this.generation;
    clearTimeout(this.timer);
    this.hide();
    for (const { window } of this.windows.values()) if (!window.isDestroyed()) window.destroy();
    this.windows.clear();
  }
}
