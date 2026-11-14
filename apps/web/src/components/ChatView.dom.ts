import {
  hasOpenDialogShortcutTarget,
  isDialogShortcutTarget,
  isEditableShortcutTarget,
} from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";

function elementFromEventTarget(target: EventTarget | null | undefined): Element | null {
  if (typeof Element === "undefined") return null;
  return target instanceof Element ? target : null;
}

function isAllowedThreadSearchEditableTarget(target: EventTarget | null | undefined): boolean {
  return (
    elementFromEventTarget(target)?.closest(
      '[data-chat-composer-form="true"], [data-thread-message-search="true"]',
    ) !== null
  );
}

/** A diff view (the Diff panel) runs its own find while focus is inside it. */
function isDiffFindSurfaceTarget(target: EventTarget | null | undefined): boolean {
  return elementFromEventTarget(target)?.closest("[data-diff-find-surface]") != null;
}

export function shouldIgnoreThreadMessageSearchShortcut(
  event: globalThis.KeyboardEvent & { isComposing?: boolean },
): boolean {
  if (event.type !== "keydown") return true;
  if (event.isComposing) return true;
  if (isTerminalFocused()) return true;
  if (isDiffFindSurfaceTarget(event.target)) return true;
  if (isDialogShortcutTarget(event.target) || hasOpenDialogShortcutTarget()) return true;
  if (
    isEditableShortcutTarget(event.target) &&
    !isAllowedThreadSearchEditableTarget(event.target)
  ) {
    return true;
  }
  return false;
}
