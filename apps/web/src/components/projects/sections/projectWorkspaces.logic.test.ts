import {
  ProjectId,
  ThreadId,
  WorktreeId,
  type LifecycleSuggestions,
  type WorkspaceLifecycleSummary,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  availableWorkspaceActions,
  excludePinnedSuggestions,
  findWorkspaceSummary,
  projectSuggestions,
  unlistedWorkspaces,
  workspaceFacts,
  workspaceInspectionSignature,
} from "./projectWorkspaces.logic";

function summary(overrides: Partial<WorkspaceLifecycleSummary> = {}): WorkspaceLifecycleSummary {
  return {
    worktreeId: WorktreeId.make("wt-1"),
    projectId: ProjectId.make("p"),
    title: "Feature",
    branch: "feature",
    path: "/repo/.worktrees/feature",
    origin: "branch",
    main: false,
    archivedAt: null,
    checkoutRemovedAt: null,
    checkout: "present",
    gitRegistered: true,
    branchExists: true,
    unmerged: false,
    changes: {
      modified: 0,
      untracked: 0,
      protectedIgnored: 0,
      protectedIgnoredSample: [],
      regenerableIgnored: 0,
      regenerableIgnoredSample: [],
      truncated: false,
    },
    conversations: { active: 1, archived: 0, trashed: 0 },
    activeWork: [],
    actions: [
      { action: "archive", available: true, blockers: [] },
      { action: "restore", available: false, blockers: ["The workspace is not archived."] },
      { action: "remove-checkout", available: true, blockers: [] },
      { action: "remove-stale-record", available: false, blockers: [] },
      { action: "recreate-checkout", available: false, blockers: [] },
    ],
    inspectedAt: "2026-10-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("workspace rows", () => {
  it("offers only what the inspection allows, archive first and removal last", () => {
    expect(availableWorkspaceActions(summary())).toEqual(["archive", "remove-checkout"]);
    expect(availableWorkspaceActions(summary({ discardBlockers: [] }))).toEqual([
      "archive",
      "remove-checkout",
      "delete-workspace",
    ]);
    expect(
      availableWorkspaceActions(summary({ discardBlockers: ["Associated work is still active."] })),
    ).toEqual(["archive", "remove-checkout"]);
    expect(availableWorkspaceActions(null)).toEqual([]);
  });

  it("stays quiet for a clean, merged checkout", () => {
    expect(workspaceFacts(summary())).toEqual([]);
  });

  it("states uncommitted work, protected ignored files, unmerged commits and use once each", () => {
    const facts = workspaceFacts(
      summary({
        unmerged: true,
        activeWork: ["Fix login: a turn is running"],
        changes: {
          modified: 3,
          untracked: 1,
          protectedIgnored: 2,
          protectedIgnoredSample: [".env", "data.db"],
          regenerableIgnored: 40,
          regenerableIgnoredSample: ["node_modules"],
          truncated: false,
        },
      }),
    );
    expect(facts.map((fact) => fact.label)).toEqual([
      "3 modified, 1 untracked",
      "2 ignored files",
      "Unmerged commits",
      "In use",
    ]);
    expect(facts.every((fact) => fact.tone === "warning")).toBe(true);
    expect(facts.at(-1)?.detail).toBe("Fix login: a turn is running");
  });

  it("names a removed or missing checkout and ignores stale change counts", () => {
    const removed = workspaceFacts(
      summary({
        checkout: "removed",
        checkoutRemovedAt: "2026-10-01T00:00:00.000Z",
        changes: { ...summary().changes!, modified: 5 },
      }),
    );
    expect(removed).toEqual([
      expect.objectContaining({ label: "Checkout removed", tone: "muted" }),
    ]);
    expect(workspaceFacts(summary({ checkout: "missing" }))[0]).toMatchObject({
      label: "Checkout missing",
      tone: "warning",
    });
  });

  it("never calls the main checkout unmerged", () => {
    expect(workspaceFacts(summary({ main: true, unmerged: true }))).toEqual([]);
  });

  it("matches the synthesized main row to the inspected main record", () => {
    const main = summary({ worktreeId: WorktreeId.make("wt-main"), main: true });
    const feature = summary();
    expect(findWorkspaceSummary([feature, main], { worktreeId: "main:p", main: true })).toBe(main);
    expect(findWorkspaceSummary([feature, main], { worktreeId: "wt-1", main: false })).toBe(
      feature,
    );
    expect(findWorkspaceSummary([main], { worktreeId: "derived", main: false })).toBeNull();
  });

  it("lists registered workspaces the tree does not show, never the main checkout", () => {
    const main = summary({ worktreeId: WorktreeId.make("wt-main"), main: true });
    const hidden = summary({ worktreeId: WorktreeId.make("wt-hidden") });
    expect(unlistedWorkspaces([main, summary(), hidden], new Set(["wt-1"]))).toEqual([hidden]);
  });

  it("re-inspects on lifecycle changes, not on ordering or activity", () => {
    const base = {
      id: "wt-1",
      branch: "feature",
      worktreePath: "/w",
      archivedAt: null,
      checkoutRemovedAt: null,
    };
    const other = { ...base, id: "wt-2" };
    expect(workspaceInspectionSignature([base, other])).toBe(
      workspaceInspectionSignature([other, base]),
    );
    expect(workspaceInspectionSignature([base])).not.toBe(
      workspaceInspectionSignature([{ ...base, archivedAt: "2026-10-01T00:00:00.000Z" }]),
    );
  });
});

describe("workspace suggestions", () => {
  const suggestions: LifecycleSuggestions = {
    generatedAt: "2026-10-01T00:00:00.000Z",
    threads: [
      {
        threadId: ThreadId.make("pinned"),
        projectId: ProjectId.make("p"),
        title: "Pinned",
        lastActivityAt: "2026-08-01T00:00:00.000Z",
      },
      {
        threadId: ThreadId.make("idle"),
        projectId: ProjectId.make("p"),
        title: "Idle",
        lastActivityAt: "2026-08-01T00:00:00.000Z",
      },
      {
        threadId: ThreadId.make("elsewhere"),
        projectId: ProjectId.make("other"),
        title: "Elsewhere",
        lastActivityAt: "2026-08-01T00:00:00.000Z",
      },
    ],
    checkouts: [
      {
        worktreeId: WorktreeId.make("holds-pinned"),
        projectId: ProjectId.make("p"),
        title: "Feature",
        branch: "feature",
        archivedSince: "2026-09-01T00:00:00.000Z",
        conversations: 1,
      },
    ],
  };

  it("keeps only the project's own suggestions", () => {
    const scoped = projectSuggestions(suggestions, "p");
    expect(scoped.threads.map((thread) => thread.threadId)).toEqual(["pinned", "idle"]);
    expect(scoped.checkouts).toHaveLength(1);
  });

  it("never suggests pinned threads or checkouts that hold a pinned thread", () => {
    const filtered = excludePinnedSuggestions(
      suggestions,
      (threadId) => threadId === "pinned",
      new Set(["holds-pinned"]),
    );
    expect(filtered.threads.map((thread) => thread.threadId)).toEqual(["idle", "elsewhere"]);
    expect(filtered.checkouts).toEqual([]);
  });
});
