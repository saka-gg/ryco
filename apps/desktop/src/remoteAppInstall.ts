/**
 * remoteAppInstall - Installs an app update another device asked for.
 *
 * "Update everything" on a remote client reaches this app through its backend's pipe as
 * `app-update-install {requestId, targetVersion}`. The installer makes sure the update
 * feed offers exactly that version, downloads it, then counts down so someone at this
 * machine can postpone the relaunch (or skip the wait). Without an answer it hands off to
 * the app's regular install path, which stops the backend and relaunches.
 *
 * Phases (`DesktopRemoteInstallState.phase`):
 * - `downloading`: preparing the updater, checking the feed, downloading.
 * - `countdown`: downloaded; relaunching at `restartAt` unless someone postpones.
 * - `installing`: handed off to the install path (also when someone at this machine
 *   clicked "Restart to update" while a remote install was pending).
 * - `postponed`: someone here postponed it. The download stays installable.
 * - `failed`: terminal, with a message for the requesting device.
 *
 * Pure apart from the injected effects, so the flow is testable without Electron.
 *
 * @module remoteAppInstall
 */
import type { DesktopRemoteInstallState, DesktopUpdateState } from "@ryco/contracts";

export const REMOTE_INSTALL_COUNTDOWN_MS = 30_000;
/** Keeps the message inside the pipe protocol's text bound with room to spare. */
const REMOTE_INSTALL_MESSAGE_MAX_LENGTH = 1_000;

export type RemoteInstallResponse = "now" | "postpone";

export function parseRemoteInstallResponse(value: unknown): RemoteInstallResponse | null {
  return value === "now" || value === "postpone" ? value : null;
}

/** A remote install whose flow is still running; another request has to wait for it. */
export function isRemoteInstallActive(
  remoteInstall: DesktopRemoteInstallState | null | undefined,
): boolean {
  return (
    remoteInstall?.phase === "downloading" ||
    remoteInstall?.phase === "countdown" ||
    remoteInstall?.phase === "installing"
  );
}

export type RemoteInstallEvent =
  | { readonly type: "requested"; readonly requestId: string; readonly targetVersion: string }
  | { readonly type: "count-down"; readonly restartAt: string }
  | { readonly type: "installing" }
  | { readonly type: "postponed" }
  | { readonly type: "failed"; readonly message: string };

function boundedMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) return "The update failed.";
  return trimmed.length > REMOTE_INSTALL_MESSAGE_MAX_LENGTH
    ? `${trimmed.slice(0, REMOTE_INSTALL_MESSAGE_MAX_LENGTH - 1)}…`
    : trimmed;
}

/** Transitions that do not apply to the current phase return the state unchanged. */
export function reduceRemoteInstall(
  state: DesktopRemoteInstallState | null,
  event: RemoteInstallEvent,
): DesktopRemoteInstallState | null {
  switch (event.type) {
    case "requested":
      return {
        requestId: event.requestId,
        targetVersion: event.targetVersion,
        phase: "downloading",
        restartAt: null,
        message: null,
      };
    case "count-down":
      return state?.phase === "downloading"
        ? { ...state, phase: "countdown", restartAt: event.restartAt }
        : state;
    case "installing":
      return state !== null &&
        (state.phase === "downloading" ||
          state.phase === "countdown" ||
          state.phase === "postponed")
        ? { ...state, phase: "installing", restartAt: null }
        : state;
    case "postponed":
      return state?.phase === "countdown"
        ? { ...state, phase: "postponed", restartAt: null }
        : state;
    case "failed":
      return state !== null && isRemoteInstallActive(state)
        ? { ...state, phase: "failed", restartAt: null, message: boundedMessage(event.message) }
        : state;
  }
}

/** The report for a request refused because another one is still running. */
export function refusedRemoteInstall(
  requestId: string,
  targetVersion: string,
  message: string,
): DesktopRemoteInstallState {
  return {
    requestId,
    targetVersion,
    phase: "failed",
    restartAt: null,
    message: boundedMessage(message),
  };
}

export interface RemoteAppInstallerEffects {
  /** The updater's state right now; read again after every await. */
  readonly updateState: () => DesktopUpdateState;
  /** Store the new remote install in the update state and broadcast it. */
  readonly publish: (remoteInstall: DesktopRemoteInstallState | null) => void;
  /** Tell the backend a request was refused, without replacing the running one. */
  readonly reportRefused: (refused: DesktopRemoteInstallState) => void;
  /** Make the updater usable; resolves with why it cannot be used, or `null`. */
  readonly prepareUpdater: () => Promise<string | null>;
  /** Check the feed, or wait for the check already running; the outcome is in the state. */
  readonly checkForUpdate: () => Promise<void>;
  /** Download the available update, or wait for the running download. */
  readonly downloadUpdate: () => Promise<void>;
  /**
   * Hand off to the app's install path. Resolves `null` once handed off (the path reports
   * its own failures through {@link RemoteAppInstaller.installFailed}), or with why it
   * refused to start.
   */
  readonly installUpdate: () => Promise<string | null>;
  /** The countdown started (e.g. notify someone at this machine when no window is open). */
  readonly countdownStarted: (remoteInstall: DesktopRemoteInstallState) => void;
  readonly now: () => number;
  /** Run `callback` after `delayMs`; returns the cancel function. */
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
}

