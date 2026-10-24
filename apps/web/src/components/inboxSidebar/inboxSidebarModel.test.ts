import { Schema } from "effect";
import type { SavedEnvironmentRuntimeState } from "@ryco/client-runtime/connection";
import { scopedProjectKey } from "@ryco/client-runtime/scoped";
import {
  forgetEnvironmentServerConfig,
  getReportedThreadCapabilitiesSnapshot,
  getShellSettlementRulesSnapshot,
  recordEnvironmentShellSettlementPolicy,
  resetEnvironmentServerConfigsForTests,
  writeEnvironmentServerConfig,
} from "@ryco/client-runtime/rpc";
import type { WorkspaceMachineCatalogEntry } from "@ryco/client-runtime/state/workspace";
import { ServerProvider, type ServerConfig } from "@ryco/contracts";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import type {
  Project,
  SidebarThreadSummary,
  SidebarWorktreeSummary,
  ThreadLifecycleAction,
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
import { ORPHANED_PROVIDER_SESSION_ERROR } from "@ryco/shared/restartContinuation";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  applyInboxServerConfig,
  buildInboxSidebarEnvironments,
  buildInboxSidebarModel,
  buildInboxSidebarSections,
  buildPrimaryInboxSidebarEnvironment,
  buildSavedInboxSidebarEnvironment,
  createInboxSidebarModelSharing,
  describeInboxFocus,
  resolveCurrentThreadLifecycle,
  sameInboxProviderCatalogs,
  threadLifecycleDisabledReason,
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

const SUPPORTED = { threadSettlement: true, threadSnooze: true } as const;

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
        capabilities: SUPPORTED,
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
      threadSnoozeSupported: true,
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
        capabilities: SUPPORTED,
      }),
    ).toMatchObject({
      label: "Studio Mac",
      connectionState: "offline",
      stale: true,
      staleDetail: "Offline · last known",
    });
  });
});

