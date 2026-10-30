import type {
  ChangeRequest,
  ChangeRequestReviewThread,
  ChangeRequestTimelineItem,
  SourceControlChangeRequestDetail,
  SourceControlCheckRollupItem,
} from "@ryco/contracts";
import { summarizeChangeRequestChecks } from "@ryco/client-runtime/state/pull-request-review";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import { splitPullRequestPatch } from "./pullRequestDiffModel";
import {
  derivePullRequestCheckSections,
  derivePullRequestConversation,
  derivePullRequestDetailItems,
  derivePullRequestFileRows,
  derivePullRequestHeader,
  describePullRequestNextStep,
  describeTimelineEvent,
  parsePullRequestNumberParam,
} from "./pullRequestDetailModel";

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 1, 10, minute));

function row(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    provider: "github",
    number: 42,
    title: "Show pull requests on the phone",
    url: "https://github.com/acme/app/pull/42",
    baseRefName: "main",
    headRefName: "feature/phone-prs",
    state: "open",
    updatedAt: Option.none(),
    author: "alice",
    ...overrides,
  };
}

function detail(overrides: Partial<SourceControlChangeRequestDetail> = {}) {
  return {
    ...row(),
    body: "Adds the list.",
    comments: [],
    truncated: false,
    ...overrides,
  } as SourceControlChangeRequestDetail;
}

function check(
  name: string,
  status: string,
  conclusion: string | null,
  extra: Partial<SourceControlCheckRollupItem> = {},
): SourceControlCheckRollupItem {
  return {
    kind: "check-run",
    name,
    status: Option.some(status),
    conclusion: conclusion === null ? Option.none() : Option.some(conclusion),
    url: Option.some(`https://ci.example/${name}`),
    startedAt: Option.some(at(0)),
    completedAt: conclusion === null ? Option.none() : Option.some(at(2)),
    ...extra,
  } as SourceControlCheckRollupItem;
}

function thread(overrides: Partial<ChangeRequestReviewThread> = {}): ChangeRequestReviewThread {
  return {
    id: "t1",
    path: "src/list.ts",
    subjectType: "line",
    side: "right",
    line: 12,
    isResolved: false,
    isOutdated: false,
    viewerCanReply: true,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    comments: [
      {
        id: "c1",
        author: { login: "bob" },
        body: "Why not reuse the shared ranking?",
        createdAt: at(5),
      },
    ],
    totalComments: 3,
    ...overrides,
  };
}

describe("derivePullRequestHeader", () => {
  it("paints from the list row, then the detail adds the description", () => {
    const fromRow = derivePullRequestHeader(
      null,
      row({ additions: 12, deletions: 3, changedFiles: 4 }),
    );
    expect(fromRow).toMatchObject({
      number: 42,
      stateLabel: "Open",
      stateTone: "open",
      changeSummary: "+12 −3 · 4 files",
      body: null,
    });
    const fromDetail = derivePullRequestHeader(detail({ isDraft: true }), row());
    expect(fromDetail).toMatchObject({ stateLabel: "Draft", body: "Adds the list." });
    expect(derivePullRequestHeader(detail({ body: "  " }), null)?.body).toBeNull();
    expect(derivePullRequestHeader(null, null)).toBeNull();
    expect(derivePullRequestHeader(null, row({ state: "merged" }))?.stateTone).toBe("merged");
  });

  it("states the next step only while there is one", () => {
    expect(
      describePullRequestNextStep({
        kind: "fix-checks",
        label: "Fix failing checks",
        reason: "CI failed",
        tone: "danger",
        blocking: true,
        viewerCanAct: true,
      }),
    ).toEqual({ label: "Fix failing checks", reason: "CI failed", tone: "danger" });
    expect(
      describePullRequestNextStep({
        kind: "merged",
        label: "Merged",
        tone: "neutral",
        blocking: true,
        viewerCanAct: false,
      }),
    ).toBeNull();
    expect(describePullRequestNextStep(null)).toBeNull();
  });
});

