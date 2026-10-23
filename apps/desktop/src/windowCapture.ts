// FILE: windowCapture.ts
// Purpose: Composer window capture on macOS: the picker's window list and
// captures, the optional global shortcut, and their delivery to the renderer.
// Layer: Desktop main-process service (loaded lazily after Electron is ready)
// Depends on: DesktopAppSnapManager and its signed native helper.
//
// The service owns its own AppSnap manager, separate from the Computer Use
// beta's: capturing a window for the composer must not require turning that
// beta on. Both run the same helper inside this app, so a macOS grant given
// through either setup serves both.

import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import type {
  DesktopAppSnapCapture,
  DesktopAppSnapKeyChord,
  DesktopAppSnapPermissionKind,
  DesktopAppSnapSettingsPane,
  DesktopAppSnapShortcut,
  DesktopAppSnapState,
  DesktopAppSnapWindowEntry,
  DesktopWindowCapturePendingEntry,
  DesktopWindowCaptureShortcutResult,
  DesktopWindowCaptureState,
} from "@ryco/contracts";
import { isAppSnapShortcut } from "@ryco/shared/appSnapShortcut";
import type { IpcMain, WebContents } from "electron";

import { DesktopAppSnapManager, type DesktopAppSnapManagerOptions } from "./appSnapManager.ts";
import { macPrivacySettingsUrl, resolveMacAppBundle } from "./macAppBundle.ts";
import { WINDOW_CAPTURE_IPC } from "./windowCaptureChannels.ts";

const PREFERENCES_VERSION = 1;
const PREFERENCES_FILE = "window-capture.json";
const CAPTURE_DIRECTORY = "window-captures";
/** With the shortcut off, the listener stops this long after the last picker request. */
const PICKER_IDLE_STOP_MS = 2 * 60 * 1000;
const MAX_MACOS_WINDOW_ID = 0xffff_ffff;
const MAX_CAPTURE_ID_LENGTH = 128;
/** The grants window capture can set up; it never needs Accessibility. */
const SETUP_PERMISSIONS: ReadonlySet<unknown> = new Set<DesktopAppSnapPermissionKind>([
  "screenRecording",
  "inputMonitoring",
]);

export type WindowCaptureManager = Pick<
  DesktopAppSnapManager,
  | "getState"
  | "listenerState"
  | "refreshState"
  | "setEnabled"
  | "setShortcut"
  | "setShortcutEnabled"
  | "checkShortcut"
  | "startPermissionSetup"
  | "listWindows"
  | "captureWindow"
  | "listPendingCaptureEntries"
  | "readPendingCapture"
  | "acknowledgeCapture"
  | "dispose"
>;

export interface DesktopWindowCaptureOptions {
  readonly platform: NodeJS.Platform;
  readonly helperPath: string;
  readonly stateDir: string;
  readonly excludedBundleId: string;
  readonly appDisplayName: string;
  readonly appBundlePath?: string | undefined;
  readonly shortcutRegistry: NonNullable<DesktopAppSnapManagerOptions["shortcutRegistry"]>;
  readonly openSettingsPane: (pane: DesktopAppSnapSettingsPane) => void;
  /** Pushes an event to the renderer; dropped while no window can take it. */
  readonly send: (channel: string, payload: unknown) => void;
  /** Brings the app forward so the user can write about a shortcut capture. */
  readonly revealWindow: () => void;
  readonly createManager?: (options: DesktopAppSnapManagerOptions) => WindowCaptureManager;
  readonly pickerIdleStopMs?: number;
}

/**
 * The shared helper's copy still names its Synara origin ("AppSnap"); this
 * surface calls the feature window capture.
 */
export function windowCaptureMessage(message: string): string {
  return message
    .replace(/\bAppSnap capture\b/g, "window capture")
    .replace(/\bthe captured AppSnap\b/g, "the capture")
    .replace(/\bAppSnaps\b/g, "captures")
    .replace(/\bAppSnap\b/g, "window capture")
    .replace(/(^|[.!?]\s+)window capture/g, (_match, start: string) => `${start}Window capture`);
}

/** Screen Recording for any capture; the Option-key shortcut also runs an event tap. */
export function requiredWindowCapturePermissions(
  shortcut: DesktopAppSnapShortcut | null,
): DesktopAppSnapPermissionKind[] {
  return shortcut?.kind === "both-option-keys"
    ? ["screenRecording", "inputMonitoring"]
    : ["screenRecording"];
}

