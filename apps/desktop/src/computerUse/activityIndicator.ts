import { Menu, Tray, nativeImage, type NativeImage } from "electron";

export type ComputerIndicatorMode = "background" | "foreground";

export interface ComputerIndicatorSession {
  readonly app: string;
  readonly mode: ComputerIndicatorMode;
}

/** How long a session stays listed after its last action. */
export const COMPUTER_INDICATOR_IDLE_MS = 60_000;

// The Ryco "R" mark as a monochrome menu-bar glyph (18 pt square), rendered
// from assets/logo_letter_only.svg. Embedded so packaging cannot drop it.
const GLYPH_1X =
  "iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAABGUlEQVR42s3UMS+DURQG4Ie20j+giMRPEJPELzAZTKIxSgx2u8SGxNCYxWKQiN1MGM0GCyEYRNMWDbWcytXo1449ycn9zs173pz3PV8ugx7Dca7gCq+oR9ZQxS3W+iHbQquPXE2bhjpIFnESwCZO8Zw0F7CASTxiots0l/hGA/NdMBtB+pkl6y1Ax1GPxBTtGMM5vvCQNua7mH2ffDdRxjKmMRX3layJajFRJfFv+x+jD5HLIqoHcD/qctJ8hwMsdVnUn2hE0w5KeArzrzGese1fHzqjijmMBtFwyC5Etnr9jI3YSFvaUSLtLCbJ95KVStuMuoiLhGwv7nO9iFphaDEBl3CTkK33Q7bbYWgbPIMXfOAdswP//PgBUXNUJ84xm9QAAAAASUVORK5CYII=";
const GLYPH_2X =
  "iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAACvElEQVR42u2XTahNURTHf3ffe5GvTBh4ERnJV/FiJBEDKQlJCs+IqaFMjQxeuXpvYOBrgoFSEiVTYkDJxOAJT5SvvIeX+3HOMVm7ltW+95597jW7q3b7dPfe//Pf/73Xf50LgxhEb1HKMacMJPK8B9gPbAGGgNlmbqb6TNa9B+4B48CkwYuOsvQ7gcfqRUXaJ+CgwS1E5qwCTYGW9DGtpTAO9ULmjIC0FGgKNEX2bqokap7fyBSwogiprQLUFKBM9UWb31Qt9lJXgCfAsOywLEAl6a8BN4AvimhqMBywGDgPbJRx/74PwPIYdXYryf0LE+AHsCtS6c1qvVeqEXtc181l9GB7ZXyWqOY6tKrMWx048mhCEyarMuChjFU7rHNy3L4BnDN3MQU+xhKaMhmVAafkDlTaEHGB30dEjcRs7iodLm/e+KOcuJ2TrwW2A+uA9eLoNhLgQqxC0wGFTgQ24f1qFXDbGKC1ibr0o0U86KcC8oRGDCFPZptKfz+/qYywpTAeqYSIil8BQscVIQ84rOY2japWrZvA3Iii/k/8DhA6prLMAQuBN8aBbTlpSFE+nPcLo1LgOJ2QrAErhUxFlHHAV+Ay8Ax4BbxW67I2idE1ZgIKHVXjB8yYV+ZloCSUin5udCPkj2wI+KwqufeYt8ASdazlNt7UVf68Rdf/NiZFMzXrnXJxTbQvhELhwW+pyp2pu7EMuA/ML4Cd25X1kR1R4yfNmH6+q3yq9L8IpSp155ii2QiQuthDFncl1DDGWFUvuhJQys8/3U9SdfOi78AGOQKnUtkBD9o4dQbs6xepunLfCaneBLKqBCwAngccOxHH39TLXx/rQ0+BpR0AnfKmd8YkPblJhVE48zLgDjAvx+782BpT9fXnxwtgkVI1OmpqN3l25e/IDuCbfAHMSJsWYpf6VUYGMYhO8Rdxtlld6r+aKAAAAABJRU5ErkJggg==";

/**
 * The one line people see while agents use the computer: which apps, never
 * which action. Foreground control is named because it takes the mouse.
 */
