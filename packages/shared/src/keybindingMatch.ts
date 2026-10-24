// FILE: keybindingMatch.ts
// Purpose: Match a keydown against a keybinding shortcut, for the web app's
// keybindings and checks that ask which binding a key chord would trigger.

import type { KeybindingShortcut } from "@ryco/contracts";

/** The modifier state of a keydown, as a DOM `KeyboardEvent` reports it. */
export interface ShortcutModifierStateLike {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** The fields of a keydown the keybinding matcher reads; no DOM types. */
export interface ShortcutEventLike extends ShortcutModifierStateLike {
  type?: string;
  code?: string;
  key: string;
  getModifierState?(key: string): boolean;
}

const EVENT_CODE_KEY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  BracketLeft: ["["],
  BracketRight: ["]"],
  Backslash: ["\\"],
  Digit0: ["0"],
  Digit1: ["1"],
  Digit2: ["2"],
  Digit3: ["3"],
  Digit4: ["4"],
  Digit5: ["5"],
  Digit6: ["6"],
  Digit7: ["7"],
  Digit8: ["8"],
  Digit9: ["9"],
};

const LETTER_EVENT_CODE = /^Key([A-Z])$/;
const PLAIN_LETTER_KEY = /^[a-z]$/i;
// A letter of a non-Latin layout (Russian Ctrl+Alt+P reports "з"), never one AltGr types on a
// Latin layout (Polish "ą") or a shared symbol letter (German AltGr+M types "µ").
const NON_LATIN_LETTER_KEY = /^(?![\p{Script=Latin}\p{Script=Common}])\p{L}$/u;
const LETTER_OR_DIGIT_KEY = /^(?:\p{L}|[0-9])$/u;

export function normalizeShortcutEventKey(key: string): string {
  const normalized = key.toLowerCase();
  if (normalized === "esc") return "escape";
  return normalized;
}

/**
 * macOS Option rewrites the produced character: Option+N is the "Dead" tilde
 * key and Option+P yields "π", so `event.key` never names the letter of an
 * `alt+<letter>` binding. Fall back to the physical key only while Alt is held
 * and the layout did not already produce a plain letter, so every layout that
 * does report letters (Windows/Linux Ctrl+Alt, non-QWERTY) keeps its own key.
 * Windows reports AltGr as Ctrl+Alt, and in a text field AltGr types letters
 * such as Polish "ą" on the A key, so there (`altGraphTypes`) with Ctrl held
 * the fallback applies only to the letters of a non-Latin layout, and never
 * while AltGr is reported.
 */
function resolveAltTransformedLetter(
  event: ShortcutEventLike,
  altGraphTypes: boolean,
): string | null {
  if (!event.altKey || !event.code || PLAIN_LETTER_KEY.test(event.key)) return null;
  if (
    altGraphTypes &&
    event.ctrlKey &&
    (event.getModifierState?.("AltGraph") === true || !NON_LATIN_LETTER_KEY.test(event.key))
  ) {
    return null;
  }
  const match = LETTER_EVENT_CODE.exec(event.code);
  return match?.[1] ? match[1].toLowerCase() : null;
}

/**
 * In a text field, a symbol typed with AltGr (German AltGr+8 is "[") is text,
 * not a shortcut, wherever the browser reports AltGr. A letter or digit still
 * matches by its physical key (German Ctrl+Alt+Ü is the [ key).
 */
function isAltGraphCharacter(event: ShortcutEventLike): boolean {
  return (
    event.getModifierState?.("AltGraph") === true &&
    event.key.length === 1 &&
    !LETTER_OR_DIGIT_KEY.test(event.key)
  );
}

function resolveShortcutEventKeys(event: ShortcutEventLike, altGraphTypes: boolean): Set<string> {
  const keys = new Set([normalizeShortcutEventKey(event.key)]);
  const altLetter = resolveAltTransformedLetter(event, altGraphTypes);
  if (altLetter) keys.add(altLetter);
  const aliases = event.code ? EVENT_CODE_KEY_ALIASES[event.code] : undefined;
  if (!aliases) return keys;

  for (const alias of aliases) {
    keys.add(alias);
  }
  return keys;
}

/** Exactly the shortcut's modifiers are held; `mod` is ⌘ where `useMetaForMod` (macOS), else Ctrl. */
export function matchesKeybindingModifiers(
  event: ShortcutModifierStateLike,
  shortcut: KeybindingShortcut,
  useMetaForMod: boolean,
): boolean {
  const expectedMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const expectedCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  return (
    event.metaKey === expectedMeta &&
    event.ctrlKey === expectedCtrl &&
    event.shiftKey === shortcut.shiftKey &&
    event.altKey === shortcut.altKey
  );
}

export interface KeybindingMatchOptions {
  /**
   * The keydown reached a control that takes text, where AltGr types
   * characters. Elsewhere it types nothing, so Ctrl+Alt+letter matches by its
   * physical key on every layout (US-International Ctrl+Alt+P reports "ö").
   */
  readonly editableTarget?: boolean;
}

export function matchesKeybindingShortcut(
  event: ShortcutEventLike,
  shortcut: KeybindingShortcut,
  useMetaForMod: boolean,
  options?: KeybindingMatchOptions,
): boolean {
  if (!matchesKeybindingModifiers(event, shortcut, useMetaForMod)) return false;
  // macOS has no AltGr; Option belongs to ⌘⌥ chords there.
  const altGraphTypes = !useMetaForMod && options?.editableTarget === true;
  if (altGraphTypes && isAltGraphCharacter(event)) return false;
  return resolveShortcutEventKeys(event, altGraphTypes).has(shortcut.key);
}
