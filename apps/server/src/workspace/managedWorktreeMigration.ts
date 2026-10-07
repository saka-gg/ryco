import fs from "node:fs/promises";
import path from "node:path";
import {
  CommandId,
  ProjectId,
  WorktreeId,
  WorkspaceLifecycleError,
  type OrchestrationWorktreeShell,
} from "@ryco/contracts";
import { Effect, Option, Semaphore } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { threadPendingWork } from "@ryco/shared/workspaceLifecycle";
import { captureWorktreeIdentity, type WorktreeIdentity } from "../storage/filesystem.ts";
import {
  canonicalStoragePath,
  hasWorktreeCreationLease,
  isStoragePathBlocked,
  storageLifecycleLock,
} from "../storage/lifecycle.ts";
import { resolveWorktreeCheckoutPath } from "../project/worktreeCheckoutPaths.ts";
import { validateWorktreeRoot } from "../project/worktreeRoot.ts";
import { assertWorktreeSetupComplete } from "../project/worktreeSetupState.ts";
import type { WorkspaceLifecycleDeps } from "./WorkspaceLifecycle.ts";
import { containsPath, samePath } from "./checkoutInspection.ts";

interface Relocation {
  worktree_id: string;
  project_id: string;
  repository_path: string;
  source_path: string;
  destination_path: string;
  identity_json: string;
  expected_updated_at: string;
  state: string;
}
const error = (cause: unknown) =>
  new WorkspaceLifecycleError({
    detail: cause instanceof Error ? cause.message : "Managed checkout relocation failed.",
  });
