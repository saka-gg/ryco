/**
 * The inbox order hold's logic. The inbox loads it once it mounts, outside the
 * shell's bundle: when the user aims at the list, and what the held list shows.
 */
import { isBareModifierKeyEvent, isEditableShortcutTarget } from "../../keybindings";

export { applyInboxOrderHold, captureInboxOrder } from "./inboxOrderHold";

/**
 * How long a press keeps holding after its release when no click follows it
 * (a drag, a long press, a touch that became a scroll).
 */
const PRESS_RELEASE_FALLBACK_MS = 500;

/**
 * Reports to `onChange` whether the user is aiming at the inbox `element`: a
 * mouse or pen pointer is over it or one of its popups (`claimedTarget`, the
 * last pointerover target React routed through it), or a press that began
 * there has not landed yet. Returns the function that stops tracking.
 *
 * The pointer is tracked from document-level pointermove, so the answer stays
 * right when the node under it unmounts (a row's glyph changing), where
 * enter/leave events never fire. Typing into a field outside the inbox, a
 * press elsewhere, or leaving the window counts as leaving until the pointer
 * moves again, so a pointer resting on the sidebar while the user writes in
 * the composer or taps elsewhere holds nothing. Modifier keys alone don't
 * release, so a Cmd- or Shift-click still lands on the row the user aimed at.
 * Touch has no hover: a tap holds from its press until its click, which
 * arrives after the release, so the click lands on the row it pressed.
 */
export function trackInboxAim(
  element: HTMLElement,
  claimedTarget: { readonly current: EventTarget | null },
  onChange: (aiming: boolean) => void,
): () => void {
  let within = false;
  let pressing = false;
  let held = false;
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  const publish = () => {
    const next = within || pressing;
    if (next === held) return;
    held = next;
    onChange(next);
  };
  const setWithin = (next: boolean) => {
    within = next;
    publish();
  };
  const endPress = () => {
    clearTimeout(pressTimer);
    pressing = false;
    publish();
  };
  const endPressAfter = (delayMs: number) => {
    if (!pressing) return;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(endPress, delayMs);
  };
  const isInside = (target: EventTarget | null) =>
    target !== null &&
    (target === claimedTarget.current || (target instanceof Node && element.contains(target)));

  const handlePointerMove = (event: PointerEvent) => {
    if (event.pointerType !== "touch") setWithin(isInside(event.target));
  };
  const handlePointerOut = (event: PointerEvent) => {
    if (event.pointerType === "touch" || event.relatedTarget !== null) return;
    // Detaching a hovered child also produces a null destination. Hit-test
    // the pointer so that replacement rows cannot release the hold.
    // Boundary changes may release a hold, but only pointer movement arms it.
    if (!isInside(document.elementFromPoint(event.clientX, event.clientY))) setWithin(false);
  };
  const handleViewportLeave = (event: PointerEvent) => {
    if (event.pointerType !== "touch") setWithin(false);
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (isBareModifierKeyEvent(event) || !isEditableShortcutTarget(event.target)) return;
    if (!isInside(event.target)) setWithin(false);
  };
  const handlePointerDown = (event: PointerEvent) => {
    if (!isInside(event.target)) {
      // A mouse got here by moving out, which already released; a tap
      // elsewhere while the mouse rests on the sidebar did not.
      setWithin(false);
      return;
    }
    clearTimeout(pressTimer);
    pressing = true;
    publish();
  };
  // A touch's click arrives in a later task than its release: the press
  // ends once the click was dispatched, so it lands where the user pressed.
  const handleClick = () => endPressAfter(0);
  const handlePointerUp = () => endPressAfter(PRESS_RELEASE_FALLBACK_MS);
  const handleBlur = () => {
    within = false;
    endPress();
  };
  const options = { capture: true, passive: true } as const;
  document.addEventListener("pointermove", handlePointerMove, options);
  document.addEventListener("pointerout", handlePointerOut, options);
  document.addEventListener("pointerdown", handlePointerDown, options);
  document.addEventListener("pointerup", handlePointerUp, options);
  document.addEventListener("pointercancel", handlePointerUp, options);
  document.addEventListener("click", handleClick, options);
  document.addEventListener("keydown", handleKeyDown, options);
  // Root pointerleave is an authoritative viewport exit, unlike null pointerout.
  // Listen without capture: a child disappearing must not count as root exit.
  const root = document.documentElement;
  root.addEventListener("pointerleave", handleViewportLeave, { passive: true });
  window.addEventListener("blur", handleBlur);
  return () => {
    document.removeEventListener("pointermove", handlePointerMove, options);
    document.removeEventListener("pointerout", handlePointerOut, options);
    document.removeEventListener("pointerdown", handlePointerDown, options);
    document.removeEventListener("pointerup", handlePointerUp, options);
    document.removeEventListener("pointercancel", handlePointerUp, options);
    document.removeEventListener("click", handleClick, options);
    document.removeEventListener("keydown", handleKeyDown, options);
    root.removeEventListener("pointerleave", handleViewportLeave);
    window.removeEventListener("blur", handleBlur);
    clearTimeout(pressTimer);
  };
}
