import {
  PROVIDER_SEND_TURN_MAX_SOURCE_CONTROL_CONTEXTS,
  type LocalTaskLink,
  type SourceControlChangeRequestDetail,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  changeRequestRepositoryKey,
  localRefNames,
  projectRepositoryKey,
  taskDraftPlacement,
  taskSourceControlContext,
  taskSourceControlLinks,
  taskStartHint,
  taskWorktreeBranch,
  type TaskDraftPlacementInput,
} from "./taskDraft.logic";

const TITLE = "Fix the login redirect loop on hosted Hub";

const pr = (
  number: number,
  extra: Partial<{ url: string; title: string }> = {},
): LocalTaskLink => ({
  kind: "pr",
  number,
  ...extra,
});
const issue = (
  number: number,
  extra: Partial<{ url: string; title: string }> = {},
): LocalTaskLink => ({
  kind: "issue",
  number,
  ...extra,
});
const branch = (name: string): LocalTaskLink => ({ kind: "branch", name });
const jira = (key: string, title?: string): LocalTaskLink => ({
  kind: "workItem",
  provider: "jira",
  key,
  url: `https://acme.atlassian.net/browse/${key}`,
  ...(title ? { title } : {}),
});

const REPOSITORY = projectRepositoryKey({
  canonicalKey: "github.com/saka-gg/ryco",
  locator: {
    source: "git-remote",
    remoteName: "upstream",
    remoteUrl: "git@github.com:saka-gg/ryco.git",
  },
  remotes: [{ name: "origin", url: "https://github.com/me/ryco.git" }],
});

function place(
  links: ReadonlyArray<LocalTaskLink>,
  overrides: Partial<TaskDraftPlacementInput> = {},
) {
  return taskDraftPlacement({
    title: TITLE,
    links,
    projectRepository: REPOSITORY,
    startBranches: [],
    sourceWorktrees: true,
    ...overrides,
  });
}

describe("taskDraftPlacement", () => {
  it("opens a new task branch from the default branch when nothing is linked", () => {
    expect(place([])).toEqual({
      worktreeSource: null,
      baseBranch: null,
      worktreeBranchName: "task/fix-login-redirect-loop",
      fetchOrigin: true,
    });
  });

  it("prefers the project's pull request, then a branch, an issue, a Jira item", () => {
    const links = [jira("OPS-1"), issue(3), branch("feature/x"), pr(746, { title: "Fix login" })];
    expect(place(links)).toEqual({
      worktreeSource: { kind: "pr", number: 746, label: "#746 Fix login" },
      baseBranch: null,
      worktreeBranchName: null,
      fetchOrigin: true,
    });
    // A linked branch is taken as it is in the checkout, not as the origin has it.
    expect(place(links.slice(0, 3))).toEqual({
      worktreeSource: null,
      baseBranch: "feature/x",
      worktreeBranchName: "task/fix-login-redirect-loop",
      fetchOrigin: false,
    });
    // An issue (or Jira item) names its worktree's branch after its title, the task's without one.
    expect(place(links.slice(0, 2)).worktreeSource).toEqual({
      kind: "workItem",
      provider: "jira",
      key: "OPS-1",
      title: TITLE,
      url: "https://acme.atlassian.net/browse/OPS-1",
      label: `OPS-1 ${TITLE}`,
    });
    expect(place([issue(3, { title: "Crash on start" }), jira("OPS-1")]).worktreeSource).toEqual({
      kind: "issue",
      number: 3,
      title: "Crash on start",
      label: "#3 Crash on start",
    });
  });

  it("only takes the project's own pull requests and issues", () => {
    const placement = place([
      pr(1234, { url: "https://github.com/vercel/next.js/pull/1234" }),
      // A fork's #9 is not the #9 the checkout resolves.
      issue(9, { url: "https://github.com/me/ryco/issues/9" }),
      pr(746, { url: "https://github.com/Saka-GG/ryco/pull/746/files" }),
    ]);
    expect(placement.worktreeSource).toMatchObject({ kind: "pr", number: 746 });
    // Without the project's repository known, a URL can't be told apart.
    expect(
      place([pr(746, { url: "https://github.com/saka-gg/ryco/pull/746" })], {
        projectRepository: null,
      }).worktreeSource,
    ).toBeNull();
    expect(changeRequestRepositoryKey("https://gitlab.com/a/b/c/-/merge_requests/3")).toBe(
      "gitlab.com/a/b/c",
    );
    expect(changeRequestRepositoryKey("https://example.com/spec")).toBeNull();
  });

  it("keeps to branches when the node can't create a worktree for an item", () => {
    expect(place([pr(746), issue(3)], { sourceWorktrees: false })).toEqual({
      worktreeSource: null,
      baseBranch: null,
      worktreeBranchName: "task/fix-login-redirect-loop",
      fetchOrigin: true,
    });
  });

  it("numbers the branch once the task has a worktree chat", () => {
    expect(place([], { startBranches: ["task/fix-login-redirect-loop"] }).worktreeBranchName).toBe(
      "task/fix-login-redirect-loop-2",
    );
  });
});

