/**
 * DatabaseDoctor - `ryco doctor`: check the node's database, and with `--apply` remove all
 * superseded history and shrink the file, offline.
 *
 * `inspectDatabase` (the default) only reads: it opens the database read-only, so it is safe
 * while a server runs, and reports sizes, schema, compaction progress, the owner, free disk and
 * the plan `--apply` would follow.
 *
 * `repairDatabase` (`--apply`):
 *
 * 1. Ownership: this data directory's `ryco service` is stopped (and started again at the end);
 *    any other owner (the desktop app, a `ryco serve`, a maintenance run) is a refusal with what
 *    to do. Then maintenance ownership of the database owner lock.
 * 2. SQLite's exclusive lock on the doctor's own connection, held until just before the swap:
 *    refused while any other connection has the database open (an older Ryco that predates the
 *    owner lock, a SQLite tool).
 * 3. Checks: `quick_check` (`--thorough`: `integrity_check`), the schema is exactly this
 *    binary's (the doctor never migrates: the app that owns the data might not open it again),
 *    every projector caught up with the log.
 * 4. Free disk on the database's volume for the compacted copy (1.1x plus 256 MiB).
 * 5. Compaction over the whole log from the beginning with an unbounded carry, so what online
 *    passes leave behind goes too (`EventLogCompaction`, `horizon: "head"`), plus old receipts.
 * 6. `VACUUM INTO` a sibling file with `auto_vacuum = INCREMENTAL` (about 1x the compacted size;
 *    in-place `VACUUM` needs about 2x plus temporary space that may be a small tmpfs), checked
 *    with `integrity_check`, row counts of every table and the AUTOINCREMENT marks.
 * 7. The swap: no other process may have `state.sqlite`, `-wal` or `-shm` open (it would keep
 *    the old file and share the new file's WAL, see `fileHolders.ts`), checked before the copy is
 *    written and again before the rename; when that cannot be known the file is not swapped
 *    (history stays removed). The copy takes the database's owner and mode, the connection closes
 *    (removing the WAL), the copy is renamed over the database and the rename made durable.
 *
 * Every step runs in one scope: an interruption or failure closes connections, removes the copy
 * if it was not swapped in, releases ownership and restarts a paused service. The original file
 * stays untouched until the rename.
 *
 * @module DatabaseDoctor
 */
import * as NodePath from "node:path";

import { formatStorageSize } from "@ryco/shared/storageRetention";
import { Data, Effect, Schema, type Scope } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { estimateCompactableBytes } from "../persistence/databaseStorageReport.ts";
import type { DatabaseOwner } from "../persistence/databaseOwnerLock.ts";
import {
  EVENT_COMPACTION_STATE_KEY,
  makeEventLogCompaction,
  ONLINE_COMPACTION_PASS_OPTIONS,
} from "../persistence/Layers/EventLogCompaction.ts";
import { writeLifecycleMarker } from "../persistence/lifecycleMarkers.ts";
import { describeRepairKeys } from "../persistence/Migrations.ts";
import {
  type CompactionProgress,
  CompactionState,
  type EventLogCompactionPassOptions,
} from "../persistence/Services/EventLogCompaction.ts";
import type { NodeServiceStatus } from "../service/nodeService.ts";
import {
  checkIntegrity,
  checkpointTruncate,
  countTableRows,
  type DatabasePages,
  isSchemaCurrent,
  openDoctorConnection,
  openDoctorReadConnection,
  type ProjectionCursors,
  readAutoincrementSequences,
  readDatabasePages,
  readProjectionCursors,
  readSchemaCompatibility,
  type SchemaCompatibility,
  takeExclusiveLock,
  tuneForMaintenance,
  usedBytes,
} from "./doctorDatabase.ts";
import {
  describeOwnerRefusal,
  type DoctorOwnershipControl,
  type DoctorServiceControl,
  isServiceOwner,
  pausedServiceMarkerPath,
  readOwnerEndpoint,
  readPausedServiceMarker,
  removePausedServiceMarker,
  writePausedServiceMarker,
} from "./doctorOwnership.ts";
import { describeFileHolders, type FileHoldersResult } from "./fileHolders.ts";
import {
  doctorCopyPath,
  fileSize,
  prepareCopyForSwap,
  removeDoctorCopy,
  removeFileIfPresent,
  removeStaleDoctorCopies,
  resolveDatabaseFile,
  swapInCopy,
} from "./sqliteSwap.ts";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface DoctorReporter {
  /** A new step. */
  readonly phase: (text: string) => Effect.Effect<void>;
  /** Progress within the current step; `fraction` in [0, 1] when known. */
  readonly progress: (text: string, fraction: number | null) => Effect.Effect<void>;
  /** A line of its own (a warning, what a finalizer did). */
  readonly note: (text: string) => Effect.Effect<void>;
}

export const silentDoctorReporter: DoctorReporter = {
  phase: () => Effect.void,
  progress: () => Effect.void,
  note: () => Effect.void,
};

export interface DoctorPorts {
  readonly ownership: DoctorOwnershipControl;
  readonly service: DoctorServiceControl;
  /** Free bytes on the volume of `directory`; null when the system cannot tell. */
  readonly freeBytes: (directory: string) => Effect.Effect<number | null>;
  readonly fileHolders: (paths: ReadonlyArray<string>) => Effect.Effect<FileHoldersResult>;
  readonly reporter: DoctorReporter;
  readonly pid: number;
  readonly now: () => number;
  /** How long a stopped service may take to release the database. */
  readonly serviceStopTimeoutMs?: number;
  /** Test hook: runs on the compacted copy before it is verified. */
  readonly beforeVerifyCopy?: (copyPath: string) => Effect.Effect<void>;
}

