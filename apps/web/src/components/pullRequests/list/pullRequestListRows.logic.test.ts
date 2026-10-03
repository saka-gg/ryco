import type { ChangeRequest, SourceControlCheckRollupItem } from "@ryco/contracts";
import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { describePullRequestReadiness } from "./pullRequestListRows.logic";

function check(name: string, conclusion: string | null): SourceControlCheckRollupItem {
  return {
    kind: "check-run",
    name,
    status: Option.some(conclusion === null ? "in_progress" : "completed"),
    conclusion: conclusion === null ? Option.none() : Option.some(conclusion),
    url: Option.none(),
    startedAt: Option.none(),
    completedAt: Option.none(),
  };
}

function row(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    provider: "github",
    number: 1,
    title: "Change",
    url: "https://github.com/acme/app/pull/1",
    baseRefName: "main",
    headRefName: "feature",
    state: "open",
    updatedAt: Option.none(),
    author: "mvogt",
    mergeability: "mergeable",
    ...overrides,
  };
}

describe("describePullRequestReadiness", () => {
  it("reads ready, green rows as landable", () => {
    expect(
      describePullRequestReadiness(
        row({ reviewDecision: "approved", checkRollup: [check("test", "success")] }),
      ),
    ).toEqual({ label: "Ready to merge", tone: "success", landable: true });
  });

  it("counts failing checks", () => {
    expect(
      describePullRequestReadiness(row({ checkRollup: [check("test", "failure")] })),
    ).toMatchObject({ label: "Check failing", landable: false });
    expect(
      describePullRequestReadiness(
        row({ checkRollup: [check("test", "failure"), check("lint", "failure")] }),
      ).label,
    ).toBe("2 checks failing");
  });

  it("says what is in the way before the merge", () => {
    expect(describePullRequestReadiness(row({ mergeability: "conflicting" }))).toMatchObject({
      label: "Conflicts",
      tone: "danger",
    });
    expect(describePullRequestReadiness(row({ checkRollup: [check("test", null)] }))).toMatchObject(
      { label: "Checks running", tone: "progress" },
    );
    expect(
      describePullRequestReadiness(row({ reviewDecision: "changes_requested" })),
    ).toMatchObject({ label: "Changes requested", tone: "warning" });
    expect(describePullRequestReadiness(row({ reviewDecision: "review_required" }))).toMatchObject({
      label: "Awaiting review",
      tone: "neutral",
    });
  });

  it("asks the author, and only the author, to mark a draft ready", () => {
    const draft = row({ isDraft: true, author: "sak0a" });
    expect(describePullRequestReadiness(draft, { viewerLogin: "SAK0A" }).label).toBe("Mark ready");
    expect(describePullRequestReadiness(draft, { viewerLogin: "mvogt" }).label).toBe("Draft");
    expect(describePullRequestReadiness(draft).label).toBe("Draft");
  });

  it("names finished pull requests", () => {
    expect(describePullRequestReadiness(row({ state: "merged" }))).toEqual({
      label: "Merged",
      tone: "merged",
      landable: false,
    });
    expect(describePullRequestReadiness(row({ state: "closed" })).label).toBe("Closed");
  });
});

describe("describePullRequestReadiness on hosts whose rows carry a merge state", () => {
  it("reads a merge the host refuses as blocked or behind, not ready", () => {
    // GitLab rows: `detailed_merge_status` of need_rebase / discussions_not_resolved.
    expect(describePullRequestReadiness(row({ mergeStateStatus: "behind" }))).toEqual({
      label: "Behind base",
      tone: "warning",
      landable: false,
    });
    expect(describePullRequestReadiness(row({ mergeStateStatus: "blocked" }))).toEqual({
      label: "Blocked",
      tone: "warning",
      landable: false,
    });
    expect(describePullRequestReadiness(row({ mergeStateStatus: "clean" }))).toMatchObject({
      label: "Ready to merge",
      landable: true,
    });
  });
});

describe("describePullRequestReadiness on hosts whose rows carry only blockers", () => {
  const options = { readiness: "blockers" } as const;

  it("names the blockers a row states and never reads ready or landable", () => {
    // Azure / Forgejo rows: no branch policies or reviews, so "nothing blocks" is unknown.
    expect(describePullRequestReadiness(row(), options)).toEqual({
      label: "Open",
      tone: "neutral",
      landable: false,
    });
    expect(
      describePullRequestReadiness(row({ reviewDecision: "approved" }), options),
    ).toMatchObject({ label: "Open", landable: false });
    expect(describePullRequestReadiness(row({ mergeability: "conflicting" }), options).label).toBe(
      "Conflicts",
    );
    expect(
      describePullRequestReadiness(row({ checkRollup: [check("test", "failure")] }), options).label,
    ).toBe("Check failing");
    expect(
      describePullRequestReadiness(row({ reviewDecision: "changes_requested" }), options).label,
    ).toBe("Changes requested");
    expect(
      describePullRequestReadiness(row({ reviewDecision: "review_required" }), options).label,
    ).toBe("Awaiting review");
  });
});

describe("describePullRequestReadiness on hosts without readiness facts", () => {
  it("states only open, draft, merged or closed, and never offers a landable stretch", () => {
    const options = { readiness: "none" } as const;
    // A row the readiness rules would call "Ready to merge" from fields the host never sent.
    expect(describePullRequestReadiness(row(), options)).toEqual({
      label: "Open",
      tone: "neutral",
      landable: false,
    });
    expect(describePullRequestReadiness(row({ isDraft: true }), options).label).toBe("Draft");
    expect(describePullRequestReadiness(row({ state: "merged" }), options)).toMatchObject({
      label: "Merged",
      tone: "merged",
    });
    expect(describePullRequestReadiness(row({ state: "closed" }), options).label).toBe("Closed");
  });
});
