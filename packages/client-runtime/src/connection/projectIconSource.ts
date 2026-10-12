import type { EnvironmentId, EnvironmentApi, ProjectId } from "@ryco/contracts";
import { LRUCache } from "@ryco/shared/lruCache";

/** Resolved artwork (or a known absence) is reused this long before a refetch. */
export const PROJECT_ICON_TTL_MS = 5 * 60_000;
const MAX_ICONS_PER_ENVIRONMENT = 64;
const MAX_ICON_BYTES_PER_ENVIRONMENT = 8 * 1024 * 1024;
/** Environments whose artwork is kept at once; the least recently used is dropped. */
const MAX_ICON_CACHE_ENVIRONMENTS = 16;

interface EnvironmentIconCache {
  readonly resolved: LRUCache<{ readonly source: string | null; readonly expiresAt: number }>;
  readonly pending: Map<string, Promise<string | null>>;
  /** Set by an explicit clear: answers still in flight are discarded. */
  cleared: boolean;
}

/**
 * Memory-only, per environment: node artwork never enters browser persistence
 * or the Hub cache, and one node's artwork is never served for another. Keyed
 * by environment + project + avatar revision rather than by connection, so a
 * reconnect (a new client and API object for the same node) and a remount
 * reuse what was already read.
 */
const caches = new Map<EnvironmentId, EnvironmentIconCache>();

function readCache(environmentId: EnvironmentId): EnvironmentIconCache | undefined {
  return caches.get(environmentId);
}

function ensureCache(environmentId: EnvironmentId): EnvironmentIconCache {
  const existing = caches.get(environmentId);
  if (existing) {
    // Most recently used environment last.
    caches.delete(environmentId);
    caches.set(environmentId, existing);
    return existing;
  }
  const created: EnvironmentIconCache = {
    resolved: new LRUCache(MAX_ICONS_PER_ENVIRONMENT, MAX_ICON_BYTES_PER_ENVIRONMENT),
    pending: new Map(),
    cleared: false,
  };
  caches.set(environmentId, created);
  while (caches.size > MAX_ICON_CACHE_ENVIRONMENTS) {
    const oldest = caches.keys().next().value;
    if (oldest === undefined) break;
    caches.delete(oldest);
  }
  return created;
}

function entryKey(projectId: ProjectId, revision: string | null): string {
  return `${projectId}\u0000${revision === null ? "" : `#${revision}`}`;
}

/** Stable per-row request identity; build it once per input change, not per render. */
export function projectIconRequestKey(
  environmentId: EnvironmentId,
  projectId: ProjectId | undefined,
  revision: string | null,
): string {
  return `${environmentId}\u0000${projectId ?? ""}\u0000${revision === null ? "" : `#${revision}`}`;
}

/**
 * The cached artwork for a row, without a request: a data URL, `null` for a
 * project known to have none, or `undefined` when nothing current is cached.
 * Lets a remounted row render its icon on the first pass.
 */
export function peekProjectIconSource(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  revision: string | null,
): string | null | undefined {
  const cached = readCache(environmentId)?.resolved.get(entryKey(projectId, revision));
  return cached && cached.expiresAt > Date.now() ? cached.source : undefined;
}

export function readProjectIconSource(
  api: EnvironmentApi,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  revision: string | null,
): Promise<string | null> {
  const cache = ensureCache(environmentId);
  const key = entryKey(projectId, revision);
  const cached = cache.resolved.get(key);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.source);
  const pending = cache.pending.get(key);
  if (pending) return pending;
  const request = api.projects
    .readIcon({ projectId })
    .then((result) => {
      // Cleared meanwhile: neither publish nor re-cache.
      if (cache.cleared) return null;
      const source = result ? `data:${result.mimeType};base64,${result.dataBase64}` : null;
      // An environment dropped for capacity still answers its rows.
      if (caches.get(environmentId) === cache) {
        cache.resolved.set(
          key,
          { source, expiresAt: Date.now() + PROJECT_ICON_TTL_MS },
          (source?.length ?? 0) * 2,
        );
      }
      return source;
    })
    .finally(() => cache.pending.delete(key));
  cache.pending.set(key, request);
  return request;
}

/** Per-environment cache controls; never touch artwork belonging to another node. */
export function projectIconCacheBytes(environmentId: EnvironmentId): number {
  return readCache(environmentId)?.resolved.retainedBytes ?? 0;
}
/** Drops every environment's artwork: an account-session teardown. */
export function clearAllProjectIconCaches(): void {
  // Deleting the visited entry while iterating a Map is well defined.
  for (const environmentId of caches.keys()) clearProjectIconCache(environmentId);
}
export function clearProjectIconCache(environmentId: EnvironmentId): void {
  const cache = readCache(environmentId);
  if (!cache) return;
  cache.cleared = true;
  cache.resolved.clear();
  caches.delete(environmentId);
}
