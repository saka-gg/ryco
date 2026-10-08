import { assert, describe, it } from "vite-plus/test";

import {
  buildCheckRingSegments,
  buildCrownRailSummary,
  countCrownChecks,
  crownRailItemDescription,
  resolveCrownHeadline,
} from "./crownModel.logic";
import { CROWN_RAIL_ITEMS, visibleCrownRailItems } from "./crownSections";
import {
  makeChanges,
  makeCheckStatus,
  makeLayout,
  makePlan,
  makePullRequest,
  makeRun,
  makeSubagent,
} from "./crownTestFixtures";

const GIT = { isGitRepo: true };

describe("buildCheckRingSegments", () => {
  it("returns no segments without runs", () => {
    assert.deepEqual(buildCheckRingSegments([]), []);
  });

  it("follows the prototype segRing maths", () => {
    const runs = [makeRun("a", "success"), makeRun("b", "failure"), makeRun("c", "running")];
    const segments = buildCheckRingSegments(runs, { gapPct: 7 });
    const slot = 100 / 3;
    assert.deepEqual(
      segments.map((s) => s.key),
      ["run:a", "run:b", "run:c"],
    );
    assert.deepEqual(
      segments.map((s) => s.state),
      ["pass", "fail", "running"],
    );
    segments.forEach((segment, i) => {
      assert.closeTo(segment.len, slot - 7, 1e-9);
      assert.closeTo(segment.offset, -(i * slot + 3.5), 1e-9);
    });
  });

  it("draws one full-length arc minus the gap for a single run", () => {
    const [only] = buildCheckRingSegments([makeRun("a", "success")], { gapPct: 9 });
    assert.equal(only?.len, 91);
    assert.equal(only?.offset, -4.5);
  });

  it("maps tones to ring states", () => {
    const tones = [
      "success",
      "failure",
      "error",
      "running",
      "pending",
      "cancelled",
      "neutral",
    ] as const;
    const states = buildCheckRingSegments(tones.map((tone) => makeRun(tone, tone))).map(
      (s) => s.state,
    );
    assert.deepEqual(states, ["pass", "fail", "fail", "running", "queued", "queued", "queued"]);
  });

  it("keeps a minimum length when the slot is smaller than the gap", () => {
    const runs = Array.from({ length: 20 }, (_, i) => makeRun(`r${i}`, "success"));
    for (const segment of buildCheckRingSegments(runs, { gapPct: 9 })) {
      assert.equal(segment.len, 0.6);
    }
  });

  it("collapses above maxSegments into one arc per state in a stable order", () => {
    const runs = [
      ...Array.from({ length: 3 }, (_, i) => makeRun(`p${i}`, "success")),
      makeRun("q", "pending"),
      ...Array.from({ length: 2 }, (_, i) => makeRun(`f${i}`, "failure")),
    ];
    const segments = buildCheckRingSegments(runs, { gapPct: 2, maxSegments: 4 });
    assert.deepEqual(
      segments.map((s) => [s.key, s.state]),
      [
        ["group:fail", "fail"],
        ["group:queued", "queued"],
        ["group:pass", "pass"],
      ],
    );
    // fail = 2/6, queued = 1/6, pass = 3/6 of the ring.
    assert.closeTo(segments[0]!.len, 100 / 3 - 2, 1e-9);
    assert.closeTo(segments[1]!.offset, -(100 / 3 + 1), 1e-9);
    assert.closeTo(segments[2]!.len, 50 - 2, 1e-9);
    assert.closeTo(segments[2]!.offset, -(100 / 2 + 1), 1e-9);
  });

  it("collapses past the default of 24 runs", () => {
    const runs = Array.from({ length: 25 }, (_, i) => makeRun(`r${i}`, "success"));
    assert.deepEqual(
      buildCheckRingSegments(runs).map((s) => s.key),
      ["group:pass"],
    );
  });
});

describe("countCrownChecks", () => {
  it("treats skipped and cancelled runs as neither failing nor in progress", () => {
    const counts = countCrownChecks(
      makePullRequest({
        latestRuns: [makeRun("a", "success"), makeRun("b", "neutral"), makeRun("c", "cancelled")],
      }),
    );
    assert.equal(counts.ci, "pass");
    assert.equal(counts.passed, 1);
    assert.equal(counts.total, 3);
  });

  it("falls back to the rollup status without run rows", () => {
    const failed = countCrownChecks(
      makePullRequest({ checkStatus: makeCheckStatus("failed", { failed: ["lint"] }) }),
    );
    assert.equal(failed.ci, "fail");
    assert.equal(failed.failed, 1);
    assert.deepEqual(failed.failedNames, ["lint"]);
    assert.equal(
      countCrownChecks(makePullRequest({ checkStatus: makeCheckStatus("pending") })).ci,
      "running",
    );
    assert.equal(countCrownChecks(null).ci, "none");
  });
});

