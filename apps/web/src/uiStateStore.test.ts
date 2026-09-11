import { ProjectId, ThreadId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearThreadUi,
  createProjectFolder,
  deleteProjectFolder,
  hydratePersistedProjectState,
  markThreadVisited,
  markThreadUnread,
  moveProjectsBetweenFolders,
  moveProjectsToFolder,
  moveProjectsToRoot,
  PERSISTED_STATE_KEY,
  type PersistedUiState,
  persistState,
  projectFolderTreeItemId,
  projectTreeItemId,
  renameProjectFolder,
  reorderProjects,
  reorderProjectTreeItem,
  readPersistedState,
  resolveSidebarModeForDocument,
  setAlwaysUseBuildMode,
  setDefaultAdvertisedEndpointKey,
  setProjectFolderExpanded,
  setProjectExpanded,
  setThreadChangedFilesExpanded,
  setThreadPinned,
  setThreadTurnFoldExpanded,
  setThreadWorkEntryExpanded,
  setThreadWorkGroupExpanded,
  setWideComposerControlsAutoCollapse,
  syncProjects,
  syncThreads,
  toggleThreadPinned,
  type UiState,
} from "./uiStateStore";

function makeUiState(overrides: Partial<UiState> = {}): UiState {
  return {
    sidebarMode: "inbox",
    projectExpandedById: {},
    projectOrder: [],
    projectFoldersById: {},
    projectFolderOrder: [],
    projectTreeOrder: [],
    pinnedThreadKeys: {},
    threadLastVisitedAtById: {},
    threadChangedFilesExpandedById: {},
    threadTurnFoldExpandedById: {},
    threadWorkGroupExpandedById: {},
    threadWorkEntryExpandedById: {},
    defaultAdvertisedEndpointKey: null,
    wideComposerControlsAutoCollapse: true,
    alwaysUseBuildMode: true,
    ...overrides,
  };
}

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => {
      store.clear();
    },
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

