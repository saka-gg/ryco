import { describe, expect, it } from "vitest";

import {
  appSnapKeyChordFromKeyEvent,
  appSnapKeyChordText,
  appSnapShortcutAccelerator,
  appSnapShortcutAppConflict,
  appSnapShortcutLabels,
  appSnapShortcutSystemConflict,
  isAppSnapShortcut,
  isAppSnapShortcutKey,
} from "./appSnapShortcut.ts";
import {
  compileResolvedKeybindingsConfig,
  NODE_DEFAULT_RESOLVED_KEYBINDINGS,
} from "./keybindings.ts";

describe("AppSnap shortcuts", () => {
  it("accepts DOM key codes, including Enter", () => {
    expect(isAppSnapShortcutKey("KeyS")).toBe(true);
    expect(isAppSnapShortcutKey("Enter")).toBe(true);
    expect(isAppSnapShortcutKey("Return")).toBe(false);
  });

  it("formats the portable chord for Electron and the UI", () => {
    const shortcut = { kind: "key-chord", modifier: "command", key: "KeyK" } as const;
    expect(appSnapShortcutAccelerator(shortcut)).toBe("Command+K");
    expect(appSnapShortcutLabels(shortcut)).toEqual(["⌘ Command", "K"]);
    expect(
      appSnapShortcutAccelerator({ kind: "key-chord", modifier: "option", key: "Enter" }),
    ).toBe("Alt+Return");
  });

  it("rejects unsupported persisted key codes", () => {
    expect(isAppSnapShortcut({ kind: "key-chord", modifier: "option", key: "F13" })).toBe(false);
  });

  it("flags universal command chords macOS would happily hand over", () => {
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "command", key: "KeyC" }),
    ).toBe("⌘ C is Copy in almost every app.");
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "command", key: "Space" }),
    ).toBe("macOS uses ⌘ Space for Spotlight.");
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "option", key: "Enter" }),
    ).toBeNull();
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "command", key: "KeyK" }),
    ).toBeNull();
  });

  it("flags the ⌃ chords macOS keeps for Mission Control, Spaces and input sources", () => {
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "control", key: "ArrowUp" }),
    ).toBe("macOS uses ⌃ ↑ for Mission Control.");
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "control", key: "ArrowDown" }),
    ).toBe("macOS uses ⌃ ↓ to show the app's windows.");
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "control", key: "ArrowLeft" }),
    ).toBe("macOS uses ⌃ ← to move one space left.");
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "control", key: "ArrowRight" }),
    ).toBe("macOS uses ⌃ → to move one space right.");
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "control", key: "Space" }),
    ).toBe("macOS uses ⌃ Space to switch input sources.");
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "control", key: "Enter" }),
    ).toBeNull();
  });

  it("flags chords that would break typing or terminals", () => {
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "shift", key: "KeyS" }),
    ).toMatch(/typing and text selection/);
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "control", key: "KeyC" }),
    ).toBe("⌃ C interrupts the running program in every terminal.");
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "control", key: "KeyK" }),
    ).toBe("⌃ K deletes to the line end in text fields.");
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "control", key: "KeyA" }),
    ).toBe("⌃ A moves to the line start in text fields.");
    // ⌥ with a letter types é, or @ and [ on German layouts; ⌥/⌘ arrows move the caret.
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "option", key: "KeyL" }),
    ).toBe("⌥ L types a character on many keyboard layouts.");
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "option", key: "Digit5" }),
    ).toMatch(/types a character/);
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "option", key: "ArrowLeft" }),
    ).toBe("⌥ ← moves by word or paragraph in text fields.");
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "command", key: "ArrowUp" }),
    ).toMatch(/line or document edge/);
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "control", key: "KeyG" }),
    ).toBeNull();
  });

  it("finds the Ryco command a chord would take over", () => {
    expect(
      appSnapShortcutAppConflict(
        { kind: "key-chord", modifier: "command", key: "KeyK" },
        NODE_DEFAULT_RESOLVED_KEYBINDINGS,
      ),
    ).toBe("commandPalette.toggle");
    expect(
      appSnapShortcutAppConflict(
        { kind: "key-chord", modifier: "command", key: "Digit2" },
        NODE_DEFAULT_RESOLVED_KEYBINDINGS,
      ),
    ).toBe("thread.jump.2");
    expect(
      appSnapShortcutAppConflict(
        { kind: "key-chord", modifier: "command", key: "KeyB" },
        NODE_DEFAULT_RESOLVED_KEYBINDINGS,
      ),
    ).toBeNull();
    // Configured bindings count; bindings with two modifiers never match.
    const configured = compileResolvedKeybindingsConfig([
      { key: "alt+enter", command: "chat.new" },
      { key: "ctrl+shift+g", command: "workspace.review" },
    ]);
    expect(
      appSnapShortcutAppConflict(
        { kind: "key-chord", modifier: "option", key: "Enter" },
        configured,
      ),
    ).toBe("chat.new");
    expect(
      appSnapShortcutAppConflict(
        { kind: "key-chord", modifier: "control", key: "KeyG" },
        configured,
      ),
    ).toBeNull();
    // Keys match as Ryco's keybinding matcher reads the chord's keydown; `mod` is ⌘.
    const keys = compileResolvedKeybindingsConfig([
      { key: "ctrl+space", command: "chat.new" },
      { key: "meta+escape", command: "thread.find" },
      { key: "mod+arrowdown", command: "thread.next" },
      { key: "mod+g", command: "workspace.files" },
    ]);
    const conflict = (modifier: "command" | "control", key: string) =>
      appSnapShortcutAppConflict({ kind: "key-chord", modifier, key }, keys);
    expect(conflict("control", "Space")).toBe("chat.new");
    expect(conflict("command", "Escape")).toBe("thread.find");
    expect(conflict("command", "ArrowDown")).toBe("thread.next");
    expect(conflict("command", "KeyG")).toBe("workspace.files");
    expect(conflict("control", "KeyG")).toBeNull();
    expect(appSnapKeyChordText({ kind: "key-chord", modifier: "command", key: "Space" })).toBe(
      "⌘ Space",
    );
  });

  it("records one modifier plus one supported key", () => {
    const keys = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    expect(appSnapKeyChordFromKeyEvent({ ...keys, code: "AltLeft", altKey: true })).toBeNull();
    expect(appSnapKeyChordFromKeyEvent({ ...keys, code: "KeyY", ctrlKey: true })).toEqual({
      chord: { kind: "key-chord", modifier: "control", key: "KeyY" },
    });
    expect(appSnapKeyChordFromKeyEvent({ ...keys, code: "KeyY" })).toMatchObject({
      error: expect.stringContaining("one modifier"),
    });
    expect(
      appSnapKeyChordFromKeyEvent({ ...keys, code: "KeyY", ctrlKey: true, altKey: true }),
    ).toMatchObject({ error: expect.stringContaining("one modifier") });
    expect(appSnapKeyChordFromKeyEvent({ ...keys, code: "F13", metaKey: true })).toMatchObject({
      error: expect.stringContaining("letter"),
    });
  });
});
