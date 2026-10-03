import type { SourceControlChangeRequestDetail } from "@ryco/contracts";
import {
  deriveChangeRequestNextAction,
  summarizeChangeRequestChecks,
} from "@ryco/client-runtime/state/pull-request-review";
import { describe, expect, it } from "vitest";

import {
  FIXTURE_688_FAILING_JOB,
  FIXTURE_703_FAILING_JOB,
  FIXTURE_703_THREADS,
  fixtureActivity,
  fixtureDetail,
} from "../testing/pullRequestFixtures";
import {
  checkJobId,
  deriveMergeStatusLines,
  deriveMergeVerdict,
  deriveNextActionButton,
  deriveNextActionMenu,
  isHeadMovedError,
  mergeMethodOptions,
  nextUnresolvedThread,
  resolveMergeMethod,
  sameCommand,
  stackMergeCount,
  type MergeFactsInput,
} from "./mergeFacts.logic";

function factsFor(
  number: number,
  patch: Partial<SourceControlChangeRequestDetail> = {},
): MergeFactsInput {
  const detail = { ...fixtureDetail(number), ...patch };
  const activity = fixtureActivity(number);
  const checks = summarizeChangeRequestChecks(detail.checkRollup);
  return {
    detail,
    viewer: activity.viewer,
    checks,
    nextAction: deriveChangeRequestNextAction(detail, activity, checks),
    threads: activity.reviewThreads,
  };
}

function buttonFor(number: number, patch: Partial<SourceControlChangeRequestDetail> = {}) {
  return deriveNextActionButton({ ...factsFor(number, patch), method: "squash" });
}

describe("deriveMergeVerdict", () => {
  it("names the block and puts it on the author", () => {
    expect(deriveMergeVerdict(factsFor(703))).toEqual({
      text: "Blocked",
      owner: "on you",
      tone: "danger",
      reason: null,
    });
    expect(deriveMergeVerdict(factsFor(688))).toMatchObject({
      text: "Blocked",
      owner: "on @jonasw",
    });
  });

  it("waits on checks, reviewers, or a draft", () => {
    expect(deriveMergeVerdict(factsFor(702))).toMatchObject({
      text: "Waiting",
      owner: "on checks",
      tone: "progress",
    });
    // The viewer is one of the requested reviewers.
    expect(deriveMergeVerdict(factsFor(712))).toMatchObject({ text: "Waiting", owner: "on you" });
    expect(deriveMergeVerdict(factsFor(704))).toMatchObject({ text: "Draft", owner: "on you" });
  });

  it("reads ready, merged, and closed states", () => {
    expect(deriveMergeVerdict(factsFor(701))).toMatchObject({
      text: "Ready to merge",
      owner: "on you",
      tone: "success",
    });
    expect(deriveMergeVerdict(factsFor(690))).toMatchObject({ text: "Merged", tone: "merged" });
    expect(deriveMergeVerdict(factsFor(683))).toMatchObject({ text: "Closed", owner: null });
  });

  it("counts the layers a stack merge lands", () => {
    const facts = factsFor(702, {
      mergeStateStatus: "clean",
      reviewDecision: "approved",
      checkRollup: fixtureDetail(701).checkRollup,
    });
    expect(facts.nextAction.kind).toBe("merge-stack");
    expect(stackMergeCount(facts.detail)).toBe(2);
    expect(deriveMergeVerdict(facts)).toMatchObject({ text: "Lands 2 layers", tone: "success" });
  });
});

describe("deriveMergeStatusLines", () => {
  it("lists what blocks #703, most urgent first, each with its reveal target", () => {
    const lines = deriveMergeStatusLines(factsFor(703));
    expect(lines.map((line) => [line.key, line.tone, line.text, line.meta])).toEqual([
      ["checks", "danger", "Test · web", "8/9"],
      ["reviews", "danger", "Changes requested", "mvogt"],
      ["conversations", "warning", "2 unresolved", null],
      ["branch", "success", "Branch up to date", null],
    ]);
    expect(lines[0]?.target).toEqual({ kind: "job", jobId: FIXTURE_703_FAILING_JOB.jobId });
    expect(lines[0]?.fix).toEqual({ kind: "fix-check", label: "Fix" });
    // Changes requested jumps to the requester's unresolved thread.
    expect(lines[1]?.target).toEqual({ kind: "thread", threadId: FIXTURE_703_THREADS.draftWalk });
    expect(lines[2]?.target).toEqual({ kind: "thread", threadId: FIXTURE_703_THREADS.draftWalk });
  });

  it("reports running checks as settled of total", () => {
    const checks = deriveMergeStatusLines(factsFor(702)).find((line) => line.key === "checks");
    expect(checks).toMatchObject({ tone: "progress", text: "4 checks running", meta: "4/8" });
  });

  it("offers Update on a stale branch and Fix on conflicts", () => {
    const behind = deriveMergeStatusLines(factsFor(697)).find((line) => line.key === "branch");
    expect(behind).toMatchObject({
      tone: "warning",
      text: "Branch out of date",
      fix: { kind: "update-branch", label: "Update" },
    });
    const conflicts = deriveMergeStatusLines(factsFor(694)).find((line) => line.key === "branch");
    expect(conflicts).toMatchObject({
      tone: "danger",
      text: "Merge conflicts",
      fix: { kind: "resolve-conflicts" },
    });
  });

  it("leaves reviews out of a draft and every line out of a closed pull request", () => {
    expect(deriveMergeStatusLines(factsFor(704)).map((line) => line.key)).not.toContain("reviews");
    expect(deriveMergeStatusLines(factsFor(690))).toEqual([]);
  });

  it("does not repeat who it waits on when the verdict already says so", () => {
    const reviews = deriveMergeStatusLines(factsFor(712)).find((line) => line.key === "reviews");
    expect(reviews).toMatchObject({ text: "Review required", meta: null });
  });
});

