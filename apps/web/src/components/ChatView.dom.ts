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

/** Chat column custom properties carrying the floating bars' heights. */
export const COMPOSER_CLEARANCE_PROPERTY = "--chat-composer-clearance";
export const HEADER_CLEARANCE_PROPERTY = "--chat-header-clearance";

/**
 * Publishes `bar`'s rendered height plus a small gap on `host` as a CSS
 * variable. The size comes from the observer's notifications, which run once
 * layout is clean and before the first paint: reading the height here
 * directly would force a layout of the freshly committed tree on every
 * switch. Returns the cleanup that drops the variable.
 */
export function publishOverlayClearance(
  host: HTMLElement,
  bar: HTMLElement,
  property: string,
): () => void {
  const apply = () => host.style.setProperty(property, `${bar.offsetHeight + 8}px`);
  const observer = new ResizeObserver(apply);
  observer.observe(bar);
  return () => {
    observer.disconnect();
    host.style.removeProperty(property);
  };
}
