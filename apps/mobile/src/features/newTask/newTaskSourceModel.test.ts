import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  branchSourceRows,
  filterSourceRows,
  issueSourceRows,
  pullRequestSourceRows,
  sourceLocationLabel,
  workItemSourceRows,
} from "./newTaskSourceModel";

describe("New Task sources", () => {
  it("lists local branches first, then remote ones no local branch tracks", () => {
    const rows = branchSourceRows([
      { name: "main", current: true, isDefault: true, worktreePath: null },
      { name: "feat/goals", current: false, isDefault: false, worktreePath: null },
      {
        name: "origin/main",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/HEAD",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/fix/ci",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ]);
    expect(rows.map((row) => [row.title, row.detail])).toEqual([
      ["main", "Default branch"],
      ["feat/goals", null],
      ["origin/fix/ci", null],
    ]);
  });

  it("turns pull requests, issues and Jira items into worktree sources", () => {
    const [pull] = pullRequestSourceRows([
      {
        provider: "github",
        number: 42,
        title: "Fix CI",
        url: "https://github.com/o/r/pull/42",
        baseRefName: "main",
        headRefName: "fix/ci",
        state: "open",
        updatedAt: Option.none(),
        isDraft: true,
      },
    ]);
    expect(pull).toMatchObject({
      title: "#42 Fix CI",
      detail: "fix/ci → main · Draft",
      source: { kind: "pr", number: 42, label: "#42 Fix CI" },
    });
    const [issue] = issueSourceRows([
      {
        provider: "github",
        number: 7,
        title: "Crash",
        url: "https://github.com/o/r/issues/7",
        state: "open",
        author: "sam",
        updatedAt: Option.none(),
      },
    ]);
    expect(issue).toMatchObject({ detail: "by sam", source: { kind: "issue", number: 7 } });
    const [item] = workItemSourceRows([
      {
        provider: "jira",
        key: "RY-12",
        title: "Goals",
        url: "https://jira/RY-12",
        state: "open",
        stateName: "To do",
        assignee: null,
        updatedAt: Option.none(),
      },
    ]);
    expect(item).toMatchObject({
      title: "RY-12 Goals",
      detail: "To do",
      source: { kind: "workItem", key: "RY-12", label: "RY-12 Goals" },
    });
    if (item?.kind === "source") {
      expect(sourceLocationLabel(item.source)).toBe("Worktree for RY-12 Goals");
    }
  });

  it("filters rows by every typed word", () => {
    const rows = branchSourceRows([
      { name: "feat/mobile-goals", current: false, isDefault: false, worktreePath: null },
      { name: "fix/mobile-ci", current: false, isDefault: false, worktreePath: null },
    ]);
    expect(filterSourceRows(rows, "mobile goals").map((row) => row.title)).toEqual([
      "feat/mobile-goals",
    ]);
    expect(filterSourceRows(rows, "  ")).toHaveLength(2);
  });
});
