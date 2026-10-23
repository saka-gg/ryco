import type { ScopedThreadRef } from "@ryco/contracts";

import { readEnvironmentApi } from "./environmentApi";
import { readLocalApi } from "./localApi";
import { readTerminalWriteRequireIdleSupported } from "./terminalRequireIdle";
import { terminalSnippetBroker } from "./terminalSnippetInsertion";
import { selectThreadTerminalState, useTerminalStateStore } from "./terminalStateStore";

export const RUNNING_TERMINAL_CLOSE_CONFIRMATION = [
  "Close terminal?",
  "A command is still running in it. Closing the terminal stops the command.",
].join("\n");

async function confirmRunningTerminalClose(): Promise<boolean> {
  try {
    const localApi = readLocalApi();
    return await (localApi
      ? localApi.dialogs.confirm(RUNNING_TERMINAL_CLOSE_CONFIRMATION)
      : window.confirm(RUNNING_TERMINAL_CLOSE_CONFIRMATION));
  } catch {
    return false;
  }
}

/**
 * Closes a terminal the user asked to close: ends its session, then runs `onClosed`, the
 * caller's own state updates. Closing stops whatever the shell runs, so a terminal the thread's
 * terminal state shows running a command asks first. That state is read at the moment of the
 * close: a terminal whose shell exited is closed right after the exit marked it idle.
 */
export function closeThreadTerminal(input: {
  readonly threadRef: ScopedThreadRef;
  readonly terminalId: string;
  readonly isFinalTerminal: boolean;
  readonly onClosed: () => void;
}): void {
  const { threadRef, terminalId } = input;
  if (!readEnvironmentApi(threadRef.environmentId)) return;
  const close = () => {
    // Read again after a confirmation: the connection may have changed meanwhile.
    const api = readEnvironmentApi(threadRef.environmentId);
    if (!api) return;
    void terminalSnippetBroker
      .close(
        { threadRef, terminalId },
        api.terminal,
        input.isFinalTerminal,
        readTerminalWriteRequireIdleSupported(threadRef.environmentId),
      )
      .catch(() => undefined);
    input.onClosed();
  };
  const { runningTerminalIds } = selectThreadTerminalState(
    useTerminalStateStore.getState().terminalStateByThreadKey,
    threadRef,
  );
  if (!runningTerminalIds.includes(terminalId)) {
    close();
    return;
  }
  void confirmRunningTerminalClose().then((confirmed) => {
    if (confirmed) close();
  });
}