export interface DoctorTarget {
  /** The configured path; the owner lock lives next to it. */
  readonly dbPath: string;
  readonly stateDir: string;
  /** `ryco` or `npx ryco-cli`, for the commands messages suggest. */
  readonly commandPrefix: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The copy needs its size plus this share, and the volume keeps this much on top. */
export const COPY_SPACE_FACTOR = 1.1;
export const SPACE_MARGIN_BYTES = 256 * 1024 * 1024;
/** An incremental database with less free space than this inside is not worth a copy. */
export const ALREADY_COMPACT_FREE_BYTES = 64 * 1024 * 1024;
/** The WAL is truncated after this many deletions, so it never grows past a bounded size. */
export const CHECKPOINT_EVERY_DELETIONS = 50_000;
const SERVICE_STOP_TIMEOUT_MS = 60_000;
const SERVICE_STOP_POLL_MS = 250;

/**
 * Offline: the whole log from the beginning (what online passes leave behind goes too), an
 * unbounded carry, no pauses, large selection windows and delete transactions (no event loop to
 * protect; fewer, larger transactions write each page to the WAL fewer times), and every old
 * receipt.
 */
export const DOCTOR_COMPACTION_PASS_OPTIONS: EventLogCompactionPassOptions = {
  ...ONLINE_COMPACTION_PASS_OPTIONS,
  horizon: "head",
  fromBeginning: true,
  persistState: true,
  maxScanSequences: Number.POSITIVE_INFINITY,
  maxWallMs: Number.POSITIVE_INFINITY,
  selectionPageSequences: 10_000,
  exclusive: true,
  deleteBatch: { initial: 2_000, min: 200, max: 10_000, targetMs: 250 },
  interBatchPauseMs: 0,
  idleRatio: 0,
  carryCapacity: Number.POSITIVE_INFINITY,
  receipts: {
    ...ONLINE_COMPACTION_PASS_OPTIONS.receipts!,
    pageRows: 10_000,
    deleteBatch: 10_000,
    maxScanRows: Number.POSITIVE_INFINITY,
  },
  mode: "delete",
};

export const formatBytes = (bytes: number) => formatStorageSize(Math.max(0, bytes), "complete");

/**
 * The compaction state the doctor leaves, whether its pass finished or not. Its pass starts at
 * sequence 0 and saves its own cursor as it goes, which an interruption would leave below where
 * online passes had already got to; but everything below the further of the two has been
 * examined, so that is the cursor, and also what the Storage estimate divides the removed bytes
 * by. The receipt cursor starts over: the doctor's walk began at 0, and a compacted copy
 * renumbers the receipts' rowids.
 */
export const settledCompactionState = (
  before: CompactionState,
  after: CompactionState,
  headSequence: number,
): CompactionState => {
  // A cursor past the head belongs to another log (`runPass` starts such a one over too).
  const earlier =
    before.compactedThroughSequence > headSequence ? 0 : before.compactedThroughSequence;
  const cursor = Math.max(earlier, Math.min(after.compactedThroughSequence, headSequence));
  return {
    ...after,
    compactedThroughSequence: cursor,
    receiptRowidCursor: 0,
    totals: { ...after.totals, scannedSequences: cursor },
  };
};

/** Free disk the copy needs: the data it will hold, 1.1x, plus a fixed margin. */
export const spaceNeededForCopy = (pages: DatabasePages, removableBytes: number | null): number =>
  Math.ceil(Math.max(0, usedBytes(pages) - Math.max(0, removableBytes ?? 0)) * COPY_SPACE_FACTOR) +
  SPACE_MARGIN_BYTES;

const describeSchemaMismatch = (schema: SchemaCompatibility, commandPrefix: string): string => {
  if (schema.applied > schema.supported) {
    return `The database has schema ${schema.applied}, newer than this ryco supports (${schema.supported}). Run the doctor from the same Ryco version as the app that uses this data directory (\`npx ryco-cli@<version> doctor\`).`;
  }
  if (schema.applied < schema.supported || schema.pendingMigrations.length > 0) {
    return `The database has schema ${schema.applied}; this ryco expects ${schema.supported}. The doctor never upgrades a database: start the Ryco version that uses this data directory once, or run the doctor from that version (\`npx ryco-cli@<version> doctor\`).`;
  }
  return `The database still needs compatibility repairs (${describeRepairKeys(schema.repairs)}) that this ryco runs when it starts. Start Ryco once on this data directory, stop it, then run \`${commandPrefix} doctor --apply\` again.`;
};

const describeLagging = (cursors: ProjectionCursors, commandPrefix: string): string =>
  `Some projections are behind the event log (${cursors.lagging
    .map((cursor) => `${cursor.projector} at ${cursor.sequence} of ${cursors.headSequence}`)
    .join(
      ", ",
    )}). Start Ryco once so it catches them up, stop it, then run \`${commandPrefix} doctor --apply\` again.`;

// ---------------------------------------------------------------------------
// Inspect
// ---------------------------------------------------------------------------

export type DoctorOwnerReport =
  | { readonly state: "free" }
  | {
      readonly state: "owned";
      readonly owner: DatabaseOwner;
      /** This data directory's service: `--apply` stops it and starts it again. */
      readonly service: boolean;
      readonly endpoint: string | null;
    }
  | { readonly state: "unknown"; readonly message: string };

export interface DoctorInspection {
  readonly dbPath: string;
  readonly exists: boolean;
  readonly fileBytes: number;
  readonly walBytes: number;
  readonly pages: DatabasePages | null;
  readonly schema: SchemaCompatibility | null;
  readonly projections: ProjectionCursors | null;
  readonly compaction: {
    readonly headSequence: number;
    readonly compactedThroughSequence: number;
    readonly removedEvents: number;
    readonly removedBytes: number;
    /** Bytes of superseded history still in the log: estimated, or counted with `--estimate`. */
    readonly removableBytes: number | null;
    /** Counted with `--estimate` only. */
    readonly removableEvents: number | null;
    readonly removableReceipts: number | null;
    readonly exact: boolean;
  } | null;
  readonly owner: DoctorOwnerReport;
  readonly service: {
    readonly label: string;
    readonly installed: boolean;
    readonly running: boolean;
    readonly pid: number | null;
  } | null;
  readonly disk: { readonly freeBytes: number | null; readonly neededBytes: number | null };
  /** An upper bound: removed payload bytes undercount what removing a row frees. */
  readonly estimatedBytesAfter: number | null;
  /** Why `--apply` would refuse right away (it re-checks everything under its locks). */
  readonly blockers: ReadonlyArray<string>;
  /** What `--apply` would do, in order. */
  readonly plan: ReadonlyArray<string>;
}

class DoctorReadError extends Data.TaggedError("DoctorReadError")<{ readonly message: string }> {}

const readOwnerReport = (
  target: DoctorTarget,
  ports: DoctorPorts,
  status: NodeServiceStatus | null,
): Effect.Effect<DoctorOwnerReport> =>
  ports.ownership.probe(target.dbPath).pipe(
    Effect.flatMap((ownership) =>
      ownership.state === "free"
        ? Effect.succeed<DoctorOwnerReport>({ state: "free" })
        : readOwnerEndpoint(target.stateDir, ownership.owner).pipe(
            Effect.map((endpoint): DoctorOwnerReport => ({
              state: "owned",
              owner: ownership.owner,
              service: isServiceOwner(ownership.owner, status),
              endpoint,
            })),
          ),
    ),
    Effect.catch((error) =>
      Effect.succeed<DoctorOwnerReport>({ state: "unknown", message: error.message }),
    ),
  );

export const inspectDatabase = (
  target: DoctorTarget,
  options: { readonly estimate: boolean },
  ports: DoctorPorts,
): Effect.Effect<DoctorInspection> =>
  Effect.gen(function* () {
    const databaseFile = yield* Effect.promise(() => resolveDatabaseFile(target.dbPath));
    const fileBytes = yield* Effect.promise(() => fileSize(databaseFile));
    const walBytes = yield* Effect.promise(() => fileSize(`${databaseFile}-wal`));
    const status = yield* ports.service.status;
    const service =
      status === null
        ? null
        : {
            label: status.label,
            installed: status.installed,
            running: status.running,
            pid: status.pid,
          };
    const owner = yield* readOwnerReport(target, ports, status);
    const freeBytes = yield* ports.freeBytes(NodePath.dirname(databaseFile));
    const exists = fileBytes > 0;
    if (!exists) {
      return {
        dbPath: databaseFile,
        exists,
        fileBytes,
        walBytes,
        pages: null,
        schema: null,
        projections: null,
        compaction: null,
        owner,
        service,
        disk: { freeBytes, neededBytes: null },
        estimatedBytesAfter: null,
        blockers: [`There is no database at ${databaseFile}.`],
        plan: [],
      } satisfies DoctorInspection;
    }

    const read = yield* Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* openDoctorReadConnection(databaseFile);
        return yield* Effect.gen(function* () {
          const pages = yield* readDatabasePages;
          const schema = yield* readSchemaCompatibility;
          const projections = isSchemaCurrent(schema) ? yield* readProjectionCursors : null;
          if (!isSchemaCurrent(schema)) return { pages, schema, projections, compaction: null };
          const compaction = yield* makeEventLogCompaction;
          const state = yield* compaction.readState("delete");
          const headSequence = projections?.headSequence ?? 0;
          let removableBytes = estimateCompactableBytes(state, headSequence);
          let removableEvents: number | null = null;
          let removableReceipts: number | null = null;
          if (options.estimate) {
            yield* ports.reporter.phase("Counting superseded history (reads the whole log)");
            const counted = yield* compaction.runPass({
              ...DOCTOR_COMPACTION_PASS_OPTIONS,
              mode: "dry-run",
              persistState: false,
              onProgress: (progress) => reportCompactionProgress(ports.reporter, progress, "found"),
            });
            removableBytes = counted.deletedBytes;
            removableEvents = counted.deletedEvents;
            removableReceipts = counted.deletedReceipts;
          }
          return {
            pages,
            schema,
            projections,
            compaction: {
              headSequence,
              compactedThroughSequence: Math.min(state.compactedThroughSequence, headSequence),
              removedEvents: state.totals.deletedEvents,
              removedBytes: state.totals.deletedBytes,
              removableBytes,
              removableEvents,
              removableReceipts,
              exact: options.estimate,
            },
          };
        }).pipe(Effect.provideService(SqlClient.SqlClient, connection.sql));
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new DoctorReadError({ message: `Ryco cannot read ${databaseFile}: ${cause.message}` }),
      ),
      Effect.result,
    );

