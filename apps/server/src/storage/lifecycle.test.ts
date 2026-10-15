import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assert, it } from "@effect/vitest";
import { PROJECT_RELOCATION_PENDING_MESSAGE } from "@ryco/contracts";
import { Deferred, Effect, Fiber, Result } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  acquireStoragePathUseLease,
  acquireStoragePathUseLeaseHandle,
  checkoutLifecycleOwner,
  hasWorktreeCreationLease,
  isStoragePathBlocked,
  retainStoragePathUseLease,
  storageLifecycleLock,
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

  it.effect("admits a path use lease during command processing, not during a cleanup claim", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM project_relocations`;
      const root = yield* Effect.promise(async () =>
        fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ryco-use-lease-admission-"))),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(root, { recursive: true, force: true })),
      );

      // Command processing holds the lock shared: a turn start's lease does not queue behind it.
      const processing = yield* Deferred.make<void>();
      const processingEntered = yield* Deferred.make<void>();
      const command = yield* storageLifecycleLock
        .withShared(
          Deferred.succeed(processingEntered, undefined).pipe(
            Effect.andThen(Deferred.await(processing)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(processingEntered);
      const release = yield* acquireStoragePathUseLease(sql, root);
      yield* release;
      yield* Deferred.succeed(processing, undefined);
      yield* Fiber.join(command);

      // A cleanup claim holds it exclusively: the lease waits until the claim is decided.
      const claiming = yield* Deferred.make<void>();
      const claimEntered = yield* Deferred.make<void>();
      const claim = yield* storageLifecycleLock
        .withPermit(
          Deferred.succeed(claimEntered, undefined).pipe(Effect.andThen(Deferred.await(claiming))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(claimEntered);
      let leased = false;
      const lease = yield* acquireStoragePathUseLease(sql, root).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            leased = true;
          }),
        ),
        Effect.forkChild,
      );
      for (let index = 0; index < 20; index++) yield* Effect.yieldNow;
      assert.isFalse(leased);
      yield* Deferred.succeed(claiming, undefined);
      yield* Fiber.join(claim);
      yield* yield* Fiber.join(lease);
      assert.isTrue(leased);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "retains a held use lease without the admission check, and re-checks once it is gone",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM project_relocations`;
        const root = yield* Effect.promise(async () =>
          fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ryco-use-lease-retain-"))),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => fs.rm(root, { recursive: true, force: true })),
        );
        const held = yield* acquireStoragePathUseLeaseHandle(sql, root);
        assert.strictEqual(held.path, root);
        assert.isTrue(hasWorktreeCreationLease(root));

        // While held, retaining succeeds even where a fresh acquire is refused, and does not
        // touch the admission lock: an exclusive holder does not delay it.
        yield* journal({ id: "relocation-retain", state: "pending", sourcePath: root });
        const claimEntered = yield* Deferred.make<void>();
        const claiming = yield* Deferred.make<void>();
        const claim = yield* storageLifecycleLock
          .withPermit(
            Deferred.succeed(claimEntered, undefined).pipe(
              Effect.andThen(Deferred.await(claiming)),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(claimEntered);
        const retained = yield* retainStoragePathUseLease(sql, held);
        yield* Deferred.succeed(claiming, undefined);
        yield* Fiber.join(claim);

        // The retained use outlives the holder's lease; each release counts once.
        yield* held.release;
        yield* held.release;
        assert.isTrue(hasWorktreeCreationLease(root));
        yield* retained;
        assert.isFalse(hasWorktreeCreationLease(root));

        // With no use left, retaining is a full acquire and sees the pending move.
        const refused = yield* Effect.result(retainStoragePathUseLease(sql, held));
        assert.isTrue(Result.isFailure(refused));
        assert.isFalse(hasWorktreeCreationLease(root));
      }).pipe(Effect.scoped),
  );

  it.effect("tells a checkout its own removal is still recording from one left behind", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const checkout = "/code/app/.worktrees/feature";
      assert.isNull(yield* checkoutLifecycleOwner(sql, checkout, "linux"));
      for (const [state, owner] of [
        ["removing", "removal"],
        ["removed", "removed"],
      ] as const) {
        yield* sql`DELETE FROM storage_owned_entries`;
        yield* sql`INSERT INTO storage_owned_entries (id, path, repository_path, category, identity_json, created_at, state)
          VALUES ('entry', ${checkout}, '/code/app', 'worktree', '{}', '2026-10-15T00:00:00.000Z', ${state})`;
        assert.equal(yield* checkoutLifecycleOwner(sql, checkout, "linux"), owner);
        assert.isNull(yield* checkoutLifecycleOwner(sql, "/code/app/.worktrees/other", "linux"));
      }
      yield* sql`UPDATE storage_owned_entries SET state = 'owned'`;
      assert.isNull(yield* checkoutLifecycleOwner(sql, checkout, "linux"));
      // Without persistence only creation leases are known.
      assert.isNull(yield* checkoutLifecycleOwner(undefined, checkout, "linux"));
      yield* sql`DELETE FROM storage_owned_entries`;
    }),
  );
});
