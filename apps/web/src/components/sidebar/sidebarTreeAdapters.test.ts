import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { DraftThreadState } from "../../composerDraftStore";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  adaptProjectForSidebarTree,
  createSidebarProjectDraftThreadsSelector,
  mergeSidebarThreadsWithDrafts,
} from "./sidebarTreeAdapters";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");

describe("sidebarTreeAdapters", () => {
  it("adapts active draft sessions into placeholder sidebar tree rows", () => {
    const draftThread = makeDraftThread();
    const draftRows = createSidebarProjectDraftThreadsSelector(makeSidebarProjectSnapshot())({
      draftThreadsByThreadKey: {
        "draft-1": draftThread,
      },
    });

    expect(draftRows).toHaveLength(1);
    expect(draftRows[0]).toMatchObject({
      archivedAt: null,
      branch: "feature/sidebar",
      draftId: "draft-1",
      id: draftThread.threadId,
      projectId: "environment-local:project-1",
      title: "New thread",
      worktreePath: "/repo/project-feature",
    });

    const treeInput = adaptProjectForSidebarTree({
      project: makeSidebarProjectSnapshot(),
      threads: draftRows,
      worktrees: [],
    });

    expect(
      treeInput.threads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    ).toEqual([scopedThreadKey(scopeThreadRef(environmentId, draftThread.threadId))]);
  });

  it("omits drafts that have already been promoted", () => {
    const draftRows = createSidebarProjectDraftThreadsSelector(makeSidebarProjectSnapshot())({
      draftThreadsByThreadKey: {
        "draft-promoted": {
          ...makeDraftThread(),
          promotedTo: scopeThreadRef(environmentId, ThreadId.make("thread-promoted")),
        },
      },
    });

    expect(draftRows).toEqual([]);
  });

  it("lets a materialized server thread shadow a draft with the same scoped id", () => {
    const [draftThread] = createSidebarProjectDraftThreadsSelector(makeSidebarProjectSnapshot())({
      draftThreadsByThreadKey: {
        "draft-1": makeDraftThread(),
      },
    });
    expect(draftThread).toBeDefined();
    const serverThread = {
      ...draftThread!,
      draftId: undefined,
      title: "Materialized thread",
    };

    const merged = mergeSidebarThreadsWithDrafts([serverThread], [draftThread!]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toBe("Materialized thread");
  });

  it("keeps selector output stable when unrelated project drafts change", () => {
    const project = makeSidebarProjectSnapshot();
    const selector = createSidebarProjectDraftThreadsSelector(project);
    const draftThread = makeDraftThread();
    const first = selector({
      draftThreadsByThreadKey: {
        "draft-1": draftThread,
      },
    });
    const unrelatedProjectDraft = makeDraftThread({
      projectId: ProjectId.make("project-2"),
      threadId: ThreadId.make("thread-other-draft"),
    });

    const withUnrelatedDraft = selector({
      draftThreadsByThreadKey: {
        "draft-1": draftThread,
        "draft-unrelated": unrelatedProjectDraft,
      },
    });
    const withChangedProjectDraft = selector({
      draftThreadsByThreadKey: {
        "draft-1": {
          ...draftThread,
          branch: "feature/sidebar-updated",
        },
        "draft-unrelated": unrelatedProjectDraft,
      },
    });

    expect(withUnrelatedDraft).toBe(first);
    expect(withChangedProjectDraft).not.toBe(first);
    expect(withChangedProjectDraft[0]?.branch).toBe("feature/sidebar-updated");
  });

  it("synthesizes one original-directory candidate per physical project environment", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const remoteProjectId = ProjectId.make("project-remote");
    const project = makeSidebarProjectSnapshot();
    const adapted = adaptProjectForSidebarTree({
      project: {
        ...project,
        groupedProjectCount: 2,
        memberProjectRefs: [
          ...project.memberProjectRefs,
          { environmentId: remoteEnvironmentId, projectId: remoteProjectId },
        ],
        memberProjects: [
          ...project.memberProjects,
          {
            ...project.memberProjects[0]!,
            id: remoteProjectId,
            environmentId: remoteEnvironmentId,
            cwd: "/remote/repo/project",
            environmentLabel: "Remote",
            physicalProjectKey: "environment-remote:/remote/repo/project",
          },
        ],
      },
      threads: [],
      worktrees: [],
    });

    expect(
      adapted.worktrees.map((worktree) => ({
        environmentId: worktree.environmentId,
        sourceProjectCwd: worktree.sourceProjectCwd,
      })),
    ).toEqual([
      {
        environmentId,
        sourceProjectCwd: "/repo/project",
      },
      {
        environmentId: remoteEnvironmentId,
        sourceProjectCwd: "/remote/repo/project",
      },
    ]);
  });
});

function makeDraftThread(overrides: Partial<DraftThreadState> = {}): DraftThreadState {
  return {
    branch: "feature/sidebar",
    createdAt: "2026-05-09T00:00:00.000Z",
    environmentId,
    envMode: "worktree",
    interactionMode: "default",
    logicalProjectKey: "environment-local:project-1",
    projectId,
    runtimeMode: "full-access",
    threadId: ThreadId.make("thread-draft"),
    worktreePath: "/repo/project-feature",
    ...overrides,
  };
}

function makeSidebarProjectSnapshot(): SidebarProjectSnapshot {
  return {
    id: projectId,
    environmentId,
    name: "Project",
    cwd: "/repo/project",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
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
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
        scripts: [],
        environmentLabel: null,
        physicalProjectKey: "environment-local:project-1",
      },
    ],
    projectKey: "environment-local:project-1",
    remoteEnvironmentLabels: [],
  };
}
