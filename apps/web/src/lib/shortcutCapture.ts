import type { KeybindingShortcut } from "@ryco/contracts";

// Local copy to keep this pure-logic module free of the heavy `./utils`
// import chain (utils transitively pulls in zustand stores). Mirrors
// `isMacPlatform` in `./utils`.
function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export interface ShortcutCaptureEvent {
  readonly key: string;
  readonly code?: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

const MODIFIER_KEYS = new Set([
  "control",
  "shift",
  "alt",
  "altgraph",
  "meta",
  "os",
  "hyper",
  "super",
  "fn",
  "capslock",
  "numlock",
  "scrolllock",
]);

const IGNORED_BARE_KEYS = new Set(["escape", "tab", "enter"]);

function normalizeKeyName(rawKey: string, code: string | undefined): string {
  const lowered = rawKey.toLowerCase();
  if (lowered === " " || lowered === "spacebar") return "space";
  if (lowered === "esc") return "escape";
  if (lowered === "arrowup") return "up";
  if (lowered === "arrowdown") return "down";
  if (lowered === "arrowleft") return "left";
  if (lowered === "arrowright") return "right";
  // Use Digit0..9 codes so shifted symbols still record the underlying number,
  // matching the EVENT_CODE_KEY_ALIASES table of the runtime matcher
  // (`@ryco/shared/keybindingMatch`).
  if (code) {
    const digitMatch = code.match(/^Digit(\d)$/);
    if (digitMatch) return digitMatch[1]!;
    if (code === "BracketLeft") return "[";
    if (code === "BracketRight") return "]";
  }
  return lowered;
}

export interface ShortcutCaptureOptions {
  readonly platform?: string;
}

/**
 * Convert a captured keyboard event into a {@link KeybindingShortcut}.
 *
 * Returns `null` for events that should NOT commit a binding:
 *  - modifier-only key presses (just Shift, Cmd, etc.)
 *  - plain Tab / Escape / Enter (no modifiers held) — these are reserved as
 *    capture-loop escape hatches by callers.
 *
 * The platform's primary modifier (`metaKey` on macOS, `ctrlKey` on
 * Linux/Windows) collapses into `modKey: true` so bindings stay cross-platform.
 * Non-primary modifiers are recorded verbatim.
 */
export function eventToShortcut(
  event: ShortcutCaptureEvent,
  options?: ShortcutCaptureOptions,
): KeybindingShortcut | null {
  const loweredKey = event.key.toLowerCase();
  if (MODIFIER_KEYS.has(loweredKey)) return null;

  const platform =
    options?.platform ?? (typeof navigator !== "undefined" ? navigator.platform : "");
  const isMac = isMacPlatform(platform);

  const primaryHeld = isMac ? event.metaKey : event.ctrlKey;

  const hasAnyModifier =
    primaryHeld || event.shiftKey || event.altKey || (isMac ? event.ctrlKey : event.metaKey);

  if (!hasAnyModifier && IGNORED_BARE_KEYS.has(loweredKey)) return null;

  const key = normalizeKeyName(event.key, event.code);
  if (key.length === 0) return null;

  return {
    key,
    modKey: primaryHeld,
    metaKey: !isMac && event.metaKey,
    ctrlKey: isMac && event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
  };
}

const MAC_SYMBOLS: Readonly<Record<string, string>> = {
  mod: "⌘",
  meta: "⌘",
  cmd: "⌘",
  ctrl: "⌃",
  control: "⌃",
  shift: "⇧",
  alt: "⌥",
  option: "⌥",
};

const PLAIN_SYMBOLS: Readonly<Record<string, string>> = {
  mod: "Ctrl",
  meta: "Meta",
  cmd: "Meta",
  ctrl: "Ctrl",
  control: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  option: "Alt",
};

const KEY_DISPLAY: Readonly<Record<string, string>> = {
  space: "Space",
  enter: "Enter",
  escape: "Esc",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  tab: "Tab",
  backspace: "⌫",
  delete: "Del",
};

/** Format a shortcut into ordered display tokens (e.g. ["⌘", "⇧", "K"]). */
export function formatShortcutTokens(
  shortcut: KeybindingShortcut,
  options?: ShortcutCaptureOptions,
): string[] {
  const platform =
    options?.platform ?? (typeof navigator !== "undefined" ? navigator.platform : "");
  const isMac = isMacPlatform(platform);
  const symbols = isMac ? MAC_SYMBOLS : PLAIN_SYMBOLS;
  const tokens: string[] = [];
  if (shortcut.modKey) tokens.push(symbols.mod!);
  if (shortcut.metaKey) tokens.push(symbols.meta!);
  if (shortcut.ctrlKey) tokens.push(symbols.ctrl!);
  if (shortcut.altKey) tokens.push(symbols.alt!);
  if (shortcut.shiftKey) tokens.push(symbols.shift!);
  const displayKey =
    KEY_DISPLAY[shortcut.key] ??
    (shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key);
  tokens.push(displayKey);
  return tokens;
}

/** Serialize a shortcut back to the canonical `mod+shift+k` form. */
export function serializeShortcut(shortcut: KeybindingShortcut): string {
  const parts: string[] = [];
  if (shortcut.modKey) parts.push("mod");
  if (shortcut.metaKey) parts.push("meta");
  if (shortcut.ctrlKey) parts.push("ctrl");
  if (shortcut.altKey) parts.push("alt");
  if (shortcut.shiftKey) parts.push("shift");
  const key = shortcut.key === " " ? "space" : shortcut.key;
  parts.push(key);
  return parts.join("+");
}
