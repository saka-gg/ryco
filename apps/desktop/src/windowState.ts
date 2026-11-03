import * as FS from "node:fs";

import { writeFileAtomicallySync } from "./atomicFileWrite.ts";
import { describeErrorForLog } from "./logValue.ts";

/**
 * Where the main window was, so it reopens there.
 *
 * Its own file rather than a desktop setting: a corrupt `desktop-settings.json`
 * stops on purpose (it holds the Hub configuration), and rewriting that file on
 * every window move would put it at risk for a cosmetic value. A corrupt
 * window-state file only falls back to the default size.
 */
export const DESKTOP_WINDOW_STATE_FILE_NAME = "desktop-window-state.json";
export const DESKTOP_WINDOW_DEFAULT_SIZE = { width: 1100, height: 780 } as const;
export const DESKTOP_WINDOW_MIN_SIZE = { width: 840, height: 620 } as const;
export const DESKTOP_WINDOW_STATE_SAVE_DEBOUNCE_MS = 500;

const MAX_WINDOW_COORDINATE = 100_000;

export interface DesktopWindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PersistedDesktopWindowState {
  readonly version: 1;
  /** The window's normal (not maximized, minimized or fullscreen) bounds, in DIP. */
  readonly bounds: DesktopWindowBounds;
  readonly isMaximized: boolean;
}

function isWindowCoordinate(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= MAX_WINDOW_COORDINATE
  );
}

function isWindowExtent(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_WINDOW_COORDINATE
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWindowBounds(value: unknown): DesktopWindowBounds | null {
  if (!isRecord(value)) return null;
  const { x, y, width, height } = value;
  if (!isWindowCoordinate(x) || !isWindowCoordinate(y)) return null;
  if (!isWindowExtent(width) || !isWindowExtent(height)) return null;
  return { x, y, width, height };
}

/** A v1 state, or `null` for anything else (an unknown version included). */
export function parseDesktopWindowState(value: unknown): PersistedDesktopWindowState | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const bounds = parseWindowBounds(value.bounds);
  if (bounds === null || typeof value.isMaximized !== "boolean") return null;
  return { version: 1, bounds, isMaximized: value.isMaximized };
}

export type DesktopWindowStateRead =
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "saved"; readonly state: PersistedDesktopWindowState };

