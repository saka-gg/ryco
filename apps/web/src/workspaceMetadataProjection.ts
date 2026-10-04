import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  WorktreeId,
  defaultInstanceIdForDriver,
  type EnvironmentId,
} from "@ryco/contracts";
import {
  isWorkspaceMetadataSnapshot,
  type WorkspaceMetadataSnapshot,
} from "@ryco/client-runtime/state/workspace";
import {
  isThreadLineage,
  type CachedEnvironmentShellSnapshot,
} from "@ryco/client-runtime/state/threads";

import { useStore, type AppState } from "./store";

export function readWorkspaceMetadataSnapshot(
  environmentId: EnvironmentId,
  capturedAt = Date.now(),
  deliveryUnknown = false,
  state: AppState = useStore.getState(),
): WorkspaceMetadataSnapshot | null {
  const environment = state.environmentStateById[environmentId];
  if (!environment?.bootstrapComplete) return null;
  const snapshot: WorkspaceMetadataSnapshot = {
    schemaVersion: 1,
    environmentId,
    capturedAt,
    projects: environment.projectIds.flatMap((projectId) => {
      const project = environment.projectById[projectId];
      return project
        ? [
            {
              environmentId,
              id: project.id,
              name: project.name,
              cwd: project.cwd,
              repositoryIdentity: project.repositoryIdentity ?? null,
              createdAt: project.createdAt ?? null,
              updatedAt: project.updatedAt ?? null,
            },
          ]
        : [];
    }),
    worktrees: (environment.worktreeIds ?? []).flatMap((worktreeId) => {
      const worktree = environment.worktreeById?.[worktreeId];
      return worktree
        ? [
            {
              environmentId,
              id: worktree.id,
              projectId: worktree.projectId,
              title: worktree.title ?? null,
              branch: worktree.branch,
              worktreePath: worktree.worktreePath,
              workItemLabel:
                worktree.workItemKey ?? worktree.prTitle ?? worktree.issueTitle ?? null,
              pullRequestNumber: worktree.prNumber,
              archivedAt: worktree.archivedAt,
              updatedAt: worktree.updatedAt,
            },
          ]
        : [];
    }),
    threads: environment.threadIds.flatMap((threadId) => {
      const thread = environment.sidebarThreadSummaryById[threadId];
      return thread
        ? [
            {
              environmentId,
              id: thread.id,
              projectId: thread.projectId,
              worktreeId: thread.worktreeId ? WorktreeId.make(thread.worktreeId) : null,
              title: thread.title,
              createdAt: thread.createdAt,
              updatedAt: thread.updatedAt ?? null,
              archivedAt: thread.archivedAt,
              settledOverride: thread.settledOverride ?? null,
              settledAt: thread.settledAt ?? null,
              snoozedUntil: thread.snoozedUntil ?? null,
              snoozedAt: thread.snoozedAt ?? null,
              modelSelection: thread.modelSelection ?? null,
              providerDriver: thread.providerDriver ?? null,
              branch: thread.branch,
              hasPendingApprovals: thread.hasPendingApprovals,
              hasPendingUserInput: thread.hasPendingUserInput,
              hasActionableProposedPlan: thread.hasActionableProposedPlan,
              deliveryUnknown,
              // Cached so delegated folding does not flicker on a cold start.
              ...(isThreadLineage(thread.lineage) ? { lineage: thread.lineage } : {}),
            },
          ]
        : [];
    }),
  };
  return isWorkspaceMetadataSnapshot(snapshot, environmentId) ? snapshot : null;
}

/**
 * A Desktop-local server has a direct environment id and, while enrolled, a
 * separate Hub environment id. Main owns the Hub cache namespace, so publish
 * the direct shell under that namespace without hydrating a second renderer
 * copy of the same physical server.
 */
