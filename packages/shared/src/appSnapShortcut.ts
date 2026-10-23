// FILE: appSnapShortcut.ts
// Purpose: Normalize AppSnap's portable two-key shortcut model for desktop and web clients.

import type {
  DesktopAppSnapKeyChord,
  DesktopAppSnapShortcut,
  DesktopAppSnapShortcutModifier,
  KeybindingCommand,
  ResolvedKeybindingsConfig,
} from "@ryco/contracts";

import { matchesKeybindingShortcut, type ShortcutEventLike } from "./keybindingMatch.ts";

export const DEFAULT_APP_SNAP_SHORTCUT = {
  kind: "both-option-keys",
} as const satisfies DesktopAppSnapShortcut;

export const APP_SNAP_SHORTCUT_MODIFIERS = [
  "command",
  "control",
  "option",
  "shift",
] as const satisfies ReadonlyArray<DesktopAppSnapShortcutModifier>;

export const APP_SNAP_SHORTCUT_KEYS = [
  ...Array.from({ length: 26 }, (_, index) => `Key${String.fromCharCode(65 + index)}`),
  ...Array.from({ length: 10 }, (_, index) => `Digit${index}`),
  "Space",
  "Enter",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
] as const;

const APP_SNAP_SHORTCUT_KEY_SET = new Set<string>(APP_SNAP_SHORTCUT_KEYS);

const MODIFIER_BY_EVENT_CODE: Readonly<Record<string, DesktopAppSnapShortcutModifier>> = {
  MetaLeft: "command",
  MetaRight: "command",
  ControlLeft: "control",
  ControlRight: "control",
  AltLeft: "option",
  AltRight: "option",
  ShiftLeft: "shift",
  ShiftRight: "shift",
};

const MODIFIER_TEXT: Readonly<
  Record<DesktopAppSnapShortcutModifier, { readonly symbol: string; readonly name: string }>
> = {
  command: { symbol: "⌘", name: "Command" },
  control: { symbol: "⌃", name: "Control" },
  option: { symbol: "⌥", name: "Option" },
  shift: { symbol: "⇧", name: "Shift" },
};

