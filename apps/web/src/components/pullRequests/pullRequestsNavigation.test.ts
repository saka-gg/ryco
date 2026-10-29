import type { SourceControlChangeRequestStack } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import type { PullRequestSelectionMotion } from "./PullRequestsPageContext";
import {
  createPullRequestsNavigation,
  derivePullRequestSelectionMotion,
  type PullRequestsNavigationDeps,
} from "./pullRequestsNavigation";
import type { PullRequestsSearch } from "./pullRequestsSearch";

const stack = {
  number: 14,
  size: 3,
  position: 2,
  baseRefName: "main",
  entries: [
    { number: 701, position: 1 },
    { number: 703, position: 2 },
    { number: 704, position: 3 },
  ],
} as unknown as SourceControlChangeRequestStack;

function modelWith(selected: number | null) {
  return {
    list: { ordered: [{ number: 704 }, { number: 703 }, { number: 701 }] },
    selection:
      selected === null
        ? null
        : {
            number: selected,
            summary: { title: `Layer ${selected}` },
            detail: { data: { title: `Layer ${selected}`, stack } },
            activity: { data: null },
            threads: { anchoredByPath: new Map() },
          },
  } as unknown as ReturnType<PullRequestsNavigationDeps["getModel"]>;
}

function harness(
  initial: PullRequestsSearch,
  extra: Pick<
    PullRequestsNavigationDeps,
    "onRevealJob" | "getCrossRepositoryRows" | "rememberScope" | "openExternal"
  > = {},
) {
  let search = initial;
  const commits: Array<{ next: PullRequestsSearch; push: boolean; types?: unknown }> = [];
  const motions: PullRequestSelectionMotion[] = [];
  let drawerClosed = 0;
  const nav = createPullRequestsNavigation({
    ...extra,
    getSearch: () => search,
    getModel: () => modelWith(search.pr ?? null),
    getRepositoryParams: () => ({ env: "env", project: "project" }),
    commit: (next, options) => {
      search = next;
      commits.push({ next, push: options.push, types: options.viewTransitionTypes });
    },
    setSelectionMotion: (motion) => motions.push(motion),
    closeDrawer: () => {
      drawerClosed += 1;
    },
    canRunPushTransition: () => true,
    now: () => 1,
  });
  return {
    nav,
    commits,
    motions,
    get search() {
      return search;
    },
    get drawerClosed() {
      return drawerClosed;
    },
  };
}

describe("createPullRequestsNavigation", () => {
  it("counts every job reveal before replacing, even a repeat of the job in the URL", () => {
    const order: string[] = [];
    const page = harness(
      { pr: 703, tab: "files", file: "a.ts" },
      { onRevealJob: () => order.push(`reveal:${page.commits.length}`) },
    );
    page.nav.revealJob("52004433871");
    expect(page.search).toEqual({ pr: 703, tab: "checks", file: "a.ts", job: "52004433871" });
    page.nav.revealJob("52004433871");
    // The URL does not change on the repeat; the count is what lands it again.
    expect(page.search).toEqual({ pr: 703, tab: "checks", file: "a.ts", job: "52004433871" });
    expect(order).toEqual(["reveal:0", "reveal:1"]);
    expect(page.commits.map((commit) => commit.push)).toEqual([false, false]);
  });

  it("reveals a job without a reveal counter", () => {
    const page = harness({ pr: 703 });
    page.nav.revealJob("CI/lint");
    expect(page.search).toEqual({ pr: 703, tab: "checks", job: "CI/lint" });
  });

  it("reveals a file in the whole change request, clearing a commit scope", () => {
    const page = harness({ pr: 703, tab: "files", commit: "abc1234", thread: "t1" });
    page.nav.revealFile("apps/web/src/a.ts", 12, "right");
    expect(page.search).toEqual({
      pr: 703,
      tab: "files",
      file: "apps/web/src/a.ts",
      line: 12,
      side: "right",
      thread: undefined,
      commit: undefined,
    });
    expect(page.commits.at(-1)?.push).toBe(false);
  });

  it("closes the drawer even when the chosen row is already open", () => {
    const page = harness({ pr: 703 });
    page.nav.selectPullRequest(703, { push: true, via: "list" });
    expect(page.drawerClosed).toBe(1);
    // Nothing else changes: no navigation, no motion.
    expect(page.commits).toEqual([]);
    expect(page.motions).toEqual([]);
  });

  it("pushes stack layers off Files and rolls from the layer that was left", () => {
    const page = harness({ pr: 703, tab: "checks" });
    page.nav.stepStackLayer(1);
    expect(page.motions.at(-1)).toEqual({
      kind: "push",
      direction: 1,
      token: 1,
      from: { number: 703, title: "Layer 703" },
    });
    expect(page.commits.at(-1)?.types).toEqual(["pr-push-up"]);
    expect(page.search).toMatchObject({ pr: 704, tab: "checks", env: "env", project: "project" });
  });

  it("settles stack layers on Files instead of ghosting the diff", () => {
    const page = harness({ pr: 703, tab: "files" });
    page.nav.stepStackLayer(-1);
    expect(page.motions.at(-1)?.kind).toBe("settle");
    expect(page.commits.at(-1)?.types).toBeUndefined();
    expect(page.search).toMatchObject({ pr: 701, tab: "files" });
  });
});

