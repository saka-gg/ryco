import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorktreeId,
  type OrchestrationThreadShell,
} from "@ryco/contracts";
import {
  applyOrchestrationEvent,
  hydrateEnvironmentStateFromCache,
  selectThreadByRef,
  syncServerShellSnapshot,
  type AppState,
} from "@ryco/client-runtime/state/threads";
import {
  isWorkspaceMetadataSnapshot,
  type WorkspaceMetadataSnapshot,
} from "@ryco/client-runtime/state/workspace";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useStore } from "./store";
import { fullThreadEntry } from "./types";
import {
  readWorkspaceMetadataSnapshot,
  remapWorkspaceMetadataSnapshotEnvironment,
  workspaceMetadataToCachedShellSnapshot,
} from "./workspaceMetadataProjection";

describe("workspace metadata projection", () => {
  it("publishes direct local metadata under the local Hub cache namespace", () => {
    const direct = EnvironmentId.make("direct-local");
    const hub = EnvironmentId.make("hub-local");
    const snapshot: WorkspaceMetadataSnapshot = {
      schemaVersion: 1,
      environmentId: direct,
      capturedAt: 1,
      projects: [
        {
          environmentId: direct,
          id: ProjectId.make("project-1"),
          name: "Ryco",
          cwd: "/code/ryco",
          repositoryIdentity: null,
          createdAt: null,
          updatedAt: null,
        },
      ],
      worktrees: [],
      threads: [
        {
          environmentId: direct,
          id: ThreadId.make("snoozed"),
          projectId: ProjectId.make("project-1"),
          worktreeId: null,
          title: "Deferred task",
          createdAt: "2026-09-06T10:00:00.000Z",
          updatedAt: "2026-09-06T10:00:00.000Z",
          archivedAt: null,
          snoozedAt: "2026-09-06T10:00:00.000Z",
          snoozedUntil: "2026-09-07T09:00:00.000Z",
          modelSelection: null,
          providerDriver: null,
          branch: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          deliveryUnknown: false,
        },
      ],
    };

    const cached = workspaceMetadataToCachedShellSnapshot(
      remapWorkspaceMetadataSnapshotEnvironment(snapshot, hub),
    );
    expect(cached?.threads[0]?.shell).toMatchObject({
      environmentId: hub,
      snoozedAt: "2026-09-06T10:00:00.000Z",
      snoozedUntil: "2026-09-07T09:00:00.000Z",
    });
    expect(cached?.threads[0]?.summary).toMatchObject({ snoozedUntil: "2026-09-07T09:00:00.000Z" });
    const hydrated = hydrateEnvironmentStateFromCache(
      { activeEnvironmentId: null, environmentStateById: {} },
      {
        ...cached,
        threads: cached.threads.map((thread) => ({
          ...thread,
          content: {
            messages: [
              {
                id: MessageId.make("remembered-message"),
                role: "assistant" as const,
                text: "Saved text",
                createdAt: "2026-09-06T10:00:00.000Z",
                streaming: true,
              },
            ],
          },
        })),
      },
      hub,
    );
    expect(hydrated.environmentStateById[hub]?.bootstrapComplete).toBe(false);
    expect(hydrated.environmentStateById[hub]?.hydratedFromCacheAt).toBe(1);
    expect(
      selectThreadByRef(hydrated, { environmentId: hub, threadId: ThreadId.make("snoozed") }),
    ).toMatchObject({ session: null, messages: [{ text: "Saved text", streaming: false }] });
    const live = {
      ...hydrated,
      environmentStateById: {
        [hub]: { ...hydrated.environmentStateById[hub]!, bootstrapComplete: true },
      },
    };
    expect(hydrateEnvironmentStateFromCache(live, cached, hub)).toBe(live);
    expect(remapWorkspaceMetadataSnapshotEnvironment(snapshot, hub)).toMatchObject({
      environmentId: hub,
      projects: [{ environmentId: hub, id: ProjectId.make("project-1") }],
    });
  });
});

