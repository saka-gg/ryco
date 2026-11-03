import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, GitWritingStyle } from "@ryco/contracts";

import {
  DEFAULT_GIT_WRITING_STYLE,
  GIT_WRITING_STYLE_OPTIONS,
  gitWritingStylePatch,
  selectGitWritingStyle,
} from "./gitWritingStyle.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

describe("git writing style selection", () => {
  it("lets a project override win and inherits the node default otherwise", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      gitWritingStyle: "default" as const,
      projectGitWritingStyle: { p: "conventional" as const, q: null },
    };
    expect(selectGitWritingStyle({ settings, projectId: "p" })).toEqual({
      style: "conventional",
      source: "project",
    });
    expect(selectGitWritingStyle({ settings, projectId: "q" })).toEqual({
      style: "default",
      source: "node",
    });
    expect(selectGitWritingStyle({ settings, projectId: "missing" })).toEqual({
      style: "default",
      source: "node",
    });
    expect(selectGitWritingStyle({ settings, projectId: null })).toEqual({
      style: "default",
      source: "node",
    });
  });

  it("treats project ids that name object properties as data", () => {
    for (const projectId of ["__proto__", "constructor", "toString"]) {
      expect(selectGitWritingStyle({ settings: DEFAULT_SERVER_SETTINGS, projectId })).toEqual({
        style: "repository",
        source: "node",
      });
    }
  });

  it("decodes the repository style as the node default", () => {
    expect(DEFAULT_SERVER_SETTINGS.gitWritingStyle).toBe(DEFAULT_GIT_WRITING_STYLE);
    expect(DEFAULT_SERVER_SETTINGS.projectGitWritingStyle).toEqual({});
  });

  it("patches the node default and single projects independently", () => {
    expect(gitWritingStylePatch(null, "conventional")).toEqual({ gitWritingStyle: "conventional" });
    expect(gitWritingStylePatch(null, null)).toEqual({ gitWritingStyle: "repository" });
    const a = applyServerSettingsPatch(
      DEFAULT_SERVER_SETTINGS,
      gitWritingStylePatch("a", "conventional"),
    );
    const b = applyServerSettingsPatch(a, gitWritingStylePatch("b", "default"));
    const reset = applyServerSettingsPatch(b, gitWritingStylePatch("a", null));
    expect(reset.projectGitWritingStyle).toEqual({ b: "default" });
    expect(reset.gitWritingStyle).toBe("repository");
    expect(a.projectGitWritingStyle).toEqual({ a: "conventional" });
    expect(
      applyServerSettingsPatch(reset, gitWritingStylePatch(null, "conventional"))
        .projectGitWritingStyle,
    ).toEqual({ b: "default" });
  });

  it("offers every style once, the default first", () => {
    expect(GIT_WRITING_STYLE_OPTIONS.map((option) => option.value).toSorted()).toEqual(
      [...GitWritingStyle.literals].toSorted(),
    );
    expect(GIT_WRITING_STYLE_OPTIONS[0].value).toBe(DEFAULT_GIT_WRITING_STYLE);
  });
});
