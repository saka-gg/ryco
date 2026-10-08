import { assert, describe, it } from "vite-plus/test";

import {
  buildCrownSnapshot,
  diffCrownSnapshots,
  mergeCrownBaseline,
  type CrownDiffContext,
  type CrownEvent,
  type CrownSnapshot,
} from "./crownAlerts.logic";
import {
  makeChanges,
  makeCheckStatus,
  makeLayout,
  makeNotesBinding,
  makeNoteView,
  makePlan,
  makePullRequest,
  makeRun,
  makeSnapshot,
  makeSubagent,
} from "./crownTestFixtures";

const NOW = 1_000_000;
const CTX: CrownDiffContext = { nowMs: NOW, suppressGitUntilMs: 0, turnOutcome: null };
const READY = { remoteStatus: true, pullRequestLookup: true };

type Checks = NonNullable<CrownSnapshot["checks"]>;
type Pr = NonNullable<CrownSnapshot["pr"]>;
type Turn = NonNullable<CrownSnapshot["turn"]>;

const snap = makeSnapshot;

function checks(overrides: Partial<Checks> = {}): Checks {
  return {
    headSha: "sha-1",
    kind: "running",
    failed: [],
    passed: 0,
    total: 3,
    refName: "feature/crown",
    ...overrides,
  };
}

function pr(overrides: Partial<Pr> = {}): Pr {
  return {
    number: 42,
    state: "open",
    isDraft: false,
    approvals: 0,
    conflicting: false,
    ...overrides,
  };
}

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    turnId: "turn-1",
    state: "running",
    startedAt: "2026-10-07T10:00:00.000Z",
    completedAt: null,
    settled: false,
    running: true,
    ...overrides,
  };
}

function diff(prev: CrownSnapshot | null, next: CrownSnapshot, ctx = CTX): CrownEvent[] {
  return diffCrownSnapshots(prev, next, ctx);
}

function only(events: CrownEvent[]): CrownEvent {
  assert.equal(events.length, 1, `expected one event, got ${JSON.stringify(events)}`);
  return events[0]!;
}