describe("workspace metadata lineage", () => {
  const environmentId = EnvironmentId.make("lineage-metadata");
  const projectId = ProjectId.make("project-lineage");
  const parentId = ThreadId.make("coordinator");
  const childId = ThreadId.make("worker");
  const lineage = { parentThreadId: parentId, rootThreadId: parentId, relationship: "delegated" };

  afterEach(() => {
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
  });

  const shell = (
    id: ThreadId,
    overrides: Partial<OrchestrationThreadShell> = {},
  ): OrchestrationThreadShell => ({
    id,
    projectId,
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    goal: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  });

  it("round-trips lineage through capture and rehydrate", () => {
    useStore.setState(
      syncServerShellSnapshot(
        { activeEnvironmentId: environmentId, environmentStateById: {} },
        {
          snapshotSequence: 1,
          projects: [
            {
              id: projectId,
              title: "Project",
              workspaceRoot: "/repo",
              projectMetadataDir: ".ryco",
              defaultModelSelection: null,
              customAvatarContentHash: null,
              preferredRemoteName: null,
              scripts: [],
              createdAt: "2026-10-01T00:00:00.000Z",
              updatedAt: "2026-10-01T00:00:00.000Z",
            },
          ],
          threads: [shell(parentId), shell(childId, { lineage })],
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
        environmentId,
      ),
    );
    const captured = readWorkspaceMetadataSnapshot(environmentId, 1);
    expect(captured).not.toBeNull();
    const capturedChild = captured!.threads.find((thread) => thread.id === childId);
    const capturedParent = captured!.threads.find((thread) => thread.id === parentId);
    expect(capturedChild?.lineage).toEqual(lineage);
    expect(capturedParent).not.toHaveProperty("lineage");

    const cached = workspaceMetadataToCachedShellSnapshot(captured!);
    const cachedChild = cached.threads.find((thread) => thread.shell.id === childId);
    expect(cachedChild?.shell.lineage).toEqual(lineage);
    expect(cachedChild?.summary.lineage).toEqual(lineage);

    const hydrated = hydrateEnvironmentStateFromCache(
      { activeEnvironmentId: null, environmentStateById: {} },
      cached,
      environmentId,
    );
    expect(
      hydrated.environmentStateById[environmentId]?.sidebarThreadSummaryById[childId]?.lineage,
    ).toEqual(lineage);
  });

  it("drops a malformed cached lineage without rejecting the snapshot", () => {
    const snapshot: WorkspaceMetadataSnapshot = {
      schemaVersion: 1,
      environmentId,
      capturedAt: 1,
      projects: [
        {
          environmentId,
          id: projectId,
          name: "Project",
          cwd: "/repo",
          repositoryIdentity: null,
          createdAt: null,
          updatedAt: null,
        },
      ],
      worktrees: [],
      threads: [
        {
          environmentId,
          id: childId,
          projectId,
          worktreeId: null,
          title: "Worker",
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: null,
          archivedAt: null,
          modelSelection: null,
          providerDriver: null,
          branch: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          deliveryUnknown: false,
          lineage: { parentThreadId: parentId, relationship: 7 } as never,
        },
      ],
    };
    expect(isWorkspaceMetadataSnapshot(snapshot, environmentId)).toBe(true);
    const cached = workspaceMetadataToCachedShellSnapshot(snapshot);
    expect(cached.threads[0]?.shell.lineage).toBeNull();
    expect(cached.threads[0]?.summary.lineage).toBeNull();
  });

  it("caches an ended latest turn and the last message time, never a running turn", () => {
    const turn = (state: "running" | "completed") => ({
      turnId: TurnId.make(`turn-${state}`),
      state,
      requestedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: state === "running" ? null : "2026-01-01T00:05:00.000Z",
      assistantMessageId: null,
    });
    useStore.setState(
      syncServerShellSnapshot(
        { activeEnvironmentId: environmentId, environmentStateById: {} },
        {
          snapshotSequence: 1,
          projects: [
            {
              id: projectId,
              title: "Project",
              workspaceRoot: "/repo",
              projectMetadataDir: ".ryco",
              defaultModelSelection: null,
              customAvatarContentHash: null,
              preferredRemoteName: null,
              scripts: [],
              createdAt: "2026-10-01T00:00:00.000Z",
              updatedAt: "2026-10-01T00:00:00.000Z",
            },
          ],
          threads: [
            shell(parentId, {
              latestTurn: turn("completed"),
              latestUserMessageAt: "2026-01-01T00:00:00.000Z",
            }),
            shell(childId, { latestTurn: turn("running") }),
          ],
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
        environmentId,
      ),
    );
    const captured = readWorkspaceMetadataSnapshot(environmentId, 1)!;
    const cached = workspaceMetadataToCachedShellSnapshot(captured);
    const summaryOf = (id: ThreadId) =>
      fullThreadEntry(cached.threads.find((thread) => thread.shell.id === id)?.summary);
    expect(summaryOf(parentId)?.latestUserMessageAt).toBe("2026-01-01T00:00:00.000Z");
    expect(summaryOf(parentId)?.latestTurn).toEqual(turn("completed"));
    // A running turn is live state: the cached row has none.
    expect(summaryOf(childId)?.latestTurn).toBeNull();
  });

  it("ignores malformed cached activity fields", () => {
    const snapshot: WorkspaceMetadataSnapshot = {
      schemaVersion: 1,
      environmentId,
      capturedAt: 1,
      projects: [
        {
          environmentId,
          id: projectId,
          name: "Project",
          cwd: "/repo",
          repositoryIdentity: null,
          createdAt: null,
          updatedAt: null,
        },
      ],
      worktrees: [],
      threads: [
        {
          environmentId,
          id: childId,
          projectId,
          worktreeId: null,
          title: "Worker",
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: null,
          archivedAt: null,
          modelSelection: null,
          providerDriver: null,
          branch: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          deliveryUnknown: false,
          latestUserMessageAt: "not a time",
          latestTurn: {
            turnId: "t",
            state: "running",
            requestedAt: "2026-01-01T00:00:00.000Z",
          } as never,
        },
      ],
    };
    const cached = workspaceMetadataToCachedShellSnapshot(snapshot);
    expect(cached.threads[0]?.summary.latestUserMessageAt).toBeNull();
    expect(fullThreadEntry(cached.threads[0]?.summary)?.latestTurn).toBeNull();
  });
});

describe("workspace metadata memoization", () => {
  const environmentId = EnvironmentId.make("memoized-metadata");
  const projectId = ProjectId.make("project-memo");
  const threadId = ThreadId.make("thread-memo");
  const at = "2026-10-01T00:00:00.000Z";

  const shell = (id: string, overrides: Partial<OrchestrationThreadShell> = {}) =>
    ({
      id: ThreadId.make(id),
      projectId,
      title: id,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      goal: null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      ...overrides,
    }) as OrchestrationThreadShell;

  const shellSnapshot = (
    input: {
      readonly title?: string;
      readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
      readonly sequence?: number;
    } = {},
  ) =>
    ({
      snapshotSequence: input.sequence ?? 1,
      projects: [
        {
          id: projectId,
          title: input.title ?? "Project",
          workspaceRoot: "/repo",
          projectMetadataDir: ".ryco",
          defaultModelSelection: null,
          customAvatarContentHash: null,
          preferredRemoteName: null,
          scripts: [],
          createdAt: at,
          updatedAt: at,
        },
      ],
      worktrees: [
        {
          worktreeId: WorktreeId.make("worktree-memo"),
          projectId,
          title: null,
          branch: "feature",
          worktreePath: "/repo-feature",
          origin: "branch",
          prNumber: null,
          issueNumber: null,
          prTitle: null,
          issueTitle: null,
          createdAt: at,
          updatedAt: at,
          archivedAt: null,
          manualPosition: 0,
        },
      ],
      threads: input.threads ?? [shell(threadId), shell("thread-other")],
      updatedAt: at,
    }) as unknown as Parameters<typeof syncServerShellSnapshot>[1];

  const emptyState: AppState = { activeEnvironmentId: null, environmentStateById: {} };
  const synced = (input?: Parameters<typeof shellSnapshot>[0]) =>
    syncServerShellSnapshot(emptyState, shellSnapshot(input), environmentId);
  const resynced = (state: AppState, input?: Parameters<typeof shellSnapshot>[0]) =>
    syncServerShellSnapshot(state, shellSnapshot(input), environmentId);

  const messageSent = (role: "assistant" | "user") =>
    ({
      sequence: 2,
      eventId: "event-message",
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: at,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.message-sent",
      payload: {
        threadId,
        messageId: "message-1",
        role,
        text: "streamed text",
        turnId: "turn-1",
        streaming: true,
        createdAt: at,
        updatedAt: at,
      },
    }) as unknown as Parameters<typeof applyOrchestrationEvent>[1];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the same arrays for unchanged state, whatever the capture time", () => {
    const state = synced();
    const first = readWorkspaceMetadataSnapshot(environmentId, 1, false, state)!;
    const second = readWorkspaceMetadataSnapshot(environmentId, 2, false, state)!;
    expect(second).not.toBe(first);
    expect(second.capturedAt).toBe(2);
    expect(second.projects).toBe(first.projects);
    expect(second.worktrees).toBe(first.worktrees);
    expect(second.threads).toBe(first.threads);
    expect(first.threads.map((thread) => thread.id)).toEqual([threadId, "thread-other"]);
  });

  it("keeps the arrays and does no JSON work across a message-only store tick", () => {
    const state = synced();
    const before = readWorkspaceMetadataSnapshot(environmentId, 1, false, state)!;
    const stringify = vi.spyOn(JSON, "stringify");
    const parse = vi.spyOn(JSON, "parse");

    for (const role of ["assistant", "user"] as const) {
      const next = applyOrchestrationEvent(state, messageSent(role), environmentId);
      expect(next).not.toBe(state);
      const after = readWorkspaceMetadataSnapshot(environmentId, 2, false, next)!;
      expect(after.projects).toBe(before.projects);
      expect(after.worktrees).toBe(before.worktrees);
      expect(after.threads).toBe(before.threads);
    }
    expect(stringify).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
  });

  it("rebuilds only the array whose source changed", () => {
    const state = synced();
    const before = readWorkspaceMetadataSnapshot(environmentId, 1, false, state)!;

    const renamedThreads = [shell(threadId, { title: "Renamed" }), shell("thread-other")];
    const renamedThread = resynced(state, { sequence: 2, threads: renamedThreads });
    const afterThread = readWorkspaceMetadataSnapshot(environmentId, 2, false, renamedThread)!;
    expect(afterThread.threads).not.toBe(before.threads);
    expect(afterThread.threads.find((thread) => thread.id === threadId)?.title).toBe("Renamed");
    expect(afterThread.projects).toBe(before.projects);
    expect(afterThread.worktrees).toBe(before.worktrees);

    const renamedProject = resynced(renamedThread, {
      sequence: 3,
      title: "Renamed project",
      threads: renamedThreads,
    });
    const afterProject = readWorkspaceMetadataSnapshot(environmentId, 3, false, renamedProject)!;
    expect(afterProject.projects).not.toBe(afterThread.projects);
    expect(afterProject.projects[0]?.name).toBe("Renamed project");
    expect(afterProject.worktrees).toBe(afterThread.worktrees);
    expect(afterProject.threads).toBe(afterThread.threads);

    const removedThread = resynced(renamedProject, {
      sequence: 4,
      title: "Renamed project",
      threads: [renamedThreads[0]!],
    });
    const afterRemoval = readWorkspaceMetadataSnapshot(environmentId, 4, false, removedThread)!;
    expect(afterRemoval.threads.map((thread) => thread.id)).toEqual([threadId]);
    expect(afterRemoval.projects).toBe(afterProject.projects);
  });

  it("rebuilds the thread rows when delivery becomes unknown", () => {
    const state = synced();
    const known = readWorkspaceMetadataSnapshot(environmentId, 1, false, state)!;
    const unknown = readWorkspaceMetadataSnapshot(environmentId, 2, true, state)!;
    expect(unknown.threads).not.toBe(known.threads);
    expect(unknown.threads.every((thread) => thread.deliveryUnknown)).toBe(true);
    expect(known.threads.every((thread) => !thread.deliveryUnknown)).toBe(true);
    expect(unknown.projects).toBe(known.projects);
    expect(readWorkspaceMetadataSnapshot(environmentId, 3, false, state)!.threads).not.toBe(
      unknown.threads,
    );
  });

  it("matches a fresh derivation of the same state", () => {
    const state = resynced(synced(), {
      sequence: 2,
      threads: [shell(threadId, { title: "Changed" }), shell("thread-other")],
    });
    const memoized = readWorkspaceMetadataSnapshot(environmentId, 7, false, state);
    // A second environment id has no memo, so this derives from scratch.
    const otherId = EnvironmentId.make("memoized-metadata-fresh");
    const fresh = readWorkspaceMetadataSnapshot(otherId, 7, false, {
      ...state,
      environmentStateById: { [otherId]: state.environmentStateById[environmentId]! },
    });
    expect(memoized).toEqual(remapWorkspaceMetadataSnapshotEnvironment(fresh!, environmentId));
  });

  it("still rejects what it cannot publish when the arrays are cached", () => {
    const state = synced();
    expect(readWorkspaceMetadataSnapshot(environmentId, 1, false, state)).not.toBeNull();
    // The capture time is validated on every read, cached arrays or not.
    expect(readWorkspaceMetadataSnapshot(environmentId, Number.NaN, false, state)).toBeNull();
    expect(readWorkspaceMetadataSnapshot(environmentId, 2, false, state)).not.toBeNull();

    // A thread in a project the shell does not list is never published.
    const environment = state.environmentStateById[environmentId]!;
    const orphaned: AppState = {
      ...state,
      environmentStateById: {
        [environmentId]: {
          ...environment,
          sidebarThreadSummaryById: {
            ...environment.sidebarThreadSummaryById,
            [threadId]: {
              ...environment.sidebarThreadSummaryById[threadId]!,
              projectId: ProjectId.make("missing"),
            },
          },
        },
      },
    };
    expect(readWorkspaceMetadataSnapshot(environmentId, 3, false, orphaned)).toBeNull();
    expect(readWorkspaceMetadataSnapshot(environmentId, 4, false, orphaned)).toBeNull();
    expect(readWorkspaceMetadataSnapshot(environmentId, 5, false, state)).not.toBeNull();
  });

  it("publishes nothing before the shell is complete", () => {
    const state = synced();
    const environment = state.environmentStateById[environmentId]!;
    const booting: AppState = {
      ...state,
      environmentStateById: { [environmentId]: { ...environment, bootstrapComplete: false } },
    };
    expect(readWorkspaceMetadataSnapshot(environmentId, 1, false, booting)).toBeNull();
    expect(
      readWorkspaceMetadataSnapshot(EnvironmentId.make("unknown"), 1, false, state),
    ).toBeNull();
  });
});
