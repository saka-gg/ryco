// @effect-diagnostics nodeBuiltinImport:off
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { afterAll, beforeAll } from "vitest";

import { generateFixtureHome } from "../../scripts/generate-fixture-home.ts";
import {
  acquireDatabaseMaintenance,
  acquireDatabaseServer,
  type DatabaseOwner,
  DatabaseOwnerLockEnvironment,
  type DatabaseOwnership,
  probeDatabaseOwner,
} from "../persistence/databaseOwnerLock.ts";
import { EVENT_COMPACTION_STATE_KEY } from "../persistence/Layers/EventLogCompactionDeferred.ts";
import { compatibilityRepairMarker, SUPPORTED_MIGRATION_ID } from "../persistence/Migrations.ts";
import {
  CompactionState,
  EMPTY_COMPACTION_STATE,
} from "../persistence/Services/EventLogCompaction.ts";
import type { NodeServiceStatus } from "../service/nodeService.ts";
import {
  type DoctorPorts,
  type DoctorRepairResult,
  type DoctorReporter,
  type DoctorTarget,
  inspectDatabase,
  repairDatabase,
  settledCompactionState,
} from "./DatabaseDoctor.ts";
import {
  databaseOwnerLockOwnership,
  DoctorServiceError,
  type DoctorServiceControl,
  pausedServiceMarkerPath,
} from "./doctorOwnership.ts";
import { findFileHolders } from "./fileHolders.ts";

// ---------------------------------------------------------------------------
// Fixture: a real Ryco database written through the engine, converted to a pre-shrinking one
// (auto_vacuum NONE, WAL) like every database created before automatic shrinking.
// ---------------------------------------------------------------------------

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-doctor-test-"));
const templatePath = NodePath.join(root, "template-none.sqlite");

