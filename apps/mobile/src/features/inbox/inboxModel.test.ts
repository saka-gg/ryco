import { describe, expect, it } from "vite-plus/test";

import type {
  Project,
  SidebarThreadSummary,
  SidebarWorktreeSummary,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId } from "@ryco/contracts";

import { buildInboxSections, resolveInboxEmptyState, type InboxEnvironment } from "./inboxModel";

const NODE_A = "node-a" as EnvironmentId;
const NODE_B = "node-b" as EnvironmentId;

function project(environmentId: EnvironmentId, id: string, name: string): Project {
  return {
    environmentId,
    id: id as never,
    name,
    cwd: `/${name.toLocaleLowerCase()}`,
    defaultModelSelection: null,
    scripts: [],
  };
}

function worktree(
  environmentId: EnvironmentId,
  id: string,
  projectId: string,
  branch: string,
): SidebarWorktreeSummary {
  return {
    environmentId,
    id: id as never,
    projectId: projectId as never,
    branch,
    title: null,
    worktreePath: null,
    origin: "main",
    prNumber: null,
    issueNumber: null,
    prTitle: null,
    issueTitle: null,
    prState: null,
    prIsDraft: null,
    issueState: null,
    workItemProvider: null,
    workItemKey: null,
    workItemTitle: null,
    workItemState: null,
    workItemStateName: null,
    workItemUrl: null,
    createdAt: "2026-07-26T08:00:00.000Z",
    updatedAt: "2026-07-26T08:00:00.000Z",
    archivedAt: null,
    manualPosition: 0,
  };
}