describe("deriveNextActionButton", () => {
  it("follows the next-action table", () => {
    expect(buttonFor(703)).toMatchObject({
      label: "View failing check",
      variant: "filled",
      command: { type: "reveal-job", jobId: FIXTURE_703_FAILING_JOB.jobId },
    });
    expect(buttonFor(688)).toMatchObject({
      command: { type: "reveal-job", jobId: FIXTURE_688_FAILING_JOB.jobId },
    });
    expect(buttonFor(704)).toMatchObject({
      label: "Mark ready for review",
      command: { type: "set-draft", draft: false },
    });
    expect(buttonFor(697)).toMatchObject({
      label: "Update branch",
      command: { type: "update-branch", method: "merge" },
    });
    expect(buttonFor(694)).toMatchObject({
      label: "Check out to resolve",
      command: { type: "checkout-worktree" },
    });
    expect(buttonFor(702)).toMatchObject({
      label: "Merge when ready",
      variant: "outline",
      command: { type: "enable-auto-merge" },
    });
    expect(buttonFor(692)).toMatchObject({
      label: "Cancel auto-merge",
      variant: "outline",
    });
    expect(buttonFor(701)).toMatchObject({
      label: "Squash and merge",
      variant: "filled",
      command: { type: "merge" },
      disabledReason: null,
    });
    expect(buttonFor(683)).toMatchObject({ label: "Reopen", variant: "outline" });
  });

  it("starts a review for a requested reviewer, requests one for the author", () => {
    expect(buttonFor(712)).toMatchObject({
      label: "Start review",
      variant: "filled",
      command: { type: "open-files" },
    });
  });

  it("uses the merge method's wording", () => {
    expect(deriveNextActionButton({ ...factsFor(701), method: "rebase" })?.label).toBe(
      "Rebase and merge",
    );
  });

  it("offers nothing after a merge the host already cleaned up", () => {
    expect(buttonFor(690)).toBeNull();
    expect(buttonFor(690, { deleteBranchOnMerge: false })).toMatchObject({
      label: "Delete branch",
      command: { type: "delete-branch" },
    });
  });
});

describe("deriveNextActionMenu", () => {
  const menuFor = (number: number, patch: Partial<SourceControlChangeRequestDetail> = {}) => {
    const facts = factsFor(number, patch);
    const button = deriveNextActionButton({ ...facts, method: "squash" });
    return {
      button,
      menu: deriveNextActionMenu({
        ...facts,
        button,
        method: "squash",
        supportsMutations: true,
        agentsAvailable: true,
      }),
    };
  };

  it("never repeats the button's action", () => {
    for (const number of [701, 702, 703, 704, 697, 694, 692]) {
      const { button, menu } = menuFor(number);
      if (!button) continue;
      expect(menu.items.some((item) => sameCommand(item.command, button.command))).toBe(false);
    }
  });

  it("lists method, delete-branch, stack and lifecycle steps for #701", () => {
    const { menu } = menuFor(701);
    expect(menu.methods?.map((option) => [option.method, option.disabledReason])).toEqual([
      ["squash", null],
      ["merge", "Not allowed in this repository"],
      ["rebase", null],
    ]);
    expect(menu.deleteBranchDefault).toBe(true);
    expect(menu.items.map((item) => item.label)).toEqual([
      "Merge stack through…",
      "Convert to draft",
      "Close pull request",
    ]);
    expect(menu.items.at(-1)?.destructive).toBe(true);
  });

  it("offers both update methods minus the one on the button", () => {
    const { menu } = menuFor(697);
    expect(menu.items.map((item) => item.label)).toContain("Update with rebase");
    expect(menu.items.map((item) => item.label)).not.toContain("Update branch");
  });

  it("hands conflicts to an agent from the menu", () => {
    expect(menuFor(694).menu.items[0]?.command).toEqual({ type: "resolve-with-agent" });
  });

  it("is empty for closed and merged pull requests, and on hosts without mutations", () => {
    expect(menuFor(690).menu).toEqual({ methods: null, deleteBranchDefault: null, items: [] });
    const facts = factsFor(701);
    expect(
      deriveNextActionMenu({
        ...facts,
        button: null,
        method: "squash",
        supportsMutations: false,
        agentsAvailable: false,
      }).items,
    ).toEqual([]);
  });
});