const KEY_LABELS: Readonly<Record<string, string>> = {
  Space: "Space",
  Enter: "Return",
  Tab: "Tab",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

const ELECTRON_KEY_NAMES: Readonly<Record<string, string>> = {
  Space: "Space",
  Enter: "Return",
  Tab: "Tab",
  Escape: "Esc",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

// Chords Electron's globalShortcut probe reports as free even though reserving
// them would hijack typing or a universal action in every foreground app.
const SYSTEM_CONTROL_CHORD_ACTIONS: Readonly<Record<string, string>> = {
  KeyC: "interrupts the running program in every terminal",
  KeyD: "ends input in every terminal",
  KeyL: "clears the screen in every terminal",
  KeyR: "searches the shell history in every terminal",
  KeyU: "deletes the line in every terminal",
  KeyW: "deletes a word in every terminal",
  KeyZ: "suspends the running program in every terminal",
  // macOS text editing, which shells mostly share.
  KeyA: "moves to the line start in text fields",
  KeyB: "moves back a character in text fields",
  KeyE: "moves to the line end in text fields",
  KeyF: "moves forward a character in text fields",
  KeyH: "deletes backward in text fields",
  KeyK: "deletes to the line end in text fields",
  KeyN: "moves down a line in text fields",
  KeyO: "inserts a line break in text fields",
  KeyP: "moves up a line in text fields",
  KeyT: "swaps two characters in text fields",
  KeyV: "scrolls down a page in text fields",
  KeyY: "pastes deleted text in text fields",
};

// On by default in macOS's Keyboard Shortcuts settings, which the globalShortcut
// probe does not see.
const SYSTEM_CONTROL_CHORD_DEFAULTS: Readonly<Record<string, string>> = {
  ArrowUp: "for Mission Control",
  ArrowDown: "to show the app's windows",
  ArrowLeft: "to move one space left",
  ArrowRight: "to move one space right",
  Space: "to switch input sources",
};

const SYSTEM_COMMAND_CHORD_ACTIONS: Readonly<Record<string, string>> = {
  KeyA: "Select All",
  KeyC: "Copy",
  KeyF: "Find",
  KeyH: "Hide",
  KeyM: "Minimize",
  KeyN: "New",
  KeyO: "Open",
  KeyP: "Print",
  KeyQ: "Quit",
  KeyS: "Save",
  KeyT: "New Tab",
  KeyV: "Paste",
  KeyW: "Close Window",
  KeyX: "Cut",
  KeyZ: "Undo",
  Space: "Spotlight",
  Tab: "app switching",
};

const ELECTRON_MODIFIER_NAMES: Readonly<Record<DesktopAppSnapShortcutModifier, string>> = {
  command: "Command",
  control: "Control",
  option: "Alt",
  shift: "Shift",
};

export function isAppSnapShortcutModifier(value: unknown): value is DesktopAppSnapShortcutModifier {
  return APP_SNAP_SHORTCUT_MODIFIERS.includes(value as DesktopAppSnapShortcutModifier);
}

export function isAppSnapShortcutKey(value: unknown): value is string {
  return typeof value === "string" && APP_SNAP_SHORTCUT_KEY_SET.has(value);
}

export function isAppSnapShortcut(value: unknown): value is DesktopAppSnapShortcut {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "both-option-keys") return true;
  return (
    candidate.kind === "key-chord" &&
    isAppSnapShortcutModifier(candidate.modifier) &&
    isAppSnapShortcutKey(candidate.key)
  );
}

export function appSnapModifierFromEventCode(code: string): DesktopAppSnapShortcutModifier | null {
  return MODIFIER_BY_EVENT_CODE[code] ?? null;
}

/**
 * The key chord a keydown names while a shortcut is being recorded: exactly
 * one modifier plus one supported key. Null while only a modifier is down.
 */
export function appSnapKeyChordFromKeyEvent(event: {
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}): { readonly chord: DesktopAppSnapKeyChord } | { readonly error: string } | null {
  if (appSnapModifierFromEventCode(event.code)) return null;
  const modifiers = (
    [
      [event.metaKey, "command"],
      [event.ctrlKey, "control"],
      [event.altKey, "option"],
      [event.shiftKey, "shift"],
    ] as const
  ).flatMap(([held, modifier]) => (held ? [modifier] : []));
  const modifier = modifiers[0];
  if (modifiers.length !== 1 || !modifier) {
    return { error: "Hold one modifier (⌘, ⌃, ⌥ or ⇧) and press one key." };
  }
  if (!isAppSnapShortcutKey(event.code)) {
    return { error: "Use a letter, a digit, Space, Return, Tab, Esc or an arrow key." };
  }
  return { chord: { kind: "key-chord", modifier, key: event.code } };
}

/**
 * Reason a chord must not be reserved globally even though macOS reports it as
 * free, e.g. ⌘C or ⇧S: reserving it would break typing or a universal action
 * in every foreground app.
 */
export function appSnapShortcutSystemConflict(chord: DesktopAppSnapKeyChord): string | null {
  const text = appSnapKeyChordText(chord);
  const arrow = chord.key.startsWith("Arrow");
  if (chord.modifier === "shift") {
    return "⇧ combinations are used for typing and text selection — combine with ⌘, ⌃ or ⌥ instead.";
  }
  if (chord.modifier === "option") {
    // ⌥ with a letter or digit types characters, e.g. é, or @ and [ on German layouts.
    if (/^(?:Key|Digit)/.test(chord.key) || chord.key === "Space") {
      return `${text} types a character on many keyboard layouts.`;
    }
    return arrow ? `${text} moves by word or paragraph in text fields.` : null;
  }
  if (chord.modifier === "control") {
    const systemUse = SYSTEM_CONTROL_CHORD_DEFAULTS[chord.key];
    if (systemUse) return `macOS uses ${text} ${systemUse}.`;
    const action = SYSTEM_CONTROL_CHORD_ACTIONS[chord.key];
    return action ? `${text} ${action}.` : null;
  }
  if (arrow) return `${text} moves to the line or document edge in text fields.`;
  const action = SYSTEM_COMMAND_CHORD_ACTIONS[chord.key];
  if (!action) return null;
  if (chord.key === "Space") return "macOS uses ⌘ Space for Spotlight.";
  if (chord.key === "Tab") return "macOS uses ⌘ Tab to switch apps.";
  return `${text} is ${action} in almost every app.`;
}

/**
 * The keydown a chord sends on a US layout. Letters and Space report their
 * character; the matcher reads digits from the code, and Enter, Tab, Escape
 * and the arrows report their code as the key.
 */
function appSnapKeyChordEvent(chord: DesktopAppSnapKeyChord): ShortcutEventLike {
  const letter = /^Key([A-Z])$/.exec(chord.key)?.[1];
  return {
    type: "keydown",
    code: chord.key,
    key: letter ? letter.toLowerCase() : chord.key === "Space" ? " " : chord.key,
    metaKey: chord.modifier === "command",
    ctrlKey: chord.modifier === "control",
    altKey: chord.modifier === "option",
    shiftKey: chord.modifier === "shift",
  };
}

/**
 * The Ryco command a chord would take over: a global reservation also
 * swallows the chord inside Ryco. Bindings match as Ryco's keybinding matcher
 * matches the chord's keydown on macOS, where `mod` is ⌘ and shortcuts are
 * reserved.
 */
export function appSnapShortcutAppConflict(
  chord: DesktopAppSnapKeyChord,
  bindings: ResolvedKeybindingsConfig,
): KeybindingCommand | null {
  const event = appSnapKeyChordEvent(chord);
  return (
    bindings.find(({ shortcut }) => matchesKeybindingShortcut(event, shortcut, true))?.command ??
    null
  );
}

/** Compact chord text for messages, e.g. "⌘ K". */
export function appSnapKeyChordText(chord: DesktopAppSnapKeyChord): string {
  return `${MODIFIER_TEXT[chord.modifier].symbol} ${appSnapShortcutKeyLabel(chord.key)}`;
}

export function appSnapShortcutLabels(shortcut: DesktopAppSnapShortcut): readonly [string, string] {
  if (shortcut.kind === "both-option-keys") return ["⌥ left", "⌥ right"];
  return [appSnapShortcutModifierLabel(shortcut.modifier), appSnapShortcutKeyLabel(shortcut.key)];
}

export function appSnapShortcutModifierLabel(modifier: DesktopAppSnapShortcutModifier): string {
  const { symbol, name } = MODIFIER_TEXT[modifier];
  return `${symbol} ${name}`;
}

export function appSnapShortcutKeyLabel(code: string): string {
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  return KEY_LABELS[code] ?? code;
}

export function appSnapShortcutAccelerator(shortcut: DesktopAppSnapKeyChord): string {
  const key = shortcut.key.startsWith("Key")
    ? shortcut.key.slice(3)
    : shortcut.key.startsWith("Digit")
      ? shortcut.key.slice(5)
      : (ELECTRON_KEY_NAMES[shortcut.key] ?? shortcut.key);
  return `${ELECTRON_MODIFIER_NAMES[shortcut.modifier]}+${key}`;
}

export function sameAppSnapShortcut(
  left: DesktopAppSnapShortcut,
  right: DesktopAppSnapShortcut,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "both-option-keys" || right.kind === "both-option-keys") return true;
  return left.modifier === right.modifier && left.key === right.key;
}
