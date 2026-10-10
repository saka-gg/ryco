import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assert, it } from "@effect/vitest";
import { PROJECT_RELOCATION_PENDING_MESSAGE } from "@ryco/contracts";
import { Effect, Result } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  acquireStoragePathUseLease,
  isStoragePathBlocked,
  storagePathBlocker,
} from "./lifecycle.ts";

const source = "/chats/2026-10-08-plan-0a1b2c3d";
const destination = "/code/plan";

const journal = (input: {
  readonly id: string;
  readonly state: "pending" | "moved" | "done" | "failed";
  readonly sourcePath?: string;
  readonly destinationPath?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM project_relocations`;
    yield* sql`INSERT INTO project_relocations (
        relocation_id, project_id, source_path, destination_path, strategy, state,
        destination_created, error, created_at, updated_at
      ) VALUES (
        ${input.id}, 'project-chat', ${input.sourcePath ?? source},
        ${input.destinationPath ?? destination}, 'rename', ${input.state}, 0, NULL,
        '2026-10-08T10:00:00.000Z', '2026-10-08T10:00:00.000Z'
      )`;
    return sql;
  });

it.layer(SqlitePersistenceMemory)("storage admission for chat moves", (it) => {
  it.effect("fences a pending or moved chat move at and below both of its paths", () =>
    Effect.gen(function* () {
      for (const state of ["pending", "moved"] as const) {
        const sql = yield* journal({ id: `relocation-${state}`, state });
        for (const candidate of [
          source,
          path.join(source, "notes"),
          destination,
          path.join(destination, "src"),
        ]) {
          assert.strictEqual(
            yield* storagePathBlocker(sql, candidate, "linux"),
            "project-relocation",
            `${state}: ${candidate}`,
          );
          assert.isTrue(yield* isStoragePathBlocked(sql, candidate, "linux"));
        }
      }
    }),
  );

  it.effect("leaves ancestors, siblings and settled moves usable", () =>
    Effect.gen(function* () {
      const sql = yield* journal({ id: "relocation-pending", state: "pending" });
      // A project that merely contains the chats folder is unrelated to the move.
      for (const candidate of ["/chats", "/", `${source}-other`, "/code/plan-b"]) {
        assert.isNull(yield* storagePathBlocker(sql, candidate, "linux"), candidate);
      }
      for (const state of ["done", "failed"] as const) {
        const settled = yield* journal({ id: `relocation-${state}`, state });
        assert.isNull(yield* storagePathBlocker(settled, source, "linux"), state);
        assert.isNull(yield* storagePathBlocker(settled, destination, "linux"), state);
      }
    }),
  );

  it.effect("compares paths case-insensitively where the filesystem does", () =>
    Effect.gen(function* () {
      const sql = yield* journal({ id: "relocation-case", state: "pending" });
      assert.strictEqual(
        yield* storagePathBlocker(sql, source.toUpperCase(), "darwin"),
        "project-relocation",
      );
      assert.isNull(yield* storagePathBlocker(sql, source.toUpperCase(), "linux"));
    }),
  );

  it.effect("refuses a provider session in a moving chat with a retryable message", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(async () =>
        fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ryco-chat-move-admission-"))),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(root, { recursive: true, force: true })),
      );
      const chat = path.join(root, "chat");
      yield* Effect.promise(() => fs.mkdir(chat));
      const sql = yield* journal({
        id: "relocation-session",
        state: "pending",
        sourcePath: chat,
        destinationPath: path.join(root, "project"),
      });
      const refused = yield* Effect.result(acquireStoragePathUseLease(sql, chat));
      assert.isTrue(Result.isFailure(refused));
      if (Result.isFailure(refused)) {
        assert.strictEqual(refused.failure.message, PROJECT_RELOCATION_PENDING_MESSAGE);
      }

      yield* sql`UPDATE project_relocations SET state = 'done'`;
      const release = yield* acquireStoragePathUseLease(sql, chat);
      yield* release;
    }).pipe(Effect.scoped),
  );
});
