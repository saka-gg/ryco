// @effect-diagnostics nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrationEntries, runMigrations } from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";
import { generateFixtureHome } from "./generate-fixture-home.ts";
import {
  checkSeedCompatibility,
  isDerivedSeedTable,
  loadCheckoutSchema,
  SEED_SKIPPED_EXIT_CODE,
  SEED_TABLE_POLICY,
  seedDevHome,
  type SeedDevHomeInput,
  type SeedDevHomeResult,
} from "./seed-dev-home.ts";

const directory = mkdtempSync(join(tmpdir(), "ryco-seed-dev-home-test-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

let caseCounter = 0;
const freshDir = (label: string) => join(directory, `${label}-${(caseCounter += 1)}`);

const runSeed = (input: SeedDevHomeInput) => Effect.runPromise(seedDevHome(input));

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

const seedTempFiles = (stateDir: string) =>
  existsSync(stateDir) ? readdirSync(stateDir).filter((entry) => entry.includes(".seed-")) : [];

interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly required: number;
  readonly defaultValue: unknown;
  readonly pk: number;
}

const insertValues = (db: DatabaseSync, table: string, row: Record<string, SQLInputValue>) => {
  const names = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
  ).run(...names.map((name) => row[name] ?? null));
};

/** Inserts a row, filling required columns the test does not care about. */
const insertRow = (db: DatabaseSync, table: string, values: Record<string, SQLInputValue>) => {
  const columns = db
    .prepare(
      `SELECT name, type, "notnull" AS required, dflt_value AS defaultValue, pk FROM pragma_table_info(?)`,
    )
    .all(table) as unknown as Array<ColumnInfo>;
  const row: Record<string, SQLInputValue> = {};
  for (const column of columns) {
    if (column.name in values) {
      row[column.name] = values[column.name] ?? null;
    } else if (
      (column.required || column.pk > 0) &&
      column.defaultValue === null &&
      !(column.pk > 0 && /INT/i.test(column.type))
    ) {
      row[column.name] = /INT|REAL|NUM/i.test(column.type) ? 0 : `test-${table}-${column.name}`;
    }
  }
  insertValues(db, table, row);
};

const cloneRow = (
  db: DatabaseSync,
  table: string,
  key: { readonly column: string; readonly value: string },
  overrides: Record<string, SQLInputValue>,
) => {
  const row = db.prepare(`SELECT * FROM ${table} WHERE ${key.column} = ?`).get(key.value) as Record<
    string,
    SQLInputValue
  >;
  insertValues(db, table, { ...row, ...overrides });
};

const count = (db: DatabaseSync, query: string, ...params: Array<SQLInputValue>) =>
  Number((db.prepare(query).get(...params) as { readonly count: number }).count);

const threadIds = (db: DatabaseSync) =>
  (
    db.prepare("SELECT thread_id FROM projection_threads ORDER BY thread_id").all() as Array<{
      thread_id: string;
    }>
  ).map((row) => row.thread_id);

/** One project's threads, by thread id: an old timestamp, the given one, and how it differs. */
const addThread = (db: DatabaseSync, threadId: string, overrides: Record<string, SQLInputValue>) =>
  cloneRow(
    db,
    "projection_threads",
    { column: "thread_id", value: "fixture-thread-7" },
    { thread_id: threadId, updated_at: "2020-01-01T00:00:00.000Z", ...overrides },
  );

const EXPECTED_KEPT_THREADS = [
  // Project 1, two families: thread 7 with its subagent and its fork, then thread 4.
  "fixture-thread-4",
  "fixture-thread-7",
  "seed-child-of-7",
  "seed-fork-of-7",
  // Project 2: its two unarchived threads.
  "fixture-thread-2",
  "fixture-thread-5",
  // Project 3: the two most recent of four.
  "fixture-thread-9",
  "fixture-thread-12",
].toSorted();

/**
 * A fixture home written by the real engine, plus every shape the prune must handle. Lives in a
 * `dev` state directory, as the main dev home's does.
 */
