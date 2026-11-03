import { describe, expect, it } from "vitest";

import { matchesKeybindingShortcut, type ShortcutEventLike } from "./keybindingMatch.ts";
import { parseKeybindingShortcut } from "./keybindings.ts";

function matches(
  binding: string,
  overrides: Partial<ShortcutEventLike>,
  { mac = false, editableTarget = false } = {},
): boolean {
  const shortcut = parseKeybindingShortcut(binding);
  if (!shortcut) throw new Error(`Invalid test binding ${binding}`);
  const event: ShortcutEventLike = {
    key: "j",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
  return matchesKeybindingShortcut(event, shortcut, mac, { editableTarget });
}

const ctrlAlt = { ctrlKey: true, altKey: true };
const altGraph = { getModifierState: (key: string) => key === "AltGraph" };

describe("matchesKeybindingShortcut", () => {
  it("matches Ctrl+Alt letters by their physical key outside a text field", () => {
    // Windows reports Ctrl+Alt as AltGr: US-International Ctrl+Alt+P reports "ö", Ctrl+Alt+N
    // "ñ", and Polish (Programmers) Ctrl+Alt+N "ń". Outside a text field they type nothing.
    expect(matches("mod+alt+p", { key: "ö", code: "KeyP", ...ctrlAlt })).toBe(true);
    expect(matches("mod+alt+n", { key: "ñ", code: "KeyN", ...ctrlAlt })).toBe(true);
    expect(matches("mod+alt+n", { key: "ń", code: "KeyN", ...ctrlAlt, ...altGraph })).toBe(true);
    // US-International Ctrl+Alt+[ reports "«" with AltGraph.
    expect(matches("mod+alt+[", { key: "«", code: "BracketLeft", ...ctrlAlt, ...altGraph })).toBe(
      true,
    );
  });

  it("leaves characters typed with AltGr to a text field outside macOS", () => {
    const inTextField = { editableTarget: true };
    // Polish AltGr+A types "ą" with or without "AltGraph".
    expect(matches("mod+alt+a", { key: "ą", code: "KeyA", ...ctrlAlt }, inTextField)).toBe(false);
    expect(
      matches("mod+alt+a", { key: "ą", code: "KeyA", ...ctrlAlt, ...altGraph }, inTextField),
    ).toBe(false);
    expect(matches("mod+alt+n", { key: "ń", code: "KeyN", ...ctrlAlt }, inTextField)).toBe(false);
    // German AltGr+8 types "[".
    expect(
      matches("mod+alt+[", { key: "[", code: "Digit8", ...ctrlAlt, ...altGraph }, inTextField),
    ).toBe(false);
    // Ctrl+Alt chords that type no AltGr character still match.
    expect(matches("mod+alt+a", { key: "a", code: "KeyA", ...ctrlAlt }, inTextField)).toBe(true);
    expect(
      matches("mod+alt+a", { key: "a", code: "KeyA", ...ctrlAlt, ...altGraph }, inTextField),
    ).toBe(true);
    expect(matches("mod+alt+[", { key: "[", code: "BracketLeft", ...ctrlAlt }, inTextField)).toBe(
      true,
    );
    // A layout letter still matches by its physical key: German Ctrl+Alt+Ü is the [ key.
    expect(
      matches("mod+alt+[", { key: "ü", code: "BracketLeft", ...ctrlAlt, ...altGraph }, inTextField),
    ).toBe(true);
    // A non-Latin layout reports its own letter (Russian "ф" on the A key) and matches by the
    // physical key, unless AltGr typed it.
    expect(matches("mod+alt+a", { key: "ф", code: "KeyA", ...ctrlAlt }, inTextField)).toBe(true);
    expect(
      matches("mod+alt+a", { key: "ф", code: "KeyA", ...ctrlAlt, ...altGraph }, inTextField),
    ).toBe(false);
    // German AltGr+M types "µ", which is no layout's own letter.
    expect(matches("mod+alt+m", { key: "µ", code: "KeyM", ...ctrlAlt }, inTextField)).toBe(false);
    expect(matches("mod+alt+m", { key: "m", code: "KeyM", ...ctrlAlt }, inTextField)).toBe(true);
    // macOS has no AltGr: ⌘⌥A still matches through the physical key.
    expect(
      matches(
        "mod+alt+a",
        { key: "å", code: "KeyA", metaKey: true, altKey: true, ...altGraph },
        { mac: true, editableTarget: true },
      ),
    ).toBe(true);
  });
});
