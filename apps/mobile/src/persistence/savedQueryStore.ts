import { planEvictionsToCapacity } from "@ryco/client-runtime/connection";
import type { EnvironmentId } from "@ryco/contracts";

import type { SavedQueryStore } from "../rpc/savedQueries";
import { registerEnvironmentDevicePurge } from "./environmentDevicePurge";
import { payloadByteLength, type SavedQueryStat, type SnapshotDb } from "./snapshotDb";

/**
 * The device side of the saved query cache (rpc/savedQueries.ts): node reads a
 * screen showed, kept so the next open shows them at once. The same rules as
 * the cached threads apply: rows live in the client-cache database, only while
 * the "Keep recent conversations on this device" setting is on (turning it
 * off removes them all), and go with the environment's snapshot (forgetting
 * the node, Hub sign-out and revocation, Settings' "Clear device cache").
 * Nothing secret is ever saved: only reads the screens show.
 *
 * Bounded per environment and overall (count and bytes, least recently
 * written first), one answer at most `SAVED_QUERY_MAX_BYTES`. Every row is
 * versioned by the store format and the query's own codec; a row of another
 * version is a miss and is removed.
 */

/** Bump when the row format itself changes; every older row becomes a miss. */
export const SAVED_QUERY_FORMAT_VERSION = 1;
/** One answer larger than this is not kept (an unusually large read). */
export const SAVED_QUERY_MAX_BYTES = 512 * 1024;
export interface SavedQueryCaps {
  readonly perEnvironment: { readonly maxEntries: number; readonly maxBytes: number };
  readonly overall: { readonly maxEntries: number; readonly maxBytes: number };
}
export const SAVED_QUERY_CAPS: SavedQueryCaps = {
  perEnvironment: { maxEntries: 160, maxBytes: 3 * 1024 * 1024 },
  overall: { maxEntries: 640, maxBytes: 12 * 1024 * 1024 },
};
/**
 * Answers are written after this quiet period; a newer answer for the same
 * read replaces one still waiting, so a stream of status pushes costs one
 * encode and one write per window instead of one per push.
 */
export const SAVED_QUERY_WRITE_DELAY_MS = 1_000;

/** The stored version of a query's codec version under the current row format. */
export function storedSavedQueryVersion(codecVersion: number): number {
  return SAVED_QUERY_FORMAT_VERSION * 10_000 + codecVersion;
}

interface PendingSave {
  readonly environmentId: EnvironmentId;
  readonly key: string;
  readonly version: number;
  readonly encode: () => string;
  readonly epoch: number;
}

export interface SavedQueryStoreHandle extends SavedQueryStore {
  /** Writes every waiting answer now (backgrounding, tests). */
  readonly flush: () => Promise<void>;
  readonly dispose: () => void;
}

function warn(message: string) {
  return (error: unknown) => {
    console.warn(`[saved-queries] ${message}`, error);
  };
}

function entryId(environmentId: string, key: string): string {
  return `${environmentId}\u0000${key}`;
}

/** Rows to remove so each environment and the whole store fit their caps. */
export function planSavedQueryEvictions(
  stats: ReadonlyArray<SavedQueryStat>,
  pinned: ReadonlySet<string>,
  caps: SavedQueryCaps = SAVED_QUERY_CAPS,
): SavedQueryStat[] {
  const byId = new Map(stats.map((stat) => [entryId(stat.environmentId, stat.key), stat]));
  const toCandidate = (stat: SavedQueryStat) => {
    const id = entryId(stat.environmentId, stat.key);
    return {
      key: id,
      lastAccessedAt: stat.updatedAt,
      retainedBytes: stat.payloadBytes,
      evictable: !pinned.has(id),
    };
  };
  const planned = new Set<string>();
  const byEnvironment = new Map<string, SavedQueryStat[]>();
  for (const stat of stats) {
    const rows = byEnvironment.get(stat.environmentId) ?? [];
    rows.push(stat);
    byEnvironment.set(stat.environmentId, rows);
  }
  for (const rows of byEnvironment.values()) {
    for (const id of planEvictionsToCapacity(rows.map(toCandidate), caps.perEnvironment)) {
      planned.add(id);
    }
  }
  const remaining = stats.filter((stat) => !planned.has(entryId(stat.environmentId, stat.key)));
  for (const id of planEvictionsToCapacity(remaining.map(toCandidate), caps.overall)) {
    planned.add(id);
  }
  return [...planned].flatMap((id) => {
    const stat = byId.get(id);
    return stat ? [stat] : [];
  });
}

