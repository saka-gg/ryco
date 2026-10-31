import { PROJECT_PREFERENCE_VALUE_KEYS, PROJECT_PREFERENCE_VALUES } from "@ryco/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  PROJECT_PREFERENCE_FIELDS,
  projectPreferenceSourceLabel,
  projectPreferenceValueLabel,
  readProjectPreferenceText,
} from "./projectPreferences.ts";

describe("project preference fields", () => {
  it("presents every registry key, in registry order", () => {
    expect(Object.keys(PROJECT_PREFERENCE_FIELDS)).toEqual(PROJECT_PREFERENCE_VALUE_KEYS);
  });

  it.each(PROJECT_PREFERENCE_VALUE_KEYS)("offers only values %s accepts", (key) => {
    const field = PROJECT_PREFERENCE_FIELDS[key];
    if (field.kind === "text") return;
    const values = field.options.map((option) => option.value);
    expect(new Set(values).size).toBe(values.length);
    expect(new Set(values.map(String)).size).toBe(values.length);
    for (const value of values)
      expect(Schema.is(PROJECT_PREFERENCE_VALUES.fields[key])(value)).toBe(true);
  });

  it("names each setting's control and reset action", () => {
    for (const field of Object.values(PROJECT_PREFERENCE_FIELDS)) {
      expect(field.title).not.toBe("");
      expect(field.controlLabel).not.toBe("");
      expect(field.resetLabel).toBe(field.resetLabel.toLowerCase());
    }
  });

  it("saves a trimmed branch prefix and rejects one Git would refuse", () => {
    expect(readProjectPreferenceText("worktreeBranchPrefix", " team/tasks ")).toBe("team/tasks");
    expect(readProjectPreferenceText("worktreeBranchPrefix", "")).toBe("");
    for (const input of ["team/", "a..b", "a".repeat(129)])
      expect(readProjectPreferenceText("worktreeBranchPrefix", input)).toBeNull();
  });

  it("reads a value as its option's label, or the text with the placeholder for none", () => {
    expect(projectPreferenceValueLabel("defaultThreadEnvMode", "worktree")).toBe("New worktree");
    expect(projectPreferenceValueLabel("runSetupScript", false)).toBe("Skip setup");
    expect(projectPreferenceValueLabel("worktreeBranchPrefix", "team")).toBe("team");
    expect(projectPreferenceValueLabel("worktreeBranchPrefix", "")).toBe("No prefix");
  });
});

describe("project preference sources", () => {
  it("words each source the same on every surface, naming the node as the surface does", () => {
    const device = { nodeNoun: "device" } as const;
    const node = { nodeNoun: "node" } as const;
    expect(projectPreferenceSourceLabel(undefined, device)).toBe("Loading…");
    for (const source of ["project", "legacy-project"] as const)
      expect(projectPreferenceSourceLabel(source, { ...node, projectId: "p" })).toBe(
        "Overridden for this project",
      );
    expect(projectPreferenceSourceLabel("node", { ...device, projectId: "p" })).toBe(
      "Inherited from device defaults",
    );
    expect(projectPreferenceSourceLabel("node", { ...node, projectId: "p" })).toBe(
      "Inherited from node defaults",
    );
    expect(projectPreferenceSourceLabel("builtin", { ...node, projectId: "p" })).toBe(
      "Inherited from Ryco defaults",
    );
    expect(projectPreferenceSourceLabel("node", device)).toBe("Device default");
    expect(projectPreferenceSourceLabel("node", node)).toBe("Node default");
    expect(projectPreferenceSourceLabel("builtin", node)).toBe("Ryco default");
  });
});
