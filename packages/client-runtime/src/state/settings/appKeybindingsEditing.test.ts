import { describe, expect, it } from "vitest";
import type { AppKeybindings } from "@ryco/contracts/keybindings";
import { NODE_DEFAULT_KEYBINDINGS } from "@ryco/shared/keybindings";
import { DEFAULT_APP_KEYBINDINGS, resolveAppKeybindings } from "./appKeybindings.ts";
import { APP_DEFAULT_KEYBINDINGS, composeAppDefaultKeybindings } from "./appKeybindingDefaults.ts";
import {
  appKeybindingsFromEditor,
  appKeybindingsFromRules,
  importAppKeybindings,
} from "./appKeybindingsEditing.ts";

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

describe("saving the editor over saved preferences", () => {
  // As another version may save them: a rule that matches this version's default, and an
  // unbinding of a command that has no default here.
  const saved: AppKeybindings = {
    rules: [{ key: "mod+p", command: "workspace.files", when: "!terminalFocus" }],
    disabledCommands: ["projects.open"],
  };
  const resolvedShortcuts = (preferences: AppKeybindings) =>
    resolveAppKeybindings(preferences)
      .map((rule) => JSON.stringify(rule))
      .sort();

  it("keeps the saved form of commands the save leaves alone", () => {
    const snapshot = APP_DEFAULT_KEYBINDINGS.map((rule) =>
      rule.command === "terminal.toggle" ? { ...rule, key: "mod+x" } : rule,
    );
    const preferences = appKeybindingsFromEditor(saved, snapshot);
    expect(preferences).toEqual({
      rules: [...saved.rules, ...custom],
      disabledCommands: ["projects.open"],
    });
    // This version resolves the same shortcuts as from the snapshot alone.
    expect(resolvedShortcuts(preferences)).toEqual(
      resolvedShortcuts(appKeybindingsFromRules(snapshot)),
    );
  });

  it("replaces the saved form of commands the user changed", () => {
    const snapshot = [
      ...APP_DEFAULT_KEYBINDINGS.map((rule) =>
        rule.command === "workspace.files" ? { ...rule, key: "mod+shift+e" } : rule,
      ),
      { key: "mod+alt+o", command: "projects.open" },
    ];
    expect(appKeybindingsFromEditor(saved, snapshot)).toEqual({
      rules: [
        { key: "mod+shift+e", command: "workspace.files", when: "!terminalFocus" },
        { key: "mod+alt+o", command: "projects.open" },
      ],
      disabledCommands: [],
    });
  });

  it("treats an older node's defaults in an imported file as untouched", () => {
    const defaults = composeAppDefaultKeybindings(
      NODE_DEFAULT_KEYBINDINGS,
      [{ key: "mod+p", command: "workspace.files", when: "!terminalFocus" }],
      [
        { key: "mod+p", command: "projects.open", when: "!terminalFocus" },
        { key: "mod+shift+e", command: "workspace.files", when: "!terminalFocus" },
      ],
    );
    // Older nodes wrote their whole default list into the file.
    const legacyFile = [
      ...NODE_DEFAULT_KEYBINDINGS,
      { key: "mod+r", command: "pullRequests.open" },
    ];
    expect(importAppKeybindings(DEFAULT_APP_KEYBINDINGS, legacyFile, defaults)).toEqual({
      rules: [{ key: "mod+r", command: "pullRequests.open" }],
      disabledCommands: [],
    });
  });
});