export interface RemoteAppInstaller {
  readonly current: () => DesktopRemoteInstallState | null;
  readonly isActive: () => boolean;
  /** Handle an `app-update-install` frame. Never rejects. */
  readonly request: (requestId: string, targetVersion: string) => Promise<void>;
  /** Someone at this machine answered the countdown. */
  readonly respond: (action: RemoteInstallResponse) => DesktopRemoteInstallState | null;
  /** The install path is starting, whoever started it: the countdown is over. */
  readonly installStarting: () => void;
  /** The install path failed after it started. */
  readonly installFailed: (message: string) => void;
  /** Stop the countdown and drop pending continuations (the app is quitting). */
  readonly dispose: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function offersVersion(state: DesktopUpdateState, version: string): boolean {
  return state.availableVersion === version || state.downloadedVersion === version;
}

function feedMismatchMessage(state: DesktopUpdateState, targetVersion: string): string {
  if (state.status === "error" && state.errorContext === "check" && state.message) {
    return `Could not check for updates: ${state.message}`;
  }
  const offered = state.downloadedVersion ?? state.availableVersion;
  return offered === null
    ? `This app's update feed does not offer ${targetVersion}.`
    : `This app's update feed offers ${offered}, not ${targetVersion}.`;
}

function downloadFailureMessage(state: DesktopUpdateState, targetVersion: string): string {
  return state.errorContext === "download" && state.message
    ? `Could not download ${targetVersion}: ${state.message}`
    : `The download of ${targetVersion} did not finish.`;
}

export function createRemoteAppInstaller(effects: RemoteAppInstallerEffects): RemoteAppInstaller {
  let state: DesktopRemoteInstallState | null = null;
  // Bumped by each accepted request and by dispose; a continuation from an older flow
  // must not touch the state.
  let flow = 0;
  let cancelCountdown: (() => void) | null = null;

  const stopCountdown = () => {
    const cancel = cancelCountdown;
    cancelCountdown = null;
    cancel?.();
  };
  const apply = (event: RemoteInstallEvent) => {
    const next = reduceRemoteInstall(state, event);
    if (next === state) return;
    state = next;
    if (state?.phase !== "countdown") stopCountdown();
    effects.publish(state);
  };
  const live = (id: number, phase: DesktopRemoteInstallState["phase"]) =>
    id === flow && state?.phase === phase;

  const install = async () => {
    if (state?.phase !== "countdown" && state?.phase !== "postponed") return;
    apply({ type: "installing" });
    const id = flow;
    let refusal: string | null;
    try {
      refusal = await effects.installUpdate();
    } catch (error) {
      refusal = errorMessage(error);
    }
    if (refusal !== null && live(id, "installing")) apply({ type: "failed", message: refusal });
  };

  const run = async (id: number, targetVersion: string) => {
    const unavailable = await effects.prepareUpdater();
    if (!live(id, "downloading")) return;
    if (unavailable !== null) {
      apply({ type: "failed", message: unavailable });
      return;
    }

    let update = effects.updateState();
    if (update.currentVersion === targetVersion) {
      apply({ type: "failed", message: `This app already runs ${targetVersion}.` });
      return;
    }
    // A check cannot run while a download is under way or done; those already name
    // the version they hold.
    if (
      !offersVersion(update, targetVersion) &&
      update.status !== "downloading" &&
      update.status !== "downloaded"
    ) {
      await effects.checkForUpdate();
      if (!live(id, "downloading")) return;
      update = effects.updateState();
    }
    if (!offersVersion(update, targetVersion)) {
      apply({ type: "failed", message: feedMismatchMessage(update, targetVersion) });
      return;
    }

    if (update.status !== "downloaded" || update.downloadedVersion !== targetVersion) {
      await effects.downloadUpdate();
      if (!live(id, "downloading")) return;
      update = effects.updateState();
      if (update.status !== "downloaded" || update.downloadedVersion !== targetVersion) {
        apply({ type: "failed", message: downloadFailureMessage(update, targetVersion) });
        return;
      }
    }

    const restartAt = new Date(effects.now() + REMOTE_INSTALL_COUNTDOWN_MS).toISOString();
    apply({ type: "count-down", restartAt });
    if (!live(id, "countdown") || state === null) return;
    cancelCountdown = effects.schedule(() => {
      cancelCountdown = null;
      if (live(id, "countdown")) void install();
    }, REMOTE_INSTALL_COUNTDOWN_MS);
    try {
      effects.countdownStarted(state);
    } catch {
      // A notification that cannot be shown must not stop the countdown.
    }
  };

  return {
    current: () => state,
    isActive: () => isRemoteInstallActive(state),
    request: async (requestId, targetVersion) => {
      // The backend may repeat a request (e.g. after a reconnect); it keeps its flow.
      if (state?.requestId === requestId) return;
      if (isRemoteInstallActive(state)) {
        effects.reportRefused(
          refusedRemoteInstall(requestId, targetVersion, "Another update is already in progress."),
        );
        return;
      }
      stopCountdown();
      const id = ++flow;
      apply({ type: "requested", requestId, targetVersion });
      try {
        await run(id, targetVersion);
      } catch (error) {
        if (live(id, "downloading")) apply({ type: "failed", message: errorMessage(error) });
      }
    },
    respond: (action) => {
      if (action === "now") {
        void install();
      } else {
        apply({ type: "postponed" });
      }
      return state;
    },
    installStarting: () => apply({ type: "installing" }),
    installFailed: (message) => {
      if (state?.phase === "installing") apply({ type: "failed", message });
    },
    dispose: () => {
      flow += 1;
      stopCountdown();
    },
  };
}