export function describeComputerSessions(
  sessions: Iterable<ComputerIndicatorSession>,
): string | null {
  const apps: string[] = [];
  let foreground = false;
  for (const session of sessions) {
    if (!apps.includes(session.app)) apps.push(session.app);
    foreground ||= session.mode === "foreground";
  }
  if (apps.length === 0) return null;
  const verb = foreground ? "controlling" : "using";
  if (apps.length === 1) return `Ryco is ${verb} ${apps[0]}`;
  if (apps.length === 2) return `Ryco is ${verb} ${apps[0]} and ${apps[1]}`;
  return `Ryco is ${verb} ${apps.length} apps`;
}

function glyph(): NativeImage {
  const image = nativeImage.createEmpty();
  image.addRepresentation({ scaleFactor: 1, dataURL: `data:image/png;base64,${GLYPH_1X}` });
  image.addRepresentation({ scaleFactor: 2, dataURL: `data:image/png;base64,${GLYPH_2X}` });
  if (process.platform === "darwin") {
    // Template rendering follows the menu bar's light/dark appearance.
    image.setTemplateImage(true);
    return image;
  }
  // Other trays do not tint templates: paint the glyph in the overlay accent.
  const size = image.getSize(2);
  const pixels = Buffer.from(image.toBitmap({ scaleFactor: 2 }));
  for (let offset = 0; offset + 3 < pixels.length; offset += 4) pixels.set([255, 164, 177], offset);
  return nativeImage.createFromBitmap(pixels, { ...size, scaleFactor: 2 });
}

/**
 * The menu-bar status for every Computer Use session, legacy and Cua alike.
 * Sessions are keyed by their owner (one per thread and runtime); the tray is
 * rebuilt only when the visible status changes, never per action.
 */
export class ComputerActivityIndicator {
  private readonly sessions = new Map<
    string,
    ComputerIndicatorSession & { timer: ReturnType<typeof setTimeout> }
  >();
  private tray: Tray | undefined;
  private rendered = "";
  private readonly onStop: () => void;
  private readonly idleMs: number;

  constructor(options: { onStop(): void; idleMs?: number }) {
    this.onStop = options.onStop;
    this.idleMs = options.idleMs ?? COMPUTER_INDICATOR_IDLE_MS;
  }

  /** The current status line, or null when no session is active. */
  get summary(): string | null {
    return describeComputerSessions(this.sessions.values());
  }

  /** Records activity for a session. Returns true when the visible status changed. */
  touch(key: string, app: string, mode: ComputerIndicatorMode): boolean {
    const previous = this.sessions.get(key);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => this.end(key), this.idleMs);
    timer.unref?.();
    this.sessions.set(key, { app, mode, timer });
    return this.render();
  }

  end(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    clearTimeout(session.timer);
    this.sessions.delete(key);
    this.render();
  }

  /** Ends every session whose key starts with `prefix`. */
  endAll(prefix = ""): void {
    for (const [key, session] of this.sessions)
      if (key.startsWith(prefix)) {
        clearTimeout(session.timer);
        this.sessions.delete(key);
      }
    this.render();
  }

  dispose(): void {
    this.endAll();
  }

  private render(): boolean {
    const sessions = [...this.sessions.values()];
    const summary = describeComputerSessions(sessions);
    const details =
      sessions.length > 1
        ? sessions.map(
            (session) =>
              `${session.app}${session.mode === "foreground" ? " (controls your mouse)" : ""}`,
          )
        : [];
    const key = JSON.stringify([summary, details]);
    if (key === this.rendered) return false;
    this.rendered = key;
    if (!summary) {
      this.tray?.destroy();
      this.tray = undefined;
      return true;
    }
    this.tray ??= new Tray(glyph());
    this.tray.setToolTip(summary);
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: summary.replaceAll("&", "&&"), enabled: false },
        ...details.map((label) => ({ label: label.replaceAll("&", "&&"), enabled: false })),
        { type: "separator" },
        { label: "Stop computer use", click: this.onStop },
      ]),
    );
    return true;
  }
}