describe("uiStateStore pure functions", () => {
  it("selects Inbox only for a genuinely fresh state document", () => {
    expect(resolveSidebarModeForDocument({ documentFound: false, persistedMode: undefined })).toBe(
      "inbox",
    );
  });

  it("migrates an existing pre-feature state document to Projects", () => {
    expect(resolveSidebarModeForDocument({ documentFound: true, persistedMode: undefined })).toBe(
      "projects",
    );
  });

  it("restores an explicit persisted sidebar mode", () => {
    expect(resolveSidebarModeForDocument({ documentFound: true, persistedMode: "inbox" })).toBe(
      "inbox",
    );
    expect(resolveSidebarModeForDocument({ documentFound: true, persistedMode: "projects" })).toBe(
      "projects",
    );
  });

  it("markThreadVisited stores the provided server timestamp", () => {
    const threadId = ThreadId.make("thread-1");
    const initialState = makeUiState();

    const next = markThreadVisited(initialState, threadId, "2026-02-25T12:30:00.700Z");

    expect(next.threadLastVisitedAtById[threadId]).toBe("2026-02-25T12:30:00.700Z");
  });

  it("markThreadVisited does not move visit state backwards under clock skew", () => {
    const threadId = ThreadId.make("thread-1");
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [threadId]: "2026-02-25T12:30:00.700Z",
      },
    });

    const next = markThreadVisited(initialState, threadId, "2026-02-25T12:30:00.000Z");

    expect(next).toBe(initialState);
  });

  it("markThreadUnread moves lastVisitedAt before completion for a completed thread", () => {
    const threadId = ThreadId.make("thread-1");
    const latestTurnCompletedAt = "2026-02-25T12:30:00.000Z";
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [threadId]: "2026-02-25T12:35:00.000Z",
      },
    });

    const next = markThreadUnread(initialState, threadId, latestTurnCompletedAt);

    expect(next.threadLastVisitedAtById[threadId]).toBe("2026-02-25T12:29:59.999Z");
  });

  it("markThreadUnread does not change a thread without a completed turn", () => {
    const threadId = ThreadId.make("thread-1");
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [threadId]: "2026-02-25T12:35:00.000Z",
      },
    });

    const next = markThreadUnread(initialState, threadId, null);

    expect(next).toBe(initialState);
  });

  it("setThreadPinned stores and removes pinned thread keys", () => {
    const threadId = ThreadId.make("thread-1");
    const pinned = setThreadPinned(makeUiState(), threadId, true);

    expect(pinned.pinnedThreadKeys).toEqual({ [threadId]: true });
    expect(setThreadPinned(pinned, threadId, true)).toBe(pinned);

    const unpinned = setThreadPinned(pinned, threadId, false);
    expect(unpinned.pinnedThreadKeys).toEqual({});
    expect(setThreadPinned(unpinned, threadId, false)).toBe(unpinned);
  });

  it("toggleThreadPinned flips pinned thread state", () => {
    const threadId = ThreadId.make("thread-1");
    const pinned = toggleThreadPinned(makeUiState(), threadId);
    const unpinned = toggleThreadPinned(pinned, threadId);

    expect(pinned.pinnedThreadKeys).toEqual({ [threadId]: true });
    expect(unpinned.pinnedThreadKeys).toEqual({});
  });

  it("reorderProjects moves a project to a target index", () => {
    const project1 = ProjectId.make("project-1");
    const project2 = ProjectId.make("project-2");
    const project3 = ProjectId.make("project-3");
    const initialState = makeUiState({
      projectOrder: [project1, project2, project3],
    });

    const next = reorderProjects(initialState, [project1], [project3]);

    expect(next.projectOrder).toEqual([project2, project3, project1]);
  });

  it("reorderProjects is a no-op when dragged key is not in projectOrder", () => {
    const project1 = ProjectId.make("project-1");
    const project2 = ProjectId.make("project-2");
    const initialState = makeUiState({
      projectOrder: [project1, project2],
    });

    const next = reorderProjects(initialState, [ProjectId.make("missing")], [project2]);

    expect(next).toBe(initialState);
  });

  it("setDefaultAdvertisedEndpointKey stores endpoint preference by stable key", () => {
    const initialState = makeUiState();

    const next = setDefaultAdvertisedEndpointKey(initialState, "desktop-core:lan:http");

    expect(next.defaultAdvertisedEndpointKey).toBe("desktop-core:lan:http");
    expect(setDefaultAdvertisedEndpointKey(next, "desktop-core:lan:http")).toBe(next);
    expect(setDefaultAdvertisedEndpointKey(next, "")).toMatchObject({
      defaultAdvertisedEndpointKey: null,
    });
  });

  it("reorderProjects moves all member keys of a multi-member group together", () => {
    const keyALocal = "env-local:proj-a";
    const keyARemote = "env-remote:proj-a";
    const keyB = "env-local:proj-b";
    const keyC = "env-local:proj-c";
    const initialState = makeUiState({
      projectOrder: [keyALocal, keyARemote, keyB, keyC],
    });

    const next = reorderProjects(initialState, [keyALocal, keyARemote], [keyC]);

    expect(next.projectOrder).toEqual([keyB, keyC, keyALocal, keyARemote]);
  });

  it("reorderProjects handles member keys scattered across projectOrder", () => {
    const keyALocal = "env-local:proj-a";
    const keyB = "env-local:proj-b";
    const keyARemote = "env-remote:proj-a";
    const keyC = "env-local:proj-c";
    const initialState = makeUiState({
      projectOrder: [keyALocal, keyB, keyARemote, keyC],
    });

    const next = reorderProjects(initialState, [keyALocal, keyARemote], [keyC]);

    expect(next.projectOrder).toEqual([keyB, keyC, keyALocal, keyARemote]);
  });

  it("reorderProjects places group after target when dragged from before a non-last target", () => {
    const keyALocal = "env-local:proj-a";
    const keyARemote = "env-remote:proj-a";
    const keyB = "env-local:proj-b";
    const keyC = "env-local:proj-c";
    const keyD = "env-local:proj-d";
    const initialState = makeUiState({
      projectOrder: [keyALocal, keyARemote, keyB, keyC, keyD],
    });

    const next = reorderProjects(initialState, [keyALocal, keyARemote], [keyC]);

    expect(next.projectOrder).toEqual([keyB, keyC, keyALocal, keyARemote, keyD]);
  });

  it("reorderProjects places group before target when dragged from after", () => {
    const keyB = "env-local:proj-b";
    const keyC = "env-local:proj-c";
    const keyALocal = "env-local:proj-a";
    const keyARemote = "env-remote:proj-a";
    const initialState = makeUiState({
      projectOrder: [keyB, keyC, keyALocal, keyARemote],
    });

    const next = reorderProjects(initialState, [keyALocal, keyARemote], [keyB]);

    expect(next.projectOrder).toEqual([keyALocal, keyARemote, keyB, keyC]);
  });

  it("reorderProjects with multi-member target inserts after first target occurrence", () => {
    const keyALocal = "env-local:proj-a";
    const keyARemote = "env-remote:proj-a";
    const keyBLocal = "env-local:proj-b";
    const keyBRemote = "env-remote:proj-b";
    const initialState = makeUiState({
      projectOrder: [keyALocal, keyARemote, keyBLocal, keyBRemote],
    });

    const next = reorderProjects(initialState, [keyALocal, keyARemote], [keyBLocal, keyBRemote]);

    // Target members may become non-contiguous; this is fine because the
    // sidebar groups by logical key using first-occurrence positioning.
    expect(next.projectOrder).toEqual([keyBLocal, keyALocal, keyARemote, keyBRemote]);
  });

  it("reorderProjects is a no-op when dragged group equals target group", () => {
    const key1 = "env-local:proj-a";
    const key2 = "env-remote:proj-a";
    const initialState = makeUiState({
      projectOrder: [key1, key2, "env-local:proj-b"],
    });

    const next = reorderProjects(initialState, [key1, key2], [key1, key2]);

    expect(next).toBe(initialState);
  });

  it("reorderProjects is a no-op when dragged keys are not in projectOrder", () => {
    const initialState = makeUiState({
      projectOrder: ["env-local:proj-a", "env-local:proj-b"],
    });

    const next = reorderProjects(initialState, ["env-local:missing"], ["env-local:proj-b"]);

    expect(next).toBe(initialState);
  });

  it("syncProjects preserves current project order during snapshot recovery", () => {
    const project1 = ProjectId.make("project-1");
    const project2 = ProjectId.make("project-2");
    const project3 = ProjectId.make("project-3");
    const initialState = makeUiState({
      projectExpandedById: {
        [project1]: true,
        [project2]: false,
      },
      projectOrder: [project2, project1],
    });

    const next = syncProjects(initialState, [
      { key: project1, logicalKey: project1, cwd: "/tmp/project-1" },
      { key: project2, logicalKey: project2, cwd: "/tmp/project-2" },
      { key: project3, logicalKey: project3, cwd: "/tmp/project-3" },
    ]);

    expect(next.projectOrder).toEqual([project2, project1, project3]);
    expect(next.projectExpandedById[project2]).toBe(false);
  });

  it("syncProjects preserves manual order across project id churn at the same cwd", () => {
    // Under the current design, physical key and logical key are both
    // cwd-derived, so an internal project-id change doesn't alter the store
    // keys. This test locks in that stability: re-syncing the same cwds keeps
    // manual order and collapse state.
    const keyProject1 = "env-local:/tmp/project-1";
    const keyProject2 = "env-local:/tmp/project-2";
    const initialState = syncProjects(
      makeUiState({
        projectExpandedById: {
          [keyProject1]: true,
          [keyProject2]: false,
        },
        projectOrder: [keyProject2, keyProject1],
      }),
      [
        { key: keyProject1, logicalKey: keyProject1, cwd: "/tmp/project-1" },
        { key: keyProject2, logicalKey: keyProject2, cwd: "/tmp/project-2" },
      ],
    );

    const next = syncProjects(initialState, [
      { key: keyProject1, logicalKey: keyProject1, cwd: "/tmp/project-1" },
      { key: keyProject2, logicalKey: keyProject2, cwd: "/tmp/project-2" },
    ]);

    expect(next.projectOrder).toEqual([keyProject2, keyProject1]);
    expect(next.projectExpandedById[keyProject2]).toBe(false);
  });

  it("syncProjects returns a new state when only project cwd changes", () => {
    const project1 = ProjectId.make("project-1");
    const initialState = syncProjects(
      makeUiState({
        projectExpandedById: {
          [project1]: false,
        },
        projectOrder: [project1],
      }),
      [{ key: project1, logicalKey: project1, cwd: "/tmp/project-1" }],
    );

    const next = syncProjects(initialState, [
      { key: project1, logicalKey: project1, cwd: "/tmp/project-1-renamed" },
    ]);

    expect(next).not.toBe(initialState);
    expect(next.projectOrder).toEqual([project1]);
    expect(next.projectExpandedById[project1]).toBe(false);
  });

  it("syncProjects keys projectExpandedById by the logical key, not the physical key", () => {
    // In repository grouping mode, multiple physical projects (different
    // environments or different repo-relative paths) collapse into one
    // logical group. The group's expand state must be keyed by the logical
    // key so clicks on the grouped row toggle the shared state, and so the
    // state survives subsequent syncProjects calls (which rebuild the map
    // from incoming inputs).
    const physicalLocal = "env-local:/repo/project";
    const physicalRemote = "env-remote:/repo/project";
    const logicalKey = "repo-canonical-key";

    const initial = syncProjects(makeUiState(), [
      { key: physicalLocal, logicalKey, cwd: "/repo/project" },
      { key: physicalRemote, logicalKey, cwd: "/repo/project" },
    ]);

    expect(initial.projectExpandedById).toEqual({ [logicalKey]: true });

    const afterCollapse = { ...initial, projectExpandedById: { [logicalKey]: false } };
    const next = syncProjects(afterCollapse, [
      { key: physicalLocal, logicalKey, cwd: "/repo/project" },
      { key: physicalRemote, logicalKey, cwd: "/repo/project" },
    ]);

    expect(next.projectExpandedById[logicalKey]).toBe(false);
  });

  it("syncProjects preserves expand state when a project's logical key changes", () => {
    // Example: late-arriving repo metadata flips grouping identity from the
    // physical key to a canonical repository key. The row did not actually
    // change, so the user's collapse choice must carry over.
    const physicalKey = "env-local:/repo/project";
    const previousLogicalKey = physicalKey;
    const nextLogicalKey = "repo-canonical-key";

    const initial = syncProjects(makeUiState(), [
      { key: physicalKey, logicalKey: previousLogicalKey, cwd: "/repo/project" },
    ]);

    expect(initial.projectExpandedById[previousLogicalKey]).toBe(true);

    const afterCollapse = {
      ...initial,
      projectExpandedById: { [previousLogicalKey]: false },
    };
    const next = syncProjects(afterCollapse, [
      { key: physicalKey, logicalKey: nextLogicalKey, cwd: "/repo/project" },
    ]);

    expect(next.projectExpandedById[nextLogicalKey]).toBe(false);
  });

  it("syncThreads prunes missing thread UI state", () => {
    const thread1 = ThreadId.make("thread-1");
    const thread2 = ThreadId.make("thread-2");
    const initialState = makeUiState({
      pinnedThreadKeys: {
        [thread1]: true,
        [thread2]: true,
      },
      threadLastVisitedAtById: {
        [thread1]: "2026-02-25T12:35:00.000Z",
        [thread2]: "2026-02-25T12:36:00.000Z",
      },
      threadChangedFilesExpandedById: {
        [thread1]: {
          "turn-1": false,
        },
        [thread2]: {
          "turn-2": false,
        },
      },
      threadTurnFoldExpandedById: {
        [thread1]: { "turn-fold:settled:turn-1": true },
        [thread2]: { "turn-fold:running:turn-2": false },
      },
      threadWorkGroupExpandedById: {
        [thread1]: { "work-group:work-1": true },
        [thread2]: { "work-group:work-2": true },
      },
    });

    const next = syncThreads(initialState, [{ key: thread1 }]);

    expect(next.pinnedThreadKeys).toEqual({
      [thread1]: true,
    });
    expect(next.threadLastVisitedAtById).toEqual({
      [thread1]: "2026-02-25T12:35:00.000Z",
    });
    expect(next.threadChangedFilesExpandedById).toEqual({
      [thread1]: {
        "turn-1": false,
      },
    });
    expect(next.threadTurnFoldExpandedById).toEqual({
      [thread1]: { "turn-fold:settled:turn-1": true },
    });
    expect(next.threadWorkGroupExpandedById).toEqual({
      [thread1]: { "work-group:work-1": true },
    });
  });

  it("syncThreads seeds visit state for unseen snapshot threads", () => {
    const thread1 = ThreadId.make("thread-1");
    const initialState = makeUiState();

    const next = syncThreads(initialState, [
      {
        key: thread1,
        seedVisitedAt: "2026-02-25T12:35:00.000Z",
      },
    ]);

    expect(next.threadLastVisitedAtById).toEqual({
      [thread1]: "2026-02-25T12:35:00.000Z",
    });
  });

  it("setProjectExpanded updates expansion without touching order", () => {
    const project1 = ProjectId.make("project-1");
    const initialState = makeUiState({
      projectExpandedById: {
        [project1]: true,
      },
      projectOrder: [project1],
    });

    const next = setProjectExpanded(initialState, project1, false);

    expect(next.projectExpandedById[project1]).toBe(false);
    expect(next.projectOrder).toEqual([project1]);
  });

  it("createProjectFolder creates a named local folder and moves initial projects into it", () => {
    const initialState = makeUiState({
      projectOrder: ["project-a", "project-b"],
      projectTreeOrder: [projectTreeItemId("project-a"), projectTreeItemId("project-b")],
    });

    const next = createProjectFolder(initialState, " WordPress ", ["project-a"], {
      folderId: "folder-wordpress",
      now: "2026-06-09T00:00:00.000Z",
    });

    expect(next.projectFolderOrder).toEqual(["folder-wordpress"]);
    expect(next.projectFoldersById["folder-wordpress"]).toMatchObject({
      id: "folder-wordpress",
      name: "WordPress",
      projectKeys: ["project-a"],
      expanded: true,
    });
    expect(next.projectTreeOrder).toEqual([
      projectTreeItemId("project-b"),
      projectFolderTreeItemId("folder-wordpress"),
    ]);
  });

  it("renameProjectFolder and setProjectFolderExpanded update only the target folder", () => {
    const initialState = createProjectFolder(makeUiState(), "WordPress", [], {
      folderId: "folder-wordpress",
      now: "2026-06-09T00:00:00.000Z",
    });

    const renamed = renameProjectFolder(
      initialState,
      "folder-wordpress",
      "WP",
      "2026-06-09T00:01:00.000Z",
    );
    const collapsed = setProjectFolderExpanded(renamed, "folder-wordpress", false);

    expect(collapsed.projectFoldersById["folder-wordpress"]).toMatchObject({
      name: "WP",
      expanded: false,
    });
    expect(renameProjectFolder(collapsed, "missing", "Other")).toBe(collapsed);
  });

  it("deleteProjectFolder removes only the folder and keeps projects in root order", () => {
    const initialState = createProjectFolder(
      makeUiState({
        projectOrder: ["project-a", "project-b"],
        projectTreeOrder: [projectTreeItemId("project-a"), projectTreeItemId("project-b")],
      }),
      "WordPress",
      ["project-a"],
      { folderId: "folder-wordpress", now: "2026-06-09T00:00:00.000Z" },
    );

    const next = deleteProjectFolder(initialState, "folder-wordpress");

    expect(next.projectFoldersById).toEqual({});
    expect(next.projectFolderOrder).toEqual([]);
    expect(next.projectTreeOrder).toEqual([
      projectTreeItemId("project-b"),
      projectTreeItemId("project-a"),
    ]);
  });

  it("moveProjectsToFolder removes moved projects from other folders before inserting", () => {
    const withFolders = createProjectFolder(
      createProjectFolder(
        makeUiState({
          projectOrder: ["project-a", "project-b", "project-c"],
          projectTreeOrder: [
            projectTreeItemId("project-a"),
            projectTreeItemId("project-b"),
            projectTreeItemId("project-c"),
          ],
        }),
        "WordPress",
        ["project-a", "project-b"],
        { folderId: "folder-wordpress", now: "2026-06-09T00:00:00.000Z" },
      ),
      "Clients",
      [],
      { folderId: "folder-clients", now: "2026-06-09T00:00:01.000Z" },
    );

    const next = moveProjectsToFolder(withFolders, ["project-b", "project-c"], "folder-clients");

    expect(next.projectFoldersById["folder-wordpress"]?.projectKeys).toEqual(["project-a"]);
    expect(next.projectFoldersById["folder-clients"]?.projectKeys).toEqual([
      "project-b",
      "project-c",
    ]);
    expect(next.projectTreeOrder).toEqual([
      projectFolderTreeItemId("folder-wordpress"),
      projectFolderTreeItemId("folder-clients"),
    ]);
  });

  it("moveProjectsToRoot removes folder membership and inserts root tree items", () => {
    const initialState = createProjectFolder(
      makeUiState({
        projectOrder: ["project-a", "project-b"],
        projectTreeOrder: [projectTreeItemId("project-a"), projectTreeItemId("project-b")],
      }),
      "WordPress",
      ["project-a"],
      { folderId: "folder-wordpress", now: "2026-06-09T00:00:00.000Z" },
    );

    const next = moveProjectsToRoot(initialState, ["project-a"], 0);

    expect(next.projectFoldersById["folder-wordpress"]?.projectKeys).toEqual([]);
    expect(next.projectTreeOrder).toEqual([
      projectTreeItemId("project-a"),
      projectTreeItemId("project-b"),
      projectFolderTreeItemId("folder-wordpress"),
    ]);
  });

  it("moveProjectsToRoot re-roots grouped projects by logical tree item", () => {
    const localProjectKey = "env-local:/repo/project";
    const remoteProjectKey = "env-remote:/repo/project";
    const logicalProjectKey = "repo-canonical-key";
    const otherProjectKey = "env-local:/repo/other";
    const synced = syncProjects(makeUiState(), [
      { key: localProjectKey, logicalKey: logicalProjectKey, cwd: "/repo/project" },
      { key: remoteProjectKey, logicalKey: logicalProjectKey, cwd: "/repo/project" },
      { key: otherProjectKey, logicalKey: otherProjectKey, cwd: "/repo/other" },
    ]);
    expect(synced.projectTreeOrder).toEqual([
      projectTreeItemId(logicalProjectKey),
      projectTreeItemId(otherProjectKey),
    ]);
    const initialState = createProjectFolder(
      synced,
      "Grouped",
      [localProjectKey, remoteProjectKey],
      { folderId: "folder-grouped", now: "2026-06-09T00:00:00.000Z" },
    );
    expect(initialState.projectTreeOrder).toEqual([
      projectTreeItemId(otherProjectKey),
      projectFolderTreeItemId("folder-grouped"),
    ]);

    const next = moveProjectsToRoot(initialState, [localProjectKey, remoteProjectKey], 0);

    expect(next.projectFoldersById["folder-grouped"]?.projectKeys).toEqual([]);
    expect(next.projectTreeOrder).toEqual([
      projectTreeItemId(logicalProjectKey),
      projectTreeItemId(otherProjectKey),
      projectFolderTreeItemId("folder-grouped"),
    ]);
    expect(next.projectTreeOrder).not.toContain(projectTreeItemId(localProjectKey));
    expect(next.projectTreeOrder).not.toContain(projectTreeItemId(remoteProjectKey));
  });

  it("moveProjectsBetweenFolders delegates to target folder insertion", () => {
    const initialState = createProjectFolder(
      createProjectFolder(
        makeUiState({
          projectOrder: ["project-a"],
          projectTreeOrder: [projectTreeItemId("project-a")],
        }),
        "WordPress",
        ["project-a"],
        { folderId: "folder-wordpress", now: "2026-06-09T00:00:00.000Z" },
      ),
      "Clients",
      [],
      { folderId: "folder-clients", now: "2026-06-09T00:00:01.000Z" },
    );

    const next = moveProjectsBetweenFolders(
      initialState,
      ["project-a"],
      "folder-wordpress",
      "folder-clients",
    );

    expect(next.projectFoldersById["folder-wordpress"]?.projectKeys).toEqual([]);
    expect(next.projectFoldersById["folder-clients"]?.projectKeys).toEqual(["project-a"]);
  });

  it("reorderProjectTreeItem reorders root items and keeps flat project order aligned", () => {
    const initialState = makeUiState({
      projectOrder: ["project-a", "project-b"],
      projectTreeOrder: [projectTreeItemId("project-a"), projectTreeItemId("project-b")],
    });

    const next = reorderProjectTreeItem(
      initialState,
      projectTreeItemId("project-a"),
      projectTreeItemId("project-b"),
    );

    expect(next.projectTreeOrder).toEqual([
      projectTreeItemId("project-b"),
      projectTreeItemId("project-a"),
    ]);
    expect(next.projectOrder).toEqual(["project-b", "project-a"]);
  });

  it("syncProjects prunes stale folder project keys and preserves empty folders", () => {
    const initialState = createProjectFolder(
      makeUiState({
        projectOrder: ["project-a", "project-b"],
        projectTreeOrder: [projectTreeItemId("project-a"), projectTreeItemId("project-b")],
      }),
      "WordPress",
      ["project-a", "project-b"],
      { folderId: "folder-wordpress", now: "2026-06-09T00:00:00.000Z" },
    );

    const next = syncProjects(initialState, [
      { key: "project-a", logicalKey: "project-a", cwd: "/project-a" },
    ]);

    expect(next.projectFoldersById["folder-wordpress"]?.projectKeys).toEqual(["project-a"]);
    expect(next.projectFolderOrder).toEqual(["folder-wordpress"]);
  });

  it("preserves local folders and order while another node loads first", () => {
    const local = { key: "local:/work", logicalKey: "local:/work", cwd: "/work" };
    const remote = { key: "remote:/other", logicalKey: "remote:/other", cwd: "/other" };
    const initial = createProjectFolder(
      syncProjects(makeUiState(), [local, remote]),
      "My projects",
      [local.key, remote.key],
      { folderId: "saved-folder", now: "2026-09-11T00:00:00.000Z" },
    );
    const waiting = syncProjects(initial, [remote], {
      authoritativeEnvironmentIds: new Set(["remote"]),
    });
    expect(waiting.projectFoldersById["saved-folder"]?.projectKeys).toEqual([
      local.key,
      remote.key,
    ]);
    expect(waiting.projectOrder).toEqual(initial.projectOrder);

    const restored = syncProjects(waiting, [remote, local], {
      authoritativeEnvironmentIds: new Set(["local", "remote"]),
    });
    expect(restored.projectFoldersById["saved-folder"]?.projectKeys).toEqual([
      local.key,
      remote.key,
    ]);
    const deleted = syncProjects(restored, [remote], {
      authoritativeEnvironmentIds: new Set(["local", "remote"]),
    });
    expect(deleted.projectFoldersById["saved-folder"]?.projectKeys).toEqual([remote.key]);
  });

  it("preserves unloaded and cached node preferences through persistence until a live catalog arrives", () => {
    const initial = createProjectFolder(
      makeUiState({
        pinnedThreadKeys: { "local:previous": true, "remote:removed": true },
        threadLastVisitedAtById: { "local:previous": "2026-09-10T00:00:00.000Z" },
        threadChangedFilesExpandedById: { "local:previous": { turn: false } },
      }),
      "My projects",
      ["local:/work"],
      { folderId: "saved-folder", now: "2026-09-11T00:00:00.000Z" },
    );
    const cachedScope = { authoritativeEnvironmentIds: new Set<string>() };
    const waiting = syncThreads(syncProjects(initial, [], cachedScope), [], cachedScope);
    vi.stubGlobal("window", { localStorage: createLocalStorageStub() });
    try {
      persistState(waiting);
      const persisted = readPersistedState();
      expect(persisted.projectFoldersById["saved-folder"]?.projectKeys).toEqual(["local:/work"]);
      expect(persisted.pinnedThreadKeys).toEqual(initial.pinnedThreadKeys);
      expect(persisted.threadChangedFilesExpandedById).toEqual(
        initial.threadChangedFilesExpandedById,
      );
    } finally {
      vi.unstubAllGlobals();
    }

    const remoteLoaded = syncThreads(waiting, [], {
      authoritativeEnvironmentIds: new Set(["remote"]),
    });
    expect(remoteLoaded.pinnedThreadKeys).toEqual({ "local:previous": true });
    expect(remoteLoaded.threadLastVisitedAtById).toEqual(initial.threadLastVisitedAtById);
    const localLoaded = syncThreads(remoteLoaded, [], {
      authoritativeEnvironmentIds: new Set(["local", "remote"]),
    });
    expect(localLoaded.pinnedThreadKeys).toEqual({});
    expect(localLoaded.threadLastVisitedAtById).toEqual({});
  });

  it("syncProjects preserves folder membership across project id churn at the same physical key", () => {
    const physicalKey = "env-local:/tmp/project";
    const initialState = createProjectFolder(
      makeUiState({
        projectOrder: [physicalKey],
        projectTreeOrder: [projectTreeItemId(physicalKey)],
      }),
      "WordPress",
      [physicalKey],
      { folderId: "folder-wordpress", now: "2026-06-09T00:00:00.000Z" },
    );

    const next = syncProjects(initialState, [
      { key: physicalKey, logicalKey: "project-id-after-churn", cwd: "/tmp/project" },
    ]);

    expect(next.projectFoldersById["folder-wordpress"]?.projectKeys).toEqual([physicalKey]);
  });

  it("clearThreadUi removes visit state for deleted threads", () => {
    const thread1 = ThreadId.make("thread-1");
    const initialState = makeUiState({
      pinnedThreadKeys: {
        [thread1]: true,
      },
      threadLastVisitedAtById: {
        [thread1]: "2026-02-25T12:35:00.000Z",
      },
      threadChangedFilesExpandedById: {
        [thread1]: {
          "turn-1": false,
        },
      },
      threadTurnFoldExpandedById: {
        [thread1]: { "turn-fold:settled:turn-1": true },
      },
      threadWorkGroupExpandedById: {
        [thread1]: { "work-group:work-1": true },
      },
    });

    const next = clearThreadUi(initialState, thread1);

    expect(next.pinnedThreadKeys).toEqual({});
    expect(next.threadLastVisitedAtById).toEqual({});
    expect(next.threadChangedFilesExpandedById).toEqual({});
    expect(next.threadTurnFoldExpandedById).toEqual({});
    expect(next.threadWorkGroupExpandedById).toEqual({});
  });

  it("setThreadChangedFilesExpanded stores collapsed turns per thread", () => {
    const thread1 = ThreadId.make("thread-1");
    const initialState = makeUiState();

    const next = setThreadChangedFilesExpanded(initialState, thread1, "turn-1", false);

    expect(next.threadChangedFilesExpandedById).toEqual({
      [thread1]: {
        "turn-1": false,
      },
    });
  });

  it("setThreadChangedFilesExpanded removes thread overrides when expanded again", () => {
    const thread1 = ThreadId.make("thread-1");
    const initialState = makeUiState({
      threadChangedFilesExpandedById: {
        [thread1]: {
          "turn-1": false,
        },
      },
    });

    const next = setThreadChangedFilesExpanded(initialState, thread1, "turn-1", true);

    expect(next.threadChangedFilesExpandedById).toEqual({});
  });

  it("setThreadWorkEntryExpanded stores per-entry expand state under the thread key", () => {
    const thread1 = ThreadId.make("thread-1");
    const initialState = makeUiState();

    const next = setThreadWorkEntryExpanded(initialState, thread1, "entry-1", true);

    expect(next.threadWorkEntryExpandedById).toEqual({
      [thread1]: {
        "entry-1": true,
      },
    });
  });

  it("setThreadWorkEntryExpanded keeps existing entries when toggling another", () => {
    const thread1 = ThreadId.make("thread-1");
    const initialState = makeUiState({
      threadWorkEntryExpandedById: {
        [thread1]: {
          "entry-1": true,
        },
      },
    });

    const next = setThreadWorkEntryExpanded(initialState, thread1, "entry-2", false);

    expect(next.threadWorkEntryExpandedById).toEqual({
      [thread1]: {
        "entry-1": true,
        "entry-2": false,
      },
    });
  });

  it("setThreadWorkEntryExpanded keeps state stable across threads", () => {
    const thread1 = ThreadId.make("thread-1");
    const thread2 = ThreadId.make("thread-2");
    const initialState = makeUiState({
      threadWorkEntryExpandedById: {
        [thread1]: { "entry-1": true },
      },
    });

    const next = setThreadWorkEntryExpanded(initialState, thread2, "entry-9", false);

    expect(next.threadWorkEntryExpandedById).toEqual({
      [thread1]: { "entry-1": true },
      [thread2]: { "entry-9": false },
    });
  });

  it("setThreadWorkEntryExpanded returns the same state when toggling to current value", () => {
    const thread1 = ThreadId.make("thread-1");
    const initialState = makeUiState({
      threadWorkEntryExpandedById: {
        [thread1]: { "entry-1": true },
      },
    });

    const next = setThreadWorkEntryExpanded(initialState, thread1, "entry-1", true);

    expect(next).toBe(initialState);
  });

  it("stores turn-fold and work-group expansion independently", () => {
    const thread1 = ThreadId.make("thread-1");
    const withRunningFoldCollapsed = setThreadTurnFoldExpanded(
      makeUiState(),
      thread1,
      "turn-fold:running:turn-1",
      false,
    );
    const next = setThreadWorkGroupExpanded(
      withRunningFoldCollapsed,
      thread1,
      "work-group:work-1",
      true,
    );

    expect(next.threadTurnFoldExpandedById).toEqual({
      [thread1]: { "turn-fold:running:turn-1": false },
    });
    expect(next.threadWorkGroupExpandedById).toEqual({
      [thread1]: { "work-group:work-1": true },
    });
    expect(next.threadWorkEntryExpandedById).toEqual({});
  });

  it("keeps running and settled fold overrides under distinct lifecycle keys", () => {
    const thread1 = ThreadId.make("thread-1");
    const running = setThreadTurnFoldExpanded(
      makeUiState(),
      thread1,
      "turn-fold:running:turn-1",
      true,
    );
    const settled = setThreadTurnFoldExpanded(running, thread1, "turn-fold:settled:turn-1", false);

    expect(settled.threadTurnFoldExpandedById[thread1]).toEqual({
      "turn-fold:running:turn-1": true,
      "turn-fold:settled:turn-1": false,
    });
  });
});

