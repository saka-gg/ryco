import { createBackendRestartBackoff } from "./backendRestartBackoff.ts";
import { describeErrorForLog } from "./logValue.ts";
import { runRecoveryDialogLoop } from "./recoveryDialog.ts";

/**
 * Reload a window whose renderer process died (out of memory, crashed, killed)
 * instead of leaving it blank. The backend is a separate process, so agents and
 * chats keep running meanwhile; only the window's own document is reloaded.
 */
export const RENDERER_RELOAD_INITIAL_DELAY_MS = 500;
export const RENDERER_RELOAD_MAX_DELAY_MS = 4_000;
export const RENDERER_MAX_AUTOMATIC_RELOADS = 3;
/** Crashes further apart than this start a new streak. Not cleared by a successful load. */
export const RENDERER_CRASH_STREAK_GAP_MS = 60_000;

/** Exits that fail the same way on every attempt, so they are not retried automatically. */
const UNRECOVERABLE_RENDERER_EXITS: ReadonlySet<string> = new Set([
  "launch-failed",
  "integrity-failure",
]);

export type RendererCrashPromptCause = "unrecoverable" | "reload-budget-exhausted";

export type RendererCrashDecision =
  | { readonly kind: "ignore" }
  | { readonly kind: "reload"; readonly attempt: number; readonly delayMs: number }
  | {
      readonly kind: "prompt";
      readonly cause: RendererCrashPromptCause;
      readonly crashes: number;
    };

export interface RendererCrashPolicy {
  /** `reason` is a string so exit reasons added by a later Chromium still compile. */
  decide(input: {
    readonly reason: string;
    readonly quitting: boolean;
    readonly nowMs: number;
  }): RendererCrashDecision;
  /** A deliberate, user-chosen reload starts a fresh streak. */
  reset(): void;
  readonly streak: number;
}

/**
 * At most {@link RENDERER_MAX_AUTOMATIC_RELOADS} reloads per crash streak, 500,
 * 1 000 and 2 000 ms apart; every further crash in the streak prompts and never
 * reloads. A reloaded window always loads, so a successful load does not end
 * the streak (that would refill the budget on every attempt); only a quiet gap
 * longer than {@link RENDERER_CRASH_STREAK_GAP_MS} does.
 */
export function createRendererCrashPolicy(): RendererCrashPolicy {
  const backoff = createBackendRestartBackoff({
    initialDelayMs: RENDERER_RELOAD_INITIAL_DELAY_MS,
    maxDelayMs: RENDERER_RELOAD_MAX_DELAY_MS,
  });
  let streak = 0;
  let lastCrashAtMs: number | null = null;
  return {
    decide({ reason, quitting, nowMs }) {
      // Update installs and relaunches end renderers on purpose.
      if (quitting || reason === "clean-exit") return { kind: "ignore" };
      if (lastCrashAtMs !== null && nowMs - lastCrashAtMs > RENDERER_CRASH_STREAK_GAP_MS) {
        streak = 0;
        backoff.reset();
      }
      lastCrashAtMs = nowMs;
      streak += 1;
      if (UNRECOVERABLE_RENDERER_EXITS.has(reason)) {
        return { kind: "prompt", cause: "unrecoverable", crashes: streak };
      }
      if (streak > RENDERER_MAX_AUTOMATIC_RELOADS) {
        return { kind: "prompt", cause: "reload-budget-exhausted", crashes: streak };
      }
      return { kind: "reload", attempt: streak, delayMs: backoff.nextDelayMs() };
    },
    reset() {
      streak = 0;
      lastCrashAtMs = null;
      backoff.reset();
    },
    get streak() {
      return streak;
    },
  };
}

/** An automatic reload's number in its streak, or the dialog's Reload. */
export type RendererRecoveryAttempt = number | "manual";

export interface RendererCrashDialogOptions {
  readonly type: "error";
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly buttons: readonly ["Reload", "Open Logs", "Quit"];
  readonly defaultId: 0;
  /** Esc reloads: quitting with agents running from a dismissed dialog would surprise. */
  readonly cancelId: 0;
  readonly noLink: true;
}

