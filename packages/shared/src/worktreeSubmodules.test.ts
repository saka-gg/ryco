import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS } from "@ryco/contracts";
import {
  selectWorktreeSubmodules,
  worktreeSubmodulesPatch,
  WORKTREE_SUBMODULE_OPTIONS,
} from "./worktreeSubmodules.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

describe("worktree submodule selection", () => {
  it("resolves project > repository > node and explicit recursive overrides", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      worktreeSubmodules: "none" as const,
      projectWorktreeSubmodules: { p: "recursive" as const },
    };
    expect(
      selectWorktreeSubmodules({ settings, projectId: "p", repositoryMode: "top-level" }),
    ).toEqual({ mode: "recursive", source: "project" });
    expect(
      selectWorktreeSubmodules({ settings, projectId: "missing", repositoryMode: "top-level" }),
    ).toEqual({ mode: "top-level", source: "repository" });
    expect(selectWorktreeSubmodules({ settings, projectId: "missing" })).toEqual({
      mode: "none",
      source: "node",
    });
    expect(
      selectWorktreeSubmodules({ settings: DEFAULT_SERVER_SETTINGS, projectId: "constructor" }),
    ).toEqual({ mode: "recursive", source: "node" });
  });
  it("patches independently and resets only the selected project", () => {
    const a = applyServerSettingsPatch(
      DEFAULT_SERVER_SETTINGS,
      worktreeSubmodulesPatch("a", "none"),
    );
    const b = applyServerSettingsPatch(a, worktreeSubmodulesPatch("b", "top-level"));
    const reset = applyServerSettingsPatch(b, worktreeSubmodulesPatch("a", null));
    expect(reset.projectWorktreeSubmodules).toEqual({ b: "top-level" });
    expect(a.projectWorktreeSubmodules).toEqual({ a: "none" });
    expect(worktreeSubmodulesPatch(null, null)).toEqual({ worktreeSubmodules: "recursive" });
  });
  it("exposes the same three selection choices to every platform", () => {
    expect(WORKTREE_SUBMODULE_OPTIONS.map((option) => option.value)).toEqual([
      "recursive",
      "top-level",
      "none",
    ]);
    for (const option of WORKTREE_SUBMODULE_OPTIONS)
      expect(worktreeSubmodulesPatch(null, option.value)).toEqual({
        worktreeSubmodules: option.value,
      });
  });
});