function thread(
  environmentId: EnvironmentId,
  id: string,
  projectId: string,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  return {
    environmentId,
    id: id as never,
    projectId: projectId as never,
    title: id,
    interactionMode: "default",
    session: null,
    createdAt: "2026-07-26T08:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-07-26T08:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    worktreeId: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("Inbox model", () => {
  it("puts Focus above Active without duplicating promoted threads", () => {
    const sections = buildInboxSections({
      projects: [project(NODE_A, "project-a", "Ryco")],
      worktrees: [],
      environments: [{ environmentId: NODE_A, label: "Mac Studio", connectionState: "connected" }],
      threads: [
        thread(NODE_A, "approval", "project-a", { hasPendingApprovals: true }),
        thread(NODE_A, "ordinary", "project-a"),
      ],
      aiFocusEnabled: true,
      nowMs: Date.parse("2026-08-25T12:00:00.000Z"),
    });

    expect(sections.map((section) => section.title)).toEqual(["Focus", "Active"]);
    expect(sections[0]?.rows[0]).toMatchObject({
      threadId: "approval",
      focusTitle: "Approval required",
      focusAiGenerated: false,
    });
    expect(sections[1]?.rows.map((row) => row.threadId)).toEqual(["ordinary"]);
    expect(new Set(sections.flatMap((section) => section.rows.map((row) => row.key))).size).toBe(2);
  });

  it("keeps idle work and attention blockers together in the Active queue", () => {
    const projects = [project(NODE_A, "project-a", "Ryco"), project(NODE_B, "project-b", "Hub")];
    const sections = buildInboxSections({
      projects,
      worktrees: [],
      environments: [
        { environmentId: NODE_A, label: "Mac Studio", connectionState: "connected" },
        { environmentId: NODE_B, label: "Build node", connectionState: "connected" },
      ],
      threads: [
        thread(NODE_A, "idle", "project-a", {
          updatedAt: "2026-07-26T09:00:00.000Z",
        }),
        thread(NODE_A, "working", "project-a", {
          latestTurn: { state: "running" } as never,
        }),
        thread(NODE_B, "approval", "project-b", {
          hasPendingApprovals: true,
        }),
        thread(NODE_B, "uncertain", "project-b"),
      ],
      deliveryUnknownThreadIds: new Set(["node-b:uncertain"]),
    });

    expect(sections.map((section) => section.title)).toEqual(["Active"]);
    expect(sections[0]?.rows.map((row) => row.threadId)).toEqual([
      "idle",
      "working",
      "approval",
      "uncertain",
    ]);
  });

  it("surfaces delivery unknown only on rows from the affected environment", () => {
    const sections = buildInboxSections({
      projects: [project(NODE_A, "project-a", "Ryco"), project(NODE_B, "project-b", "Hub")],
      worktrees: [],
      environments: [
        {
          environmentId: NODE_A,
          label: "Mac Studio",
          connectionState: "offline",
          deliveryUnknown: true,
        },
        { environmentId: NODE_B, label: "Build node", connectionState: "connected" },
      ],
      threads: [thread(NODE_A, "uncertain", "project-a"), thread(NODE_B, "safe", "project-b")],
    });

    const rows = sections.flatMap((section) => section.rows);
    expect(rows.find((row) => row.threadId === "uncertain")?.state).toBe("delivery-unknown");
    expect(rows.find((row) => row.threadId === "uncertain")?.statusLabel).toBe("Check delivery");
    expect(rows.find((row) => row.threadId === "safe")?.state).toBe("idle");
  });

  it("builds the complete node, project, and worktree context and filters it", () => {
    const sections = buildInboxSections({
      projects: [project(NODE_A, "project-a", "Ryco")],
      worktrees: [worktree(NODE_A, "tree-a", "project-a", "feat/mobile")],
      environments: [{ environmentId: NODE_A, label: "Mac Studio", connectionState: "connected" }],
      threads: [
        thread(NODE_A, "thread-a", "project-a", {
          title: "Polish inbox",
          worktreeId: "tree-a",
        } as never),
      ],
      query: "feat/mobile",
    });

    expect(sections[0]?.rows[0]?.contextLabel).toBe("Mac Studio · Ryco · feat/mobile");
  });

  it("carries the current provider brand onto every thread row", () => {
    const sections = buildInboxSections({
      projects: [project(NODE_A, "project-a", "Ryco")],
      worktrees: [],
      environments: [{ environmentId: NODE_A, label: "Mac Studio", connectionState: "connected" }],
      threads: [
        thread(NODE_A, "thread-a", "project-a", {
          session: { provider: "claudeAgent" } as SidebarThreadSummary["session"],
        }),
      ],
    });

    expect(sections[0]?.rows[0]).toMatchObject({
      providerDriver: "claudeAgent",
      providerLabel: "Claude",
    });
  });

  it("retains provider identity for cached rows whose live session was stripped", () => {
    const sections = buildInboxSections({
      projects: [project(NODE_A, "project-a", "Ryco")],
      worktrees: [],
      environments: [
        { environmentId: NODE_A, label: "Mac Studio", connectionState: "offline", stale: true },
      ],
      threads: [
        thread(NODE_A, "thread-a", "project-a", {
          session: null,
          modelSelection: { instanceId: "cursor", model: "cursor-agent" } as never,
          providerDriver: "cursor" as never,
        }),
      ],
    });

    expect(sections[0]?.rows[0]).toMatchObject({
      providerDriver: "cursor",
      providerLabel: "Cursor",
    });
  });

  it("scopes by node and excludes archived tasks", () => {
    const sections = buildInboxSections({
      projects: [project(NODE_A, "a", "A"), project(NODE_B, "b", "B")],
      worktrees: [],
      environments: [
        { environmentId: NODE_A, label: "A", connectionState: "connected" },
        { environmentId: NODE_B, label: "B", connectionState: "connected" },
      ],
      threads: [
        thread(NODE_A, "visible", "a"),
        thread(NODE_B, "other", "b"),
        thread(NODE_A, "archived", "a", { archivedAt: "2026-07-26T09:00:00.000Z" }),
      ],
      nodeScope: NODE_A,
    });

    expect(sections.flatMap((section) => section.rows).map((row) => row.threadId)).toEqual([
      "visible",
    ]);
  });

  it("partitions manual and merged-PR work into Settled", () => {
    const merged = {
      ...worktree(NODE_A, "tree-a", "project-a", "feat/mobile"),
      prNumber: 42,
      prState: "merged" as const,
      updatedAt: "2026-07-26T10:00:00.000Z",
    };
    const sections = buildInboxSections({
      projects: [project(NODE_A, "project-a", "Ryco")],
      worktrees: [merged],
      threads: [
        thread(NODE_A, "manual", "project-a", {
          settledOverride: "settled",
          settledAt: "2026-07-26T11:00:00.000Z",
        }),
        thread(NODE_A, "merged", "project-a", { worktreeId: "tree-a" }),
        thread(NODE_A, "kept-active", "project-a", {
          worktreeId: "tree-a",
          settledOverride: "active",
        }),
      ],
      environments: [
        {
          environmentId: NODE_A,
          label: "Studio",
          connectionState: "connected",
          threadSettlementSupported: true,
          mutationReady: true,
          shellCurrent: true,
        },
      ],
      nowMs: Date.parse("2026-07-26T12:00:00.000Z"),
    });

    expect(sections.map((section) => section.title)).toEqual(["Active", "Settled"]);
    expect(sections[0]?.rows.map((row) => row.threadId)).toEqual(["kept-active"]);
    expect(sections[1]?.rows.map((row) => row.threadId)).toEqual(["manual", "merged"]);
  });

  it("routes every empty state to its missing prerequisite", () => {
    expect(
      resolveInboxEmptyState({
        environmentCount: 0,
        projectCount: 0,
        threadCount: 0,
        hasFilter: false,
      }),
    ).toBe("connect-node");
    expect(
      resolveInboxEmptyState({
        environmentCount: 1,
        projectCount: 0,
        threadCount: 0,
        hasFilter: false,
      }),
    ).toBe("add-project");
    expect(
      resolveInboxEmptyState({
        environmentCount: 1,
        projectCount: 1,
        threadCount: 0,
        hasFilter: false,
      }),
    ).toBe("new-task");
    expect(
      resolveInboxEmptyState({
        environmentCount: 1,
        projectCount: 1,
        threadCount: 2,
        hasFilter: true,
      }),
    ).toBe("clear-filter");
  });
});

