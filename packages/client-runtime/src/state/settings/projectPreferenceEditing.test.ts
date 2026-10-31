import { describe, expect, it } from "vitest";
import type { EffectiveProjectPreferences, ServerSettings } from "@ryco/contracts";
import {
  DEFAULT_SERVER_SETTINGS,
  PROJECT_PREFERENCE_VALUE_KEYS,
  ProviderInstanceId,
} from "@ryco/contracts";
import { applyServerSettingsPatch } from "@ryco/shared/serverSettings";
import {
  projectPreferenceCanReset,
  projectPreferenceResetValue,
  projectPreferencesWritePatch,
  projectPreferenceSupported,
} from "./projectPreferenceEditing.ts";

const builtinModel = { instanceId: ProviderInstanceId.make("codex"), model: "builtin-model" };
const nodeModel = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "node-model",
  options: [{ id: "reasoningEffort", value: "high" }],
};
const projectModel = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-x" };

/** Effective preferences as the node resolves them, for the given node settings and project. */
function effectiveFor(
  settings: ServerSettings,
  projectId?: string,
  legacyModel?: typeof projectModel,
): EffectiveProjectPreferences {
  const overrides = projectId ? (settings.projectPreferences[projectId] ?? {}) : {};
  const model = overrides.initialModelSelection;
  const legacy =
    Object.hasOwn(overrides, "initialModelSelection") || settings.initialModelSelection
      ? undefined
      : legacyModel;
  return {
    overrides,
    initialModelSelection: model
      ? { value: model, source: "project" }
      : settings.initialModelSelection
        ? { value: settings.initialModelSelection, source: "node" }
        : legacy
          ? { value: legacy, source: "legacy-project" }
          : { value: builtinModel, source: "builtin" },
    defaultThreadEnvMode: {
      value: overrides.defaultThreadEnvMode ?? settings.defaultThreadEnvMode,
      source: overrides.defaultThreadEnvMode === undefined ? "node" : "project",
    },
    worktreeBranchPrefix: {
      value: overrides.worktreeBranchPrefix ?? settings.worktreeBranchPrefix,
      source: overrides.worktreeBranchPrefix === undefined ? "node" : "project",
    },
    runSetupScript: {
      value: overrides.runSetupScript ?? settings.runSetupScript,
      source: overrides.runSetupScript === undefined ? "node" : "project",
    },
    worktreeBranchChangeTypes: {
      value: overrides.worktreeBranchChangeTypes ?? settings.worktreeBranchChangeTypes,
      source: overrides.worktreeBranchChangeTypes === undefined ? "node" : "project",
    },
    pullRequestTemplates: {
      value: overrides.pullRequestTemplates ?? settings.pullRequestTemplates,
      source: overrides.pullRequestTemplates === undefined ? "node" : "project",
    },
    worktreeRoot: { value: "", source: "builtin" },
  };
}

describe("project preference writes", () => {
  it("compares a project's never-set fields as unset and its never-set model as absent", () => {
    const effective = effectiveFor(DEFAULT_SERVER_SETTINGS, "p");
    expect(
      projectPreferencesWritePatch({ effective, projectId: "p", patch: { runSetupScript: false } }),
    ).toEqual({
      projectPreferences: { p: { runSetupScript: false } },
      expectedProjectPreferences: { p: { runSetupScript: null } },
    });
    expect(
      projectPreferencesWritePatch({
        effective,
        projectId: "p",
        patch: { initialModelSelection: projectModel, worktreeBranchPrefix: "" },
      }),
    ).toEqual({
      projectPreferences: { p: { initialModelSelection: projectModel, worktreeBranchPrefix: "" } },
      expectedProjectPreferences: {
        p: { initialModelSelection: "absent", worktreeBranchPrefix: null },
      },
    });
  });

  it("compares a project's own overrides, its model reset mask included, when resetting", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectPreferences: { p: { initialModelSelection: null, runSetupScript: false } },
    });
    const effective = effectiveFor(settings, "p", projectModel);
    expect(
      projectPreferencesWritePatch({
        effective,
        projectId: "p",
        patch: { runSetupScript: null, initialModelSelection: projectModel },
      }),
    ).toEqual({
      projectPreferences: { p: { runSetupScript: null, initialModelSelection: projectModel } },
      expectedProjectPreferences: { p: { runSetupScript: false, initialModelSelection: null } },
    });
  });

  it("compares node defaults by effective value, and a built-in model as unset", () => {
    const effective = effectiveFor(DEFAULT_SERVER_SETTINGS);
    expect(
      projectPreferencesWritePatch({
        effective,
        patch: { initialModelSelection: nodeModel, defaultThreadEnvMode: "worktree" },
      }),
    ).toEqual({
      initialModelSelection: nodeModel,
      defaultThreadEnvMode: "worktree",
      expectedNodePreferences: { initialModelSelection: null, defaultThreadEnvMode: "local" },
    });
    const configured = effectiveFor(
      applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        initialModelSelection: nodeModel,
        worktreeBranchPrefix: "team",
      }),
    );
    expect(
      projectPreferencesWritePatch({
        effective: configured,
        projectId: "",
        patch: { initialModelSelection: null, worktreeBranchPrefix: "ryco" },
      }),
    ).toEqual({
      initialModelSelection: null,
      worktreeBranchPrefix: "ryco",
      expectedNodePreferences: { initialModelSelection: nodeModel, worktreeBranchPrefix: "team" },
    });
  });

  it("writes patches the node accepts when current and rejects once another edit landed", () => {
    let settings = DEFAULT_SERVER_SETTINGS;
    for (const [projectId, patch] of [
      ["p", { runSetupScript: false }],
      ["p", { initialModelSelection: projectModel }],
      ["p", { runSetupScript: null, initialModelSelection: null }],
      [undefined, { initialModelSelection: nodeModel }],
      [undefined, { defaultThreadEnvMode: "worktree", worktreeBranchPrefix: "team" }],
    ] as const) {
      const effective = effectiveFor(settings, projectId);
      const write = projectPreferencesWritePatch({ effective, projectId, patch });
      const next = applyServerSettingsPatch(settings, write);
      expect(() => applyServerSettingsPatch(next, write)).toThrow(/changed elsewhere/);
      settings = next;
    }
    expect(settings.projectPreferences).toEqual({ p: { initialModelSelection: null } });
    expect(settings).toMatchObject({
      initialModelSelection: nodeModel,
      defaultThreadEnvMode: "worktree",
      worktreeBranchPrefix: "team",
    });
  });

  it("keeps edits to other fields of the same project independent", () => {
    const effective = effectiveFor(DEFAULT_SERVER_SETTINGS, "p");
    const first = projectPreferencesWritePatch({
      effective,
      projectId: "p",
      patch: { runSetupScript: false },
    });
    const second = projectPreferencesWritePatch({
      effective,
      projectId: "p",
      patch: { defaultThreadEnvMode: "worktree" },
    });
    const settings = applyServerSettingsPatch(
      applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, first),
      second,
    );
    expect(settings.projectPreferences).toEqual({
      p: { runSetupScript: false, defaultThreadEnvMode: "worktree" },
    });
  });
});

