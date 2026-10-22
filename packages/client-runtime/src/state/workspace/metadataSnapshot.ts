import type { EnvironmentId } from "@ryco/contracts";

import type {
  WorkspaceMetadataCacheNamespace,
  WorkspaceMetadataCacheRecord,
  WorkspaceMetadataSnapshot,
} from "./types.js";
import { WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION } from "./types.js";

export const MAX_WORKSPACE_SNAPSHOT_THREADS_PER_ENVIRONMENT = 400;
export const MAX_WORKSPACE_SNAPSHOT_BYTES_PER_ENVIRONMENT = 2 * 1024 * 1024;
export const MAX_WORKSPACE_SNAPSHOT_ENVIRONMENTS = 32;
export const MAX_WORKSPACE_SNAPSHOT_TOTAL_BYTES = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasEnvironment(value: unknown, environmentId: EnvironmentId): boolean {
  return isRecord(value) && value.environmentId === environmentId;
}

export function isWorkspaceMetadataSnapshot(
  value: unknown,
  expectedEnvironmentId?: EnvironmentId,
): value is WorkspaceMetadataSnapshot {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION) return false;
  if (!isNonEmptyString(value.environmentId)) return false;
  const environmentId = value.environmentId as EnvironmentId;
  if (expectedEnvironmentId !== undefined && environmentId !== expectedEnvironmentId) return false;
  if (typeof value.capturedAt !== "number" || !Number.isFinite(value.capturedAt)) return false;
  if (
    !Array.isArray(value.projects) ||
    !Array.isArray(value.worktrees) ||
    !Array.isArray(value.threads)
  ) {
    return false;
  }

  const projectIds = new Set<string>();
  for (const project of value.projects) {
    if (!hasEnvironment(project, environmentId)) return false;
    if (
      !isNonEmptyString(project.id) ||
      !isNonEmptyString(project.name) ||
      typeof project.cwd !== "string"
    ) {
      return false;
    }
    if (projectIds.has(project.id)) return false;
    projectIds.add(project.id);
  }
  const worktreeIds = new Set<string>();
  for (const worktree of value.worktrees) {
    if (!hasEnvironment(worktree, environmentId)) return false;
    if (!isNonEmptyString(worktree.id) || !isNonEmptyString(worktree.projectId)) return false;
    if (!projectIds.has(worktree.projectId) || worktreeIds.has(worktree.id)) return false;
    worktreeIds.add(worktree.id);
  }
  const threadIds = new Set<string>();
  for (const thread of value.threads) {
    if (!hasEnvironment(thread, environmentId)) return false;
    if (!isNonEmptyString(thread.id) || !isNonEmptyString(thread.projectId)) return false;
    if (!projectIds.has(thread.projectId) || threadIds.has(thread.id)) return false;
    if (thread.worktreeId != null && !worktreeIds.has(thread.worktreeId)) return false;
    threadIds.add(thread.id);
  }
  return true;
}

const payloadTextEncoder = new TextEncoder();
const payloadBytesBySnapshot = new WeakMap<WorkspaceMetadataSnapshot, number>();
const payloadBytesByArray = new WeakMap<ReadonlyArray<unknown>, number>();

function serializedBytes(value: unknown): number {
  return payloadTextEncoder.encode(JSON.stringify(value)).byteLength;
}

function cachedArrayBytes(array: ReadonlyArray<unknown>): number {
  let bytes = payloadBytesByArray.get(array);
  if (bytes === undefined) {
    bytes = serializedBytes(array);
    payloadBytesByArray.set(array, bytes);
  }
  return bytes;
}

/**
 * The UTF-8 size of the serialized snapshot. Snapshots and their member arrays
 * are immutable, so sizes are cached per object: a snapshot that reuses its
 * arrays from an earlier one only re-measures its few fixed fields.
 */
export function workspaceMetadataPayloadBytes(snapshot: WorkspaceMetadataSnapshot): number {
  const cached = payloadBytesBySnapshot.get(snapshot);
  if (cached !== undefined) return cached;
  const { projects, worktrees, threads } = snapshot;
  const bytes =
    Array.isArray(projects) && Array.isArray(worktrees) && Array.isArray(threads)
      ? // Each array serializes to its own bytes; replacing it with a one
        // character placeholder leaves the fixed fields and punctuation.
        serializedBytes({ ...snapshot, projects: 0, worktrees: 0, threads: 0 }) -
        3 +
        cachedArrayBytes(projects) +
        cachedArrayBytes(worktrees) +
        cachedArrayBytes(threads)
      : serializedBytes(snapshot);
  payloadBytesBySnapshot.set(snapshot, bytes);
  return bytes;
}

