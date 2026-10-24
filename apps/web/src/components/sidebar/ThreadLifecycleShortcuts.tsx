import { useEffect, useLayoutEffect, useRef } from "react";

import {
  dispatchThreadSettlement,
  dispatchThreadSnooze,
  requestThreadArchive,
} from "../../threadLifecycleCommands";
import type {
  ThreadLifecycleCommands,
  ThreadLifecycleShortcutsProps,
} from "./threadLifecycleShortcutsController";

const COMMANDS: ThreadLifecycleCommands = {
  dispatchThreadSettlement,
  dispatchThreadSnooze,
  requestThreadArchive,
};

/**
 * Settle, snooze, archive and mark unread for the open thread: their keyboard
 * shortcuts, and what the command palette offers. Also the Undo shortcut for
 * the newest Undo notice. Only the sidebar has the inbox's inputs, so it
 * renders this once. It subscribes to nothing and decides nothing until a
 * shortcut or the palette asks. The listeners load after the sidebar mounts,
 * off the shell's critical path.
 */
export function ThreadLifecycleShortcuts(props: ThreadLifecycleShortcutsProps) {
  // Read at call time, so the reader and the listeners stay registered for the mount.
  const latestProps = useRef(props);
  useLayoutEffect(() => {
    latestProps.current = props;
  });
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    void import("./threadLifecycleShortcutsController")
      .then(({ startThreadLifecycleShortcuts }) => {
        if (!disposed) stop = startThreadLifecycleShortcuts(() => latestProps.current, COMMANDS);
      })
      .catch((error: unknown) => console.warn("Thread lifecycle shortcuts failed to load.", error));
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  return null;
}