let sourcePath = "";
let sourceSequence = 0;

beforeAll(async () => {
  const fixture = await generateFixtureHome({
    out: join(directory, "fixture"),
    projects: 3,
    threads: 12,
    turns: 2,
    archivedShare: 0.25,
    usageReportsPerTurn: 1,
    seed: 7,
  });
  const db = new DatabaseSync(fixture.dbPath);
  try {
    db.exec("BEGIN");
    // A project that was deleted and one that is a chat, each with a thread.
    cloneRow(
      db,
      "projection_projects",
      { column: "project_id", value: "fixture-project-1" },
      { project_id: "seed-deleted-project", deleted_at: "2026-01-01T00:00:00.000Z" },
    );
    cloneRow(
      db,
      "projection_projects",
      { column: "project_id", value: "fixture-project-1" },
      { project_id: "seed-chat-project", kind: "chat" },
    );
    addThread(db, "seed-thread-of-deleted-project", {
      project_id: "seed-deleted-project",
      updated_at: "2030-02-01T00:00:00.000Z",
    });
    addThread(db, "seed-thread-of-chat-project", {
      project_id: "seed-chat-project",
      updated_at: "2030-02-01T00:00:00.000Z",
    });

    // Project 1: thread 7 gains a subagent and a fork, and recent threads that are live,
    // limited or trashed must never win a slot.
    db.exec(
      "UPDATE projection_threads SET updated_at = '2026-01-01T00:00:00.000Z' WHERE thread_id = 'fixture-thread-1'",
    );
    addThread(db, "seed-child-of-7", { parent_thread_id: "fixture-thread-7" });
    addThread(db, "seed-fork-of-7", {
      lineage_parent_thread_id: "fixture-thread-7",
      lineage_root_thread_id: "fixture-thread-7",
      lineage_relationship: "fork",
    });
    addThread(db, "seed-running", { updated_at: "2030-01-09T00:00:00.000Z" });
    insertRow(db, "projection_thread_sessions", {
      thread_id: "seed-running",
      status: "running",
      updated_at: "2030-01-09T00:00:00.000Z",
    });
    addThread(db, "seed-child-of-running", {
      parent_thread_id: "seed-running",
      updated_at: "2030-01-09T00:00:00.000Z",
    });
    addThread(db, "seed-pending-turn", { updated_at: "2030-01-08T00:00:00.000Z" });
    insertRow(db, "projection_turns", {
      thread_id: "seed-pending-turn",
      turn_id: "seed-pending-turn-1",
      state: "pending",
      requested_at: "2030-01-08T00:00:00.000Z",
      checkpoint_files_json: "[]",
    });
    addThread(db, "seed-usage-limited", {
      updated_at: "2030-01-07T00:00:00.000Z",
      usage_limit_json: "{}",
    });
    addThread(db, "seed-trashed", {
      updated_at: "2030-01-06T00:00:00.000Z",
      trashed_at: "2030-01-06T00:00:00.000Z",
    });
    addThread(db, "seed-orphan-child", {
      parent_thread_id: "seed-missing-parent",
      updated_at: "2030-01-05T00:00:00.000Z",
    });
    // A project's main checkout stays even when no kept thread uses it.
    db.exec(
      "UPDATE projection_worktrees SET origin = 'main' WHERE worktree_id = 'fixture-worktree-3-3'",
    );
    db.exec(
      "UPDATE projection_projects SET custom_avatar_content_hash = 'abc' WHERE project_id = 'fixture-project-1'",
    );

    // State that would make a seeded server act on its own.
    insertRow(db, "auth_sessions", { session_id: "seed-session" });
    insertRow(db, "storage_owned_entries", { id: "seed-owned", state: "owned" });
    insertRow(db, "managed_worktree_relocations", { worktree_id: "seed-moving", state: "moving" });
    insertRow(db, "agent_control_automations", {
      automation_id: "seed-automation",
      revision: 1,
      enabled: 1,
      cancelled: 0,
    });
    insertRow(db, "restart_continuations", {
      thread_id: "fixture-thread-7",
      source_turn_id: "seed-turn",
      kind: "in-flight",
      status: "pending",
    });
    insertRow(db, "provider_session_runtime", { thread_id: "fixture-thread-7" });
    insertRow(db, "orchestration_command_receipts", { command_id: "seed-command" });
    insertRow(db, "orchestration_events", {
      event_id: "seed-pull-request-event",
      aggregate_kind: "pull-request",
      stream_id: "seed-pull-request",
      stream_version: 1,
      event_type: "pull-request.updated",
      occurred_at: "2030-01-01T00:00:00.000Z",
      actor_kind: "server",
      payload_json: "{}",
      metadata_json: "{}",
    });

    // Another branch's table and trigger.
    db.exec(`
      CREATE TABLE branch_only_table (id TEXT PRIMARY KEY);
      INSERT INTO branch_only_table VALUES ('branch-row');
      CREATE TRIGGER branch_only_trigger AFTER DELETE ON projection_threads
      BEGIN INSERT OR IGNORE INTO branch_only_table VALUES (old.thread_id); END;
    `);
    db.exec("COMMIT");
    sourceSequence = count(
      db,
      "SELECT seq AS count FROM sqlite_sequence WHERE name = 'orchestration_events'",
    );
  } finally {
    db.close();
  }

  // The main dev home's layout: <home>/dev/state.sqlite and its side files.
  sourcePath = join(directory, "source-home", "dev", "state.sqlite");
  mkdirSync(join(dirname(sourcePath), "project-avatars"), { recursive: true });
  mkdirSync(join(dirname(sourcePath), "secrets"), { recursive: true });
  copyFileSync(fixture.dbPath, sourcePath);
  writeFileSync(join(dirname(sourcePath), "keybindings.json"), "[]\n");
  writeFileSync(join(dirname(sourcePath), "settings.json"), '{"secret":"no"}\n');
  writeFileSync(join(dirname(sourcePath), "secrets", "key"), "secret\n");
  writeFileSync(join(dirname(sourcePath), "project-avatars", "fixture-project-1.png"), "png");
  writeFileSync(join(dirname(sourcePath), "project-avatars", "fixture-project-9.png"), "png");
}, 120_000);