    if (read._tag === "Failure") {
      return {
        dbPath: databaseFile,
        exists,
        fileBytes,
        walBytes,
        pages: null,
        schema: null,
        projections: null,
        compaction: null,
        owner,
        service,
        disk: { freeBytes, neededBytes: null },
        estimatedBytesAfter: null,
        blockers: [read.failure.message],
        plan: [],
      } satisfies DoctorInspection;
    }
    const { pages, schema, projections, compaction } = read.success;
    const removable = compaction?.removableBytes ?? null;
    const neededBytes = spaceNeededForCopy(pages, removable);
    const blockers: Array<string> = [];
    if (!isSchemaCurrent(schema))
      blockers.push(describeSchemaMismatch(schema, target.commandPrefix));
    if (projections !== null && projections.lagging.length > 0) {
      blockers.push(describeLagging(projections, target.commandPrefix));
    }
    if (owner.state === "unknown") blockers.push(owner.message);
    if (owner.state === "owned" && !owner.service) {
      blockers.push(
        describeOwnerRefusal({
          owner: owner.owner,
          endpoint: owner.endpoint,
          commandPrefix: target.commandPrefix,
        }),
      );
    }
    if (freeBytes !== null && freeBytes < neededBytes) {
      blockers.push(
        `The compacted copy needs about ${formatBytes(neededBytes)} free on this volume; ${formatBytes(freeBytes)} is available. Free some space first.`,
      );
    }
    const serviceLabel = service?.label ?? ports.service.label;
    const plan = [
      ...(owner.state === "owned" && owner.service
        ? [`Stop the background service ${serviceLabel} and start it again at the end.`]
        : []),
      "Take ownership of the database and SQLite's exclusive lock (nothing else may have it open).",
      "Check it (quick_check), its schema and its projections.",
      "Remove all superseded progress history, not only what is a day old, and old command receipts.",
      "Write a compacted copy with automatic shrinking on, check it (integrity_check) and swap it in.",
    ];
    return {
      dbPath: databaseFile,
      exists,
      fileBytes,
      walBytes,
      pages,
      schema,
      projections,
      compaction,
      owner,
      service,
      disk: { freeBytes, neededBytes },
      estimatedBytesAfter: Math.max(pages.pageSize, usedBytes(pages) - Math.max(0, removable ?? 0)),
      blockers,
      plan,
    } satisfies DoctorInspection;
  });

