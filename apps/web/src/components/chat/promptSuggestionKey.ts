import type { ComposerCommandKey } from "../ComposerPromptEditor";

/**
 * What a composer key does to an offered prompt suggestion: plain Tab in an empty composer fills
 * it in, Escape dismisses it. Anything else (a typed draft, an open `/` or `@` menu, a modifier,
 * an IME composition) leaves the key to the composer's other handlers, so Shift+Tab still
 * switches modes and Tab still picks a menu item.
 */
export function readPromptSuggestionKey(input: {
  readonly key: ComposerCommandKey;
  readonly event: Pick<
    KeyboardEvent,
    "shiftKey" | "altKey" | "metaKey" | "ctrlKey" | "isComposing" | "keyCode"
  >;
  readonly suggestion: string | null;
  readonly promptEmpty: boolean;
  readonly menuIsActive: boolean;
}): "accept" | "dismiss" | null {
  const { key, event } = input;
  if (input.suggestion === null || !input.promptEmpty || input.menuIsActive) return null;
  // 229: the key event of an IME composition (Safari reports it without isComposing).
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return null;
  if (key === "Tab") return "accept";
  if (key === "Escape") return "dismiss";
  return null;
}
