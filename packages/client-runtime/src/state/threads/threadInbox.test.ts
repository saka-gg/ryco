import { scopedProjectKey, scopedThreadKey } from "@ryco/client-runtime/scoped";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorktreeId,
  ThreadPriorityBatchId,
  ThreadPriorityFingerprint,
  ThreadPriorityReason,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadInbox,
  deriveThreadSnoozeEligibility,
  scopedInboxWorktreeKey,
  type BuildThreadInboxInput,
  type ThreadInboxDraftSummary,
  type ThreadInboxEnvironment,
} from "./threadInbox.ts";
import type { Project, SidebarThreadSummary, SidebarWorktreeSummary } from "./types.ts";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");
const projectId = ProjectId.make("project-1");
const worktreeId = WorktreeId.make("worktree-1");
const nowMs = Date.parse("2026-07-31T12:00:00.000Z");

function makeEnvironment(
  environmentId: EnvironmentId,
  overrides: Partial<ThreadInboxEnvironment> = {},
): ThreadInboxEnvironment {
  return {
    environmentId,
    label: environmentId === environmentA ? "Local" : "Remote",
    threadSettlementSupported: true,
    connected: true,
    mutationReady: true,
    shellCurrent: true,
    ...overrides,
  };
}

function makeProject(environmentId: EnvironmentId): Project {
  return {
    id: projectId,
    environmentId,
    name: environmentId === environmentA ? "Alpha" : "Beta",
    cwd: `/tmp/${environmentId}`,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    scripts: [],
  };
}