const reportCompactionProgress = (
  reporter: DoctorReporter,
  progress: CompactionProgress,
  verb: "removed" | "found",
) =>
  reporter.progress(
    `scanned ${progress.compactedThroughSequence.toLocaleString("en-US")} of ${progress.horizonSequence.toLocaleString("en-US")} events, ${verb} ${progress.deletedEvents.toLocaleString("en-US")} (${formatBytes(progress.deletedBytes)})`,
    progress.horizonSequence > 0
      ? progress.compactedThroughSequence / progress.horizonSequence
      : null,
  );

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

export type DoctorRepairStatus =
  /** Compacted and shrunk. */
  | "repaired"
  /** History removed; the file was not swapped (no room, or other processes have it open). */
  | "compacted"
  /** Nothing to shrink: an incremental database with little free space after compaction. */
  | "already-compact"
  /** Nothing changed: a precondition did not hold. */
  | "refused"
  /** Something failed midway; the original file is intact unless `swapped`. */
  | "failed";

export interface DoctorRepairResult {
  readonly status: DoctorRepairStatus;
  /** 0 done (also with warnings), 1 failure, 2 refused. */
  readonly exitCode: 0 | 1 | 2;
  readonly message: string;
  readonly dbPath: string;
  readonly before: { readonly fileBytes: number; readonly pages: DatabasePages | null } | null;
  readonly after: { readonly fileBytes: number; readonly pages: DatabasePages } | null;
  readonly removedEvents: number;
  readonly removedBytes: number;
  readonly removedReceipts: number;
  readonly swapped: boolean;
  readonly serviceRestarted: boolean;
  readonly durationsMs: Readonly<Record<string, number>>;
  readonly notes: ReadonlyArray<string>;
}

/** Ends the run early with a result (refusals, failures, and "done, but not shrunk"). */
class DoctorStop extends Data.TaggedError("DoctorStop")<{
  readonly status: DoctorRepairStatus;
  readonly exitCode: 0 | 1 | 2;
  readonly message: string;
}> {}

const refuse = (message: string) => new DoctorStop({ status: "refused", exitCode: 2, message });
const fail = (message: string) => new DoctorStop({ status: "failed", exitCode: 1, message });

/** What the run did so far; read by finalizers and by the result. */
interface RepairProgress {
  databaseFile: string;
  before: DoctorRepairResult["before"];
  after: DoctorRepairResult["after"];
  removedEvents: number;
  removedBytes: number;
  removedReceipts: number;
  swapped: boolean;
  /** The service this run (or an interrupted earlier one) stopped, to start again. */
  pausedService: string | null;
  serviceRestarted: boolean;
  durationsMs: Record<string, number>;
  notes: Array<string>;
}

const encodeCompactionState = Schema.encodeSync(Schema.fromJsonString(CompactionState));

export interface DoctorRepairOptions {
  readonly thorough: boolean;
  /** Start a service this run stopped again at the end (`--no-restart-service`: false). */
  readonly restartService: boolean;
}

