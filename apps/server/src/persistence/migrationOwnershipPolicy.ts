/**
 * migrationOwnershipPolicy - A CLI never migrates a database a live server owns.
 *
 * Every process that builds the persistence layer used to run the migrations
 * and repairs itself, so a newer `ryco` CLI next to an older running desktop
 * app upgraded the schema under it. Now only the database's owner migrates:
 *
 * - The server owning the database (its {@link DatabaseOwnerLease}) migrates as
 *   before.
 * - Any other process first reads what an upgrade would change: pending
 *   numbered migrations, or compatibility repairs this database has never
 *   recorded; on a database without any record (last run by a release from
 *   before them), only those whose effect is missing (`inspectMigrationLedger`,
 *   `isUpgradePending`; nothing runs). Nothing to do: it skips the ledger pass
 *   and the repairs.
 * - Something to do and nobody owns the database: it takes maintenance
 *   ownership for the migration, so a server starting meanwhile waits for it.
 * - Something to do and a live process owns the database: it waits up to 30 s
 *   when that owner runs the same schema code (it is upgrading right now), and
 *   otherwise refuses with {@link DatabaseUpgradeBlockedError}.
 *
 * Only migrating is gated; opening, reading and the ordinary writes of CLI
 * commands work while a server runs. `migrate` takes the pre-upgrade backup
 * too (Layers/Sqlite.ts), so a process that may not migrate never takes one.
 *
 * @module migrationOwnershipPolicy
 */
import { Clock, Effect, Option } from "effect";

import packageJson from "../../package.json" with { type: "json" };
import { databaseBackupsDirectory } from "./databaseBackupPolicy.ts";
import {
  acquireDatabaseMaintenance,
  type DatabaseOwner,
  DatabaseOwnerLease,
  DatabaseUpgradeBlockedError,
  describeDatabaseOwner,
  isDatabaseOwnerLockDisabled,
  probeDatabaseOwnerSettled,
} from "./databaseOwnerLock.ts";
import {
  describeRepairKeys,
  failIfSchemaTooNew,
  inspectMigrationLedger,
  isUpgradePending,
  type MigrationLedgerInspection,
  migrationSchemaDigest,
} from "./Migrations.ts";

/** How long a CLI waits for a maintenance owner (another CLI migrating). */
export const CLI_MAINTENANCE_WAIT_MS = 30_000;
/** How long a CLI waits for an owner with the same schema code to finish its upgrade. */
export const SAME_SCHEMA_OWNER_UPGRADE_WAIT_MS = 30_000;
const UPGRADE_POLL_MS = 250;

export interface SchemaUpgrade {
  /** Pending migrations, and the repairs (`repairsPending`) this database has never recorded. */
  readonly ledger: MigrationLedgerInspection;
  readonly needed: boolean;
}

/**
 * Read-only: what this binary would change in the database at `dbPath`. Fails when the schema
 * is too new, naming its backups directory.
 */
export const inspectSchemaUpgrade = (dbPath: string) =>
  Effect.gen(function* () {
    const ledger = yield* inspectMigrationLedger();
    yield* failIfSchemaTooNew(ledger, databaseBackupsDirectory(dbPath));
    return { ledger, needed: isUpgradePending(ledger) } satisfies SchemaUpgrade;
  });

const describeUpgrade = (upgrade: SchemaUpgrade) =>
  upgrade.ledger.pending.length > 0
    ? upgrade.ledger.latestApplied === 0
      ? `create the database schema (${upgrade.ledger.supported})`
      : `upgrade the database from schema ${upgrade.ledger.latestApplied} to ${upgrade.ledger.supported}`
    : `repair the database schema (${describeRepairKeys(upgrade.ledger.repairsPending)})`;

const restartHint = (owner: DatabaseOwner) => {
  if (owner.legacy) return "quit it and start the updated Ryco";
  switch (owner.launcher) {
    case "desktop":
      return "reopen the desktop app";
    case "service":
      return "`ryco service restart`";
    case "serve":
      return "restart `ryco serve`";
    case "cli":
    case "unknown":
      return "restart it";
  }
};

export function describeUpgradeBlocked(input: {
  readonly owner: DatabaseOwner | null;
  readonly upgrade: SchemaUpgrade;
  readonly ownerError?: string | undefined;
  readonly nowMs?: number | undefined;
}): string {
  const ours = `This ryco (${packageJson.version}) needs to ${describeUpgrade(input.upgrade)}`;
  const owner = input.owner;
  if (owner === null) {
    return `${ours}, but cannot tell whether a Ryco server is using it: ${input.ownerError ?? "its owner lock could not be read"} Ryco never upgrades a database that a server may be using.`;
  }
  const holder = describeDatabaseOwner(owner, input.nowMs);
  if (owner.kind === "maintenance") {
    return `${ours}, but another process is upgrading or repairing it right now (${holder}). Wait for it to finish, then run this command again.`;
  }
  if (!owner.legacy && owner.schemaDigest === migrationSchemaDigest) {
    return `${ours}, but ${holder} is using it and has not finished upgrading it. Wait until it has started, then run this command again.`;
  }
  return `${ours}, but ${holder} is using it, and Ryco never upgrades a database under a running server. Update and restart that server first (${restartHint(owner)}), or quit it and run this command again.`;
}