export function createSavedQueryStore(deps: {
  readonly db: SnapshotDb;
  /** The "keep recent conversations" device setting. */
  readonly isEnabled: () => boolean;
  /**
   * Resolves once `isEnabled` reflects the saved choice. On a cold start the
   * first reads come before the preferences load; they wait instead of
   * reading the setting as off.
   */
  readonly ready?: Promise<void>;
  readonly now: () => number;
  readonly writeDelayMs?: number;
  readonly caps?: SavedQueryCaps;
}): SavedQueryStoreHandle {
  const ready = (deps.ready ?? Promise.resolve()).catch(() => undefined);
  const writeDelayMs = deps.writeDelayMs ?? SAVED_QUERY_WRITE_DELAY_MS;
  const pending = new Map<string, PendingSave>();
  /** Bumped by an environment purge: a write captured before it is dropped. */
  const epochs = new Map<string, number>();
  const epochOf = (environmentId: string) => epochs.get(environmentId) ?? 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing: Promise<void> = Promise.resolve();
  let disposed = false;

  const writeBatch = async (batch: ReadonlyArray<PendingSave>): Promise<void> => {
    await ready;
    if (!deps.isEnabled()) return;
    const written = new Set<string>();
    for (const save of batch) {
      if (disposed || epochOf(save.environmentId) !== save.epoch) continue;
      let payload: string;
      try {
        payload = save.encode();
      } catch (error) {
        warn("could not encode an answer")(error);
        continue;
      }
      const payloadBytes = payloadByteLength(payload);
      // Checked again after the encode: a purge may have landed meanwhile.
      if (epochOf(save.environmentId) !== save.epoch || !deps.isEnabled()) continue;
      if (payloadBytes > SAVED_QUERY_MAX_BYTES) {
        // An older, smaller copy would now be out of date.
        await deps.db
          .removeSavedQueries([{ environmentId: save.environmentId, key: save.key }])
          .catch(warn("could not remove an oversized answer"));
        continue;
      }
      try {
        await deps.db.saveSavedQuery({
          environmentId: save.environmentId,
          key: save.key,
          schemaVersion: storedSavedQueryVersion(save.version),
          payload,
          payloadBytes,
          updatedAt: deps.now(),
        });
        written.add(entryId(save.environmentId, save.key));
      } catch (error) {
        warn("could not save an answer")(error);
      }
    }
    if (written.size === 0) return;
    try {
      const evictions = planSavedQueryEvictions(
        await deps.db.listSavedQueryStats(),
        written,
        deps.caps,
      );
      await deps.db.removeSavedQueries(evictions);
    } catch (error) {
      warn("could not apply the saved answer budget")(error);
    }
  };

  const flush = (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.size === 0) return flushing;
    const batch = [...pending.values()];
    pending.clear();
    // Batches run one after another so a later answer is never overwritten by an earlier one.
    flushing = flushing.then(() => writeBatch(batch)).catch(warn("could not save answers"));
    return flushing;
  };

  const unregisterPurge = registerEnvironmentDevicePurge(async (environmentId) => {
    epochs.set(environmentId, epochOf(environmentId) + 1);
    for (const [id, save] of pending) {
      if (save.environmentId === environmentId) pending.delete(id);
    }
    // The snapshot removal deletes the rows too; this covers a purge that runs
    // without it (a registered purge alone).
    await flushing;
    const stats = await deps.db.listSavedQueryStats();
    await deps.db.removeSavedQueries(stats.filter((stat) => stat.environmentId === environmentId));
  });

  return {
    load: async (environmentId, key, version) => {
      await ready;
      if (!deps.isEnabled()) return null;
      try {
        const row = await deps.db.loadSavedQuery(environmentId, key);
        if (row === null) return null;
        if (row.schemaVersion !== storedSavedQueryVersion(version)) {
          void deps.db
            .removeSavedQueries([{ environmentId, key }])
            .catch(warn("could not remove an outdated answer"));
          return null;
        }
        return { payload: row.payload, savedAt: row.updatedAt };
      } catch (error) {
        warn("could not read a saved answer")(error);
        return null;
      }
    },
    save: (environmentId, key, version, encode) => {
      if (disposed) return;
      pending.set(entryId(environmentId, key), {
        environmentId,
        key,
        version,
        encode,
        epoch: epochOf(environmentId),
      });
      timer ??= setTimeout(() => {
        timer = null;
        void flush();
      }, writeDelayMs);
    },
    flush,
    dispose: () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending.clear();
      unregisterPurge();
    },
  };
}

/** Bytes of one environment's saved answers (Settings' device cache sizes). */
export async function savedQueryBytes(
  db: SnapshotDb,
  environmentId: EnvironmentId,
): Promise<number> {
  try {
    return await db.savedQueryBytes(environmentId);
  } catch {
    return 0;
  }
}
