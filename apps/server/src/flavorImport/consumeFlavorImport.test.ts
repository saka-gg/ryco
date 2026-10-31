// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  FLAVOR_IMPORT_REQUEST_FILE_NAME,
  FLAVOR_IMPORT_RESULT_FILE_NAME,
  formatFlavorImportRequest,
} from "@ryco/shared/flavorImport";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Logger } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  acquireDatabaseMaintenance,
  acquireDatabaseServer,
  asDatabaseOwner,
} from "../persistence/databaseOwnerLock.ts";
import { databaseRestoreJournalPath } from "../persistence/databaseRestoreJournal.ts";
import { makePrivateSqliteCopyLive, makeRuntimeSqliteLayer } from "../persistence/Layers/Sqlite.ts";
import { runMigrations, SUPPORTED_MIGRATION_ID } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  consumeFlavorImport,
  FLAVOR_IMPORT_MESSAGES,
  type FlavorImportInput,
  type FlavorImportOutcome,
} from "./consumeFlavorImport.ts";

const { join } = NodePath;
const directory = NodeFS.mkdtempSync(join(NodeOS.tmpdir(), "ryco-flavor-import-test-"));
const templateDb = join(directory, "template.sqlite");
let caseCounter = 0;

beforeAll(async () => {
  await Effect.runPromise(
    runMigrations().pipe(
      Effect.provide(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: templateDb }), Logger.layer([])),
      ),
    ),
  );
}, 60_000);

afterAll(() => NodeFS.rmSync(directory, { recursive: true, force: true }));

/** Inserts a row, filling every required column without a default that `values` leaves out. */
const insertRow = (
  db: DatabaseSync,
  table: string,
  values: Record<string, string | number | null>,
) => {
  const columns = db
    .prepare(
      `SELECT name, type, "notnull" AS required, dflt_value AS defaultValue FROM pragma_table_info(?)`,
    )
    .all(table) as Array<{ name: string; type: string; required: number; defaultValue: unknown }>;
  const row: Record<string, string | number | null> = { ...values };
  for (const column of columns) {
    if (column.name in row || column.required === 0 || column.defaultValue !== null) continue;
    row[column.name] = /INT/i.test(column.type)
      ? 1
      : `${table}-${column.name}-${(caseCounter += 1)}`;
  }
  const names = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
  ).run(...names.map((name) => row[name] ?? null));
};

const write = (path: string, contents: string) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, contents);
};

/** The files of the node itself and of the desktop app beside Ryco's state, never copied. */
const NEVER_COPIED = [
  "environment-id",
  "anonymous-id",
  "hub-identity.json",
  "hub-push.json",
  "secrets/server-signing-key.bin",
  "native-security/hub-session-token",
  "saved-environments.json",
  "desktop-settings.json",
  "client-settings.json",
  "logs/server.log",
  "node-update/marker.json",
  "backups/state-v100-manual-20261030T000000000Z.sqlite",
  "server-runtime.json",
  "node.json",
  "cli-remotes.json",
  "state.sqlite.owner",
  "provider-sign-in/claude/token",
];

interface Fixture {
  readonly root: string;
  readonly stableHome: string;
  readonly stableState: string;
  readonly stableDb: string;
  readonly nightlyHome: string;
  readonly nightlyState: string;
  readonly nightlyDb: string;
}

