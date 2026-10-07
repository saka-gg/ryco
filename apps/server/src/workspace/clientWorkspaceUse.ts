import path from "node:path";
import { Effect, Option, Schema, Semaphore } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OpenError } from "../open.ts";
import { acquireStoragePathUseLease, canonicalStoragePath } from "../storage/lifecycle.ts";
import { WorkspaceFileSystemError } from "./Services/WorkspaceFileSystem.ts";

/** A connected editor may retain an unsaved buffer long after its last read.
 * Conservatively pin read workspaces until that RPC connection closes.
 */
export const makeClientWorkspaceUse = Effect.gen(function* () {
  const storage = yield* Effect.serviceOption(SqlClient.SqlClient);
  const releases = new Map<string, Effect.Effect<void>>();
  const lock = Semaphore.makeUnsafe(1);
  const use = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          if (Option.isNone(storage) || releases.has(cwd)) return;
          const release = yield* acquireStoragePathUseLease(storage.value, cwd).pipe(
            Effect.mapError(
              (cause) =>
                new WorkspaceFileSystemError({
                  cwd,
                  operation: "editor admission",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          releases.set(cwd, release);
        }),
      )
      .pipe(Effect.andThen(effect));
  return {
    use,
    release: lock.withPermit(
      Effect.gen(function* () {
        for (const release of releases.values()) yield* release;
        releases.clear();
      }),
    ),
    externalEditor: <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
      use(
        cwd,
        Effect.gen(function* () {
          if (Option.isSome(storage)) {
            // Detached external applications cannot acknowledge buffer closure. Keep
            // a durable pin rather than guessing that a restart made them idle.
            const canonical = yield* Effect.tryPromise(() =>
              canonicalStoragePath(path.resolve(cwd.replace(/:\d+(?::\d+)?$/, ""))),
            );
            yield* storage.value`INSERT OR IGNORE INTO managed_worktree_editor_pins (path, created_at) VALUES (${canonical}, ${new Date().toISOString()})`;
          }
          return yield* effect;
        }),
      ).pipe(
        Effect.mapError((cause) =>
          Schema.is(OpenError)(cause)
            ? cause
            : new OpenError({
                message:
                  cause instanceof Error ? cause.message : "Editor workspace is unavailable.",
                cause,
              }),
        ),
      ),
  };
});