function permissionOf(state: DesktopAppSnapState, kind: DesktopAppSnapPermissionKind) {
  if (kind === "screenRecording") return state.screenRecordingPermission;
  if (kind === "inputMonitoring") return state.inputMonitoringPermission;
  return state.accessibilityPermission ?? "unknown";
}

function shortcutGrantsHeld(
  state: DesktopAppSnapState,
  shortcut: DesktopAppSnapShortcut | null,
): boolean {
  return (
    shortcut !== null &&
    requiredWindowCapturePermissions(shortcut).every(
      (kind) => permissionOf(state, kind) === "granted",
    )
  );
}

/** The grants a setup request names; none means those the current setup needs. */
function setupPermissions(input: unknown): DesktopAppSnapPermissionKind[] | null {
  if (input === undefined || input === null) return null;
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    !input.every((kind) => SETUP_PERMISSIONS.has(kind))
  ) {
    throw new Error("Choose which permissions to set up.");
  }
  return [...new Set(input as DesktopAppSnapPermissionKind[])];
}

function isCaptureId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CAPTURE_ID_LENGTH;
}

function normalizeShortcut(shortcut: DesktopAppSnapShortcut): DesktopAppSnapShortcut {
  return shortcut.kind === "both-option-keys"
    ? { kind: "both-option-keys" }
    : { kind: "key-chord", modifier: shortcut.modifier, key: shortcut.key };
}

async function readShortcutPreference(path: string): Promise<DesktopAppSnapShortcut | null> {
  try {
    const parsed = JSON.parse(await FS.promises.readFile(path, "utf8")) as {
      readonly version?: unknown;
      readonly shortcut?: unknown;
    };
    return parsed.version === PREFERENCES_VERSION && isAppSnapShortcut(parsed.shortcut)
      ? normalizeShortcut(parsed.shortcut)
      : null;
  } catch {
    // Missing or unreadable preferences leave the shortcut off.
    return null;
  }
}