describe("uiStateStore persistence round-trip", () => {
  let localStorageStub: Storage;

  beforeEach(() => {
    localStorageStub = createLocalStorageStub();
    vi.stubGlobal("window", { localStorage: localStorageStub });
    vi.stubGlobal("localStorage", localStorageStub);
    // Reset module-level persistence state so tests don't bleed into each other.
    hydratePersistedProjectState({ collapsedProjectCwds: [], expandedProjectCwds: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves all-collapsed project state across restart", () => {
    // Regression: pre-fix, persistState only wrote `expandedProjectCwds`, so
    // an empty array on rehydrate was indistinguishable from a fresh install
    // and the syncProjects fallback re-expanded every row.
    const projectA = { key: "kA", logicalKey: "kA", cwd: "/projA" };
    const projectB = { key: "kB", logicalKey: "kB", cwd: "/projB" };

    let state = syncProjects(makeUiState(), [projectA, projectB]);
    state = setProjectExpanded(state, projectA.key, false);
    state = setProjectExpanded(state, projectB.key, false);
    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    hydratePersistedProjectState(persisted);
    const rehydrated = syncProjects(makeUiState(), [projectA, projectB]);

    expect(rehydrated.projectExpandedById).toEqual({
      [projectA.key]: false,
      [projectB.key]: false,
    });
  });

  it("persists pinned thread keys in the v1 ui-state blob", () => {
    const thread1 = ThreadId.make("thread-1");
    const thread2 = ThreadId.make("thread-2");
    persistState(
      makeUiState({
        pinnedThreadKeys: {
          [thread1]: true,
          [thread2]: false,
        },
      }),
    );

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;

    expect(persisted.pinnedThreadKeys).toEqual([thread1]);
  });

  it("distinguishes fresh, migrated, and explicitly chosen sidebar modes", () => {
    expect(readPersistedState().sidebarMode).toBe("inbox");

    localStorageStub.setItem(PERSISTED_STATE_KEY, JSON.stringify({ projectOrderCwds: [] }));
    expect(readPersistedState().sidebarMode).toBe("projects");

    persistState(makeUiState({ sidebarMode: "inbox" }));
    expect(readPersistedState().sidebarMode).toBe("inbox");

    persistState(makeUiState({ sidebarMode: "projects" }));
    expect(readPersistedState().sidebarMode).toBe("projects");
  });

  it("respects mixed expand state on rehydrate and defaults new projects to expanded", () => {
    const projectA = { key: "kA", logicalKey: "kA", cwd: "/projA" };
    const projectB = { key: "kB", logicalKey: "kB", cwd: "/projB" };
    const projectC = { key: "kC", logicalKey: "kC", cwd: "/projC" };

    let state = syncProjects(makeUiState(), [projectA, projectB]);
    state = setProjectExpanded(state, projectB.key, false);
    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    hydratePersistedProjectState(persisted);
    const rehydrated = syncProjects(makeUiState(), [projectA, projectB, projectC]);

    expect(rehydrated.projectExpandedById).toEqual({
      [projectA.key]: true,
      [projectB.key]: false,
      [projectC.key]: true,
    });
  });

  it("preserves legacy not-in-expanded-list = collapsed for one upgrade session", () => {
    // Pre-fix shape only stored expandedProjectCwds. Absence of
    // collapsedProjectCwds opts the session into the legacy fallback so
    // upgrade users do not see previously collapsed rows pop open.
    hydratePersistedProjectState({
      expandedProjectCwds: ["/projA"],
    });

    const rehydrated = syncProjects(makeUiState(), [
      { key: "kA", logicalKey: "kA", cwd: "/projA" },
      { key: "kB", logicalKey: "kB", cwd: "/projB" },
    ]);

    expect(rehydrated.projectExpandedById).toEqual({
      kA: true,
      kB: false,
    });
  });

  it("preserves manual project order across restart", () => {
    const projectA = { key: "kOrderA", logicalKey: "kOrderA", cwd: "/order-projA" };
    const projectB = { key: "kOrderB", logicalKey: "kOrderB", cwd: "/order-projB" };
    const projectC = { key: "kOrderC", logicalKey: "kOrderC", cwd: "/order-projC" };

    let state = syncProjects(makeUiState(), [projectA, projectB, projectC]);
    state = reorderProjects(state, [projectC.key], [projectA.key]);
    expect(state.projectOrder).toEqual([projectC.key, projectA.key, projectB.key]);
    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    expect(persisted.projectOrderCwds).toEqual([projectC.cwd, projectA.cwd, projectB.cwd]);

    hydratePersistedProjectState(persisted);
    // Fresh state (empty projectOrder) so syncProjects derives order from
    // persistedProjectOrderCwds rather than the in-memory projectOrder branch.
    const rehydrated = syncProjects(makeUiState(), [projectA, projectB, projectC]);

    expect(rehydrated.projectOrder).toEqual([projectC.key, projectA.key, projectB.key]);
  });

  it("persists project folders under the existing ui state key", () => {
    const state = createProjectFolder(
      makeUiState({
        projectOrder: ["project-a"],
        projectTreeOrder: [projectTreeItemId("project-a")],
      }),
      "WordPress",
      ["project-a"],
      { folderId: "folder-wordpress", now: "2026-06-09T00:00:00.000Z" },
    );

    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    expect(persisted.projectFolders).toEqual([
      {
        id: "folder-wordpress",
        name: "WordPress",
        projectKeys: ["project-a"],
        expanded: true,
        createdAt: "2026-06-09T00:00:00.000Z",
        updatedAt: "2026-06-09T00:00:00.000Z",
      },
    ]);
    expect(persisted.projectFolderOrder).toEqual(["folder-wordpress"]);
    expect(persisted.projectTreeOrder).toEqual([projectFolderTreeItemId("folder-wordpress")]);
  });

  it("persists the default advertised endpoint preference", () => {
    const state = setDefaultAdvertisedEndpointKey(makeUiState(), "desktop-core:lan:http");

    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    expect(persisted.defaultAdvertisedEndpointKey).toBe("desktop-core:lan:http");
  });

  it("preserves expand state across restart when project's logical key changes", () => {
    // After restart, in-memory previousExpandedById is empty, so the
    // previousLogicalKey-to-state bridge in syncProjects cannot help. The
    // persisted-cwd fallback is the only mechanism that can carry collapse
    // state across a restart that also flips a project into a new logical
    // group (e.g. late-arriving repo metadata). This locks in that path.
    const physicalKey = "env-local:/lk-restart-proj";
    const previousLogicalKey = physicalKey;
    const cwd = "/lk-restart-proj";

    let state = syncProjects(makeUiState(), [
      { key: physicalKey, logicalKey: previousLogicalKey, cwd },
    ]);
    state = setProjectExpanded(state, previousLogicalKey, false);
    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    hydratePersistedProjectState(persisted);

    const nextLogicalKey = "lk-restart-canonical";
    const rehydrated = syncProjects(makeUiState(), [
      { key: physicalKey, logicalKey: nextLogicalKey, cwd },
    ]);

    expect(rehydrated.projectExpandedById[nextLogicalKey]).toBe(false);
  });
});

describe("uiStateStore — composer controls", () => {
  let localStorageStub: Storage;

  beforeEach(() => {
    localStorageStub = createLocalStorageStub();
    vi.stubGlobal("window", { localStorage: localStorageStub });
    vi.stubGlobal("localStorage", localStorageStub);
    hydratePersistedProjectState({ collapsedProjectCwds: [], expandedProjectCwds: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("omits obsolete reasoning indicator styles from active and persisted state", () => {
    const state = makeUiState();
    expect(state).not.toHaveProperty("reasoningIndicatorStyle");

    const legacyState = { ...state, reasoningIndicatorStyle: "dots" as const };
    persistState(legacyState);
    const raw = localStorageStub.getItem(PERSISTED_STATE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("reasoningIndicatorStyle");
  });

  it("defaults wide composer controls auto-collapse to enabled", () => {
    expect(makeUiState().wideComposerControlsAutoCollapse).toBe(true);
  });

  it("setWideComposerControlsAutoCollapse returns a new state with the chosen value", () => {
    const next = setWideComposerControlsAutoCollapse(makeUiState(), false);
    expect(next.wideComposerControlsAutoCollapse).toBe(false);
  });

  it("setWideComposerControlsAutoCollapse is a no-op when value is unchanged", () => {
    const state = makeUiState({ wideComposerControlsAutoCollapse: false });
    expect(setWideComposerControlsAutoCollapse(state, false)).toBe(state);
  });

  it("persists wide composer controls auto-collapse and reads it back", () => {
    const state = setWideComposerControlsAutoCollapse(makeUiState(), false);
    persistState(state);
    const raw = localStorageStub.getItem(PERSISTED_STATE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as PersistedUiState;
    expect(parsed.wideComposerControlsAutoCollapse).toBe(false);
  });

  it("defaults always use Build mode to enabled", () => {
    expect(readPersistedState().alwaysUseBuildMode).toBe(true);
  });

  it("setAlwaysUseBuildMode returns a new state with the chosen value", () => {
    const next = setAlwaysUseBuildMode(makeUiState(), false);
    expect(next.alwaysUseBuildMode).toBe(false);
  });

  it("setAlwaysUseBuildMode is a no-op when value is unchanged", () => {
    const state = makeUiState({ alwaysUseBuildMode: true });
    expect(setAlwaysUseBuildMode(state, true)).toBe(state);
  });

  it("persists always use Build mode and reads it back", () => {
    const state = setAlwaysUseBuildMode(makeUiState(), false);
    persistState(state);
    const raw = localStorageStub.getItem(PERSISTED_STATE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as PersistedUiState;
    expect(parsed.alwaysUseBuildMode).toBe(false);
  });
});
