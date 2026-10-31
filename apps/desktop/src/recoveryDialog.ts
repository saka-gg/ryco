/**
 * Button indexes of a recovery dialog: [primary action, "Open Logs", "Quit"], or with an extra
 * action [primary action, "Open Logs", extra action, "Quit"].
 */
export const RECOVERY_DIALOG_PRIMARY_RESPONSE = 0;
export const RECOVERY_DIALOG_OPEN_LOGS_RESPONSE = 1;
export const RECOVERY_DIALOG_EXTRA_RESPONSE = 2;

/**
 * The native dialog the app shows when part of it stopped (the backend could
 * not start, the window's renderer crashed): a primary action, Open Logs, which
 * shows the dialog again, and Quit (any other answer). An optional extra
 * action sits before Quit; it resolves true when it took over (the loop ends)
 * and false to show the dialog again. An answer that arrives once it no longer
 * matters, for example because the app is quitting, does nothing.
 * Electron-free, so the loop is testable.
 */
export async function runRecoveryDialogLoop(options: {
  /** Shows the dialog and resolves with the chosen button. */
  readonly show: () => Promise<{ readonly response: number }>;
  readonly isCancelled: () => boolean;
  readonly openLogs: () => Promise<unknown>;
  readonly primary: () => void;
  readonly extra?: (() => Promise<boolean>) | undefined;
  readonly quit: () => void;
}): Promise<void> {
  for (;;) {
    const { response } = await options.show();
    if (options.isCancelled()) return;
    if (response === RECOVERY_DIALOG_OPEN_LOGS_RESPONSE) {
      await options.openLogs().catch(() => undefined);
      continue;
    }
    if (response === RECOVERY_DIALOG_EXTRA_RESPONSE && options.extra !== undefined) {
      const tookOver = await options.extra().catch(() => false);
      if (tookOver || options.isCancelled()) return;
      continue;
    }
    if (response === RECOVERY_DIALOG_PRIMARY_RESPONSE) {
      options.primary();
      return;
    }
    options.quit();
    return;
  }
}