const exists = async (file: string) => {
  try {
    await fs.lstat(file);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
};
/** Directory and repository identity survive a same-filesystem Git move. */
const sameIdentity = (a: WorktreeIdentity, b: WorktreeIdentity) =>
  a.device === b.device &&
  a.inode === b.inode &&
  a.gitDirectory === b.gitDirectory &&
  a.commonDirectory === b.commonDirectory &&
  a.commonDevice === b.commonDevice &&
  a.commonInode === b.commonInode;

export function makeManagedWorktreeMigration(
  deps: WorkspaceLifecycleDeps,
  sql: SqlClient.SqlClient,
  stateDir: string,
  lockFor: (id: string) => Semaphore.Semaphore,
) {
  const passLock = Semaphore.makeUnsafe(1);
  const validateLayout = (row: Relocation) => {
    const segment = /^[a-f0-9]{8}_[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
    if (
      !path.isAbsolute(row.source_path) ||
      !path.isAbsolute(row.destination_path) ||
      path.basename(path.dirname(row.source_path)) !== row.project_id ||
      !samePath(
        path.dirname(path.dirname(row.source_path)),
        path.dirname(path.dirname(row.destination_path)),
      ) ||
      !segment.test(path.basename(path.dirname(row.destination_path))) ||
      !segment.test(path.basename(row.destination_path))
    )
      throw new Error(
        "Relocation journal does not describe a managed checkout in its original root.",
      );
  };
  const inspect = (row: Relocation, candidate: string) =>
    Effect.tryPromise(async () => {
      validateLayout(row);
      const original = JSON.parse(row.identity_json) as WorktreeIdentity;
      const identity = await captureWorktreeIdentity(row.repository_path, candidate);
      if (!sameIdentity(original, identity))
        throw new Error("Checkout or repository identity changed; manual recovery is required.");
      return identity;
    });
  const mark = (row: Relocation, state: string, detail: string | null) =>
    // Failures in optional post-commit work cannot fence an already committed destination.
    sql`UPDATE managed_worktree_relocations SET state = ${state}, last_error = ${detail} WHERE worktree_id = ${row.worktree_id} AND state != 'complete'`;

  const idle = (worktree: OrchestrationWorktreeShell, candidate: string) =>
    Effect.gen(function* () {
      if (hasWorktreeCreationLease(candidate)) return false;
      const snapshot = yield* deps.snapshots.getShellSnapshot();
      if (
        snapshot.projects.some(
          (project) =>
            project.id !== worktree.projectId &&
            (containsPath(candidate, project.workspaceRoot) ||
              containsPath(project.workspaceRoot, candidate)),
        )
      )
        return false;
      if (
        snapshot.worktrees?.some(
          (other) =>
            other.worktreeId !== worktree.worktreeId &&
            other.worktreePath &&
            (containsPath(candidate, other.worktreePath) ||
              containsPath(other.worktreePath, candidate)),
        )
      )
        return false;
      const threads = yield* sql<{ thread_id: string }>`SELECT thread_id FROM projection_threads
      WHERE project_id = ${worktree.projectId} AND (worktree_id = ${worktree.worktreeId} OR worktree_path = ${worktree.worktreePath}) LIMIT 5001`;
      if (threads.length > 5000) return false;
      const ids = new Set(threads.map((thread) => thread.thread_id));
      if (
        snapshot.threads.some(
          (thread) => ids.has(thread.id) && threadPendingWork(thread, Date.now()).length > 0,
        )
      )
        return false;
      // A provider that is ready between turns still owns its working directory.
      if (!deps.sessionDirectory) return false;
      const bindings = yield* deps.sessionDirectory.listBindings();
      if (bindings.some((binding) => ids.has(binding.threadId) && binding.status !== "stopped"))
        return false;
      const terminals = yield* deps.terminals.listDiagnostics;
      if (
        terminals.some(
          (terminal) =>
            (terminal.pid !== null ||
              terminal.status === "running" ||
              terminal.status === "starting") &&
            (ids.has(terminal.threadId) ||
              containsPath(candidate, terminal.cwd) ||
              containsPath(terminal.cwd, candidate) ||
              (terminal.worktreePath !== null && samePath(candidate, terminal.worktreePath))),
        )
      )
        return false;
      const pending =
        yield* sql`SELECT 1 FROM projection_threads t WHERE t.thread_id IN ${sql.in([...ids])}
      AND (EXISTS (SELECT 1 FROM projection_turns p WHERE p.thread_id = t.thread_id AND p.state IN ('pending', 'running'))
        OR EXISTS (SELECT 1 FROM provider_effect_intents i WHERE i.thread_id = t.thread_id)
        OR EXISTS (SELECT 1 FROM restart_continuations r WHERE r.thread_id = t.thread_id AND r.status = 'pending')) LIMIT 1`;
      if (pending.length) return false;
      const pins = yield* sql<{ path: string }>`SELECT path FROM managed_worktree_editor_pins`;
      return !pins.some(
        (pin) => containsPath(candidate, pin.path) || containsPath(pin.path, candidate),
      );
    });

  // Call under admission: harmless title/branch changes while deferred are retained.
  // Once fenced, all competing worktree metadata commands defer until commit.
  const refreshRevision = (row: Relocation) =>
    Effect.gen(function* () {
      const snapshot = yield* deps.snapshots.getShellSnapshot();
      const worktree = snapshot.worktrees?.find((item) => item.worktreeId === row.worktree_id);
      if (
        !worktree ||
        worktree.projectId !== row.project_id ||
        worktree.worktreePath !== row.source_path ||
        worktree.origin === "main" ||
        worktree.checkoutRemovedAt != null
      )
        throw new Error("Workspace references changed; manual recovery is required.");
      row.expected_updated_at = worktree.updatedAt;
      yield* sql`UPDATE managed_worktree_relocations SET expected_updated_at = ${worktree.updatedAt} WHERE worktree_id = ${row.worktree_id}`;
      return worktree;
    });

  const finish = (row: Relocation, identity: WorktreeIdentity) =>
    Effect.gen(function* () {
      yield* storageLifecycleLock.withPermit(
        Effect.gen(function* () {
          yield* refreshRevision(row);
          yield* sql`UPDATE managed_worktree_relocations SET state = 'moved', destination_identity_json = ${JSON.stringify(identity)} WHERE worktree_id = ${row.worktree_id}`;
        }),
      );
      yield* deps.engine.dispatch({
        type: "worktree.relocate",
        commandId: CommandId.make(
          `managed-worktree-relocate:${row.worktree_id}:${path.basename(row.destination_path)}`,
        ),
        worktreeId: WorktreeId.make(row.worktree_id),
        projectId: ProjectId.make(row.project_id),
        sourcePath: row.source_path,
        destinationPath: row.destination_path,
        expectedUpdatedAt: row.expected_updated_at,
        relocatedAt: new Date().toISOString(),
      });
      // Retain busy siblings and unowned files; remove only an empty legacy parent.
      const parent = path.dirname(row.source_path);
      const prefix = parent + path.sep;
      const references =
        yield* sql`SELECT 1 FROM projection_worktrees WHERE instr(worktree_path, ${prefix}) = 1
        UNION ALL SELECT 1 FROM projection_threads WHERE instr(worktree_path, ${prefix}) = 1
        UNION ALL SELECT 1 FROM storage_owned_entries WHERE instr(path, ${prefix}) = 1 LIMIT 1`;
      if (!references.length)
        yield* Effect.tryPromise(async () => {
          try {
            await fs.rmdir(parent);
          } catch (cause) {
            if (
              !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
                (cause as NodeJS.ErrnoException).code ?? "",
              )
            )
              throw cause;
          }
        }).pipe(Effect.ignore({ log: true }));
      yield* deps.git.invalidateStatus(row.source_path);
      yield* deps.git.invalidateStatus(row.destination_path);
    });

  const resume = (row: Relocation) =>
    Effect.gen(function* () {
      const sourceExists = yield* Effect.tryPromise(() => exists(row.source_path));
      const destinationExists = yield* Effect.tryPromise(() => exists(row.destination_path));
      if (sourceExists === destinationExists) {
        yield* mark(
          row,
          "attention",
          "Both paths exist, or neither exists. No move or deletion was attempted; manual recovery is required.",
        );
        return;
      }
      if (destinationExists) {
        const identity = yield* inspect(row, row.destination_path);
        yield* finish(row, identity);
        return;
      }
      yield* inspect(row, row.source_path);
      const admitted = yield* storageLifecycleLock.withPermit(
        Effect.gen(function* () {
          const worktree = yield* refreshRevision(row);
          const owned =
            yield* sql`SELECT 1 FROM storage_owned_entries WHERE path = ${row.source_path} AND state = 'owned' AND identity_json = ${row.identity_json}`;
          if (
            owned.length !== 1 ||
            (yield* isStoragePathBlocked(
              sql,
              row.source_path,
              process.platform,
              row.worktree_id,
            )) ||
            (yield* isStoragePathBlocked(
              sql,
              row.destination_path,
              process.platform,
              row.worktree_id,
            ))
          ) {
            yield* mark(
              row,
              "attention",
              "Checkout ownership or lifecycle admission changed; manual recovery is required.",
            );
            return false;
          }
          if (!(yield* idle(worktree, row.source_path))) {
            yield* mark(row, "deferred", null);
            return false;
          }
          yield* mark(row, "moving", null);
          return true;
        }),
      );
      if (!admitted) return;
      const authorized = yield* validateWorktreeRoot(row.destination_path, deps.policy);
      if (authorized !== row.destination_path)
        throw new Error("Relocation destination changed its canonical identity.");
      yield* Effect.tryPromise(() =>
        fs.mkdir(path.dirname(row.destination_path), { recursive: true }),
      );
      // Never force a move: Git refuses locked, submodule, and unsupported layouts.
      const moved = yield* deps.gitDriver
        .execute({
          operation: "managed worktree migration",
          cwd: row.repository_path,
          args: ["worktree", "move", row.source_path, row.destination_path],
          timeoutMs: 30_000,
          maxOutputBytes: 8192,
        })
        .pipe(Effect.exit);
      if (moved._tag === "Failure") {
        const unchanged = yield* inspect(row, row.source_path).pipe(Effect.option);
        const destinationNowExists = yield* Effect.tryPromise(() => exists(row.destination_path));
        yield* mark(
          row,
          Option.isSome(unchanged) && !destinationNowExists ? "failed" : "attention",
          "Git could not move the checkout. Its contents were retained; inspect the worktree manually.",
        );
        return;
      }
      yield* finish(row, yield* inspect(row, row.destination_path));
    }).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const source = yield* inspect(row, row.source_path).pipe(Effect.option);
          const destination = yield* Effect.tryPromise(() => exists(row.destination_path)).pipe(
            Effect.orElseSucceed(() => true),
          );
          yield* mark(
            row,
            Option.isSome(source) && !destination ? "failed" : "attention",
            cause instanceof Error ? cause.message : "Relocation needs manual recovery.",
          );
        }),
      ),
    );

  const migrate = () =>
    passLock
      .withPermit(
        Effect.gen(function* () {
          const journals =
            yield* sql<Relocation>`SELECT * FROM managed_worktree_relocations WHERE state IN ('moving', 'moved', 'deferred')`;
          for (const row of journals) yield* lockFor(row.worktree_id).withPermit(resume(row));
          const snapshot = yield* deps.snapshots.getShellSnapshot();
          for (const worktree of snapshot.worktrees ?? []) {
            if (
              worktree.origin === "main" ||
              worktree.origin === "manual" ||
              !worktree.worktreePath ||
              worktree.checkoutRemovedAt != null
            )
              continue;
            const project = snapshot.projects.find((item) => item.id === worktree.projectId);
            // Only the old managed layout, in its original root. Imported/project-local paths stay put.
            if (!project || path.basename(path.dirname(worktree.worktreePath)) !== project.id)
              continue;
            yield* lockFor(worktree.worktreeId)
              .withPermit(
                Effect.gen(function* () {
                  const existing =
                    yield* sql`SELECT 1 FROM managed_worktree_relocations WHERE worktree_id = ${worktree.worktreeId}`;
                  if (existing.length) return;
                  const source = yield* Effect.tryPromise(() =>
                    canonicalStoragePath(worktree.worktreePath!),
                  );
                  if (source !== worktree.worktreePath || samePath(source, project.workspaceRoot))
                    return;
                  const repository = yield* Effect.tryPromise(() =>
                    canonicalStoragePath(project.workspaceRoot),
                  );
                  const owned = yield* sql<{
                    identity_json: string;
                    state: string;
                    repository_path: string;
                  }>`SELECT identity_json, state, repository_path
          FROM storage_owned_entries WHERE path = ${source} AND category = 'worktree'`;
                  if (
                    owned.length !== 1 ||
                    owned[0]!.state !== "owned" ||
                    owned[0]!.repository_path !== repository
                  )
                    return;
                  if (!(yield* storageLifecycleLock.withPermit(idle(worktree, source)))) return;
                  yield* assertWorktreeSetupComplete(stateDir, source);
                  const identity = yield* Effect.tryPromise(() =>
                    captureWorktreeIdentity(repository, source),
                  );
                  if (
                    !sameIdentity(JSON.parse(owned[0]!.identity_json) as WorktreeIdentity, identity)
                  )
                    return;
                  const target = yield* resolveWorktreeCheckoutPath({
                    location: undefined,
                    appWorktreesRoot: path.dirname(path.dirname(source)),
                    projectId: project.id,
                    projectTitle: project.title,
                    workspaceRoot: repository,
                    projectMetadataDir: project.projectMetadataDir,
                    initialName: worktree.title,
                    branchName: worktree.branch,
                  }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
                  const row: Relocation = {
                    worktree_id: worktree.worktreeId,
                    project_id: project.id,
                    repository_path: repository,
                    source_path: source,
                    destination_path: target,
                    identity_json: JSON.stringify(identity),
                    expected_updated_at: worktree.updatedAt,
                    state: "moving",
                  };
                  const admitted = yield* storageLifecycleLock.withPermit(
                    Effect.gen(function* () {
                      if (
                        (yield* isStoragePathBlocked(sql, source)) ||
                        (yield* isStoragePathBlocked(sql, target)) ||
                        !(yield* idle(worktree, source)) ||
                        hasWorktreeCreationLease(target)
                      )
                        return false;
                      yield* sql`INSERT INTO managed_worktree_relocations
            (worktree_id, project_id, repository_path, source_path, destination_path, identity_json, expected_updated_at, state, created_at)
            VALUES (${row.worktree_id}, ${row.project_id}, ${repository}, ${source}, ${target}, ${row.identity_json}, ${row.expected_updated_at}, 'moving', ${new Date().toISOString()})`;
                      return true;
                    }),
                  );
                  if (admitted) yield* resume(row);
                }),
              )
              .pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Managed worktree migration deferred", {
                    worktreeId: worktree.worktreeId,
                    cause,
                  }),
                ),
              );
          }
        }),
      )
      .pipe(Effect.mapError(error));
  const recover = () =>
    passLock
      .withPermit(
        Effect.gen(function* () {
          const rows =
            yield* sql<Relocation>`SELECT * FROM managed_worktree_relocations WHERE state IN ('moving', 'moved')`;
          for (const row of rows)
            yield* lockFor(row.worktree_id).withPermit(
              Effect.gen(function* () {
                const sourceExists = yield* Effect.tryPromise(() => exists(row.source_path));
                const destinationExists = yield* Effect.tryPromise(() =>
                  exists(row.destination_path),
                );
                if (sourceExists === destinationExists)
                  return yield* mark(
                    row,
                    "attention",
                    "Both or neither relocation paths exist; manual recovery is required.",
                  );
                if (destinationExists) {
                  yield* finish(row, yield* inspect(row, row.destination_path));
                  return;
                }
                yield* inspect(row, row.source_path);
                // No filesystem move happened. Restore admission before provider/continuation
                // recovery so their original cwd remains usable; migrate later when idle.
                yield* storageLifecycleLock.withPermit(
                  Effect.gen(function* () {
                    yield* refreshRevision(row);
                    yield* mark(row, "deferred", null);
                  }),
                );
              }).pipe(
                Effect.catch((cause) =>
                  mark(
                    row,
                    "attention",
                    cause instanceof Error ? cause.message : "Recovery needs attention.",
                  ),
                ),
              ),
            );
        }),
      )
      .pipe(Effect.mapError(error));
  return { migrate, recover };
}