async function writeShortcutPreference(
  path: string,
  shortcut: DesktopAppSnapShortcut | null,
): Promise<void> {
  await FS.promises.mkdir(Path.dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Crypto.randomUUID()}.tmp`;
  try {
    await FS.promises.writeFile(
      temporaryPath,
      `${JSON.stringify({ version: PREFERENCES_VERSION, shortcut })}\n`,
      { mode: 0o600 },
    );
    await FS.promises.rename(temporaryPath, path);
  } finally {
    await FS.promises.unlink(temporaryPath).catch(() => undefined);
  }
}

export class DesktopWindowCapture {
  readonly #options: DesktopWindowCaptureOptions;
  readonly #manager: WindowCaptureManager;
  readonly #preferencesPath: string;
  #shortcut: DesktopAppSnapShortcut | null = null;
  // Settles once the saved shortcut is loaded; anything that reads or
  // replaces the shortcut waits for it, so a late load never wins.
  #loaded: Promise<void> = Promise.resolve();
  // The shortcut is armed only while its grants are held and its key combo is
  // free, so neither ever blocks the picker, which needs Screen Recording alone.
  #armed = false;
  // Whether the shortcut's grants were held at the last sync; a change in the
  // manager's state (the setup guide, a revoke) syncs again.
  #grantsHeld = false;
  // Why a saved key combo stays unarmed although its grants are held.
  #shortcutConflict: string | null = null;
  // Shortcut syncs run one at a time; a grant change or a retry of a held
  // combo queues at most one more.
  #shortcutSync: Promise<void> = Promise.resolve();
  #syncQueued = false;
  #idleStopTimer: NodeJS.Timeout | null = null;
  #activeRequests = 0;
  #lastPublishedStateJson: string | null = null;
  #disposed = false;

  constructor(options: DesktopWindowCaptureOptions) {
    this.#options = options;
    this.#preferencesPath = Path.join(options.stateDir, PREFERENCES_FILE);
    const createManager =
      options.createManager ?? ((managerOptions) => new DesktopAppSnapManager(managerOptions));
    this.#manager = createManager({
      platform: options.platform,
      helperPath: options.helperPath,
      captureDirectory: Path.join(options.stateDir, CAPTURE_DIRECTORY),
      excludedBundleId: options.excludedBundleId,
      appDisplayName: options.appDisplayName,
      ...(options.appBundlePath ? { appBundlePath: options.appBundlePath } : {}),
      shortcutRegistry: options.shortcutRegistry,
      openSettingsPane: options.openSettingsPane,
      onState: (state) => {
        this.#publishState();
        this.#followGrants(state);
      },
      // Only shortcut captures arrive here; picker captures resolve their
      // request. Either way the capture stays pending until acknowledged, so
      // a renderer that is loading or closed drains it later.
      onCaptured: (capture) => {
        this.#options.revealWindow();
        this.#options.send(WINDOW_CAPTURE_IPC.captured, capture);
      },
      onError: (error, focusApp) => {
        if (focusApp) this.#options.revealWindow();
        this.#options.send(WINDOW_CAPTURE_IPC.error, {
          ...error,
          message: windowCaptureMessage(error.message),
        });
      },
    });
  }

  /**
   * Arms a saved shortcut. Only a preflight grant check runs here: startup
   * never raises a macOS prompt or opens System Settings.
   */
  start(): Promise<void> {
    this.#loaded = (async () => {
      this.#shortcut = await readShortcutPreference(this.#preferencesPath);
      if (this.#disposed) return;
      if (this.#shortcut) await this.#manager.setShortcut(this.#shortcut);
      await this.#syncShortcut({ check: true });
    })();
    return this.#loaded;
  }

  state(): DesktopWindowCaptureState {
    const appSnap = this.#manager.getState();
    const reportsMessage =
      appSnap.status === "error" ||
      appSnap.status === "permission-required" ||
      appSnap.status === "unsupported";
    const managerMessage =
      reportsMessage && appSnap.message ? windowCaptureMessage(appSnap.message) : null;
    return {
      supported: appSnap.supported,
      shortcut: this.#shortcut,
      screenRecordingPermission: appSnap.screenRecordingPermission,
      inputMonitoringPermission: appSnap.inputMonitoringPermission,
      missingPermissions: requiredWindowCapturePermissions(this.#shortcut).filter(
        (kind) => permissionOf(appSnap, kind) !== "granted",
      ),
      message: managerMessage ?? this.#shortcutConflict,
      appDisplayName: appSnap.appDisplayName,
    };
  }

  /** A cached preflight check; it also arms a saved shortcut once its grants land. */
  async refresh(): Promise<DesktopWindowCaptureState> {
    await this.#loaded.catch(() => undefined);
    await this.#manager.refreshState(requiredWindowCapturePermissions(this.#shortcut));
    await this.#syncShortcut({ check: false });
    return this.state();
  }

  /**
   * Tries a saved key combo again that was taken at the last check; `main.ts`
   * calls this whenever the app becomes active, the moment the user may have
   * quit the app that held it. A free combo arms; a held one costs one probe.
   */
  retryHeldShortcut(): void {
    if (this.#shortcutConflict !== null) this.#queueShortcutSync();
  }

  /**
   * Guides the user through the named grants, or those the current setup
   * needs. The picker names Screen Recording alone: it never needs the
   * Option-key shortcut's Input Monitoring.
   */
  async setup(permissions?: unknown): Promise<DesktopWindowCaptureState> {
    const kinds = setupPermissions(permissions);
    await this.#loaded.catch(() => undefined);
    await this.#manager.startPermissionSetup(
      kinds ?? requiredWindowCapturePermissions(this.#shortcut),
    );
    return this.state();
  }

  /** A shortcut that macOS, another app or typing already uses is reported, not saved. */
  async setShortcut(shortcut: unknown): Promise<DesktopWindowCaptureShortcutResult> {
    if (shortcut !== null && !isAppSnapShortcut(shortcut)) {
      throw new Error("Choose one modifier and one supported keyboard key.");
    }
    await this.#loaded.catch(() => undefined);
    if (shortcut !== null) {
      const availability = this.#manager.checkShortcut(shortcut);
      if (!availability.available) return { state: this.state(), availability };
    }
    const next = shortcut === null ? null : normalizeShortcut(shortcut);
    await writeShortcutPreference(this.#preferencesPath, next);
    this.#shortcut = next;
    if (next) await this.#manager.setShortcut(next);
    await this.#syncShortcut({ check: next !== null });
    return { state: this.state(), availability: { available: true, reason: null } };
  }

  listWindows(): Promise<DesktopAppSnapWindowEntry[]> {
    return this.#withListener(() => this.#manager.listWindows());
  }

  captureWindow(windowId: unknown): Promise<DesktopAppSnapCapture> {
    if (
      typeof windowId !== "number" ||
      !Number.isInteger(windowId) ||
      windowId <= 0 ||
      windowId > MAX_MACOS_WINDOW_ID
    ) {
      return Promise.reject(new Error("Choose a window to capture."));
    }
    return this.#withListener(() => this.#manager.captureWindow(windowId));
  }

  /** Metadata only: the renderer reads the bytes of the captures it still needs. */
  listPendingCaptures(): Promise<DesktopWindowCapturePendingEntry[]> {
    return this.#manager.listPendingCaptureEntries();
  }

  async readPendingCapture(captureId: unknown): Promise<DesktopAppSnapCapture | null> {
    return isCaptureId(captureId) ? await this.#manager.readPendingCapture(captureId) : null;
  }

  async acknowledgeCapture(captureId: unknown): Promise<void> {
    if (isCaptureId(captureId)) await this.#manager.acknowledgeCapture(captureId);
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearIdleStop();
    this.#manager.dispose();
  }

  /**
   * Runs a picker request against a listening helper, starting it on demand.
   * With the shortcut off it needs only Screen Recording and stops again
   * once the picker has been idle for a while.
   */
  async #withListener<T>(run: () => Promise<T>): Promise<T> {
    this.#clearIdleStop();
    this.#activeRequests += 1;
    try {
      await this.#loaded.catch(() => undefined);
      // Only the listener's own health counts: a sticky setup failure in the
      // manager's state leaves a running listener able to serve the request.
      if (!this.#manager.listenerState().listening) {
        await this.#manager.setEnabled(true);
        // The check that enabling ran may have changed what the shortcut can
        // arm; settle that before the request so it reaches the final listener.
        await this.#syncShortcut({ check: false });
        const listener = this.#manager.listenerState();
        if (!listener.listening) {
          throw new Error(listener.message ?? "Window capture is unavailable.");
        }
      }
      return await run();
    } catch (error) {
      throw new Error(
        windowCaptureMessage(error instanceof Error ? error.message : String(error)),
        { cause: error },
      );
    } finally {
      this.#activeRequests -= 1;
      this.#scheduleIdleStop();
    }
  }

  #syncShortcut(options: { readonly check: boolean }): Promise<void> {
    const run = this.#shortcutSync.then(() => this.#applyShortcut(options));
    this.#shortcutSync = run.catch(() => undefined);
    return run;
  }

  /** Grants that land through the setup guide, or a revoke, re-sync the shortcut. */
  #followGrants(state: DesktopAppSnapState): void {
    if (shortcutGrantsHeld(state, this.#shortcut) !== this.#grantsHeld) this.#queueShortcutSync();
  }

  /**
   * Queues one sync behind the running ones; requests while it waits join it.
   * It runs only if it still matters then: the grants changed, or a saved
   * combo is still unarmed because it was taken.
   */
  #queueShortcutSync(): void {
    if (this.#disposed || this.#syncQueued) return;
    this.#syncQueued = true;
    const run = this.#shortcutSync.then(async () => {
      this.#syncQueued = false;
      if (this.#disposed) return;
      const grantsChanged =
        shortcutGrantsHeld(this.#manager.getState(), this.#shortcut) !== this.#grantsHeld;
      if (grantsChanged || this.#shortcutConflict !== null) {
        await this.#applyShortcut({ check: false });
      }
    });
    this.#shortcutSync = run.catch(() => undefined);
  }

  /**
   * Arms the shortcut while its grants are held and its key combo is free,
   * and keeps the listener running for it; disarming stops a listener no
   * picker request is using.
   */
  async #applyShortcut(options: { readonly check: boolean }): Promise<void> {
    const shortcut = this.#shortcut;
    const appSnap =
      shortcut && options.check
        ? await this.#manager.refreshState(requiredWindowCapturePermissions(shortcut))
        : this.#manager.getState();
    if (this.#disposed) return;
    this.#grantsHeld = shortcutGrantsHeld(appSnap, shortcut);
    // A combo another app took since it was saved stays saved but unarmed:
    // a failed reservation would stop the listener the picker needs too.
    this.#shortcutConflict =
      this.#grantsHeld && shortcut?.kind === "key-chord" ? this.#chordConflict(shortcut) : null;
    const wasArmed = this.#armed;
    const attempt = this.#grantsHeld && this.#shortcutConflict === null;
    let armed = attempt;
    let startedListener = false;
    if (attempt) {
      this.#clearIdleStop();
      await this.#manager.setShortcutEnabled(true);
      if (!this.#manager.getState().enabled) {
        startedListener = true;
        await this.#manager.setEnabled(true);
      }
      if (shortcut?.kind === "key-chord" && !this.#manager.listenerState().listening) {
        // Another app may have taken the combo after the check above.
        this.#shortcutConflict = this.#chordConflict(shortcut);
        armed = this.#shortcutConflict === null;
      }
    }
    // Armed only once arming worked: a failed attempt must not count as a
    // shortcut that kept the listener running.
    this.#armed = armed;
    if (armed) {
      // A picker request that ended during the attempt may have scheduled one.
      this.#clearIdleStop();
    } else {
      if ((wasArmed || startedListener) && this.#activeRequests === 0) {
        // Stop first: disarming a running listener would restart it for requests.
        this.#clearIdleStop();
        await this.#manager.setEnabled(false);
      }
      await this.#manager.setShortcutEnabled(false);
      // The attempt cleared the idle stop of a listener a picker request started.
      if (attempt && this.#manager.getState().enabled) this.#scheduleIdleStop();
    }
    this.#publishState();
  }

  #chordConflict(shortcut: DesktopAppSnapKeyChord): string | null {
    const availability = this.#manager.checkShortcut(shortcut);
    return availability.available
      ? null
      : (availability.reason ?? "macOS or another app is already using this shortcut.");
  }

  #scheduleIdleStop(): void {
    if (this.#disposed || this.#armed || this.#activeRequests > 0) return;
    this.#clearIdleStop();
    const timer = setTimeout(() => {
      if (this.#idleStopTimer !== timer) return;
      this.#idleStopTimer = null;
      if (this.#disposed || this.#armed || this.#activeRequests > 0) return;
      void this.#manager.setEnabled(false).catch(() => undefined);
    }, this.#options.pickerIdleStopMs ?? PICKER_IDLE_STOP_MS);
    timer.unref?.();
    this.#idleStopTimer = timer;
  }

  #clearIdleStop(): void {
    if (this.#idleStopTimer) clearTimeout(this.#idleStopTimer);
    this.#idleStopTimer = null;
  }

  #publishState(): void {
    if (this.#disposed) return;
    const state = this.state();
    const json = JSON.stringify(state);
    if (json === this.#lastPublishedStateJson) return;
    this.#lastPublishedStateJson = json;
    this.#options.send(WINDOW_CAPTURE_IPC.state, state);
  }
}

/** Electron wiring for the service; `main.ts` loads this module only on macOS. */
export function createDesktopWindowCapture(input: {
  readonly stateDir: string;
  readonly resourcesDir: string;
  readonly executablePath: string;
  readonly appDisplayName: string;
  readonly shortcutRegistry: DesktopWindowCaptureOptions["shortcutRegistry"];
  readonly openExternal: (url: string) => void;
  readonly send: DesktopWindowCaptureOptions["send"];
  readonly revealWindow: DesktopWindowCaptureOptions["revealWindow"];
}): DesktopWindowCapture {
  const { bundlePath, bundleId } = resolveMacAppBundle(input.executablePath, process.platform);
  return new DesktopWindowCapture({
    platform: process.platform,
    helperPath: Path.join(input.resourcesDir, "ryco-computer-ui-helper"),
    stateDir: input.stateDir,
    excludedBundleId: bundleId,
    appDisplayName: input.appDisplayName,
    appBundlePath: bundlePath,
    shortcutRegistry: input.shortcutRegistry,
    openSettingsPane: (pane) => input.openExternal(macPrivacySettingsUrl(pane)),
    send: input.send,
    revealWindow: input.revealWindow,
  });
}

interface WindowCaptureIpcWindow {
  readonly webContents: WebContents;
  isDestroyed(): boolean;
}

/** Every handler answers only the main window's top frame. */
export function registerWindowCaptureIpc(
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">,
  capture: DesktopWindowCapture,
  getWindow: () => WindowCaptureIpcWindow | null,
): void {
  const handle = (channel: string, run: (input: unknown) => unknown) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, input: unknown) => {
      const window = getWindow();
      if (
        !window ||
        window.isDestroyed() ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      ) {
        throw new Error("Window capture is available only in the Ryco desktop window.");
      }
      return run(input);
    });
  };
  handle(WINDOW_CAPTURE_IPC.getState, () => capture.refresh());
  handle(WINDOW_CAPTURE_IPC.setup, (input) => capture.setup(input));
  handle(WINDOW_CAPTURE_IPC.setShortcut, (input) => capture.setShortcut(input));
  handle(WINDOW_CAPTURE_IPC.listWindows, () => capture.listWindows());
  handle(WINDOW_CAPTURE_IPC.captureWindow, (input) => capture.captureWindow(input));
  handle(WINDOW_CAPTURE_IPC.listPendingCaptures, () => capture.listPendingCaptures());
  handle(WINDOW_CAPTURE_IPC.readPendingCapture, (input) => capture.readPendingCapture(input));
  handle(WINDOW_CAPTURE_IPC.acknowledgeCapture, (input) => capture.acknowledgeCapture(input));
}