describe("merging past a step the host does not require", () => {
  const menuFor = (facts: MergeFactsInput) => {
    const button = deriveNextActionButton({ ...facts, method: "squash" });
    return deriveNextActionMenu({
      ...facts,
      button,
      method: "squash",
      supportsMutations: true,
      agentsAvailable: true,
    });
  };

  it("lands a stack layer through its stack while optional checks still run", () => {
    // #702 sits on #701, which is still open: merging #702 lands both.
    const facts = factsFor(702, { mergeStateStatus: "unstable", reviewDecision: "approved" });
    expect(facts.nextAction).toMatchObject({ kind: "checks-running", blocking: false });
    expect(deriveNextActionButton({ ...facts, method: "squash" })).toEqual({
      label: "Merge stack (2)",
      variant: "filled",
      command: { type: "merge-stack" },
      disabledReason: null,
    });
  });

  it("holds that stack merge while a lower layer cannot land", () => {
    const stack = fixtureDetail(702).stack!;
    const draftBase = { ...stack.entries.find((entry) => entry.number === 701)!, isDraft: true };
    const facts = factsFor(702, {
      mergeStateStatus: "unstable",
      reviewDecision: "approved",
      stack: {
        ...stack,
        entries: stack.entries.map((entry) => (entry.number === 701 ? draftBase : entry)),
      },
    });
    expect(deriveNextActionButton({ ...facts, method: "squash" })).toMatchObject({
      command: { type: "merge-stack" },
      disabledReason: "#701 below is still a draft.",
    });
  });

  it("keeps a lone pull request's merge on the button while optional checks run", () => {
    const facts = factsFor(713, { mergeStateStatus: "unstable" });
    expect(facts.nextAction).toMatchObject({ kind: "checks-running", blocking: false });
    expect(deriveNextActionButton({ ...facts, method: "squash" })).toMatchObject({
      label: "Squash and merge",
      command: { type: "merge" },
      disabledReason: null,
    });
  });

  it("offers the merge from the menu when only optional checks fail", () => {
    const facts = factsFor(688, { mergeStateStatus: "unstable" });
    expect(deriveMergeVerdict(facts)).toMatchObject({ text: "Ready to merge", owner: "on you" });
    expect(deriveNextActionButton({ ...facts, method: "squash" })?.command.type).toBe("reveal-job");
    expect(menuFor(facts).items[0]).toEqual({
      command: { type: "merge" },
      label: "Squash and merge",
      hint: "The failing checks are not required",
      destructive: false,
    });
  });

  it("offers the merge from the menu when the host does not require the review", () => {
    const facts = factsFor(712, { mergeStateStatus: "clean" });
    expect(facts.nextAction).toMatchObject({ kind: "awaiting-review", blocking: false });
    expect(menuFor(facts).items.find((item) => item.command.type === "merge")).toMatchObject({
      label: "Squash and merge",
      hint: "No approving review is required",
    });
  });

  it("offers no merge the host would refuse, and leaves a stack merge to its picker", () => {
    expect(menuFor(factsFor(703)).items.some((item) => item.command.type === "merge")).toBe(false);
    // #703 would land #701 and #702 too: only "Merge stack through…" names that.
    const items = menuFor(factsFor(703, { mergeStateStatus: "unstable" })).items;
    expect(items.some((item) => item.command.type === "merge")).toBe(false);
    expect(items.some((item) => item.command.type === "merge-stack")).toBe(true);
  });
});

describe("merge method helpers", () => {
  it("falls back to the first allowed method", () => {
    const detail = fixtureDetail(701);
    expect(mergeMethodOptions(detail).find((option) => option.method === "merge")).toMatchObject({
      disabledReason: "Not allowed in this repository",
    });
    expect(resolveMergeMethod(detail, "merge")).toBe("squash");
    expect(resolveMergeMethod(detail, "rebase")).toBe("rebase");
    expect(resolveMergeMethod(detail, null)).toBe("squash");
  });

  it("reads job ids from Actions URLs only", () => {
    expect(
      checkJobId({ kind: "check-run", url: "https://github.com/o/r/actions/runs/12/job/34" }),
    ).toBe("34");
    expect(checkJobId({ kind: "status-context", url: "https://ci.example/34" })).toBeNull();
    expect(checkJobId({ kind: "check-run", url: null })).toBeNull();
  });

  it("recognizes a merge refused because the head moved", () => {
    expect(
      isHeadMovedError(new Error("Head branch was modified. Review and try the merge again.")),
    ).toBe(true);
    expect(isHeadMovedError(new Error("Pull request head changed since it was loaded"))).toBe(true);
    expect(isHeadMovedError(new Error("Required status check is failing"))).toBe(false);
  });

  it("prefers the named authors' unresolved thread", () => {
    const threads = fixtureActivity(703).reviewThreads;
    expect(nextUnresolvedThread(threads, ["eliotm"])?.id).toBe(FIXTURE_703_THREADS.ariaCurrent);
    expect(nextUnresolvedThread(threads)?.id).toBe(FIXTURE_703_THREADS.draftWalk);
    expect(nextUnresolvedThread([])).toBeNull();
  });
});
