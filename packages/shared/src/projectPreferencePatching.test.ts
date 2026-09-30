import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsPatch,
} from "@ryco/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const initial = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "model",
  options: [{ id: "reasoningEffort", value: "high" }],
};

describe("independent preference patches", () => {
  it("keeps project preferences, submodule policies and worktree roots independent during resets", () => {
    let settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectPreferences: { a: { runSetupScript: false }, b: { worktreeBranchPrefix: "team" } },
      projectWorktreeSubmodules: { a: "none", b: "top-level" },
      projectWorktreeRoots: { a: "/a", b: "/b" },
    });
    settings = applyServerSettingsPatch(settings, {
      projectPreferences: { a: { defaultThreadEnvMode: "worktree" } },
      expectedProjectPreferences: { a: { defaultThreadEnvMode: null } },
      projectWorktreeSubmodules: { a: null },
    });
    settings = applyServerSettingsPatch(settings, {
      projectPreferences: { a: { runSetupScript: null } },
      expectedProjectPreferences: { a: { runSetupScript: false } },
      projectWorktreeRoots: { b: null },
    });
    const persisted = Schema.decodeSync(ServerSettings)(JSON.parse(JSON.stringify(settings)));
    expect(persisted.projectPreferences).toEqual({
      a: { defaultThreadEnvMode: "worktree" },
      b: { worktreeBranchPrefix: "team" },
    });
    expect(persisted.projectWorktreeSubmodules).toEqual({ b: "top-level" });
    expect(persisted.projectWorktreeRoots).toEqual({ a: "/a" });
    expect(persisted).not.toHaveProperty("expectedProjectPreferences");
  });
  it("preserves unrelated projects/fields under interleaved writes", () => {
    let settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectPreferences: { a: { runSetupScript: false }, b: { worktreeBranchPrefix: "team" } },
      expectedProjectPreferences: { a: { runSetupScript: null } },
    });
    settings = applyServerSettingsPatch(settings, {
      projectPreferences: { a: { defaultThreadEnvMode: "worktree" } },
      expectedProjectPreferences: { a: { defaultThreadEnvMode: null } },
    });
    expect(settings.projectPreferences).toEqual({
      a: { runSetupScript: false, defaultThreadEnvMode: "worktree" },
      b: { worktreeBranchPrefix: "team" },
    });
    expect(settings).not.toHaveProperty("expectedProjectPreferences");
  });
  it("rejects stale writes to the same field and accepts unrelated node changes", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectPreferences: { a: { runSetupScript: false } },
      runSetupScript: false,
    });
    expect(() =>
      applyServerSettingsPatch(settings, {
        projectPreferences: { a: { runSetupScript: true } },
        expectedProjectPreferences: { a: { runSetupScript: null } },
      }),
    ).toThrow("changed elsewhere");
    expect(() =>
      applyServerSettingsPatch(settings, {
        runSetupScript: true,
        expectedNodePreferences: { runSetupScript: true },
      }),
    ).toThrow("changed elsewhere");
    expect(
      applyServerSettingsPatch(settings, {
        worktreeBranchPrefix: "team",
        expectedNodePreferences: { worktreeBranchPrefix: "ryco" },
      }).worktreeBranchPrefix,
    ).toBe("team");
  });
  it("replaces whole models/options and persists model inheritance tombstones", () => {
    let settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      initialModelSelection: initial,
      projectPreferences: { a: { initialModelSelection: initial, runSetupScript: false } },
    });
    settings = applyServerSettingsPatch(settings, {
      initialModelSelection: { instanceId: initial.instanceId, model: "next" },
      projectPreferences: {
        a: { initialModelSelection: { instanceId: initial.instanceId, model: "next" } },
      },
    });
    expect(settings.initialModelSelection).not.toHaveProperty("options");
    expect(settings.projectPreferences.a?.initialModelSelection).not.toHaveProperty("options");
    settings = applyServerSettingsPatch(settings, {
      projectPreferences: { a: { initialModelSelection: null, runSetupScript: null } },
    });
    expect(
      Schema.decodeSync(ServerSettings)(JSON.parse(JSON.stringify(settings))).projectPreferences.a,
    ).toEqual({ initialModelSelection: null });
  });
  it("distinguishes an absent legacy preset override from a persisted inherit mask", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectPreferences: { a: { initialModelSelection: null } },
      expectedProjectPreferences: { a: { initialModelSelection: "absent" } },
    });
    expect(() =>
      applyServerSettingsPatch(settings, {
        projectPreferences: { a: { initialModelSelection: initial } },
        expectedProjectPreferences: { a: { initialModelSelection: "absent" } },
      }),
    ).toThrow("changed elsewhere");
  });
  it("rejects authority, credentials, arbitrary commands and invalid refs in project patches", () => {
    for (const forbidden of [
      "runtimeMode",
      "tokenMode",
      "providerInstances",
      "environment",
      "setupCommand",
      "worktreeRoot",
      "serverPassword",
      "theme",
      "submoduleMode",
    ]) {
      expect(() =>
        Schema.decodeUnknownSync(ServerSettingsPatch)({
          projectPreferences: { a: { [forbidden]: "value" } },
        }),
      ).toThrow();
    }
    expect(() =>
      Schema.decodeUnknownSync(ServerSettingsPatch)({
        projectPreferences: { a: { worktreeBranchPrefix: "../bad" } },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ServerSettingsPatch)({
        initialModelSelection: { ...initial, options: [{ id: "environment", value: "SECRET" }] },
      }),
    ).toThrow();
  });
});