export function remapWorkspaceMetadataSnapshotEnvironment(
  snapshot: WorkspaceMetadataSnapshot,
  environmentId: EnvironmentId,
): WorkspaceMetadataSnapshot {
  if (snapshot.environmentId === environmentId) return snapshot;
  return {
    ...snapshot,
    environmentId,
    projects: snapshot.projects.map((project) => ({ ...project, environmentId })),
    worktrees: snapshot.worktrees.map((worktree) => ({ ...worktree, environmentId })),
    threads: snapshot.threads.map((thread) => ({ ...thread, environmentId })),
  };
}

/** Rehydrate only the list-safe shell fields represented by the shared schema. */
export function workspaceMetadataToCachedShellSnapshot(
  snapshot: WorkspaceMetadataSnapshot,
): CachedEnvironmentShellSnapshot {
  return {
    capturedAt: snapshot.capturedAt,
    projects: snapshot.projects.map((project) => ({
      id: project.id,
      environmentId: project.environmentId,
      name: project.name,
      cwd: project.cwd,
      repositoryIdentity: project.repositoryIdentity,
      defaultModelSelection: null,
      createdAt: project.createdAt ?? undefined,
      updatedAt: project.updatedAt ?? undefined,
      scripts: [],
    })),
    worktrees: snapshot.worktrees.map((worktree) => ({
      id: worktree.id,
      environmentId: worktree.environmentId,
      projectId: worktree.projectId,
      title: worktree.title,
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
      origin: "manual",
      prNumber: worktree.pullRequestNumber,
      issueNumber: null,
      prTitle: worktree.workItemLabel,
      issueTitle: null,
      prState: null,
      prIsDraft: null,
      issueState: null,
      workItemProvider: null,
      workItemKey: null,
      workItemTitle: worktree.workItemLabel,
      workItemState: null,
      workItemStateName: null,
      workItemUrl: null,
      createdAt: worktree.updatedAt,
      updatedAt: worktree.updatedAt,
      archivedAt: worktree.archivedAt,
      manualPosition: 0,
    })),
    threads: snapshot.threads.map((thread) => {
      const driver = thread.providerDriver ?? ProviderDriverKind.make("codex");
      const modelSelection = thread.modelSelection ?? {
        instanceId: defaultInstanceIdForDriver(driver),
        model: DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL,
      };
      // Cached lineage is untrusted storage: drop it unless it is well formed.
      const lineage = isThreadLineage(thread.lineage) ? thread.lineage : null;
      const shell = {
        id: thread.id,
        environmentId: thread.environmentId,
        codexThreadId: null,
        projectId: thread.projectId,
        title: thread.title,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        error: null,
        createdAt: thread.createdAt,
        archivedAt: thread.archivedAt,
        settledOverride: thread.settledOverride ?? null,
        settledAt: thread.settledAt ?? null,
        snoozedUntil: thread.snoozedUntil ?? null,
        snoozedAt: thread.snoozedAt ?? null,
        updatedAt: thread.updatedAt ?? undefined,
        branch: thread.branch,
        worktreePath: null,
        worktreeId: thread.worktreeId,
        lineage,
      };
      return {
        shell,
        summary: {
          id: thread.id,
          environmentId: thread.environmentId,
          projectId: thread.projectId,
          title: thread.title,
          interactionMode: "default" as const,
          modelSelection,
          providerDriver: thread.providerDriver,
          session: null,
          createdAt: thread.createdAt,
          archivedAt: thread.archivedAt,
          settledOverride: thread.settledOverride ?? null,
          settledAt: thread.settledAt ?? null,
          snoozedUntil: thread.snoozedUntil ?? null,
          snoozedAt: thread.snoozedAt ?? null,
          updatedAt: thread.updatedAt ?? undefined,
          latestTurn: null,
          branch: thread.branch,
          worktreePath: null,
          worktreeId: thread.worktreeId,
          latestUserMessageAt: null,
          hasPendingApprovals: thread.hasPendingApprovals,
          hasPendingUserInput: thread.hasPendingUserInput,
          hasActionableProposedPlan: thread.hasActionableProposedPlan,
          lineage,
        },
      };
    }),
  };
}
