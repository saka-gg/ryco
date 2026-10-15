import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  TurnId,
  WorktreeId,
  defaultInstanceIdForDriver,
  type EnvironmentId,
} from "@ryco/contracts";
import { projectKindOf } from "@ryco/shared/projectKind";
import {
  isWorkspaceMetadataSnapshot,
  type WorkspaceMetadataSnapshot,
  type WorkspaceThreadLatestTurn,
  type WorkspaceThreadMetadata,
} from "@ryco/client-runtime/state/workspace";
import {
  isArchivedThreadStub,
  isThreadLineage,
  type ArchivedThreadStub,
  type CachedEnvironmentShellSnapshot,
} from "@ryco/client-runtime/state/threads";

import { useStore, type AppState } from "./store";
import type { SidebarThreadSummary } from "./types";

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
              kind: projectKindOf(project),
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
    threads: environment.threadIds.flatMap((threadId): WorkspaceThreadMetadata[] => {
      const thread = environment.sidebarThreadSummaryById[threadId];
      if (isArchivedThreadStub(thread)) {
        return [
          {
            environmentId,
            id: thread.id,
            projectId: thread.projectId,
            worktreeId: thread.worktreeId ? WorktreeId.make(thread.worktreeId) : null,
            title: thread.title,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            archivedAt: thread.archivedAt,
            // Unknown for a stub, and marked so (`shellDetail`) rather than read.
            modelSelection: null,
            providerDriver: null,
            branch: thread.branch,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            hasActionableProposedPlan: false,
            deliveryUnknown,
            ...(isThreadLineage(thread.lineage) ? { lineage: thread.lineage } : {}),
            latestUserMessageAt: thread.latestUserMessageAt,
            shellDetail: "archived-stub" as const,
          },
        ];
      }
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
              // Cached so rows settle and sort as the live ones do.
              latestUserMessageAt: thread.latestUserMessageAt,
              latestTurn: endedLatestTurn(thread.latestTurn),
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
      kind: projectKindOf(project),
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
      // Cached lineage is untrusted storage: drop it unless it is well formed.
      if (thread.shellDetail === "archived-stub" && thread.archivedAt !== null) {
        const stub: ArchivedThreadStub = {
          shellDetail: "archived-stub",
          id: thread.id,
          environmentId: thread.environmentId,
          projectId: thread.projectId,
          title: thread.title,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt ?? thread.createdAt,
          archivedAt: thread.archivedAt,
          branch: thread.branch,
          worktreePath: null,
          worktreeId: thread.worktreeId,
          latestUserMessageAt: readCachedTimestamp(thread.latestUserMessageAt),
          lineage: isThreadLineage(thread.lineage) ? thread.lineage : null,
        };
        return { shell: stub, summary: stub };
      }
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
          latestTurn: readCachedLatestTurn(thread.latestTurn),
          branch: thread.branch,
          worktreePath: null,
          worktreeId: thread.worktreeId,
          latestUserMessageAt: readCachedTimestamp(thread.latestUserMessageAt),
          hasPendingApprovals: thread.hasPendingApprovals,
          hasPendingUserInput: thread.hasPendingUserInput,
          hasActionableProposedPlan: thread.hasActionableProposedPlan,
          lineage,
        },
      };
    }),
  };
}

/** The latest turn worth caching: one that ended. A running turn is live state, never cached. */
function endedLatestTurn(
  turn: SidebarThreadSummary["latestTurn"],
): WorkspaceThreadLatestTurn | null {
  if (turn === null || turn.state === "running") return null;
  return {
    turnId: turn.turnId,
    state: turn.state,
    requestedAt: turn.requestedAt,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
  };
}

const ENDED_TURN_STATES = new Set(["interrupted", "completed", "error"]);

function readCachedTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

/** Cached turns are untrusted storage: only a well-formed ended turn is used. */
function readCachedLatestTurn(value: unknown): SidebarThreadSummary["latestTurn"] {
  if (typeof value !== "object" || value === null) return null;
  const turn = value as Partial<Record<keyof WorkspaceThreadLatestTurn, unknown>>;
  const requestedAt = readCachedTimestamp(turn.requestedAt);
  if (
    typeof turn.turnId !== "string" ||
    turn.turnId.length === 0 ||
    typeof turn.state !== "string" ||
    !ENDED_TURN_STATES.has(turn.state) ||
    requestedAt === null
  ) {
    return null;
  }
  return {
    turnId: TurnId.make(turn.turnId),
    state: turn.state as WorkspaceThreadLatestTurn["state"],
    requestedAt,
    startedAt: readCachedTimestamp(turn.startedAt),
    completedAt: readCachedTimestamp(turn.completedAt),
    assistantMessageId: null,
  };
}