describe("buildSavedInboxSidebarEnvironment", () => {
  const runtime = (
    overrides: Partial<SavedEnvironmentRuntimeState>,
  ): SavedEnvironmentRuntimeState => ({
    connectionState: "connected",
    authState: "authenticated",
    lastError: null,
    lastErrorAt: null,
    role: "owner",
    descriptor: null,
    serverConfig: null,
    connectedAt: null,
    disconnectedAt: null,
    ...overrides,
  });

  it("tells the user to pair again instead of reconnecting forever", () => {
    const environment = buildSavedInboxSidebarEnvironment({
      environmentId: ENV_A,
      label: "Studio Mac",
      runtime: runtime({ connectionState: "error", authState: "requires-auth", role: null }),
      hydratedFromCache: true,
      capabilities: SUPPORTED,
    });

    expect(environment).toMatchObject({
      connectionState: "offline",
      stale: true,
      staleDetail: "Needs re-pair",
      mutationReady: false,
    });
    const sections = build({ environments: [environment], threads: [thread("paired")] });
    expect(sections[0]?.rows[0]).toMatchObject({ state: "offline", statusLabel: "Needs re-pair" });
  });

  it("keeps a transport error on the reconnecting path", () => {
    expect(
      buildSavedInboxSidebarEnvironment({
        environmentId: ENV_A,
        label: "Studio Mac",
        runtime: runtime({ connectionState: "error" }),
        hydratedFromCache: false,
        capabilities: SUPPORTED,
      }),
    ).toMatchObject({ connectionState: "reconnecting", staleDetail: "Offline · last known" });
  });

  it("is mutation-ready only while connected with a known role", () => {
    expect(
      buildSavedInboxSidebarEnvironment({
        environmentId: ENV_A,
        label: "Studio Mac",
        runtime: runtime({}),
        hydratedFromCache: false,
        capabilities: SUPPORTED,
      }),
    ).toMatchObject({ connectionState: "connected", stale: false, mutationReady: true });
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
  it("labels chat threads No project, never with the chat folder's title", () => {
    const chatProjectId = ProjectId.make("chat-project");
    const rows = buildInboxSidebarSections({
      projects: [
        project(ENV_A),
        {
          ...project(ENV_A),
          id: chatProjectId,
          name: "Plan a trip",
          cwd: "/home/me/.ryco/chats/2026-10-08-plan-a-trip-1a2b3c4d",
          kind: "chat",
        },
      ],
      worktrees: [],
      threads: [
        thread("chat", { projectId: chatProjectId, branch: null }),
        thread("project-thread"),
      ],
      environments: [environment(ENV_A)],
      filters: ALL_FILTERS,
    }).flatMap((section) => section.rows);
    expect(rows.find((row) => row.title === "chat")).toMatchObject({
      projectLabel: "No project",
      isChat: true,
      workspaceLabel: "Chat folder",
    });
    expect(rows.find((row) => row.title === "project-thread")).toMatchObject({
      projectLabel: "Ryco",
      isChat: false,
    });
  });

  it("finds chat threads when searching for No project", () => {
    const chatProjectId = ProjectId.make("chat-project");
    const titles = buildInboxSidebarSections({
      projects: [
        project(ENV_A),
        { ...project(ENV_A), id: chatProjectId, name: "Plan a trip", kind: "chat" },
      ],
      worktrees: [],
      threads: [
        thread("chat", { projectId: chatProjectId, branch: null }),
        thread("project-thread"),
      ],
      environments: [environment(ENV_A)],
      filters: { ...ALL_FILTERS, query: "no project" },
    }).flatMap((section) => section.rows.map((row) => row.title));
    expect(titles).toEqual(["chat"]);
  });

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

  it("keeps only the filtered projects, on whichever machine they live", () => {
    const other = ProjectId.make("project-other");
    const titles = buildInboxSidebarSections({
      projects: [project(ENV_A), project(ENV_B), { ...project(ENV_A), id: other, name: "Hub" }],
      worktrees: [],
      threads: [
        thread("here"),
        thread("there", { environmentId: ENV_B }),
        thread("hub", { projectId: other }),
      ],
      environments: [environment(ENV_A), environment(ENV_B)],
      filters: {
        ...ALL_FILTERS,
        projectKeys: [
          scopedProjectKey({ environmentId: ENV_A, projectId: PROJECT_A }),
          scopedProjectKey({ environmentId: ENV_B, projectId: PROJECT_A }),
        ],
      },
    }).flatMap((section) => section.rows.map((row) => row.title));
    expect(titles.toSorted()).toEqual(["here", "there"]);
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
  it("names each thread's own pull request and lists the workspace's others", () => {
    const link = (number: number, state: "open" | "merged", linkedAt: string) => ({
      number,
      title: `PR ${number}`,
      url: `https://github.com/acme/ryco/pull/${number}`,
      state,
      isDraft: false,
      terminalAt: state === "merged" ? "2026-08-24T09:00:00.000Z" : null,
      headRefName: `branch-${number}`,
      baseRefName: "main",
      source: "created" as const,
      linkedAt,
      dismissedAt: null,
    });
    const rows = build({
      threads: [
        // Shipped #675 before the follow-up existed.
        thread("shipped", {
          worktreeId: worktree.id,
          createdAt: "2026-08-23T08:00:00.000Z",
          updatedAt: "2026-08-23T08:00:00.000Z",
        }),
        // Asked for the follow-up after #675 merged.
        thread("follow-up", {
          worktreeId: worktree.id,
          createdAt: "2026-08-24T10:00:00.000Z",
          updatedAt: "2026-08-24T10:00:00.000Z",
        }),
      ],
      worktrees: [
        {
          ...worktree,
          prNumber: 677,
          prState: "open",
          pullRequests: [
            link(675, "merged", "2026-08-23T09:00:00.000Z"),
            link(677, "open", "2026-08-24T11:00:00.000Z"),
          ],
        },
      ],
    }).flatMap((section) => section.rows);
    const byThread = new Map(rows.map((row) => [row.threadId as string, row]));
    expect(byThread.get("shipped")?.pullRequest).toMatchObject({ number: 675, state: "merged" });
    expect(byThread.get("shipped")?.pullRequestLinked).toBe(true);
    expect(byThread.get("shipped")?.otherPullRequests.map((pr) => pr.number)).toEqual([677]);
    expect(byThread.get("follow-up")?.pullRequest).toMatchObject({ number: 677, state: "open" });
    expect(byThread.get("follow-up")?.otherPullRequests.map((pr) => pr.number)).toEqual([675]);
  });
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
  beforeEach(resetEnvironmentServerConfigsForTests);
  afterEach(resetEnvironmentServerConfigsForTests);

  function liveConfig(environmentId: EnvironmentId): ServerConfig {
    return {
      environment: {
        environmentId,
        label: environmentId,
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "1.0.0",
        capabilities: {
          repositoryIdentity: true,
          threadSettlement: true,
          threadSnooze: true,
          threadPriorityRanking: false,
        },
      },
      providers: [],
    } as unknown as ServerConfig;
  }

  function machine(
    environmentId: EnvironmentId,
    overrides: Partial<WorkspaceMachineCatalogEntry> = {},
  ): WorkspaceMachineCatalogEntry {
    return {
      environmentId,
      nodeId: `node-${environmentId}`,
      label: environmentId,
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "1.0.0",
      // The Hub directory publishes no thread capabilities.
      capabilities: { repositoryIdentity: true, nativeClientRequired: false },
      clientTier: "hosted-web",
      nativeTrust: "not-required",
      effectiveRole: "owner",
      presence: { online: true, lastSeenAt: 1, observedAt: 1 },
      connectionState: "connected",
      deliveryUnknown: false,
      revokedAt: null,
      removed: false,
      canReadMetadata: true,
      canConnect: true,
      canMutate: true,
      cacheDisposition: "available",
      accessReasons: [],
      ...overrides,
    };
  }

  /** The hosted inbox's environments with `selected` as the selected node. */
  function hostedEnvironments(
    selected: EnvironmentId,
    machines: ReadonlyArray<WorkspaceMachineCatalogEntry>,
  ) {
    return buildInboxSidebarEnvironments({
      knownEnvironmentIds: [],
      primary: {
        environmentId: selected,
        label: selected,
        connectionState: "connected",
        // The selected node's placeholder, built from the directory.
        descriptor: {
          capabilities: {
            repositoryIdentity: false,
            threadSettlement: false,
            threadPriorityRanking: false,
          },
        },
        serverConfig: null,
      },
      hosted: { machines, queuedEnvironmentIds: [] },
      desktopWorkspace: null,
      savedEnvironmentRegistry: {},
      savedEnvironmentRuntimeById: {},
      cacheHydratedEnvironmentIds: new Set(),
      reportedThreadCapabilities: getReportedThreadCapabilitiesSnapshot(),
      shellSettlementRules: getShellSettlementRulesSnapshot(),
    });
  }

  const byId = (environments: ReadonlyArray<InboxSidebarEnvironment>, id: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === id);

  const inactive = thread("old", { latestUserMessageAt: "2026-08-23T10:00:00.000Z" });

  it("enables snooze and auto-settlement once the node reports its capabilities", () => {
    writeEnvironmentServerConfig(ENV_A, liveConfig(ENV_A));
    const sections = build({
      threads: [inactive],
      environments: hostedEnvironments(ENV_A, [machine(ENV_A)]),
      autoSettleAfterDays: 3,
      nowMs: Date.parse("2026-09-11T10:00:00Z"),
    });
    expect(sections.find((section) => section.key === "settled")?.rows[0]).toMatchObject({
      title: "old",
      canSnooze: true,
      settlementActionEnabled: true,
    });
  });

  it("takes a non-selected node's capabilities from its own config", () => {
    writeEnvironmentServerConfig(ENV_B, liveConfig(ENV_B));
    const environments = hostedEnvironments(ENV_A, [machine(ENV_A), machine(ENV_B)]);
    expect(byId(environments, ENV_B)).toMatchObject({
      threadSettlementSupported: true,
      threadSnoozeSupported: true,
    });
    // The selected node's placeholder is no answer: it stays unknown.
    expect(byId(environments, ENV_A)).toMatchObject({
      threadSettlementSupported: "unknown",
      threadSnoozeSupported: "unknown",
    });
  });

  it("honors a settlement flag the directory states", () => {
    const environments = hostedEnvironments(ENV_A, [
      machine(ENV_B, {
        capabilities: {
          repositoryIdentity: true,
          nativeClientRequired: false,
          threadSettlement: false,
        },
      }),
    ]);
    expect(byId(environments, ENV_B)?.threadSettlementSupported).toBe(false);
  });

  it("keeps a node's settled threads Settled when the selection moves to another node", () => {
    const nowMs = Date.parse("2026-09-11T10:00:00Z");
    const failedSession = {
      session: {
        provider: ProviderDriverKind.make("codex"),
        status: "error" as const,
        orchestrationStatus: "error" as const,
        lastError: "Provider exited (code 1)",
        createdAt: "2026-08-23T10:00:00.000Z",
        updatedAt: "2026-08-23T10:00:00.000Z",
      },
    };
    const threads = [
      thread("a-settled-error", {
        ...failedSession,
        settledOverride: "settled",
        settledAt: "2026-08-24T10:00:00.000Z",
      }),
      thread("a-old-error", { ...failedSession, latestUserMessageAt: "2026-08-23T10:00:00.000Z" }),
      thread("b-old", { environmentId: ENV_B, latestUserMessageAt: "2026-08-23T10:00:00.000Z" }),
    ];
    const sectionOf = (
      environments: ReadonlyArray<InboxSidebarEnvironment>,
      selected: EnvironmentId,
    ) =>
      buildInboxSidebarSections({
        projects: [project(ENV_A), project(ENV_B)],
        worktrees: [],
        threads,
        environments,
        filters: ALL_FILTERS,
        autoSettleAfterDays: 7,
        primaryEnvironmentId: selected,
        nowMs,
      });
    const settledKeys = (sections: ReturnType<typeof buildInboxSidebarSections>) =>
      sections
        .find((section) => section.key === "settled")
        ?.rows.map((row) => row.key)
        .toSorted();
    const nodeA = ["machine-a:a-old-error", "machine-a:a-settled-error"];

    // Node A is selected and connected.
    writeEnvironmentServerConfig(ENV_A, liveConfig(ENV_A));
    const selectedA = hostedEnvironments(ENV_A, [
      machine(ENV_A),
      machine(ENV_B, { connectionState: "disconnected" }),
    ]);
    expect(settledKeys(sectionOf(selectedA, ENV_A))).toEqual([...nodeA, "machine-b:b-old"]);

    // Opening a thread on node B selects it before its config arrives.
    const switching = hostedEnvironments(ENV_B, [
      machine(ENV_A),
      machine(ENV_B, { connectionState: "connecting" }),
    ]);
    expect(settledKeys(sectionOf(switching, ENV_B))).toEqual([...nodeA, "machine-b:b-old"]);
    expect(sectionOf(switching, ENV_B).find((section) => section.key === "active")).toBeUndefined();

    // Node B's config arrives, and node A is later released from the warm set.
    writeEnvironmentServerConfig(ENV_B, liveConfig(ENV_B));
    forgetEnvironmentServerConfig(ENV_A);
    const selectedB = hostedEnvironments(ENV_B, [
      machine(ENV_A, { connectionState: "disconnected" }),
      machine(ENV_B),
    ]);
    expect(settledKeys(sectionOf(selectedB, ENV_B))).toEqual([...nodeA, "machine-b:b-old"]);
    expect(byId(selectedB, ENV_A)?.threadSettlementSupported).toBe(true);
  });

  it.each([
    { mutationReady: false },
    { shellCurrent: false },
    { connectionState: "offline" as const, stale: true },
  ])("keeps mutations blocked with live capabilities and %o", (blocker) => {
    const live = environment(ENV_A, { ...blocker, threadSnoozeSupported: true });
    const rows = build({ threads: [inactive], environments: [live] }).flatMap(
      (section) => section.rows,
    );
    expect(rows[0]).toMatchObject({ canSnooze: false, settlementActionEnabled: false });
  });

  it("allows no settlement or snooze change on a node that has not answered", () => {
    const rows = build({
      threads: [inactive],
      environments: [
        environment(ENV_A, {
          threadSettlementSupported: "unknown",
          threadSnoozeSupported: "unknown",
        }),
      ],
      autoSettleAfterDays: 3,
      nowMs: Date.parse("2026-09-11T10:00:00Z"),
    }).flatMap((section) => section.rows);
    expect(rows[0]).toMatchObject({
      settled: true,
      canSnooze: false,
      canUnsnooze: false,
      settlementActionEnabled: false,
    });
  });

  it("leaves an environment as it is when no node config has arrived", () => {
    const initial = environment(ENV_A, { threadSettlementSupported: false });
    expect(applyInboxServerConfig(initial, null)).toBe(initial);
  });

  it("lists each node's threads by that node's own auto-settle rule", () => {
    const withRule = (environmentId: EnvironmentId, threadAutoSettleAfterDays?: 3 | 30) => {
      const config = liveConfig(environmentId);
      return {
        ...config,
        environment: {
          ...config.environment,
          capabilities: { ...config.environment.capabilities, nodeAutoSettlement: true },
        },
        settings: threadAutoSettleAfterDays === undefined ? {} : { threadAutoSettleAfterDays },
      } as unknown as ServerConfig;
    };
    writeEnvironmentServerConfig(ENV_A, withRule(ENV_A, 30));
    writeEnvironmentServerConfig(ENV_B, withRule(ENV_B, 3));
    // A cold node known only from a cached snapshot.
    const ENV_C = EnvironmentId.make("machine-c");
    recordEnvironmentShellSettlementPolicy(ENV_C, { autoSettleAfterDays: 3 });
    const environments = hostedEnvironments(ENV_A, [
      machine(ENV_A),
      machine(ENV_B),
      machine(ENV_C, { connectionState: "disconnected" }),
    ]);
    expect(environments.map((entry) => entry.autoSettleAfterDays)).toEqual([30, 3, 3]);

    const lastActive = { latestUserMessageAt: "2026-09-01T10:00:00.000Z" };
    const settledKeys = build({
      threads: [
        thread("a-idle", lastActive),
        thread("b-idle", { ...lastActive, environmentId: ENV_B }),
        thread("c-idle", { ...lastActive, environmentId: ENV_C }),
      ],
      environments,
      // This client's own rule no longer decides for nodes that keep theirs.
      autoSettleAfterDays: 90,
      nowMs: Date.parse("2026-09-11T10:00:00Z"),
    })
      .find((section) => section.key === "settled")
      ?.rows.map((row) => row.key)
      .toSorted();
    expect(settledKeys).toEqual(["machine-b:b-idle", "machine-c:c-idle"]);
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

  it("rests a thread a server restart interrupted as idle, without error text", () => {
    const session = {
      provider: ProviderDriverKind.make("codex"),
      status: "error" as const,
      orchestrationStatus: "error" as const,
      createdAt: "2026-08-23T10:00:00.000Z",
      updatedAt: "2026-08-23T10:03:00.000Z",
    };
    const interrupted = {
      turnId: TurnId.make("turn-interrupted"),
      state: "interrupted" as const,
      requestedAt: "2026-08-23T10:00:00.000Z",
      startedAt: "2026-08-23T10:00:01.000Z",
      completedAt: "2026-08-23T10:03:00.000Z",
      assistantMessageId: null,
    };
    const sections = build({
      threads: [
        thread("a-working", running("2026-08-23T10:02:00.000Z")),
        thread("b-released", {
          session: { ...session, lastError: ORPHANED_PROVIDER_SESSION_ERROR },
          latestTurn: interrupted,
        }),
        thread("c-failed", {
          session: { ...session, lastError: "Provider exited (code 1)" },
          latestTurn: interrupted,
        }),
      ],
      nowMs: Date.parse("2026-08-23T10:05:00.000Z"),
    });

    expect(
      sections.map((section) => [section.key, section.rows.map((row) => row.threadId)]),
    ).toEqual([
      ["active", ["c-failed", "a-working"]],
      ["recent", ["b-released"]],
    ]);
    expect(sections[1]?.rows[0]).toMatchObject({
      state: "idle",
      statusLabel: "Idle",
      placementState: "idle",
      errorDetail: null,
    });
    expect(sections[0]?.rows[0]).toMatchObject({
      state: "error",
      errorDetail: "Provider exited (code 1)",
    });
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

  it("lets every row narrow to its machine once threads span machines, the primary one too", () => {
    const local = thread("local");
    const remote = thread("remote", { environmentId: ENV_B });
    expect(rows({ threads: [local] }).map((row) => row.spansMachines)).toEqual([false]);
    const mixed = rows({ threads: [local, remote], primaryEnvironmentId: ENV_A });
    expect(mixed.every((row) => row.spansMachines)).toBe(true);
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

describe("usage-limited rows", () => {
  const rows = (input: Parameters<typeof build>[0]) =>
    build(input).flatMap((section) => section.rows);
  const BEFORE_RESET = Date.parse("2026-08-23T12:00:00.000Z");
  const AFTER_RESET = Date.parse("2026-08-23T16:00:00.000Z");
  const limitedThread = (id: string, overrides: Partial<SidebarThreadSummary> = {}) =>
    thread(id, {
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "sonnet" },
      session: {
        provider: ProviderDriverKind.make("claudeAgent"),
        status: "error",
        orchestrationStatus: "error",
        lastError: "Claude usage limit reached.",
        createdAt: "2026-08-23T10:00:00.000Z",
        updatedAt: "2026-08-23T10:00:00.000Z",
      },
      usageLimit: {
        limitId: `usage-limit:${id}:turn-1`,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        turnId: TurnId.make("turn-1"),
        message: "Claude usage limit reached.",
        limitedAt: "2026-08-23T10:00:00.000Z",
        resetAt: "2026-08-23T15:00:00.000Z",
        autoResume: null,
        updatedAt: "2026-08-23T10:00:00.000Z",
      },
      ...overrides,
    });

  it("shows a limited thread as Limited in Active, ranked with errors and before working", () => {
    const sections = build({
      threads: [
        thread("working", {
          latestTurn: {
            turnId: TurnId.make("turn-working"),
            state: "running",
            requestedAt: "2026-08-23T09:00:00.000Z",
            startedAt: "2026-08-23T09:00:00.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
        }),
        limitedThread("limited"),
      ],
      nowMs: BEFORE_RESET,
    });
    const active = sections.find((section) => section.key === "active");
    expect(active?.rows.map((row) => [row.title, row.state])).toEqual([
      ["limited", "limited"],
      ["working", "working"],
    ]);
    expect(active?.rows[0]).toMatchObject({
      statusLabel: "Limited",
      errorDetail: null,
      usageLimit: { phase: "limited", resetAt: "2026-08-23T15:00:00.000Z" },
    });
  });

  it("falls back to Error when the thread targets another instance", () => {
    const [row] = rows({
      threads: [
        limitedThread("switched", {
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        }),
      ],
      nowMs: BEFORE_RESET,
    });
    expect(row).toMatchObject({ state: "error", statusLabel: "Error" });
  });

  it("labels the row Limit reset after the reset", () => {
    const [row] = rows({ threads: [limitedThread("reset")], nowMs: AFTER_RESET });
    expect(row).toMatchObject({
      state: "limited",
      statusLabel: "Limit reset",
      usageLimit: { phase: "reset" },
    });
  });

  it("gives the sidebar a Limited pill unless the thread is working", () => {
    expect(resolveThreadStatusPill({ thread: limitedThread("pill") })).toMatchObject({
      label: "Limited",
      pulse: false,
    });
    expect(
      resolveThreadStatusPill({
        thread: limitedThread("pill-working", {
          latestTurn: {
            turnId: TurnId.make("turn-2"),
            state: "running",
            requestedAt: "2026-08-23T11:00:00.000Z",
            startedAt: "2026-08-23T11:00:00.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
        }),
      })?.label,
    ).toBe("Working");
  });
});

describe("delegated thread folding", () => {
  const delegatedFrom = (parent: string, root: string = parent) => ({
    parentThreadId: ThreadId.make(parent),
    rootThreadId: ThreadId.make(root),
    relationship: "delegated",
  });
  const working = { backgroundLiveness: "working" as const };
  const running = (startedAt: string) => ({
    latestTurn: {
      turnId: TurnId.make(`turn-${startedAt}`),
      state: "running" as const,
      requestedAt: startedAt,
      startedAt,
      completedAt: null,
      assistantMessageId: null,
    },
  });
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

  it("folds working children under a Recent parent and shows the parent Working", () => {
    const sections = build({
      threads: [
        thread("parent"),
        thread("late", {
          lineage: delegatedFrom("parent"),
          ...running("2026-08-23T11:00:00.000Z"),
        }),
        thread("early", {
          lineage: delegatedFrom("parent"),
          ...running("2026-08-23T10:30:00.000Z"),
        }),
        thread("done", { lineage: delegatedFrom("parent") }),
      ],
    });
    expect(sections.map((candidate) => candidate.key)).toEqual(["active"]);
    const host = section(sections, "active")?.rows[0];
    expect(host).toMatchObject({
      threadId: "parent",
      state: "working",
      statusLabel: "Working",
      delegatedState: true,
      runningSince: "2026-08-23T10:30:00.000Z",
    });
    expect(ids(host?.delegatedChildren)).toEqual(expect.arrayContaining(["late", "early", "done"]));
    expect(host?.delegatedChildren.map((child) => child.state)).toEqual(
      expect.arrayContaining(["working", "working", "idle"]),
    );
  });

  it("folds a needs-input child and moves its parent to Needs input", () => {
    const sections = build({
      threads: [
        thread("parent", working),
        thread("child", { lineage: delegatedFrom("parent"), hasPendingApprovals: true }),
      ],
    });
    expect(sections.map((candidate) => candidate.key)).toEqual(["needs-input"]);
    const host = section(sections, "needs-input")?.rows[0];
    expect(host).toMatchObject({
      threadId: "parent",
      state: "needs-input",
      attention: "approval",
      delegatedState: true,
      runningSince: null,
    });
    expect(ids(host?.delegatedChildren)).toEqual(["child"]);
  });

  it("keeps the parent's own state when it is at least as strong as its children's", () => {
    const asking = build({
      threads: [
        thread("parent", { hasPendingUserInput: true }),
        thread("child", { lineage: delegatedFrom("parent"), ...working }),
      ],
    });
    expect(section(asking, "needs-input")?.rows[0]).toMatchObject({
      state: "needs-input",
      attention: "input",
      delegatedState: false,
    });

    const busy = build({
      threads: [
        thread("parent", running("2026-08-23T11:00:00.000Z")),
        thread("child", {
          lineage: delegatedFrom("parent"),
          ...running("2026-08-23T10:00:00.000Z"),
        }),
      ],
    });
    expect(section(busy, "active")?.rows[0]).toMatchObject({
      state: "working",
      delegatedState: false,
      runningSince: "2026-08-23T11:00:00.000Z",
    });
  });

  it("folds an errored child without passing its error to the parent", () => {
    const sections = build({
      threads: [
        thread("parent"),
        thread("child", {
          lineage: delegatedFrom("parent"),
          session: {
            provider: ProviderDriverKind.make("codex"),
            status: "error",
            orchestrationStatus: "error",
            lastError: "Provider exited",
            createdAt: "2026-08-23T10:00:00.000Z",
            updatedAt: "2026-08-23T10:00:00.000Z",
          },
        }),
      ],
    });
    expect(sections.map((candidate) => candidate.key)).toEqual(["recent"]);
    const host = section(sections, "recent")?.rows[0];
    expect(host).toMatchObject({ state: "idle", delegatedState: false });
    expect(host?.delegatedChildren[0]).toMatchObject({ threadId: "child", state: "error" });
  });

  it("folds an idle child into a working host in Active now", () => {
    const sections = build({
      threads: [thread("parent", working), thread("child", { lineage: delegatedFrom("parent") })],
    });
    expect(sections.map((candidate) => candidate.key)).toEqual(["active"]);
    expect(ids(section(sections, "active")?.rows[0]?.delegatedChildren)).toEqual(["child"]);
    expect(section(sections, "active")?.rows[0]?.delegatedState).toBe(false);
  });

  it("keeps a working child top-level under a Settled parent", () => {
    const sections = build({
      threads: [
        thread("parent", settled),
        thread("child", { lineage: delegatedFrom("parent"), ...working }),
      ],
    });
    expect(ids(section(sections, "active")?.rows)).toEqual(["child"]);
    expect(ids(section(sections, "settled")?.rows)).toEqual(["parent"]);
    expect(section(sections, "settled")?.rows[0]).toMatchObject({
      delegatedChildren: [],
      delegatedState: false,
    });
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

  it("keeps folding under a project filter", () => {
    const threads = [thread("parent"), thread("child", { lineage: delegatedFrom("parent") })];
    const filtered = build({
      threads,
      filters: {
        ...ALL_FILTERS,
        projectKeys: [scopedProjectKey({ environmentId: ENV_A, projectId: PROJECT_A })],
      },
    });
    expect(ids(section(filtered, "recent")?.rows)).toEqual(["parent"]);
    expect(ids(section(filtered, "recent")?.rows[0]?.delegatedChildren)).toEqual(["child"]);
  });

  it("filters a status by the host's section, children included", () => {
    const threads = [
      thread("parent"),
      thread("child", { lineage: delegatedFrom("parent"), ...working }),
    ];
    expect(build({ threads, filters: { ...ALL_FILTERS, status: "recent" } })).toEqual([]);

    const active = build({ threads, filters: { ...ALL_FILTERS, status: "active" } });
    expect(active.map((candidate) => candidate.key)).toEqual(["active"]);
    expect(ids(section(active, "active")?.rows)).toEqual(["parent"]);
    expect(ids(section(active, "active")?.rows[0]?.delegatedChildren)).toEqual(["child"]);
  });
});

it("keeps a settled foreground turn with background work Working across inbox and status pills", () => {
  const background = thread("background", {
    interactionMode: "plan",
    hasActionableProposedPlan: true,
    backgroundLiveness: "working",
    latestTurn: {
      turnId: TurnId.make("settled-turn"),
      state: "completed",
      requestedAt: "2026-08-23T10:00:00.000Z",
      startedAt: "2026-08-23T10:00:00.000Z",
      completedAt: "2026-08-23T10:01:00.000Z",
      assistantMessageId: null,
    },
  });
  const rows = build({ threads: [background] }).flatMap((section) => section.rows);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ state: "working", statusLabel: "Working" });
  expect(resolveThreadStatusPill({ thread: background })).toMatchObject({
    label: "Working",
    pulse: true,
  });
  expect(
    resolveThreadStatusPill({ thread: { ...background, hasPendingApprovals: true } }),
  ).toMatchObject({ label: "Pending Approval" });
  expect(
    resolveThreadStatusPill({ thread: { ...background, hasPendingUserInput: true } }),
  ).toMatchObject({ label: "Awaiting Input" });
  expect(
    resolveThreadStatusPill({ thread: { ...background, backgroundLiveness: null } }),
  ).toMatchObject({ label: "Plan Ready" });
});

describe("sameInboxProviderCatalogs", () => {
  const models = [] as unknown as ServerProvider["models"];
  const provider = (overrides: Record<string, unknown> = {}) =>
    ({
      instanceId: "codex",
      driver: "codex",
      status: "ready",
      models,
      ...overrides,
    }) as unknown as ServerProvider;

  it("ignores status-only changes", () => {
    expect(sameInboxProviderCatalogs([provider()], [provider({ status: "error" })])).toBe(true);
    expect(sameInboxProviderCatalogs(null, null)).toBe(true);
  });

  it("detects catalog, driver, instance and presence changes", () => {
    expect(sameInboxProviderCatalogs([provider()], [provider({ models: [] })])).toBe(false);
    expect(sameInboxProviderCatalogs([provider()], [provider({ driver: "claudeAgent" })])).toBe(
      false,
    );
    expect(sameInboxProviderCatalogs([provider()], [provider({ instanceId: "other" })])).toBe(
      false,
    );
    expect(sameInboxProviderCatalogs([provider()], [provider(), provider()])).toBe(false);
    expect(sameInboxProviderCatalogs(null, [provider()])).toBe(false);
  });
});

describe("queued environments", () => {
  const idleRow = (environments: ReadonlyArray<InboxSidebarEnvironment>) =>
    build({ threads: [thread("idle")], environments }).flatMap((section) => section.rows)[0];

  it("says Waiting for an environment queued for a free connection slot", () => {
    expect(
      idleRow([environment(ENV_A, { connectionState: "reconnecting", queued: true })]),
    ).toMatchObject({ state: "reconnecting", statusLabel: "Waiting" });
  });

  it("keeps Reconnecting for an environment that is not queued", () => {
    expect(idleRow([environment(ENV_A, { connectionState: "reconnecting" })])).toMatchObject({
      state: "reconnecting",
      statusLabel: "Reconnecting",
    });
  });

  it("keeps the queued flag when a node config supplies its providers", () => {
    const queued = environment(ENV_A, { connectionState: "reconnecting", queued: true });
    expect(applyInboxServerConfig(queued, { providers: [] })).toMatchObject({ queued: true });
  });
});

describe("placement while a machine connects", () => {
  const rowsOf = (sections: ReturnType<typeof build>) =>
    sections.flatMap((section) => section.rows);
  const failedSession = {
    session: {
      provider: ProviderDriverKind.make("codex"),
      status: "error" as const,
      orchestrationStatus: "error" as const,
      lastError: "Provider exited (code 1)",
      createdAt: "2026-08-23T10:00:00.000Z",
      updatedAt: "2026-08-23T10:00:00.000Z",
    },
  };
  const runningTurn = {
    latestTurn: {
      turnId: TurnId.make("turn-running"),
      state: "running" as const,
      requestedAt: "2026-08-23T10:00:00.000Z",
      startedAt: "2026-08-23T10:00:01.000Z",
      completedAt: null,
      assistantMessageId: null,
    },
  };

  it("keeps a released machine's rows in Recent and in place while it connects or waits", () => {
    const threads = [
      thread("a-new", { createdAt: "2026-08-23T10:06:00.000Z" }),
      thread("b-mid", { environmentId: ENV_B, createdAt: "2026-08-23T10:05:00.000Z" }),
      thread("a-old", { createdAt: "2026-08-23T10:04:00.000Z" }),
      thread("b-old", { environmentId: ENV_B, createdAt: "2026-08-23T10:03:00.000Z" }),
    ];
    const layout = (machineB: Partial<InboxSidebarEnvironment>) =>
      build({ threads, environments: [environment(ENV_A), environment(ENV_B, machineB)] });
    const released = layout({ connectionState: "idle" });
    const releasedKeys = rowsOf(released).map((row) => row.key);
    expect(releasedKeys).toEqual([
      "machine-a:a-new",
      "machine-b:b-mid",
      "machine-a:a-old",
      "machine-b:b-old",
    ]);

    const progress = [
      [{ connectionState: "idle" }, "idle", "Idle"],
      [{ connectionState: "connecting" }, "connecting", "Connecting"],
      [{ connectionState: "reconnecting", queued: true }, "reconnecting", "Waiting"],
      [{ connectionState: "reconnecting" }, "reconnecting", "Reconnecting"],
      [{ connectionState: "connected" }, "idle", "Idle"],
    ] as const;
    for (const [machineB, state, statusLabel] of progress) {
      const sections = layout(machineB);
      expect(sections.map((section) => section.key)).toEqual(["recent"]);
      expect(rowsOf(sections).map((row) => row.key)).toEqual(releasedKeys);
      expect(
        rowsOf(sections)
          .filter((row) => row.environmentId === ENV_B)
          .map((row) => [row.state, row.statusLabel, row.placementState]),
      ).toEqual([
        [state, statusLabel, "idle"],
        [state, statusLabel, "idle"],
      ]);
    }
  });

  it("ranks an errored row by its own state while its machine connects", () => {
    const threads = [
      thread("a-working", runningTurn),
      thread("b-error", { environmentId: ENV_B, ...failedSession }),
    ];
    const active = (machineB: Partial<InboxSidebarEnvironment>) =>
      build({
        threads,
        environments: [environment(ENV_A), environment(ENV_B, machineB)],
      }).find((section) => section.key === "active")?.rows;

    expect(active({ connectionState: "connected" })?.map((row) => row.threadId)).toEqual([
      "b-error",
      "a-working",
    ]);
    const connecting = active({ connectionState: "connecting" });
    expect(connecting?.map((row) => row.threadId)).toEqual(["b-error", "a-working"]);
    expect(connecting?.[0]).toMatchObject({
      state: "connecting",
      statusLabel: "Connecting",
      placementState: "error",
    });
  });

  it("still files a thread whose own session is connecting under Active now", () => {
    const sections = build({
      threads: [
        thread("starting", {
          session: {
            provider: ProviderDriverKind.make("codex"),
            status: "connecting",
            orchestrationStatus: "starting",
            createdAt: "2026-08-23T10:00:00.000Z",
            updatedAt: "2026-08-23T10:00:00.000Z",
          },
        }),
      ],
    });
    expect(sections.map((section) => section.key)).toEqual(["active"]);
    expect(sections[0]?.rows[0]).toMatchObject({
      state: "connecting",
      placementState: "connecting",
    });
  });

  it("files a folded host by the inherited state while its machine connects", () => {
    const sections = build({
      threads: [
        thread("parent", { environmentId: ENV_B }),
        thread("child", {
          environmentId: ENV_B,
          backgroundLiveness: "working",
          lineage: {
            parentThreadId: ThreadId.make("parent"),
            rootThreadId: ThreadId.make("parent"),
            relationship: "delegated",
          },
        }),
      ],
      environments: [environment(ENV_A), environment(ENV_B, { connectionState: "connecting" })],
    });
    expect(sections.map((section) => section.key)).toEqual(["active"]);
    expect(sections[0]?.rows[0]).toMatchObject({
      threadId: "parent",
      state: "working",
      placementState: "working",
      delegatedState: true,
    });
  });
});

describe("createInboxSidebarModelSharing", () => {
  const NOW_MS = Date.parse("2026-08-24T00:00:00Z");
  const pullRequestWorktree: SidebarWorktreeSummary = {
    id: WorktreeId.make("shared-worktree"),
    environmentId: ENV_A,
    projectId: PROJECT_A,
    title: "Feature",
    branch: "feature/shared",
    worktreePath: "/repo/shared",
    origin: "pr",
    prNumber: 7,
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
  const working = {
    latestTurn: {
      turnId: TurnId.make("turn-shared"),
      state: "running" as const,
      requestedAt: "2026-08-23T10:00:00.000Z",
      startedAt: "2026-08-23T10:00:00.000Z",
      completedAt: null,
      assistantMessageId: null,
    },
  };
  const buildModel = (threads: ReadonlyArray<SidebarThreadSummary>) =>
    buildInboxSidebarModel({
      projects: [project(ENV_A)],
      worktrees: [pullRequestWorktree],
      threads,
      environments: [environment(ENV_A)],
      filters: ALL_FILTERS,
      nowMs: NOW_MS,
    });
  const rowByTitle = (model: ReturnType<typeof buildModel>, title: string) =>
    model.sections.flatMap((section) => section.rows).find((row) => row.title === title)!;
  const sectionByKey = (model: ReturnType<typeof buildModel>, key: string) =>
    model.sections.find((section) => section.key === key)!;
  const threads = (restingTitle = "resting") => [
    thread("busy", { ...working, worktreeId: pullRequestWorktree.id }),
    thread("resting", { title: restingTitle }),
  ];

  it("returns the previous model, sections and rows for identical inputs", () => {
    const sharing = createInboxSidebarModelSharing();
    const first = sharing.share(buildModel(threads()));
    const second = sharing.share(buildModel(threads()));

    // The builder returns fresh objects every time, including pull requests.
    const fresh = buildModel(threads());
    expect(rowByTitle(fresh, "busy")).not.toBe(rowByTitle(first, "busy"));
    expect(rowByTitle(first, "busy").pullRequest).toEqual({
      number: 7,
      state: "open",
      isDraft: false,
    });

    expect(second).toBe(first);
    expect(second.sections).toBe(first.sections);
    for (const section of first.sections) {
      expect(sectionByKey(second, section.key)).toBe(section);
      expect(sectionByKey(second, section.key).rows).toBe(section.rows);
    }
    expect(rowByTitle(second, "busy")).toBe(rowByTitle(first, "busy"));
    expect(rowByTitle(second, "resting")).toBe(rowByTitle(first, "resting"));
  });

  it("replaces only the row of the thread whose summary changed", () => {
    const sharing = createInboxSidebarModelSharing();
    const first = sharing.share(buildModel(threads()));
    const second = sharing.share(buildModel(threads("renamed")));

    expect(second).not.toBe(first);
    expect(rowByTitle(second, "busy")).toBe(rowByTitle(first, "busy"));
    expect(sectionByKey(second, "active")).toBe(sectionByKey(first, "active"));
    expect(rowByTitle(second, "renamed")).not.toBe(rowByTitle(first, "resting"));
    expect(sectionByKey(second, "recent")).not.toBe(sectionByKey(first, "recent"));
    expect(sectionByKey(second, "recent").rows.map((row) => row.title)).toEqual(["renamed"]);
  });

  it("follows a changed order and a changed settlement deadline", () => {
    const sharing = createInboxSidebarModelSharing();
    const older = thread("older", {
      updatedAt: "2026-08-23T09:00:00.000Z",
      createdAt: "2026-08-23T09:00:00.000Z",
    });
    const newer = thread("newer", {
      updatedAt: "2026-08-23T11:00:00.000Z",
      createdAt: "2026-08-23T11:00:00.000Z",
    });
    const first = sharing.share(buildModel([older, newer]));
    expect(sectionByKey(first, "recent").rows.map((row) => row.title)).toEqual(["newer", "older"]);

    const reordered = sharing.share(
      buildModel([
        older,
        { ...newer, createdAt: "2026-08-23T08:00:00.000Z", updatedAt: "2026-08-23T08:00:00.000Z" },
      ]),
    );
    expect(sectionByKey(reordered, "recent").rows.map((row) => row.title)).toEqual([
      "older",
      "newer",
    ]);
    expect(sectionByKey(reordered, "recent")).not.toBe(sectionByKey(first, "recent"));

    const deadline = sharing.share({ ...reordered, nextSettlementEvaluationAtMs: 42 });
    expect(deadline).not.toBe(reordered);
    expect(deadline.nextSettlementEvaluationAtMs).toBe(42);
    expect(deadline.sections).toBe(reordered.sections);
  });

  it("replaces a host row when a folded child changes", () => {
    const delegated = {
      parentThreadId: ThreadId.make("host"),
      rootThreadId: ThreadId.make("host"),
      relationship: "delegated" as const,
    };
    const family = (childTitle: string) => [
      thread("host"),
      thread("child", { title: childTitle, lineage: delegated }),
    ];
    const sharing = createInboxSidebarModelSharing();
    const first = sharing.share(buildModel(family("child")));
    const same = sharing.share(buildModel(family("child")));
    expect(rowByTitle(same, "host")).toBe(rowByTitle(first, "host"));
    expect(rowByTitle(same, "host").delegatedChildren[0]).toBe(
      rowByTitle(first, "host").delegatedChildren[0],
    );

    const changed = sharing.share(buildModel(family("renamed child")));
    expect(rowByTitle(changed, "host")).not.toBe(rowByTitle(first, "host"));
    expect(rowByTitle(changed, "host").delegatedChildren.map((row) => row.title)).toEqual([
      "renamed child",
    ]);
  });

  it("forgets rows that left the model", () => {
    const sharing = createInboxSidebarModelSharing();
    const first = sharing.share(buildModel(threads()));
    sharing.share(buildModel([thread("resting")]));
    const back = sharing.share(buildModel(threads()));
    expect(rowByTitle(back, "busy")).not.toBe(rowByTitle(first, "busy"));
    expect(rowByTitle(back, "busy")).toEqual(rowByTitle(first, "busy"));
  });
});

describe("current thread lifecycle", () => {
  const nowMs = Date.parse("2026-08-23T12:00:00.000Z");
  const completedTurn = {
    turnId: TurnId.make("turn-1"),
    state: "completed" as const,
    requestedAt: "2026-08-23T10:00:00.000Z",
    startedAt: "2026-08-23T10:00:00.000Z",
    completedAt: "2026-08-23T10:05:00.000Z",
    assistantMessageId: null,
  };
  const used = (id: string, overrides: Partial<SidebarThreadSummary> = {}) =>
    thread(id, {
      latestUserMessageAt: "2026-08-23T10:00:00.000Z",
      latestTurn: completedTurn,
      ...overrides,
    });
  const idle = used("idle");
  const running = used("running", {
    session: {
      provider: ProviderDriverKind.make("codex"),
      status: "running",
      orchestrationStatus: "running",
      activeTurnId: TurnId.make("turn-2"),
      createdAt: "2026-08-23T11:00:00.000Z",
      updatedAt: "2026-08-23T11:00:00.000Z",
    },
    latestTurn: {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      state: "running",
      completedAt: null,
    },
  });
  const live = environment(ENV_A, { threadSnoozeSupported: true });
  const current = (value: SidebarThreadSummary, environments = [live]) =>
    resolveCurrentThreadLifecycle({
      thread: value,
      projects: [project(ENV_A)],
      worktrees: [],
      environments,
      nowMs,
    });
  const reason = (
    value: SidebarThreadSummary,
    action: ThreadLifecycleAction,
    environments = [live],
  ) => threadLifecycleDisabledReason(current(value, environments)!.availability, action);

  it("names the open thread and what can be done to it", () => {
    expect(current(idle)).toEqual({
      target: { environmentId: ENV_A, threadId: idle.id },
      title: "idle",
      availability: {
        settle: { enabled: true, blocker: null, settled: false },
        snooze: { enabled: true, blocker: null, snoozedUntil: null },
        archive: { enabled: true, blocker: null },
        markUnread: { enabled: true, blocker: null },
      },
    });
    expect(current(used("untitled", { title: "" }))?.title).toBe("Untitled task");
  });

  it("has nothing for a thread the inbox does not list", () => {
    expect(current({ ...idle, archivedAt: "2026-08-23T11:00:00.000Z" })).toBeNull();
  });

  it("decides each thread exactly as its inbox row does", () => {
    const threads = [
      idle,
      running,
      thread("fresh"),
      used("asking", { hasPendingApprovals: true }),
      used("settled", { settledOverride: "settled", settledAt: "2026-08-23T11:00:00.000Z" }),
      used("snoozed", {
        snoozedAt: "2026-08-23T11:00:00.000Z",
        snoozedUntil: "2026-08-23T13:00:00.000Z",
      }),
    ];
    for (const environments of [
      [live],
      [environment(ENV_A)],
      [environment(ENV_A, { threadSnoozeSupported: true, mutationReady: false })],
      [environment(ENV_A, { threadSettlementSupported: "unknown", threadSnoozeSupported: true })],
    ]) {
      const rows = build({ threads, environments, nowMs }).flatMap((section) => section.rows);
      expect(rows).toHaveLength(threads.length);
      for (const row of rows) {
        const { availability } = current(
          threads.find((candidate) => candidate.id === row.threadId)!,
          environments,
        )!;
        expect({
          settled: availability.settle.settled,
          snoozedUntil: availability.snooze.snoozedUntil,
          settlementActionEnabled: availability.settle.enabled,
          settlementDisabledReason: threadLifecycleDisabledReason(availability, "settle"),
          snoozeEnabled: availability.snooze.enabled,
        }).toEqual({
          settled: row.settled,
          snoozedUntil: row.snoozedUntil,
          settlementActionEnabled: row.settlementActionEnabled,
          settlementDisabledReason: row.settlementDisabledReason,
          snoozeEnabled: row.snoozedUntil ? row.canUnsnooze : row.canSnooze,
        });
      }
    }
  });

  it("says why each action is blocked, in the action's own words", () => {
    const offline = [
      environment(ENV_A, { connectionState: "offline", threadSnoozeSupported: true }),
    ];
    const stale = [environment(ENV_A, { shellCurrent: false, threadSnoozeSupported: true })];
    const viewer = [environment(ENV_A, { mutationReady: false, threadSnoozeSupported: true })];
    expect(reason(running, "settle")).toBe("Wait for the running work to finish.");
    expect(reason(running, "snooze")).toBe("Wait for the running work to finish.");
    expect(reason(running, "archive")).toBe("Wait for the running work to finish.");
    expect(reason(running, "markUnread")).toBe("Nothing to mark unread yet.");
    expect(reason(used("asking", { hasPendingApprovals: true }), "snooze")).toBe(
      "Resolve the pending approval first.",
    );
    expect(reason(thread("fresh"), "archive")).toBe("Send a message before archiving.");
    expect(reason(idle, "settle", offline)).toBe("Reconnect this machine to change settlement.");
    expect(reason(idle, "snooze", offline)).toBe("Reconnect this machine to snooze threads.");
    expect(reason(idle, "archive", offline)).toBe("Reconnect this machine to archive threads.");
    expect(reason(idle, "snooze", stale)).toBe("Wait for current thread data before snoozing.");
    expect(reason(idle, "archive", stale)).toBe("Wait for current thread data before archiving.");
    expect(reason(idle, "archive", viewer)).toBe("Your role cannot change this thread.");
    expect(reason(idle, "snooze", [environment(ENV_A, { threadSnoozeSupported: false })])).toBe(
      "Update this machine to use Snooze.",
    );
    // Mark unread is this client's own state: no machine blocks it.
    expect(reason(idle, "markUnread", offline)).toBeNull();
    expect(
      threadLifecycleDisabledReason(
        resolveCurrentThreadLifecycle({
          thread: idle,
          projects: [project(ENV_A)],
          worktrees: [],
          environments: [live],
          deliveryUnknownThreadKeys: new Set([`${ENV_A}:${idle.id}`]),
          nowMs,
        })!.availability,
        "snooze",
      ),
    ).toBe("Confirm message delivery before snoozing.");
  });
});
