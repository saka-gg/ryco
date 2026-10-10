import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { WorkspaceLifecycleError } from "@ryco/contracts";

import {
  canonicalStoragePath,
  hasWorktreeCreationLease,
  storageLifecycleLock,
  isWorktreeRelocationBlocked,
} from "../storage/lifecycle.ts";

/**
 * Admission fence for a checkout being removed. It reuses the storage lifecycle
 * tombstone (`storage_owned_entries`): while a row is `removing`, turn starts, provider
 * recovery, terminal spawns and worktree creation all refuse the path; once `removed`,
 * new work there stays refused until the checkout is recreated.
 */
export interface CheckoutFenceClaim {
  readonly id: string;
  readonly path: string;
  readonly previousState: string | null;
}

export interface CheckoutFence {
  readonly claim: (input: {
    readonly path: string;
    readonly repository: string;
    readonly projectId: string;
  }) => Effect.Effect<CheckoutFenceClaim, WorkspaceLifecycleError>;
  /** Removal did not happen: restore exactly the previous admission state. */
  readonly release: (claim: CheckoutFenceClaim) => Effect.Effect<void>;
  /** Removal verified: keep refusing new work at this path. */
  readonly complete: (claim: CheckoutFenceClaim) => Effect.Effect<void>;
}

const fenceError = (detail: string) => new WorkspaceLifecycleError({ detail });

export const makeSqlCheckoutFence = (sql: SqlClient.SqlClient): CheckoutFence => ({
  claim: (input) =>
    storageLifecycleLock
      .withPermit(
        Effect.gen(function* () {
          const canonical = yield* Effect.tryPromise({
            try: () => canonicalStoragePath(input.path),
            catch: () => fenceError("Checkout path could not be resolved."),
          });
          if (yield* isWorktreeRelocationBlocked(sql, canonical))
            return yield* fenceError("Checkout relocation requires recovery before removal.");
          if (hasWorktreeCreationLease(canonical))
            return yield* Effect.fail(
              fenceError("A worktree creation is still using this path. Try again shortly."),
            );
          const rows = yield* sql<{
            id: string;
            state: string;
          }>`SELECT id, state FROM storage_owned_entries WHERE path = ${canonical} LIMIT 1`;
          const existing = rows[0];
          if (existing?.state === "removing")
            return yield* Effect.fail(
              fenceError("Another cleanup of this checkout is in progress or was interrupted."),
            );
          if (existing) {
            yield* sql`UPDATE storage_owned_entries SET state = 'removing', last_error = NULL WHERE id = ${existing.id} AND state = ${existing.state}`;
            return { id: existing.id, path: canonical, previousState: existing.state };
          }
          const id = crypto.randomUUID();
          yield* sql`INSERT INTO storage_owned_entries (id, path, repository_path, project_id, category, identity_json, created_at, state)
            VALUES (${id}, ${canonical}, ${input.repository}, ${input.projectId}, 'worktree', '{}', ${new Date().toISOString()}, 'removing')`;
          return { id, path: canonical, previousState: null };
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(WorkspaceLifecycleError)(cause)
            ? cause
            : fenceError("The checkout could not be fenced for removal."),
        ),
      ),
  release: (claim) =>
    storageLifecycleLock
      .withPermit(
        claim.previousState === null
          ? sql`DELETE FROM storage_owned_entries WHERE id = ${claim.id} AND state = 'removing'`
          : sql`UPDATE storage_owned_entries SET state = ${claim.previousState} WHERE id = ${claim.id} AND state = 'removing'`,
      )
      .pipe(Effect.asVoid, Effect.ignore({ log: true })),
  complete: (claim) =>
    storageLifecycleLock
      .withPermit(
        sql`UPDATE storage_owned_entries SET state = 'removed', last_error = NULL WHERE id = ${claim.id}`,
      )
      .pipe(Effect.asVoid, Effect.ignore({ log: true })),
});