describe("derivePullRequestSelectionMotion", () => {
  it("settles in list order for list moves", () => {
    expect(
      derivePullRequestSelectionMotion({
        current: { pr: 704 },
        pr: 701,
        via: "list",
        model: modelWith(704),
        token: 7,
      }),
    ).toEqual({ kind: "settle", direction: 1, token: 7 });
  });
});

describe("All repositories navigation", () => {
  const checkout = (environmentId: string, projectId: string) => ({ environmentId, projectId });
  const rows = [
    {
      rowKey: "github.com/acme/app#12",
      number: 12,
      url: "https://github.com/acme/app/pull/12",
      checkout: checkout("env-a", "app"),
    },
    {
      rowKey: "github.com/acme/api#3",
      number: 3,
      url: "https://github.com/acme/api/pull/3",
      checkout: checkout("env-b", "api"),
    },
    {
      rowKey: "github.com/other/x#9",
      number: 9,
      url: "https://github.com/other/x/pull/9",
      checkout: null,
    },
  ];
  function crossHarness(initial: PullRequestsSearch) {
    const scopes: Array<"all" | null> = [];
    const opened: string[] = [];
    let page: ReturnType<typeof harness>;
    const selectedKey = () => {
      const search = page.search;
      const row = rows.find(
        (entry) =>
          entry.checkout !== null &&
          entry.checkout.environmentId === search.env &&
          entry.checkout.projectId === search.project &&
          entry.number === search.pr,
      );
      return row?.rowKey ?? null;
    };
    page = harness(initial, {
      getCrossRepositoryRows: () =>
        ({
          ordered: rows.slice(0, 2),
          byKey: new Map(rows.map((row) => [row.rowKey, row])),
          selectedKey: selectedKey(),
        }) as unknown as ReturnType<
          NonNullable<PullRequestsNavigationDeps["getCrossRepositoryRows"]>
        >,
      rememberScope: (scope) => scopes.push(scope),
      openExternal: (url) => opened.push(url),
    });
    return { page, scopes, opened };
  }

  it("shows All repositories without one repository's or pull request's params", () => {
    const { page, scopes } = crossHarness({
      env: "env",
      project: "project",
      pr: 4,
      tab: "files",
      file: "a.ts",
      thread: "t",
      q: "fix",
      state: "merged",
      only: "review",
      sort: "updated",
    });
    page.nav.showAllRepositories();
    expect(page.search).toEqual({ scope: "all", state: "merged", only: "review", sort: "updated" });
    expect(page.commits.at(-1)?.push).toBe(true);
    expect(scopes).toEqual(["all"]);
  });

  it("selects a row through its checkout and stays in All repositories", () => {
    const { page } = crossHarness({ scope: "all", tab: "checks" });
    page.nav.selectCrossRepositoryRow("github.com/acme/api#3", { push: true, via: "list" });
    expect(page.search).toEqual({
      scope: "all",
      env: "env-b",
      project: "api",
      pr: 3,
      tab: "checks",
    });
    expect(page.commits.at(-1)?.push).toBe(true);
  });

  it("keeps the search for a list selection and drops it with a link's, in one navigation", () => {
    const { page } = crossHarness({ scope: "all", q: "fix" });
    page.nav.selectCrossRepositoryRow("github.com/acme/app#12", { via: "list" });
    expect(page.search).toMatchObject({ q: "fix", pr: 12 });
    page.nav.selectCrossRepositoryRow("github.com/acme/api#3", { push: true, via: "link" });
    expect(page.commits).toHaveLength(2);
    expect(page.search.q).toBeUndefined();
    expect(page.search).toMatchObject({ scope: "all", env: "env-b", project: "api", pr: 3 });
  });

  it("opens a row whose repository is not in Ryco on its host", () => {
    const { page, opened } = crossHarness({ scope: "all" });
    page.nav.selectCrossRepositoryRow("github.com/other/x#9");
    expect(opened).toEqual(["https://github.com/other/x/pull/9"]);
    expect(page.commits).toEqual([]);
  });

  it("moves J/K across repositories in list order", () => {
    const { page } = crossHarness({ scope: "all" });
    page.nav.stepPullRequest(1);
    expect(page.search).toMatchObject({ env: "env-a", project: "app", pr: 12 });
    page.nav.stepPullRequest(1);
    expect(page.search).toMatchObject({ scope: "all", env: "env-b", project: "api", pr: 3 });
    expect(page.motions.at(-1)).toEqual({ kind: "settle", direction: 1, token: 1 });
    page.nav.stepPullRequest(1);
    expect(page.commits).toHaveLength(2);
  });

  it("leaves All repositories when a repository is chosen", () => {
    const { page, scopes } = crossHarness({ scope: "all", env: "env-a", project: "app", pr: 12 });
    page.nav.selectRepository({ environmentId: "env-b", projectId: "api" } as never);
    expect(page.search).toEqual({ env: "env-b", project: "api" });
    expect(scopes).toEqual([null]);
  });
});