describe("inbox change-request badge", () => {
  it("carries the worktree's pull request onto the row", () => {
    // The fields were already reaching this module and being discarded at the
    // output boundary — that is the regression this pins.
    const tree = {
      ...worktree(NODE_A, "tree-a", "project-a", "feat/mobile"),
      prNumber: 42,
      prState: "open" as const,
    };
    const sections = buildInboxSections({
      projects: [project(NODE_A, "project-a", "Ryco")],
      worktrees: [tree],
      threads: [thread(NODE_A, "thread-a", "project-a", { worktreeId: "tree-a" })],
      environments: [{ environmentId: NODE_A, label: "Studio", connectionState: "connected" }],
    });
    const row = sections.flatMap((section) => section.rows)[0];
    expect(row?.changeRequest?.label).toBe("#42");
    expect(row?.changeRequest?.tone).toBe("open");
  });

  it("leaves the badge null when the worktree has no linked work", () => {
    const sections = buildInboxSections({
      projects: [project(NODE_A, "project-a", "Ryco")],
      worktrees: [worktree(NODE_A, "tree-a", "project-a", "feat/mobile")],
      threads: [thread(NODE_A, "thread-a", "project-a", { worktreeId: "tree-a" })],
      environments: [{ environmentId: NODE_A, label: "Studio", connectionState: "connected" }],
    });
    expect(sections.flatMap((section) => section.rows)[0]?.changeRequest).toBeNull();
  });

  it("presents a stale environment's rows as offline, never as live or actionable", () => {
    const sections = buildInboxSections({
      projects: [project(NODE_A, "project-a", "Ryco"), project(NODE_B, "project-b", "Hub")],
      worktrees: [],
      environments: [
        {
          environmentId: NODE_A,
          label: "Work Mac",
          connectionState: "offline",
          stale: true,
          staleDetail: "Offline · last seen 2h ago",
        },
        { environmentId: NODE_B, label: "Build node", connectionState: "connected" },
      ],
      threads: [
        // Cached fields that would otherwise read as live or actionable.
        thread(NODE_A, "cached-running", "project-a", {
          latestTurn: { state: "running" } as never,
        }),
        thread(NODE_A, "cached-approval", "project-a", { hasPendingApprovals: true }),
        thread(NODE_B, "live-working", "project-b", {
          latestTurn: { state: "running" } as never,
        }),
      ],
    });

    const active = sections.find((section) => section.key === "active");
    expect(active?.rows.map((row) => row.state)).toEqual(["offline", "offline", "working"]);
    expect(active?.rows[0]?.statusLabel).toBe("Offline · last seen 2h ago");
  });
});