describe("buildCrownRailSummary", () => {
  it("summarises every rail icon", () => {
    const summary = buildCrownRailSummary(
      makeLayout({
        changes: makeChanges({
          aheadCount: 3,
          files: [
            { path: "a.ts", insertions: 1, deletions: 0 },
            { path: "b.ts", insertions: 2, deletions: 1 },
          ],
        }),
        pullRequest: makePullRequest({
          isDraft: true,
          hasMergeConflicts: true,
          latestRuns: [makeRun("a", "success"), makeRun("b", "running")],
        }),
        activePlan: makePlan([
          ["One", "completed"],
          ["Two", "inProgress"],
          ["Three", "pending"],
          ["Four", "pending"],
        ]),
        subagents: [makeSubagent("x", "running"), makeSubagent("y", "finished")],
      }),
      { isGitRepo: true, notesCount: 2 },
    );
    assert.equal(summary.branch.badge, "↑3");
    assert.equal(summary.changes.count, 2);
    assert.equal(summary.checks.ci, "running");
    assert.equal(summary.checks.passed, 1);
    assert.equal(summary.checks.total, 2);
    assert.equal(summary.checks.segments.length, 2);
    assert.deepEqual(summary.plan, {
      pct: 25,
      done: 1,
      total: 4,
      active: true,
      stepLabel: "Two",
    });
    assert.deepEqual(summary.agents, { count: 2, live: 1 });
    assert.deepEqual(summary.pr, { state: "draft", conflict: true });
    assert.deepEqual(summary.notes, { count: 2 });
    assert.deepEqual(summary.ship, { count: 3, ready: true });
  });

  it("reports an empty thread", () => {
    const summary = buildCrownRailSummary(makeLayout(), GIT);
    assert.equal(summary.branch.badge, "");
    assert.equal(summary.checks.ci, "none");
    assert.deepEqual(summary.plan, { pct: 0, done: 0, total: 0, active: false, stepLabel: null });
    assert.equal(summary.pr.state, null);
    assert.deepEqual(summary.ship, { count: 0, ready: false });
  });

  it("ships a never-pushed branch's commits ahead of the default branch", () => {
    const neverPushed = buildCrownRailSummary(
      makeLayout({ changes: makeChanges({ hasUpstream: false, aheadOfDefaultCount: 4 }) }),
      GIT,
    );
    assert.deepEqual(neverPushed.ship, { count: 4, ready: true });
    const tracked = buildCrownRailSummary(
      makeLayout({ changes: makeChanges({ hasUpstream: true, aheadOfDefaultCount: 4 }) }),
      GIT,
    );
    assert.deepEqual(tracked.ship, { count: 0, ready: false });
  });

  it("maps pull request states", () => {
    const stateOf = (pr: Parameters<typeof makePullRequest>[0]) =>
      buildCrownRailSummary(makeLayout({ pullRequest: makePullRequest(pr) }), GIT).pr.state;
    assert.equal(stateOf({ state: "open" }), "open");
    assert.equal(stateOf({ state: "OPEN", isDraft: true }), "draft");
    assert.equal(stateOf({ state: "merged" }), "merged");
    assert.equal(stateOf({ state: "closed" }), "closed");
    // Branch-only checks carry no PR number.
    const { number: _omit, ...branchOnly } = makePullRequest();
    assert.equal(
      buildCrownRailSummary(makeLayout({ pullRequest: branchOnly }), GIT).pr.state,
      null,
    );
  });

  it("ignores source control outside a git repository", () => {
    const summary = buildCrownRailSummary(
      makeLayout({
        changes: makeChanges({ aheadCount: 2 }),
        pullRequest: makePullRequest({ latestRuns: [makeRun("a", "failure")] }),
      }),
      { isGitRepo: false },
    );
    assert.equal(summary.checks.ci, "none");
    assert.deepEqual(summary.checks.segments, []);
    assert.equal(summary.ship.count, 0);
    assert.equal(summary.pr.state, null);
  });
});

