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
  extra: Pick<PullRequestsNavigationDeps, "onRevealJob"> = {},
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