function makeThread(
  environmentId: EnvironmentId,
  threadId: string,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  return {
    id: ThreadId.make(threadId),
    environmentId,
    projectId,
    title: threadId,
    interactionMode: "default",
    tokenMode: "balanced",
    session: null,
    createdAt: "2026-07-31T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    updatedAt: "2026-07-31T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    worktreeId: null,
    manualStatusBucket: null,
    manualPosition: 0,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeWorktree(
  environmentId: EnvironmentId,
  overrides: Partial<SidebarWorktreeSummary> = {},
): SidebarWorktreeSummary {
  return {
    id: worktreeId,
    environmentId,
    projectId,
    title: "Feature",
    branch: "feature/inbox",
    worktreePath: `/tmp/${environmentId}/worktree`,
    origin: "pr",
    prNumber: 42,
    issueNumber: null,
    prTitle: "Inbox",
    issueTitle: null,
    prState: "open",
    prIsDraft: false,
    issueState: null,
    workItemProvider: null,
    workItemKey: null,
    workItemTitle: null,
    workItemState: null,
    workItemStateName: null,
    workItemUrl: null,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T01:00:00.000Z",
    archivedAt: null,
    manualPosition: 0,
    ...overrides,
  };
}

function baseInput(overrides: Partial<BuildThreadInboxInput> = {}): BuildThreadInboxInput {
  return {
    projects: [makeProject(environmentA), makeProject(environmentB)],
    worktrees: [],
    threads: [],
    environments: [makeEnvironment(environmentA), makeEnvironment(environmentB)],
    nowMs,
    ...overrides,
  };
}

describe("thread inbox", () => {
  it("builds one global inbox while keeping identical worktree IDs environment-scoped", () => {
    const threadA = makeThread(environmentA, "thread-a", {
      worktreeId,
      worktreePath: `/tmp/${environmentA}/worktree`,
    });
    const threadB = makeThread(environmentB, "thread-b", {
      worktreeId,
      worktreePath: `/tmp/${environmentB}/worktree`,
    });
    const inbox = buildThreadInbox(
      baseInput({
        worktrees: [
          makeWorktree(environmentA, {
            prState: "merged",
            updatedAt: "2026-07-31T10:00:00.000Z",
          }),
          makeWorktree(environmentB, { prState: "open" }),
        ],
        threads: [threadA, threadB],
      }),
    );

    expect(inbox.active.map((entry) => entry.key)).toEqual([
      scopedThreadKey({ environmentId: environmentB, threadId: threadB.id }),
    ]);
    expect(inbox.settled.map((entry) => entry.key)).toEqual([
      scopedThreadKey({ environmentId: environmentA, threadId: threadA.id }),
    ]);
    expect(inbox.settled[0]?.worktree?.environmentId).toBe(environmentA);
  });

  it("keeps unsupported environment rows active and mutation-disabled", () => {
    const thread = makeThread(environmentB, "thread-unsupported", {
      settledOverride: "settled",
      settledAt: "2026-07-31T10:00:00.000Z",
    });
    const inbox = buildThreadInbox(
      baseInput({
        environments: [
          makeEnvironment(environmentB, {
            threadSettlementSupported: false,
          }),
        ],
        threads: [thread],
      }),
    );

    expect(inbox.active[0]?.thread).toBe(thread);
    expect(inbox.active[0]?.lifecycle.settlementBlocker).toBe("unsupported");
    expect(inbox.active[0]?.mutationBlocker).toBe("unsupported");
    expect(inbox.settled).toEqual([]);
  });

  it("automatically settles merged and closed PRs, then reopens them with the PR", () => {
    const thread = makeThread(environmentA, "thread-pr", {
      worktreeId,
      worktreePath: `/tmp/${environmentA}/worktree`,
    });
    const merged = buildThreadInbox(
      baseInput({
        threads: [thread],
        worktrees: [makeWorktree(environmentA, { prState: "merged" })],
      }),
    );
    const closed = buildThreadInbox(
      baseInput({
        threads: [thread],
        worktrees: [makeWorktree(environmentA, { prState: "closed" })],
      }),
    );
    const reopened = buildThreadInbox(
      baseInput({
        threads: [thread],
        worktrees: [makeWorktree(environmentA, { prState: "open" })],
      }),
    );

    expect(merged.settled).toHaveLength(1);
    expect(closed.settled).toHaveLength(1);
    expect(reopened.active).toHaveLength(1);
    expect(reopened.settled).toEqual([]);
  });

  it("judges each thread by its own pull request when the workspace carried several", () => {
    const link = (number: number, state: "open" | "merged", linkedAt: string) => ({
      number,
      title: `PR ${number}`,
      url: null,
      state,
      isDraft: false,
      terminalAt: state === "merged" ? "2026-07-31T06:00:00.000Z" : null,
      headRefName: "feature",
      baseRefName: "main",
      source: "created" as const,
      linkedAt,
      dismissedAt: null,
    });
    const worktree = makeWorktree(environmentA, {
      prNumber: 677,
      prState: "open",
      prTerminalAt: null,
      pullRequests: [
        link(675, "merged", "2026-07-31T02:00:00.000Z"),
        link(677, "open", "2026-07-31T08:00:00.000Z"),
      ],
    });
    const shipped = makeThread(environmentA, "thread-shipped", {
      worktreeId,
      worktreePath: `/tmp/${environmentA}/worktree`,
      createdAt: "2026-07-31T01:00:00.000Z",
      latestUserMessageAt: "2026-07-31T01:30:00.000Z",
    });
    const followUp = makeThread(environmentA, "thread-follow-up", {
      worktreeId,
      worktreePath: `/tmp/${environmentA}/worktree`,
      createdAt: "2026-07-31T09:00:00.000Z",
      latestUserMessageAt: "2026-07-31T09:30:00.000Z",
    });
    const inbox = buildThreadInbox(
      baseInput({ threads: [shipped, followUp], worktrees: [worktree] }),
    );
    expect(inbox.settled.map((entry) => entry.thread.id)).toEqual([shipped.id]);
    expect(inbox.active.map((entry) => entry.thread.id)).toEqual([followUp.id]);
    expect(inbox.active[0]?.lifecycle.settlementBlocker ?? null).toBeNull();
  });

  it("auto-settles from activity time, protects open PRs, and exposes one next boundary", () => {
    const inactive = makeThread(environmentA, "thread-inactive", {
      latestUserMessageAt: "2026-07-23T12:00:00.000Z",
      updatedAt: "2026-07-31T11:59:00.000Z",
    });
    const future = makeThread(environmentA, "thread-future", {
      latestUserMessageAt: "2026-07-30T12:00:00.000Z",
    });
    const openPr = makeThread(environmentA, "thread-open-pr", {
      worktreeId,
      worktreePath: `/tmp/${environmentA}/worktree`,
      latestUserMessageAt: "2026-07-23T12:00:00.000Z",
    });
    const inbox = buildThreadInbox(
      baseInput({
        autoSettleAfterDays: 7,
        threads: [inactive, future, openPr],
        worktrees: [makeWorktree(environmentA, { prState: "open" })],
      }),
    );

    expect(inbox.settled.map((entry) => entry.thread?.id)).toEqual([inactive.id]);
    expect(inbox.active.map((entry) => entry.thread?.id)).toEqual([future.id, openPr.id]);
    expect(inbox.nextSettlementEvaluationAtMs).toBe(Date.parse("2026-08-06T12:00:00.000Z"));
    expect(inbox.settled[0]?.lifecycle.effectiveSettlementTimestamp).toBe(
      "2026-07-30T12:00:00.000Z",
    );
  });

  describe("automatic settlement signals", () => {
    const staleActivity = {
      latestUserMessageAt: "2026-07-20T12:00:00.000Z",
      updatedAt: "2026-07-20T12:00:00.000Z",
    };

    it("keeps a pinned thread active past the inactivity boundary", () => {
      const pinned = makeThread(environmentA, "thread-pinned", staleActivity);
      const unpinned = makeThread(environmentA, "thread-unpinned", staleActivity);
      const pinnedKey = scopedThreadKey({ environmentId: environmentA, threadId: pinned.id });
      const inbox = buildThreadInbox(
        baseInput({
          autoSettleAfterDays: 7,
          threads: [pinned, unpinned],
          pinnedThreadKeys: [pinnedKey],
        }),
      );

      expect(inbox.active.map((entry) => entry.thread?.id)).toEqual([pinned.id]);
      expect(inbox.active[0]).toMatchObject({
        pinned: true,
        lifecycle: { autoSettlementBlocker: "pinned", settlementBlocker: null },
      });
      expect(inbox.settled.map((entry) => entry.thread?.id)).toEqual([unpinned.id]);
      expect(inbox.settled[0]?.lifecycle.autoSettlementBlocker).toBeNull();
    });

    it("keeps live agent work active and lets watch loops settle", () => {
      const working = makeThread(environmentA, "thread-working", {
        ...staleActivity,
        backgroundLiveness: "working",
      });
      const monitoring = makeThread(environmentA, "thread-monitoring", {
        ...staleActivity,
        backgroundLiveness: "monitoring",
      });
      const inbox = buildThreadInbox(
        baseInput({ autoSettleAfterDays: 7, threads: [working, monitoring] }),
      );

      expect(inbox.active.map((entry) => entry.thread?.id)).toEqual([working.id]);
      expect(inbox.active[0]?.lifecycle.autoSettlementBlocker).toBe("background-work");
      expect(inbox.settled.map((entry) => entry.thread?.id)).toEqual([monitoring.id]);
    });

    it("keeps a PR worktree whose state is unknown active", () => {
      const thread = makeThread(environmentA, "thread-unknown-pr", {
        ...staleActivity,
        worktreeId,
      });
      const inbox = buildThreadInbox(
        baseInput({
          autoSettleAfterDays: 7,
          threads: [thread],
          worktrees: [makeWorktree(environmentA, { prNumber: 42, prState: null })],
        }),
      );

      expect(inbox.active[0]?.lifecycle.autoSettlementBlocker).toBe("pull-request-unknown");
      expect(inbox.settled).toEqual([]);
      expect(inbox.nextSettlementEvaluationAtMs).toBeNull();
    });

    it("does not settle a merged PR that closed before later activity, and schedules inactivity", () => {
      const thread = makeThread(environmentA, "thread-merged-earlier", {
        worktreeId,
        latestUserMessageAt: "2026-07-31T10:00:00.000Z",
      });
      const inbox = buildThreadInbox(
        baseInput({
          autoSettleAfterDays: 7,
          threads: [thread],
          worktrees: [
            makeWorktree(environmentA, {
              prState: "merged",
              prTerminalAt: "2026-07-31T09:00:00.000Z",
            }),
          ],
        }),
      );

      expect(inbox.active.map((entry) => entry.thread?.id)).toEqual([thread.id]);
      expect(inbox.active[0]?.lifecycle.autoSettlementBlocker).toBeNull();
      expect(inbox.nextSettlementEvaluationAtMs).toBe(Date.parse("2026-08-07T10:00:00.000Z"));
    });

    it("settles a merged PR that closed after the last activity at its close time", () => {
      const thread = makeThread(environmentA, "thread-merged-later", {
        worktreeId,
        latestUserMessageAt: "2026-07-31T10:00:00.000Z",
      });
      const inbox = buildThreadInbox(
        baseInput({
          threads: [thread],
          worktrees: [
            makeWorktree(environmentA, {
              prState: "merged",
              prTerminalAt: "2026-07-31T11:00:00.000Z",
            }),
          ],
        }),
      );

      expect(inbox.settled.map((entry) => entry.thread?.id)).toEqual([thread.id]);
      expect(inbox.settled[0]?.lifecycle.effectiveSettlementTimestamp).toBe(
        "2026-07-31T11:00:00.000Z",
      );
    });

    it("keeps the legacy merged rule when the server omits prTerminalAt", () => {
      const thread = makeThread(environmentA, "thread-legacy-merged", {
        worktreeId,
        latestUserMessageAt: "2026-07-31T10:00:00.000Z",
      });
      const inbox = buildThreadInbox(
        baseInput({
          threads: [thread],
          worktrees: [makeWorktree(environmentA, { prState: "merged" })],
        }),
      );

      expect(inbox.settled.map((entry) => entry.thread?.id)).toEqual([thread.id]);
    });
  });

  it("excludes archived threads and worktrees before applying filters", () => {
    const archivedThread = makeThread(environmentA, "thread-archived", {
      archivedAt: "2026-07-31T10:00:00.000Z",
    });
    const archivedWorktreeThread = makeThread(environmentA, "thread-worktree-archived", {
      worktreeId,
    });
    const visible = makeThread(environmentB, "thread-visible");
    const inbox = buildThreadInbox(
      baseInput({
        threads: [archivedThread, archivedWorktreeThread, visible],
        worktrees: [
          makeWorktree(environmentA, {
            archivedAt: "2026-07-31T10:00:00.000Z",
          }),
        ],
        filters: { environmentIds: [environmentA] },
      }),
    );

    expect(inbox.active).toEqual([]);
    expect(inbox.settled).toEqual([]);
    expect(inbox.excludedCount).toBe(2);
  });

  it("keeps queue and delivery-unknown rows active", () => {
    const queued = makeThread(environmentA, "thread-queued", {
      settledOverride: "settled",
      settledAt: "2026-07-31T09:00:00.000Z",
    });
    const unknown = makeThread(environmentA, "thread-unknown", {
      settledOverride: "settled",
      settledAt: "2026-07-31T09:00:00.000Z",
    });
    const queuedKey = scopedThreadKey({
      environmentId: environmentA,
      threadId: queued.id,
    });
    const unknownKey = scopedThreadKey({
      environmentId: environmentA,
      threadId: unknown.id,
    });
    const inbox = buildThreadInbox(
      baseInput({
        threads: [queued, unknown],
        localQueuedThreadKeys: new Set([queuedKey]),
        deliveryUnknownThreadKeys: new Set([unknownKey]),
      }),
    );

    expect(inbox.active.map((entry) => entry.lifecycle.settlementBlocker).toSorted()).toEqual([
      "delivery-unknown",
      "local-queue",
    ]);
    expect(inbox.settled).toEqual([]);
  });

  it("treats an actionable proposed plan as pending input", () => {
    const thread = makeThread(environmentA, "thread-plan", {
      hasActionableProposedPlan: true,
      interactionMode: "plan",
      latestTurn: {
        turnId: TurnId.make("plan-turn"),
        state: "completed",
        requestedAt: "2026-07-01T00:00:00.000Z",
        startedAt: "2026-07-01T00:00:00.000Z",
        completedAt: "2026-07-01T00:00:01.000Z",
        assistantMessageId: null,
      },
      latestUserMessageAt: "2026-07-01T00:00:00.000Z",
    });
    const inbox = buildThreadInbox(baseInput({ threads: [thread], autoSettleAfterDays: 7 }));

    expect(inbox.active[0]?.lifecycle.settlementBlocker).toBe("pending-user-input");
    expect(inbox.settled).toEqual([]);
  });

  it("keeps local drafts active and removes them once their promoted thread exists", () => {
    const realThread = makeThread(environmentA, "thread-real");
    const promotedTo = {
      environmentId: environmentA,
      threadId: realThread.id,
    };
    const draft: ThreadInboxDraftSummary = {
      environmentId: environmentA,
      threadId: ThreadId.make("thread-draft"),
      projectId,
      title: "Draft",
      createdAt: "2026-07-31T11:00:00.000Z",
      branch: null,
      worktreePath: null,
      promotedTo,
    };
    const beforePromotion = buildThreadInbox(baseInput({ drafts: [draft] }));
    const afterPromotion = buildThreadInbox(baseInput({ drafts: [draft], threads: [realThread] }));

    expect(beforePromotion.active).toHaveLength(1);
    expect(beforePromotion.active[0]).toMatchObject({
      isDraft: true,
      mutationEnabled: false,
      mutationBlocker: "client-draft",
    });
    expect(afterPromotion.active).toHaveLength(1);
    expect(afterPromotion.active[0]?.thread).toBe(realThread);
  });

  it("uses stable active ordering and settlement-time ordering", () => {
    const oldest = makeThread(environmentA, "thread-old", {
      createdAt: "2026-07-31T01:00:00.000Z",
    });
    const newest = makeThread(environmentA, "thread-new", {
      createdAt: "2026-07-31T03:00:00.000Z",
      updatedAt: "2026-07-31T11:59:00.000Z",
    });
    const pinned = makeThread(environmentB, "thread-pinned", {
      createdAt: "2026-07-31T00:00:00.000Z",
    });
    const settledEarly = makeThread(environmentA, "thread-settled-early", {
      settledOverride: "settled",
      settledAt: "2026-07-31T08:00:00.000Z",
    });
    const settledLate = makeThread(environmentA, "thread-settled-late", {
      settledOverride: "settled",
      settledAt: "2026-07-31T10:00:00.000Z",
    });
    const pinnedKey = scopedThreadKey({
      environmentId: pinned.environmentId,
      threadId: pinned.id,
    });
    const inbox = buildThreadInbox(
      baseInput({
        threads: [oldest, newest, pinned, settledEarly, settledLate],
        pinnedThreadKeys: [pinnedKey],
      }),
    );

    expect(inbox.active.map((entry) => entry.thread?.id)).toEqual([
      pinned.id,
      newest.id,
      oldest.id,
    ]);
    expect(inbox.settled.map((entry) => entry.thread?.id)).toEqual([
      settledLate.id,
      settledEarly.id,
    ]);
  });

  it("derives a duplicate-free Focus partition from scoped projected rankings", () => {
    const rankedAt = new Date(nowMs - 60_000).toISOString();
    const usableUntil = new Date(nowMs + 60_000).toISOString();
    const ranked = (environmentId: EnvironmentId) =>
      makeThread(environmentId, "shared-thread-id", {
        priority: {
          tier: "now",
          confidence: "high",
          reason: ThreadPriorityReason.make("Actionable next work"),
          inputFingerprint: ThreadPriorityFingerprint.make(`fingerprint-${environmentId}`),
          batchId: ThreadPriorityBatchId.make(`batch-${environmentId}`),
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          rankedAt,
          usableUntil,
        },
      });
    const approval = makeThread(environmentA, "approval", { hasPendingApprovals: true });
    const active = makeThread(environmentB, "active");
    const inbox = buildThreadInbox(
      baseInput({
        threads: [ranked(environmentA), ranked(environmentB), approval, active],
        aiFocusEnabled: true,
      }),
    );

    expect(inbox.focus.map((entry) => [entry.key, entry.focus?.source])).toEqual([
      [scopedThreadKey({ environmentId: environmentA, threadId: approval.id }), "approval"],
      [
        scopedThreadKey({
          environmentId: environmentA,
          threadId: ThreadId.make("shared-thread-id"),
        }),
        "ai",
      ],
      [
        scopedThreadKey({
          environmentId: environmentB,
          threadId: ThreadId.make("shared-thread-id"),
        }),
        "ai",
      ],
    ]);
    expect(inbox.active.map((entry) => entry.thread?.id)).toEqual([active.id]);
    expect(new Set([...inbox.focus, ...inbox.active].map((entry) => entry.key)).size).toBe(4);
  });

  it("composes filters while retaining the currently routed settled row", () => {
    const settled = makeThread(environmentA, "thread-current", {
      title: "Needle",
      settledOverride: "settled",
      settledAt: "2026-07-31T10:00:00.000Z",
      worktreeId,
    });
    const key = scopedThreadKey({
      environmentId: settled.environmentId,
      threadId: settled.id,
    });
    const inbox = buildThreadInbox(
      baseInput({
        threads: [settled],
        worktrees: [makeWorktree(environmentA)],
        currentThreadKey: key,
        filters: {
          environmentIds: [environmentB],
          projectKeys: [
            scopedProjectKey({
              environmentId: environmentB,
              projectId,
            }),
          ],
          worktreeKeys: [scopedInboxWorktreeKey(environmentB, worktreeId)],
          text: "not present",
        },
      }),
    );

    expect(inbox.settled).toHaveLength(1);
    expect(inbox.settled[0]).toMatchObject({ key, current: true });
  });
});

describe("snoozed inbox entries", () => {
  const until = "2026-07-31T13:00:00.000Z";
  const since = "2026-07-31T11:00:00.000Z";
  const build = (overrides: Partial<BuildThreadInboxInput> = {}) =>
    buildThreadInbox({
      projects: [],
      worktrees: [],
      threads: [
        makeThread(environmentA, "snoozed", {
          snoozedAt: since,
          snoozedUntil: until,
          settledOverride: "active",
        }),
      ],
      environments: [makeEnvironment(environmentA, { threadSnoozeSupported: true })],
      nowMs,
      ...overrides,
    });
  it("keeps pins while suppressing focus and schedules the next wake", () => {
    const key = scopedThreadKey({
      environmentId: environmentA,
      threadId: ThreadId.make("snoozed"),
    });
    const inbox = build({ pinnedThreadKeys: [key], aiFocusEnabled: true });
    expect(inbox.active).toHaveLength(0);
    expect(inbox.focus).toHaveLength(0);
    expect(inbox.snoozed[0]).toMatchObject({ pinned: true, canSnooze: true });
    expect(inbox.nextSettlementEvaluationAtMs).toBe(Date.parse(until));
    const awake = build({ nowMs: Date.parse(until), pinnedThreadKeys: [key] });
    expect(awake.snoozed).toHaveLength(0);
    expect(awake.active[0]?.pinned).toBe(true);
  });
  it.each([
    { threadSnoozeSupported: false },
    { mutationReady: false },
    { shellCurrent: false },
    { connected: false },
  ])("gates mutation for %j", (environment) => {
    expect(
      build({
        environments: [
          makeEnvironment(environmentA, { threadSnoozeSupported: true, ...environment }),
        ],
      }).snoozed[0]?.canSnooze,
    ).toBe(false);
  });
  it("never suppresses pending requests or local undelivered work", () => {
    const thread = makeThread(environmentA, "snoozed", {
      snoozedAt: since,
      snoozedUntil: until,
      hasPendingApprovals: true,
    });
    expect(build({ threads: [thread] }).snoozed).toHaveLength(0);
    const key = scopedThreadKey({ environmentId: environmentA, threadId: thread.id });
    const inbox = build({ localQueuedThreadKeys: [key] });
    expect(inbox.snoozed).toHaveLength(0);
    expect(inbox.active[0]?.canSnooze).toBe(false);
  });
});

describe("deriveThreadSnoozeEligibility", () => {
  it("is blocked by a locally queued message, like the inbox", () => {
    const thread = makeThread(environmentA, "thread-snooze", {
      latestUserMessageAt: "2026-07-31T10:00:00.000Z",
    });
    const environment = makeEnvironment(environmentA);
    expect(
      deriveThreadSnoozeEligibility({ thread, environment, hasLocalQueuedMessage: false, nowMs })
        .canSnooze,
    ).toBe(true);
    expect(
      deriveThreadSnoozeEligibility({ thread, environment, hasLocalQueuedMessage: true, nowMs }),
    ).toEqual({ canSnooze: false, blocker: "local-queue" });
  });
});
