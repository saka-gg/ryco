import type { EnvironmentId } from "@ryco/contracts";
import {
  isWorkspaceMetadataSnapshot,
  planWorkspaceMetadataCacheEvictions,
  workspaceMetadataNamespaceKey,
  workspaceMetadataPayloadBytes,
  type WorkspaceMetadataCache,
  type WorkspaceMetadataCacheNamespace,
  type WorkspaceMetadataCacheRecord,
  type WorkspaceMetadataSnapshot,
} from "@ryco/client-runtime/state/workspace";

/** Where an earlier build persisted this cache; it is cleared once and never read. */
export const HOSTED_WORKSPACE_METADATA_CACHE_KEY = "ryco:hosted-workspace-metadata:v1";

function normalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return url.origin.toLowerCase();
  } catch {
    return origin.replace(/\/+$/gu, "").toLowerCase();
  }
}

function normalizeNamespace(
  namespace: WorkspaceMetadataCacheNamespace,
): WorkspaceMetadataCacheNamespace {
  return { ...namespace, hubOrigin: normalizeOrigin(namespace.hubOrigin) };
}

function isNamespace(value: unknown): value is WorkspaceMetadataCacheNamespace {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<WorkspaceMetadataCacheNamespace>;
  return (
    typeof candidate.hubOrigin === "string" &&
    candidate.hubOrigin.length > 0 &&
    candidate.hubOrigin.length <= 2_048 &&
    typeof candidate.accountId === "string" &&
    candidate.accountId.length > 0 &&
    candidate.accountId.length <= 2_048 &&
    typeof candidate.environmentId === "string" &&
    candidate.environmentId.length > 0 &&
    candidate.environmentId.length <= 2_048
  );
}

function sharesMembers(
  snapshot: unknown,
  stored: WorkspaceMetadataSnapshot,
): snapshot is WorkspaceMetadataSnapshot {
  if (typeof snapshot !== "object" || snapshot === null) return false;
  const candidate = snapshot as Partial<WorkspaceMetadataSnapshot>;
  return (
    candidate.projects === stored.projects &&
    candidate.worktrees === stored.worktrees &&
    candidate.threads === stored.threads
  );
}

/**
 * A snapshot that shares its member arrays with the stored one only changed
 * its fixed fields: the arrays were validated when stored, so validating the
 * snapshot with empty arrays covers everything that could differ.
 */
function isSnapshotFor(
  snapshot: unknown,
  environmentId: EnvironmentId,
  stored: WorkspaceMetadataCacheRecord | undefined,
): snapshot is WorkspaceMetadataSnapshot {
  if (stored !== undefined && sharesMembers(snapshot, stored.snapshot)) {
    return isWorkspaceMetadataSnapshot(
      { ...snapshot, projects: [], worktrees: [], threads: [] },
      environmentId,
    );
  }
  return isWorkspaceMetadataSnapshot(snapshot, environmentId);
}

/**
 * Validates an incoming record against the records held, and returns it under
 * its normalized namespace; null when it is not a well-formed record.
 */
function acceptRecord(
  value: unknown,
  records: ReadonlyMap<string, WorkspaceMetadataCacheRecord>,
): WorkspaceMetadataCacheRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Partial<WorkspaceMetadataCacheRecord>;
  if (!isNamespace(candidate.namespace)) return null;
  const namespace = normalizeNamespace(candidate.namespace);
  const { snapshot, payloadBytes, updatedAt } = candidate;
  if (
    !isSnapshotFor(
      snapshot,
      namespace.environmentId,
      records.get(workspaceMetadataNamespaceKey(namespace)),
    ) ||
    typeof payloadBytes !== "number" ||
    !Number.isSafeInteger(payloadBytes) ||
    payloadBytes !== workspaceMetadataPayloadBytes(snapshot) ||
    typeof updatedAt !== "number" ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < 0
  ) {
    return null;
  }
  return { namespace, snapshot, payloadBytes, updatedAt };
}

/**
 * Metadata-only hosted-Web cache. It lives in page memory and never touches
 * the service worker, authenticated HTTP cache, CacheStorage, or page storage.
 */
export function createInMemoryWorkspaceMetadataCache(): WorkspaceMetadataCache {
  const records = new Map<string, WorkspaceMetadataCacheRecord>();
  let pending: Promise<unknown> = Promise.resolve();
  const exclusive = <A>(operation: () => Promise<A>): Promise<A> => {
    const run = pending.then(operation, operation);
    pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    load: async (namespace) =>
      records.get(workspaceMetadataNamespaceKey(normalizeNamespace(namespace))) ?? null,
    list: async ({ hubOrigin, accountId }) => {
      const origin = normalizeOrigin(hubOrigin);
      return Array.from(records.values()).filter(
        (record) =>
          record.namespace.hubOrigin === origin && record.namespace.accountId === accountId,
      );
    },
    replace: (incoming) =>
      exclusive(async () => {
        const accepted = acceptRecord(incoming, records);
        if (accepted === null) throw new TypeError("Invalid hosted workspace metadata record.");
        const plan = planWorkspaceMetadataCacheEvictions({
          existing: Array.from(records.values()),
          incoming: accepted,
        });
        if (!plan.accepted) return;
        for (const namespace of plan.evict)
          records.delete(workspaceMetadataNamespaceKey(namespace));
        // Delete first so the replaced record is also the most recently written.
        const key = workspaceMetadataNamespaceKey(accepted.namespace);
        records.delete(key);
        records.set(key, accepted);
      }),
    purgeEnvironment: (namespace) =>
      exclusive(async () => {
        records.delete(workspaceMetadataNamespaceKey(normalizeNamespace(namespace)));
      }),
    purgeAccount: ({ hubOrigin, accountId }) =>
      exclusive(async () => {
        const origin = normalizeOrigin(hubOrigin);
        for (const [key, record] of records) {
          if (record.namespace.hubOrigin === origin && record.namespace.accountId === accountId) {
            records.delete(key);
          }
        }
      }),
  };
}

let browserWorkspaceMetadataCache: WorkspaceMetadataCache | null = null;

export function getBrowserWorkspaceMetadataCache(): WorkspaceMetadataCache {
  if (!browserWorkspaceMetadataCache) {
    // Disk persistence now belongs to the account-fenced encrypted read cache.
    // This adapter remains the coordinator's bounded in-memory metadata index.
    try {
      window.localStorage.removeItem(HOSTED_WORKSPACE_METADATA_CACHE_KEY);
    } catch {
      /* Optional storage. */
    }
    browserWorkspaceMetadataCache = createInMemoryWorkspaceMetadataCache();
  }
  return browserWorkspaceMetadataCache;
}
