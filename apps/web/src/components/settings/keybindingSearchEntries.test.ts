import {
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
  STATIC_KEYBINDING_COMMANDS,
  THREAD_JUMP_KEYBINDING_COMMANDS,
  type StaticKeybindingCommand,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getCommandMeta, keybindingRowId } from "../../lib/keybindingCategories";
import { KEYBINDING_SEARCH_ENTRIES } from "./keybindingSearchEntries";
import { SETTINGS_SEARCH_INDEX } from "./settingsSearchIndex";

/** Titles of the results the settings search lists for `query`, by its own match. */
function search(query: string): ReadonlyArray<string> {
  return KEYBINDING_SEARCH_ENTRIES.filter((entry) =>
    `${entry.title} ${entry.description} ${entry.keywords ?? ""}`.toLowerCase().includes(query),
  ).map((entry) => entry.title);
}

describe("keybinding search entries", () => {
  it("lists every built-in command once, folding the numbered jumps into their first", () => {
    const folded = new Set<string>([
      ...THREAD_JUMP_KEYBINDING_COMMANDS.slice(1),
      ...MODEL_PICKER_JUMP_KEYBINDING_COMMANDS.slice(1),
    ]);
    expect(KEYBINDING_SEARCH_ENTRIES.map((entry) => entry.targetId)).toEqual(
      STATIC_KEYBINDING_COMMANDS.filter((command) => !folded.has(command)).map(keybindingRowId),
    );
  });

  it("opens the Keybindings panel at a row titled like the result", () => {
    for (const entry of KEYBINDING_SEARCH_ENTRIES) {
      expect(entry).toMatchObject({ section: "keybindings", owner: "client" });
      expect(entry.title).not.toMatch(/^Run:/);
    }
    const byTarget = (command: StaticKeybindingCommand) =>
      KEYBINDING_SEARCH_ENTRIES.find((entry) => entry.targetId === keybindingRowId(command));
    expect(byTarget("navigation.back")).toMatchObject({
      title: getCommandMeta("navigation.back").title,
      description: "Navigation shortcut",
    });
    expect(byTarget("thread.jump.1")?.title).toBe("Jump to thread 1–9");
    expect(byTarget("modelPicker.jump.1")?.title).toBe("Pick model 1–9");
  });

  it("keeps titles unique in the Keybindings section, which keys its results by title", () => {
    const titles = [...SETTINGS_SEARCH_INDEX, ...KEYBINDING_SEARCH_ENTRIES]
      .filter((entry) => entry.section === "keybindings")
      .map((entry) => entry.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("finds a shortcut by its title, its id or its default key", () => {
    for (const query of ["go back", "navigation.back", "mod+[", "cmd+[", "ctrl+["]) {
      expect(search(query), query).toContain("Go back");
    }
    expect(search("mod+shift+[")).toContain("Previous thread");
    expect(search("mod+shift+[")).not.toContain("Go back");
    for (const query of ["thread.jump.5", "mod+5"]) {
      expect(search(query), query).toContain("Jump to thread 1–9");
    }
  });
});