describe("taskStartHint", () => {
  it("names where the draft's worktree comes from", () => {
    expect(taskStartHint(place([]))).toEqual({
      prefix: "a new worktree",
      ref: "task/fix-login-redirect-loop",
    });
    expect(taskStartHint(place([branch("feature/x")]))).toEqual({
      prefix: "a worktree from feature/x",
      ref: "task/fix-login-redirect-loop",
    });
    expect(taskStartHint(place([pr(746)]))).toEqual({
      prefix: "the PR #746 worktree",
      ref: null,
    });
    expect(taskStartHint(place([issue(3)])).prefix).toBe("a worktree for #3");
    expect(taskStartHint(place([jira("OPS-1")])).prefix).toBe("a worktree for OPS-1");
  });
});

describe("taskWorktreeBranch", () => {
  it("moves past branches that exist and ones the task already asked for", () => {
    expect(
      taskWorktreeBranch({
        title: TITLE,
        startBranches: [],
        existingRefNames: ["task/fix-login-redirect-loop"],
      }),
    ).toBe("task/fix-login-redirect-loop-2");
    expect(
      taskWorktreeBranch({
        title: TITLE,
        startBranches: ["task/fix-login-redirect-loop"],
        existingRefNames: ["task/fix-login-redirect-loop-2"],
      }),
    ).toBe("task/fix-login-redirect-loop-3");
  });

  it("reads remote refs as their local names", () => {
    expect(
      localRefNames([
        { name: "main" },
        { name: "origin/task/x", isRemote: true, remoteName: "origin" },
        { name: "upstream/task/y", isRemote: true, remoteName: "upstream" },
      ]),
    ).toEqual(["main", "task/x", "task/y"]);
  });
});

describe("source control contexts", () => {
  it("attaches each linked pull request and issue once, up to the message's limit", () => {
    const links = [
      pr(1),
      issue(1),
      pr(1),
      branch("x"),
      ...Array.from({ length: 12 }, (_, i) => issue(i + 10)),
    ];
    const picked = taskSourceControlLinks(links, REPOSITORY);
    expect(picked.slice(0, 3)).toEqual([
      { kind: "change-request", number: 1, reference: "1" },
      { kind: "issue", number: 1, reference: "1" },
      { kind: "issue", number: 10, reference: "10" },
    ]);
    expect(picked).toHaveLength(PROVIDER_SEND_TURN_MAX_SOURCE_CONTROL_CONTEXTS);
  });

  it("attaches only the project's own items, read by URL when linked by one", () => {
    const own = "https://github.com/saka-gg/ryco/pull/746";
    const other = "https://github.com/vercel/next.js/pull/1234";
    expect(
      taskSourceControlLinks(
        [
          { kind: "pr", number: 1234, url: other },
          { kind: "pr", number: 746, url: own },
          { kind: "issue", number: 9, url: "https://github.com/me/ryco/issues/9" },
        ],
        REPOSITORY,
      ),
    ).toEqual([{ kind: "change-request", number: 746, reference: own }]);
    // Without the project's repository known, only items linked by number are its own.
    expect(taskSourceControlLinks([pr(5), pr(746, { url: own })], null)).toEqual([
      { kind: "change-request", number: 5, reference: "5" },
    ]);
  });

  it("builds the context the composer would attach", () => {
    const detail = { provider: "github", number: 746 } as SourceControlChangeRequestDetail;
    const context = taskSourceControlContext({
      id: "ctx-1",
      kind: "change-request",
      detail,
      nowMs: Date.UTC(2026, 9, 18),
    });
    expect(context).toMatchObject({
      id: "ctx-1",
      kind: "change-request",
      provider: "github",
      reference: "github#746",
      detail,
    });
    expect(context.staleAfter.epochMilliseconds - context.fetchedAt.epochMilliseconds).toBe(
      5 * 60 * 1000,
    );
  });
});
