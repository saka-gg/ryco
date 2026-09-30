import {
  DEFAULT_MODEL,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
} from "@ryco/contracts";
import { describe, expect, it } from "vitest";
import { applyServerSettingsPatch } from "@ryco/shared/serverSettings";
import {
  resolveProjectPreferences,
  resolveThreadCreationPreferences,
} from "./projectPreferences.ts";

const project = { id: ProjectId.make("p"), defaultModelSelection: null };
const model = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
  options: [{ id: "reasoningEffort", value: "high" }],
};

describe("authoritative project preferences", () => {
  it("resolves builtins for legacy settings", () => {
    const effective = resolveProjectPreferences({ settings: DEFAULT_SERVER_SETTINGS, project });
    expect(effective.initialModelSelection).toEqual({
      value: { instanceId: "codex", model: DEFAULT_MODEL },
      source: "builtin",
    });
    expect(effective.defaultThreadEnvMode).toEqual({ value: "local", source: "node" });
    expect(effective.runSetupScript.value).toBe(true);
  });
  it("labels explicitly saved node values equal to initial defaults as node defaults", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultThreadEnvMode: "local",
      worktreeBranchPrefix: "ryco",
      runSetupScript: true,
      initialModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL },
    });
    const effective = resolveProjectPreferences({ settings, project });
    expect(effective.defaultThreadEnvMode.source).toBe("node");
    expect(effective.worktreeBranchPrefix.source).toBe("node");
    expect(effective.runSetupScript.source).toBe("node");
    expect(effective.initialModelSelection.source).toBe("node");
  });
  it("inherits node model options and creation preferences", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      initialModelSelection: model,
      defaultThreadEnvMode: "worktree",
      worktreeBranchPrefix: "team/tasks",
      runSetupScript: false,
    });
    const effective = resolveProjectPreferences({ settings, project });
    expect(effective.initialModelSelection).toEqual({ value: model, source: "node" });
    expect(effective.defaultThreadEnvMode).toEqual({ value: "worktree", source: "node" });
    expect(effective.runSetupScript).toEqual({ value: false, source: "node" });
  });
  it("retains legacy models and roots, and resets a model to true inheritance", () => {
    const legacy = { ...project, defaultModelSelection: model };
    let settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      worktreeRoot: "/node",
      projectWorktreeRoots: { p: "/project" },
    });
    expect(
      resolveProjectPreferences({ settings, project: legacy }).initialModelSelection.source,
    ).toBe("legacy-project");
    expect(resolveProjectPreferences({ settings, project: legacy }).worktreeRoot).toEqual({
      value: "/project",
      source: "project",
    });
    settings = applyServerSettingsPatch(settings, {
      projectPreferences: { p: { initialModelSelection: null } },
    });
    expect(
      resolveProjectPreferences({ settings, project: legacy }).initialModelSelection.source,
    ).toBe("builtin");
    expect(legacy.defaultModelSelection).toEqual(model);
  });
  it("keeps empty prefixes and false setup as explicit overrides", () => {
    let settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectPreferences: {
        p: { worktreeBranchPrefix: "", runSetupScript: false, defaultThreadEnvMode: "worktree" },
      },
    });
    expect(resolveProjectPreferences({ settings, project }).worktreeBranchPrefix).toEqual({
      value: "",
      source: "project",
    });
    expect(resolveProjectPreferences({ settings, project }).runSetupScript).toEqual({
      value: false,
      source: "project",
    });
    settings = applyServerSettingsPatch(settings, {
      projectPreferences: { p: { runSetupScript: null } },
    });
    const effective = resolveProjectPreferences({ settings, project });
    expect(effective.runSetupScript).toEqual({ value: true, source: "node" });
    expect(effective.defaultThreadEnvMode.source).toBe("project");
    expect(
      resolveProjectPreferences({ settings, project: { ...project, id: ProjectId.make("other") } })
        .defaultThreadEnvMode.source,
    ).toBe("node");
  });
});

describe("creation choice precedence", () => {
  it.each([true, false])(
    "inherits project setup=%s and preserves explicitly supplied creation choices",
    (runSetupScript) => {
      const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        initialModelSelection: model,
        projectPreferences: {
          p: {
            defaultThreadEnvMode: "worktree",
            worktreeBranchPrefix: "project/tasks",
            runSetupScript,
          },
        },
      });
      const effective = resolveProjectPreferences({ settings, project });
      expect(resolveThreadCreationPreferences({ effective })).toEqual({
        modelSelection: model,
        envMode: "worktree",
        worktreeBranchPrefix: "project/tasks",
        runSetupScript,
      });
      const explicitModel = { ...model, model: "caller", options: [] };
      expect(
        resolveThreadCreationPreferences({
          effective,
          modelSelection: explicitModel,
          envMode: "local",
          worktreeBranchPrefix: "",
          runSetupScript: !runSetupScript,
        }),
      ).toEqual({
        modelSelection: explicitModel,
        envMode: "local",
        worktreeBranchPrefix: "",
        runSetupScript: !runSetupScript,
      });
    },
  );
});