export const repairDatabase = (
  target: DoctorTarget,
  options: DoctorRepairOptions,
  ports: DoctorPorts,
): Effect.Effect<DoctorRepairResult> =>
  Effect.gen(function* () {
    const progress: RepairProgress = {
      databaseFile: target.dbPath,
      before: null,
      after: null,
      removedEvents: 0,
      removedBytes: 0,
      removedReceipts: 0,
      swapped: false,
      pausedService: null,
      serviceRestarted: false,
      durationsMs: {},
      notes: [],
    };
    const exit = yield* Effect.exit(
      Effect.scoped(
        repairSteps(target, options, ports, progress).pipe(
          // Before the finalizers (copy removal, ownership, service restart) report their part.
          Effect.onInterrupt(() =>
            note(
              ports,
              progress,
              progress.swapped
                ? "Interrupted after the compacted copy was swapped in."
                : progress.removedEvents > 0
                  ? `Interrupted after removing ${progress.removedEvents.toLocaleString("en-US")} superseded events; the file was not shrunk. Run the doctor again to finish.`
                  : "Interrupted; the database file was not replaced.",
            ),
          ),
        ),
      ),
    );
    const result = (
      status: DoctorRepairStatus,
      exitCode: 0 | 1 | 2,
      message: string,
    ): DoctorRepairResult => ({
      status,
      exitCode,
      message,
      dbPath: progress.databaseFile,
      before: progress.before,
      after: progress.after,
      removedEvents: progress.removedEvents,
      removedBytes: progress.removedBytes,
      removedReceipts: progress.removedReceipts,
      swapped: progress.swapped,
      serviceRestarted: progress.serviceRestarted,
      durationsMs: progress.durationsMs,
      notes: progress.notes,
    });
    if (exit._tag === "Success") return result(exit.value.status, 0, exit.value.message);
    const stop = exit.cause.reasons.find((reason) => reason._tag === "Fail");
    if (stop !== undefined && stop._tag === "Fail") {
      return result(stop.error.status, stop.error.exitCode, stop.error.message);
    }
    const defect = exit.cause.reasons.find((reason) => reason._tag === "Die");
    return result(
      "failed",
      1,
      `The doctor failed unexpectedly: ${defect !== undefined && defect._tag === "Die" ? String(defect.defect) : "interrupted"}. ${
        progress.swapped
          ? "The compacted copy was already swapped in."
          : "The database file itself was not replaced."
      }`,
    );
  });

const timed = <A, E, R>(
  progress: RepairProgress,
  name: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const startedAt = performance.now();
    return effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          progress.durationsMs[name] = Math.round(performance.now() - startedAt);
        }),
      ),
    );
  });

const note = (ports: DoctorPorts, progress: RepairProgress, text: string) =>
  Effect.suspend(() => {
    progress.notes.push(text);
    return ports.reporter.note(text);
  });

/** Starts the service a run paused (finalizer), or says why it stays stopped. */
const restartPausedService = (
  target: DoctorTarget,
  options: DoctorRepairOptions,
  ports: DoctorPorts,
  progress: RepairProgress,
) =>
  Effect.suspend(() => {
    const label = progress.pausedService;
    if (label === null) return Effect.void;
    if (!options.restartService) {
      return removePausedServiceMarker(target.stateDir).pipe(
        Effect.andThen(
          note(
            ports,
            progress,
            `The background service ${label} stays stopped (--no-restart-service). Start it with \`ryco service start\`.`,
          ),
        ),
      );
    }
    return ports.reporter.phase(`Starting the background service ${label} again`).pipe(
      Effect.andThen(ports.service.start(label)),
      Effect.andThen(removePausedServiceMarker(target.stateDir)),
      Effect.andThen(
        Effect.sync(() => {
          progress.serviceRestarted = true;
        }),
      ),
      Effect.andThen(note(ports, progress, `Started the background service ${label} again.`)),
      Effect.catch((error) =>
        note(
          ports,
          progress,
          `Could not start the background service ${label} again (${error.message}). Start it with \`ryco service start\`.`,
        ),
      ),
    );
  });

