import type { TerminalEvent } from "@ryco/contracts";

export function terminalRunningSubprocessFromEvent(event: TerminalEvent): boolean | null {
  switch (event.type) {
    case "activity":
      return event.hasRunningSubprocess;
    case "started":
      // A replayed session may already be running a subprocess; unknown leaves state as is.
      if (event.replay) return event.hasRunningSubprocess ?? null;
      return false;
    case "restarted":
    case "exited":
      return false;
    default:
      return null;
  }
}
