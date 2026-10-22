import { isPasteAsTextShortcut } from "@ryco/client-runtime/state/composer";
import type { DesktopBridge } from "@ryco/contracts";

import { isMacPlatform } from "./utils";

/** Dispatched on the window just before the desktop app pastes as text, for editors to prepare. */
export const PASTE_AS_TEXT_EVENT = "ryco:paste-as-text";

/** The desktop Edit menu's Paste as Text. */
const PASTE_AS_TEXT_MENU_ACTION = "paste-as-text";

// A chord's own paste lands within its keypress; its menu action follows at once.
const CHORD_PASTE_WINDOW_MS = 1_000;

/**
 * Carries out the desktop Edit menu's Paste as Text: announces it with `PASTE_AS_TEXT_EVENT`,
 * then asks the desktop app to paste, so the paste always follows the announcement. When the
 * item ran from its shortcut and Chromium already pasted for the keypress, that paste stands and
 * nothing more is pasted.
 */
export function installDesktopPasteAsText(
  bridge: Pick<DesktopBridge, "onMenuAction" | "pasteAsText"> | undefined,
  target: Window,
): () => void {
  const pasteAsText = bridge?.pasteAsText;
  if (!bridge || !pasteAsText) return () => {};
  let chordAt: number | null = null;
  let chordPasted = false;
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isPasteAsTextShortcut(event, isMacPlatform(target.navigator.platform))) return;
    chordAt = event.timeStamp;
    chordPasted = false;
  };
  const onPaste = () => {
    if (chordAt !== null) chordPasted = true;
  };
  target.addEventListener("keydown", onKeyDown, true);
  target.addEventListener("paste", onPaste, true);
  const unsubscribe = bridge.onMenuAction((action) => {
    if (action !== PASTE_AS_TEXT_MENU_ACTION) return;
    const pastedByChord =
      chordPasted && chordAt !== null && target.performance.now() - chordAt < CHORD_PASTE_WINDOW_MS;
    chordAt = null;
    chordPasted = false;
    if (pastedByChord) return;
    target.dispatchEvent(new Event(PASTE_AS_TEXT_EVENT));
    void pasteAsText().catch(() => undefined);
  });
  return () => {
    unsubscribe();
    target.removeEventListener("keydown", onKeyDown, true);
    target.removeEventListener("paste", onPaste, true);
  };
}