describe("derivePullRequestCheckSections", () => {
  it("groups checks attention first with the shared labels and durations", () => {
    const sections = derivePullRequestCheckSections(
      summarizeChangeRequestChecks([
        check("lint", "COMPLETED", "SUCCESS"),
        check("test", "COMPLETED", "FAILURE", { isRequired: true }),
        check("build", "IN_PROGRESS", null),
      ]),
    );
    expect(sections.map((section) => [section.title, section.rows.map((r) => r.label)])).toEqual([
      ["Needs attention", ["test"]],
      ["Running", ["build"]],
      ["Completed", ["lint"]],
    ]);
    expect(sections[0]?.rows[0]).toMatchObject({
      stateLabel: "Failed",
      overall: "failing",
      duration: "2m",
      required: true,
      url: "https://ci.example/test",
    });
    expect(sections[1]?.rows[0]).toMatchObject({ stateLabel: "Running", duration: null });
  });

  it("has no sections without checks", () => {
    expect(derivePullRequestCheckSections(summarizeChangeRequestChecks([]))).toEqual([]);
  });
});

describe("derivePullRequestConversation", () => {
  const timeline: ReadonlyArray<ChangeRequestTimelineItem> = [
    {
      kind: "commit",
      id: "k1",
      createdAt: at(1),
      actor: { login: "alice" },
      oid: "a".repeat(40),
      shortOid: "aaaaaaa",
      messageHeadline: "Add the list",
      checkState: "failure",
    },
    {
      kind: "commit",
      id: "k2",
      createdAt: at(2),
      actor: { login: "alice" },
      oid: "b".repeat(40),
      shortOid: "bbbbbbb",
      messageHeadline: "Fix lint",
    },
    {
      kind: "labeled",
      id: "l1",
      createdAt: at(3),
      actor: { login: "alice" },
      label: { name: "mobile" },
    },
    {
      kind: "review-requested",
      id: "r1",
      createdAt: at(3),
      actor: { login: "alice" },
      reviewer: "bob",
      reviewerKind: "user",
    },
    {
      kind: "review",
      id: "v1",
      createdAt: at(6),
      actor: { login: "bob" },
      state: "changes_requested",
      body: "",
      threadIds: ["t1"],
    },
    {
      kind: "comment",
      id: "m1",
      createdAt: at(7),
      actor: { login: "alice" },
      body: "Done, thanks!",
    },
    {
      kind: "comment",
      id: "m2",
      createdAt: at(8),
      actor: { login: "spam" },
      body: "hidden",
      isMinimized: true,
    },
    { kind: "closed", id: "e1", createdAt: at(9), actor: { login: "alice" } },
  ];

  it("reads like the web's conversation, as plain rows", () => {
    const { rows, truncated } = derivePullRequestConversation({
      timeline,
      reviewThreads: [thread()],
      timelineTruncated: true,
    });
    expect(truncated).toBe(true);
    expect(rows.map((entry) => [entry.kind, entry.author])).toEqual([
      ["commits", "alice"],
      ["event", "alice"],
      ["review", "bob"],
      ["comment", "alice"],
      ["event", "alice"],
    ]);
    const [commits, events, review, , closed] = rows;
    expect(commits).toMatchObject({ text: "pushed 2 commits" });
    if (commits?.kind === "commits") {
      expect(commits.commits.map((commit) => commit.checks)).toEqual(["failing", null]);
    }
    expect(events).toMatchObject({ text: "added mobile, requested review from @bob" });
    expect(review).toMatchObject({ verdict: "changes-requested", text: "requested changes" });
    if (review?.kind === "review") {
      expect(review.threads[0]).toMatchObject({
        location: "src/list.ts:12",
        moreComments: 2,
        resolved: false,
      });
    }
    expect(closed).toMatchObject({ text: "closed this" });
  });

  it("places a thread no review claims where its first comment was written", () => {
    const { rows } = derivePullRequestConversation({
      timeline: timeline.filter((item) => item.kind !== "review"),
      reviewThreads: [thread({ subjectType: "file" })],
      timelineTruncated: false,
    });
    const index = rows.findIndex((entry) => entry.kind === "thread");
    expect(rows[index - 1]?.kind).toBe("event");
    expect(rows[index]).toMatchObject({ author: "bob" });
    if (rows[index]?.kind === "thread") expect(rows[index].thread.location).toBe("src/list.ts");
  });
});

describe("describeTimelineEvent", () => {
  it("phrases events after the actor's name", () => {
    expect(
      describeTimelineEvent({
        kind: "merged",
        id: "x",
        createdAt: at(0),
        commitOid: "0123456789abcdef",
        baseRefName: "main",
      }),
    ).toBe("merged 0123456 into main");
    expect(
      describeTimelineEvent({
        kind: "force-pushed",
        id: "x",
        createdAt: at(0),
        beforeOid: "1111111aaaa",
        afterOid: "2222222bbbb",
      }),
    ).toBe("force-pushed 1111111 → 2222222");
    expect(
      describeTimelineEvent({
        kind: "base-ref-changed",
        id: "x",
        createdAt: at(0),
        currentRefName: "develop",
      }),
    ).toBe("changed the base to develop");
  });
});

