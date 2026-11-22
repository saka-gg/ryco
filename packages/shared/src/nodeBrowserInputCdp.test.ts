import { describe, expect, it } from "vite-plus/test";

import { NodeBrowserInputEvent } from "@ryco/contracts/node-browser";
import * as Schema from "effect/Schema";

import { isAppLevelChord, isDroppedHandoffInput } from "./nodeBrowserInputCdp.ts";

const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;
const chord = (key: string, modifiers: number, code = "") => ({ key, code, modifiers });

describe("app-level chords in hand-off input", () => {
  it("drops close, quit, reload, new window or tab, find, settings, zoom, history and switching", () => {
    for (const command of [CTRL, META]) {
      for (const key of ["w", "W", "q", "r", "n", "t", "l", "f", "g", ",", "=", "+", "-", "0"]) {
        expect(isAppLevelChord(chord(key, command)), `${command}+${key}`).toBe(true);
      }
      for (const key of ["[", "]", "Tab", "`", "h", "m", "F4"]) {
        expect(isAppLevelChord(chord(key, command)), `${command}+${key}`).toBe(true);
      }
      // Reopen a closed tab, a hard reload, new incognito window: Shift does not let them through.
      for (const key of ["T", "R", "N"]) {
        expect(isAppLevelChord(chord(key, command | SHIFT))).toBe(true);
      }
    }
  });

  it("drops the devtools chords and the keys that act on their own", () => {
    for (const key of ["i", "I", "j", "J", "c", "C"]) {
      expect(isAppLevelChord(chord(key, CTRL | SHIFT)), `ctrl+shift+${key}`).toBe(true);
      expect(isAppLevelChord(chord(key, META | ALT)), `meta+alt+${key}`).toBe(true);
    }
    for (const key of ["F3", "F5", "F6", "F11", "F12", "BrowserBack", "BrowserRefresh"]) {
      expect(isAppLevelChord(chord(key, 0)), key).toBe(true);
    }
    expect(isAppLevelChord(chord("F4", ALT))).toBe(true);
    expect(isAppLevelChord(chord("ArrowLeft", ALT))).toBe(true);
    expect(isAppLevelChord(chord("ArrowRight", ALT))).toBe(true);
  });

  it("goes by the physical key for a non-Latin layout's letters", () => {
    // Ctrl+W on a Russian layout: key "ц", code KeyW.
    expect(isAppLevelChord(chord("ц", CTRL, "KeyW"))).toBe(true);
    expect(isAppLevelChord(chord("с", CTRL, "KeyC"))).toBe(false);
    // A Latin layout keeps its own letter (German Z sits on KeyY).
    expect(isAppLevelChord(chord("z", META, "KeyY"))).toBe(false);
  });

  it("keeps typing, editing shortcuts, formatting and navigation within the page", () => {
    for (const command of [CTRL, META]) {
      for (const key of ["c", "x", "a", "z", "y", "b", "i", "u", "Backspace", "ArrowLeft"]) {
        expect(isAppLevelChord(chord(key, command)), `${command}+${key}`).toBe(false);
      }
      expect(isAppLevelChord(chord("z", command | SHIFT))).toBe(false);
    }
    for (const key of ["a", "W", "Q", "1", " ", "Enter", "Tab", "Escape", "ArrowUp", "@"]) {
      expect(isAppLevelChord(chord(key, 0)), key).toBe(false);
      expect(isAppLevelChord(chord(key, SHIFT)), `shift+${key}`).toBe(false);
    }
    // AltGr characters on Windows arrive as Ctrl+Alt with the character.
    expect(isAppLevelChord(chord("@", CTRL | ALT, "KeyQ"))).toBe(false);
    expect(isAppLevelChord(chord("€", CTRL | ALT, "KeyE"))).toBe(false);
  });

  it("drops pasting by key: the desktop's clipboard, where the viewer's paste comes as text", () => {
    for (const command of [CTRL, META]) {
      expect(isAppLevelChord(chord("v", command)), `${command}+v`).toBe(true);
      // The app menu's Paste as Text.
      expect(isAppLevelChord(chord("V", command | SHIFT)), `${command}+shift+v`).toBe(true);
    }
    expect(isAppLevelChord(chord("Insert", SHIFT, "Insert"))).toBe(true);
    expect(isAppLevelChord(chord("м", CTRL, "KeyV"))).toBe(true);
    // The viewer's own paste is text, and passes.
    expect(isDroppedHandoffInput({ type: "text", text: "pasted" })).toBe(false);
  });

  it("drops middle clicks, and back and forward buttons cannot arrive at all", () => {
    const mouse = (action: "down" | "up" | "move", button: "left" | "middle" | "right" | "none") =>
      ({
        type: "mouse",
        action,
        x: 1,
        y: 1,
        button,
        buttons: 0,
        clickCount: 1,
        modifiers: 0,
      }) as const;
    expect(isDroppedHandoffInput(mouse("down", "middle"))).toBe(true);
    expect(isDroppedHandoffInput(mouse("up", "middle"))).toBe(true);
    for (const button of ["left", "right", "none"] as const) {
      expect(isDroppedHandoffInput(mouse("down", button))).toBe(false);
    }
    expect(isDroppedHandoffInput(mouse("move", "none"))).toBe(false);
    const decode = Schema.decodeUnknownExit(NodeBrowserInputEvent);
    for (const event of [
      { ...mouse("down", "left"), button: "back" },
      { ...mouse("down", "left"), button: "forward" },
      { ...mouse("move", "none"), buttons: 8 },
      { ...mouse("move", "none"), buttons: 16 },
    ]) {
      expect(decode(event)._tag, JSON.stringify(event)).toBe("Failure");
    }
    expect(decode(mouse("down", "left"))._tag).toBe("Success");
  });
});