describe("buildCrownSnapshot", () => {
  it("reduces the overview to comparable state", () => {
    const snapshot = buildCrownSnapshot({
      scopeKey: "scope",
      layout: makeLayout({
        changes: makeChanges({
          aheadCount: 2,
          behindCount: 1,
          files: [{ path: "a.ts", insertions: 1, deletions: 0 }],
        }),
        pullRequest: makePullRequest({
          isDraft: true,
          reviewsApproved: 1,
          mergeability: "conflicting",
          hasMergeConflicts: true,
          checkStatus: makeCheckStatus("failed", { headSha: "abc" }),
          latestRuns: [makeRun("lint", "failure"), makeRun("test", "success")],
        }),
        activePlan: makePlan([
          ["One", "completed"],
          ["Two", "inProgress"],
        ]),
        subagents: [makeSubagent("agent:a", "running", "Scout")],
      }),
      latestTurn: {
        turnId: "turn-1",
        state: "completed",
        startedAt: "2026-10-07T10:00:00.000Z",
        completedAt: "2026-10-07T10:03:00.000Z",
      },
      turnSettled: true,
      agentRunning: false,
      readiness: READY,
    });
    assert.deepEqual(snapshot, {
      scopeKey: "scope",
      turn: {
        turnId: "turn-1",
        state: "completed",
        startedAt: "2026-10-07T10:00:00.000Z",
        completedAt: "2026-10-07T10:03:00.000Z",
        settled: true,
        running: false,
      },
      checks: {
        headSha: "abc",
        kind: "failed",
        failed: ["lint"],
        passed: 1,
        total: 2,
        refName: "feature/crown",
      },
      pr: { number: 42, state: "open", isDraft: true, approvals: 1, conflicting: true },
      prSettled: true,
      branch: { refName: "feature/crown", ahead: 2, behind: 1 },
      plan: { turnId: "turn-1", completedSteps: ["One"], total: 2 },
      subagents: { "agent:a": { status: "running", name: "Scout" } },
      fileCount: 1,
      notes: null,
    });
  });

  it("keeps the worktree view's notes once they have answered, marking this client's own", () => {
    const base = {
      scopeKey: "scope",
      layout: makeLayout(),
      latestTurn: null,
      turnSettled: true,
      agentRunning: false,
      readiness: READY,
    };
    const notes = makeNotesBinding({
      worktreeNotes: [
        makeNoteView("mine", { body: "[ ] Ship   the\ncrown" }),
        makeNoteView("theirs", { body: "x".repeat(60) }),
      ],
      ownNoteIds: new Set(["mine"]),
    });
    assert.deepEqual(buildCrownSnapshot({ ...base, notes }).notes, {
      mine: { summary: "Ship the crown", own: true },
      theirs: { summary: `${"x".repeat(39)}…`, own: false },
    });
    assert.isNull(buildCrownSnapshot({ ...base, notes: { ...notes, loaded: false } }).notes);
    assert.isNull(buildCrownSnapshot({ ...base, notes: { ...notes, available: false } }).notes);
    // A pending delete hides a note from the list, not from the alert baseline: rolling
    // it back must not look like a note appearing.
    const deleting = makeNotesBinding({
      worktreeNotes: [],
      alertNotes: [makeNoteView("theirs", { body: "Kept" })],
    });
    assert.deepEqual(buildCrownSnapshot({ ...base, notes: deleting }).notes, {
      theirs: { summary: "Kept", own: false },
    });
  });

  it("leaves checks unknown while loading, unavailable or erroring", () => {
    for (const kind of ["loading", "unavailable", "api-error"] as const) {
      const snapshot = buildCrownSnapshot({
        scopeKey: "scope",
        layout: makeLayout({
          pullRequest: makePullRequest({ checkStatus: makeCheckStatus(kind) }),
        }),
        latestTurn: null,
        turnSettled: false,
        agentRunning: false,
        readiness: READY,
      });
      assert.equal(snapshot.checks, null, kind);
    }
  });

  it("has no PR for branch-only checks", () => {
    const { number: _omit, ...branchOnly } = makePullRequest({
      checkStatus: makeCheckStatus("running"),
    });
    const snapshot = buildCrownSnapshot({
      scopeKey: "scope",
      layout: makeLayout({ pullRequest: branchOnly }),
      latestTurn: null,
      turnSettled: false,
      agentRunning: false,
      readiness: READY,
    });
    assert.equal(snapshot.pr, null);
    assert.equal(snapshot.checks?.kind, "running");
  });

  it("leaves values unknown until their source has answered", () => {
    const { state: _state, ...numberOnly } = makePullRequest();
    const snapshot = buildCrownSnapshot({
      scopeKey: "scope",
      layout: makeLayout({
        changes: makeChanges({ aheadCount: 0 }),
        // A PR number with no detail yet: no state, draft flag, reviews or mergeability.
        pullRequest: numberOnly,
      }),
      latestTurn: null,
      turnSettled: false,
      agentRunning: false,
      readiness: { remoteStatus: false, pullRequestLookup: false },
    });
    assert.deepEqual(snapshot.branch, { refName: "feature/crown", ahead: null, behind: null });
    assert.deepEqual(snapshot.pr, {
      number: 42,
      state: null,
      isDraft: null,
      approvals: null,
      conflicting: null,
    });
    assert.equal(snapshot.prSettled, false);
  });
});

