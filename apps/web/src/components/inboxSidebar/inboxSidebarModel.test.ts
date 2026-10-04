import { Schema } from "effect";
import { ServerProvider } from "@ryco/contracts";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import type {
  Project,
  SidebarThreadSummary,
  SidebarWorktreeSummary,
} from "@ryco/client-runtime/state/threads";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type SidebarAutoSettleAfterDays,
  ThreadId,
  WorktreeId,
  TurnId,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyInboxServerConfig,
  buildInboxSidebarSections,
  buildPrimaryInboxSidebarEnvironment,
  describeInboxFocus,
  type InboxSidebarEnvironment,
  type InboxSidebarFilters,
} from "./inboxSidebarModel";

const ENV_A = EnvironmentId.make("machine-a");
const ENV_B = EnvironmentId.make("machine-b");
const PROJECT_A = ProjectId.make("project-a");

function project(environmentId = ENV_A): Project {
  return {
    id: PROJECT_A,
    environmentId,
    name: "Ryco",
    cwd: "/repo/ryco",
    defaultModelSelection: null,
    scripts: [],
  };
}

function thread(id: string, overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make(id),
    environmentId: ENV_A,
    projectId: PROJECT_A,
    title: id,
    interactionMode: "default",
    session: null,
    createdAt: "2026-08-23T10:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-08-23T10:00:00.000Z",
    latestTurn: null,
    branch: "main",
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function environment(
  environmentId: EnvironmentId,
  overrides: Partial<InboxSidebarEnvironment> = {},
): InboxSidebarEnvironment {
  return {
    environmentId,
    label: environmentId,
    connectionState: "connected",
    stale: false,
    role: "owner",
    trust: "verified",
    deliveryUnknown: false,
    threadSettlementSupported: true,
    mutationReady: true,
    shellCurrent: true,
    ...overrides,
  };
}

const ALL_FILTERS: InboxSidebarFilters = {
  query: "",
  environmentId: null,
  status: "all",
};

describe("buildPrimaryInboxSidebarEnvironment", () => {
  it("identifies a connected primary environment as Studio Mac", () => {
    expect(
      buildPrimaryInboxSidebarEnvironment({
        label: "Studio Mac",
        environmentId: ENV_A,
        connectionState: "connected",
        hydratedFromCache: false,
        threadSettlementSupported: true,
      }),
    ).toEqual({
      environmentId: ENV_A,
      label: "Studio Mac",
      connectionState: "connected",
      stale: false,
      role: "owner",
      trust: "not-required",
      deliveryUnknown: false,
      threadSettlementSupported: true,
      mutationReady: true,
      shellCurrent: true,
    });
  });

  it("keeps an actually cached primary environment visibly stale", () => {
    expect(
      buildPrimaryInboxSidebarEnvironment({
        label: "Studio Mac",
        environmentId: ENV_A,
        connectionState: "offline",
        hydratedFromCache: true,
        threadSettlementSupported: true,
      }),
    ).toMatchObject({
      label: "Studio Mac",
      connectionState: "offline",
      stale: true,
      staleDetail: "Offline · last known",
    });
  });
});

function build(input: {
  threads: ReadonlyArray<SidebarThreadSummary>;
  environments?: ReadonlyArray<InboxSidebarEnvironment>;
  filters?: InboxSidebarFilters;
  worktrees?: ReadonlyArray<SidebarWorktreeSummary>;
  aiFocusEnabled?: boolean;
  autoSettleAfterDays?: SidebarAutoSettleAfterDays;
  pinnedThreadKeys?: ReadonlySet<string>;
  primaryEnvironmentId?: EnvironmentId | null;
  nestDelegated?: boolean;
  nowMs?: number;
}) {
  return buildInboxSidebarSections({
    projects: [project(ENV_A), project(ENV_B)],
    worktrees: input.worktrees ?? [],
    threads: input.threads,
    environments: input.environments ?? [environment(ENV_A), environment(ENV_B)],
    filters: input.filters ?? ALL_FILTERS,
    ...(input.aiFocusEnabled !== undefined ? { aiFocusEnabled: input.aiFocusEnabled } : {}),
    ...(input.autoSettleAfterDays !== undefined
      ? { autoSettleAfterDays: input.autoSettleAfterDays }
      : {}),
    ...(input.pinnedThreadKeys !== undefined ? { pinnedThreadKeys: input.pinnedThreadKeys } : {}),
    ...(input.primaryEnvironmentId !== undefined
      ? { primaryEnvironmentId: input.primaryEnvironmentId }
      : {}),
    ...(input.nestDelegated !== undefined ? { nestDelegated: input.nestDelegated } : {}),
    ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
  });
}

describe("buildInboxSidebarSections", () => {
  it("resolves model aliases from the owning environment and retains project identity", () => {
    const provider = Schema.decodeUnknownSync(ServerProvider)({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-08-25T00:00:00.000Z",
      models: [
        {
          slug: "claude-opus-5",
          aliases: ["opus"],
          name: "Claude Opus 5",
          isCustom: false,
          capabilities: null,
        },
      ],
    });
    const selection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" };
    const rows = build({
      threads: [
        thread("local", { modelSelection: selection }),
        thread("worktree", { modelSelection: selection, worktreePath: "/repo/worktrees/task" }),
        thread("remote", { environmentId: ENV_B, modelSelection: selection }),
      ],
      environments: [environment(ENV_A, { providers: [provider] }), environment(ENV_B)],
    }).flatMap((section) => section.rows);
    expect(rows.find((row) => row.title === "local")).toMatchObject({
      modelLabel: "Opus 5",
      isWorktree: false,
      project: project(ENV_A),
    });
    expect(rows.find((row) => row.title === "worktree")).toMatchObject({ isWorktree: true });
    expect(rows.find((row) => row.title === "remote")).toMatchObject({
      modelLabel: null,
      project: project(ENV_B),
    });
  });

  it("tracks a plan follow-up through running, connecting and settled states like the chat sidebar", () => {
    const planned = thread("plan", {
      interactionMode: "plan",
      hasActionableProposedPlan: true,
      latestTurn: {
        turnId: TurnId.make("plan-turn"),
        state: "completed",
        requestedAt: "2026-08-23T10:00:00.000Z",
        startedAt: "2026-08-23T10:00:00.000Z",
        completedAt: "2026-08-23T10:01:00.000Z",
        assistantMessageId: null,
      },
    });
    const row = (value: SidebarThreadSummary) =>
      build({ threads: [value] }).flatMap((section) => section.rows)[0]!;
    expect(row(planned).state).toBe("needs-input");
    expect(resolveThreadStatusPill({ thread: planned })?.label).toBe("Plan Ready");
    for (const status of ["running", "connecting"] as const) {
      const active = {
        ...planned,
        session: {
          provider: ProviderDriverKind.make("codex"),
          status,
          orchestrationStatus: status === "running" ? ("running" as const) : ("starting" as const),
          createdAt: planned.createdAt,
          updatedAt: planned.createdAt,
        },
      };
      expect(row(active).state).toBe(status === "running" ? "working" : "connecting");
      expect(row(active).settlementDisabledReason).toBe("Wait for the running work to finish.");
      expect(resolveThreadStatusPill({ thread: active })?.label).toBe(
        status === "running" ? "Working" : "Connecting",
      );
      expect(row({ ...active, hasPendingUserInput: true }).state).toBe("needs-input");
      expect(row({ ...active, hasPendingApprovals: true }).state).toBe("needs-input");
    }
    expect(row({ ...planned, interactionMode: "default" }).state).toBe("idle");
    expect(row({ ...planned, interactionMode: "default" }).settlementActionEnabled).toBe(true);
    expect(row(planned).state).toBe("needs-input");
  });

  it("groups active work, required input, and recency without losing machine scope", () => {
    const sections = build({
      threads: [
        thread("working", {
          latestTurn: {
            turnId: "turn-working" as never,
            state: "running",
            requestedAt: "2026-08-23T10:00:00.000Z",
            startedAt: "2026-08-23T10:00:01.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
        }),
        thread("approval", { hasPendingApprovals: true }),
        thread("recent", { environmentId: ENV_B, updatedAt: "2026-08-23T11:00:00.000Z" }),
      ],
    });

    expect(sections.map((section) => section.key)).toEqual(["active", "needs-input", "recent"]);
    expect(sections[0]?.rows[0]).toMatchObject({
      key: "machine-a:working",
      machineLabel: "machine-a",
      statusLabel: "Working",
    });
    expect(sections[1]?.rows[0]?.threadId).toBe("approval");
    expect(sections[2]?.rows[0]).toMatchObject({
      key: "machine-b:recent",
      machineLabel: "machine-b",
    });
  });

  it("demotes stale cached activity and pending input to offline Recent", () => {
    const sections = build({
      environments: [
        environment(ENV_A, {
          stale: true,
          staleDetail: "Offline · last seen 4m ago",
        }),
      ],
      threads: [thread("stale", { hasPendingUserInput: true })],
    });

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ key: "recent" });
    expect(sections[0]?.rows[0]).toMatchObject({
      state: "offline",
      statusLabel: "Offline · last seen 4m ago",
    });
  });

  it("keeps an online demand-released machine idle instead of calling it offline", () => {
    const sections = build({
      environments: [
        environment(ENV_A, {
          connectionState: "idle",
          stale: false,
        }),
      ],
      threads: [thread("leased down")],
    });

    expect(sections).toHaveLength(1);
    expect(sections[0]?.rows[0]).toMatchObject({
      state: "idle",
      statusLabel: "Idle",
    });
  });

  it("uses the existing delivery, trust, role, and provider vocabulary per row", () => {
    const sections = build({
      environments: [
        environment(ENV_A, {
          deliveryUnknown: true,
          trust: "unverified",
          role: "viewer",
        }),
      ],
      threads: [
        thread("uncertain", {
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet",
          },
        }),
      ],
    });

    expect(sections[0]?.rows[0]).toMatchObject({
      state: "delivery-unknown",
      statusLabel: "Check delivery",
      trustLabel: "Not verified",
      roleLabel: "Viewer",
      providerDriver: ProviderDriverKind.make("claudeAgent"),
      providerLabel: "Claude",
    });
  });

  it("applies search, machine, and status filters deterministically", () => {
    const rows = [
      thread("older match", { updatedAt: "2026-08-23T10:00:00.000Z" }),
      thread("newer match", {
        environmentId: ENV_B,
        updatedAt: "2026-08-23T11:00:00.000Z",
      }),
      thread("working match", {
        environmentId: ENV_B,
        backgroundLiveness: "working",
        updatedAt: "2026-08-23T09:00:00.000Z",
      }),
    ];

    const recent = build({
      threads: rows,
      filters: { query: "match", environmentId: ENV_B, status: "recent" },
    });
    expect(recent.flatMap((section) => section.rows.map((row) => row.threadId))).toEqual([
      "newer match",
    ]);

    const active = build({
      threads: rows,
      filters: { query: "match", environmentId: ENV_B, status: "active" },
    });
    expect(active.flatMap((section) => section.rows.map((row) => row.threadId))).toEqual([
      "working match",
    ]);
  });

  it("orders Recent by creation or finished responses, ignoring live updates and prompts", () => {
    const newer = thread("newer", { createdAt: "2026-08-23T11:00:00.000Z" });
    const older = thread("older", {
      latestCompletedTurnAt: null,
      updatedAt: "2026-08-23T12:00:00.000Z",
      latestUserMessageAt: "2026-08-23T12:00:00.000Z",
    });
    const order = (value: SidebarThreadSummary) =>
      build({ threads: [value, newer], autoSettleAfterDays: null }).flatMap((section) =>
        section.rows.map((row) => row.threadId),
      );
    expect(order(older)).toEqual(["newer", "older"]);
    const completed = { ...older, latestCompletedTurnAt: "2026-08-23T12:01:00.000Z" };
    expect(order(completed)).toEqual(["older", "newer"]);
    expect(order({ ...completed, updatedAt: "2026-08-23T13:00:00.000Z" })).toEqual([
      "older",
      "newer",
    ]);
    expect(build({ threads: [completed], autoSettleAfterDays: null })[0]?.rows[0]?.updatedAt).toBe(
      completed.latestCompletedTurnAt,
    );
  });

  it("keeps active and pinned ordering stable through a subsequent turn's intermediate messages", () => {
    const oldCompletion = "2026-08-23T10:30:00.000Z";
    const running = thread("running", {
      backgroundLiveness: "working",
      latestCompletedTurnAt: oldCompletion,
      latestTurn: {
        turnId: TurnId.make("running-turn"),
        state: "completed",
        requestedAt: "2026-08-23T12:00:00.000Z",
        startedAt: "2026-08-23T12:00:00.000Z",
        completedAt: "2026-08-23T12:01:00.000Z",
        assistantMessageId: null,
      },
    });
    const other = thread("other", {
      backgroundLiveness: "working",
      createdAt: "2026-08-23T11:00:00.000Z",
    });
    for (const pinnedThreadKeys of [
      new Set<string>(),
      new Set(["machine-a:running", "machine-a:other"]),
    ]) {
      for (const updatedAt of ["2026-08-23T12:01:00.000Z", "2026-08-23T12:02:00.000Z"]) {
        const rows = build({
          threads: [{ ...running, updatedAt }, other],
          pinnedThreadKeys,
          autoSettleAfterDays: null,
        })[0]!.rows;
        expect(rows.map((row) => row.threadId)).toEqual(["other", "running"]);
        expect(rows[1]?.updatedAt).toBe(oldCompletion);
      }
    }
  });

  it("uses only completed turns as a fallback for older servers", () => {
    for (const state of ["running", "interrupted", "error", "completed"] as const) {
      const value = thread("legacy", {
        latestTurn: {
          turnId: TurnId.make("legacy-turn"),
          state,
          requestedAt: "2026-08-23T11:00:00.000Z",
          startedAt: "2026-08-23T11:00:00.000Z",
          completedAt: "2026-08-23T12:00:00.000Z",
          assistantMessageId: null,
        },
      });
      const row = build({ threads: [value], autoSettleAfterDays: null })[0]!.rows[0]!;
      expect(row.updatedAt).toBe(
        state === "completed" ? value.latestTurn!.completedAt : value.createdAt,
      );
    }
  });

  it("puts all pinned threads first without duplicates and supports the Pinned filter", () => {
    const threads = [
      thread("pin-idle"),
      thread("pin-working", { backgroundLiveness: "working" }),
      thread("pin-input", { hasPendingApprovals: true }),
      thread("pin-settled", { settledOverride: "settled", settledAt: "2026-08-23T12:00:00.000Z" }),
      thread("recent"),
    ];
    const pinnedThreadKeys = new Set(threads.slice(0, 4).map((value) => `machine-a:${value.id}`));
    const sections = build({ threads, pinnedThreadKeys });
    expect(sections.map((section) => section.key)).toEqual(["pinned", "recent"]);
    expect(sections[0]?.title).toBe("Pinned");
    expect(sections[0]?.rows).toHaveLength(4);
    expect(sections.flatMap((section) => section.rows)).toHaveLength(5);
    expect(
      build({ threads, pinnedThreadKeys, filters: { ...ALL_FILTERS, status: "pinned" } }),
    ).toEqual([sections[0]]);
    expect(
      build({ threads, pinnedThreadKeys: new Set() }).some((section) => section.key === "pinned"),
    ).toBe(false);
  });

  it("uses stable scoped-key ordering when timestamps tie", () => {
    const sections = build({
      threads: [thread("z"), thread("a")],
    });
    expect(sections[0]?.rows.map((row) => row.threadId)).toEqual(["a", "z"]);
  });

  it("adds a scoped Settled shelf without changing the owning route", () => {
    const sections = build({
      threads: [
        thread("done", {
          environmentId: ENV_B,
          settledOverride: "settled",
          settledAt: "2026-08-23T12:00:00.000Z",
        }),
      ],
    });

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ key: "settled", title: "Settled" });
    expect(sections[0]?.rows[0]).toMatchObject({
      key: "machine-b:done",
      environmentId: ENV_B,
      settled: true,
      settlementActionEnabled: true,
      effectiveSettlementTimestamp: "2026-08-23T12:00:00.000Z",
    });
  });

  it("settles inactive work by default and respects Off and custom intervals", () => {
    const inactive = thread("inactive", {
      latestUserMessageAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-25T09:59:00.000Z",
    });
    const nowMs = Date.parse("2026-08-25T10:00:00.000Z");

    expect(build({ threads: [inactive], nowMs })[0]?.key).toBe("settled");
    expect(build({ threads: [inactive], nowMs, autoSettleAfterDays: null })[0]?.key).toBe("recent");
    const enabled = build({
      threads: [inactive],
      autoSettleAfterDays: 14,
      nowMs,
    });
    expect(enabled[0]).toMatchObject({ key: "settled" });
    expect(enabled[0]?.rows[0]).toMatchObject({
      settled: true,
      effectiveSettlementTimestamp: "2026-08-24T10:00:00.000Z",
    });
  });

  it("keeps mixed-version environments Active-only and blocks unsupported commands", () => {
    const sections = build({
      environments: [environment(ENV_A, { threadSettlementSupported: false })],
      threads: [
        thread("legacy", {
          settledOverride: "settled",
          settledAt: "2026-08-23T12:00:00.000Z",
        }),
      ],
    });

    expect(sections[0]?.key).toBe("recent");
    expect(sections[0]?.rows[0]).toMatchObject({
      settled: false,
      settlementActionEnabled: false,
      settlementDisabledReason: "Update this machine to use Settle.",
    });
  });

  it("renders Focus above Active and removes every focused row from its old section", () => {
    const sections = build({
      aiFocusEnabled: true,
      pinnedThreadKeys: new Set(["machine-a:pinned"]),
      nowMs: Date.parse("2026-08-25T10:00:00.000Z"),
      threads: [
        thread("pinned"),
        thread("working", { backgroundLiveness: "working" }),
        thread("ai-now", {
          priority: {
            tier: "now",
            confidence: "high",
            reason: "A release decision is waiting on this task.",
            inputFingerprint: "fingerprint" as never,
            batchId: "batch" as never,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            rankedAt: "2026-08-25T09:59:00.000Z",
            usableUntil: "2026-08-25T10:09:00.000Z",
          },
        }),
      ],
    });

    expect(sections.map((section) => section.key)).toEqual(["pinned", "focus", "active"]);
    expect(sections[0]?.rows.map((row) => row.threadId)).toEqual(["pinned"]);
    expect(sections[1]?.rows.map((row) => row.threadId)).toEqual(["ai-now"]);
    expect(sections[2]?.rows.map((row) => row.threadId)).toEqual(["working"]);
    const allKeys = sections.flatMap((section) => section.rows.map((row) => row.key));
    expect(new Set(allKeys).size).toBe(allKeys.length);
  });

  it("keeps a separate Pinned section when AI Focus is disabled", () => {
    const sections = build({
      aiFocusEnabled: false,
      pinnedThreadKeys: new Set(["machine-a:pinned"]),
      threads: [thread("pinned")],
    });
    expect(sections.map((section) => section.key)).toEqual(["pinned"]);
    expect(sections[0]?.rows[0]?.focus).toBeNull();
  });
});