describe("project preference resets", () => {
  it("resets a project field to inheritance, and a node field to Ryco's default", () => {
    for (const key of PROJECT_PREFERENCE_VALUE_KEYS) {
      expect(projectPreferenceResetValue(key, "p")).toBeNull();
      expect(projectPreferenceResetValue(key)).toBe(DEFAULT_SERVER_SETTINGS[key]);
    }
    expect(projectPreferenceResetValue("initialModelSelection", "p")).toBeNull();
    expect(projectPreferenceResetValue("initialModelSelection", "")).toBeNull();
  });

  it("offers a reset only for a project's own override or a changed node value", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      initialModelSelection: nodeModel,
      runSetupScript: false,
      projectPreferences: { p: { worktreeBranchPrefix: "" } },
    });
    const project = effectiveFor(settings, "p");
    expect(
      projectPreferenceCanReset({
        effective: project,
        projectId: "p",
        field: "worktreeBranchPrefix",
      }),
    ).toBe(true);
    for (const field of ["runSetupScript", "initialModelSelection"] as const)
      expect(projectPreferenceCanReset({ effective: project, projectId: "p", field })).toBe(false);
    const legacy = effectiveFor(DEFAULT_SERVER_SETTINGS, "p", projectModel);
    expect(
      projectPreferenceCanReset({
        effective: legacy,
        projectId: "p",
        field: "initialModelSelection",
      }),
    ).toBe(true);
    const node = effectiveFor(settings);
    expect(projectPreferenceCanReset({ effective: node, field: "initialModelSelection" })).toBe(
      true,
    );
    expect(projectPreferenceCanReset({ effective: node, field: "runSetupScript" })).toBe(true);
    expect(projectPreferenceCanReset({ effective: node, field: "defaultThreadEnvMode" })).toBe(
      false,
    );
    const defaults = effectiveFor(DEFAULT_SERVER_SETTINGS);
    expect(projectPreferenceCanReset({ effective: defaults, field: "initialModelSelection" })).toBe(
      false,
    );
    expect(projectPreferenceCanReset({ effective: null, field: "runSetupScript" })).toBe(false);
    expect(
      projectPreferenceCanReset({ effective: null, projectId: "p", field: "runSetupScript" }),
    ).toBe(false);
  });

  it("reports only the preferences the node's reply carries", () => {
    const effective = effectiveFor(DEFAULT_SERVER_SETTINGS);
    for (const key of ["initialModelSelection", ...PROJECT_PREFERENCE_VALUE_KEYS] as const)
      expect(projectPreferenceSupported(effective, key)).toBe(true);
    const { runSetupScript: _omitted, ...older } = effective;
    expect(projectPreferenceSupported(older as EffectiveProjectPreferences, "runSetupScript")).toBe(
      false,
    );
    // A node from before the change-type and template overrides omits them.
    const {
      worktreeBranchChangeTypes: _types,
      pullRequestTemplates: _templates,
      ...before
    } = effective;
    expect(projectPreferenceSupported(before, "worktreeBranchChangeTypes")).toBe(false);
    expect(projectPreferenceSupported(before, "pullRequestTemplates")).toBe(false);
    expect(projectPreferenceSupported(before, "runSetupScript")).toBe(true);
  });
});
