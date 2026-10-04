import { WorktreeId, type EnvironmentId } from "@ryco/contracts";
import { isThreadLineage } from "@ryco/client-runtime/state/threads";
import {
  MAX_WORKSPACE_SNAPSHOT_BYTES_PER_ENVIRONMENT,
  MAX_WORKSPACE_SNAPSHOT_THREADS_PER_ENVIRONMENT,
  WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION,
  type WorkspaceMetadataSnapshot,
} from "@ryco/client-runtime/state/workspace";

import type {
  CachedEnvironmentShellSnapshot,
  EnvironmentState,
  Project,
  SidebarThreadSummary,
  SidebarWorktreeSummary,
  ThreadShell,
} from "../state/threadsRuntime";

/**
 * The typed record layer over snapshotDb: versioned per-environment snapshot
 * records with an explicit schemaVersion literal, so a downgraded client (or a
 * record written by a future client) fails to decode and is discarded instead
 * of being mis-read as current. Version history:
 *
 * v1 — initial: projects, worktrees, and thread shell/sidebar-summary pairs,
 *      with sessions and background liveness stripped at capture so a cached
 *      row can never claim live activity.
 */
export const ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION = 1;

export interface StoredEnvironmentSnapshotThread {
  readonly shell: ThreadShell;
  readonly summary: SidebarThreadSummary;
}

export interface StoredEnvironmentSnapshot {
  readonly schemaVersion: typeof ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION;
  readonly environmentId: EnvironmentId;
  readonly capturedAt: number;
  readonly projects: ReadonlyArray<Project>;
  readonly worktrees: ReadonlyArray<SidebarWorktreeSummary>;
  readonly threads: ReadonlyArray<StoredEnvironmentSnapshotThread>;
}

/**
 * Per-environment bounds, applied at capture. The total-across-environments
 * budget is enforced separately with the shared eviction policy
 * (`planEvictionsToCapacity`) over the stored rows.
 */
export const MAX_SNAPSHOT_THREADS_PER_ENVIRONMENT = MAX_WORKSPACE_SNAPSHOT_THREADS_PER_ENVIRONMENT;
export const MAX_SNAPSHOT_PAYLOAD_BYTES_PER_ENVIRONMENT =
  MAX_WORKSPACE_SNAPSHOT_BYTES_PER_ENVIRONMENT;

function threadRecency(summary: SidebarThreadSummary): number {
  const timestamp = Date.parse(
    summary.updatedAt ?? summary.latestUserMessageAt ?? summary.createdAt,
  );
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Snapshot the settled shell projection of one environment out of the shared
 * threads store. Sessions and background liveness are stripped here — the
 * persisted form is only ever rendered as last-known state.
 */
export function captureEnvironmentSnapshotRecord(
  environmentState: EnvironmentState,
  environmentId: EnvironmentId,
  capturedAt: number,
): StoredEnvironmentSnapshot {
  const projects = environmentState.projectIds.flatMap((projectId) => {
    const project = environmentState.projectById[projectId];
    return project ? [project] : [];
  });
  const worktrees = (environmentState.worktreeIds ?? []).flatMap((worktreeId) => {
    const worktree = environmentState.worktreeById?.[worktreeId];
    return worktree ? [worktree] : [];
  });
  const threads = environmentState.threadIds.flatMap((threadId) => {
    const shell = environmentState.threadShellById[threadId];
    const summary = environmentState.sidebarThreadSummaryById[threadId];
    if (!shell || !summary) return [];
    return [{ shell, summary: { ...summary, session: null, backgroundLiveness: null } }];
  });
  return {
    schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
    environmentId,
    capturedAt,
    projects,
    worktrees,
    threads,
  };
}

/**
 * Enforce the per-environment bounds by dropping threads — archived first,
 * then oldest — while preserving the survivors' original order. The byte cap
 * re-serializes after each trim round; projects and worktrees are never
 * dropped (they are small and the interface renders from them).
 */
export function boundStoredEnvironmentSnapshot(
  record: StoredEnvironmentSnapshot,
  caps: { readonly maxThreads: number; readonly maxPayloadBytes: number } = {
    maxThreads: MAX_SNAPSHOT_THREADS_PER_ENVIRONMENT,
    maxPayloadBytes: MAX_SNAPSHOT_PAYLOAD_BYTES_PER_ENVIRONMENT,
  },
): { readonly record: StoredEnvironmentSnapshot; readonly payload: string } {
  const dropOrder = (threads: ReadonlyArray<StoredEnvironmentSnapshotThread>) =>
    threads.toSorted((left, right) => {
      const archivedDelta =
        Number(right.shell.archivedAt !== null) - Number(left.shell.archivedAt !== null);
      if (archivedDelta !== 0) return archivedDelta;
      return threadRecency(left.summary) - threadRecency(right.summary);
    });

  let threads = record.threads;
  if (threads.length > caps.maxThreads) {
    const dropped = new Set(dropOrder(threads).slice(0, threads.length - caps.maxThreads));
    threads = threads.filter((thread) => !dropped.has(thread));
  }

  let bounded: StoredEnvironmentSnapshot = { ...record, threads };
  let payload = JSON.stringify(bounded);
  while (
    new TextEncoder().encode(payload).byteLength > caps.maxPayloadBytes &&
    bounded.threads.length > 0
  ) {
    const dropCount = Math.max(1, Math.ceil(bounded.threads.length / 4));
    const dropped = new Set(dropOrder(bounded.threads).slice(0, dropCount));
    bounded = { ...bounded, threads: bounded.threads.filter((thread) => !dropped.has(thread)) };
    payload = JSON.stringify(bounded);
  }
  return { record: bounded, payload };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidProject(value: unknown, environmentId: string): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    value.environmentId === environmentId &&
    typeof value.name === "string" &&
    typeof value.cwd === "string"
  );
}

