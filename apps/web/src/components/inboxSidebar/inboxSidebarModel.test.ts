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

  it("moves an inactivity-eligible row into Settled only when enabled", () => {
    const inactive = thread("inactive", {
      latestUserMessageAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-25T09:59:00.000Z",
    });
    const nowMs = Date.parse("2026-08-25T10:00:00.000Z");

    expect(build({ threads: [inactive], nowMs })[0]?.key).toBe("recent");
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

    expect(sections.map((section) => section.key)).toEqual(["focus", "active"]);
    expect(sections[0]?.rows.map((row) => row.threadId)).toEqual(["pinned", "ai-now"]);
    expect(sections[1]?.rows.map((row) => row.threadId)).toEqual(["working"]);
    const allKeys = sections.flatMap((section) => section.rows.map((row) => row.key));
    expect(new Set(allKeys).size).toBe(allKeys.length);
  });

  it("preserves the existing sections exactly when AI Focus is disabled", () => {
    const sections = build({
      aiFocusEnabled: false,
      pinnedThreadKeys: new Set(["machine-a:pinned"]),
      threads: [thread("pinned")],
    });
    expect(sections.map((section) => section.key)).toEqual(["recent"]);
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
