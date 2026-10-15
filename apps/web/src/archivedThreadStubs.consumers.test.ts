/**
 * Web consumers of thread rows with archived threads held as stubs
 * (`archivedThreads: "stub"`): each reads only what a stub carries, or leaves
 * stubs out where it lists unarchived threads only.
 */
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  hydrateEnvironmentStateFromCache,
  isArchivedThreadStub,
  selectEnvironmentState,
  selectSidebarThreadsAcrossEnvironments,
  selectThreadShellsAcrossEnvironments,
  syncServerShellSnapshot,
  type AppState,
} from "@ryco/client-runtime/state/threads";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationArchivedThreadStub,
  type OrchestrationThreadShell,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionItems } from "./components/CommandPalette.logic";
import { toMapThread } from "./components/projects/map/projectMapModel";
import { selectArchivedSettingsGroups } from "./components/settings/archivedSettings";
import { composeSidebarTree } from "./components/sidebar/hooks/useSidebarTree";
import { resolveWorktreeOpenTarget } from "./components/sidebar/hooks/useSidebarWorktreeActions";
import { adaptProjectForSidebarTree } from "./components/sidebar/sidebarTreeAdapters";
import { countActiveDesktopTurns } from "./desktopRelaunchGuard.logic";
import type { SidebarProjectSnapshot } from "./sidebarProjectGrouping";
import { createSessionTabsSelector } from "./sessionTabs.selectors";
import { readSidebarUndoLocalContext } from "./sidebarUndo";
import { useStore } from "./store";
import {
  readWorkspaceMetadataSnapshot,
  workspaceMetadataToCachedShellSnapshot,
} from "./workspaceMetadataProjection";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";