describe("mergeCrownBaseline", () => {
  it("keeps the last known checks and PR across a reload", () => {
    const prev = snap({ checks: checks(), pr: pr() });
    const next = snap({ fileCount: 2 });
    const merged = mergeCrownBaseline(prev, next);
    assert.equal(merged.checks, prev.checks);
    assert.equal(merged.pr, prev.pr);
    assert.equal(merged.fileCount, 2);
  });

  it("keeps the last known PR fields and ahead / behind while they reload", () => {
    const prev = snap({
      pr: pr({ approvals: 1, conflicting: false }),
      branch: { refName: "feature/crown", ahead: 3, behind: 1 },
    });
    const next = snap({
      pr: pr({ state: null, isDraft: null, approvals: null, conflicting: null }),
      branch: { refName: "feature/crown", ahead: null, behind: null },
    });
    const merged = mergeCrownBaseline(prev, next);
    assert.deepEqual(merged.pr, prev.pr);
    assert.deepEqual(merged.branch, prev.branch);
    // A branch switch does not carry counts over.
    const other = snap({ branch: { refName: "other", ahead: null, behind: null } });
    assert.deepEqual(mergeCrownBaseline(prev, other).branch, other.branch);
  });

  it("takes the next snapshot when it is new or a new scope", () => {
    const next = snap({ checks: checks({ kind: "passed" }) });
    assert.deepEqual(mergeCrownBaseline(snap({ checks: checks() }), next), next);
    assert.equal(mergeCrownBaseline(null, next), next);
    const otherScope = snap({ scopeKey: "thread-2|/repo" });
    assert.equal(mergeCrownBaseline(snap({ checks: checks() }), otherScope), otherScope);
  });
});

describe("diffCrownSnapshots baseline", () => {
  it("is silent for the first snapshot", () => {
    assert.deepEqual(diff(null, snap({ checks: checks({ kind: "failed", failed: ["x"] }) })), []);
  });

  it("is silent on a thread switch", () => {
    const prev = snap({ checks: checks(), subagents: {} });
    const next = snap({
      scopeKey: "thread-2|/repo",
      checks: checks({ kind: "failed", failed: ["lint"] }),
      subagents: { a: { status: "running", name: "Scout" } },
      branch: { refName: "feature/crown", ahead: 5, behind: 0 },
    });
    assert.deepEqual(diff(prev, next), []);
  });

  it("is silent for an unchanged snapshot", () => {
    const value = snap({ checks: checks(), pr: pr(), turn: turn() });
    assert.deepEqual(diff(value, { ...value }), []);
  });

  it("gives every event a unique id and its dedupe key", () => {
    const event = only(
      diff(
        snap({ checks: checks() }),
        snap({ checks: checks({ kind: "failed", failed: ["lint"] }) }),
      ),
    );
    assert.equal(event.id, `${event.dedupeKey}@${NOW}`);
  });
});

