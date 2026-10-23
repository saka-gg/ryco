import type { ThreadLifecycleAction } from "@ryco/client-runtime/state/threads";
import type { KeybindingCommand } from "@ryco/contracts";

import type { CurrentThreadLifecycle } from "../../commandPaletteStore";
import { shouldIgnoreSplitViewShortcut, type ShortcutEventLike } from "../../keybindings";

export function threadLifecycleActionForCommand(
  command: KeybindingCommand | null,
): ThreadLifecycleAction | null {
  switch (command) {
    case "thread.settle":
      return "settle";
    case "thread.snooze":
      return "snooze";
    case "thread.archive":
      return "archive";
    case "thread.markUnread":
      return "markUnread";
    default:
      return null;
  }
}

/**
 * Lifecycle chords never edit text, so like split-view chords they also run
 * while typing. Held keys, IME composition, dialogs (the palette included) and
 * open menus keep them, and so does a key a focused control already handled.
 */
export function shouldIgnoreThreadLifecycleShortcut(
  event: ShortcutEventLike & {
    readonly defaultPrevented: boolean;
    readonly repeat: boolean;
    readonly isComposing?: boolean;
    readonly target?: EventTarget | null;
  },
): boolean {
  if (event.defaultPrevented || event.repeat) return true;
  if (shouldIgnoreSplitViewShortcut(event)) return true;
  return typeof document !== "undefined" && document.querySelector('[role="menu"]') !== null;
}

/**
 * Runs a lifecycle shortcut on the open thread. Settle and snooze toggle like
 * the Inbox row's buttons; snooze times are picked in the command palette. An
 * action that cannot run says why. False without an open thread, so the key
 * goes on to the focused control.
 */
export function runThreadLifecycleShortcut(
  action: ThreadLifecycleAction,
  lifecycle: CurrentThreadLifecycle | null,
  ui: { readonly notify: (reason: string) => void; readonly pickSnoozeTime: () => void },
): boolean {
  if (lifecycle === null) return false;
  const reason = lifecycle.disabledReasons[action];
  if (reason !== null) ui.notify(reason);
  else if (action === "settle") lifecycle.setSettled(!lifecycle.settled);
  else if (action === "snooze") {
    if (lifecycle.snoozed) lifecycle.snooze(null);
    else ui.pickSnoozeTime();
  } else if (action === "archive") lifecycle.archive();
  else lifecycle.markUnread();
  return true;
}