const shell = (
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id: ThreadId.make(id),
  projectId,
  title: `Thread ${id}`,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  goal: null,
  createdAt: T0,
  updatedAt: T0,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: T0,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

const stub = (id: string): OrchestrationArchivedThreadStub => ({
  id: ThreadId.make(id),
  projectId,
  title: `Archived ${id}`,
  branch: null,
  worktreePath: null,
  worktreeId: null,
  createdAt: T0,
  updatedAt: T1,
  archivedAt: T1,
  latestUserMessageAt: T0,
  lineage: null,
});

const state: AppState = syncServerShellSnapshot(
  { activeEnvironmentId: null, environmentStateById: {} },
  {
    snapshotSequence: 5,
    projects: [
      {
        id: projectId,
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: T0,
        updatedAt: T0,
      } as never,
    ],
    threads: [shell("live", { session: null })],
    archivedThreadStubs: [stub("old")],
    updatedAt: T0,
  },
  environmentId,
);
const rows = selectSidebarThreadsAcrossEnvironments(state);
const shells = selectThreadShellsAcrossEnvironments(state);

function projectSnapshot(): SidebarProjectSnapshot {
  return {
    id: projectId,
    environmentId,
    name: "Project",
    cwd: "/repo/project",
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: T0,
    updatedAt: T0,
    scripts: [],
    displayName: "Project",
    environmentPresence: "local-only",
    groupedProjectCount: 1,
    memberProjectRefs: [{ environmentId, projectId }],
    memberProjects: [
      {
        id: projectId,
        environmentId,
        name: "Project",
        cwd: "/repo/project",
        repositoryIdentity: null,
        defaultModelSelection: null,
        createdAt: T0,
        updatedAt: T0,
        scripts: [],
        environmentLabel: null,
        physicalProjectKey: "environment-local:project-1",
      },
    ],
    projectKey: "environment-local:project-1",
    remoteEnvironmentLabels: [],
  } as unknown as SidebarProjectSnapshot;
}

describe("archived stubs in web consumers", () => {
  it("fills the archive panel from stubs: title, archive and creation times", () => {
    const groups = selectArchivedSettingsGroups(
      [{ id: projectId, environmentId, name: "Project", cwd: "/repo/project" } as never],
      shells,
    );
    expect(groups).toHaveLength(1);
    const [archived] = groups[0]!.threads;
    expect(archived).toMatchObject({ id: "old", title: "Archived old", archivedAt: T1 });
    expect(isArchivedThreadStub(archived)).toBe(true);
  });

  it("lists only unarchived threads as command palette thread actions", () => {
    const items = buildThreadActionItems({
      threads: rows,
      projectTitleById: new Map(),
      sortOrder: "updated_at",
      icon: null,
      runThread: async () => undefined,
    });
    expect(items.map((item) => item.value)).toEqual(["thread:live"]);
  });

  it("never counts a stub as a running desktop turn", () => {
    expect(countActiveDesktopTurns(rows, environmentId, true)).toBe(0);
  });

  it("never offers a stub as a session tab", () => {
    const tabs = createSessionTabsSelector()(rows, { worktreeId: null, worktreePath: null });
    expect(tabs.map((tab) => tab.key)).toEqual([
      scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make("live"))),
    ]);
  });

  it("files a stub under the sidebar tree's archived sessions, with no status", () => {
    const adapted = adaptProjectForSidebarTree({ project: projectSnapshot(), threads: rows });
    const archivedRow = adapted.threads.find((thread) => thread.id === "old");
    expect(archivedRow?.statusPill).toBeNull();
    const tree = composeSidebarTree({
      projects: [adapted.project],
      threads: adapted.threads,
      worktrees: adapted.worktrees,
      nowMs: Date.parse(T1),
      isGitRepoByProjectId: { [adapted.project.id]: false },
    });
    const project = tree.projects[0]!;
    expect(project.archivedSessions.map((thread) => thread.id)).toEqual(["old"]);
    expect(project.flatSessions.map((thread) => thread.id)).toEqual(["live"]);
  });

  it("reopens an archived workspace's latest conversation even when it is a stub", () => {
    const archivedRow = adaptProjectForSidebarTree({
      project: projectSnapshot(),
      threads: rows,
    }).threads.find((thread) => thread.id === "old")!;
    const target = resolveWorktreeOpenTarget({
      sessions: [],
      archivedSessions: [archivedRow],
      worktree: {
        worktreeId: "wt",
        projectId,
        branch: "feature",
        worktreePath: "/w",
        origin: "branch",
        archivedAt: T1,
      },
    });
    expect(target.kind === "thread" && target.thread.id).toBe("old");
  });

  it("shows a stub on the project map as an archived, quiet thread", () => {
    const archivedRow = adaptProjectForSidebarTree({
      project: projectSnapshot(),
      threads: rows,
    }).threads.find((thread) => thread.id === "old")!;
    expect(toMapThread(archivedRow, true)).toEqual({
      id: "old",
      title: "Archived old",
      glyph: "idle",
      glyphLabel: "Archived",
      archived: true,
      activityAt: T1,
    });
  });

  it("caches a stub as a marked stub and paints it back as a stub", () => {
    const captured = readWorkspaceMetadataSnapshot(environmentId, 1, false, state)!;
    const cachedStub = captured.threads.find((thread) => thread.id === "old");
    expect(cachedStub).toMatchObject({
      shellDetail: "archived-stub",
      archivedAt: T1,
      modelSelection: null,
      hasPendingApprovals: false,
    });
    const painted = hydrateEnvironmentStateFromCache(
      { activeEnvironmentId: null, environmentStateById: {} },
      workspaceMetadataToCachedShellSnapshot(captured),
      environmentId,
    );
    const entry = selectEnvironmentState(painted, environmentId).threadShellById[
      ThreadId.make("old")
    ];
    expect(isArchivedThreadStub(entry)).toBe(true);
    expect(entry?.title).toBe("Archived old");
    const live = selectEnvironmentState(painted, environmentId).threadShellById[
      ThreadId.make("live")
    ];
    expect(isArchivedThreadStub(live)).toBe(false);
  });

  it("still paints an older cache's archived row (no marker) as a full row", () => {
    const captured = readWorkspaceMetadataSnapshot(environmentId, 1, false, state)!;
    const legacy = {
      ...captured,
      threads: captured.threads.map(({ shellDetail: _marker, ...thread }) => thread),
    };
    const painted = hydrateEnvironmentStateFromCache(
      { activeEnvironmentId: null, environmentStateById: {} },
      workspaceMetadataToCachedShellSnapshot(legacy),
      environmentId,
    );
    const entry = selectEnvironmentState(painted, environmentId).threadShellById[
      ThreadId.make("old")
    ];
    expect(isArchivedThreadStub(entry)).toBe(false);
    expect(entry?.archivedAt).toBe(T1);
  });

  it("keeps undo's local context for a thread whose entry is a stub", () => {
    const previous = useStore.getState();
    useStore.setState(state);
    try {
      const context = readSidebarUndoLocalContext(
        scopeThreadRef(environmentId, ThreadId.make("old")),
      );
      expect(context?.threadTitle).toBe("Archived old");
      expect(typeof context?.threadRevision).toBe("string");
    } finally {
      useStore.setState(previous, true);
    }
  });
});
