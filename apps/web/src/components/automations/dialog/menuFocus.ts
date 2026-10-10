import type { FocusEvent } from "react";

const CHECKED_ITEM = '[role="menuitemradio"][aria-checked="true"]';

/**
 * A choice menu opens on what is chosen, like the lab's `menuPop` (its
 * `initialFocus` is the checked item): Base UI's menu opens on its first
 * item, so as focus first enters the popup — from the trigger, by keyboard
 * or pointer — it moves on to the checked radio item, which becomes the
 * highlighted one. Moves inside the popup (arrows, typeahead) are left alone.
 *
 * Pass as the menu popup's `onFocus`.
 */
export function focusCheckedItemOnEntry(event: FocusEvent<HTMLElement>): void {
  const popup = event.currentTarget;
  const from = event.relatedTarget;
  if (from instanceof Node && popup.contains(from)) return;
  const checked = popup.querySelector<HTMLElement>(CHECKED_ITEM);
  if (!checked || checked === event.target) return;
  checked.focus({ preventScroll: true });
  checked.scrollIntoView({ block: "nearest" });
}
