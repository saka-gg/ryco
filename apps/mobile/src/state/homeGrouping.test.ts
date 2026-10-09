import { describe, expect, it } from "vite-plus/test";

import type { Project, SidebarThreadSummary } from "@ryco/client-runtime/state/threads";

import { buildHomeThreadGroups, resolveHomeGroupingMode } from "./homeGrouping";
import { projectWorkspaceState } from "./workspaceModel";
import {
  shouldShowWorkspaceConnectionStatus,
  workspaceConnectionStatusLabel,
} from "../features/home/workspace-connection-status";

function project(
  overrides: Partial<Project> & Pick<Project, "id" | "environmentId" | "name" | "cwd">,
): Project {
  return {
    repositoryIdentity: null,
    defaultModelSelection: null,
    ...overrides,
  } as unknown as Project;
}

function thread(
  overrides: Partial<SidebarThreadSummary> &
    Pick<SidebarThreadSummary, "id" | "environmentId" | "projectId" | "title" | "createdAt">,
): SidebarThreadSummary {
  return {
    archivedAt: null,
    session: null,
    latestTurn: null,
    updatedAt: overrides.createdAt,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    interactionMode: "code",
    branch: null,
    worktreePath: null,
    ...overrides,
  } as unknown as SidebarThreadSummary;
}

describe("buildHomeThreadGroups", () => {
  it("groups unarchived threads by project across two environments", () => {
    const projects = [
      project({ id: "p1" as never, environmentId: "envA" as never, name: "Alpha", cwd: "/a" }),
      project({ id: "p2" as never, environmentId: "envB" as never, name: "Beta", cwd: "/b" }),
    ];
    const threads = [
      thread({
        id: "t1" as never,
        environmentId: "envA" as never,
        projectId: "p1" as never,
        title: "Alpha one",
        createdAt: "2026-07-24T10:00:00.000Z",
      }),
      thread({
        id: "t2" as never,
        environmentId: "envA" as never,
        projectId: "p1" as never,
        title: "Alpha two",
        createdAt: "2026-07-24T11:00:00.000Z",
      }),
      thread({
        id: "t3" as never,
        environmentId: "envB" as never,
        projectId: "p2" as never,
        title: "Beta one",
        createdAt: "2026-07-24T12:00:00.000Z",
      }),
      // archived thread must be excluded
      thread({
        id: "t4" as never,
        environmentId: "envB" as never,
        projectId: "p2" as never,
        title: "Archived",
        createdAt: "2026-07-24T09:00:00.000Z",
        archivedAt: "2026-07-24T09:30:00.000Z",
      }),
    ];

    const groups = buildHomeThreadGroups({ projects, threads, groupingMode: "separate" });

    expect(groups).toHaveLength(2);
    // Beta's most-recent thread (12:00) sorts its group ahead of Alpha (11:00).
    expect(groups[0]!.label).toBe("Beta");
    expect(groups[0]!.threads.map((t) => t.id)).toEqual(["t3"]);
    expect(groups[1]!.label).toBe("Alpha");
    // Two threads, most-recent first; archived one excluded.
    expect(groups[1]!.threads.map((t) => t.id)).toEqual(["t2", "t1"]);
  });

  it("resolves the grouping mode from the preference (undefined/true -> repository)", () => {
    expect(resolveHomeGroupingMode(undefined)).toBe("repository");
    expect(resolveHomeGroupingMode(true)).toBe("repository");
    expect(resolveHomeGroupingMode(false)).toBe("separate");
  });
});

describe("workspace connection status", () => {
  it("shows a quiet saved-view label while the machine is unavailable", () => {
    const state = projectWorkspaceState({
      isReady: true,
      networkStatus: "online",
      environments: [
        {
          environmentId: "envA" as never,
          environmentLabel: "Prod node",
          connectionState: "reconnecting",
          connectionError: null,
        },
      ],
      shellSummary: {
        hasSnapshot: true,
        hasSynchronizingShell: false,
        firstError: null,
        latestSnapshotUpdatedAt: null,
      },
    });

    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(true);
    expect(workspaceConnectionStatusLabel(state)).toBe("Saved view · Machines unavailable");
    expect(state.connectionState).toBe("reconnecting");
  });

  it("stays hidden when the single environment is connected and synced", () => {
    const state = projectWorkspaceState({
      isReady: true,
      networkStatus: "online",
      environments: [
        {
          environmentId: "envA" as never,
          environmentLabel: "Prod node",
          connectionState: "connected",
          connectionError: null,
        },
      ],
      shellSummary: {
        hasSnapshot: true,
        hasSynchronizingShell: false,
        firstError: null,
        latestSnapshotUpdatedAt: null,
      },
    });

    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(false);
  });
});
