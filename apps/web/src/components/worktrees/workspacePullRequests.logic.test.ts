import type { ChangeRequest, SourceControlChangeRequestStack } from "@ryco/contracts";
import { Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import type { WorktreePullRequestLink } from "@ryco/shared/worktreePullRequests";
import {
  describeOtherPullRequests,
  groupWorkspacePullRequests,
  stackFactsFromDetail,
  rankLinkCandidates,
  resolveDisplayStack,
} from "./workspacePullRequests.logic";

function link(
  number: number,
  state: WorktreePullRequestLink["state"],
  terminalAt: string | null = null,
): WorktreePullRequestLink {
  return {
    number,
    title: `PR ${number}`,
    url: null,
    state,
    isDraft: false,
    terminalAt,
    headRefName: "feature",
    baseRefName: "main",
    source: "created",
    linkedAt: null,
    dismissedAt: null,
  };
}

const stack = {
  number: 14,
  size: 3,
  position: 2,
  baseRefName: "main",
  entries: [681, 682, 683].map((number, index) => ({
    position: index + 1,
    number,
    title: `Layer ${number}`,
    url: `https://github.com/o/r/pull/${number}`,
    headRefName: `layer-${number}`,
    baseRefName: index === 0 ? "main" : `layer-${number - 1}`,
    state: "open" as const,
    isDraft: false,
    mergeability: "mergeable" as const,
  })),
} as unknown as SourceControlChangeRequestStack;

describe("workspace pull request groups", () => {
  it("splits a follow-up from the pull request it replaced", () => {
    const groups = groupWorkspacePullRequests({
      links: [link(677, "open"), link(675, "merged", "2026-10-06T06:51:00.000Z")],
      stack: null,
    });
    expect(groups.open.map((entry) => entry.number)).toEqual([677]);
    expect(groups.earlier.map((entry) => entry.number)).toEqual([675]);
    expect(describeOtherPullRequests({ groups, shownNumber: 677 })).toBe("1 earlier");
    expect(describeOtherPullRequests({ groups, shownNumber: 675 })).toBe("1 more open");
  });

  it("lets the stack own its layers so no number shows twice", () => {
    const groups = groupWorkspacePullRequests({
      links: [link(682, "open"), link(690, "open"), link(660, "merged")],
      stack,
    });
    expect(groups.open.map((entry) => entry.number)).toEqual([690]);
    expect(describeOtherPullRequests({ groups, shownNumber: 682 })).toBe(
      "Stack 2/3 · 1 more open · 1 earlier",
    );
  });

  it("says nothing when the shown pull request is all there is", () => {
    const groups = groupWorkspacePullRequests({ links: [link(675, "merged")], stack: null });
    expect(describeOtherPullRequests({ groups, shownNumber: 675 })).toBeNull();
  });

  it("summarizes a host stack read-only, at the shown layer", () => {
    const facts = stackFactsFromDetail({ stack, incomplete: false, currentNumber: 682 });
    expect(facts.position).toBe("2 of 3");
    expect(facts.canMergeThrough).toBe(false);
    expect(facts.currentNumber).toBe(682);
  });

  it("draws only a host stack of at least two layers", () => {
    expect(resolveDisplayStack({ provider: "github", stack })).toBe(stack);
    expect(resolveDisplayStack({ provider: "gitlab", stack })).toBeNull();
    expect(
      resolveDisplayStack({
        provider: "github",
        stack: { ...stack, entries: stack.entries.slice(0, 1) },
      }),
    ).toBeNull();
    expect(resolveDisplayStack(null)).toBeNull();
  });
});

describe("link candidates", () => {
  const candidate = (
    number: number,
    headRefName: string,
    title = `PR ${number}`,
    baseRefName = "main",
  ) =>
    ({
      provider: "github",
      number,
      title,
      url: `https://github.com/o/r/pull/${number}`,
      baseRefName,
      headRefName,
      state: "open",
      updatedAt: Option.none(),
    }) as unknown as ChangeRequest;

  it("puts the workspace branch first, then newest, without what is already linked", () => {
    const ranked = rankLinkCandidates(
      [
        candidate(700, "other"),
        candidate(677, "feature"),
        candidate(690, "else"),
        candidate(675, "feature"),
      ],
      {
        linkedNumbers: new Set([675]),
        workspaceBranch: "feature",
        linkHeads: new Set(),
        query: "",
      },
    );
    expect(ranked.map((entry) => entry.number)).toEqual([677, 700, 690]);
  });

  it("ranks pull requests stacked on the workspace next", () => {
    const ranked = rankLinkCandidates(
      [
        candidate(720, "other"),
        candidate(710, "layer-2", "Layer 2", "layer-1"),
        candidate(705, "layer-1b", "On the workspace", "feature"),
      ],
      {
        linkedNumbers: new Set(),
        workspaceBranch: "feature",
        linkHeads: new Set(["layer-1"]),
        query: "",
      },
    );
    expect(ranked.map((entry) => entry.number)).toEqual([710, 705, 720]);
  });

  it("filters by number prefix, title, or branch", () => {
    const list = [candidate(677, "projects-map", "Add Projects map"), candidate(690, "x", "Fix")];
    const rank = (query: string) =>
      rankLinkCandidates(list, {
        linkedNumbers: new Set(),
        workspaceBranch: null,
        linkHeads: new Set(),
        query,
      }).map((entry) => entry.number);
    expect(rank("#67")).toEqual([677]);
    expect(rank("map")).toEqual([677]);
    expect(rank("fix")).toEqual([690]);
  });
});
