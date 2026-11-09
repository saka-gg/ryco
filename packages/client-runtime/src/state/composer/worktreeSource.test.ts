import { describe, expect, it } from "vite-plus/test";

import {
  issueWorktreeSource,
  pullRequestWorktreeSource,
  workItemWorktreeSource,
  worktreeSourceIntent,
} from "./worktreeSource.ts";

describe("worktree sources", () => {
  it("labels each source the way the pickers show it", () => {
    expect(pullRequestWorktreeSource(42, "  Fix CI ").label).toBe("#42 Fix CI");
    expect(pullRequestWorktreeSource(42, null).label).toBe("#42");
    expect(issueWorktreeSource({ number: 7, title: "Crash on launch" }).label).toBe(
      "#7 Crash on launch",
    );
    expect(
      workItemWorktreeSource({
        provider: "jira",
        key: "RY-12",
        title: "Goals",
        stateName: "To do",
      }),
    ).toEqual({
      kind: "workItem",
      provider: "jira",
      key: "RY-12",
      title: "Goals",
      stateName: "To do",
      label: "RY-12 Goals",
    });
  });

  it("asks the node for the worktree each source needs", () => {
    expect(worktreeSourceIntent(pullRequestWorktreeSource(42, "Fix CI"))).toEqual({
      kind: "pr",
      number: 42,
    });
    expect(worktreeSourceIntent(issueWorktreeSource({ number: 7, title: "Crash" }))).toEqual({
      kind: "issue",
      number: 7,
      title: "Crash",
    });
    expect(
      worktreeSourceIntent(
        workItemWorktreeSource({
          provider: "jira",
          key: "RY-12",
          title: "Goals",
          url: "https://x",
        }),
      ),
    ).toEqual({
      kind: "workItem",
      provider: "jira",
      key: "RY-12",
      title: "Goals",
      url: "https://x",
    });
  });
});