function threadRecency(thread: WorkspaceMetadataSnapshot["threads"][number]): number {
  const parsed = Date.parse(thread.updatedAt ?? thread.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Preserve projects/worktrees; trim archived then oldest thread metadata first. */
export function boundWorkspaceMetadataSnapshot(
  snapshot: WorkspaceMetadataSnapshot,
  caps: {
    readonly maxThreads: number;
    readonly maxPayloadBytes: number;
  } = {
    maxThreads: MAX_WORKSPACE_SNAPSHOT_THREADS_PER_ENVIRONMENT,
    maxPayloadBytes: MAX_WORKSPACE_SNAPSHOT_BYTES_PER_ENVIRONMENT,
  },
): WorkspaceMetadataSnapshot {
  const dropOrder = snapshot.threads.toSorted((left, right) => {
    const archiveDelta = Number(right.archivedAt !== null) - Number(left.archivedAt !== null);
    return (
      archiveDelta ||
      threadRecency(left) - threadRecency(right) ||
      String(left.id).localeCompare(String(right.id))
    );
  });
  let threads = snapshot.threads;
  if (threads.length > caps.maxThreads) {
    const dropped = new Set(dropOrder.slice(0, threads.length - caps.maxThreads));
    threads = threads.filter((thread) => !dropped.has(thread));
  }

  const withThreads = (
    nextThreads: WorkspaceMetadataSnapshot["threads"],
  ): WorkspaceMetadataSnapshot => Object.assign({}, snapshot, { threads: nextThreads });
  let bounded = withThreads(threads);
  while (
    workspaceMetadataPayloadBytes(bounded) > caps.maxPayloadBytes &&
    bounded.threads.length > 0
  ) {
    const ordered = bounded.threads.toSorted((left, right) => {
      const archiveDelta = Number(right.archivedAt !== null) - Number(left.archivedAt !== null);
      return (
        archiveDelta ||
        threadRecency(left) - threadRecency(right) ||
        String(left.id).localeCompare(String(right.id))
      );
    });
    const dropCount = Math.max(1, Math.ceil(ordered.length / 4));
    const dropped = new Set(ordered.slice(0, dropCount));
    bounded = withThreads(bounded.threads.filter((thread) => !dropped.has(thread)));
  }
  return bounded;
}

export function workspaceMetadataNamespaceKey(namespace: WorkspaceMetadataCacheNamespace): string {
  return JSON.stringify([
    namespace.hubOrigin.replace(/\/+$/g, "").toLowerCase(),
    namespace.accountId,
    namespace.environmentId,
  ]);
}

export function planWorkspaceMetadataCacheEvictions(input: {
  readonly existing: ReadonlyArray<WorkspaceMetadataCacheRecord>;
  readonly incoming: WorkspaceMetadataCacheRecord;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}): { readonly accepted: boolean; readonly evict: ReadonlyArray<WorkspaceMetadataCacheNamespace> } {
  const maxEntries = input.maxEntries ?? MAX_WORKSPACE_SNAPSHOT_ENVIRONMENTS;
  const maxBytes = input.maxBytes ?? MAX_WORKSPACE_SNAPSHOT_TOTAL_BYTES;
  if (input.incoming.payloadBytes > maxBytes || maxEntries < 1) {
    return { accepted: false, evict: [] };
  }
  const incomingKey = workspaceMetadataNamespaceKey(input.incoming.namespace);
  const candidates = input.existing
    .filter((record) => workspaceMetadataNamespaceKey(record.namespace) !== incomingKey)
    .toSorted(
      (left, right) =>
        left.updatedAt - right.updatedAt ||
        workspaceMetadataNamespaceKey(left.namespace).localeCompare(
          workspaceMetadataNamespaceKey(right.namespace),
        ),
    );
  let count = candidates.length + 1;
  let bytes =
    candidates.reduce((total, record) => total + record.payloadBytes, 0) +
    input.incoming.payloadBytes;
  const evict: WorkspaceMetadataCacheNamespace[] = [];
  for (const candidate of candidates) {
    if (count <= maxEntries && bytes <= maxBytes) break;
    evict.push(candidate.namespace);
    count -= 1;
    bytes -= candidate.payloadBytes;
  }
  return { accepted: count <= maxEntries && bytes <= maxBytes, evict };
}