describe("describeInboxFocus", () => {
  it("never describes deterministic focus as AI-generated", () => {
    expect(describeInboxFocus({ source: "pin", ranking: null })).toEqual({
      title: "Pinned",
      detail: "Pinned by you.",
      aiGenerated: false,
    });
    expect(describeInboxFocus({ source: "approval", ranking: null }).aiGenerated).toBe(false);
  });

  it("uses the bounded projected tier and reason for AI focus", () => {
    expect(
      describeInboxFocus({
        source: "ai",
        ranking: {
          tier: "soon",
          confidence: "medium",
          reason: "A review should happen next.",
          inputFingerprint: "fingerprint" as never,
          batchId: "batch" as never,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          rankedAt: "2026-08-25T09:59:00.000Z",
          usableUntil: "2026-08-25T10:09:00.000Z",
        },
      }),
    ).toEqual({
      title: "Soon",
      detail: "A review should happen next.",
      aiGenerated: true,
    });
  });
});

describe("inbox PR badges", () => {
  const worktree: SidebarWorktreeSummary = {
    id: WorktreeId.make("pr-worktree"),
    environmentId: ENV_A,
    projectId: PROJECT_A,
    title: "Feature",
    branch: "feature/pr",
    worktreePath: "/repo/pr",
    origin: "pr",
    prNumber: 42,
    issueNumber: null,
    prTitle: "Pull request",
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
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    archivedAt: null,
    manualPosition: 0,
  };
  it.each(["open", "closed", "merged"] as const)(
    "exposes %s PR metadata directly on the row",
    (state) => {
      const rows = build({
        threads: [thread("pr", { worktreeId: worktree.id })],
        worktrees: [{ ...worktree, prState: state, prIsDraft: state === "open" }],
      }).flatMap((section) => section.rows);
      expect(rows[0]?.pullRequest).toEqual({ number: 42, state, isDraft: state === "open" });
    },
  );
  it("does not label an issue as a pull request or borrow another machine's PR", () => {
    const rows = build({
      threads: [
        thread("issue", { worktreeId: worktree.id }),
        thread("other", { environmentId: ENV_B, worktreeId: worktree.id }),
      ],
      worktrees: [{ ...worktree, prNumber: null, issueNumber: 12 }],
    }).flatMap((section) => section.rows);
    expect(rows.every((row) => row.pullRequest === null)).toBe(true);
  });
});

