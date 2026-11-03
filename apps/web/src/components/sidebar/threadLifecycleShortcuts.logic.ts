import type { ThreadLifecycleAction } from "@ryco/client-runtime/state/threads";
import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@ryco/contracts";

import type { CurrentThreadLifecycle } from "../../commandPaletteStore";
import {
  hasOpenDialogShortcutTarget,
  isBareModifierKeyEvent,
  isDialogShortcutTarget,
  isEditableShortcutTarget,
  resolveShortcutCommand,
  shouldIgnoreSplitViewShortcut,
  type ShortcutEventLike,
  type ShortcutMatchContext,
} from "../../keybindings";

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
 * It looks for open dialogs and menus in the page, so ask only for a key that
 * resolved to a lifecycle command.
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
 * action that cannot run says why. While one the node has not answered is
 * pending, settle, snooze and archive take the key and do nothing. False
 * without an open thread, so the key goes on to the focused control.
 */
export function runThreadLifecycleShortcut(
  action: ThreadLifecycleAction,
  lifecycle: CurrentThreadLifecycle | null,
  ui: { readonly notify: (reason: string) => void; readonly pickSnoozeTime: () => void },
): boolean {
  if (lifecycle === null) return false;
  if (lifecycle.pending && action !== "markUnread") return true;
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

/**
 * Who takes the Undo shortcut when the thread Undo does not: the composer, a
 * control with its own undo (another text field, a code editor, a dialog, the
 * model picker), or nothing.
 */
export type UndoShortcutOwner = "composer" | "control" | "none";

/**
 * Edits that need no keypress: a paste or cut from a menu, a drop, dictation.
 * The composer cancels clipboard and drop events before any input event, so
 * they count on their own.
 */
export const UNDO_SHORTCUT_EDIT_EVENTS = ["input", "cut", "paste", "drop"] as const;

type UndoShortcutEvent = ShortcutEventLike & {
  readonly code: string;
  readonly repeat: boolean;
  readonly isComposing?: boolean;
  readonly defaultPrevented: boolean;
  readonly target: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
};

/** For the Undo shortcut, who else takes it where it was pressed; null for any other key. */
export function resolveUndoShortcutOwner(
  event: UndoShortcutEvent,
  keybindings: ResolvedKeybindingsConfig,
  context: Partial<ShortcutMatchContext>,
): UndoShortcutOwner | null {
  if (event.isComposing) return null;
  if (resolveShortcutCommand(event, keybindings, { context }) !== "thread.undo") return null;
  if (event.defaultPrevented || context.modelPickerOpen) return "control";
  if (isDialogShortcutTarget(event.target) || hasOpenDialogShortcutTarget()) return "control";
  if (!isEditableShortcutTarget(event.target)) return "none";
  const composer = (event.target as Element).closest('[data-testid="composer-editor"]');
  return composer === null ? "control" : "composer";
}

/**
 * The Undo shortcut undoes the newest Undo notice. A new notice also claims the
 * key in the composer until the user presses another key or edits text; then
 * it is the composer's own undo again. Notice ids only grow, so the claim is
 * the newest id seen when it was last released. A held key undoes once: its
 * repeats are swallowed, so they cannot fall through to the composer's undo.
 */
export function createThreadUndoShortcut(deps: {
  /** The newest notice whose Undo can still run. */
  readonly latestNoticeId: () => number | null;
  readonly undo: (noticeId: number) => void;
  readonly owner: (event: UndoShortcutEvent) => UndoShortcutOwner | null;
}) {
  let releasedThroughId = 0;
  let heldCode: string | null = null;
  const release = () => {
    releasedThroughId = Math.max(releasedThroughId, deps.latestNoticeId() ?? 0);
  };
  return {
    keydown(event: UndoShortcutEvent) {
      if (event.repeat) {
        if (event.code !== heldCode) return;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // A modifier pressed mid-hold leaves the held key repeating.
      if (isBareModifierKeyEvent(event)) return;
      heldCode = null;
      // Without a notice there is nothing to undo and no claim to release, so
      // most keystrokes stop here without reading who owns the key.
      const noticeId = deps.latestNoticeId();
      if (noticeId === null) return;
      const owner = deps.owner(event);
      if (owner === null) {
        releasedThroughId = Math.max(releasedThroughId, noticeId);
        return;
      }
      if (owner === "control" || (owner === "composer" && noticeId <= releasedThroughId)) return;
      heldCode = event.code;
      event.preventDefault();
      event.stopPropagation();
      deps.undo(noticeId);
    },
    edit: release,
  };
}