describe("checkSeedCompatibility", () => {
  const ledger = (entries: ReadonlyArray<readonly [number, string]>) =>
    entries.map(([id, name]) => ({ id, name }));
  const checkout = (entries: ReadonlyArray<readonly [number, string]>) => entries;
  const main = Array.from({ length: 93 }, (_, index) => [index + 1, `M${index + 1}`] as const);

  it("accepts identical ledgers and a source that is behind", () => {
    expect(checkSeedCompatibility(ledger(main), checkout(main))).toEqual({ ok: true });
    expect(checkSeedCompatibility(ledger(main.slice(0, 92)), checkout(main))).toEqual({ ok: true });
  });

  it("refuses a source with a newer schema", () => {
    const result = checkSeedCompatibility(ledger([...main, [94, "OtherBranch"]]), checkout(main));
    expect(result).toMatchObject({ ok: false, reason: "schema-newer" });
    expect(result.ok ? "" : result.detail).toContain("schema 94 (OtherBranch)");
  });

  it("refuses a slot the migrator would skip", () => {
    expect(
      checkSeedCompatibility(ledger([...main, [94, "Bar"]]), checkout([...main, [94, "Foo"]])),
    ).toMatchObject({ ok: false, reason: "slot-collision" });
    expect(
      checkSeedCompatibility(
        ledger([...main, [94, "Bar"]]),
        checkout([...main, [94, "Foo"], [95, "Baz"]]),
      ),
    ).toMatchObject({ ok: false, reason: "slot-collision" });
  });

  it("accepts historic divergence below the last agreeing migration", () => {
    const diverged = main.map(([id, name]) =>
      id === 42 ? ([id, "ProjectionThreadsSettled"] as const) : ([id, name] as const),
    );
    expect(checkSeedCompatibility(ledger(diverged.slice(0, 92)), checkout(main))).toEqual({
      ok: true,
    });
  });

  it("matches this checkout's own ledger", () => {
    expect(
      checkSeedCompatibility(
        migrationEntries.map(([id, name]) => ({ id, name })),
        migrationEntries,
      ),
    ).toEqual({ ok: true });
  });
});

