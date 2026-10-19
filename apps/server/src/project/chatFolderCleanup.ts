/**
 * ChatFolderCleanup - empty chat folders go away after a while and come back when needed.
 *
 * Every chat without a project gets its own folder at its first send (`chatFolders.ts`), and most
 * never hold a file. With the `chatFolderCleanupAfterDays` setting on, a background sweep removes
 * a chat's folder once the chat has been idle that long and the folder is still empty. The chat
 * itself stays; artifacts never live in its folder, so nothing is lost.
 *
 * The folder comes back whenever something uses it (`restoreChatFolder` in `chatFolderRestore.ts`): a provider
 * session, a terminal, a file read, an editor, a move into a project. Listing an old chat's files
 * does not bring it back; a removed chat folder lists as empty (`isRemovedChatFolder`).
 *
 * Removal runs inside the exclusive storage lifecycle lock, after checking that no path use lease,
 * live provider session, terminal, editor pin or pending turn holds the folder. Every user takes
 * its lease (or, for terminals, its admission) before it restores the folder, so a folder in use
 * is never removed and a removed one is back before it is used.
 *
 * Only folders Ryco allocated for the chat (by name), strictly inside the current chats root, are
 * ever removed: chats left behind in an earlier chats root keep theirs.
 *
 * @module ChatFolderCleanup
 */
import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

import { Duration, Effect } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";

import type { ProviderSessionDirectoryShape } from "../provider/Services/ProviderSessionDirectory.ts";
import type { ServerSettingsShape } from "../serverSettings.ts";
import {
  canonicalStoragePath,
  hasWorktreeCreationLease,
  isStoragePathBlocked,
  storageLifecycleLock,
} from "../storage/lifecycle.ts";
import type { TerminalManagerShape } from "../terminal/Services/Manager.ts";
import { containsPath } from "../workspace/checkoutInspection.ts";
import { isChatFolderNameOf } from "./chatFolderNames.ts";
import { isMissingPath } from "./chatFolderRestore.ts";
import type { ChatFoldersShape } from "./chatFolders.ts";

/** How often the sweep looks for idle chats; days-long thresholds need no finer grain. */
export const CHAT_FOLDER_CLEANUP_INTERVAL = Duration.hours(1);
/** Finder writes this into every folder it shows; it alone does not make a folder used. */
const IGNORED_ENTRIES: ReadonlySet<string> = new Set([".DS_Store"]);

export interface ChatFolderCleanupDependencies {
  readonly sql: SqlClient.SqlClient;
  readonly settings: Pick<ServerSettingsShape, "getSettings">;
  readonly chatFolders: Pick<ChatFoldersShape, "isInsideChatsRoot">;
  /** A provider runtime that is not stopped still owns its working directory. */
  readonly sessionDirectory: Pick<ProviderSessionDirectoryShape, "listBindings">;
  readonly terminals: Pick<TerminalManagerShape, "listDiagnostics">;
  readonly now?: () => Date;
}

export interface ChatFolderCleanupSweep {
  /** Chats idle past the setting whose folder still exists. */
  readonly candidates: number;
  readonly removed: number;
  /** Not empty, in use, or not a folder Ryco may remove. */
  readonly kept: number;
}

interface IdleChat {
  readonly projectId: string;
  readonly workspaceRoot: string;
}

/** Neither the chat nor any of its threads changed since `cutoff`. */
const listIdleChats = (sql: SqlClient.SqlClient, cutoff: string) =>
  sql<IdleChat>`
    SELECT projects.project_id AS "projectId", projects.workspace_root AS "workspaceRoot"
    FROM projection_projects AS projects
    WHERE projects.kind = 'chat'
      AND projects.deleted_at IS NULL
      AND projects.updated_at < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM projection_threads AS threads
        WHERE threads.project_id = projects.project_id AND threads.updated_at >= ${cutoff}
      )
    ORDER BY projects.updated_at ASC, projects.project_id ASC
  `;

/** The folder's entries when it holds nothing but {@link IGNORED_ENTRIES}, else null. */
const emptyFolderEntries = async (folder: string): Promise<ReadonlyArray<string> | null> => {
  const stats = await lstat(folder).catch(() => null);
  if (stats === null || !stats.isDirectory()) return null;
  const entries = await readdir(folder);
  return entries.every((entry) => IGNORED_ENTRIES.has(entry)) ? entries : null;
};

/**
 * Remove the empty folder of every chat idle for the configured number of days, keeping any folder
 * something still uses. Off when the setting is null. A folder that cannot be judged is kept and
 * judged again by the next sweep.
 */