beforeAll(async () => {
  const summary = await generateFixtureHome({
    out: NodePath.join(root, "generated"),
    projects: 1,
    threads: 4,
    turns: 2,
    archivedShare: 0,
    usageReportsPerTurn: 1,
    seed: 11,
    progressTicksPerTurn: 12,
    reasoningFlushesPerTurn: 3,
    subagentFlushesPerTurn: 3,
  });
  const db = new DatabaseSync(summary.dbPath);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("PRAGMA auto_vacuum = NONE");
    db.exec(`VACUUM INTO '${templatePath.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
}, 120_000);

afterAll(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

let homeSerial = 0;
/** A data directory of its own holding a copy of the template, in WAL mode. */
const makeHome = () => {
  homeSerial += 1;
  const baseDir = NodePath.join(root, `home-${homeSerial}`);
  const stateDir = NodePath.join(baseDir, "userdata");
  NodeFS.mkdirSync(stateDir, { recursive: true });
  const dbPath = NodePath.join(stateDir, "state.sqlite");
  NodeFS.copyFileSync(templatePath, dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.close();
  const target: DoctorTarget = { dbPath, stateDir, commandPrefix: "ryco" };
  return { baseDir, stateDir, dbPath, target };
};

const query = <T>(dbPath: string, sql: string): T => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).get() as T;
  } finally {
    db.close();
  }
};

const scalar = (dbPath: string, sql: string) =>
  Number(Object.values(query<Record<string, unknown>>(dbPath, sql))[0]);

const execute = (dbPath: string, sql: string) => {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
};

/** Superseded latest-state versions still in the log (a later event of the same id exists). */
const supersededEvents = (dbPath: string) =>
  scalar(
    dbPath,
    `SELECT count(*) FROM orchestration_events e
     WHERE e.event_type = 'thread.activity-appended'
       AND json_extract(e.payload_json, '$.activity.kind') IN ('task.progress','tool.progress','agent.message','reasoning')
       AND EXISTS (
         SELECT 1 FROM orchestration_events later
         WHERE later.stream_id = e.stream_id AND later.sequence > e.sequence
           AND later.event_type = 'thread.activity-appended'
           AND json_extract(later.payload_json, '$.activity.id') = json_extract(e.payload_json, '$.activity.id')
       )`,
  );

/** Every projection table, hashed, so a compacted and shrunk copy can be compared. */
const projectionDump = (dbPath: string) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = (
      db
        .prepare(
          // Virtual (FTS) tables are compared through their shadow tables.
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'projection_%' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    return Object.fromEntries(
      tables.map((table) => {
        const rows = db.prepare(`SELECT * FROM "${table}"`).all();
        const lines = rows
          .map((row) =>
            JSON.stringify(
              Object.entries(row as Record<string, unknown>).toSorted(),
              (_key, value) => (typeof value === "bigint" ? value.toString() : value),
            ),
          )
          .toSorted();
        return [table, createHash("sha256").update(lines.join("\n")).digest("hex")];
      }),
    );
  } finally {
    db.close();
  }
};

const fileState = (dbPath: string) => {
  const info = NodeFS.statSync(dbPath);
  return {
    size: info.size,
    mtimeMs: info.mtimeMs,
    sha: createHash("sha256").update(NodeFS.readFileSync(dbPath)).digest("hex"),
  };
};

const doctorCopies = (stateDir: string) =>
  NodeFS.readdirSync(stateDir).filter((name) => name.includes(".doctor-"));

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

interface Recorder {
  readonly calls: Array<string>;
  readonly lines: Array<string>;
}

const recordingReporter = (recorder: Recorder): DoctorReporter => ({
  phase: (text) => Effect.sync(() => void recorder.lines.push(`phase: ${text}`)),
  progress: (text) => Effect.sync(() => void recorder.lines.push(`progress: ${text}`)),
  note: (text) => Effect.sync(() => void recorder.lines.push(`note: ${text}`)),
});

const SERVICE_LABEL = "space.ryco.node.test";

const serviceStatus = (input: { running: boolean; pid: number | null }): NodeServiceStatus => ({
  platform: "launchd",
  label: SERVICE_LABEL,
  definitionPath: "/dev/null",
  installed: true,
  loaded: input.running,
  running: input.running,
  pid: input.pid,
  lingering: null,
});

/** A service that is not installed: `status` says so, stop/start must never run. */
const noService = (recorder: Recorder): DoctorServiceControl => ({
  platform: "launchd",
  label: SERVICE_LABEL,
  status: Effect.succeed(null),
  stop: (label) => Effect.sync(() => void recorder.calls.push(`stop:${label}`)),
  start: (label) => Effect.sync(() => void recorder.calls.push(`start:${label}`)),
});

const makePorts = (recorder: Recorder, overrides: Partial<DoctorPorts> = {}): DoctorPorts => ({
  ownership: databaseOwnerLockOwnership,
  service: noService(recorder),
  freeBytes: () => Effect.succeed(1024 ** 4),
  // This process is the only holder (the test opens nothing else).
  fileHolders: () => Effect.succeed({ kind: "checked", others: [] }),
  reporter: recordingReporter(recorder),
  pid: process.pid,
  now: Date.now,
  serviceStopTimeoutMs: 5_000,
  ...overrides,
});

const newRecorder = (): Recorder => ({ calls: [], lines: [] });

const ownerOf = (pid: number, overrides: Partial<DatabaseOwner> = {}): DatabaseOwner => ({
  pid,
  kind: "server",
  startedAt: new Date().toISOString(),
  purpose: "serve",
  launcher: "desktop",
  appVersion: "0.1.36",
  schemaSupported: SUPPORTED_MIGRATION_ID,
  schemaDigest: "digest",
  legacy: false,
  self: false,
  ...overrides,
});

const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(CompactionState));

const assertRefusedUnchanged = (
  result: DoctorRepairResult,
  before: ReturnType<typeof fileState>,
  dbPath: string,
) => {
  assert.equal(result.status, "refused");
  assert.equal(result.exitCode, 2);
  const after = fileState(dbPath);
  assert.equal(after.sha, before.sha);
  assert.equal(after.size, before.size);
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DatabaseDoctor", () => {
  it.live("a dry run reports the database and its plan and changes nothing", () =>
    Effect.gen(function* () {
      const home = makeHome();
      const before = fileState(home.dbPath);
      const recorder = newRecorder();
      const inspection = yield* inspectDatabase(
        home.target,
        { estimate: true },
        makePorts(recorder),
      );

      assert.deepEqual(inspection.blockers, []);
      assert.equal(inspection.exists, true);
      assert.equal(inspection.pages?.autoVacuum, "none");
      assert.equal(inspection.schema?.applied, SUPPORTED_MIGRATION_ID);
      assert.equal(inspection.owner.state, "free");
      assert.equal(inspection.compaction?.exact, true);
      // Counted exactly: every superseded version in the fixture.
      assert.equal(inspection.compaction?.removableEvents, supersededEvents(home.dbPath));
      assert.isAbove(inspection.compaction?.removableEvents ?? 0, 0);
      assert.isAbove(inspection.plan.length, 2);
      assert.isBelow(inspection.estimatedBytesAfter ?? Infinity, inspection.fileBytes);

      const after = fileState(home.dbPath);
      assert.equal(after.sha, before.sha);
      assert.equal(after.mtimeMs, before.mtimeMs);
      assert.equal(
        scalar(
          home.dbPath,
          `SELECT count(*) FROM lifecycle_markers WHERE key LIKE 'orchestration_event_compaction%'`,
        ),
        0,
      );
      assert.deepEqual(recorder.calls, []);
    }),
  );

  it.live(
    "--apply removes superseded history, shrinks the file, turns automatic shrinking on and keeps every projection",
    () =>
      Effect.gen(function* () {
        const home = makeHome();
        const projections = projectionDump(home.dbPath);
        const eventsBefore = scalar(home.dbPath, "SELECT count(*) FROM orchestration_events");
        const superseded = supersededEvents(home.dbPath);
        const headBefore = scalar(home.dbPath, "SELECT MAX(sequence) FROM orchestration_events");
        const sizeBefore = NodeFS.statSync(home.dbPath).size;
        const recorder = newRecorder();

        const result = yield* repairDatabase(
          home.target,
          { thorough: true, restartService: true },
          makePorts(recorder),
        );

        assert.equal(result.status, "repaired", result.message);
        assert.equal(result.exitCode, 0);
        assert.equal(result.swapped, true);
        assert.equal(result.removedEvents, superseded);
        assert.equal(supersededEvents(home.dbPath), 0);
        assert.equal(
          scalar(home.dbPath, "SELECT count(*) FROM orchestration_events"),
          eventsBefore - superseded,
        );
        assert.equal(
          scalar(home.dbPath, "SELECT MAX(sequence) FROM orchestration_events"),
          headBefore,
        );
        assert.isBelow(NodeFS.statSync(home.dbPath).size, sizeBefore);
        assert.equal(scalar(home.dbPath, "PRAGMA auto_vacuum"), 2);
        assert.equal(
          query<{ journal_mode: string }>(home.dbPath, "PRAGMA journal_mode").journal_mode,
          "wal",
        );
        assert.equal(
          query<{ integrity_check: string }>(home.dbPath, "PRAGMA integrity_check").integrity_check,
          "ok",
        );
        assert.deepEqual(projectionDump(home.dbPath), projections);
        // Old random-id receipts went too (the fixture's history is months old).
        assert.isAbove(result.removedReceipts, 0);
        // The compaction cursor sits at the head, the receipt cursor starts over after the copy.
        const state = decodeState(
          query<{ value: string }>(
            home.dbPath,
            `SELECT value FROM lifecycle_markers WHERE key = '${EVENT_COMPACTION_STATE_KEY}'`,
          ).value,
        );
        assert.equal(state.compactedThroughSequence, headBefore);
        assert.equal(state.receiptRowidCursor, 0);
        assert.equal(state.totals.scannedSequences, headBefore);
        // Nothing left behind: no copy, ownership released, the stale shared-memory file gone.
        assert.deepEqual(doctorCopies(home.stateDir), []);
        assert.deepEqual(yield* probeDatabaseOwner(home.dbPath), { state: "free" });
        assert.isFalse(NodeFS.existsSync(`${home.dbPath}.owner`));
        assert.deepEqual(recorder.calls, []);
      }),
  );

  it.live("stops this data directory's service, repairs, and starts it again", () =>
    Effect.gen(function* () {
      const home = makeHome();
      const recorder = newRecorder();
      let running = true;
      const service: DoctorServiceControl = {
        platform: "launchd",
        label: SERVICE_LABEL,
        status: Effect.sync(() => {
          recorder.calls.push("status");
          return serviceStatus({ running, pid: running ? 4242 : null });
        }),
        stop: (label) =>
          Effect.sync(() => {
            recorder.calls.push(`stop:${label}`);
            // The marker is written before the service stops.
            assert.isTrue(NodeFS.existsSync(pausedServiceMarkerPath(home.stateDir)));
            running = false;
          }),
        start: (label) =>
          Effect.sync(() => {
            recorder.calls.push(`start:${label}`);
            running = true;
          }),
      };
      const ownership = {
        ...databaseOwnerLockOwnership,
        probe: () =>
          Effect.succeed<DatabaseOwnership>(
            running
              ? { state: "owned", owner: ownerOf(4242, { launcher: "service" }) }
              : { state: "free" },
          ),
      };

      const result = yield* repairDatabase(
        home.target,
        { thorough: false, restartService: true },
        makePorts(recorder, { service, ownership }),
      );

      assert.equal(result.status, "repaired", result.message);
      assert.equal(result.serviceRestarted, true);
      assert.deepEqual(
        recorder.calls.filter((call) => call !== "status"),
        [`stop:${SERVICE_LABEL}`, `start:${SERVICE_LABEL}`],
      );
      // Started only after the swap: the last phase is the restart.
      const phases = recorder.lines.filter((line) => line.startsWith("phase:"));
      assert.match(phases.at(-1) ?? "", /Starting the background service/);
      assert.isFalse(NodeFS.existsSync(pausedServiceMarkerPath(home.stateDir)));
    }),
  );

  it.live(
    "recognises its service by the label the owner recorded when the service manager names no pid",
    () =>
      Effect.gen(function* () {
        const home = makeHome();
        const recorder = newRecorder();
        let running = true;
        const service: DoctorServiceControl = {
          ...noService(recorder),
          // launchd printed no pid line.
          status: Effect.sync(() => serviceStatus({ running, pid: null })),
          stop: (label) =>
            Effect.sync(() => {
              recorder.calls.push(`stop:${label}`);
              running = false;
            }),
          start: (label) =>
            Effect.sync(() => {
              recorder.calls.push(`start:${label}`);
              running = true;
            }),
        };
        const owner = ownerOf(4242, { launcher: "service", serviceLabel: SERVICE_LABEL });
        const ownership = {
          ...databaseOwnerLockOwnership,
          probe: () =>
            Effect.succeed<DatabaseOwnership>(
              running ? { state: "owned", owner } : { state: "free" },
            ),
        };
        const result = yield* repairDatabase(
          home.target,
          { thorough: false, restartService: true },
          makePorts(recorder, { service, ownership }),
        );
        assert.equal(result.status, "repaired", result.message);
        assert.deepEqual(recorder.calls, [`stop:${SERVICE_LABEL}`, `start:${SERVICE_LABEL}`]);
      }),
  );

  it.live("refuses another data directory's service without stopping it", () =>
    Effect.gen(function* () {
      const home = makeHome();
      const before = fileState(home.dbPath);
      const recorder = newRecorder();
      const service: DoctorServiceControl = {
        ...noService(recorder),
        status: Effect.succeed(serviceStatus({ running: true, pid: 4242 })),
      };
      const owner = ownerOf(5151, { launcher: "service", serviceLabel: "space.ryco.node.other" });
      const result = yield* repairDatabase(
        home.target,
        { thorough: false, restartService: true },
        makePorts(recorder, {
          service,
          ownership: {
            ...databaseOwnerLockOwnership,
            probe: () => Effect.succeed<DatabaseOwnership>({ state: "owned", owner }),
          },
        }),
      );
      assertRefusedUnchanged(result, before, home.dbPath);
      assert.match(result.message, /space\.ryco\.node\.other/);
      assert.match(result.message, /stop it yourself/);
      assert.notMatch(result.message, /restarted automatically/);
      assert.deepEqual(recorder.calls, []);
    }),
  );

  it.live("does not start a service whose stop failed while it still runs", () =>
    Effect.gen(function* () {
      const home = makeHome();
      const before = fileState(home.dbPath);
      const recorder = newRecorder();
      const service: DoctorServiceControl = {
        ...noService(recorder),
        status: Effect.succeed(serviceStatus({ running: true, pid: 4242 })),
        stop: (label) =>
          Effect.sync(() => void recorder.calls.push(`stop:${label}`)).pipe(
            Effect.andThen(Effect.fail(new DoctorServiceError({ message: "systemctl timed out" }))),
          ),
      };
      const result = yield* repairDatabase(
        home.target,
        { thorough: false, restartService: true },
        makePorts(recorder, {
          service,
          ownership: {
            ...databaseOwnerLockOwnership,
            probe: () =>
              Effect.succeed<DatabaseOwnership>({ state: "owned", owner: ownerOf(4242) }),
          },
        }),
      );
      assertRefusedUnchanged(result, before, home.dbPath);
      assert.match(result.message, /systemctl timed out/);
      assert.deepEqual(recorder.calls, [`stop:${SERVICE_LABEL}`]);
      assert.isFalse(result.notes.some((line) => line.includes("Started the background service")));
      assert.isFalse(NodeFS.existsSync(pausedServiceMarkerPath(home.stateDir)));
    }),
  );

  it.live("leaves the service stopped with --no-restart-service", () =>
    Effect.gen(function* () {
      const home = makeHome();
      const recorder = newRecorder();
      let running = true;
      const service: DoctorServiceControl = {
        ...noService(recorder),
        status: Effect.sync(() => serviceStatus({ running, pid: running ? 4242 : null })),
        stop: (label) =>
          Effect.sync(() => {
            recorder.calls.push(`stop:${label}`);
            running = false;
          }),
      };
      const ownership = {
        ...databaseOwnerLockOwnership,
        probe: () =>
          Effect.succeed<DatabaseOwnership>(
            running ? { state: "owned", owner: ownerOf(4242) } : { state: "free" },
          ),
      };
      const result = yield* repairDatabase(
        home.target,
        { thorough: false, restartService: false },
        makePorts(recorder, { service, ownership }),
      );
      assert.equal(result.status, "repaired", result.message);
      assert.deepEqual(recorder.calls, [`stop:${SERVICE_LABEL}`]);
      assert.isTrue(result.notes.some((line) => line.includes("stays stopped")));
      assert.isFalse(NodeFS.existsSync(pausedServiceMarkerPath(home.stateDir)));
    }),
  );

  it.live("refuses while the desktop app has the database, naming it, and changes nothing", () =>
    Effect.gen(function* () {
      const home = makeHome();
      const before = fileState(home.dbPath);
      const recorder = newRecorder();
      // The desktop app (another live process) owns the database through the real owner lock.
      const desktopPid = 777_001;
      const asProcess =
        (pid: number) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.provideService(effect, DatabaseOwnerLockEnvironment, {
            pid,
            now: Date.now,
            probe: {
              platform: "linux",
              bootTime: () => 1_784_000_000_000,
              bootId: async () => "0b6ff1d4-6c1f-4f5e-9d38-6a1c3e2b7f10",
              processAlive: (candidate) => candidate === desktopPid || candidate === process.pid,
              processStartTime: async (candidate) =>
                candidate === desktopPid ? "5000" : candidate === process.pid ? "6000" : undefined,
            },
            isListening: async () => false,
          });
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* asProcess(desktopPid)(
            acquireDatabaseServer(home.dbPath, { launcher: "desktop" }, { waitMs: 0 }),
          );
          return yield* asProcess(process.pid)(
            repairDatabase(
              home.target,
              { thorough: false, restartService: true },
              makePorts(recorder),
            ),
          );
        }),
      );
      assertRefusedUnchanged(result, before, home.dbPath);
      assert.match(result.message, /desktop app/);
      assert.match(result.message, /pid 777001/);
      assert.match(result.message, /cannot stop the desktop app/);
      assert.deepEqual(recorder.calls, []);
    }),
  );

  it.live("refuses while another maintenance run owns the database", () =>
    Effect.gen(function* () {
      const home = makeHome();
      const before = fileState(home.dbPath);
      const recorder = newRecorder();
      const result = yield* repairDatabase(
        home.target,
        { thorough: false, restartService: true },
        makePorts(recorder, {
          ownership: {
            ...databaseOwnerLockOwnership,
            probe: () =>
              Effect.succeed<DatabaseOwnership>({
                state: "owned",
                owner: ownerOf(9_999, { kind: "maintenance", launcher: "cli", purpose: "restore" }),
              }),
          },
        }),
      );
      assertRefusedUnchanged(result, before, home.dbPath);
      assert.match(result.message, /upgrading or repairing/);
    }),
  );

  it.live("refuses when maintenance ownership is taken between the probe and the run", () =>
    Effect.gen(function* () {
      const home = makeHome();
      const before = fileState(home.dbPath);
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireDatabaseMaintenance(home.dbPath, "restore");
          return yield* repairDatabase(
            home.target,
            { thorough: false, restartService: true },
            makePorts(newRecorder(), {
              // The probe still saw a free database.
              ownership: {
                ...databaseOwnerLockOwnership,
                probe: () => Effect.succeed<DatabaseOwnership>({ state: "free" }),
              },
            }),
          );
        }),
      );
      assertRefusedUnchanged(result, before, home.dbPath);
    }),
  );

  it.live("refuses at SQLite's exclusive lock while another connection has the database open", () =>
    Effect.gen(function* () {
      const home = makeHome();
      // An older Ryco or a SQLite tool: it predates the owner lock, so only SQLite sees it.
      const other = new DatabaseSync(home.dbPath);
      other.prepare("SELECT count(*) FROM orchestration_events").get();
      const before = fileState(home.dbPath);
      try {
        const result = yield* repairDatabase(
          home.target,
          { thorough: false, restartService: true },
          makePorts(newRecorder()),
        );
        assertRefusedUnchanged(result, before, home.dbPath);
        assert.match(result.message, /Another process has the database open/);
        assert.deepEqual(yield* probeDatabaseOwner(home.dbPath), { state: "free" });
      } finally {
        other.close();
      }
    }),
  );

  it.live("refuses a database whose schema is newer or older than this binary", () =>
    Effect.gen(function* () {
      const newer = makeHome();
      execute(
        newer.dbPath,
        `INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (${SUPPORTED_MIGRATION_ID + 1}, 'FromTheFuture', '2026-10-24T00:00:00Z')`,
      );
      const newerBefore = fileState(newer.dbPath);
      const newerResult = yield* repairDatabase(
        newer.target,
        { thorough: false, restartService: true },
        makePorts(newRecorder()),
      );
      assertRefusedUnchanged(newerResult, newerBefore, newer.dbPath);
      assert.match(newerResult.message, /newer than this ryco supports/);

      const older = makeHome();
      execute(
        older.dbPath,
        `DELETE FROM effect_sql_migrations WHERE migration_id = ${SUPPORTED_MIGRATION_ID}`,
      );
      const olderBefore = fileState(older.dbPath);
      const olderResult = yield* repairDatabase(
        older.target,
        { thorough: false, restartService: true },
        makePorts(newRecorder()),
      );
      assertRefusedUnchanged(olderResult, olderBefore, older.dbPath);
      assert.match(olderResult.message, /never upgrades a database/);
      // The dry run says so too.
      const inspection = yield* inspectDatabase(
        older.target,
        { estimate: false },
        makePorts(newRecorder()),
      );
      assert.equal(inspection.blockers.length, 1);
    }),
  );

  it.live("refuses a database with a compatibility repair it never recorded", () =>
    Effect.gen(function* () {
      // What a server from before repair records, or one that stopped before recording a new
      // repair, leaves: the repair runs again on the next start, so the doctor must not compact.
      const home = makeHome();
      execute(
        home.dbPath,
        `DELETE FROM ryco_compatibility_repairs WHERE repair_key = '${compatibilityRepairMarker("lifecycle-markers")}'`,
      );
      const inspection = yield* inspectDatabase(
        home.target,
        { estimate: false },
        makePorts(newRecorder()),
      );
      assert.deepEqual(inspection.schema?.repairs, ["lifecycle-markers"]);
      assert.equal(inspection.blockers.length, 1);
      assert.match(inspection.blockers[0] ?? "", /compatibility repairs \(lifecycle-markers\)/);

      const before = fileState(home.dbPath);
      const result = yield* repairDatabase(
        home.target,
        { thorough: false, restartService: true },
        makePorts(newRecorder()),
      );
      assertRefusedUnchanged(result, before, home.dbPath);
      assert.match(result.message, /Start Ryco once on this data directory/);
    }),
  );

  it.live("refuses while a projector lags behind the log", () =>
    Effect.gen(function* () {
      const home = makeHome();
      execute(
        home.dbPath,
        "UPDATE projection_state SET last_applied_sequence = last_applied_sequence - 1 WHERE projector = 'projection.threads'",
      );
      const before = fileState(home.dbPath);
      const result = yield* repairDatabase(
        home.target,
        { thorough: false, restartService: true },
        makePorts(newRecorder()),
      );
      assertRefusedUnchanged(result, before, home.dbPath);
      assert.match(result.message, /projection\.threads/);
    }),
  );

  it.live("refuses before changing anything when the copy will not fit", () =>
    Effect.gen(function* () {
      const home = makeHome();
      const superseded = supersededEvents(home.dbPath);
      const before = fileState(home.dbPath);
      const result = yield* repairDatabase(
        home.target,
        { thorough: false, restartService: true },
        makePorts(newRecorder(), { freeBytes: () => Effect.succeed(1_000_000) }),
      );
      assertRefusedUnchanged(result, before, home.dbPath);
      assert.match(result.message, /free on this volume/);
      assert.equal(supersededEvents(home.dbPath), superseded);
    }),
  );

  it.live(
    "keeps the removed history but does not shrink when space runs out after compaction",
    () =>
      Effect.gen(function* () {
        const home = makeHome();
        let calls = 0;
        const result = yield* repairDatabase(
          home.target,
          { thorough: false, restartService: true },
          makePorts(newRecorder(), {
            freeBytes: () => Effect.sync(() => (++calls === 1 ? 1024 ** 4 : 1_000_000)),
          }),
        );
        assert.equal(result.status, "compacted", result.message);
        assert.equal(result.exitCode, 0);
        assert.equal(result.swapped, false);
        assert.match(result.message, /not shrunk/);
        assert.equal(supersededEvents(home.dbPath), 0);
        assert.equal(scalar(home.dbPath, "PRAGMA auto_vacuum"), 0);
        assert.deepEqual(doctorCopies(home.stateDir), []);
      }),
  );

  it.live("removes a copy that does not match and keeps the database file", () =>
    Effect.gen(function* () {
      const home = makeHome();
      let beforeCopy: ReturnType<typeof fileState> | undefined;
      const result = yield* repairDatabase(
        home.target,
        { thorough: false, restartService: true },
        makePorts(newRecorder(), {
          beforeVerifyCopy: (copyPath) =>
            Effect.sync(() => {
              beforeCopy = fileState(home.dbPath);
              execute(
                copyPath,
                "DELETE FROM projection_threads WHERE rowid = (SELECT MIN(rowid) FROM projection_threads)",
              );
            }),
        }),
      );
      assert.equal(result.status, "failed", result.message);
      assert.equal(result.exitCode, 1);
      assert.match(result.message, /projection_threads/);
      assert.deepEqual(doctorCopies(home.stateDir), []);
      assert.equal(fileState(home.dbPath).sha, beforeCopy?.sha);
      assert.equal(scalar(home.dbPath, "PRAGMA auto_vacuum"), 0);
      assert.deepEqual(yield* probeDatabaseOwner(home.dbPath), { state: "free" });
    }),
  );

  it.live(
    "does not swap while another process holds the file, or when that cannot be checked",
    () =>
      Effect.gen(function* () {
        for (const holders of [
          { kind: "checked" as const, others: [{ pid: 4321, command: "DB Browser" }] },
          { kind: "unavailable" as const, reason: "not supported on testos" },
        ]) {
          const home = makeHome();
          let copyWritten = false;
          const result = yield* repairDatabase(
            home.target,
            { thorough: false, restartService: true },
            makePorts(newRecorder(), {
              fileHolders: () => Effect.succeed(holders),
              beforeVerifyCopy: () =>
                Effect.sync(() => {
                  copyWritten = true;
                }),
            }),
          );
          // Known before the copy: none is written for a swap that cannot happen.
          assert.isFalse(copyWritten);
          assert.equal(result.status, "compacted", result.message);
          assert.equal(result.exitCode, 0);
          assert.equal(result.swapped, false);
          assert.match(
            result.message,
            holders.kind === "checked" ? /pid 4321 \(DB Browser\)/ : /cannot check/,
          );
          assert.equal(scalar(home.dbPath, "PRAGMA auto_vacuum"), 0);
          assert.equal(supersededEvents(home.dbPath), 0);
          assert.deepEqual(doctorCopies(home.stateDir), []);
        }
      }),
  );

  it.live.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "sees a process that opened the database during the run and never read it",
    () =>
      Effect.gen(function* () {
        const home = makeHome();
        let child: ChildProcess | undefined;
        try {
          const result = yield* repairDatabase(
            home.target,
            { thorough: false, restartService: true },
            makePorts(newRecorder(), {
              fileHolders: (paths) => Effect.promise(() => findFileHolders({ paths })),
              // Opens the file (a descriptor, no lock) after the exclusive lock was taken.
              beforeVerifyCopy: () =>
                Effect.promise(
                  () =>
                    new Promise<void>((resolve, reject) => {
                      child = spawn(
                        process.execPath,
                        [
                          "-e",
                          `require("node:fs").openSync(${JSON.stringify(home.dbPath)}, "r"); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`,
                        ],
                        { stdio: ["ignore", "pipe", "inherit"] },
                      );
                      child.once("error", reject);
                      child.stdout?.once("data", () => resolve());
                    }),
                ),
            }),
          );
          assert.equal(result.status, "compacted", result.message);
          assert.equal(result.swapped, false);
          assert.include(result.message, `pid ${child?.pid}`);
          assert.equal(scalar(home.dbPath, "PRAGMA auto_vacuum"), 0);
          assert.deepEqual(doctorCopies(home.stateDir), []);
        } finally {
          child?.kill("SIGKILL");
        }
      }),
  );

  it.live("an interruption during compaction releases everything and restarts the service", () =>
    Effect.gen(function* () {
      const home = makeHome();
      const recorder = newRecorder();
      let running = true;
      const compacting = yield* Deferred.make<void>();
      const service: DoctorServiceControl = {
        ...noService(recorder),
        status: Effect.sync(() => serviceStatus({ running, pid: running ? 4242 : null })),
        stop: (label) =>
          Effect.sync(() => {
            recorder.calls.push(`stop:${label}`);
            running = false;
          }),
        start: (label) =>
          Effect.sync(() => {
            recorder.calls.push(`start:${label}`);
            running = true;
          }),
      };
      const ports = makePorts(recorder, {
        service,
        ownership: {
          ...databaseOwnerLockOwnership,
          probe: () =>
            Effect.succeed<DatabaseOwnership>(
              running ? { state: "owned", owner: ownerOf(4242) } : { state: "free" },
            ),
        },
        reporter: {
          ...recordingReporter(recorder),
          progress: (text) =>
            Effect.gen(function* () {
              recorder.lines.push(`progress: ${text}`);
              yield* Deferred.succeed(compacting, undefined);
              // Stay here until interrupted.
              return yield* Effect.never;
            }),
        },
      });
      const fiber = yield* Effect.forkChild(
        repairDatabase(home.target, { thorough: false, restartService: true }, ports),
      );
      yield* Deferred.await(compacting);
      yield* Fiber.interrupt(fiber);

      assert.deepEqual(recorder.calls, [`stop:${SERVICE_LABEL}`, `start:${SERVICE_LABEL}`]);
      assert.isTrue(recorder.lines.some((line) => line.includes("Interrupted")));
      assert.isFalse(NodeFS.existsSync(pausedServiceMarkerPath(home.stateDir)));
      assert.deepEqual(doctorCopies(home.stateDir), []);
      assert.deepEqual(yield* probeDatabaseOwner(home.dbPath), { state: "free" });
      assert.equal(scalar(home.dbPath, "PRAGMA auto_vacuum"), 0);
    }),
  );

  it.live("an interruption with the copy written removes it and keeps the database file", () =>
    Effect.gen(function* () {
      const home = makeHome();
      const copied = yield* Deferred.make<string>();
      const ports = makePorts(newRecorder(), {
        beforeVerifyCopy: (copyPath) =>
          Deferred.succeed(copied, copyPath).pipe(Effect.andThen(Effect.never)),
      });
      const fiber = yield* Effect.forkChild(
        repairDatabase(home.target, { thorough: false, restartService: true }, ports),
      );
      const copyPath = yield* Deferred.await(copied);
      assert.isTrue(NodeFS.existsSync(copyPath));
      yield* Fiber.interrupt(fiber);
      assert.isFalse(NodeFS.existsSync(copyPath));
      assert.deepEqual(doctorCopies(home.stateDir), []);
      assert.equal(scalar(home.dbPath, "PRAGMA auto_vacuum"), 0);
      assert.deepEqual(yield* probeDatabaseOwner(home.dbPath), { state: "free" });
    }),
  );

  it.live(
    "finishes what a killed run left: its copy is removed and its paused service started",
    () =>
      Effect.gen(function* () {
        const home = makeHome();
        const recorder = newRecorder();
        const stale = `${home.dbPath}.doctor-999-1700000000000.tmp`;
        NodeFS.writeFileSync(stale, "partial copy");
        NodeFS.writeFileSync(`${stale}-journal`, "");
        // Same prefix, not a doctor copy: left alone.
        const unrelated = `${home.dbPath}.doctor-notes.txt`;
        NodeFS.writeFileSync(unrelated, "keep");
        NodeFS.writeFileSync(
          pausedServiceMarkerPath(home.stateDir),
          `${JSON.stringify({ version: 1, label: SERVICE_LABEL, platform: "launchd", pausedAt: "2026-10-23T10:00:00.000Z", doctorPid: 999 })}\n`,
        );
        const service: DoctorServiceControl = {
          ...noService(recorder),
          status: Effect.succeed(serviceStatus({ running: false, pid: null })),
        };
        const result = yield* repairDatabase(
          home.target,
          { thorough: false, restartService: true },
          makePorts(recorder, { service }),
        );
        assert.equal(result.status, "repaired", result.message);
        assert.isFalse(NodeFS.existsSync(stale));
        assert.isFalse(NodeFS.existsSync(`${stale}-journal`));
        assert.isTrue(NodeFS.existsSync(unrelated));
        assert.deepEqual(recorder.calls, [`start:${SERVICE_LABEL}`]);
        assert.isFalse(NodeFS.existsSync(pausedServiceMarkerPath(home.stateDir)));
      }),
  );

  it.live("leaves a paused-service marker that names another service alone", () =>
    Effect.gen(function* () {
      const home = makeHome();
      const recorder = newRecorder();
      NodeFS.writeFileSync(
        pausedServiceMarkerPath(home.stateDir),
        `${JSON.stringify({ version: 1, label: "space.ryco.node.other", platform: "launchd", pausedAt: "2026-10-23T10:00:00.000Z", doctorPid: 999 })}\n`,
      );
      const service: DoctorServiceControl = {
        ...noService(recorder),
        status: Effect.succeed(serviceStatus({ running: false, pid: null })),
      };
      const result = yield* repairDatabase(
        home.target,
        { thorough: false, restartService: true },
        makePorts(recorder, { service }),
      );
      assert.equal(result.status, "repaired", result.message);
      assert.deepEqual(recorder.calls, []);
      assert.isTrue(NodeFS.existsSync(pausedServiceMarkerPath(home.stateDir)));
      assert.isTrue(result.notes.some((line) => line.includes("space.ryco.node.other")));
    }),
  );

  it("leaves the compaction cursor where online passes or the doctor got furthest", () => {
    const online: CompactionState = {
      ...EMPTY_COMPACTION_STATE,
      compactedThroughSequence: 900,
      receiptRowidCursor: 4_000,
      totals: {
        scannedSequences: 1_400,
        deletedEvents: 50,
        deletedBytes: 5_000,
        deletedReceipts: 7,
      },
    };
    // Interrupted: the doctor's own pass (from 0) had only reached 300.
    const interrupted = settledCompactionState(
      online,
      {
        ...online,
        compactedThroughSequence: 300,
        receiptRowidCursor: 0,
        totals: { ...online.totals, scannedSequences: 1_700, deletedEvents: 60 },
      },
      1_000,
    );
    assert.equal(interrupted.compactedThroughSequence, 900);
    assert.equal(interrupted.totals.scannedSequences, 900);
    assert.equal(interrupted.totals.deletedEvents, 60);
    assert.equal(interrupted.receiptRowidCursor, 0);
    // Finished: the whole log, once.
    const finished = settledCompactionState(
      online,
      {
        ...online,
        compactedThroughSequence: 1_000,
        totals: { ...online.totals, scannedSequences: 2_400 },
      },
      1_000,
    );
    assert.equal(finished.compactedThroughSequence, 1_000);
    assert.equal(finished.totals.scannedSequences, 1_000);
    // A cursor from another log (past the head) does not count.
    const reset = settledCompactionState(
      { ...online, compactedThroughSequence: 5_000 },
      { ...online, compactedThroughSequence: 300 },
      1_000,
    );
    assert.equal(reset.compactedThroughSequence, 300);
  });

  it.live("shrinks the file a linked state.sqlite points to and keeps the link", () =>
    Effect.gen(function* () {
      const home = makeHome();
      const elsewhere = NodePath.join(root, `linked-target-${homeSerial}`);
      NodeFS.mkdirSync(elsewhere, { recursive: true });
      const realFile = NodePath.join(elsewhere, "state.sqlite");
      NodeFS.renameSync(home.dbPath, realFile);
      NodeFS.symlinkSync(realFile, home.dbPath);
      const sizeBefore = NodeFS.statSync(realFile).size;
      const volumes: Array<string> = [];
      const result = yield* repairDatabase(
        home.target,
        { thorough: false, restartService: true },
        makePorts(newRecorder(), {
          freeBytes: (directory) =>
            Effect.sync(() => {
              volumes.push(directory);
              return 1024 ** 4;
            }),
        }),
      );
      assert.equal(result.status, "repaired", result.message);
      assert.isTrue(NodeFS.lstatSync(home.dbPath).isSymbolicLink());
      assert.isBelow(NodeFS.statSync(realFile).size, sizeBefore);
      assert.equal(scalar(home.dbPath, "PRAGMA auto_vacuum"), 2);
      // Free space is measured where the copy is written: next to the file itself.
      assert.isTrue(volumes.every((directory) => directory === NodeFS.realpathSync(elsewhere)));
      assert.deepEqual(doctorCopies(elsewhere), []);
    }),
  );

  it.live("says there is nothing to do for a missing database", () =>
    Effect.gen(function* () {
      const baseDir = NodePath.join(root, "empty-home");
      const stateDir = NodePath.join(baseDir, "userdata");
      NodeFS.mkdirSync(stateDir, { recursive: true });
      const target = {
        dbPath: NodePath.join(stateDir, "state.sqlite"),
        stateDir,
        commandPrefix: "ryco",
      };
      const inspection = yield* inspectDatabase(
        target,
        { estimate: false },
        makePorts(newRecorder()),
      );
      assert.equal(inspection.exists, false);
      assert.match(inspection.blockers[0] ?? "", /no database/);
      const result = yield* repairDatabase(
        target,
        { thorough: false, restartService: true },
        makePorts(newRecorder()),
      );
      assert.equal(result.exitCode, 2);
      assert.isFalse(NodeFS.existsSync(target.dbPath));
    }),
  );
});