describe("hosted inbox capability resolution", () => {
  const liveConfig = {
    environment: {
      environmentId: ENV_A,
      label: "Node name",
      platform: { os: "darwin" as const, arch: "arm64" as const },
      serverVersion: "1.0.0",
      capabilities: {
        repositoryIdentity: true,
        threadSettlement: true,
        threadSnooze: true,
        threadPriorityRanking: false,
      },
    },
    providers: [],
  };
  const inactive = thread("old", { latestUserMessageAt: "2026-08-23T10:00:00.000Z" });
  it("enables snooze and auto-settlement after a live node replaces directory capability defaults", () => {
    const initial = environment(ENV_A, {
      threadSettlementSupported: false,
      threadSnoozeSupported: false,
    });
    const live = applyInboxServerConfig(initial, liveConfig);
    const sections = build({
      threads: [inactive],
      environments: [live],
      autoSettleAfterDays: 3,
      nowMs: Date.parse("2026-09-11T10:00:00Z"),
    });
    expect(sections.find((section) => section.key === "settled")?.rows[0]).toMatchObject({
      title: "old",
      canSnooze: true,
      settlementActionEnabled: true,
    });
  });
  it.each([
    { mutationReady: false },
    { shellCurrent: false },
    { connectionState: "offline" as const, stale: true },
  ])("keeps mutations blocked with live capabilities and %o", (blocker) => {
    const live = applyInboxServerConfig(environment(ENV_A, blocker), liveConfig);
    const rows = build({ threads: [inactive], environments: [live] }).flatMap(
      (section) => section.rows,
    );
    expect(rows[0]).toMatchObject({ canSnooze: false, settlementActionEnabled: false });
  });
  it("does not borrow capabilities when no node config has arrived", () => {
    const initial = environment(ENV_A, { threadSettlementSupported: false });
    expect(applyInboxServerConfig(initial, null)).toBe(initial);
  });
});

