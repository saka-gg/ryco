/**
 * AuthRecordRetention - removes auth rows that can no longer authenticate anyone.
 *
 * Nothing else deletes from `auth_sessions` or `auth_pairing_links`: a revoked, expired or
 * superseded session and a consumed, revoked or expired pairing link only get a timestamp, and
 * keep their credential and client metadata (IP address, user agent). Every bearer renewal adds
 * a session row. This pass removes, conservatively:
 *
 * - pairing links consumed, revoked or expired more than `pairingLinkRetentionMs` ago (30 days);
 * - session rows revoked or expired more than `sessionRetentionMs` ago (90 days), but never a
 *   row of a pairing (rotation chain) that still has a live session: one that is neither
 *   revoked nor expired. Reusing a superseded bearer of a live pairing must keep finding its row,
 *   which is what revokes the pairing (`SessionCredentialService.verify`), and the chain head
 *   reads its predecessor (`AuthSessions.ts`'s `isChainHead`). A pairing that ended (revoked, or
 *   every session expired) goes row by row as each row passes the cutoff.
 *
 * Each delete is one statement of at most `deleteBatch` rows on the main connection, with a
 * pause after a full batch; `maxRowsPerPass` bounds a pass, and `backlog` says it stopped there.
 * Both tables are small (a few rows per paired device and month), so the candidate selection
 * reads them whole; the live pairings are collected once per statement.
 *
 * `DatabaseMaintenance` runs it in the background and loads this module with `import()` on the
 * first pass, like the event-log compaction pass, so it stays off the boot path.
 *
 * @module AuthRecordRetention
 */
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AuthRecordRetentionOptions {
  /** How long a consumed, revoked or expired pairing link stays. */
  readonly pairingLinkRetentionMs: number;
  /** How long a revoked or expired session row of an ended pairing stays. */
  readonly sessionRetentionMs: number;
  /** Rows per delete statement. */
  readonly deleteBatch: number;
  /** Rows a pass deletes at most, both tables together. */
  readonly maxRowsPerPass: number;
  /** Pause after a full batch. */
  readonly batchPauseMs: number;
}

export const DEFAULT_AUTH_RECORD_RETENTION_OPTIONS: AuthRecordRetentionOptions = {
  pairingLinkRetentionMs: 30 * DAY_MS,
  sessionRetentionMs: 90 * DAY_MS,
  deleteBatch: 200,
  maxRowsPerPass: 5_000,
  batchPauseMs: 8,
};

export interface AuthRecordRetentionResult {
  readonly deletedPairingLinks: number;
  readonly deletedSessions: number;
  /** The pass stopped at `maxRowsPerPass` with rows still to remove. */
  readonly backlog: boolean;
}

export const runAuthRecordRetentionPass = (
  options: AuthRecordRetentionOptions,
  nowMs: number,
): Effect.Effect<AuthRecordRetentionResult, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Stored timestamps are ISO-8601 UTC strings of one width, so they compare as text.
    const now = new Date(nowMs).toISOString();
    const linkCutoff = new Date(nowMs - options.pairingLinkRetentionMs).toISOString();
    const sessionCutoff = new Date(nowMs - options.sessionRetentionMs).toISOString();
    const batchSize = Math.max(1, options.deleteBatch);
    let remaining = Math.max(0, options.maxRowsPerPass);
    let backlog = false;

    const deleteInBatches = (
      deleteBatch: (limit: number) => Effect.Effect<ReadonlyArray<unknown>, SqlError>,
    ) =>
      Effect.gen(function* () {
        let deleted = 0;
        while (true) {
          if (remaining === 0) {
            backlog = true;
            return deleted;
          }
          const limit = Math.min(batchSize, remaining);
          const rows = (yield* deleteBatch(limit)).length;
          deleted += rows;
          remaining -= rows;
          if (rows < limit) return deleted;
          yield* Effect.sleep(options.batchPauseMs);
        }
      });

    const deletedPairingLinks = yield* deleteInBatches(
      (limit) => sql`
        DELETE FROM auth_pairing_links
        WHERE rowid IN (
          SELECT rowid
          FROM auth_pairing_links
          WHERE consumed_at < ${linkCutoff}
            OR revoked_at < ${linkCutoff}
            OR expires_at < ${linkCutoff}
          LIMIT ${limit}
        )
        RETURNING id
      `,
    );

    // Rows from before bearer rotation have no chain id and are their own chain, which a
    // successor names by the first row's session id (`COALESCE`, as in AuthSessions.ts).
    const deletedSessions = yield* deleteInBatches(
      (limit) => sql`
        DELETE FROM auth_sessions
        WHERE rowid IN (
          SELECT rowid
          FROM auth_sessions
          WHERE (revoked_at < ${sessionCutoff} OR expires_at < ${sessionCutoff})
            AND COALESCE(chain_id, session_id) NOT IN (
              SELECT COALESCE(chain_id, session_id)
              FROM auth_sessions
              WHERE revoked_at IS NULL
                AND expires_at > ${now}
            )
          LIMIT ${limit}
        )
        RETURNING session_id
      `,
    );

    return { deletedPairingLinks, deletedSessions, backlog } satisfies AuthRecordRetentionResult;
  });
