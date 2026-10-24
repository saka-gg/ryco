import type { Project, SidebarThreadSummary } from "@ryco/client-runtime/state/threads";
import { EnvironmentId, ProjectId, ProviderDriverKind, ThreadId, TurnId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveInboxBulkActions } from "./inboxBulkTriage.logic";
import {
  buildInboxSidebarSections,
  type InboxSidebarEnvironment,
  type InboxSidebarRow,
} from "./inboxSidebarModel";
import { selectSettleFinishedRows } from "./inboxSettleFinished.logic";

const READY = EnvironmentId.make("ready");
const VIEWER = EnvironmentId.make("viewer");
const OFFLINE = EnvironmentId.make("offline");
const OLD = EnvironmentId.make("old");
const PROJECT = ProjectId.make("project");
const NOW_MS = Date.parse("2026-08-23T12:00:00.000Z");

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
    threadSnoozeSupported: true,
    mutationReady: true,
    shellCurrent: true,
    ...overrides,
  };
}

const ENVIRONMENTS = [
  environment(READY),
  environment(VIEWER, { role: "viewer", mutationReady: false }),
  environment(OFFLINE, { connectionState: "offline", stale: true }),
  environment(OLD, { threadSettlementSupported: false, threadSnoozeSupported: false }),
];

function project(environmentId: EnvironmentId): Project {
  return {
    id: PROJECT,
    environmentId,
    name: "Ryco",
    cwd: "/repo/ryco",
    defaultModelSelection: null,
    scripts: [],
  };
}

/** A thread whose latest turn finished at 10:`minute`. */
function thread(
  id: string,
  minute: number,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  const at = `2026-08-23T10:${String(minute).padStart(2, "0")}:00.000Z`;
  return {
    id: ThreadId.make(id),
    environmentId: READY,
    projectId: PROJECT,
    title: id,
    interactionMode: "default",
    session: null,
    createdAt: "2026-08-23T09:00:00.000Z",
    archivedAt: null,
    updatedAt: at,
    latestTurn: {
      turnId: TurnId.make(`turn-${id}`),
      state: "completed",
      requestedAt: "2026-08-23T09:00:00.000Z",
      startedAt: "2026-08-23T09:00:00.000Z",
      completedAt: at,
      assistantMessageId: null,
    },
    branch: "main",
    worktreePath: null,
    latestUserMessageAt: "2026-08-23T09:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

const settled = { settledOverride: "settled", settledAt: "2026-08-23T11:00:00.000Z" } as const;
const snoozed = {
  snoozedAt: "2026-08-23T11:00:00.000Z",
  snoozedUntil: "2026-08-23T13:00:00.000Z",
} as const;
const delegatedFrom = (parent: string) => ({
  parentThreadId: ThreadId.make(parent),
  rootThreadId: ThreadId.make(parent),
  relationship: "delegated" as const,
});

function sections(threads: ReadonlyArray<SidebarThreadSummary>) {
  return buildInboxSidebarSections({
    projects: ENVIRONMENTS.map((candidate) => project(candidate.environmentId)),
    worktrees: [],
    threads,
    environments: ENVIRONMENTS,
    filters: { query: "", environmentId: null, status: "all" },
    nowMs: NOW_MS,
  });
}

const rows = (threads: ReadonlyArray<SidebarThreadSummary>) =>
  sections(threads).flatMap((section) => section.rows);

const ids = (rows: ReadonlyArray<InboxSidebarRow>) => rows.map((row) => row.threadId);

describe("resolveInboxBulkActions", () => {
  it("offers each row only the actions its own menu allows", () => {
    const selection = rows([
      thread("awake", 1),
      thread("resting", 2, settled),
      thread("asleep", 3, snoozed),
      thread("fresh", 4, { latestTurn: null }),
      thread("viewer", 5, { environmentId: VIEWER }),
      thread("offline", 6, { environmentId: OFFLINE }),
      thread("old", 7, { environmentId: OLD }),
    ]).toSorted((left, right) => left.threadId.localeCompare(right.threadId));

    expect(selection).toHaveLength(7);
    const actions = resolveInboxBulkActions(selection);
    expect(
      Object.fromEntries(
        Object.entries(actions).map(([action, eligible]) => [action, ids(eligible)]),
      ),
    ).toEqual({
      settle: ["asleep", "awake", "fresh"],
      unsettle: ["resting"],
      snooze: ["awake", "fresh", "resting"],
      unsnooze: ["asleep"],
      markUnread: ["asleep", "awake", "offline", "old", "resting", "viewer"],
      delete: ["asleep", "awake", "fresh", "old", "resting"],
    });
  });

  it("keeps the first rows of each action up to the limit", () => {
    const selection = rows([thread("a", 1), thread("b", 2), thread("c", 3)]);
    const actions = resolveInboxBulkActions(selection, 2);
    expect(ids(actions.settle)).toEqual(ids(selection.slice(0, 2)));
    expect(actions.delete).toHaveLength(2);
  });
});

describe("selectSettleFinishedRows", () => {
  const unseen = new Set(["unseen"]);
  const isUnseen = (row: InboxSidebarRow) => unseen.has(row.threadId);

  it("settles finished threads the user has seen, oldest first", () => {
    const listed = rows([
      thread("newer", 30),
      thread("older", 10),
      thread("unseen", 20),
      thread("no-result", 25, { latestTurn: null }),
      thread("resting", 5, settled),
      thread("asleep", 6, snoozed),
      thread("failed", 7, {
        session: {
          provider: ProviderDriverKind.make("codex"),
          status: "error",
          orchestrationStatus: "error",
          lastError: "Provider exited (code 1)",
          createdAt: "2026-08-23T10:00:00.000Z",
          updatedAt: "2026-08-23T10:00:00.000Z",
        },
      }),
      thread("offline", 8, { environmentId: OFFLINE }),
      thread("viewer", 9, { environmentId: VIEWER }),
      thread("old", 11, { environmentId: OLD }),
    ]);

    expect(ids(selectSettleFinishedRows(listed, { isUnseen }))).toEqual(["older", "newer"]);
  });

  it("includes the folded children of a host, and caps the result", () => {
    const recent = sections([
      thread("host", 20),
      thread("child", 10, { lineage: delegatedFrom("host") }),
      thread("other", 30),
    ]).find((section) => section.key === "recent")!.rows;

    expect(ids(recent)).toEqual(["other", "host"]);
    expect(ids(selectSettleFinishedRows(recent, { isUnseen }))).toEqual(["child", "host", "other"]);
    expect(ids(selectSettleFinishedRows(recent, { isUnseen, limit: 2 }))).toEqual([
      "child",
      "host",
    ]);
  });
});
