/**
 * ChatFolderRestore - a chat's folder comes back when something uses it.
 *
 * Empty-folder cleanup (`chatFolderCleanup.ts`) removes the folder of a chat idle for a while; a
 * user may delete one by hand. Whatever runs in a chat's folder (a provider session, a terminal,
 * a file read, an editor, a move into a project) calls {@link restoreChatFolder} first, after
 * taking its path use lease or terminal admission, so cleanup cannot remove it again in between.
 * Only an active chat's own folder (by record and by name) is ever recreated.
 *
 * @module ChatFolderRestore
 */
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";

import { isChatFolderNameOf } from "./chatFolderNames.ts";

/** Whether nothing exists at `folder`; other `lstat` failures reject. */
export const isMissingPath = (folder: string) =>
  lstat(folder).then(
    () => false,
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return true;
      throw cause;
    },
  );

/** The active chat whose folder is exactly `folder`, when its name is one Ryco gave that chat. */
const chatOwningFolder = (sql: SqlClient.SqlClient, folder: string) =>
  sql<{ readonly projectId: string }>`
    SELECT project_id AS "projectId" FROM projection_projects
    WHERE kind = 'chat' AND deleted_at IS NULL AND workspace_root = ${folder}
    LIMIT 2
  `.pipe(
    Effect.map((rows) =>
      rows.length === 1 && isChatFolderNameOf(folder, rows[0]!.projectId)
        ? rows[0]!.projectId
        : null,
    ),
  );

/**
 * Whether `folder` is an active chat's own folder that is missing on disk: removed by the sweep
 * (or by hand), and recreated by {@link restoreChatFolder} on its next use. Never fails.
 */
export const isRemovedChatFolder = (
  sql: SqlClient.SqlClient,
  folder: string,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (!path.isAbsolute(folder) || !(yield* Effect.tryPromise(() => isMissingPath(folder)))) {
      return false;
    }
    return (yield* chatOwningFolder(sql, folder)) !== null;
  }).pipe(Effect.orElseSucceed(() => false));

/**
 * Recreate an active chat's own folder when it is missing; anything else is left as it is. Call
 * after taking the path's use lease (or terminal admission), so the sweep cannot remove it again
 * before it is used. One `lstat` when the folder exists. Never fails; reports whether it
 * recreated the folder.
 */
export const restoreChatFolder = (
  sql: SqlClient.SqlClient,
  folder: string,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (!(yield* isRemovedChatFolder(sql, folder))) return false;
    yield* Effect.tryPromise(async () => {
      // The chats root may be gone too; the chat's folder sits directly inside it.
      await mkdir(path.dirname(folder), { recursive: true });
      await mkdir(folder).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== "EEXIST") throw cause;
      });
    });
    yield* Effect.logInfo("recreated a chat folder", { folder });
    return true;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("could not recreate a chat folder", { folder, cause: String(cause) }).pipe(
        Effect.as(false),
      ),
    ),
  );