/** Never throws: a file that cannot be read or understood is `unreadable`. */
export function readDesktopWindowState(filePath: string): DesktopWindowStateRead {
  let raw: string;
  try {
    raw = FS.readFileSync(filePath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unreadable" };
  }
  try {
    const state = parseDesktopWindowState(JSON.parse(raw));
    return state === null ? { kind: "unreadable" } : { kind: "saved", state };
  } catch {
    return { kind: "unreadable" };
  }
}

export function writeDesktopWindowState(
  filePath: string,
  state: PersistedDesktopWindowState,
): void {
  const { x, y, width, height } = state.bounds;
  const canonical: PersistedDesktopWindowState = {
    version: 1,
    bounds: { x, y, width, height },
    isMaximized: state.isMaximized,
  };
  writeFileAtomicallySync(filePath, `${JSON.stringify(canonical)}\n`);
}

function intersectionArea(a: DesktopWindowBounds, b: DesktopWindowBounds): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function clampInto(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Fit saved bounds onto a display that exists now: the work area they overlap
 * most (the primary on a tie), sized into it, or centred on the primary when
 * they overlap none (the monitor is gone).
 */
export function resolveVisibleWindowBounds(input: {
  readonly saved: DesktopWindowBounds;
  /** Display work areas, primary first. */
  readonly workAreas: ReadonlyArray<DesktopWindowBounds>;
}): { readonly bounds: DesktopWindowBounds; readonly clamped: boolean } {
  const { saved, workAreas } = input;
  const [primary] = workAreas;
  if (primary === undefined) return { bounds: saved, clamped: false };

  let area = primary;
  let overlap = intersectionArea(saved, primary);
  for (const candidate of workAreas.slice(1)) {
    const candidateOverlap = intersectionArea(saved, candidate);
    if (candidateOverlap > overlap) {
      area = candidate;
      overlap = candidateOverlap;
    }
  }

  // Below the minimum, Electron's minWidth/minHeight still win.
  const width = Math.min(area.width, Math.max(DESKTOP_WINDOW_MIN_SIZE.width, saved.width));
  const height = Math.min(area.height, Math.max(DESKTOP_WINDOW_MIN_SIZE.height, saved.height));
  const bounds: DesktopWindowBounds =
    overlap === 0
      ? {
          x: area.x + Math.round((area.width - width) / 2),
          y: area.y + Math.round((area.height - height) / 2),
          width,
          height,
        }
      : {
          x: clampInto(saved.x, area.x, area.x + area.width - width),
          y: clampInto(saved.y, area.y, area.y + area.height - height),
          width,
          height,
        };
  return { bounds, clamped: !sameBounds(bounds, saved) };
}

export interface RestoredDesktopWindowState {
  /** BrowserWindow constructor bounds; without x/y Electron centres the window. */
  readonly bounds: {
    readonly x?: number;
    readonly y?: number;
    readonly width: number;
    readonly height: number;
  };
  readonly maximize: boolean;
  readonly source: "saved" | "default" | "unreadable";
  readonly clamped: boolean;
}

/** First launch, an unreadable file or no display information: today's default, centred. */
export function resolveRestoredDesktopWindowState(input: {
  readonly read: DesktopWindowStateRead;
  readonly workAreas: ReadonlyArray<DesktopWindowBounds>;
}): RestoredDesktopWindowState {
  const { read } = input;
  if (read.kind === "saved" && input.workAreas.length > 0) {
    const visible = resolveVisibleWindowBounds({
      saved: read.state.bounds,
      workAreas: input.workAreas,
    });
    return {
      bounds: visible.bounds,
      maximize: read.state.isMaximized,
      source: "saved",
      clamped: visible.clamped,
    };
  }
  return {
    bounds: { ...DESKTOP_WINDOW_DEFAULT_SIZE },
    maximize: false,
    source: read.kind === "unreadable" ? "unreadable" : "default",
    clamped: false,
  };
}

/**
 * Whether the window system ignores client window positions and reports a fake
 * one (Wayland: x=0/y=0). Such a position must not replace a saved one.
 */
export function isWindowPositionUnreported(input: {
  readonly platform: NodeJS.Platform;
  readonly sessionType: string | undefined;
  readonly waylandDisplay: string | undefined;
  /** The `--ozone-platform` switch, empty when unset. */
  readonly ozonePlatform: string;
}): boolean {
  if (input.platform !== "linux" || input.ozonePlatform === "x11") return false;
  if (input.ozonePlatform === "wayland") return true;
  return input.sessionType === "wayland" || (input.waylandDisplay ?? "").length > 0;
}

/** The subset of BrowserWindow the store uses (structural, so tests pass a fake). */
export interface DesktopWindowStateTarget {
  getNormalBounds(): DesktopWindowBounds;
  isMaximized(): boolean;
  isMinimized(): boolean;
  isFullScreen(): boolean;
  isDestroyed(): boolean;
  maximize(): void;
  on(
    event: "resize" | "move" | "maximize" | "unmaximize" | "close" | "closed",
    listener: () => void,
  ): unknown;
}

export interface DesktopWindowStateStore {
  restore(workAreas: ReadonlyArray<DesktopWindowBounds>): RestoredDesktopWindowState;
  track(window: DesktopWindowStateTarget, restored: RestoredDesktopWindowState): void;
  /** Right before a window's first show(): maximizes it once when the restored state was maximized. */
  beforeFirstShow(window: DesktopWindowStateTarget): void;
  /** Write every tracked window's pending change now (paths that end with app.exit()). */
  flushAll(): void;
}

function sameBounds(a: DesktopWindowBounds, b: DesktopWindowBounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function sameState(a: PersistedDesktopWindowState, b: PersistedDesktopWindowState): boolean {
  return a.isMaximized === b.isMaximized && sameBounds(a.bounds, b.bounds);
}

function roundBounds(bounds: DesktopWindowBounds): DesktopWindowBounds {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
}

interface WindowStateTracker {
  readonly window: DesktopWindowStateTarget;
  /** What the file holds for this window (or what it opened with): never written again. */
  reference: PersistedDesktopWindowState;
  /** A change not written yet. */
  pending: PersistedDesktopWindowState | null;
  timer: ReturnType<typeof setTimeout> | null;
  saveFailureLogged: boolean;
  invalidSnapshotLogged: boolean;
}

export function createDesktopWindowStateStore(input: {
  readonly filePath: string;
  readonly log: (line: string) => void;
  readonly debounceMs?: number;
  /** For the restore duration in the log line. */
  readonly now?: () => number;
  /** False where the window system reports a fake position (see isWindowPositionUnreported). */
  readonly positionReported?: boolean;
  /** Replaces the file write (tests count writes). */
  readonly write?: (filePath: string, state: PersistedDesktopWindowState) => void;
}): DesktopWindowStateStore {
  const debounceMs = input.debounceMs ?? DESKTOP_WINDOW_STATE_SAVE_DEBOUNCE_MS;
  const now = input.now ?? (() => performance.now());
  const positionReported = input.positionReported ?? true;
  const write = input.write ?? writeDesktopWindowState;
  // The file's content as last read or written. Read once: on macOS a closed
  // window's successor opens where it was without reading the file again.
  let latest: DesktopWindowStateRead | undefined;
  const trackers = new Set<WindowStateTracker>();
  // Maximize waits for the first show (one visible transition); until then the
  // window counts as maximized.
  const maximizeBeforeFirstShow = new WeakMap<DesktopWindowStateTarget, boolean>();

  const clearTimer = (tracker: WindowStateTracker) => {
    if (tracker.timer !== null) clearTimeout(tracker.timer);
    tracker.timer = null;
  };

  const snapshot = (tracker: WindowStateTracker): PersistedDesktopWindowState => {
    const { window } = tracker;
    // A minimized or fullscreen window cannot be moved or resized, and what it
    // reports then is wrong: isMaximized() is false even when it returns to
    // maximized, and on macOS a maximized window that is minimized reports its
    // maximized frame as its normal bounds. It keeps its last normal state.
    if (window.isMinimized() || window.isFullScreen()) return tracker.pending ?? tracker.reference;
    let bounds = roundBounds(window.getNormalBounds());
    if (!positionReported && latest?.kind === "saved") {
      bounds = { ...bounds, x: latest.state.bounds.x, y: latest.state.bounds.y };
    }
    const isMaximized = maximizeBeforeFirstShow.get(window) === true || window.isMaximized();
    return { version: 1, bounds, isMaximized };
  };

  const persist = (tracker: WindowStateTracker, state: PersistedDesktopWindowState) => {
    if (sameState(state, tracker.reference)) {
      tracker.pending = null;
      return;
    }
    // The reader rejects such a state and would drop the whole file.
    if (parseDesktopWindowState(state) === null) {
      tracker.pending = null;
      if (!tracker.invalidSnapshotLogged) {
        tracker.invalidSnapshotLogged = true;
        const { x, y, width, height } = state.bounds;
        input.log(
          `window state not saved; invalid bounds x=${x} y=${y} width=${width} height=${height}`,
        );
      }
      return;
    }
    try {
      write(input.filePath, state);
    } catch (error) {
      // Kept, so the window's close retries it.
      tracker.pending = state;
      if (!tracker.saveFailureLogged) {
        tracker.saveFailureLogged = true;
        input.log(`window state save failed message=${describeErrorForLog(error)}`);
      }
      return;
    }
    tracker.saveFailureLogged = false;
    tracker.reference = state;
    tracker.pending = null;
    latest = { kind: "saved", state };
  };

  const schedule = (tracker: WindowStateTracker) => {
    if (!trackers.has(tracker) || tracker.window.isDestroyed()) return;
    const next = snapshot(tracker);
    clearTimer(tracker);
    if (sameState(next, tracker.reference)) {
      tracker.pending = null;
      return;
    }
    tracker.pending = next;
    const timer = setTimeout(() => {
      tracker.timer = null;
      if (tracker.pending !== null) persist(tracker, tracker.pending);
    }, debounceMs);
    timer.unref?.();
    tracker.timer = timer;
  };

  /** Write the live state now (the window is still alive) or the last pending one. */
  const flush = (tracker: WindowStateTracker) => {
    clearTimer(tracker);
    if (!tracker.window.isDestroyed()) tracker.pending = snapshot(tracker);
    if (tracker.pending !== null) persist(tracker, tracker.pending);
  };

  return {
    restore(workAreas) {
      const startedAt = now();
      latest ??= readDesktopWindowState(input.filePath);
      const restored = resolveRestoredDesktopWindowState({ read: latest, workAreas });
      const elapsedMs = (now() - startedAt).toFixed(2);
      input.log(
        `window state restore source=${restored.source} clamped=${restored.clamped} maximized=${restored.maximize} ms=${elapsedMs}${restored.source === "unreadable" ? "; using the default size" : ""}`,
      );
      return restored;
    },

    track(window, restored) {
      maximizeBeforeFirstShow.set(window, restored.maximize);
      const tracker: WindowStateTracker = {
        window,
        reference: {
          version: 1,
          bounds: roundBounds(window.getNormalBounds()),
          isMaximized: restored.maximize,
        },
        pending: null,
        timer: null,
        saveFailureLogged: false,
        invalidSnapshotLogged: false,
      };
      // What the window opened with. A clamped restore therefore reaches the
      // file only once the user moves, resizes, maximizes or unmaximizes it, so
      // a position on a monitor that is missing this launch survives it.
      tracker.reference = snapshot(tracker);
      trackers.add(tracker);
      const onChange = () => schedule(tracker);
      window.on("resize", onChange);
      window.on("move", onChange);
      window.on("maximize", onChange);
      window.on("unmaximize", onChange);
      window.on("close", () => {
        if (trackers.has(tracker)) flush(tracker);
      });
      // Also emitted by destroy(), which skips `close`.
      window.on("closed", () => {
        if (!trackers.has(tracker)) return;
        clearTimer(tracker);
        if (tracker.pending !== null) persist(tracker, tracker.pending);
        trackers.delete(tracker);
      });
    },

    beforeFirstShow(window) {
      const maximize = maximizeBeforeFirstShow.get(window);
      if (maximize === undefined) return;
      // Still flagged while it maximizes, so the resulting event reads as unchanged.
      if (maximize && !window.isDestroyed()) window.maximize();
      maximizeBeforeFirstShow.delete(window);
    },

    flushAll() {
      for (const tracker of trackers) flush(tracker);
    },
  };
}
