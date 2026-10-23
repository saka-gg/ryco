import { describe, expect, it } from "vitest";
import type { AppKeybindings, KeybindingRule } from "@ryco/contracts/keybindings";
import {
  compileResolvedKeybindingsConfig,
  NODE_DEFAULT_KEYBINDINGS,
} from "@ryco/shared/keybindings";
import {
  APP_DEFAULT_KEYBINDINGS,
  APP_DEFAULT_RESOLVED_KEYBINDINGS,
  CLIENT_ONLY_DEFAULT_KEYBINDINGS,
  composeAppDefaultKeybindings,
  SUPERSEDED_NODE_DEFAULT_KEYBINDINGS,
} from "./appKeybindingDefaults.ts";
import {
  appKeybindingsFromRules,
  DEFAULT_APP_KEYBINDINGS,
  resolveAppKeybindings,
  validateAppKeybindings,
} from "./appKeybindings.ts";

const isSameRule = (left: KeybindingRule, right: KeybindingRule) =>
  left.key === right.key && left.command === right.command && left.when === right.when;
const remainingNodeDefaults = NODE_DEFAULT_KEYBINDINGS.filter(
  (rule) => !SUPERSEDED_NODE_DEFAULT_KEYBINDINGS.some((superseded) => isSameRule(rule, superseded)),
);

describe("app default keybindings", () => {
  it("lists the node's remaining rules in node order, then the client-only rules", () => {
    expect(APP_DEFAULT_KEYBINDINGS).toEqual([
      ...remainingNodeDefaults,
      ...CLIENT_ONLY_DEFAULT_KEYBINDINGS,
    ]);
  });

  it("supersedes only node rules and leaves no command with defaults in both lists", () => {
    for (const superseded of SUPERSEDED_NODE_DEFAULT_KEYBINDINGS) {
      expect(NODE_DEFAULT_KEYBINDINGS).toContainEqual(superseded);
    }
    const nodeCommands = new Set(remainingNodeDefaults.map((rule) => rule.command));
    expect(
      CLIENT_ONLY_DEFAULT_KEYBINDINGS.filter((rule) => nodeCommands.has(rule.command)),
    ).toEqual([]);
  });

  it("gives a new chat without a project a client-only default", () => {
    expect(NODE_DEFAULT_KEYBINDINGS.some((rule) => rule.command === "chat.newWithoutProject")).toBe(
      false,
    );
    expect(APP_DEFAULT_KEYBINDINGS).toContainEqual({
      key: "mod+alt+n",
      command: "chat.newWithoutProject",
      when: "!terminalFocus",
    });
  });

  it("resolves the app defaults and stores nothing for an untouched editor", () => {
    expect(resolveAppKeybindings()).toEqual(APP_DEFAULT_RESOLVED_KEYBINDINGS);
    expect(appKeybindingsFromRules(APP_DEFAULT_KEYBINDINGS)).toEqual(DEFAULT_APP_KEYBINDINGS);
  });

  describe("when a client-only rule supersedes a node rule", () => {
    const nodeRule = { key: "mod+p", command: "workspace.files", when: "!terminalFocus" } as const;
    const clientRule = { key: "mod+p", command: "projects.open", when: "!terminalFocus" } as const;
    const defaults = composeAppDefaultKeybindings(
      NODE_DEFAULT_KEYBINDINGS,
      [nodeRule],
      [clientRule],
    );
    const resolvedDefaults = compileResolvedKeybindingsConfig(defaults);
    const resolvedCommands = (preferences: AppKeybindings) =>
      resolveAppKeybindings(preferences, resolvedDefaults).map((rule) => rule.command);

    it("resolves the client-only rule in place of the node rule", () => {
      expect(NODE_DEFAULT_KEYBINDINGS).toContainEqual(nodeRule);
      expect(defaults).not.toContainEqual(nodeRule);
      expect(defaults.at(-1)).toEqual(clientRule);
      const commands = resolvedCommands(DEFAULT_APP_KEYBINDINGS);
      expect(commands).toContain("projects.open");
      expect(commands).not.toContain("workspace.files");
    });

    it("stores nothing for an unchanged editor snapshot", () => {
      expect(appKeybindingsFromRules(defaults, defaults)).toEqual(DEFAULT_APP_KEYBINDINGS);
    });

    it("keeps a removed client-only default unbound after a reload", () => {
      const preferences = appKeybindingsFromRules(
        defaults.filter((rule) => rule.command !== "projects.open"),
        defaults,
      );
      expect(preferences).toEqual({ rules: [], disabledCommands: ["projects.open"] });
      const reloaded = validateAppKeybindings(JSON.parse(JSON.stringify(preferences)));
      expect(resolvedCommands(reloaded)).not.toContain("projects.open");
    });

    it("turns the default on for a document saved before it existed", () => {
      const commands = resolvedCommands({
        rules: [{ key: "mod+x", command: "terminal.toggle" }],
        disabledCommands: ["chat.new"],
      });
      expect(commands).toContain("projects.open");
      expect(commands).not.toContain("chat.new");
    });
  });
});
