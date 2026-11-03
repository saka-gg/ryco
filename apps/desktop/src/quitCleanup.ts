export interface QuitCleanupHandler {
  (event: { preventDefault: () => void }): void;
  /** Whether a confirmation holds a quit right now. */
  readonly confirming: () => boolean;
}

/**
 * Keep Electron alive until its owned backend has exited or been force-stopped, after asking
 * (`confirm`) whether to quit at all.
 */
export function createQuitCleanupHandler(options: {
  readonly cleanup: () => Promise<void> | undefined;
  readonly quit: () => void;
  /**
   * Asked once per quit attempt, before cleanup. `null`: nothing to ask, clean up now. A
   * promise holds the quit: `true` quits (the next before-quit cleans up), `false` keeps the
   * app running. A rejection or a throw quits: a person asked to quit, so a failed
   * confirmation must not trap them.
   */
  readonly confirm?: (signal: AbortSignal) => Promise<boolean> | null;
  /**
   * A quit no one may hold (update install, signals, system shutdown): never asks, and aborts
   * an open confirmation.
   */
  readonly mustQuitNow?: () => boolean;
  /** A repeated quit while a confirmation is open; it is absorbed, not a second dialog. */
  readonly onAbsorbed?: () => void;
  /** A confirmation that threw or rejected; the quit goes ahead. */
  readonly onConfirmError?: (error: unknown) => void;
}): QuitCleanupHandler {
  let started = false;
  let complete = false;
  let confirmed = false;
  let asking: AbortController | null = null;

  const reportConfirmError = (error: unknown) => {
    try {
      options.onConfirmError?.(error);
    } catch {
      // Reporting must never decide whether the app quits.
    }
  };

  /** Asks when it can; `true` when the quit is now held by an open confirmation. */
  const holdForConfirmation = (event: { preventDefault: () => void }): boolean => {
    if (options.confirm === undefined || confirmed) return false;
    const urgent = options.mustQuitNow?.() === true;
    if (asking !== null) {
      if (urgent) {
        // The late answer is ignored: `asking` no longer names its controller.
        asking.abort();
        asking = null;
        return false;
      }
      event.preventDefault();
      options.onAbsorbed?.();
      return true;
    }
    if (urgent) return false;
    const controller = new AbortController();
    let pending: Promise<boolean> | null;
    try {
      pending = options.confirm(controller.signal);
    } catch (error) {
      reportConfirmError(error);
      pending = null;
    }
    if (pending === null) return false;
    event.preventDefault();
    asking = controller;
    void pending
      .catch((error: unknown) => {
        reportConfirmError(error);
        return true;
      })
      .then((allow) => {
        if (asking !== controller) return;
        asking = null;
        if (!allow) return;
        confirmed = true;
        options.quit();
      });
    return true;
  };

  const handler = (event: { preventDefault: () => void }) => {
    if (complete) return;
    if (started) {
      event.preventDefault();
      return;
    }
    if (holdForConfirmation(event)) return;
    started = true;
    const pending = options.cleanup();
    if (pending === undefined) {
      complete = true;
      return;
    }
    event.preventDefault();
    void pending
      .catch(() => undefined)
      .then(() => {
        complete = true;
        options.quit();
      });
  };
  return Object.assign(handler, { confirming: () => asking !== null });
}
