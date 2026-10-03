import { scopedScriptCommand } from "@ryco/client-runtime/state/settings";
import { describe, expect, it } from "vite-plus/test";
import type { KeybindingRule } from "@ryco/contracts";
import { buildConflictIndex, detectConflictsAt } from "./keybindingConflicts";

const r = (key: string, command: KeybindingRule["command"], when?: string): KeybindingRule => ({
  key,
  command,
  when,
});

describe("detectConflictsAt", () => {
  it("returns no conflicts when no other rule shares the key", () => {
    const draft = [r("mod+t", "chat.new"), r("mod+j", "terminal.toggle")];
    expect(detectConflictsAt(draft, 0)).toEqual([]);
  });

  it("flags conflicts for the same key in the same context", () => {
    const draft = [r("mod+t", "chat.new"), r("mod+t", "terminal.toggle")];
    expect(detectConflictsAt(draft, 0)).toEqual([
      { key: "mod+t", otherCommand: "terminal.toggle", otherWhen: undefined },
    ]);
  });

  it("ignores rules with the same command (e.g. multiple bindings for chat.new)", () => {
    const draft = [
      r("mod+n", "chat.new", "!terminalFocus"),
      r("mod+shift+o", "chat.new", "!terminalFocus"),
    ];
    expect(detectConflictsAt(draft, 0)).toEqual([]);
  });

  it("does NOT flag Always vs a specific when (runtime ordering resolves it)", () => {
    // thread.jump.1 (Always) + modelPicker.jump.1 (modelPickerOpen) is the
    // canonical case: the modal-scoped rule wins when its context is active,
    // the default fires otherwise. No conflict to surface.
    const draft = [
      r("mod+1", "thread.jump.1"),
      r("mod+1", "modelPicker.jump.1", "modelPickerOpen"),
    ];
    expect(detectConflictsAt(draft, 0)).toEqual([]);
    expect(detectConflictsAt(draft, 1)).toEqual([]);
  });

  it("does not flag conflicting commands with mutually exclusive when contexts", () => {
    const draft = [
      r("mod+d", "diff.toggle", "!terminalFocus"),
      r("mod+d", "terminal.split", "terminalFocus"),
    ];
    expect(detectConflictsAt(draft, 0)).toEqual([]);
    expect(detectConflictsAt(draft, 1)).toEqual([]);
  });

  it("treats identical when strings as overlapping", () => {
    const draft = [
      r("mod+t", "chat.new", "terminalFocus"),
      r("mod+t", "terminal.toggle", "terminalFocus"),
    ];
    expect(detectConflictsAt(draft, 0)).toHaveLength(1);
  });

  it("does not flag rules with custom whens that differ from the target", () => {
    const draft = [
      r("mod+t", "chat.new", "terminalOpen && !terminalFocus"),
      r("mod+t", "terminal.toggle", "terminalFocus"),
    ];
    expect(detectConflictsAt(draft, 0)).toEqual([]);
  });
});

describe("buildConflictIndex", () => {
  it("groups conflicts by command", () => {
    const draft = [
      r("mod+t", "chat.new"),
      r("mod+t", "terminal.toggle"),
      r("mod+j", "diff.toggle"),
    ];
    const index = buildConflictIndex(draft);
    expect(index.get("chat.new")).toHaveLength(1);
    expect(index.get("terminal.toggle")).toHaveLength(1);
    expect(index.get("diff.toggle")).toBeUndefined();
  });

  it("returns an empty index when there are no conflicts", () => {
    const draft = [r("mod+t", "chat.new"), r("mod+j", "terminal.toggle")];
    expect(buildConflictIndex(draft).size).toBe(0);
  });
});

it("does not report conflicts between scripts on different nodes or projects", () => {
  const first = scopedScriptCommand({ environmentId: "node-a", projectId: "same-project" }, "test");
  const second = scopedScriptCommand(
    { environmentId: "node-b", projectId: "same-project" },
    "test",
  );
  expect(
    detectConflictsAt(
      [
        { key: "mod+x", command: first },
        { key: "mod+x", command: second },
      ],
      0,
    ),
  ).toEqual([]);
});
