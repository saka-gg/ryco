import {
  DEFAULT_MODEL,
  DEFAULT_SERVER_SETTINGS,
  EffectiveProjectPreferences,
  PROJECT_PREFERENCE_VALUE_KEYS,
  ProjectId,
  ProviderInstanceId,
  type ProjectPreferenceValueKey,
  type ServerSettings,
} from "@ryco/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { applyServerSettingsPatch } from "@ryco/shared/serverSettings";
import {
  resolveProjectPreferences,
  resolveProjectPreferenceValue,
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
  it("ranks a node default above a legacy project model, and a project override above both", () => {
    const legacyModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
    const legacy = { ...project, defaultModelSelection: legacyModel };
    let settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      initialModelSelection: model,
    });
    expect(resolveProjectPreferences({ settings, project: legacy }).initialModelSelection).toEqual({
      value: model,
      source: "node",
    });
    const override = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-x" };
    settings = applyServerSettingsPatch(settings, {
      projectPreferences: { p: { initialModelSelection: override } },
    });
    expect(
      resolveProjectPreferences({ settings, project: legacy }).initialModelSelection,
    ).toMatchObject({ value: override, source: "project" });
    // An explicit project reset inherits the node default, never the legacy model.
    settings = applyServerSettingsPatch(settings, {
      projectPreferences: { p: { initialModelSelection: null } },
    });
    expect(resolveProjectPreferences({ settings, project: legacy }).initialModelSelection).toEqual({
      value: model,
      source: "node",
    });
    // Without a node default the legacy model still stands in for the built-in one.
    settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {});
    expect(resolveProjectPreferences({ settings, project: legacy }).initialModelSelection).toEqual({
      value: legacyModel,
      source: "legacy-project",
    });
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

/**
 * One node value and one project value per registry key, the project's falsy where it can be.
 * A key added to the registry fails typecheck here until it has a row.
 */
const INHERITANCE: {
  readonly [K in ProjectPreferenceValueKey]: {
    readonly node: ServerSettings[K];
    readonly project: ServerSettings[K];
  };
} = {
  defaultThreadEnvMode: { node: "worktree", project: "local" },
  worktreeBranchPrefix: { node: "team/tasks", project: "" },
  runSetupScript: { node: false, project: true },
  worktreeBranchChangeTypes: { node: false, project: true },
  pullRequestTemplates: { node: false, project: true },
};

describe("registry inheritance", () => {
  it.each(PROJECT_PREFERENCE_VALUE_KEYS)(
    "gives %s by project id alone, as the full resolver does",
    (key) => {
      const sample = INHERITANCE[key];
      const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        [key]: sample.node,
        projectPreferences: { p: { [key]: sample.project } },
      });
      expect(resolveProjectPreferenceValue(settings, "p", key)).toEqual(sample.project);
      expect(resolveProjectPreferenceValue(settings, "other", key)).toEqual(sample.node);
      expect(resolveProjectPreferenceValue(settings, null, key)).toEqual(sample.node);
      expect(resolveProjectPreferenceValue(settings, "p", key)).toEqual(
        resolveProjectPreferences({ settings, project })[key]?.value,
      );
    },
  );
  it.each(PROJECT_PREFERENCE_VALUE_KEYS)("resolves %s from the project, else the node", (key) => {
    const sample = INHERITANCE[key];
    const other = { ...project, id: ProjectId.make("other") };
    expect(resolveProjectPreferences({ settings: DEFAULT_SERVER_SETTINGS, project })[key]).toEqual({
      value: DEFAULT_SERVER_SETTINGS[key],
      source: "node",
    });
    let settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { [key]: sample.node });
    expect(resolveProjectPreferences({ settings, project })[key]).toEqual({
      value: sample.node,
      source: "node",
    });
    expect(resolveProjectPreferences({ settings })[key]).toEqual({
      value: sample.node,
      source: "node",
    });
    settings = applyServerSettingsPatch(settings, {
      projectPreferences: { p: { [key]: sample.project } },
    });
    expect(resolveProjectPreferences({ settings, project })[key]).toEqual({
      value: sample.project,
      source: "project",
    });
    expect(resolveProjectPreferences({ settings, project: other })[key]).toEqual({
      value: sample.node,
      source: "node",
    });
    settings = applyServerSettingsPatch(settings, { projectPreferences: { p: { [key]: null } } });
    expect(resolveProjectPreferences({ settings, project })[key]).toEqual({
      value: sample.node,
      source: "node",
    });
  });
  it("resolves every effective field, in a shape the RPC schema encodes", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      initialModelSelection: model,
      projectPreferences: { p: { runSetupScript: false } },
    });
    const effective = resolveProjectPreferences({ settings, project });
    expect(Object.keys(effective).toSorted()).toEqual(
      Object.keys(EffectiveProjectPreferences.fields).toSorted(),
    );
    expect(
      Schema.decodeUnknownSync(EffectiveProjectPreferences)(
        Schema.encodeSync(EffectiveProjectPreferences)(effective),
      ),
    ).toEqual(effective);
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