describe("inbox row provenance", () => {
  function rowsFor(environment: InboxEnvironment) {
    return buildInboxSections({
      projects: [project(environment.environmentId, "project-a", "Ryco")],
      worktrees: [],
      threads: [thread(environment.environmentId, "thread-a", "project-a")],
      environments: [environment],
    }).flatMap((section) => section.rows);
  }

  it.each(["unverified", "account-trusted", "verified"] as const)(
    "keeps %s trust metadata out of task rows",
    (trust) => {
      const row = rowsFor({
        environmentId: NODE_A,
        label: "Work Mac",
        connectionState: "connected",
        trust,
      })[0];
      expect(row).not.toHaveProperty("trustLabel");
    },
  );

  it("surfaces the role only when it changes what the user may do", () => {
    expect(
      rowsFor({
        environmentId: NODE_A,
        label: "Work Mac",
        connectionState: "read-only",
        role: "viewer",
      })[0]?.roleLabel,
    ).toBe("Viewer");
    for (const role of ["operator", "owner", "client"] as const) {
      expect(
        rowsFor({
          environmentId: NODE_A,
          label: "Work Mac",
          connectionState: "connected",
          role,
        })[0]?.roleLabel,
      ).toBeNull();
    }
    expect(
      rowsFor({ environmentId: NODE_A, label: "Work Mac", connectionState: "connected" })[0]
        ?.roleLabel,
    ).toBeNull();
  });

  it("preserves offline and viewer information without trust metadata", () => {
    const row = rowsFor({
      environmentId: NODE_A,
      label: "Work Mac",
      connectionState: "offline",
      stale: true,
      staleDetail: "Offline · last seen 2h ago",
      role: "viewer",
      trust: "unverified",
    })[0];

    expect(row?.state).toBe("offline");
    expect(row?.statusLabel).toBe("Offline · last seen 2h ago");
    expect(row?.roleLabel).toBe("Viewer");
    expect(row).not.toHaveProperty("trustLabel");
  });
});