describe("glyph row facts", () => {
  const rows = (input: Parameters<typeof build>[0]) =>
    build(input).flatMap((section) => section.rows);
  const running = (startedAt: string | null): Partial<SidebarThreadSummary> => ({
    latestTurn: {
      turnId: TurnId.make("turn-running"),
      state: "running",
      requestedAt: "2026-08-23T10:00:00.000Z",
      startedAt,
      completedAt: null,
      assistantMessageId: null,
    },
  });

  it("names what a needs-input thread waits on", () => {
    const [approval, input, plan] = rows({
      threads: [
        thread("approval", { hasPendingApprovals: true }),
        thread("input", { hasPendingUserInput: true }),
        thread("plan", {
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          latestTurn: {
            turnId: TurnId.make("turn-plan"),
            state: "completed",
            requestedAt: "2026-08-23T10:00:00.000Z",
            startedAt: "2026-08-23T10:00:01.000Z",
            completedAt: "2026-08-23T10:00:05.000Z",
            assistantMessageId: null,
          },
        }),
      ],
    }).toSorted((left, right) => left.title.localeCompare(right.title));
    expect([approval?.attention, input?.attention, plan?.attention]).toEqual([
      "approval",
      "input",
      "plan",
    ]);
  });

  it("keeps attention, error text and the run clock scoped to their state", () => {
    const [failed] = rows({
      threads: [
        thread("failed", {
          session: {
            provider: ProviderDriverKind.make("codex"),
            status: "error",
            orchestrationStatus: "error",
            lastError: "  Provider exited (code 1)  ",
            createdAt: "2026-08-23T10:00:00.000Z",
            updatedAt: "2026-08-23T10:00:00.000Z",
          },
        }),
      ],
    });
    expect(failed).toMatchObject({
      state: "error",
      errorDetail: "Provider exited (code 1)",
      attention: null,
      runningSince: null,
    });

    const [working] = rows({ threads: [thread("working", running("2026-08-23T10:00:02.000Z"))] });
    expect(working).toMatchObject({
      state: "working",
      runningSince: "2026-08-23T10:00:02.000Z",
      errorDetail: null,
    });
    const [queued] = rows({ threads: [thread("queued", running(null))] });
    expect(queued?.runningSince).toBe("2026-08-23T10:00:00.000Z");
  });

  it("exposes the latest turn completion for unseen-work checks", () => {
    const [done] = rows({
      threads: [
        thread("done", {
          latestTurn: {
            turnId: TurnId.make("turn-done"),
            state: "completed",
            requestedAt: "2026-08-23T10:00:00.000Z",
            startedAt: "2026-08-23T10:00:01.000Z",
            completedAt: "2026-08-23T10:04:00.000Z",
            assistantMessageId: null,
          },
        }),
      ],
    });
    expect(done?.latestTurnCompletedAt).toBe("2026-08-23T10:04:00.000Z");
  });

  it("labels machines only when threads span machines, never the primary one", () => {
    const local = thread("local");
    const remote = thread("remote", { environmentId: ENV_B });
    expect(rows({ threads: [local] }).map((row) => row.showMachine)).toEqual([false]);
    expect(
      rows({ threads: [remote], primaryEnvironmentId: ENV_A }).map((row) => row.showMachine),
    ).toEqual([false]);
    const mixed = rows({ threads: [local, remote], primaryEnvironmentId: ENV_A });
    expect(Object.fromEntries(mixed.map((row) => [row.title, row.showMachine]))).toEqual({
      local: false,
      remote: true,
    });
    const hosted = rows({ threads: [local, remote], primaryEnvironmentId: null });
    expect(hosted.every((row) => row.showMachine)).toBe(true);
  });

  it("names the project only once the inbox spans projects", () => {
    expect(rows({ threads: [thread("one"), thread("two")] }).some((row) => row.showProject)).toBe(
      false,
    );
    const other = ProjectId.make("project-other");
    const sections = buildInboxSidebarSections({
      projects: [project(ENV_A), { ...project(ENV_A), id: other, name: "Hub" }],
      worktrees: [],
      threads: [thread("one"), thread("two", { projectId: other })],
      environments: [environment(ENV_A)],
      filters: ALL_FILTERS,
    });
    expect(sections.flatMap((section) => section.rows).every((row) => row.showProject)).toBe(true);
  });
});