describe("diffCrownSnapshots checks", () => {
  it("alerts loudly when checks start failing", () => {
    const event = only(
      diff(
        snap({ checks: checks() }),
        snap({ checks: checks({ kind: "failed", failed: ["lint", "test"] }) }),
      ),
    );
    assert.deepInclude(event, {
      kind: "checks",
      section: "checks",
      railKey: "checks",
      tone: "danger",
      icon: "x",
      title: "2 checks failing",
      sub: "lint",
      loud: true,
    });
  });

  it("alerts again when the failed set grows on the same head", () => {
    const event = only(
      diff(
        snap({ checks: checks({ kind: "failed", failed: ["lint"] }) }),
        snap({ checks: checks({ kind: "failed", failed: ["lint", "test"] }) }),
      ),
    );
    assert.equal(event.title, "2 checks failing");
    assert.equal(event.loud, true);
  });

  it("stays quiet while the same failures persist", () => {
    const failing = checks({ kind: "failed", failed: ["lint"] });
    assert.deepEqual(diff(snap({ checks: failing }), snap({ checks: { ...failing } })), []);
  });

  it("alerts when all checks pass after running", () => {
    const event = only(
      diff(
        snap({ checks: checks(), pr: pr() }),
        snap({ checks: checks({ kind: "passed", passed: 3 }), pr: pr() }),
      ),
    );
    assert.deepInclude(event, {
      tone: "success",
      icon: "check",
      title: "All checks passed",
      sub: "PR #42",
      loud: true,
    });
  });

  it("does not call a terminal-to-passed flip a pass", () => {
    assert.deepEqual(
      diff(
        snap({ checks: checks({ kind: "cancelled" }) }),
        snap({ checks: checks({ kind: "passed" }) }),
      ),
      [],
    );
  });

  it("only pings when checks start or a new head arrives", () => {
    const started = only(
      diff(
        snap({ checks: checks({ kind: "passed" }) }),
        snap({ checks: checks({ kind: "pending" }) }),
      ),
    );
    assert.deepInclude(started, { loud: false, title: "Checks started", railKey: "checks" });
    const newHead = only(
      diff(
        snap({ checks: checks({ kind: "passed" }) }),
        snap({ checks: checks({ headSha: "sha-2", kind: "running" }) }),
      ),
    );
    assert.equal(newHead.loud, false);
  });

  it("still alerts when a new head arrives already failing", () => {
    const event = only(
      diff(
        snap({ checks: checks({ kind: "passed" }) }),
        snap({ checks: checks({ headSha: "sha-2", kind: "failed", failed: ["lint"] }) }),
      ),
    );
    assert.equal(event.loud, true);
    assert.equal(event.title, "1 check failing");
  });

  it("survives a loading flap without re-alerting", () => {
    const failing = snap({ checks: checks({ kind: "failed", failed: ["lint"] }) });
    const loading = snap({ checks: null });
    assert.deepEqual(diff(failing, loading), []);
    const baseline = mergeCrownBaseline(failing, loading);
    assert.deepEqual(diff(baseline, failing), []);
  });

  it("still catches a transition hidden behind a loading flap", () => {
    const running = snap({ checks: checks() });
    const baseline = mergeCrownBaseline(running, snap({ checks: null }));
    const event = only(diff(baseline, snap({ checks: checks({ kind: "failed", failed: ["x"] }) })));
    assert.equal(event.tone, "danger");
  });

  it("treats the first known check status as a baseline", () => {
    assert.deepEqual(
      diff(snap({ checks: null }), snap({ checks: checks({ kind: "failed", failed: ["x"] }) })),
      [],
    );
  });

  it("keeps dedupe keys stable for the same transition", () => {
    const prev = snap({ checks: checks() });
    const next = snap({ checks: checks({ kind: "failed", failed: ["b", "a"] }) });
    const first = only(diff(prev, next));
    const second = only(diff(prev, next, { ...CTX, nowMs: NOW + 5000 }));
    assert.equal(first.dedupeKey, second.dedupeKey);
    assert.notEqual(first.id, second.id);
  });
});

describe("diffCrownSnapshots pull request", () => {
  it("announces a newly opened PR", () => {
    const event = only(diff(snap(), snap({ pr: pr({ isDraft: true }) })));
    assert.deepInclude(event, {
      kind: "pr",
      railKey: "pr",
      icon: "pr",
      tone: "info",
      title: "Opened draft PR #42",
      loud: true,
    });
  });

  it("suppresses the opened alert during the user's git action", () => {
    assert.deepEqual(diff(snap(), snap({ pr: pr() }), { ...CTX, suppressGitUntilMs: NOW + 1 }), []);
  });

  it("does not call a PR found after a branch switch opened", () => {
    const next = snap({ pr: pr(), branch: { refName: "other", ahead: 0, behind: 0 } });
    assert.deepEqual(diff(snap(), next), []);
  });

  it("announces ready for review", () => {
    const event = only(diff(snap({ pr: pr({ isDraft: true }) }), snap({ pr: pr() })));
    assert.deepInclude(event, { tone: "info", title: "PR #42 ready for review", loud: true });
  });

  it("announces approvals", () => {
    const event = only(
      diff(snap({ pr: pr({ approvals: 0 }) }), snap({ pr: pr({ approvals: 1 }) })),
    );
    assert.deepInclude(event, { tone: "success", title: "PR #42 approved", loud: true });
    assert.deepEqual(
      diff(snap({ pr: pr({ approvals: 2 }) }), snap({ pr: pr({ approvals: 1 }) })),
      [],
    );
  });

  it("announces a merge", () => {
    const event = only(diff(snap({ pr: pr() }), snap({ pr: pr({ state: "merged" }) })));
    assert.deepInclude(event, { tone: "success", title: "PR #42 merged", loud: true });
  });

  it("announces conflicts", () => {
    const event = only(diff(snap({ pr: pr() }), snap({ pr: pr({ conflicting: true }) })));
    assert.deepInclude(event, { tone: "danger", title: "PR #42 has conflicts", loud: true });
  });

  it("only pings a close", () => {
    const event = only(diff(snap({ pr: pr() }), snap({ pr: pr({ state: "closed" }) })));
    assert.deepInclude(event, { title: "PR #42 closed", loud: false });
  });

  it("does not call a PR found while the lookup was still answering opened", () => {
    assert.deepEqual(diff(snap({ prSettled: false }), snap({ pr: pr() })), []);
  });

  it("adopts PR detail arriving after the number silently", () => {
    const numberOnly = snap({
      pr: pr({ state: null, isDraft: null, approvals: null, conflicting: null }),
    });
    const detailed = snap({ pr: pr({ state: "merged", approvals: 1, conflicting: true }) });
    assert.deepEqual(diff(numberOnly, detailed), []);
    // Once known, a real change still alerts.
    const event = only(
      diff(mergeCrownBaseline(numberOnly, detailed), snap({ pr: pr({ approvals: 2 }) })),
    );
    assert.equal(event.title, "PR #42 approved");
  });

  it("ignores a PR that disappears while reloading", () => {
    const withPr = snap({ pr: pr() });
    const reloading = snap();
    assert.deepEqual(diff(withPr, reloading), []);
    assert.deepEqual(diff(mergeCrownBaseline(withPr, reloading), withPr), []);
  });
});

