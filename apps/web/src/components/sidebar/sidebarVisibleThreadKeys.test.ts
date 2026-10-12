import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { DEFAULT_INTERACTION_MODE, type SidebarThreadSummary } from "../../types";
import { sortThreadsWithPinned } from "../Sidebar.logic";
import {
  composeSidebarTree,
  decorateSidebarTreeProject,
  type SidebarTreeThread,
} from "./hooks/useSidebarTree";
import { createSidebarProjectTreeCache } from "./sidebarProjectTreeCache";
import { adaptProjectForSidebarTree, restatusSidebarTreeThread } from "./sidebarTreeAdapters";
import {
  computeSidebarProjectThreadKeys,
  createSidebarProjectThreadKeysCache,
  groupByLogicalProjectKey,
} from "./sidebarVisibleThreadKeys";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");

function makeProject(): SidebarProjectSnapshot {
  const member = {
    id: projectId,
    environmentId,
    name: "Project",
    cwd: "/repo/project",
    repositoryIdentity: null,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    scripts: [],
  };
  return {
    ...member,
    displayName: "Project",
    environmentPresence: "local-only",
    groupedProjectCount: 1,
    memberProjectRefs: [{ environmentId, projectId }],
    memberProjects: [
      { ...member, environmentLabel: null, physicalProjectKey: "environment-local:project-1" },
    ],
    projectKey: "environment-local:project-1",
    remoteEnvironmentLabels: [],
  } as SidebarProjectSnapshot;
}