export function buildRendererCrashDialog(input: {
  readonly appName: string;
  readonly cause: RendererCrashPromptCause;
  readonly crashes: number;
  readonly reason: string;
}): RendererCrashDialogOptions {
  const { appName } = input;
  const budgetExhausted = input.cause === "reload-budget-exhausted";
  return {
    type: "error",
    title: `${appName} window stopped`,
    message: budgetExhausted
      ? `The ${appName} window crashed ${input.crashes} times in a row.`
      : `The ${appName} window stopped unexpectedly.`,
    detail: [
      `Its page process exited (${input.reason}). Your chats and agents keep running.`,
      budgetExhausted
        ? "Automatic reloads are paused so a repeating crash cannot keep reloading."
        : "This kind of exit repeats on reload, so it was not retried automatically.",
    ].join("\n\n"),
    buttons: ["Reload", "Open Logs", "Quit"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

export interface RendererCrashRecovery {
  handleRenderProcessGone(details: { readonly reason: string; readonly exitCode: number }): void;
  /** The window started loading a new document (main frame, cross-document). */
  noteNavigationStarted(): void;
  /** The (re)loaded document reported a usable app shell. */
  noteShellUsable(): void;
  dispose(): void;
}

export interface RendererCrashRecoveryOptions {
  readonly appName: string;
  /** Monotonic milliseconds (performance.now). */
  readonly now: () => number;
  readonly isQuitting: () => boolean;
  readonly isWindowClosed: () => boolean;
  /**
   * Another path already started a fresh load of the window after the crash
   * and its navigation has not begun yet (packaged: a backend app load waiting
   * for cache maintenance). Reloading as well would race it.
   */
  readonly isLoadPending: () => boolean;
  /** The current document's kind ("app", "boot", "blank", "other", "closed"); never the URL. */
  readonly describeUrl: () => string;
  readonly recover: (attempt: RendererRecoveryAttempt) => void;
  /** Shows the window, so the dialog's sheet is visible. */
  readonly reveal: () => void;
  readonly showMessageBox: (
    options: RendererCrashDialogOptions,
  ) => Promise<{ readonly response: number }>;
  readonly openLogs: () => Promise<unknown>;
  readonly quit: () => void;
  readonly log: (line: string) => void;
  /**
   * The renderer died unexpectedly (not a clean exit, not while quitting): fail
   * requests sent to the dead document, which it can no longer answer.
   */
  readonly onRendererGone?: () => void;
}

export function createRendererCrashRecovery(
  options: RendererCrashRecoveryOptions,
): RendererCrashRecovery {
  const policy = createRendererCrashPolicy();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let dialogOpen = false;
  // The window shows a dead document: set by a crash, cleared by any new
  // navigation (ours, or a backend load that revived it first). Gating on this
  // rather than webContents.isCrashed() also covers exit reasons that
  // isCrashed() does not report, such as memory-eviction.
  let documentDead = false;
  let lastCrashAtMs = 0;
  let recovering: {
    readonly attempt: RendererRecoveryAttempt;
    readonly crashedAtMs: number;
  } | null = null;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  /** Whether a reload is still needed; logs why not otherwise. */
  const needsReload = (attempt: RendererRecoveryAttempt): boolean => {
    if (documentDead && !options.isLoadPending()) return true;
    options.log(
      `renderer already reloaded; ${attempt === "manual" ? "manual" : "automatic"} reload skipped attempt=${attempt}`,
    );
    return false;
  };

  const startRecovery = (attempt: RendererRecoveryAttempt, crashedAtMs: number) => {
    recovering = { attempt, crashedAtMs };
    options.recover(attempt);
  };

  const promptUser = async (
    decision: Extract<RendererCrashDecision, { kind: "prompt" }>,
    reason: string,
  ): Promise<void> => {
    if (dialogOpen) {
      options.log("renderer recovery prompt already open");
      return;
    }
    dialogOpen = true;
    try {
      options.reveal();
      await runRecoveryDialogLoop({
        show: () =>
          options.showMessageBox(
            buildRendererCrashDialog({
              appName: options.appName,
              cause: decision.cause,
              crashes: decision.crashes,
              reason,
            }),
          ),
        isCancelled: () => disposed || options.isQuitting(),
        openLogs: options.openLogs,
        primary: () => {
          policy.reset();
          if (!options.isWindowClosed() && needsReload("manual")) {
            startRecovery("manual", lastCrashAtMs);
          }
        },
        quit: () => {
          options.log("renderer recovery: quit chosen");
          options.quit();
        },
      });
    } catch (error) {
      options.log(`renderer recovery prompt failed message=${describeErrorForLog(error)}`);
    } finally {
      dialogOpen = false;
    }
  };

  return {
    handleRenderProcessGone(details) {
      if (disposed) return;
      options.log(
        `renderer process gone reason=${details.reason} exitCode=${details.exitCode} url=${options.describeUrl()}`,
      );
      const crashedAtMs = options.now();
      const decision = policy.decide({
        reason: details.reason,
        quitting: options.isQuitting(),
        nowMs: crashedAtMs,
      });
      if (decision.kind === "ignore") return;
      options.onRendererGone?.();
      documentDead = true;
      lastCrashAtMs = crashedAtMs;
      clearTimer();
      if (decision.kind === "reload") {
        const { attempt, delayMs } = decision;
        options.log(
          `renderer reload scheduled attempt=${attempt}/${RENDERER_MAX_AUTOMATIC_RELOADS} delayMs=${delayMs}`,
        );
        timer = setTimeout(() => {
          timer = null;
          if (disposed || options.isQuitting() || options.isWindowClosed()) return;
          if (needsReload(attempt)) startRecovery(attempt, crashedAtMs);
        }, delayMs);
        return;
      }
      options.log(`renderer recovery prompt cause=${decision.cause} crashes=${decision.crashes}`);
      void promptUser(decision, details.reason);
    },

    noteNavigationStarted() {
      documentDead = false;
    },

    noteShellUsable() {
      if (recovering === null) return;
      options.log(
        `renderer recovered attempt=${recovering.attempt} elapsedMs=${Math.round(options.now() - recovering.crashedAtMs)}`,
      );
      // The streak stays: a reloaded window always loads, so ending it here
      // would refill the reload budget on every attempt.
      recovering = null;
    },

    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}

/** The parts of a BrowserWindow crash recovery listens to (structural, so tests pass a fake). */
export interface RendererCrashRecoveryTarget {
  readonly webContents: {
    on(
      event: "render-process-gone",
      listener: (
        event: unknown,
        details: { readonly reason: string; readonly exitCode: number },
      ) => void,
    ): unknown;
    on(
      event: "did-start-navigation",
      listener: (details: {
        readonly isMainFrame: boolean;
        readonly isSameDocument: boolean;
      }) => void,
    ): unknown;
  };
  on(event: "unresponsive" | "responsive" | "closed", listener: () => void): unknown;
}

/**
 * Wire crash recovery to a window, in development and packaged builds alike:
 * a dead renderer reloads, hangs are logged, and closing the window disposes it.
 */
export function attachRendererCrashRecovery(
  target: RendererCrashRecoveryTarget,
  options: RendererCrashRecoveryOptions,
): RendererCrashRecovery {
  const recovery = createRendererCrashRecovery(options);
  let unresponsiveSinceMs: number | null = null;
  target.webContents.on("render-process-gone", (_event, details) =>
    recovery.handleRenderProcessGone(details),
  );
  target.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) recovery.noteNavigationStarted();
  });
  target.on("unresponsive", () => {
    unresponsiveSinceMs = options.now();
    options.log("renderer unresponsive");
  });
  target.on("responsive", () => {
    const hungMs =
      unresponsiveSinceMs === null ? null : Math.round(options.now() - unresponsiveSinceMs);
    unresponsiveSinceMs = null;
    options.log(`renderer responsive${hungMs === null ? "" : ` afterMs=${hungMs}`}`);
  });
  target.on("closed", () => recovery.dispose());
  return recovery;
}