describe("crownRailItemDescription", () => {
  const describeAll = (summary: ReturnType<typeof buildCrownRailSummary>) =>
    Object.fromEntries(
      CROWN_RAIL_ITEMS.map((item) => [item.key, crownRailItemDescription(item, summary)]),
    );

  it("puts what the badges, ring and colours show into words", () => {
    const summary = buildCrownRailSummary(
      makeLayout({
        changes: makeChanges({
          aheadCount: 3,
          files: [{ path: "a.ts", insertions: 1, deletions: 0 }],
        }),
        pullRequest: makePullRequest({
          hasMergeConflicts: true,
          latestRuns: [makeRun("a", "success"), makeRun("b", "failure"), makeRun("c", "failure")],
        }),
        activePlan: makePlan([
          ["One", "completed"],
          ["Two", "inProgress"],
        ]),
        subagents: [makeSubagent("x", "running"), makeSubagent("y", "finished")],
      }),
      { isGitRepo: true, notesCount: 1 },
    );
    assert.deepEqual(describeAll(summary), {
      branch: "3 commits ahead",
      changes: "1 file changed",
      checks: "2 checks failing",
      plan: "1 of 2 steps done",
      agents: "2 subagents, 1 running",
      pr: "open, has conflicts",
      notes: "1 note",
      ship: "3 commits to push",
    });
  });

  it("describes an empty thread and running checks", () => {
    assert.deepEqual(describeAll(buildCrownRailSummary(makeLayout(), GIT)), {
      branch: null,
      changes: "No changes",
      checks: "No checks",
      plan: "No plan",
      agents: "No subagents",
      pr: "No pull request",
      notes: null,
      ship: "Nothing to push",
    });
    const running = buildCrownRailSummary(
      makeLayout({
        pullRequest: makePullRequest({
          latestRuns: [makeRun("a", "success"), makeRun("b", "running")],
        }),
      }),
      GIT,
    );
    const checks = CROWN_RAIL_ITEMS.find((item) => item.key === "checks")!;
    assert.equal(crownRailItemDescription(checks, running), "Running, 1 of 2 passed");
  });
});

describe("resolveCrownHeadline", () => {
  const headline = (layout: ReturnType<typeof makeLayout>, isGitRepo = true) =>
    resolveCrownHeadline(buildCrownRailSummary(layout, { isGitRepo }), layout);

  const busy = {
    changes: makeChanges({ aheadCount: 2 }),
    activePlan: makePlan([
      ["One", "completed"],
      ["Two", "inProgress"],
    ]),
  };

  it("puts failing checks first", () => {
    const result = headline(
      makeLayout({
        ...busy,
        pullRequest: makePullRequest({
          latestRuns: [
            makeRun("lint", "failure"),
            makeRun("test", "error"),
            makeRun("build", "running"),
          ],
        }),
      }),
    );
    assert.deepEqual(result, {
      section: "checks",
      tone: "danger",
      glyph: "x",
      title: "2 checks failing",
      sub: "lint",
    });
    const single = headline(
      makeLayout({ pullRequest: makePullRequest({ latestRuns: [makeRun("lint", "failure")] }) }),
    );
    assert.equal(single.title, "1 check failing");
  });

  it("then running or pending checks", () => {
    const result = headline(
      makeLayout({
        ...busy,
        pullRequest: makePullRequest({
          latestRuns: [makeRun("a", "success"), makeRun("b", "running"), makeRun("c", "pending")],
        }),
      }),
    );
    assert.deepEqual(result, {
      section: "checks",
      tone: "warning",
      glyph: "spinner",
      title: "Checks 1/3",
      sub: "2 in progress",
    });
  });

  it("then unpushed commits", () => {
    const result = headline(makeLayout(busy));
    assert.deepEqual(result, {
      section: "branch",
      tone: "info",
      glyph: "upload",
      title: "2 to push",
      sub: "feature/crown",
    });
  });

  it("then the active plan step", () => {
    const result = headline(makeLayout({ activePlan: busy.activePlan }));
    assert.deepEqual(result, {
      section: "plan",
      tone: "plan",
      glyph: "sparkles",
      title: "Plan 1/2",
      sub: "Two",
    });
  });

  it("then all checks passed", () => {
    const result = headline(
      makeLayout({ pullRequest: makePullRequest({ latestRuns: [makeRun("a", "success")] }) }),
    );
    assert.deepEqual(result, {
      section: "checks",
      tone: "success",
      glyph: "check",
      title: "All checks passed",
      sub: "PR #42",
    });
  });

  it("names the branch when passing checks have no PR", () => {
    const { number: _omit, ...branchOnly } = makePullRequest({
      latestRuns: [makeRun("a", "success")],
    });
    const result = headline(makeLayout({ changes: makeChanges(), pullRequest: branchOnly }));
    assert.equal(result.sub, "feature/crown");
  });

  it("falls back to a neutral face", () => {
    assert.deepEqual(headline(makeLayout({ changes: makeChanges() })), {
      section: "branch",
      tone: "neutral",
      glyph: "dot",
      title: "Overview",
      sub: "feature/crown",
    });
    assert.equal(headline(makeLayout(), false).section, "plan");
  });
});

describe("visibleCrownRailItems", () => {
  const keys = (input: { isGitRepo: boolean; notesAvailable: boolean }) =>
    visibleCrownRailItems(input).map((item) => item.key);

  it("shows Notes only while the node's notes are available", () => {
    assert.deepEqual(keys({ isGitRepo: true, notesAvailable: true }), [
      "branch",
      "changes",
      "checks",
      "plan",
      "agents",
      "pr",
      "notes",
      "ship",
    ]);
    assert.notInclude(keys({ isGitRepo: true, notesAvailable: false }), "notes");
    assert.deepEqual(keys({ isGitRepo: false, notesAvailable: true }), ["plan", "agents", "notes"]);
  });
});