function makeThread(id: string, updatedAt: string): SidebarThreadSummary {
  return {
    id: ThreadId.make(id),
    environmentId,
    projectId,
    title: id,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    archivedAt: null,
    updatedAt,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

const NO_PINS: ReadonlySet<string> = new Set();

const NO_DRAFTS: readonly SidebarTreeThread[] = [];

describe("sidebar visible thread keys", () => {
  const structureOf = (threads: readonly SidebarThreadSummary[]) =>
    createSidebarProjectTreeCache().structure({
      project: makeProject(),
      threads,
      drafts: NO_DRAFTS,
      worktrees: [],
      sortOrder: "updated_at",
      pinnedThreadKeys: NO_PINS,
    });

  it("orders a project's sessions like its tree and hides collapsed projects", () => {
    const input = {
      structure: structureOf([
        makeThread("old", "2026-05-01T00:00:00.000Z"),
        makeThread("new", "2026-05-02T00:00:00.000Z"),
      ]),
      activeThreadKey: null,
    };
    expect(computeSidebarProjectThreadKeys({ ...input, projectExpanded: true })).toEqual([
      "environment-local:new",
      "environment-local:old",
    ]);
    expect(computeSidebarProjectThreadKeys({ ...input, projectExpanded: false })).toEqual([]);
    expect(
      computeSidebarProjectThreadKeys({
        ...input,
        projectExpanded: false,
        activeThreadKey: "environment-local:old",
      }),
    ).toEqual(["environment-local:old"]);
  });

  it("never lists archived sessions", () => {
    const archived = {
      ...makeThread("gone", "2026-05-03T00:00:00.000Z"),
      archivedAt: "2026-05-03T00:00:00.000Z",
    };
    const structure = structureOf([makeThread("kept", "2026-05-01T00:00:00.000Z"), archived]);
    expect(
      computeSidebarProjectThreadKeys({ structure, projectExpanded: true, activeThreadKey: null }),
    ).toEqual(["environment-local:kept"]);
    expect(
      computeSidebarProjectThreadKeys({
        structure,
        projectExpanded: false,
        activeThreadKey: "environment-local:gone",
      }),
    ).toEqual([]);
  });

  it("reuses a project's keys until its structure changes", () => {
    const cache = createSidebarProjectThreadKeysCache();
    const input = {
      projectKey: "environment-local:project-1",
      structure: structureOf([makeThread("a", "2026-05-01T00:00:00.000Z")]),
      projectExpanded: true,
      activeThreadKey: null,
    };
    const first = cache.projectThreadKeys(input);
    expect(cache.projectThreadKeys({ ...input })).toBe(first);
    const changed = cache.projectThreadKeys({
      ...input,
      structure: structureOf([
        makeThread("a", "2026-05-01T00:00:00.000Z"),
        makeThread("b", "2026-05-02T00:00:00.000Z"),
      ]),
    });
    expect(changed).not.toBe(first);
    expect(changed).toEqual(["environment-local:b", "environment-local:a"]);
  });
});

describe("sidebar project tree cache", () => {
  const baseInput = (threads: readonly SidebarThreadSummary[]) => ({
    project: makeProject(),
    threads,
    drafts: NO_DRAFTS,
    worktrees: [] as const,
    sortOrder: "updated_at" as const,
    pinnedThreadKeys: NO_PINS,
  });

  it("serves a second consumer with its own arrays of the same rows from one structure", () => {
    const cache = createSidebarProjectTreeCache();
    const a = makeThread("a", "2026-05-01T00:00:00.000Z");
    const b = makeThread("b", "2026-05-02T00:00:00.000Z");
    const sidebarInput = baseInput([a, b]);
    const first = cache.structure(sidebarInput);
    // The project row selects the same store rows into its own array, in another order,
    // with an equal but separately built pin set.
    const second = cache.structure({
      ...sidebarInput,
      threads: [b, a],
      pinnedThreadKeys: new Set<string>(),
    });
    expect(second).toBe(first);
    const changed = cache.structure({
      ...sidebarInput,
      threads: [a, { ...b, updatedAt: "2026-05-03T00:00:00.000Z" }],
    });
    expect(changed).not.toBe(first);
  });

  it("matches the full composition once decorated with visits", () => {
    const cache = createSidebarProjectTreeCache();
    const completed = {
      ...makeThread("done", "2026-05-02T00:00:00.000Z"),
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed" as const,
        requestedAt: "2026-05-02T00:00:00.000Z",
        startedAt: "2026-05-02T00:00:00.000Z",
        completedAt: "2026-05-02T00:01:00.000Z",
        assistantMessageId: null,
      },
    };
    const threads = [makeThread("idle", "2026-05-01T00:00:00.000Z"), completed];
    const visits = new Map([["environment-local:done", "2026-05-02T00:02:00.000Z"]]);
    const structure = cache.structure(baseInput(threads))!;
    const decorated = decorateSidebarTreeProject(structure, {
      nowMs: 0,
      restatusThread: (thread) =>
        restatusSidebarTreeThread(thread, visits.get(`environment-local:${thread.id}`)),
    });
    const adapted = adaptProjectForSidebarTree({
      lastVisitedAtByThreadKey: visits,
      project: makeProject(),
      threads: sortThreadsWithPinned({
        threads,
        sortOrder: "updated_at",
        pinnedThreadKeys: NO_PINS,
        getThreadKey: (thread) => `environment-local:${thread.id}`,
      }),
      worktrees: [],
    });
    const expected = composeSidebarTree({
      nowMs: 0,
      projects: [adapted.project],
      threads: adapted.threads,
      worktrees: adapted.worktrees,
    }).projects[0];
    expect(decorated).toEqual(expected);
    // The visited completion is no longer unseen; without the visit it is.
    const pillOf = (sessions: readonly SidebarTreeThread[]) =>
      sessions.find((thread) => thread.id === "done")?.statusPill?.label ?? null;
    expect(pillOf(decorated.worktrees[0]!.sessions)).toBeNull();
    expect(pillOf(structure.worktrees[0]!.threads)).toBe("Completed");
  });
});

describe("sidebar project groups", () => {
  it("keeps untouched groups' arrays when regrouping", () => {
    const cache = createSidebarProjectThreadKeysCache();
    const a = { key: "p1", value: 1 };
    const b = { key: "p2", value: 2 };
    const c = { key: "p2", value: 3 };
    const first = cache.shareGroups(
      "rows",
      groupByLogicalProjectKey([a, b], (row) => row.key),
    );
    const second = cache.shareGroups(
      "rows",
      groupByLogicalProjectKey([a, b, c], (row) => row.key),
    );
    expect(second.get("p1")).toBe(first.get("p1"));
    expect(second.get("p2")).not.toBe(first.get("p2"));
    expect(second.get("p2")).toEqual([b, c]);
  });
});
