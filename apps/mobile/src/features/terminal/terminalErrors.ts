export interface SafeTerminalError {
  readonly title: string;
  readonly detail: string;
}

function errorTag(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("_tag" in error)) return null;
  return typeof error._tag === "string" ? error._tag : null;
}

/**
 * Fixed copy for a terminal RPC failure. Contract errors can carry the
 * workspace path, thread and terminal ids or a server defect, so no field of
 * the error itself is ever shown.
 */
export function safeTerminalError(error: unknown): SafeTerminalError {
  switch (errorTag(error)) {
    case "TerminalCwdError":
      return {
        title: "Workspace unavailable",
        detail: "The terminal workspace could not be opened. Refresh the task and try again.",
      };
    case "TerminalHistoryError":
      return {
        title: "Terminal history unavailable",
        detail: "The process may still be running. Reload the terminal view to try again.",
      };
    case "TerminalSessionLookupError":
      return {
        title: "Terminal session unavailable",
        detail: "Refresh the terminal sessions before trying that action again.",
      };
    case "TerminalNotRunningError":
      return {
        title: "Terminal has exited",
        detail: "Restart this terminal to send more input.",
      };
    case "TerminalInputRejectedError":
    case "TerminalBusyError":
      return {
        title: "Input not sent",
        detail: "The machine did not accept this input. Nothing was sent.",
      };
    default:
      return {
        title: "Terminal unavailable",
        detail: "Reload the terminal view and try again.",
      };
  }
}

export const TERMINAL_PASTE_UNAVAILABLE: SafeTerminalError = {
  title: "Paste unavailable",
  detail: "Clipboard text could not be pasted.",
};

export const TERMINAL_COPY_UNAVAILABLE: SafeTerminalError = {
  title: "Copy unavailable",
  detail: "The selected terminal text could not be copied.",
};

export const TERMINAL_PASTE_INTERRUPTED: SafeTerminalError = {
  title: "Paste stopped",
  detail: "The terminal changed before the whole paste was sent.",
};
