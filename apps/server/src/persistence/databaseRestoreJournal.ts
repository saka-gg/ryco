/**
 * Where an in-place database restore (`ryco db restore --replace`, databaseRestoreSwap.ts) keeps
 * its journal. Opening the database checks for it first: a journal that is still there means a
 * swap was interrupted, and the swap is finished before anything opens the database. This module
 * stays tiny because that check is on every startup; the swap itself loads only when a journal
 * exists.
 *
 * @module databaseRestoreJournal
 */

/** The journal of an in-place restore of the database at `dbPath`, next to it. */
export const databaseRestoreJournalPath = (dbPath: string): string => `${dbPath}.restore.json`;