export const removeIdleChatFolders = Effect.fn("removeIdleChatFolders")(function* (
  deps: ChatFolderCleanupDependencies,
) {
  const days = (yield* deps.settings.getSettings).chatFolderCleanupAfterDays;
  if (days === null) return { candidates: 0, removed: 0, kept: 0 } satisfies ChatFolderCleanupSweep;
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const cutoff = new Date(nowMs - Duration.toMillis(Duration.days(days))).toISOString();
  const { sql } = deps;

  /** Still idle, with no turn, provider intent or restart continuation pending. */
  const stillIdle = (projectId: string) =>
    sql`
      SELECT 1 FROM projection_projects AS projects
      WHERE projects.project_id = ${projectId}
        AND projects.kind = 'chat'
        AND projects.deleted_at IS NULL
        AND projects.updated_at < ${cutoff}
        AND NOT EXISTS (
          SELECT 1 FROM projection_threads AS threads
          WHERE threads.project_id = projects.project_id
            AND (
              threads.updated_at >= ${cutoff}
              OR EXISTS (SELECT 1 FROM projection_turns AS turns
                WHERE turns.thread_id = threads.thread_id AND turns.state IN ('pending', 'running'))
              OR EXISTS (SELECT 1 FROM provider_effect_intents AS intents
                WHERE intents.thread_id = threads.thread_id)
              OR EXISTS (SELECT 1 FROM restart_continuations AS continuations
                WHERE continuations.thread_id = threads.thread_id AND continuations.status = 'pending')
            )
        )
    `.pipe(Effect.map((rows) => rows.length > 0));

  /** A provider runtime, terminal or editor pin still holds the folder or one of its threads. */
  const heldByRuntime = (projectId: string, canonical: string, folder: string) =>
    Effect.gen(function* () {
      const threads = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId" FROM projection_threads WHERE project_id = ${projectId}
      `;
      const threadIds = new Set(threads.map((thread) => thread.threadId));
      const bindings = yield* deps.sessionDirectory.listBindings();
      if (
        bindings.some((binding) => threadIds.has(binding.threadId) && binding.status !== "stopped")
      ) {
        return true;
      }
      const terminals = yield* deps.terminals.listDiagnostics;
      const inFolder = (candidate: string) =>
        containsPath(folder, candidate) || containsPath(canonical, candidate);
      if (
        terminals.some(
          (terminal) =>
            (terminal.pid !== null ||
              terminal.status === "running" ||
              terminal.status === "starting") &&
            (threadIds.has(terminal.threadId) || inFolder(terminal.cwd)),
        )
      ) {
        return true;
      }
      // An external editor the user opened on the folder keeps it (`clientWorkspaceUse.ts`).
      const pins = yield* sql<{ readonly path: string }>`
        SELECT path FROM managed_worktree_editor_pins
      `;
      return pins.some((pin) => inFolder(pin.path) || containsPath(pin.path, canonical));
    });

  /** Under the exclusive admission lock: every check, then the removal itself. */
  const removeIfUnused = (chat: IdleChat, entries: ReadonlyArray<string>) =>
    storageLifecycleLock.withPermit(
      Effect.gen(function* () {
        const folder = chat.workspaceRoot;
        const canonical = yield* Effect.tryPromise(() => canonicalStoragePath(folder));
        if (hasWorktreeCreationLease(canonical)) return false;
        if (yield* isStoragePathBlocked(sql, canonical)) return false;
        if (!(yield* stillIdle(chat.projectId))) return false;
        if (yield* heldByRuntime(chat.projectId, canonical, folder)) return false;
        return yield* Effect.tryPromise(async () => {
          for (const entry of entries) await unlink(path.join(folder, entry));
          // `rmdir` refuses a folder that gained an entry meanwhile, so nothing written is lost.
          await rmdir(folder);
          return true;
        });
      }),
    );

  const chats = yield* listIdleChats(sql, cutoff);
  let candidates = 0;
  let removed = 0;
  let kept = 0;
  for (const chat of chats) {
    const entries = yield* Effect.tryPromise(() => emptyFolderEntries(chat.workspaceRoot)).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (entries === null) {
      // Missing (already removed) folders are not candidates; anything else here is kept.
      const missing = yield* Effect.tryPromise(() => isMissingPath(chat.workspaceRoot)).pipe(
        Effect.orElseSucceed(() => false),
      );
      if (!missing) {
        candidates += 1;
        kept += 1;
      }
      continue;
    }
    candidates += 1;
    const removable =
      isChatFolderNameOf(chat.workspaceRoot, chat.projectId) &&
      (yield* deps.chatFolders.isInsideChatsRoot(chat.workspaceRoot));
    const didRemove =
      removable &&
      (yield* removeIfUnused(chat, entries).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("kept an empty chat folder", {
            folder: chat.workspaceRoot,
            cause: String(cause),
          }).pipe(Effect.as(false)),
        ),
      ));
    if (didRemove) removed += 1;
    else kept += 1;
  }
  const sweep: ChatFolderCleanupSweep = { candidates, removed, kept };
  yield* removed > 0
    ? Effect.logInfo("removed empty chat folders", { ...sweep, days })
    : Effect.logDebug("no empty chat folders to remove", { ...sweep, days });
  return sweep;
});
