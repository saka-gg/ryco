/**
 * databaseBackupList - the database backups Storage settings lists, and their removal.
 *
 * Every upgrade keeps a backup of the database before its migrations (the newest three of each
 * kind, `databaseBackups.ts`); on a large database they add up to gigabytes. Storage settings
 * lists each one with its size, and removes one only when the owner clicks it: nothing here runs
 * on its own. A backup is named by its file name in the backups folder and found again in a fresh
 * listing, so a request can never name another file. A backup still being written or compressed
 * (a raw file) is refused, and a removal takes its raw and compressed twins together.
 *
 * Loaded on first use (`import()` from `StorageService.ts`), so the backup code stays off the
 * server's boot path.
 *
 * @module databaseBackupList
 */
import { rm } from "node:fs/promises";

import type { DatabaseBackupSummary } from "@ryco/contracts";
import { Effect } from "effect";

import { type DatabaseBackup, listDatabaseBackups } from "../persistence/databaseBackups.ts";

/** One backup and the files that hold it (a raw file and its compressed twin are one). */
const groupBackups = (backups: ReadonlyArray<DatabaseBackup>) => {
  const groups = new Map<string, DatabaseBackup[]>();
  for (const backup of backups) {
    const key = `${backup.kind}:${backup.from}:${backup.to}:${backup.createdAt}:${backup.seq}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [backup]);
    else group.push(backup);
  }
  // Newest first, as listed; each group's finished file first.
  return [...groups.values()];
};

/** The database's backups, newest first. */
export const listDatabaseBackupSummaries = (dbPath: string) =>
  listDatabaseBackups(dbPath).pipe(
    Effect.map((backups) =>
      groupBackups(backups).map((files, index): DatabaseBackupSummary => ({
        name: files[0]!.name,
        kind: files[0]!.kind,
        fromSchema: files[0]!.from,
        toSchema: files[0]!.to,
        createdAt: new Date(files[0]!.createdAt).toISOString(),
        bytes: files.reduce((sum, file) => sum + file.bytes, 0),
        newest: index === 0,
      })),
    ),
  );

export type RemoveDatabaseBackupOutcome =
  | { readonly kind: "removed"; readonly freedBytes: number }
  | { readonly kind: "refused"; readonly detail: string };

/** Removes the backup listed as `name` (all its files), when it is finished. */
export const removeDatabaseBackup = (dbPath: string, name: string) =>
  Effect.gen(function* () {
    const groups = groupBackups(yield* listDatabaseBackups(dbPath));
    const files = groups.find((group) => group.some((file) => file.name === name));
    if (files === undefined) {
      return {
        kind: "refused",
        detail: "This backup is no longer there. Scan again.",
      } satisfies RemoveDatabaseBackupOutcome;
    }
    if (files.every((file) => file.state === "raw")) {
      return {
        kind: "refused",
        detail: "This backup is still being checked and compressed. Try again in a few minutes.",
      } satisfies RemoveDatabaseBackupOutcome;
    }
    let freedBytes = 0;
    for (const file of files) {
      yield* Effect.tryPromise(() => rm(file.path, { force: true }));
      freedBytes += file.bytes;
    }
    return { kind: "removed", freedBytes } satisfies RemoveDatabaseBackupOutcome;
  });
