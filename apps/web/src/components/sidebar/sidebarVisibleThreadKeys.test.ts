import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { DEFAULT_INTERACTION_MODE, type SidebarThreadSummary } from "../../types";
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

describe("sidebar visible thread keys", () => {
  it("orders a project's sessions like its tree and hides collapsed projects", () => {
    const project = makeProject();
    const threads = [
      makeThread("old", "2026-05-01T00:00:00.000Z"),
      makeThread("new", "2026-05-02T00:00:00.000Z"),
    ];
    const input = {
      project,
      threads,
      worktrees: [],
      sortOrder: "updated_at" as const,
      pinnedThreadKeys: NO_PINS,
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

  it("reuses a project's keys until one of its inputs changes", () => {
    const cache = createSidebarProjectThreadKeysCache();
    const project = makeProject();
    const threads = [makeThread("a", "2026-05-01T00:00:00.000Z")];
    const input = {
      project,
      threads,
      worktrees: [],
      sortOrder: "updated_at" as const,
      pinnedThreadKeys: NO_PINS,
      projectExpanded: true,
      activeThreadKey: null,
    };
    const first = cache.projectThreadKeys(input);
    expect(cache.projectThreadKeys({ ...input })).toBe(first);
    const changed = cache.projectThreadKeys({
      ...input,
      threads: [...threads, makeThread("b", "2026-05-02T00:00:00.000Z")],
    });
    expect(changed).not.toBe(first);
    expect(changed).toEqual(["environment-local:b", "environment-local:a"]);
  });

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