function isValidWorktree(value: unknown, environmentId: string): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    value.environmentId === environmentId &&
    isNonEmptyString(value.projectId)
  );
}

function isValidThread(value: unknown, environmentId: string): boolean {
  if (!isRecord(value) || !isRecord(value.shell) || !isRecord(value.summary)) return false;
  const shell = value.shell;
  const summary = value.summary;
  return (
    isNonEmptyString(shell.id) &&
    shell.environmentId === environmentId &&
    isNonEmptyString(shell.projectId) &&
    summary.id === shell.id &&
    summary.environmentId === environmentId
  );
}

/**
 * Strict envelope decode: version literal, embedded identity, and per-row
 * identity checks. Any mismatch — including a schemaVersion bump in either
 * direction — makes the whole record invalid; the caller deletes the row and
 * treats it as a cache miss.
 */
export function decodeStoredEnvironmentSnapshot(
  raw: string,
  environmentId: EnvironmentId,
): StoredEnvironmentSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION) return null;
  if (value.environmentId !== environmentId) return null;
  if (typeof value.capturedAt !== "number" || !Number.isFinite(value.capturedAt)) return null;
  const { projects, worktrees, threads } = value;
  if (!Array.isArray(projects) || !Array.isArray(worktrees) || !Array.isArray(threads)) {
    return null;
  }
  if (!projects.every((project) => isValidProject(project, environmentId))) return null;
  if (!worktrees.every((worktree) => isValidWorktree(worktree, environmentId))) return null;
  if (!threads.every((thread) => isValidThread(thread, environmentId))) return null;
  return value as unknown as StoredEnvironmentSnapshot;
}

export function toCachedEnvironmentShellSnapshot(
  record: StoredEnvironmentSnapshot,
): CachedEnvironmentShellSnapshot {
  return {
    capturedAt: record.capturedAt,
    projects: record.projects,
    worktrees: record.worktrees,
    threads: record.threads,
  };
}

/**
 * Compatibility projection from the existing v1 Mobile record to the shared
 * metadata-only domain. The SQLite payload stays byte-compatible in this wave.
 */
export function toWorkspaceMetadataSnapshot(
  record: StoredEnvironmentSnapshot,
): WorkspaceMetadataSnapshot {
  return {
    schemaVersion: WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION,
    environmentId: record.environmentId,
    capturedAt: record.capturedAt,
    projects: record.projects.map((project) => ({
      environmentId: project.environmentId,
      id: project.id,
      name: project.name,
      cwd: project.cwd,
      repositoryIdentity: project.repositoryIdentity ?? null,
      createdAt: project.createdAt ?? null,
      updatedAt: project.updatedAt ?? null,
    })),
    worktrees: record.worktrees.map((worktree) => ({
      environmentId: worktree.environmentId,
      id: worktree.id,
      projectId: worktree.projectId,
      title: worktree.title ?? null,
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
      workItemLabel: worktree.workItemKey ?? worktree.workItemTitle ?? null,
      pullRequestNumber: worktree.prNumber,
      archivedAt: worktree.archivedAt,
      updatedAt: worktree.updatedAt,
    })),
    threads: record.threads.map(({ shell, summary }) => ({
      environmentId: shell.environmentId,
      id: shell.id,
      projectId: shell.projectId,
      worktreeId: summary.worktreeId ? WorktreeId.make(summary.worktreeId) : null,
      title: shell.title,
      createdAt: shell.createdAt,
      updatedAt: summary.updatedAt ?? shell.updatedAt ?? null,
      archivedAt: shell.archivedAt,
      modelSelection: summary.modelSelection ?? shell.modelSelection,
      providerDriver: summary.providerDriver ?? null,
      branch: shell.branch,
      hasPendingApprovals: summary.hasPendingApprovals,
      hasPendingUserInput: summary.hasPendingUserInput,
      hasActionableProposedPlan: summary.hasActionableProposedPlan,
      deliveryUnknown: false,
      // Stored shells come from storage: keep lineage only when well formed.
      ...(isThreadLineage(shell.lineage) ? { lineage: shell.lineage } : {}),
    })),
  };
}
