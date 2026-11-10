import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { databaseBackupsDirectory } from "../persistence/databaseBackupPolicy.ts";
import { formatBackupName } from "../persistence/databaseBackups.ts";
import { listDatabaseBackupSummaries, removeDatabaseBackup } from "./databaseBackupList.ts";

let root: string | null = null;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

const setup = async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ryco-backup-list-"));
  const dbPath = path.join(root, "userdata", "state.sqlite");
  const directory = databaseBackupsDirectory(dbPath);
  await mkdir(directory, { recursive: true });
  const write = async (name: string, bytes: number) => {
    await writeFile(path.join(directory, name), Buffer.alloc(bytes));
    return name;
  };
  const older = await write(
    formatBackupName({
      stem: "state",
      from: 93,
      to: 95,
      at: Date.UTC(2026, 9, 30),
      codec: "zst",
    }),
    3_000,
  );
  const newest = await write(
    formatBackupName({ stem: "state", from: 95, to: 100, at: Date.UTC(2026, 10, 1), codec: "zst" }),
    2_000,
  );
  // Still being compressed: only its raw file exists.
  const raw = await write(
    formatBackupName({ stem: "state", from: 90, to: 93, at: Date.UTC(2026, 9, 1) }),
    5_000,
  );
  await write("notes.txt", 10);
  return { dbPath, directory, older, newest, raw };
};

describe("database backup list", () => {
  it("lists each backup newest first with its size", async () => {
    const { dbPath, older, newest, raw } = await setup();
    const listed = await Effect.runPromise(listDatabaseBackupSummaries(dbPath));
    expect(listed).toEqual([
      {
        name: newest,
        kind: "before",
        fromSchema: 95,
        toSchema: 100,
        createdAt: "2026-11-01T00:00:00.000Z",
        bytes: 2_000,
        newest: true,
      },
      expect.objectContaining({ name: older, bytes: 3_000, newest: false }),
      expect.objectContaining({ name: raw, bytes: 5_000, newest: false }),
    ]);
  });

  it("removes only a listed, finished backup", async () => {
    const { dbPath, directory, older, raw } = await setup();
    expect(await Effect.runPromise(removeDatabaseBackup(dbPath, older))).toEqual({
      kind: "removed",
      freedBytes: 3_000,
    });
    expect(await Effect.runPromise(removeDatabaseBackup(dbPath, raw))).toMatchObject({
      kind: "refused",
    });
    for (const name of ["../state.sqlite", "notes.txt", older]) {
      expect(await Effect.runPromise(removeDatabaseBackup(dbPath, name))).toMatchObject({
        kind: "refused",
      });
    }
    expect((await readdir(directory)).toSorted()).toEqual(
      [
        raw,
        "notes.txt",
        (await Effect.runPromise(listDatabaseBackupSummaries(dbPath)))[0]!.name,
      ].toSorted(),
    );
  });
});
