import { describe, expect, it } from "vitest";
import { DEFAULT_APP_KEYBINDINGS } from "./appKeybindings.ts";
import { APP_DEFAULT_KEYBINDINGS } from "./appKeybindingDefaults.ts";
import { appKeybindingsFromRules, importAppKeybindings } from "./appKeybindingsEditing.ts";

const custom = [{ key: "mod+x", command: "terminal.toggle" }];

describe("keybindings editor snapshots", () => {
  it("stores only actual overrides so later import can fill untouched commands", () => {
    const fullEditor = APP_DEFAULT_KEYBINDINGS.map((rule) =>
      rule.command === "terminal.toggle" ? { ...rule, key: "mod+x" } : rule,
    );
    const preferences = appKeybindingsFromRules(fullEditor);
    expect(preferences.rules).toEqual(custom);
    expect(preferences.disabledCommands).toEqual([]);
    const imported = importAppKeybindings(preferences, [{ key: "mod+r", command: "diff.toggle" }]);
    expect(imported.rules).toEqual([{ key: "mod+r", command: "diff.toggle" }, ...custom]);
    expect(appKeybindingsFromRules(APP_DEFAULT_KEYBINDINGS)).toEqual(DEFAULT_APP_KEYBINDINGS);
  });

  it.each([
    { key: "ctrl", command: "terminal.toggle" },
    { key: "mod+x", command: "terminal.toggle", when: "terminalFocus &&" },
  ] as const)("rejects invalid extra default-command rules before normalization: %j", (invalid) => {
    expect(() => appKeybindingsFromRules([...APP_DEFAULT_KEYBINDINGS, invalid])).toThrow(
      "Invalid shortcut or when expression.",
    );
  });
});