describe("SEED_TABLE_POLICY", () => {
  it("classifies every table this checkout's migrations create", async () => {
    const schema = await Effect.runPromise(loadCheckoutSchema);
    const unclassified = [...schema.tables].filter(
      (table) => SEED_TABLE_POLICY[table] === undefined && !isDerivedSeedTable(table),
    );
    expect(
      unclassified,
      "classify it in SEED_TABLE_POLICY (apps/server/scripts/seed-dev-home.ts)",
    ).toEqual([]);
    const stale = Object.keys(SEED_TABLE_POLICY).filter((table) => !schema.tables.has(table));
    expect(stale, "remove tables main no longer has from SEED_TABLE_POLICY").toEqual([]);
  });
});

describe("seedDevHome", () => {
  let result: SeedDevHomeResult;
  let stateDir = "";
  let sourceHashBefore = "";

  beforeAll(async () => {
    stateDir = join(freshDir("seeded"), "dev");
    sourceHashBefore = sha256(sourcePath);
    result = await runSeed({
      sourcePath,
      stateDir,
      threadsPerProject: 2,
      productionHome: join(directory, "production-home"),
    });
  }, 120_000);

  it("keeps settled thread families of repository projects and drops the rest", () => {
    expect(result).toMatchObject({ _tag: "Seeded", threads: EXPECTED_KEPT_THREADS.length });
    const db = new DatabaseSync(join(stateDir, "state.sqlite"), { readOnly: true });
    try {
      expect(threadIds(db)).toEqual(EXPECTED_KEPT_THREADS);
      expect(
        (
          db
            .prepare("SELECT project_id FROM projection_projects ORDER BY project_id")
            .all() as Array<{
            project_id: string;
          }>
        ).map((row) => row.project_id),
      ).toEqual(["fixture-project-1", "fixture-project-2", "fixture-project-3"]);
      expect(
        (
          db
            .prepare("SELECT worktree_id FROM projection_worktrees ORDER BY worktree_id")
            .all() as Array<{
            worktree_id: string;
          }>
        ).map((row) => row.worktree_id),
      ).toEqual(["fixture-worktree-1-1", "fixture-worktree-3-3"]);
      // Rows of dropped threads went with them.
      for (const table of [
        "projection_thread_messages",
        "projection_turns",
        "projection_thread_sessions",
      ]) {
        expect(
          count(
            db,
            `SELECT COUNT(*) AS count FROM ${table} WHERE thread_id NOT IN (SELECT thread_id FROM projection_threads)`,
          ),
          table,
        ).toBe(0);
      }
    } finally {
      db.close();
    }
  });

  it("leaves nothing a server would act on by itself", () => {
    const db = new DatabaseSync(join(stateDir, "state.sqlite"), { readOnly: true });
    try {
      for (const [table, policy] of Object.entries(SEED_TABLE_POLICY)) {
        if (policy !== "clear") continue;
        expect(count(db, `SELECT COUNT(*) AS count FROM ${table}`), table).toBe(0);
      }
      expect(count(db, "SELECT COUNT(*) AS count FROM branch_only_table")).toBe(0);
      expect(
        count(db, "SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'branch_only_trigger'"),
      ).toBe(0);
      expect(
        count(
          db,
          "SELECT COUNT(*) AS count FROM projection_thread_sessions WHERE provider_session_id IS NOT NULL OR provider_thread_id IS NOT NULL OR runtime_session_id IS NOT NULL",
        ),
      ).toBe(0);
    } finally {
      db.close();
    }
    expect(result).toMatchObject({
      clearedUnknownTables: ["branch_only_table"],
      droppedTriggers: ["branch_only_trigger"],
    });
  });

  it("keeps exactly the event streams of kept aggregates", () => {
    const db = new DatabaseSync(join(stateDir, "state.sqlite"), { readOnly: true });
    try {
      expect(
        count(
          db,
          "SELECT COUNT(*) AS count FROM orchestration_events WHERE aggregate_kind NOT IN ('project', 'thread', 'worktree')",
        ),
      ).toBe(0);
      expect(
        count(
          db,
          `SELECT COUNT(*) AS count FROM orchestration_events WHERE
            (aggregate_kind = 'thread' AND stream_id NOT IN (SELECT thread_id FROM projection_threads))
            OR (aggregate_kind = 'project' AND stream_id NOT IN (SELECT project_id FROM projection_projects))
            OR (aggregate_kind = 'worktree' AND stream_id NOT IN (SELECT worktree_id FROM projection_worktrees))`,
        ),
      ).toBe(0);
      expect(
        count(
          db,
          "SELECT COUNT(*) AS count FROM orchestration_events WHERE stream_id = 'fixture-thread-7'",
        ),
      ).toBeGreaterThan(0);
      // The message search index follows the kept messages.
      const indexed = count(db, "SELECT COUNT(*) AS count FROM projection_message_search_ids");
      expect(indexed).toBeGreaterThan(0);
      expect(
        count(
          db,
          "SELECT COUNT(*) AS count FROM projection_message_search_ids WHERE message_id IN (SELECT message_id FROM projection_thread_messages)",
        ),
      ).toBe(indexed);
      expect(
        count(
          db,
          "SELECT COUNT(*) AS count FROM projection_message_chunks WHERE message_id NOT IN (SELECT message_id FROM projection_thread_messages)",
        ),
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("keeps new event sequences above every projector cursor", () => {
    const path = join(stateDir, "state.sqlite");
    const db = new DatabaseSync(path, { readOnly: true });
    let cursor = 0;
    try {
      expect(
        count(db, "SELECT seq AS count FROM sqlite_sequence WHERE name = 'orchestration_events'"),
      ).toBe(sourceSequence);
      cursor = count(db, "SELECT MAX(last_applied_sequence) AS count FROM projection_state");
      expect(cursor).toBeGreaterThan(0);
    } finally {
      db.close();
    }
    // On a scratch copy, so the other checks see the seed's own result.
    const scratch = join(freshDir("sequence"), "state.sqlite");
    mkdirSync(dirname(scratch), { recursive: true });
    copyFileSync(path, scratch);
    const writer = new DatabaseSync(scratch);
    try {
      insertRow(writer, "orchestration_events", {
        event_id: "seed-new-event",
        aggregate_kind: "thread",
        stream_id: "fixture-thread-7",
        stream_version: 9_999,
        event_type: "thread.meta-updated",
        occurred_at: "2030-01-01T00:00:00.000Z",
        actor_kind: "server",
        payload_json: "{}",
        metadata_json: "{}",
      });
      expect(
        count(
          writer,
          "SELECT sequence AS count FROM orchestration_events WHERE event_id = 'seed-new-event'",
        ),
      ).toBeGreaterThan(cursor);
    } finally {
      writer.close();
    }
  });

  it("publishes a private WAL database on this checkout's schema", async () => {
    const path = join(stateDir, "state.sqlite");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    } finally {
      db.close();
    }
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(seedTempFiles(stateDir)).toEqual([]);
    const executed = await Effect.runPromise(
      runMigrations().pipe(Effect.provide(NodeSqliteClient.layer({ filename: path }))),
    );
    expect(executed).toEqual([]);
  });

  it("copies keybindings and kept avatars, nothing else", () => {
    expect(result).toMatchObject({
      copiedSideFiles: ["keybindings.json", join("project-avatars", "fixture-project-1.png")],
    });
    expect(existsSync(join(stateDir, "settings.json"))).toBe(false);
    expect(existsSync(join(stateDir, "secrets"))).toBe(false);
    expect(existsSync(join(stateDir, "project-avatars", "fixture-project-9.png"))).toBe(false);
  });

  it("never writes the source database", () => {
    expect(sha256(sourcePath)).toBe(sourceHashBefore);
  });

  it("copies only committed rows while another connection writes the source", async () => {
    const writer = new DatabaseSync(sourcePath);
    const target = join(freshDir("concurrent"), "dev");
    try {
      writer.exec("BEGIN IMMEDIATE");
      cloneRow(
        writer,
        "projection_projects",
        { column: "project_id", value: "fixture-project-2" },
        { project_id: "seed-uncommitted-project" },
      );
      const concurrent = await runSeed({
        sourcePath,
        stateDir: target,
        threadsPerProject: 2,
        productionHome: join(directory, "production-home"),
      });
      expect(concurrent._tag).toBe("Seeded");
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
    const db = new DatabaseSync(join(target, "state.sqlite"), { readOnly: true });
    try {
      expect(
        count(
          db,
          "SELECT COUNT(*) AS count FROM projection_projects WHERE project_id = 'seed-uncommitted-project'",
        ),
      ).toBe(0);
      expect(count(db, "SELECT COUNT(*) AS count FROM projection_projects")).toBe(3);
    } finally {
      db.close();
    }
  });
});

describe("seedDevHome target and source guards", () => {
  const productionHome = () => join(directory, "production-home");

  it("leaves a database that already exists alone", async () => {
    const stateDir = join(freshDir("exists"), "dev");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "state.sqlite"), "existing");
    const result = await runSeed({ sourcePath, stateDir, productionHome: productionHome() });
    expect(result).toMatchObject({ _tag: "Skipped", reason: "target-exists" });
    expect(readFileSync(join(stateDir, "state.sqlite"), "utf8")).toBe("existing");
    expect(seedTempFiles(stateDir)).toEqual([]);
  });

  it("does not replace a database created while it seeded", async () => {
    const stateDir = join(freshDir("race"), "dev");
    const result = await runSeed({
      sourcePath,
      stateDir,
      productionHome: productionHome(),
      beforePublish: Effect.sync(() => writeFileSync(join(stateDir, "state.sqlite"), "raced")),
    });
    expect(result).toMatchObject({ _tag: "Skipped", reason: "target-exists" });
    expect(readFileSync(join(stateDir, "state.sqlite"), "utf8")).toBe("raced");
    expect(seedTempFiles(stateDir)).toEqual([]);
  });

  it("removes temp files of a seed that died", async () => {
    const stateDir = join(freshDir("stale"), "dev");
    mkdirSync(stateDir, { recursive: true });
    // No live process has pid 2^22 + 1 on the platforms CI runs.
    const stale = join(stateDir, "state.sqlite.seed-4194305-deadbeef.tmp");
    writeFileSync(stale, "stale");
    const result = await runSeed({ sourcePath, stateDir, productionHome: productionHome() });
    expect(result._tag).toBe("Seeded");
    expect(existsSync(stale)).toBe(false);
  });

  it("never reads the production home's data", async () => {
    const production = join(freshDir("production"), "home");
    const productionDb = join(production, "userdata", "state.sqlite");
    mkdirSync(dirname(productionDb), { recursive: true });
    copyFileSync(sourcePath, productionDb);
    const stateDir = join(freshDir("from-production"), "dev");
    expect(
      await runSeed({
        sourcePath: productionDb,
        stateDir,
        productionHome: production,
        allowUserdataSource: true,
      }),
    ).toMatchObject({ _tag: "Skipped", reason: "source-is-production" });
    expect(existsSync(join(stateDir, "state.sqlite"))).toBe(false);
  });

  it("refuses any other userdata directory unless allowed", async () => {
    const elsewhere = join(freshDir("other-production"), "userdata", "state.sqlite");
    mkdirSync(dirname(elsewhere), { recursive: true });
    copyFileSync(sourcePath, elsewhere);
    expect(
      await runSeed({
        sourcePath: elsewhere,
        stateDir: join(freshDir("from-userdata"), "dev"),
        productionHome: productionHome(),
      }),
    ).toMatchObject({ _tag: "Skipped", reason: "source-is-production" });
    expect(
      await runSeed({
        sourcePath: elsewhere,
        stateDir: join(freshDir("from-userdata-allowed"), "dev"),
        productionHome: productionHome(),
        allowUserdataSource: true,
      }),
    ).toMatchObject({ _tag: "Seeded" });
  });

  it("refuses to seed a database from itself or from nothing", async () => {
    expect(
      await runSeed({
        sourcePath,
        stateDir: dirname(sourcePath),
        productionHome: productionHome(),
      }),
    ).toMatchObject({ _tag: "Skipped", reason: "source-is-target" });
    expect(
      await runSeed({
        sourcePath: join(directory, "missing.sqlite"),
        stateDir: join(freshDir("missing"), "dev"),
        productionHome: productionHome(),
      }),
    ).toMatchObject({ _tag: "Skipped", reason: "source-missing" });
  });

  it("rejects a thread count it cannot use", async () => {
    const exit = await Effect.runPromiseExit(
      seedDevHome({
        sourcePath,
        stateDir: join(freshDir("bad-count"), "dev"),
        threadsPerProject: Number.NaN,
        productionHome: productionHome(),
      }),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("refuses a source with a newer schema before copying it", async () => {
    const newer = join(freshDir("newer"), "dev", "state.sqlite");
    mkdirSync(dirname(newer), { recursive: true });
    copyFileSync(sourcePath, newer);
    const db = new DatabaseSync(newer);
    try {
      db.exec(
        "INSERT INTO effect_sql_migrations (migration_id, name) VALUES (9999, 'FromTheFuture')",
      );
    } finally {
      db.close();
    }
    const stateDir = join(freshDir("from-newer"), "dev");
    expect(
      await runSeed({ sourcePath: newer, stateDir, productionHome: productionHome() }),
    ).toMatchObject({ _tag: "Skipped", reason: "schema-newer" });
    expect(seedTempFiles(stateDir)).toEqual([]);
    expect(existsSync(join(stateDir, "state.sqlite"))).toBe(false);
  });
});

// scripts/dev-runner.ts reads these exit codes (and keeps its own copy of the skip code).
describe("seed-dev-home CLI", () => {
  const script = join(import.meta.dirname, "seed-dev-home.ts");
  const runCli = (entry: string, args: ReadonlyArray<string>) =>
    spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", timeout: 60_000 });

  it("exits with the skip code, through a symlinked path too", () => {
    // macOS reaches /tmp through a symlink; the CLI must still run there, not exit 0 unseeded.
    const entry =
      process.platform === "win32" ? script : join(freshDir("cli-link"), "seed-dev-home.ts");
    if (entry !== script) {
      mkdirSync(dirname(entry), { recursive: true });
      symlinkSync(script, entry);
    }
    const result = runCli(entry, [
      "--source",
      join(directory, "missing.sqlite"),
      "--state-dir",
      join(freshDir("cli-missing"), "dev"),
    ]);
    expect(SEED_SKIPPED_EXIT_CODE).toBe(3);
    expect(result.status, result.stderr).toBe(SEED_SKIPPED_EXIT_CODE);
    expect(result.stdout).toContain("skipped (source-missing)");
  });

  it("exits 0 when the home already has a database, and 2 for bad arguments", () => {
    const stateDir = join(freshDir("cli-exists"), "dev");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "state.sqlite"), "existing");
    const exists = runCli(script, ["--source", sourcePath, "--state-dir", stateDir]);
    expect(exists.status, exists.stderr).toBe(0);
    expect(exists.stdout).toContain("skipped (target-exists)");

    const badCount = runCli(script, [
      "--source",
      sourcePath,
      "--state-dir",
      join(freshDir("cli-bad-count"), "dev"),
      "--threads-per-project",
      "ten",
    ]);
    expect(badCount.status).toBe(2);
    expect(badCount.stderr).toContain("Usage:");
  });
});
