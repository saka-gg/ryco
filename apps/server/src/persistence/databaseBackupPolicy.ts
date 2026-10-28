/**
 * The part of the database backups that every startup needs: where backups live, whether they
 * are on, and whether this upgrade needs one. It stays small and static so that startup with
 * nothing to migrate never loads databaseBackups.ts (~30 KB): the persistence layer imports it
 * when a backup is due, and otherwise only for the background pass 30 s after boot.
 *
 * @module databaseBackupPolicy
 */
import { dirname, join } from "node:path";

import { Config, Duration, Effect, Option } from "effect";

import { isUpgradePending, type MigrationLedgerInspection } from "./Migrations.ts";

/** Phase 2 waits this long after startup, out of boot and hydration. */
export const BACKUP_FINALIZE_DELAY = Duration.seconds(30);

export type PremigrationBackupMode = "auto" | "always" | "off";

/** Where backups of `dbPath` live: next to it, in `backups/`. */
export const databaseBackupsDirectory = (dbPath: string) => join(dirname(dbPath), "backups");

/** `RYCO_PREMIGRATION_BACKUP`: `auto` (default), `always` (no size limit) or `off`. */
export const readPremigrationBackupMode = Effect.gen(function* () {
  const configured = yield* Config.String("RYCO_PREMIGRATION_BACKUP").pipe(
    Config.option,
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const value = Option.getOrElse(configured, () => "")
    .trim()
    .toLowerCase();
  if (value === "" || value === "auto") return "auto" as PremigrationBackupMode;
  if (value === "always" || value === "off") return value as PremigrationBackupMode;
  yield* Effect.logWarning(
    `Ignoring RYCO_PREMIGRATION_BACKUP=${value}: expected auto, always or off. Using auto.`,
  );
  return "auto" as PremigrationBackupMode;
});

/** An existing database that the next migration pass will change. */
export const needsPremigrationBackup = (ledger: MigrationLedgerInspection) =>
  !ledger.fresh && !ledger.tooNew && isUpgradePending(ledger);