/** Ryco's home with its work and its node files, and Ryco Nightly's home with its own. */
const makeFixture = (): Fixture => {
  const root = join(directory, `case-${(caseCounter += 1)}`);
  const stableHome = join(root, ".ryco");
  const stableState = join(stableHome, "userdata");
  const stableDb = join(stableState, "state.sqlite");
  const nightlyHome = join(root, ".ryco-nightly");
  const nightlyState = join(nightlyHome, "userdata");
  const nightlyDb = join(nightlyState, "state.sqlite");
  for (const [dbPath, threadId] of [
    [stableDb, "stable-thread"],
    [nightlyDb, "nightly-thread"],
  ] as const) {
    NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
    NodeFS.copyFileSync(templateDb, dbPath);
    const db = new DatabaseSync(dbPath);
    try {
      insertRow(db, "projection_threads", { thread_id: threadId, project_id: "project-1" });
    } finally {
      db.close();
    }
  }
  write(join(stableState, "settings.json"), JSON.stringify({ theme: "stable" }));
  write(join(stableState, "attachments", "thread-1", "image.png"), "stable image");
  write(join(stableState, "task-files", "file-1"), "stable task file");
  for (const name of NEVER_COPIED) write(join(stableState, name), `stable ${name}`);
  write(join(stableHome, "caches", "provider-status.json"), "stable cache");

  write(join(nightlyState, "settings.json"), JSON.stringify({ theme: "nightly" }));
  write(join(nightlyState, "keybindings.json"), JSON.stringify([{ key: "nightly" }]));
  write(join(nightlyState, "attachments", "thread-2", "image.png"), "nightly image");
  write(join(nightlyState, "environment-id"), "nightly-environment");
  write(join(nightlyState, "hub-identity.json"), "nightly identity");
  return { root, stableHome, stableState, stableDb, nightlyHome, nightlyState, nightlyDb };
};

const requestPath = (fixture: Fixture) =>
  join(fixture.nightlyHome, FLAVOR_IMPORT_REQUEST_FILE_NAME);
const resultPath = (fixture: Fixture) => join(fixture.nightlyHome, FLAVOR_IMPORT_RESULT_FILE_NAME);

const writeRequest = (
  fixture: Fixture,
  sourceHomeDir = fixture.stableHome,
  requestedAt = new Date(),
) => write(requestPath(fixture), formatFlavorImportRequest({ sourceHomeDir, requestedAt }));

const importInto = (fixture: Fixture, overrides: Partial<FlavorImportInput> = {}) =>
  consumeFlavorImport({
    baseDir: fixture.nightlyHome,
    stateDir: fixture.nightlyState,
    dbPath: fixture.nightlyDb,
    allowedSourceHome: fixture.stableHome,
    supportedMigrationId: SUPPORTED_MIGRATION_ID,
    openSqlite: makeRuntimeSqliteLayer,
    migratedCopy: makePrivateSqliteCopyLive,
    asDatabaseOwner,
    restoreJournalPath: databaseRestoreJournalPath,
    ...overrides,
  }).pipe(Effect.provide(Logger.layer([])));

const run = (
  fixture: Fixture,
  overrides: Partial<FlavorImportInput> = {},
): Promise<FlavorImportOutcome> => Effect.runPromise(importInto(fixture, overrides));

const threadIds = (dbPath: string) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (
      db.prepare("SELECT thread_id FROM projection_threads ORDER BY thread_id").all() as Array<{
        thread_id: string;
      }>
    ).map((row) => row.thread_id);
  } finally {
    db.close();
  }
};

const countRows = (dbPath: string, sql: string) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number((db.prepare(sql).get() as { count: number }).count);
  } finally {
    db.close();
  }
};

/** Every path under `root` with its size and modification time: what "unchanged" compares. */
const snapshot = (root: string) => {
  const entries: Array<string> = [];
  const visit = (relative: string) => {
    for (const entry of NodeFS.readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      const info = NodeFS.lstatSync(join(root, path));
      entries.push(`${path} ${info.isDirectory() ? "dir" : `${info.size} ${info.mtimeMs}`}`);
      if (entry.isDirectory()) visit(path);
    }
  };
  visit("");
  return entries.toSorted();
};

const readResult = (fixture: Fixture) =>
  JSON.parse(NodeFS.readFileSync(resultPath(fixture), "utf8")) as {
    version: number;
    ok: boolean;
    error?: string;
  };

const read = (path: string) => NodeFS.readFileSync(path, "utf8");