describe("delegated thread folding", () => {
  const delegatedFrom = (parent: string, root: string = parent) => ({
    parentThreadId: ThreadId.make(parent),
    rootThreadId: ThreadId.make(root),
    relationship: "delegated",
  });
  const working = { backgroundLiveness: "working" as const };
  const settled = {
    settledOverride: "settled" as const,
    settledAt: "2026-08-23T12:00:00.000Z",
  };
  const ids = (rows: ReadonlyArray<{ readonly threadId: string }> | undefined) =>
    (rows ?? []).map((row) => row.threadId);
  const section = (sections: ReturnType<typeof build>, key: string) =>
    sections.find((candidate) => candidate.key === key);

  it("folds an idle child under its idle parent and out of Recent", () => {
    const sections = build({
      threads: [thread("parent"), thread("child", { lineage: delegatedFrom("parent") })],
    });
    expect(sections.map((candidate) => candidate.key)).toEqual(["recent"]);
    expect(ids(section(sections, "recent")?.rows)).toEqual(["parent"]);
    expect(ids(section(sections, "recent")?.rows[0]?.delegatedChildren)).toEqual(["child"]);
  });

  it("keeps a working child in Active now under a Recent parent", () => {
    const sections = build({
      threads: [
        thread("parent"),
        thread("child", { lineage: delegatedFrom("parent"), ...working }),
      ],
    });
    expect(ids(section(sections, "active")?.rows)).toEqual(["child"]);
    expect(ids(section(sections, "recent")?.rows)).toEqual(["parent"]);
    expect(section(sections, "recent")?.rows[0]?.delegatedChildren).toEqual([]);
  });

  it("keeps a needs-input child in Needs input under a working parent", () => {
    const sections = build({
      threads: [
        thread("parent", working),
        thread("child", { lineage: delegatedFrom("parent"), hasPendingApprovals: true }),
      ],
    });
    expect(ids(section(sections, "active")?.rows)).toEqual(["parent"]);
    expect(ids(section(sections, "needs-input")?.rows)).toEqual(["child"]);
  });

  it("folds an idle child into a working host in Active now", () => {
    const sections = build({
      threads: [thread("parent", working), thread("child", { lineage: delegatedFrom("parent") })],
    });
    expect(sections.map((candidate) => candidate.key)).toEqual(["active"]);
    expect(ids(section(sections, "active")?.rows[0]?.delegatedChildren)).toEqual(["child"]);
  });

  it("folds a settled child under a Recent parent but not a Recent child under a Settled one", () => {
    const settledChild = build({
      threads: [
        thread("parent"),
        thread("child", { lineage: delegatedFrom("parent"), ...settled }),
      ],
    });
    expect(settledChild.map((candidate) => candidate.key)).toEqual(["recent"]);
    expect(ids(section(settledChild, "recent")?.rows[0]?.delegatedChildren)).toEqual(["child"]);

    const recentChild = build({
      threads: [thread("parent", settled), thread("child", { lineage: delegatedFrom("parent") })],
    });
    expect(ids(section(recentChild, "recent")?.rows)).toEqual(["child"]);
    expect(ids(section(recentChild, "settled")?.rows)).toEqual(["parent"]);
    expect(section(recentChild, "settled")?.rows[0]?.delegatedChildren).toEqual([]);
  });

  it("keeps pinned and focused children in Pinned and Focus", () => {
    const sections = build({
      aiFocusEnabled: true,
      pinnedThreadKeys: new Set(["machine-a:pinned-child"]),
      nowMs: Date.parse("2026-08-25T10:00:00.000Z"),
      autoSettleAfterDays: null,
      threads: [
        thread("parent"),
        thread("pinned-child", { lineage: delegatedFrom("parent") }),
        thread("focused-child", {
          lineage: delegatedFrom("parent"),
          priority: {
            tier: "now",
            confidence: "high",
            reason: "A release decision is waiting on this task.",
            inputFingerprint: "fingerprint" as never,
            batchId: "batch" as never,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            rankedAt: "2026-08-25T09:59:00.000Z",
            usableUntil: "2026-08-25T10:09:00.000Z",
          },
        }),
      ],
    });
    expect(ids(section(sections, "pinned")?.rows)).toEqual(["pinned-child"]);
    expect(ids(section(sections, "focus")?.rows)).toEqual(["focused-child"]);
    expect(section(sections, "recent")?.rows[0]?.delegatedChildren).toEqual([]);
  });

  it("flattens a grandchild under the topmost visible host", () => {
    const sections = build({
      threads: [
        thread("parent"),
        thread("child", { lineage: delegatedFrom("parent") }),
        thread("grandchild", { lineage: delegatedFrom("child", "parent") }),
      ],
    });
    const recent = section(sections, "recent");
    expect(ids(recent?.rows)).toEqual(["parent"]);
    expect(ids(recent?.rows[0]?.delegatedChildren)).toEqual(["child", "grandchild"]);
    expect(recent?.rows[0]?.delegatedChildren[0]?.delegatedChildren).toEqual([]);
  });

  it("shows flat rows for a text search and when nesting is off", () => {
    const threads = [
      thread("task-parent"),
      thread("task-child", { lineage: delegatedFrom("task-parent") }),
    ];
    const searched = build({ threads, filters: { ...ALL_FILTERS, query: "task" } });
    expect(ids(section(searched, "recent")?.rows)).toEqual(["task-child", "task-parent"]);

    const flat = build({ threads, nestDelegated: false });
    expect(ids(section(flat, "recent")?.rows)).toEqual(["task-child", "task-parent"]);
    expect(section(flat, "recent")?.rows.every((row) => row.delegatedChildren.length === 0)).toBe(
      true,
    );
  });

  it("leaves a child top-level when a status filter hides its host", () => {
    const sections = build({
      threads: [thread("parent", working), thread("child", { lineage: delegatedFrom("parent") })],
      filters: { ...ALL_FILTERS, status: "recent" },
    });
    expect(sections.map((candidate) => candidate.key)).toEqual(["recent"]);
    expect(ids(section(sections, "recent")?.rows)).toEqual(["child"]);
  });
});
