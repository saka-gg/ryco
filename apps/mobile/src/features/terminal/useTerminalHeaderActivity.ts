import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { selectTerminalEventEntries } from "@ryco/client-runtime/state/terminal";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { useShallow } from "zustand/react/shallow";

import { useTerminalStateStore } from "../../state/terminalStateStore";
import {
  buildTerminalHeaderActivity,
  knownTerminalSessionIds,
  MOBILE_DEFAULT_TERMINAL_ID,
} from "./terminalSessionModel";

/**
 * The thread's terminal sessions this device knows of, as the ⋯ menu's Terminal item says them
 * ("Command running · 2 sessions"). It reads the memory-only terminal store and nothing else;
 * reading it never starts a session. Returns a string, so it only re-renders on a change.
 */
export function useTerminalHeaderActivity(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): string | null {
  const threadRef = scopeThreadRef(environmentId, threadId);
  const threadKey = scopedThreadKey(threadRef);
  const sessions = useTerminalStateStore(
    useShallow((state) => {
      const recorded = state.terminalStateByThreadKey[threadKey] ?? null;
      return {
        terminalIds: knownTerminalSessionIds({
          sessions: recorded,
          defaultTerminalHasEvents:
            selectTerminalEventEntries(
              state.terminalEventEntriesByKey,
              threadRef,
              MOBILE_DEFAULT_TERMINAL_ID,
            ).length > 0,
        }).join("\u0000"),
        runningTerminalIds: (recorded?.runningTerminalIds ?? []).join("\u0000"),
      };
    }),
  );
  return buildTerminalHeaderActivity({
    terminalIds: sessions.terminalIds === "" ? [] : sessions.terminalIds.split("\u0000"),
    runningTerminalIds:
      sessions.runningTerminalIds === "" ? [] : sessions.runningTerminalIds.split("\u0000"),
  }).subtitle;
}
