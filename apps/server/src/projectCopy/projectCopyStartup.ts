/**
 * projectCopyStartup - where the cross-node project copy keeps its state, and whether a server
 * start has anything of it to clean up or finish.
 *
 * The copy services load on first use (`ProjectCopyServicesDeferred.ts`). A start loads them only
 * when an earlier process left work behind: an import row that is still running, one interrupted
 * with something left (a staging folder, a child, a registered project to finish), settled rows
 * old enough to prune, or files in the transfer, import or export directories. Small and free of
 * the services themselves, so the boot path holds only this check.
 *
 * @module projectCopyStartup
 */
import { readdir } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Uploaded transfers, under the state directory. */
export const PROJECT_TRANSFERS_DIRECTORY = "project-transfers";
/** Claimed transfers, one directory per import; the import job owns each directory's lifetime. */
export const PROJECT_IMPORTS_DIRECTORY = "project-imports";
/** Built export artifacts, one directory per export id. */
export const PROJECT_EXPORTS_DIRECTORY = "project-exports";
/** Settled imports without a leftover are pruned after this long. */
export const PROJECT_IMPORT_SETTLED_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const hasEntries = (directory: string) =>
  Effect.promise(() =>
    readdir(directory).then(
      (entries) => entries.length > 0,
      (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
    ),
  );

/**
 * Whether an earlier process left copy work for this start: the same rows and folders
 * `ProjectImports.recoverOnStartup`, the transfer store and the export sweep handle. A check
 * that fails answers yes, so nothing is ever skipped by mistake.
 */
export const projectCopyNeedsStartupWork = (
  stateDir: string,
): Effect.Effect<boolean, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const cutoff = new Date(Date.now() - PROJECT_IMPORT_SETTLED_RETENTION_MS).toISOString();
    const rows = yield* sql<{ readonly found: number }>`
      SELECT 1 AS found FROM project_imports
      WHERE status = 'running'
        OR (status = 'interrupted'
          AND (staging_path IS NOT NULL OR child_pid IS NOT NULL OR registered = 1))
        OR (status <> 'running' AND staging_path IS NULL AND updated_at < ${cutoff})
      LIMIT 1`;
    if (rows.length > 0) return true;
    for (const directory of [
      PROJECT_TRANSFERS_DIRECTORY,
      PROJECT_IMPORTS_DIRECTORY,
      PROJECT_EXPORTS_DIRECTORY,
    ]) {
      if (yield* hasEntries(path.join(stateDir, directory))) return true;
    }
    return false;
  }).pipe(Effect.orElseSucceed(() => true));
