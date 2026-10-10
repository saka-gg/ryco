import fs from "node:fs/promises";
import path from "node:path";
import { Effect, Semaphore } from "effect";
import { PROJECT_RELOCATION_PENDING_MESSAGE, StorageError } from "@ryco/contracts";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { captureWorktreeIdentity } from "./filesystem.ts";

// One process-wide admission lock: orchestration projection, terminal spawning and cleanup.
// The node's existing single-owner database/runtime boundary remains authoritative.
export const storageLifecycleLock = Semaphore.makeUnsafe(1);
export {
  acquireStorageSettingsLease,
  acquireStorageSettingsUpdateLease,
  hasStorageSettingsUpdateLease,
  hasStorageSettingsLease,
  noteStorageSettingsChange,
} from "./settingsAdmission.ts";
const creations = new Map<string, number>();
let activityVersion = 0;
export const noteStorageActivity = () => {
  activityVersion++;
};
export const storageActivityVersion = () => activityVersion;
const overlaps = (a: string, b: string, platform: NodeJS.Platform = process.platform) => {
  if (platform === "darwin" || platform === "win32") {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  const boundary = (root: string) => (root.endsWith(path.sep) ? root : root + path.sep);
  return a === b || a.startsWith(boundary(b)) || b.startsWith(boundary(a));
};
/** `candidate` is `root` or below it. */
const contains = (root: string, candidate: string, platform: NodeJS.Platform) => {
  const a = platform === "darwin" || platform === "win32" ? root.toLowerCase() : root;
  const b = platform === "darwin" || platform === "win32" ? candidate.toLowerCase() : candidate;
  return a === b || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
};

const removingPaths = (row: { path: string; identity_json: string }): readonly string[] => {
  let identity: { quarantinePath?: string } | null;
  try {
    identity = JSON.parse(row.identity_json) as typeof identity;
  } catch {
    return [path.parse(row.path).root];
  }
  const quarantine = identity?.quarantinePath;
  if (quarantine === undefined) return [row.path];
  if (
    typeof quarantine !== "string" ||
    !path.isAbsolute(quarantine) ||
    path.dirname(quarantine) !== path.dirname(row.path) ||
    !path.basename(quarantine).startsWith(".cleanup-")
  )
    return [path.parse(row.path).root]; // Corrupt provenance: conservatively refuse admission.
  return [row.path, quarantine];
};

/** Resolve aliases even when the leaf was removed, so refusal survives partial cleanup. */
export async function canonicalStoragePath(candidate: string): Promise<string> {
  let current = path.resolve(candidate);
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...suffix.toReversed());
    } catch (cause) {
      if (
        (cause as NodeJS.ErrnoException).code !== "ENOENT" &&
        (cause as NodeJS.ErrnoException).code !== "ENOTDIR"
      )
        throw cause;
      const parent = path.dirname(current);
      if (parent === current) throw cause;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

/** Short admission lease; git add/hydration never holds the node-wide lock. */
export function acquireWorktreeCreationLease(sql: SqlClient.SqlClient, candidate: string) {
  return storageLifecycleLock.withPermit(
    Effect.gen(function* () {
      const canonical = yield* Effect.tryPromise(() => canonicalStoragePath(candidate));
      if (yield* isWorktreeRelocationBlocked(sql, canonical))
        return yield* new StorageError({
          detail:
            "Checkout relocation is pending or this is a retired checkout path. Reload the workspace.",
        });
      const pending = yield* sql<{
        path: string;
        identity_json: string;
      }>`SELECT path, identity_json FROM storage_owned_entries WHERE state = 'removing' LIMIT 257`;
      if (pending.length > 256)
        return yield* new StorageError({
          detail:
            "Too many interrupted cleanups to establish safe creation admission. Inspect pending cleanup records.",
        });
      if (pending.some((row) => removingPaths(row).some((root) => overlaps(root, canonical))))
        return yield* new StorageError({
          detail: "Checkout cleanup is pending. Creation cannot replace an in-flight removal.",
        });
      creations.set(canonical, (creations.get(canonical) ?? 0) + 1);
      return Effect.sync(() => {
        const remaining = (creations.get(canonical) ?? 1) - 1;
        if (remaining > 0) creations.set(canonical, remaining);
        else creations.delete(canonical);
        noteStorageActivity();
      });
    }),
  );
}

/** Path-specific use lease before recovery/provider callbacks. Never holds the global lock. */
export function acquireStoragePathUseLease(sql: SqlClient.SqlClient, candidate: string) {
  return storageLifecycleLock.withPermit(
    Effect.gen(function* () {
      const canonical = yield* Effect.tryPromise(() => canonicalStoragePath(candidate));
      const blocker = yield* storagePathBlocker(sql, canonical);
      if (blocker !== null)
        return yield* new StorageError({
          detail:
            blocker === "project-relocation"
              ? PROJECT_RELOCATION_PENDING_MESSAGE
              : "Checkout cleanup is pending or complete. Restore/recreate it before provider recovery.",
        });
      creations.set(canonical, (creations.get(canonical) ?? 0) + 1);
      return Effect.sync(() => {
        const remaining = (creations.get(canonical) ?? 1) - 1;
        if (remaining > 0) creations.set(canonical, remaining);
        else creations.delete(canonical);
        noteStorageActivity();
      });
    }),
  );
}

/** Called only inside the admission lock when cleanup claims a path. */
export const hasWorktreeCreationLease = (candidate: string): boolean =>
  [...creations.keys()].some((root) => overlaps(root, candidate));

export function recordCreatedWorktree(
  sql: SqlClient.SqlClient,
  repository: string,
  candidate: string,
) {
  return Effect.gen(function* () {
    const canonicalRepository = yield* Effect.tryPromise(() => fs.realpath(repository));
    const canonicalCandidate = yield* Effect.tryPromise(() => fs.realpath(candidate));
    const captured = yield* Effect.tryPromise(() =>
      captureWorktreeIdentity(canonicalRepository, path.resolve(candidate)),
    ).pipe(
      Effect.match({
        onSuccess: (identity) => ({ identity, error: null }),
        onFailure: (cause) => ({ identity: null, error: cause.message }),
      }),
    );
    const recorded = yield* sql<{
      id: string;
    }>`INSERT INTO storage_owned_entries (id, path, repository_path, category, identity_json, created_at, state, last_error)
      VALUES (${crypto.randomUUID()}, ${canonicalCandidate}, ${canonicalRepository}, 'worktree', ${JSON.stringify(captured.identity)}, ${new Date().toISOString()}, ${captured.identity ? "owned" : "unverified"}, ${captured.error})
      ON CONFLICT(path) DO UPDATE SET id = excluded.id, identity_json = excluded.identity_json,
      repository_path = excluded.repository_path, created_at = excluded.created_at,
      state = excluded.state, completed_at = NULL, last_error = excluded.last_error
      WHERE storage_owned_entries.state != 'removing' RETURNING id`;
    if (recorded.length !== 1)
      return yield* new StorageError({
        detail:
          "Ownership capture refused to replace a pending cleanup. The creation outcome remains protected.",
      });
  });
}

/**
 * Why a path is refused: a chat's folder is moving into a project (transient, retry soon), or
 * checkout lifecycle work (relocation, cleanup, tombstone) fences it.
 */
export type StoragePathBlocker = "project-relocation" | "checkout";

/**
 * Storage admission for a path: refused while a chat's folder moves or checkout lifecycle work
 * fences it. Persistent tombstones prevent restart/resume from granting authority to a removed
 * checkout.
 */
export function isStoragePathBlocked(
  sql: SqlClient.SqlClient,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
  ignoredRelocationId?: string,
) {
  return storagePathBlocker(sql, candidate, platform, ignoredRelocationId).pipe(
    Effect.map((blocker) => blocker !== null),
  );
}

/** {@link isStoragePathBlocked}, with the reason, so admission can tell a retryable move apart. */
export function storagePathBlocker(
  sql: SqlClient.SqlClient,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
  ignoredRelocationId?: string,
) {
  return Effect.gen(function* () {
    if (yield* isProjectRelocationBlocked(sql, candidate, platform))
      return "project-relocation" as const;
    return (yield* isCheckoutPathBlocked(sql, candidate, platform, ignoredRelocationId))
      ? ("checkout" as const)
      : null;
  });
}

function isCheckoutPathBlocked(
  sql: SqlClient.SqlClient,
  candidate: string,
  platform: NodeJS.Platform,
  ignoredRelocationId: string | undefined,
) {
  const ancestors: string[] = [];
  let current = path.resolve(candidate);
  for (;;) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const matching =
    platform === "darwin" || platform === "win32"
      ? sql`path COLLATE NOCASE IN ${sql.in(ancestors)}`
      : sql.in("path", ancestors);
  return Effect.gen(function* () {
    if (yield* isWorktreeRelocationBlocked(sql, candidate, platform, ignoredRelocationId))
      return true;
    const ancestorsBlocked = yield* sql<{
      path: string;
    }>`SELECT path FROM storage_owned_entries WHERE state IN ('removing', 'removed') AND ${matching} LIMIT 1`;
    if (ancestorsBlocked.length) return true;
    // A parent cwd can access a removing child. Removed children do not permanently
    // disable their parent; active removal overlap is checked in both directions.
    const pending = yield* sql<{
      path: string;
      identity_json: string;
    }>`SELECT path, identity_json FROM storage_owned_entries WHERE state = 'removing' LIMIT 257`;
    return (
      pending.length > 256 ||
      pending.some((row) =>
        removingPaths(row).some((root) => overlaps(root, path.resolve(candidate), platform)),
      )
    );
  });
}

/** Active moves fence both paths; completed moves permanently fence the old path. */
export function isWorktreeRelocationBlocked(
  sql: SqlClient.SqlClient,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
  ignoredRelocationId?: string,
) {
  return Effect.gen(function* () {
    const table =
      yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'managed_worktree_relocations'`;
    if (!table.length) return false;
    const rows = yield* sql<{ source_path: string; destination_path: string; state: string }>`
      SELECT source_path, destination_path, state FROM managed_worktree_relocations
      WHERE state IN ('moving', 'moved', 'attention', 'complete')
        AND worktree_id != ${ignoredRelocationId ?? ""}`;
    const resolved = path.resolve(candidate);
    return rows.some((row) =>
      row.state === "complete"
        ? contains(row.source_path, resolved, platform)
        : overlaps(row.source_path, resolved, platform) ||
          overlaps(row.destination_path, resolved, platform),
    );
  });
}

/**
 * An unsettled chat promotion (`project_relocations` row `pending` or `moved`, see
 * `project/chatPromotion.ts`) fences everything at or below both of its paths, so no turn, provider
 * session or terminal starts in a folder that is moving. Promotion writes the row before it stops
 * sessions and closes terminals. Unlike a checkout move, ancestors stay usable: a project that
 * merely contains the chats folder is unrelated, and a write into a moving copy fails its
 * verification. Settled moves lift the fence; the project then points at its new root.
 */
function isProjectRelocationBlocked(
  sql: SqlClient.SqlClient,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
) {
  return Effect.gen(function* () {
    const table =
      yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_relocations'`;
    if (!table.length) return false;
    const rows = yield* sql<{ source_path: string; destination_path: string }>`
      SELECT source_path, destination_path FROM project_relocations
      WHERE state IN ('pending', 'moved')`;
    const resolved = path.resolve(candidate);
    return rows.some(
      (row) =>
        contains(row.source_path, resolved, platform) ||
        contains(row.destination_path, resolved, platform),
    );
  });
}
