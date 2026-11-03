import { createTerminalEventAdmission } from "@ryco/client-runtime/state/terminal";

import { useComposerDraftStore } from "../state/composerDraftStore";
import { useTerminalStateStore } from "../state/terminalStateStore";
import {
  selectBootstrapCompleteForEnvironment,
  selectEnvironmentState,
  useStore,
} from "../state/threadsRuntime";

/**
 * Mobile's binding of the shared terminal-event admission path, fed by both
 * connection planes. The hosted plane checks its session generation before
 * calling it; a direct connection's events end with its subscription.
 * Terminal output stays in the memory-only terminal store.
 */
export const applyMobileTerminalEvent = createTerminalEventAdmission({
  // The shell entry, stub or full: an archived stub is still a known, archived thread.
  readServerThreadArchivedAt: (threadRef) =>
    selectEnvironmentState(useStore.getState(), threadRef.environmentId).threadShellById[
      threadRef.threadId
    ]?.archivedAt,
  hasDraftThread: (threadRef) =>
    useComposerDraftStore.getState().getDraftThreadByRef(threadRef) !== null,
  applyTerminalEvent: (threadRef, event) =>
    useTerminalStateStore.getState().applyTerminalEvent(threadRef, event),
  // Catch-up for sessions already running can arrive before the shell lists
  // their thread; the snapshot's reconcile (environmentStateSink) drops what
  // it does not list.
  isShellBootstrapped: (environmentId) =>
    selectBootstrapCompleteForEnvironment(useStore.getState(), environmentId),
});