describe("diffCrownSnapshots branch", () => {
  const branch = (ahead: number, behind = 0, refName = "feature/crown") => ({
    refName,
    ahead,
    behind,
  });

  it("announces new commits", () => {
    const event = only(diff(snap({ branch: branch(1) }), snap({ branch: branch(3) })));
    assert.deepInclude(event, {
      kind: "branch",
      section: "branch",
      railKey: "branch",
      tone: "neutral",
      icon: "commit",
      title: "2 new commits",
      sub: "feature/crown",
      loud: true,
    });
    assert.equal(only(diff(snap(), snap({ branch: branch(1) }))).title, "1 new commit");
  });

  it("announces a push", () => {
    const event = only(diff(snap({ branch: branch(3) }), snap({ branch: branch(0) })));
    assert.deepInclude(event, {
      tone: "info",
      icon: "upload",
      title: "Pushed 3 commits",
      loud: true,
    });
  });

  it("does not call a pull or rebase a push", () => {
    assert.deepEqual(diff(snap({ branch: branch(3, 2) }), snap({ branch: branch(0, 0) })), []);
  });

  it("ignores branch switches", () => {
    assert.deepEqual(
      diff(snap({ branch: branch(0) }), snap({ branch: branch(4, 0, "other") })),
      [],
    );
  });

  it("drops branch events inside the suppression window and resumes after it", () => {
    const prev = snap({ branch: branch(3) });
    const next = snap({ branch: branch(0) });
    assert.deepEqual(diff(prev, next, { ...CTX, suppressGitUntilMs: Infinity }), []);
    assert.deepEqual(diff(prev, next, { ...CTX, suppressGitUntilMs: NOW + 4000 }), []);
    assert.equal(
      diff(prev, next, { ...CTX, nowMs: NOW + 4000, suppressGitUntilMs: NOW + 4000 }).length,
      1,
    );
  });

  it("keeps non-git events during the suppression window", () => {
    const events = diff(
      snap({ branch: branch(3), checks: checks() }),
      snap({ branch: branch(0), checks: checks({ kind: "failed", failed: ["x"] }) }),
      { ...CTX, suppressGitUntilMs: Infinity },
    );
    assert.equal(only(events).kind, "checks");
  });

  it("stays quiet while git status hydrates: local only, then remote", () => {
    const empty = snap({ prSettled: false, branch: { refName: null, ahead: null, behind: null } });
    const local = snap({
      prSettled: false,
      branch: { refName: "feature/crown", ahead: null, behind: null },
    });
    const remote = snap({ pr: pr(), branch: branch(3) });
    assert.deepEqual(diff(empty, local), []);
    const baseline = mergeCrownBaseline(empty, local);
    assert.deepEqual(diff(baseline, remote), []);
  });

  it("stays quiet when a resubscribe drops back to local-only status", () => {
    const full = snap({ pr: pr(), branch: branch(3) });
    const localOnly = snap({
      prSettled: false,
      branch: { refName: "feature/crown", ahead: null, behind: null },
    });
    assert.deepEqual(diff(full, localOnly), []);
    const baseline = mergeCrownBaseline(full, localOnly);
    assert.deepEqual(diff(baseline, full), []);
  });

  it("tells repeated ahead counts apart by turn", () => {
    const first = only(diff(snap({ turn: turn() }), snap({ turn: turn(), branch: branch(1) })));
    const second = only(
      diff(
        snap({ turn: turn({ turnId: "turn-2" }) }),
        snap({ turn: turn({ turnId: "turn-2" }), branch: branch(1) }),
      ),
    );
    assert.notEqual(first.dedupeKey, second.dedupeKey);
  });
});

