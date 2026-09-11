import type { EnvironmentApi, ProjectId } from "@ryco/contracts";
import { LRUCache } from "../lib/lruCache";

// Connection-scoped, memory-only: node artwork never enters browser persistence or the Hub cache.
const caches = new WeakMap<
  EnvironmentApi,
  {
    resolved: LRUCache<{ source: string | null; expiresAt: number }>;
    pending: Map<string, Promise<string | null>>;
  }
>();

export function readProjectIconSource(
  api: EnvironmentApi,
  projectId: ProjectId,
  revision: string | null,
  generation: string | null = null,
): Promise<string | null> {
  let cache = caches.get(api);
  if (!cache) {
    cache = { resolved: new LRUCache(64, 8 * 1024 * 1024), pending: new Map() };
    caches.set(api, cache);
  }
  const key = JSON.stringify([projectId, revision, generation]);
  const cached = cache.resolved.get(key);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.source);
  const pending = cache.pending.get(key);
  if (pending) return pending;
  const current = cache;
  const request = api.projects
    .readIcon({ projectId })
    .then((result) => {
      const source = result ? `data:${result.mimeType};base64,${result.dataBase64}` : null;
      current.resolved.set(
        key,
        { source, expiresAt: Date.now() + 5 * 60_000 },
        (source?.length ?? 0) * 2,
      );
      return source;
    })
    .finally(() => current.pending.delete(key));
  current.pending.set(key, request);
  return request;
}
