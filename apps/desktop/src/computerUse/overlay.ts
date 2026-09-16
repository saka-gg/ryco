import { BrowserWindow, globalShortcut, screen, Tray, Menu, nativeImage } from "electron";
import type { ComputerUseActivity } from "@ryco/contracts";
import { COMPUTER_CURSOR_HTML } from "./cursor.ts";

const SHORTCUT = "CommandOrControl+Shift+Escape";
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;pointer-events:none}
#badge{position:fixed;top:38px;left:50%;transform:translateX(-50%);padding:9px 15px;border:1px solid #b1a4ff88;border-radius:24px;background:#201d2bf0;color:#f7f5ff;font:12px system-ui;box-shadow:0 4px 18px #0004;max-width:70%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#cursor{position:absolute;left:0;top:0;transition:transform 160ms ease-out;filter:drop-shadow(0 2px 3px #0006)}
body.takeover{box-shadow:inset 0 0 0 3px #b1a4ff,inset 0 0 45px #b1a4ff28}
</style></head><body><div id="badge"></div><div id="cursor" hidden>${COMPUTER_CURSOR_HTML}</div></body></html>`;

function activityLabel(action: string): string {
  switch (action) {
    case "observe":
    case "screenshot":
      return "Screen capture";
    case "find_elements":
      return "Inspect controls";
    case "type_text":
    case "type":
    case "fill":
    case "set_element_value":
      return "Text entry";
    default:
      return action.replaceAll("_", " ");
  }
}

function trayIcon() {
  // A small monitor at 2x resolution. Template rendering follows macOS's
  // light/dark menu bar without resembling its system privacy indicator.
  const pixels = Buffer.alloc(36 * 36 * 4);
  for (let y = 0; y < 36; y++)
    for (let x = 0; x < 36; x++) {
      const border = x >= 3 && x < 33 && y >= 5 && y < 26 && (x < 6 || x >= 30 || y < 8 || y >= 23);
      const stand =
        (x >= 16 && x < 20 && y >= 26 && y < 30) || (x >= 10 && x < 26 && y >= 30 && y < 33);
      if (!border && !stand) continue;
      const offset = (y * 36 + x) * 4;
      if (process.platform !== "darwin") pixels.set([255, 164, 177], offset);
      pixels[offset + 3] = 255;
    }
  const icon = nativeImage.createFromBitmap(pixels, { width: 36, height: 36, scaleFactor: 2 });
  icon.setTemplateImage(process.platform === "darwin");
  return icon;
}

export class ComputerUseOverlay {
  private readonly windows = new Map<number, { window: BrowserWindow; ready: Promise<void> }>();
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private indicatorTimer: ReturnType<typeof setTimeout> | undefined;
  private tray: Tray | undefined;
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
    clearTimeout(this.indicatorTimer);
    const generation = ++this.generation;
    if (!activity) {
      this.hide();
      this.clearIndicator();
      return;
    }
    const actionLabel = activityLabel(activity.action);
    this.tray ??= new Tray(trayIcon());
    this.tray.setToolTip(`Ryco Computer Use · ${activity.target} · ${actionLabel}`);
    if (process.platform === "darwin") this.tray.setTitle("Ryco");
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Ryco Computer Use", enabled: false },
        { label: activity.target.replaceAll("&", "&&"), enabled: false },
        { label: `Last action: ${actionLabel}`, enabled: false },
        {
          label: activity.mode === "foreground" ? "Foreground control" : "Background control",
          enabled: false,
        },
        { type: "separator" },
        { label: "Stop computer use", accelerator: SHORTCUT, click: this.onStop },
      ]),
    );
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
        };
        this.windows.set(display.id, entry);
      }
      const { window, ready } = entry;
      window.setBounds(display.bounds);
      const label = `Ryco · ${actionLabel}: ${activity.target} · ${process.platform === "darwin" ? "⌘" : "Ctrl"}+Shift+Esc to stop`;
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
      // Invalidate pending page loads so they cannot show an expired overlay.
      ++this.generation;
      this.hide();
    }, 8_000);
    // Keep the named target and Stop menu available between agent tool calls.
    // The menu says "Last action" because snapshots are not a live video stream.
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
  private clearIndicator(): void {
    this.tray?.destroy();
    this.tray = undefined;
  }
  dispose(): void {
    globalShortcut.unregister(SHORTCUT);
    ++this.generation;
    clearTimeout(this.timer);
    clearTimeout(this.indicatorTimer);
    this.clearIndicator();
    this.hide();
    for (const { window } of this.windows.values()) if (!window.isDestroyed()) window.destroy();
    this.windows.clear();
  }
}