/**
 * Run `migrate` only if this process may: see the module comment. `migrate`
 * runs at most once, and is where the pre-upgrade backup belongs, so a process
 * that is refused, or that waits for its owner to upgrade, takes none.
 * `finalize` tells it whether it runs in the database's long-lived owner (a
 * server), which may start background work that outlives the migration (the
 * pre-upgrade backup's verification and compression); a CLI migrating under
 * maintenance ownership gets false and leaves that to the next server.
 *
 * A process holding maintenance ownership that wants to migrate through the
 * persistence layer provides its lease as {@link DatabaseOwnerLease}.
 */
export const migrateUnderOwnershipPolicy = <A, E, R>(
  dbPath: string,
  migrate: (options: { readonly finalize: boolean }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    if (yield* isDatabaseOwnerLockDisabled) {
      yield* migrate({ finalize: true });
      return;
    }
    const lease = yield* Effect.serviceOption(DatabaseOwnerLease);
    if (Option.isSome(lease) && lease.value.dbPath === dbPath) {
      yield* migrate({ finalize: true });
      return;
    }

    // A lock being written is read again for a moment: its writer may give it up.
    const probed = yield* probeDatabaseOwnerSettled(dbPath).pipe(
      Effect.map((ownership) =>
        ownership.state === "owned"
          ? { owner: ownership.owner, ownerError: undefined, free: false }
          : { owner: null, ownerError: undefined, free: true },
      ),
      // A lock that cannot be judged may be a live server's: never migrate under it.
      Effect.catchTag("DatabaseOwnerLockError", (error) =>
        Effect.succeed({ owner: null, ownerError: error.message, free: false }),
      ),
    );
    if (probed.owner?.self === true && probed.owner.kind === "server") {
      yield* migrate({ finalize: true });
      return;
    }

    const upgrade = yield* inspectSchemaUpgrade(dbPath);
    // Nothing would change: skip the ledger pass and the repairs (an owner ran them).
    if (!upgrade.needed) return;

    let owner = probed.owner;
    let ownerError = probed.ownerError;
    if (probed.free) {
      const taken = yield* Effect.scoped(
        Effect.gen(function* () {
          const refused = yield* acquireDatabaseMaintenance(dbPath, "cli-migration", {
            waitMs: CLI_MAINTENANCE_WAIT_MS,
          }).pipe(
            Effect.as(null),
            // A server took the database first: it migrates, not this process.
            Effect.catch((error) => Effect.succeed(error)),
          );
          if (refused !== null) return refused;
          // Another process may have migrated while this one waited.
          if ((yield* inspectSchemaUpgrade(dbPath)).needed) yield* migrate({ finalize: false });
          return null;
        }),
      );
      if (taken === null) return;
      owner = taken.owner;
      ownerError = taken.owner === null ? taken.message : undefined;
    }

    yield* waitForOwnerUpgrade({ dbPath, owner, ownerError });
  });

/**
 * An owner running this binary's schema code finishes the upgrade itself
 * (it holds the database while it migrates): wait for that. Any other owner
 * never will, so refuse, unless the database no longer needs the upgrade: this
 * process may have waited for maintenance ownership before it got here, and
 * whoever held the database meanwhile may have done it.
 */
const waitForOwnerUpgrade = (input: {
  readonly dbPath: string;
  readonly owner: DatabaseOwner | null;
  readonly ownerError: string | undefined;
}) =>
  Effect.gen(function* () {
    const { owner } = input;
    if (owner !== null && !owner.legacy && owner.schemaDigest === migrationSchemaDigest) {
      yield* Effect.logInfo(
        `Waiting for ${describeDatabaseOwner(owner)} to finish upgrading the database`,
      );
      const startedMs = yield* Clock.currentTimeMillis;
      while ((yield* Clock.currentTimeMillis) - startedMs < SAME_SCHEMA_OWNER_UPGRADE_WAIT_MS) {
        yield* Effect.sleep(UPGRADE_POLL_MS);
        if (!(yield* inspectSchemaUpgrade(input.dbPath)).needed) return;
      }
    }
    const upgrade = yield* inspectSchemaUpgrade(input.dbPath);
    if (!upgrade.needed) return;
    return yield* Effect.fail(
      new DatabaseUpgradeBlockedError({
        owner,
        from: upgrade.ledger.latestApplied,
        to: upgrade.ledger.supported,
        repairs: upgrade.ledger.repairsPending,
        message: describeUpgradeBlocked({ owner, upgrade, ownerError: input.ownerError }),
      }),
    );
  });
