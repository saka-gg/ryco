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
const PLAIN_LETTER_OR_DIGIT_KEY = /^[a-z0-9]$/i;

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
 * Windows reports AltGr as Ctrl+Alt, and AltGr types letters such as Polish
 * "ą" on the A key, so outside macOS the fallback never applies with Ctrl held.
 */
function resolveAltTransformedLetter(
  event: ShortcutEventLike,
  useMetaForMod: boolean,
): string | null {
  if (!event.altKey || !event.code || PLAIN_LETTER_KEY.test(event.key)) return null;
  if (event.ctrlKey && !useMetaForMod) return null;
  const match = LETTER_EVENT_CODE.exec(event.code);
  return match?.[1] ? match[1].toLowerCase() : null;
}

/**
 * A character typed with AltGr (German AltGr+8 is "[") is text, not a
 * shortcut, wherever the browser reports AltGr. macOS has no AltGr; Option
 * belongs to ⌘⌥ chords there.
 */
function isAltGraphCharacter(event: ShortcutEventLike, useMetaForMod: boolean): boolean {
  return (
    !useMetaForMod &&
    event.getModifierState?.("AltGraph") === true &&
    event.key.length === 1 &&
    !PLAIN_LETTER_OR_DIGIT_KEY.test(event.key)
  );
}

function resolveShortcutEventKeys(event: ShortcutEventLike, useMetaForMod: boolean): Set<string> {
  const keys = new Set([normalizeShortcutEventKey(event.key)]);
  const altLetter = resolveAltTransformedLetter(event, useMetaForMod);
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

export function matchesKeybindingShortcut(
  event: ShortcutEventLike,
  shortcut: KeybindingShortcut,
  useMetaForMod: boolean,
): boolean {
  if (!matchesKeybindingModifiers(event, shortcut, useMetaForMod)) return false;
  if (isAltGraphCharacter(event, useMetaForMod)) return false;
  return resolveShortcutEventKeys(event, useMetaForMod).has(shortcut.key);
}