/** Nightly still has exactly its own data, and nothing of a copy was left behind. */
const expectNightlyUnchanged = (fixture: Fixture) => {
  expect(threadIds(fixture.nightlyDb)).toEqual(["nightly-thread"]);
  expect(JSON.parse(read(join(fixture.nightlyState, "settings.json")))).toEqual({
    theme: "nightly",
  });
  expect(NodeFS.existsSync(join(fixture.nightlyState, "keybindings.json"))).toBe(true);
  expect(read(join(fixture.nightlyState, "attachments", "thread-2", "image.png"))).toBe(
    "nightly image",
  );
  expect(NodeFS.existsSync(join(fixture.nightlyState, "attachments", "thread-1"))).toBe(false);
  expect(
    NodeFS.readdirSync(fixture.nightlyHome).filter((name) => name.startsWith(".flavor-import-")),
  ).toEqual([]);
};

const expectRefused = (outcome: FlavorImportOutcome, fixture: Fixture, error: string) => {
  expect(outcome).toEqual({ _tag: "Refused", error });
  expect(readResult(fixture)).toMatchObject({ version: 1, ok: false, error });
  expect(NodeFS.existsSync(requestPath(fixture))).toBe(false);
  expectNightlyUnchanged(fixture);
};

describe("consumeFlavorImport", () => {
  it("does nothing without a request", async () => {
    const fixture = makeFixture();
    const before = snapshot(fixture.nightlyHome);
    expect(await run(fixture)).toEqual({ _tag: "NotRequested" });
    expect(snapshot(fixture.nightlyHome)).toEqual(before);
  });

  it("copies Ryco's database and the allowlisted files, nothing else, and never writes into Ryco's home", async () => {
    const fixture = makeFixture();
    // Leftovers in Nightly: an old WAL that must not replay, and a crashed copy's staging.
    write(`${fixture.nightlyDb}-wal`, "not a write-ahead log of this database");
    write(join(fixture.nightlyHome, ".flavor-import-staging-old", "state.sqlite"), "old copy");
    writeRequest(fixture);
    const stableBefore = snapshot(fixture.stableHome);

    const outcome = await run(fixture);

    expect(outcome).toMatchObject({
      _tag: "Copied",
      schema: SUPPORTED_MIGRATION_ID,
      entries: ["settings.json", "attachments", "task-files"],
    });
    expect(readResult(fixture)).toMatchObject({ version: 1, ok: true });
    expect(readResult(fixture).error).toBeUndefined();
    expect(NodeFS.existsSync(requestPath(fixture))).toBe(false);
    expect(snapshot(fixture.stableHome)).toEqual(stableBefore);

    expect(threadIds(fixture.nightlyDb)).toEqual(["stable-thread"]);
    expect(JSON.parse(read(join(fixture.nightlyState, "settings.json")))).toEqual({
      theme: "stable",
    });
    expect(read(join(fixture.nightlyState, "attachments", "thread-1", "image.png"))).toBe(
      "stable image",
    );
    expect(read(join(fixture.nightlyState, "task-files", "file-1"))).toBe("stable task file");
    // Nightly ends up with Ryco's entries: its own attachments and keybindings went with its data.
    expect(NodeFS.existsSync(join(fixture.nightlyState, "attachments", "thread-2"))).toBe(false);
    expect(NodeFS.existsSync(join(fixture.nightlyState, "keybindings.json"))).toBe(false);
    expect(NodeFS.existsSync(`${fixture.nightlyDb}-wal`)).toBe(false);
    // Nightly stays a node of its own: none of Ryco's node files arrive, its own stay.
    for (const name of NEVER_COPIED) {
      const path = join(fixture.nightlyState, name);
      if (NodeFS.existsSync(path)) expect(read(path), name).not.toContain("stable");
    }
    expect(read(join(fixture.nightlyState, "environment-id"))).toBe("nightly-environment");
    expect(read(join(fixture.nightlyState, "hub-identity.json"))).toBe("nightly identity");
    expect(NodeFS.existsSync(join(fixture.nightlyHome, "caches"))).toBe(false);
    expect(NodeFS.readdirSync(fixture.nightlyState).toSorted()).toEqual(
      [
        "attachments",
        "environment-id",
        "hub-identity.json",
        "settings.json",
        "state.sqlite",
        "task-files",
      ].toSorted(),
    );
    expect(
      NodeFS.readdirSync(fixture.nightlyHome).filter((name) => name.startsWith(".flavor-import-")),
    ).toEqual([]);
    // The database is free again for the server.
    await Effect.runPromise(
      Effect.scoped(acquireDatabaseMaintenance(fixture.nightlyDb, "after the copy")),
    );
  });

  it("copies a database Ryco has open, with its latest writes still in the WAL", async () => {
    const fixture = makeFixture();
    const live = new DatabaseSync(fixture.stableDb);
    try {
      live.exec("PRAGMA journal_mode = WAL");
      live.exec("PRAGMA wal_autocheckpoint = 0");
      insertRow(live, "projection_threads", {
        thread_id: "stable-live-thread",
        project_id: "project-1",
      });
      writeRequest(fixture);
      const stableBefore = snapshot(fixture.stableHome);
      expect(await run(fixture)).toMatchObject({ _tag: "Copied" });
      expect(snapshot(fixture.stableHome)).toEqual(stableBefore);
    } finally {
      live.close();
    }
    expect(threadIds(fixture.nightlyDb)).toEqual(["stable-live-thread", "stable-thread"]);
  });

  it("scrubs what would let Nightly act as Ryco's node", async () => {
    const fixture = makeFixture();
    const db = new DatabaseSync(fixture.stableDb);
    try {
      insertRow(db, "auth_sessions", { session_id: "session-1" });
      insertRow(db, "auth_pairing_links", { id: "link-1" });
      insertRow(db, "provider_session_runtime", { thread_id: "stable-thread" });
      insertRow(db, "projection_thread_sessions", {
        thread_id: "stable-thread",
        status: "running",
        provider_session_id: "claude-session",
        active_turn_id: "turn-1",
      });
      insertRow(db, "agent_control_automations", {
        automation_id: "automation-1",
        definition_json: JSON.stringify({ enabled: true }),
        revision: 1,
        enabled: 1,
        cancelled: 0,
        next_run_at: "2026-11-01T08:00:00.000Z",
      });
    } finally {
      db.close();
    }
    writeRequest(fixture);

    const outcome = await run(fixture);

    expect(outcome).toMatchObject({ _tag: "Copied" });
    for (const table of ["auth_sessions", "auth_pairing_links", "provider_session_runtime"]) {
      expect(countRows(fixture.nightlyDb, `SELECT COUNT(*) AS count FROM ${table}`), table).toBe(0);
    }
    expect(
      countRows(
        fixture.nightlyDb,
        "SELECT COUNT(*) AS count FROM agent_control_automations WHERE enabled = 0 AND next_run_at IS NULL",
      ),
    ).toBe(1);
    expect(
      countRows(
        fixture.nightlyDb,
        "SELECT COUNT(*) AS count FROM projection_thread_sessions WHERE provider_session_id IS NULL AND active_turn_id IS NULL",
      ),
    ).toBe(1);
    // Ryco's own database keeps everything.
    expect(countRows(fixture.stableDb, "SELECT COUNT(*) AS count FROM auth_sessions")).toBe(1);
    expect(
      countRows(
        fixture.stableDb,
        "SELECT COUNT(*) AS count FROM agent_control_automations WHERE enabled = 1",
      ),
    ).toBe(1);
  });

  it("drops a request older than an hour without copying or touching the last result", async () => {
    const fixture = makeFixture();
    write(resultPath(fixture), "earlier result");
    writeRequest(fixture, fixture.stableHome, new Date(Date.now() - 61 * 60_000));

    expect(await run(fixture)).toEqual({ _tag: "Stale" });
    expect(NodeFS.existsSync(requestPath(fixture))).toBe(false);
    expect(read(resultPath(fixture))).toBe("earlier result");
    expectNightlyUnchanged(fixture);
  });

  it("drops a request dated ahead", async () => {
    const fixture = makeFixture();
    writeRequest(fixture, fixture.stableHome, new Date(Date.now() + 10 * 60_000));
    expect(await run(fixture)).toEqual({ _tag: "Stale" });
    expect(NodeFS.existsSync(requestPath(fixture))).toBe(false);
    expectNightlyUnchanged(fixture);
  });

  it("refuses a request it cannot read, and removes it even when it is a folder", async () => {
    const fixture = makeFixture();
    NodeFS.mkdirSync(join(requestPath(fixture), "inside"), { recursive: true });
    expectRefused(await run(fixture), fixture, FLAVOR_IMPORT_MESSAGES.unreadable);

    write(requestPath(fixture), JSON.stringify({ version: 1, sourceHomeDir: fixture.stableHome }));
    expectRefused(await run(fixture), fixture, FLAVOR_IMPORT_MESSAGES.unreadable);
  });

  it("refuses a source other than the home the app allows", async () => {
    const fixture = makeFixture();
    const other = join(fixture.root, "other-home");
    NodeFS.cpSync(fixture.stableHome, other, { recursive: true });
    writeRequest(fixture, other);
    expectRefused(await run(fixture), fixture, FLAVOR_IMPORT_MESSAGES.notAllowed);

    // An allowance that is not an absolute path allows nothing, not even the folder it resolves to.
    writeRequest(fixture, NodePath.resolve("relative-home"));
    expectRefused(
      await run(fixture, { allowedSourceHome: "relative-home" }),
      fixture,
      FLAVOR_IMPORT_MESSAGES.notAllowed,
    );
  });

  it("refuses to copy Nightly's own home, also through a linked parent folder", async () => {
    const fixture = makeFixture();
    writeRequest(fixture, fixture.nightlyHome);
    expectRefused(
      await run(fixture, { allowedSourceHome: fixture.nightlyHome }),
      fixture,
      FLAVOR_IMPORT_MESSAGES.ownHome,
    );

    const alias = join(directory, `alias-${(caseCounter += 1)}`);
    NodeFS.symlinkSync(fixture.root, alias);
    const aliased = join(alias, ".ryco-nightly");
    writeRequest(fixture, aliased);
    expectRefused(
      await run(fixture, { allowedSourceHome: aliased }),
      fixture,
      FLAVOR_IMPORT_MESSAGES.ownHome,
    );
  });

  it("refuses a linked home, state folder, database or sidecar", async () => {
    const linkedHome = makeFixture();
    const realHome = join(linkedHome.root, "real-ryco");
    NodeFS.renameSync(linkedHome.stableHome, realHome);
    NodeFS.symlinkSync(realHome, linkedHome.stableHome);
    writeRequest(linkedHome);
    expectRefused(
      await run(linkedHome),
      linkedHome,
      `Ryco Nightly copies no links, and ${linkedHome.stableHome} is one.`,
    );

    const linkedState = makeFixture();
    const realState = join(linkedState.root, "real-userdata");
    NodeFS.renameSync(linkedState.stableState, realState);
    NodeFS.symlinkSync(realState, linkedState.stableState);
    writeRequest(linkedState);
    expectRefused(
      await run(linkedState),
      linkedState,
      `Ryco Nightly copies no links, and ${linkedState.stableState} is one.`,
    );

    const linkedDatabase = makeFixture();
    const realDatabase = join(linkedDatabase.root, "elsewhere.sqlite");
    NodeFS.renameSync(linkedDatabase.stableDb, realDatabase);
    NodeFS.symlinkSync(realDatabase, linkedDatabase.stableDb);
    writeRequest(linkedDatabase);
    expectRefused(
      await run(linkedDatabase),
      linkedDatabase,
      `Ryco Nightly copies no links, and ${linkedDatabase.stableDb} is one.`,
    );

    const linkedSidecar = makeFixture();
    write(join(linkedSidecar.root, "elsewhere-wal"), "");
    NodeFS.symlinkSync(join(linkedSidecar.root, "elsewhere-wal"), `${linkedSidecar.stableDb}-wal`);
    writeRequest(linkedSidecar);
    expectRefused(
      await run(linkedSidecar),
      linkedSidecar,
      `Ryco Nightly copies no links, and ${linkedSidecar.stableDb}-wal is one.`,
    );
  });

  it("refuses a link among the copied files and folders", async () => {
    const linkedSettings = makeFixture();
    const settings = join(linkedSettings.stableState, "settings.json");
    NodeFS.rmSync(settings);
    NodeFS.symlinkSync(
      join(linkedSettings.stableState, "secrets", "server-signing-key.bin"),
      settings,
    );
    writeRequest(linkedSettings);
    expectRefused(
      await run(linkedSettings),
      linkedSettings,
      `Ryco Nightly copies no links, and ${settings} is one.`,
    );

    const linkedAttachment = makeFixture();
    NodeFS.symlinkSync(
      join(linkedAttachment.stableState, "secrets"),
      join(linkedAttachment.stableState, "attachments", "thread-1", "secrets"),
    );
    writeRequest(linkedAttachment);
    expectRefused(
      await run(linkedAttachment),
      linkedAttachment,
      `Ryco Nightly copies no links, and ${join(linkedAttachment.stableState, "attachments", "thread-1", "secrets")} is one.`,
    );
  });

  it("refuses a database newer than this build", async () => {
    const fixture = makeFixture();
    const db = new DatabaseSync(fixture.stableDb);
    try {
      db.prepare("INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, ?)").run(
        SUPPORTED_MIGRATION_ID + 1,
        "FromALaterRelease",
      );
    } finally {
      db.close();
    }
    writeRequest(fixture);
    const outcome = await run(fixture);
    expectRefused(
      outcome,
      fixture,
      "Ryco is newer than this Ryco Nightly. Update Ryco Nightly, then copy again.",
    );
  });

  it("puts Nightly's previous data back when a move fails", async () => {
    const fixture = makeFixture();
    write(`${fixture.nightlyDb}-wal`, "");
    writeRequest(fixture);
    const outcome = await run(fixture, {
      rename: (from, to) => {
        if (to === fixture.nightlyDb && from.includes(".flavor-import-staging-")) {
          throw new Error("the disk went away");
        }
        NodeFS.renameSync(from, to);
      },
    });
    expectRefused(
      outcome,
      fixture,
      "The copy could not be moved into place (the disk went away). Ryco Nightly's data is unchanged.",
    );
    expect(NodeFS.existsSync(`${fixture.nightlyDb}-wal`)).toBe(true);
    expect(NodeFS.existsSync(join(fixture.nightlyState, "task-files"))).toBe(false);
  });

  it("refuses while another server owns Nightly's database", async () => {
    const fixture = makeFixture();
    writeRequest(fixture);
    const outcome = await Effect.runPromise(
      Effect.scoped(
        acquireDatabaseServer(fixture.nightlyDb, { launcher: "desktop" }).pipe(
          Effect.andThen(Effect.promise(() => run(fixture))),
        ),
      ),
    );
    expect(outcome._tag).toBe("Refused");
    expect(NodeFS.existsSync(requestPath(fixture))).toBe(false);
    expect(readResult(fixture).ok).toBe(false);
    expectNightlyUnchanged(fixture);
  });

  it("says the copy stopped when Nightly quits during it, and keeps Nightly's data", async () => {
    const fixture = makeFixture();
    writeRequest(fixture);
    const migrating = Promise.withResolvers<void>();
    const fiber = Effect.runFork(
      importInto(fixture, {
        migratedCopy: () =>
          Layer.effect(
            SqlClient.SqlClient,
            Effect.sync(() => migrating.resolve()).pipe(Effect.andThen(Effect.never)),
          ),
      }),
    );
    await migrating.promise;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(readResult(fixture)).toMatchObject({
      ok: false,
      error: FLAVOR_IMPORT_MESSAGES.interrupted,
    });
    expect(NodeFS.existsSync(requestPath(fixture))).toBe(false);
    expectNightlyUnchanged(fixture);
  });

  it("refuses while Nightly has an interrupted database restore to finish", async () => {
    const fixture = makeFixture();
    write(databaseRestoreJournalPath(fixture.nightlyDb), "{}");
    writeRequest(fixture);
    expectRefused(await run(fixture), fixture, FLAVOR_IMPORT_MESSAGES.restoreInterrupted);
  });
});