const repairSteps = (
  target: DoctorTarget,
  options: DoctorRepairOptions,
  ports: DoctorPorts,
  progress: RepairProgress,
): Effect.Effect<
  { readonly status: DoctorRepairStatus; readonly message: string },
  DoctorStop,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const reporter = ports.reporter;
    // Registered first, so it runs last: after the connections closed and ownership was released.
    yield* Effect.addFinalizer(() => restartPausedService(target, options, ports, progress));

    const databaseFile = yield* Effect.promise(() => resolveDatabaseFile(target.dbPath));
    progress.databaseFile = databaseFile;
    if ((yield* Effect.promise(() => fileSize(databaseFile))) === 0) {
      return yield* refuse(`There is no database at ${databaseFile}.`);
    }

    // 1. Ownership.
    yield* reporter.phase("Checking who has the database");
    const ownership = yield* ports.ownership
      .probe(target.dbPath)
      .pipe(Effect.mapError((error) => refuse(error.message)));
    if (ownership.state === "owned") {
      const owner = ownership.owner;
      const status = yield* ports.service.status;
      if (!isServiceOwner(owner, status) || status === null || ports.service.platform === null) {
        return yield* refuse(
          describeOwnerRefusal({
            owner,
            endpoint: yield* readOwnerEndpoint(target.stateDir, owner),
            commandPrefix: target.commandPrefix,
          }),
        );
      }
      yield* timed(
        progress,
        "stopService",
        Effect.gen(function* () {
          yield* reporter.phase(`Stopping the background service ${status.label}`);
          yield* writePausedServiceMarker(target.stateDir, {
            version: 1,
            label: status.label,
            platform: ports.service.platform!,
            pausedAt: new Date(ports.now()).toISOString(),
            doctorPid: ports.pid,
          }).pipe(Effect.mapError((error) => refuse(error.message)));
          // Set before the stop: a stop that fails midway may still have stopped it.
          progress.pausedService = status.label;
          const stopped = yield* Effect.result(ports.service.stop(status.label));
          if (stopped._tag === "Failure") {
            const after = yield* ports.service.status;
            if (after?.running === true) {
              // Still running: nothing to start again at the end.
              progress.pausedService = null;
              yield* removePausedServiceMarker(target.stateDir);
            }
            return yield* refuse(
              `Could not stop the background service ${status.label}: ${stopped.failure.message}`,
            );
          }
          const deadline = ports.now() + (ports.serviceStopTimeoutMs ?? SERVICE_STOP_TIMEOUT_MS);
          for (;;) {
            const current = yield* ports.ownership
              .probe(target.dbPath)
              .pipe(Effect.mapError((error) => refuse(error.message)));
            if (current.state === "free") break;
            if (ports.now() >= deadline) {
              return yield* refuse(
                `The background service ${status.label} did not release the database within ${Math.round((ports.serviceStopTimeoutMs ?? SERVICE_STOP_TIMEOUT_MS) / 1000)} s.`,
              );
            }
            yield* Effect.sleep(SERVICE_STOP_POLL_MS);
          }
        }),
      );
    }

    yield* ports.ownership
      .acquireMaintenance(target.dbPath)
      .pipe(Effect.mapError((error) => refuse(error.message)));
    const stale = yield* Effect.promise(() => removeStaleDoctorCopies(databaseFile));
    if (stale.length > 0) {
      yield* note(
        ports,
        progress,
        `Removed copies an interrupted doctor run left: ${stale.join(", ")}.`,
      );
    }
    if (progress.pausedService === null) {
      const earlier = yield* readPausedServiceMarker(target.stateDir);
      // The status read is this data directory's service; a marker naming another one is stale.
      if (earlier !== null && earlier.label === ports.service.label) {
        const status = yield* ports.service.status;
        if (status !== null && !status.running) {
          progress.pausedService = earlier.label;
          yield* note(
            ports,
            progress,
            `An interrupted doctor run stopped the background service ${earlier.label}; it is started again at the end.`,
          );
        } else if (status !== null) {
          // Running again: nothing left to do. (Unknown state: keep the marker for a later run.)
          yield* removePausedServiceMarker(target.stateDir);
        }
      } else if (earlier !== null) {
        yield* note(
          ports,
          progress,
          `${pausedServiceMarkerPath(target.stateDir)} names the background service ${earlier.label}, not this data directory's (${ports.service.label}), so the doctor leaves it alone: start that service yourself if it should run, then delete the file.`,
        );
      }
    }

    // 2. The exclusive lock, held by C1 until just before the swap.
    const main = yield* openDoctorConnection(databaseFile, { readonly: false }).pipe(
      Effect.mapError((error) => refuse(`Ryco cannot open ${databaseFile}: ${error.message}`)),
    );
    const onMain = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      Effect.provideService(effect, SqlClient.SqlClient, main.sql);
    const sqlFailure = (what: string) => (error: { readonly message: string }) =>
      fail(`${what} failed: ${error.message}`);
    const exclusive = yield* onMain(takeExclusiveLock).pipe(Effect.result);
    if (exclusive._tag === "Failure") {
      const holders = yield* ports.fileHolders([
        databaseFile,
        `${databaseFile}-wal`,
        `${databaseFile}-shm`,
      ]);
      const named =
        holders.kind === "checked" && holders.others.length > 0
          ? ` (${describeFileHolders(holders.others)})`
          : "";
      return yield* refuse(
        `Another process has the database open${named}: an older Ryco, or a SQLite tool. Close it, then run \`${target.commandPrefix} doctor --apply\` again.`,
      );
    }

    yield* onMain(tuneForMaintenance).pipe(
      Effect.mapError(sqlFailure("Configuring the connection")),
    );

    // 3. Checks.
    yield* reporter.phase(
      options.thorough
        ? "Checking the database (integrity_check)"
        : "Checking the database (quick_check)",
    );
    const problems = yield* timed(
      progress,
      "check",
      onMain(checkIntegrity(options.thorough ? "integrity_check" : "quick_check")),
    ).pipe(Effect.mapError(sqlFailure("The integrity check")));
    if (problems.length > 0) {
      return yield* refuse(
        `The database is damaged (${problems.slice(0, 3).join("; ")}). The doctor does not repair damaged databases; restore a backup.`,
      );
    }
    const schema = yield* onMain(readSchemaCompatibility).pipe(
      Effect.mapError(sqlFailure("Reading the schema")),
    );
    if (!isSchemaCurrent(schema)) {
      return yield* refuse(describeSchemaMismatch(schema, target.commandPrefix));
    }
    const cursors = yield* onMain(readProjectionCursors).pipe(
      Effect.mapError(sqlFailure("Reading the projections")),
    );
    if (cursors.lagging.length > 0) {
      return yield* refuse(describeLagging(cursors, target.commandPrefix));
    }
    const pagesBefore = yield* onMain(readDatabasePages).pipe(
      Effect.mapError(sqlFailure("Reading the page counts")),
    );
    progress.before = {
      fileBytes:
        (yield* Effect.promise(() => fileSize(databaseFile))) +
        (yield* Effect.promise(() => fileSize(`${databaseFile}-wal`))),
      pages: pagesBefore,
    };

    // 4. Free disk for the copy.
    const compaction = yield* onMain(makeEventLogCompaction);
    const state = yield* compaction
      .readState("delete")
      .pipe(Effect.mapError(sqlFailure("Reading the compaction state")));
    const estimate = estimateCompactableBytes(state, cursors.headSequence);
    const needed = spaceNeededForCopy(pagesBefore, estimate);
    const free = yield* ports.freeBytes(NodePath.dirname(databaseFile));
    if (free !== null && free < needed) {
      return yield* refuse(
        `The compacted copy needs about ${formatBytes(needed)} free on this volume; ${formatBytes(free)} is available. Free some space, then run \`${target.commandPrefix} doctor --apply\` again.`,
      );
    }
    if (free === null) {
      yield* note(ports, progress, "Free disk space is unknown on this system; continuing.");
    }

    // 5. Compaction over the whole log.
    const settleCompactionMarker = onMain(
      Effect.gen(function* () {
        const current = yield* compaction.readState("delete");
        yield* writeLifecycleMarker(
          EVENT_COMPACTION_STATE_KEY,
          encodeCompactionState(settledCompactionState(state, current, cursors.headSequence)),
        );
      }),
    );
    let compactionSettled = false;
    // Registered after the connection, so it runs while the connection is still open.
    yield* Effect.addFinalizer(() =>
      compactionSettled ? Effect.void : Effect.exit(settleCompactionMarker).pipe(Effect.asVoid),
    );
    yield* reporter.phase("Removing superseded history");
    let checkpointedAt = 0;
    const pass = yield* timed(
      progress,
      "compact",
      compaction.runPass({
        ...DOCTOR_COMPACTION_PASS_OPTIONS,
        onProgress: (step) =>
          Effect.gen(function* () {
            progress.removedEvents = step.deletedEvents;
            progress.removedBytes = step.deletedBytes;
            yield* reportCompactionProgress(reporter, step, "removed");
            if (step.deletedEvents - checkpointedAt >= CHECKPOINT_EVERY_DELETIONS) {
              checkpointedAt = step.deletedEvents;
              yield* onMain(checkpointTruncate).pipe(Effect.ignore);
            }
          }),
      }),
    ).pipe(Effect.mapError(sqlFailure("Removing superseded history")));
    progress.removedEvents = pass.deletedEvents;
    progress.removedBytes = pass.deletedBytes;
    progress.removedReceipts = pass.deletedReceipts;
    yield* settleCompactionMarker.pipe(Effect.mapError(sqlFailure("Saving the compaction state")));
    compactionSettled = true;
    yield* onMain(checkpointTruncate).pipe(Effect.mapError(sqlFailure("The checkpoint")));
    const recheck = yield* onMain(checkIntegrity("quick_check")).pipe(
      Effect.mapError(sqlFailure("The integrity check")),
    );
    if (recheck.length > 0) {
      return yield* fail(
        `quick_check failed after removing history (${recheck.slice(0, 3).join("; ")}). The file was not shrunk; restore a backup if Ryco reports errors.`,
      );
    }

    // 6. The compacted copy.
    const pagesCompacted = yield* onMain(readDatabasePages).pipe(
      Effect.mapError(sqlFailure("Reading the page counts")),
    );
    const removedText = `Removed ${pass.deletedEvents.toLocaleString("en-US")} superseded events (${formatBytes(pass.deletedBytes)}) and ${pass.deletedReceipts.toLocaleString("en-US")} old receipts`;
    if (
      pagesCompacted.autoVacuum === "incremental" &&
      pagesCompacted.freePages * pagesCompacted.pageSize < ALREADY_COMPACT_FREE_BYTES
    ) {
      return {
        status: "already-compact" as const,
        message: `${removedText}. The file already shrinks automatically and has little free space; no copy needed.`,
      };
    }
    const neededNow = spaceNeededForCopy(pagesCompacted, 0);
    const freeNow = yield* ports.freeBytes(NodePath.dirname(databaseFile));
    if (freeNow !== null && freeNow < neededNow) {
      return yield* new DoctorStop({
        status: "compacted",
        exitCode: 0,
        message: `${removedText}, but the file was not shrunk: the copy needs about ${formatBytes(neededNow)} free and ${formatBytes(freeNow)} is available. The freed space is reused inside the file. Free some space and run the doctor again to shrink it.`,
      });
    }
    /** Stops without a swap when another process has the file open, or when that is unknown. */
    const requireNoOtherHolders = Effect.gen(function* () {
      const holders = yield* ports.fileHolders([
        databaseFile,
        `${databaseFile}-wal`,
        `${databaseFile}-shm`,
      ]);
      if (holders.kind === "checked" && holders.others.length === 0) return;
      return yield* new DoctorStop({
        status: "compacted",
        exitCode: 0,
        message:
          holders.kind === "unavailable"
            ? `${removedText}, but the file was not shrunk: Ryco cannot check whether another process has it open (${holders.reason}), and swapping it then could corrupt the database.`
            : `${removedText}, but the file was not shrunk: ${describeFileHolders(holders.others)} still has it open. Close it, then run \`${target.commandPrefix} doctor --apply\` again.`,
      });
    });
    // Before the copy too: when the swap cannot happen, writing the copy is only wasted time.
    yield* requireNoOtherHolders;

    const copyPath = doctorCopyPath(databaseFile, ports.pid, ports.now());
    // Before the copy exists: an interruption during VACUUM INTO must remove it too.
    yield* Effect.addFinalizer(() =>
      progress.swapped ? Effect.void : Effect.promise(() => removeDoctorCopy(copyPath)),
    );
    yield* reporter.phase(
      `Writing a compacted copy, about ${formatBytes(usedBytes(pagesCompacted))}; this can take several minutes. Ctrl-C takes effect after this step`,
    );
    yield* timed(
      progress,
      "copy",
      onMain(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // Not the source's mode (a no-op on a database with tables until a VACUUM): the copy's.
          yield* sql`PRAGMA auto_vacuum = INCREMENTAL`;
          yield* sql`VACUUM INTO ${copyPath}`;
        }),
      ),
    ).pipe(Effect.mapError(sqlFailure("Writing the compacted copy")));
    if (ports.beforeVerifyCopy !== undefined) yield* ports.beforeVerifyCopy(copyPath);

    // Verification of the copy against the source, which nothing can change meanwhile.
    yield* reporter.phase("Checking the copy (integrity_check)");
    const mismatch = yield* timed(
      progress,
      "verify",
      Effect.scoped(
        Effect.gen(function* () {
          const copy = yield* openDoctorReadConnection(copyPath);
          const onCopy = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
            Effect.provideService(effect, SqlClient.SqlClient, copy.sql);
          const copyProblems = yield* onCopy(checkIntegrity("integrity_check"));
          if (copyProblems.length > 0)
            return `integrity_check: ${copyProblems.slice(0, 3).join("; ")}`;
          const copyPages = yield* onCopy(readDatabasePages);
          if (copyPages.autoVacuum !== "incremental") {
            return `automatic shrinking is ${copyPages.autoVacuum} in the copy`;
          }
          const sourceCounts = yield* onMain(countTableRows);
          const copyCounts = yield* onCopy(countTableRows);
          for (const [table, rows] of sourceCounts) {
            if (copyCounts.get(table) !== rows) {
              return `table ${table} has ${copyCounts.get(table) ?? "no"} rows in the copy, ${rows} in the database`;
            }
          }
          if (copyCounts.size !== sourceCounts.size) return "the copy has other tables";
          const sourceSequences = (yield* onMain(readAutoincrementSequences)).join(",");
          const copySequences = (yield* onCopy(readAutoincrementSequences)).join(",");
          if (sourceSequences !== copySequences) return "AUTOINCREMENT sequences differ";
          const copyCursors = yield* onCopy(readProjectionCursors);
          if (copyCursors.headSequence !== cursors.headSequence) return "the newest event differs";
          return null;
        }),
      ),
    ).pipe(Effect.mapError(sqlFailure("Checking the copy")));
    if (mismatch !== null) {
      return yield* fail(
        `The compacted copy did not match the database (${mismatch}). It was removed and the database file was not replaced; superseded history was removed from it.`,
      );
    }

    // 7. The swap.
    yield* reporter.phase("Swapping the compacted copy in");
    yield* Effect.tryPromise(() => prepareCopyForSwap(copyPath, databaseFile)).pipe(
      Effect.mapError((cause) =>
        fail(
          `Could not prepare the compacted copy (${String(cause)}); the database file was not replaced.`,
        ),
      ),
    );
    const checkpoint = yield* onMain(checkpointTruncate).pipe(
      Effect.mapError(sqlFailure("The checkpoint")),
    );
    if (checkpoint.busy)
      return yield* fail("The final checkpoint could not run; the database file was not replaced.");
    // Again, with the exclusive lock still held: a process may have opened the file meanwhile.
    yield* requireNoOtherHolders;
    yield* main.close;
    if ((yield* Effect.promise(() => fileSize(`${databaseFile}-wal`))) > 0) {
      return yield* fail(
        "The write-ahead log was not empty after closing the database; the database file was not replaced.",
      );
    }
    // Left by the server that last used the file in shared mode; it describes the old file's WAL.
    yield* Effect.tryPromise(() => removeFileIfPresent(`${databaseFile}-shm`)).pipe(
      Effect.mapError((cause) =>
        fail(
          `Could not remove ${databaseFile}-shm (${String(cause)}); the database file was not replaced.`,
        ),
      ),
    );
    // Uninterruptible: an interruption must not leave a finished rename recorded as not done
    // (the finalizers and the summary rely on `swapped`).
    const swap = yield* timed(
      progress,
      "swap",
      Effect.tryPromise(() => swapInCopy(copyPath, databaseFile)).pipe(
        Effect.mapError((cause) =>
          fail(
            `Could not swap the compacted copy in: ${String(cause)}. The database file was not replaced.`,
          ),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            progress.swapped = true;
          }),
        ),
        Effect.uninterruptible,
      ),
    );
    if (swap.syncError !== null) {
      yield* note(
        ports,
        progress,
        `The compacted copy was swapped in, but syncing its directory failed (${swap.syncError}); a power loss right now could bring the old file back.`,
      );
    }

    // Reopen: WAL mode back on, a last quick_check.
    const reopened = yield* Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* openDoctorConnection(databaseFile, { readonly: false });
        return yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA journal_mode = WAL`;
          const finalProblems = yield* checkIntegrity("quick_check");
          const pages = yield* readDatabasePages;
          return { finalProblems, pages };
        }).pipe(Effect.provideService(SqlClient.SqlClient, connection.sql));
      }),
    ).pipe(Effect.mapError(sqlFailure("Reopening the database")));
    progress.after = {
      fileBytes:
        (yield* Effect.promise(() => fileSize(databaseFile))) +
        (yield* Effect.promise(() => fileSize(`${databaseFile}-wal`))),
      pages: reopened.pages,
    };
    if (reopened.finalProblems.length > 0) {
      return yield* fail(
        `The new database file failed quick_check (${reopened.finalProblems.slice(0, 3).join("; ")}). Restore a backup.`,
      );
    }
    return {
      status: "repaired" as const,
      message: `${formatBytes(progress.before.fileBytes)} → ${formatBytes(progress.after.fileBytes)}. ${removedText}. Automatic shrinking is now on.`,
    };
  });