describe("diffCrownSnapshots subagents", () => {
  const agents = (entries: Record<string, CrownSnapshot["subagents"][string]["status"]>) =>
    Object.fromEntries(
      Object.entries(entries).map(([key, status]) => [key, { status, name: key.toUpperCase() }]),
    );

  it("announces a subagent starting", () => {
    const event = only(diff(snap(), snap({ subagents: agents({ a: "running" }) })));
    assert.deepInclude(event, {
      kind: "subagent",
      section: "agents",
      railKey: "agents",
      tone: "agent",
      icon: "bot",
      title: "A started",
      loud: true,
    });
  });

  it("announces a subagent finishing", () => {
    const event = only(
      diff(
        snap({ subagents: agents({ a: "running" }) }),
        snap({ subagents: agents({ a: "finished" }) }),
      ),
    );
    assert.deepInclude(event, { tone: "agent", title: "A finished", loud: true });
  });

  it("asks for review when a subagent fails", () => {
    const event = only(
      diff(
        snap({ subagents: agents({ a: "running" }) }),
        snap({ subagents: agents({ a: "failed" }) }),
      ),
    );
    assert.deepInclude(event, { tone: "danger", title: "A needs review", loud: true });
  });

  it("never alerts for interruptions", () => {
    assert.deepEqual(
      diff(
        snap({ subagents: agents({ a: "running" }) }),
        snap({ subagents: agents({ a: "interrupted" }) }),
      ),
      [],
    );
    assert.deepEqual(
      diff(
        snap({ subagents: agents({ a: "interrupted" }) }),
        snap({ subagents: agents({ a: "failed" }) }),
      ),
      [],
    );
  });

  it("does not announce a subagent that appears already finished", () => {
    assert.deepEqual(diff(snap(), snap({ subagents: agents({ a: "finished" }) })), []);
  });

  it("keeps two events separate", () => {
    const events = diff(
      snap({ subagents: agents({ a: "running", b: "running" }) }),
      snap({ subagents: agents({ a: "finished", b: "finished" }) }),
    );
    assert.deepEqual(
      events.map((event) => event.title),
      ["A finished", "B finished"],
    );
  });

  it("collapses a burst of three or more into one event", () => {
    const event = only(
      diff(
        snap({ subagents: agents({ a: "running", b: "running", c: "running" }) }),
        snap({ subagents: agents({ a: "finished", b: "finished", c: "finished" }) }),
      ),
    );
    assert.deepInclude(event, {
      title: "3 subagents finished",
      sub: "A, B, C",
      tone: "agent",
      loud: true,
    });
  });

  it("collapses a mixed burst and keeps the danger tone", () => {
    const event = only(
      diff(
        snap({ subagents: agents({ a: "running", b: "running" }) }),
        snap({ subagents: agents({ a: "finished", b: "failed", c: "running" }) }),
      ),
    );
    assert.deepInclude(event, { title: "3 subagent updates", tone: "danger" });
  });
});

