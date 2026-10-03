import { describe, expect, it } from "vitest";

import { isPageShortcutKeystroke, shortcutToken } from "./pullRequestsShortcuts";

function keystroke(
  key: string,
  modifiers: { meta?: boolean; ctrl?: boolean; alt?: boolean; altGraph?: boolean } = {},
) {
  return {
    key,
    metaKey: modifiers.meta ?? false,
    ctrlKey: modifiers.ctrl ?? false,
    altKey: modifiers.alt ?? false,
    getModifierState: (name: string) => name === "AltGraph" && (modifiers.altGraph ?? false),
  };
}

describe("isPageShortcutKeystroke", () => {
  it("accepts plain keys and rejects ⌘ and Ctrl chords", () => {
    expect(isPageShortcutKeystroke(keystroke("j"))).toBe(true);
    expect(isPageShortcutKeystroke(keystroke("["))).toBe(true);
    expect(isPageShortcutKeystroke(keystroke("[", { meta: true }))).toBe(false);
    expect(isPageShortcutKeystroke(keystroke("j", { ctrl: true }))).toBe(false);
    expect(isPageShortcutKeystroke(keystroke("[", { ctrl: true }))).toBe(false);
  });

  it("accepts symbols typed with Option on macOS layouts (German [ ] \\)", () => {
    expect(isPageShortcutKeystroke(keystroke("[", { alt: true }))).toBe(true);
    expect(isPageShortcutKeystroke(keystroke("]", { alt: true }))).toBe(true);
    expect(isPageShortcutKeystroke(keystroke("\\", { alt: true }))).toBe(true);
    // Option + a letter or digit is a chord, not a layout symbol.
    expect(isPageShortcutKeystroke(keystroke("j", { alt: true }))).toBe(false);
    expect(isPageShortcutKeystroke(keystroke("5", { alt: true }))).toBe(false);
    expect(isPageShortcutKeystroke(keystroke("ArrowLeft", { alt: true }))).toBe(false);
  });

  it("accepts symbols typed with AltGr on Windows (reported as Ctrl+Alt)", () => {
    expect(isPageShortcutKeystroke(keystroke("[", { ctrl: true, alt: true, altGraph: true }))).toBe(
      true,
    );
    expect(isPageShortcutKeystroke(keystroke("\\", { ctrl: true, alt: true }))).toBe(true);
    expect(isPageShortcutKeystroke(keystroke("k", { ctrl: true, alt: true }))).toBe(false);
  });
});

describe("shortcutToken", () => {
  it("prefixes Shift only for letters", () => {
    expect(shortcutToken({ key: "J", shiftKey: true })).toBe("shift+j");
    expect(shortcutToken({ key: "\\", shiftKey: true })).toBe("\\");
    expect(shortcutToken({ key: "?", shiftKey: true })).toBe("?");
  });
});