describe("derivePullRequestFileRows", () => {
  it("lists the detail's files in reading order until the diff is parsed", () => {
    const provisional = derivePullRequestFileRows(null, [
      { path: "docs/readme.md", additions: 1, deletions: 0 },
      { path: "src/list.ts", additions: 10, deletions: 2 },
    ]);
    expect(provisional.map((file) => [file.path, file.statusLetter, file.diffStat])).toEqual([
      ["src/list.ts", null, "+10 −2"],
      ["docs/readme.md", null, "+1"],
    ]);
    const parsed = derivePullRequestFileRows(
      splitPullRequestPatch(
        [
          "diff --git a/src/new.ts b/src/new.ts",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/src/new.ts",
          "@@ -0,0 +1 @@",
          "+export {};",
        ].join("\n"),
      ),
      [],
    );
    expect(parsed).toEqual([
      {
        path: "src/new.ts",
        previousPath: null,
        statusLetter: "A",
        status: "added",
        diffStat: "+1",
        binary: false,
      },
    ]);
  });
});

describe("parsePullRequestNumberParam", () => {
  it("accepts only a positive integer", () => {
    expect(parsePullRequestNumberParam("42")).toBe(42);
    expect(parsePullRequestNumberParam(7)).toBe(7);
    expect(parsePullRequestNumberParam(["12"])).toBe(12);
    for (const bad of ["0", "-3", "4.5", "12abc", "", undefined, "1e3"]) {
      expect(parsePullRequestNumberParam(bad)).toBeNull();
    }
  });
});

describe("derivePullRequestDetailItems", () => {
  const base = {
    header: { body: "Adds the list." },
    hostName: "GitHub",
    detail: { files: [{ path: "src/list.ts", additions: 3, deletions: 1 }] },
    activity: null,
    activitySupported: true,
    hostKnown: true,
    checks: summarizeChangeRequestChecks([check("test", "COMPLETED", "FAILURE")]),
    diff: { status: "waiting" as const, error: null, files: null },
  };

  it("puts the description above the conversation and notes a cut timeline", () => {
    const items = derivePullRequestDetailItems({
      ...base,
      tab: "conversation",
      activity: {
        timeline: [{ kind: "closed", id: "e1", createdAt: at(1), actor: { login: "a" } }],
        reviewThreads: [],
        timelineTruncated: true,
      },
    });
    expect(items.map((item) => item.kind)).toEqual(["description", "note", "conversation"]);
    expect(items[1]).toMatchObject({ text: "Older activity is on GitHub." });
  });

  it("says when the host does not share its conversation", () => {
    const items = derivePullRequestDetailItems({
      ...base,
      tab: "conversation",
      header: null,
      activitySupported: false,
    });
    expect(items).toEqual([
      { kind: "note", key: "no-activity", text: "GitHub does not share its conversation here." },
    ]);
    // Until the host is known, nothing is claimed.
    expect(
      derivePullRequestDetailItems({
        ...base,
        tab: "conversation",
        header: null,
        activitySupported: false,
        hostKnown: false,
      }),
    ).toEqual([]);
  });

  it("lists checks under their group titles", () => {
    const items = derivePullRequestDetailItems({ ...base, tab: "checks" });
    expect(items.map((item) => [item.kind, item.key])).toEqual([
      ["section", "section:attention"],
      ["check", "check:\u0000test"],
    ]);
    const none = derivePullRequestDetailItems({
      ...base,
      tab: "checks",
      checks: summarizeChangeRequestChecks([]),
    });
    expect(none).toEqual([{ kind: "note", key: "no-checks", text: "No checks reported" }]);
  });

  it("keeps the detail's files listed when the host refuses the diff", () => {
    const items = derivePullRequestDetailItems({
      ...base,
      tab: "files",
      diff: { status: "oversized", error: "HTTP 406", files: null },
    });
    expect(items.map((item) => item.kind)).toEqual(["note", "file"]);
    expect(items[0]).toMatchObject({ key: "oversized" });
  });
});