describe("diffCrownSnapshots plan", () => {
  const plan = (completedSteps: string[], turnId = "turn-1") => ({
    turnId,
    completedSteps,
    total: 4,
  });

  it("pings when a step finishes", () => {
    const event = only(diff(snap({ plan: plan(["One"]) }), snap({ plan: plan(["One", "Two"]) })));
    assert.deepInclude(event, {
      kind: "plan",
      railKey: "plan",
      tone: "plan",
      icon: "sparkles",
      title: "Finished “Two”",
      loud: false,
    });
  });

  it("ignores a new plan for another turn", () => {
    assert.deepEqual(diff(snap({ plan: plan([]) }), snap({ plan: plan(["One"], "turn-2") })), []);
  });
});

describe("diffCrownSnapshots turn", () => {
  // The turn-completion tracker decides that a turn ended; the diff only words it.
  const ended = turn({
    state: "completed",
    completedAt: "2026-10-07T10:04:00.000Z",
    settled: true,
    running: false,
  });
  const withOutcome = (turnOutcome: CrownDiffContext["turnOutcome"]) => ({ ...CTX, turnOutcome });

  it("announces a finished turn with its duration", () => {
    const event = only(
      diff(snap({ turn: turn() }), snap({ turn: ended }), withOutcome("completed")),
    );
    assert.deepInclude(event, {
      kind: "turn",
      tone: "success",
      icon: "turn",
      title: "Turn finished",
      sub: "Took 4m",
      loud: true,
      dedupeKey: "turn:turn-1:completed",
    });
  });

  it("announces a failed turn", () => {
    const failed = { ...ended, state: "error" as const };
    const event = only(diff(snap({ turn: turn() }), snap({ turn: failed }), withOutcome("failed")));
    assert.deepInclude(event, { tone: "danger", icon: "x", title: "Turn failed", loud: true });
  });

  it("stays quiet without an outcome or for an interrupted turn", () => {
    assert.deepEqual(diff(snap({ turn: turn() }), snap({ turn: ended })), []);
    const interrupted = { ...ended, state: "interrupted" as const };
    assert.deepEqual(
      diff(snap({ turn: turn() }), snap({ turn: interrupted }), withOutcome("interrupted")),
      [],
    );
  });
});

describe("diffCrownSnapshots changes", () => {
  it("pings when more files change", () => {
    const event = only(diff(snap({ fileCount: 1 }), snap({ fileCount: 3 })));
    assert.deepInclude(event, {
      kind: "changes",
      railKey: "changes",
      title: "3 files changed",
      loud: false,
    });
    assert.deepEqual(diff(snap({ fileCount: 3 }), snap({ fileCount: 1 })), []);
  });
});

describe("diffCrownSnapshots notes", () => {
  const note = (summary: string, own = false) => ({ summary, own });

  it("is silent when the notes first answer, and keeps them across a reload", () => {
    const loaded = snap({ notes: { a: note("Alpha") } });
    assert.deepEqual(diff(snap(), loaded), []);
    const reloading = mergeCrownBaseline(loaded, snap());
    assert.deepEqual(reloading.notes, loaded.notes);
    assert.deepEqual(diff(reloading, loaded), []);
  });

  it("announces a note saved elsewhere, carrying its id for View", () => {
    const event = only(
      diff(
        snap({ notes: { a: note("Alpha") } }),
        snap({ notes: { b: note("Hosted worker must not cache"), a: note("Alpha") } }),
      ),
    );
    assert.deepInclude(event, {
      kind: "note",
      section: "notes",
      railKey: "notes",
      tone: "note",
      icon: "note",
      title: "Note saved",
      sub: "Hosted worker must not cache",
      loud: true,
      noteId: "b",
      dedupeKey: "note:b",
    });
  });

  it("only pings for this client's own save", () => {
    const event = only(diff(snap({ notes: {} }), snap({ notes: { mine: note("Mine", true) } })));
    assert.deepInclude(event, { kind: "note", railKey: "notes", loud: false, noteId: "mine" });
  });

  it("collapses a burst of notes into one alert and ignores removals", () => {
    const event = only(
      diff(
        snap({ notes: { a: note("A") } }),
        snap({ notes: { d: note("D"), c: note("C"), b: note("B") } }),
      ),
    );
    assert.deepInclude(event, { title: "3 notes saved", sub: "D", noteId: "d", loud: true });
    assert.equal(event.dedupeKey, "notes:b|c|d");
  });
});