describe("mobile settlement and attention policy", () => {
  const nowMs = Date.parse("2026-09-12T12:00:00Z");
  const activityAt = "2026-09-05T12:00:00.000Z";
  const environment: InboxEnvironment = {
    environmentId: NODE_A,
    label: "Mac",
    connectionState: "connected",
    threadSettlementSupported: true,
    mutationReady: true,
    shellCurrent: true,
  };
  function build(overrides: Partial<Parameters<typeof buildInboxSections>[0]> = {}) {
    return buildInboxSections({
      projects: [project(NODE_A, "p", "Ryco")],
      worktrees: [],
      environments: [environment],
      threads: [thread(NODE_A, "old", "p", { latestUserMessageAt: activityAt })],
      nowMs,
      ...overrides,
    });
  }
  it("settles at exactly seven days, leaves Off disabled, and honors custom intervals", () => {
    expect(build({ nowMs: nowMs - 1 })[0]?.key).toBe("active");
    expect(build()[0]?.key).toBe("settled");
    expect(build()[0]?.rows[0]?.updatedAt).toBe("2026-09-12T12:00:00.000Z");
    expect(build({ autoSettleAfterDays: null })[0]?.key).toBe("active");
    expect(build({ autoSettleAfterDays: 14 })[0]?.key).toBe("active");
  });
  it("protects queued messages and environment-level unknown delivery", () => {
    expect(build({ localQueuedThreadIds: new Set(["node-a:old"]) })[0]?.rows[0]).toMatchObject({
      attentionState: "active",
      canSettle: false,
    });
    expect(
      build({ environments: [{ ...environment, deliveryUnknown: true }] })[0]?.rows[0],
    ).toMatchObject({ attentionState: "active", state: "delivery-unknown", canSettle: false });
  });
  it("keeps running, pending input, open PRs, and manual Active overrides out of Settled", () => {
    const open = {
      ...worktree(NODE_A, "tree", "p", "feat/inbox"),
      prNumber: 42,
      prState: "open" as const,
    };
    const sections = build({
      worktrees: [open],
      threads: [
        thread(NODE_A, "running", "p", {
          latestUserMessageAt: activityAt,
          latestTurn: { state: "running", requestedAt: activityAt } as never,
        }),
        thread(NODE_A, "input", "p", {
          latestUserMessageAt: activityAt,
          hasPendingUserInput: true,
        }),
        thread(NODE_A, "open", "p", { latestUserMessageAt: activityAt, worktreeId: "tree" }),
        thread(NODE_A, "kept", "p", { latestUserMessageAt: activityAt, settledOverride: "active" }),
      ],
    });
    expect(sections.map((section) => section.key)).toEqual(["active"]);
    expect(sections[0]?.rows).toHaveLength(4);
  });
  it("puts pending input in Focus when enabled without duplicating it in Active", () => {
    const sections = build({
      aiFocusEnabled: true,
      threads: [
        thread(NODE_A, "input", "p", {
          latestUserMessageAt: activityAt,
          hasPendingUserInput: true,
        }),
        thread(NODE_A, "old", "p", { latestUserMessageAt: activityAt }),
      ],
    });
    expect(sections.map((section) => section.key)).toEqual(["focus", "settled"]);
    expect(sections[0]?.rows[0]).toMatchObject({ state: "needs-input", canSettle: false });
    expect(new Set(sections.flatMap((section) => section.rows.map((row) => row.key))).size).toBe(2);
  });
  it("keeps cached rows offline and read-only even when their known lifecycle is settled", () => {
    expect(
      build({
        environments: [
          {
            ...environment,
            connectionState: "offline",
            stale: true,
            mutationReady: false,
            shellCurrent: false,
          },
        ],
      })[0]?.rows[0],
    ).toMatchObject({ attentionState: "settled", state: "offline", mutationEnabled: false });
  });
  it("carries project artwork and distinguishes a worktree from the original checkout", () => {
    const p = { ...project(NODE_A, "p", "Ryco"), customAvatarContentHash: "avatar" };
    const wt = { ...worktree(NODE_A, "tree", "p", "feat/inbox"), worktreePath: "/worktrees/inbox" };
    const sections = build({
      projects: [p],
      worktrees: [wt],
      threads: [
        thread(NODE_A, "main", "p", { branch: "main" }),
        thread(NODE_A, "worktree", "p", { worktreeId: "tree" }),
      ],
    });
    const rows = sections.flatMap((section) => section.rows);
    expect(rows.find((row) => row.threadId === "main")).toMatchObject({
      project: p,
      isWorktree: false,
      worktreeLabel: "main",
    });
    expect(rows.find((row) => row.threadId === "worktree")).toMatchObject({
      project: p,
      isWorktree: true,
      worktreeLabel: "feat/inbox",
    });
  });
});
