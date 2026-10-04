import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@ryco/contracts";
import {
  hydrateEnvironmentStateFromCache,
  selectThreadByRef,
  syncServerShellSnapshot,
} from "@ryco/client-runtime/state/threads";
import {
  isWorkspaceMetadataSnapshot,
  type WorkspaceMetadataSnapshot,
} from "@ryco/client-runtime/state/workspace";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useStore } from "./store";
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
});
