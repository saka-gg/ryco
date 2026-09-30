import type { ProviderRuntimeBinding } from "../provider/Services/ProviderSessionDirectory.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { assert, it } from "@effect/vitest";
import { vi } from "vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  GitCommandError,
  OrchestrationShellSnapshot,
  ProjectId,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  WorktreeId,
  type DiagnosticsTerminalProcess,
} from "@ryco/contracts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { type ServerConfigShape } from "../config.ts";
import { makeWorkspaceAccessPolicy } from "../workspace/Layers/WorkspaceAccessPolicy.ts";
import { runProcess } from "../processRunner.ts";
import { makeStorageService } from "./StorageService.ts";
import { resolveUsageProtectedPaths } from "../usage/usageProtectedPaths.ts";
import {
  acquireWorktreeCreationLease,
  acquireStoragePathUseLease,
  acquireStorageSettingsUpdateLease,
  canonicalStoragePath,
  isStoragePathBlocked,
  recordCreatedWorktree,
  storageLifecycleLock,
  noteStorageSettingsChange,
} from "./lifecycle.ts";
import {
  assertCanonicalPath,
  assertCleanWorktree,
  measureDirectory,
  removeVerifiedWorktree,
} from "./filesystem.ts";

const projectId = ProjectId.make("fixture-project");
const threadId = ThreadId.make("fixture-thread");
const worktreeId = WorktreeId.make("fixture-worktree");
const old = "2020-01-01T00:00:00Z";
const io = <A>(work: () => Promise<A>) => Effect.tryPromise(work);
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`DELETE FROM storage_owned_entries`;
  yield* sql`DELETE FROM storage_cleanup_previews`;
  yield* sql`DELETE FROM storage_usage_history`;
  const root = yield* io(async () =>
    fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ryco-storage-fixture-"))),
  );
  yield* Effect.addFinalizer(() =>
    io(() => fs.rm(root, { recursive: true, force: true })).pipe(Effect.orDie),
  );
  const repo = path.join(root, "repository");
  const checkout = path.join(root, "checkout");
  yield* io(() => fs.mkdir(repo));
  const git = (cwd: string, args: readonly string[]) =>
    io(() =>
      runProcess("git", args, {
        cwd,
        timeoutMs: 10_000,
        maxBufferBytes: 256 * 1024,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: path.join(root, "empty-config"),
          GIT_CONFIG_NOSYSTEM: "1",
        },
      }),
    );
  yield* git(repo, ["init", "--initial-branch=main"]);
  yield* git(repo, ["config", "user.name", "Storage fixture"]);
  yield* git(repo, ["config", "user.email", "fixture@example.invalid"]);
  yield* io(() => fs.writeFile(path.join(repo, "tracked.txt"), "fixture\n"));
  yield* git(repo, ["add", "tracked.txt"]);
  yield* git(repo, ["commit", "-m", "fixture"]);
  yield* git(repo, ["worktree", "add", "-b", "fixture-branch", checkout]);
  yield* recordCreatedWorktree(sql, repo, checkout);
  let snapshot = Schema.decodeUnknownSync(OrchestrationShellSnapshot)({
    snapshotSequence: 1,
    updatedAt: old,
    projects: [
      {
        id: projectId,
        title: "Fixture project",
        workspaceRoot: repo,
        defaultModelSelection: null,
        scripts: [],
        createdAt: old,
        updatedAt: old,
      },
    ],
    threads: [
      {
        id: threadId,
        projectId,
        title: "Completed fixture",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "fixture-branch",
        worktreePath: checkout,
        worktreeId,
        createdAt: old,
        updatedAt: old,
        archivedAt: old,
        settledOverride: null,
        settledAt: null,
        session: null,
        latestTurn: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      },
    ],
    worktrees: [
      {
        worktreeId,
        projectId,
        branch: "fixture-branch",
        worktreePath: checkout,
        origin: "branch",
        prNumber: null,
        issueNumber: null,
        prTitle: null,
        issueTitle: null,
        createdAt: old,
        updatedAt: old,
        archivedAt: null,
        manualPosition: 0,
      },
    ],
  });
  let currentSettings = DEFAULT_SERVER_SETTINGS;
  let bindingRows: readonly ProviderRuntimeBinding[] = [];
  let terminalRows: readonly DiagnosticsTerminalProcess[] = [];
  let protectedSources:
    | ((settings: typeof DEFAULT_SERVER_SETTINGS) => readonly string[])
    | null = () => [];
  let beforeRemove: (() => Effect.Effect<void>) | null = null;
  let duringListWorktrees: (() => Effect.Effect<void>) | null = null;
  const config = {
    stateDir: root,
    dbPath: path.join(root, "node.sqlite"),
    attachmentsDir: path.join(root, "attachments"),
    logsDir: path.join(root, "logs"),
  } as ServerConfigShape;
  const policy = yield* makeWorkspaceAccessPolicy(undefined);
  const service = makeStorageService({
    sql,
    config,
    providerProtection: {
      resolve: (settings) => {
        if (!protectedSources) throw new Error("resolver unavailable");
        return protectedSources(settings);
      },
    },
    settings: { getSettings: Effect.suspend(() => Effect.succeed(currentSettings)) },
    snapshots: { getShellSnapshot: () => Effect.suspend(() => Effect.succeed(snapshot)) },
    providers: {
      listBindings: () =>
        Effect.suspend(() =>
          Effect.succeed(
            bindingRows.map((binding) => Object.assign({}, binding, { lastSeenAt: old })),
          ),
        ),
    },
    terminals: { listDiagnostics: Effect.suspend(() => Effect.succeed(terminalRows)) },
    policy,
    git: {
      listWorktreePaths: () =>
        Effect.gen(function* () {
          if (duringListWorktrees) yield* duringListWorktrees();
          return yield* git(repo, ["worktree", "list", "--porcelain"]);
        }).pipe(
          Effect.map((result) =>
            result.stdout
              .split("\n")
              .filter((line) => line.startsWith("worktree "))
              .map((line) => line.slice(9)),
          ),
          Effect.mapError((cause) => cause as never),
        ),
      removeWorktree: (input) =>
        Effect.gen(function* () {
          assert.strictEqual(input.force, false);
          if (beforeRemove) yield* beforeRemove();
          assert.isDefined(input.cleanup);
          yield* Effect.tryPromise({
            try: () => removeVerifiedWorktree(input.cwd, input.path, input.cleanup!),
            catch: (cause) =>
              new GitCommandError({
                operation: "fixture.verifiedCleanup",
                command: "verified cleanup",
                cwd: input.cwd,
                detail: cause instanceof Error ? cause.message : "Verified cleanup failed",
                cause,
              }),
          });
        }).pipe(Effect.mapError((cause) => cause as never)),
    },
  });
  const entry = (yield* service.scan()).entries.find((item) => item.path === checkout)!;
  return {
    sql,
    service,
    root,
    repo,
    checkout,
    git,
    entry,
    setSnapshot: (update: (current: typeof snapshot) => typeof snapshot) => {
      snapshot = update(snapshot);
    },
    setSettings: (update: typeof currentSettings) => {
      currentSettings = update;
    },
    setBindings: (rows: typeof bindingRows) => {
      bindingRows = rows;
    },
    setTerminals: (rows: typeof terminalRows) => {
      terminalRows = rows;
    },
    setProtectedSources: (resolver: typeof protectedSources) => {
      protectedSources = resolver;
    },
    duringListWorktrees: (hook: () => Effect.Effect<void>) => {
      duringListWorktrees = hook;
    },
    beforeRemove: (hook: () => Effect.Effect<void>) => {
      beforeRemove = hook;
    },
  };
});

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory(), NodeServices.layer))(
  "safe node storage lifecycle",
  (it) => {
    it.effect(
      "previews clean owned checkouts, retains branches/history and replays only the recorded result",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            assert.isTrue(f.entry.eligible);
            const preview = yield* f.service.preview("owner-fixture", [f.entry.id]);
            const result = yield* f.service.execute("owner-fixture", preview.token);
            assert.strictEqual(result.results[0]?.status, "removed");
            assert.deepEqual(yield* f.service.execute("owner-fixture", preview.token), result);
            assert.strictEqual(
              (yield* f.git(f.repo, ["rev-parse", "refs/heads/fixture-branch"])).stdout.length > 0,
              true,
            );
            assert.isTrue(yield* isStoragePathBlocked(f.sql, path.join(f.checkout, "nested")));
            assert.isTrue((yield* f.service.scan()).history.length > 0);
          }),
        ),
    );
    it.effect("refuses dirty/untracked work introduced after preview", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const preview = yield* f.service.preview("owner", [f.entry.id]);
          yield* io(() => fs.writeFile(path.join(f.checkout, "user-work.txt"), "keep"));
          const result = yield* f.service.execute("owner", preview.token);
          assert.strictEqual(result.results[0]?.status, "protected");
          assert.strictEqual(
            yield* io(() => fs.readFile(path.join(f.checkout, "user-work.txt"), "utf8")),
            "keep",
          );
        }),
      ),
    );
    it.effect("protects running, starting, pending, shared, manual and terminal-owned work", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const initial = yield* f.service.scan();
          for (const kind of ["active", "pending", "background", "shared", "manual", "terminal"]) {
            // Reset each case to a new fixture snapshot through the previous projected value.
            f.setSnapshot((s) => ({
              ...s,
              threads: s.threads.slice(0, 1).map((t) =>
                Object.assign({}, t, {
                  archivedAt: old,
                  hasPendingUserInput: false,
                  backgroundLiveness: null,
                }),
              ),
              worktrees: s.worktrees?.map((w) => ({ ...w, origin: "branch" })),
            }));
            f.setTerminals([]);
            if (kind === "active")
              f.setSnapshot((s) => ({
                ...s,
                threads: s.threads.map((t) => ({ ...t, archivedAt: null })),
              }));
            if (kind === "pending")
              f.setSnapshot((s) => ({
                ...s,
                threads: s.threads.map((t) => ({ ...t, hasPendingUserInput: true })),
              }));
            if (kind === "background")
              f.setSnapshot((s) => ({
                ...s,
                threads: s.threads.map((t) => ({ ...t, backgroundLiveness: "working" })),
              }));
            if (kind === "shared")
              f.setSnapshot((s) => ({
                ...s,
                threads: [...s.threads, { ...s.threads[0]!, id: ThreadId.make("second") }],
              }));
            if (kind === "manual")
              f.setSnapshot((s) => ({
                ...s,
                worktrees: s.worktrees?.map((w) => ({ ...w, origin: "manual" })),
              }));
            if (kind === "terminal")
              f.setTerminals([
                {
                  threadId,
                  terminalId: "fixture",
                  cwd: f.checkout,
                  worktreePath: f.checkout,
                  status: "starting",
                  pid: null,
                  hasRunningSubprocess: false,
                  exitCode: null,
                  exitSignal: null,
                  updatedAt: old,
                },
              ]);
            assert.isFalse(
              (yield* f.service.scan()).entries.find((item) => item.id === f.entry.id)!.eligible,
              kind,
            );
          }
          assert.isTrue(
            initial.entries.some((entry) => entry.category === "repository" && !entry.eligible),
          );
        }),
      ),
    );
    it.effect(
      "refuses activation after the cleanup claim without holding the admission lock through git",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            let refused = false;
            f.beforeRemove(() =>
              storageLifecycleLock.withPermit(
                Effect.gen(function* () {
                  refused = yield* isStoragePathBlocked(f.sql, f.checkout).pipe(Effect.orDie);
                }),
              ),
            );
            const preview = yield* f.service.preview("owner", [f.entry.id]);
            const result = yield* f.service.execute("owner", preview.token);
            assert.isTrue(refused);
            assert.strictEqual(result.results[0]?.status, "removed");
          }),
        ),
    );
    it.effect("protects activation accepted before execution and changed retention policy", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const preview = yield* f.service.preview("owner", [f.entry.id]);
          yield* storageLifecycleLock.withPermit(
            Effect.sync(() =>
              f.setSnapshot((s) => ({
                ...s,
                snapshotSequence: s.snapshotSequence + 1,
                threads: s.threads.map((t) => ({ ...t, archivedAt: null })),
              })),
            ),
          );
          assert.strictEqual(
            (yield* f.service.execute("owner", preview.token)).results[0]?.status,
            "protected",
          );
          f.setSnapshot((s) => ({
            ...s,
            threads: s.threads.map((t) => ({ ...t, archivedAt: old })),
          }));
          const next = yield* f.service.preview("owner", [f.entry.id]);
          f.setSettings({
            ...DEFAULT_SERVER_SETTINGS,
            storageRetention: {
              automatic: true,
              completedWorktreeDays: 30,
              temporaryDataDays: null,
            },
          });
          assert.strictEqual(
            (yield* f.service.execute("owner", next.token)).results[0]?.status,
            "protected",
          );
        }),
      ),
    );
    it.effect(
      "retention is opt-in, retains unmerged branches and never adopts existing checkouts",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            yield* f.service.runRetention;
            assert.isTrue(yield* io(() => fs.lstat(f.checkout).then(() => true)));
            yield* io(() => fs.writeFile(path.join(f.checkout, "tracked.txt"), "unmerged\n"));
            yield* f.git(f.checkout, ["commit", "-am", "unmerged fixture"]);
            assert.isFalse(
              (yield* f.service.scan()).entries.find((entry) => entry.id === f.entry.id)!.eligible,
            );
            yield* f.sql`DELETE FROM storage_owned_entries`;
            const scan = yield* f.service.scan();
            assert.isFalse(scan.entries.find((entry) => entry.path === f.checkout)!.eligible);
            assert.include(
              scan.entries.find((entry) => entry.path === f.checkout)!.reason,
              "No durable",
            );
          }),
        ),
    );
    it.effect("canonicalizes aliased project provenance without claiming a symlink checkout", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const alias = path.join(f.root, "repository-alias");
          yield* io(() => fs.symlink(f.repo, alias, "dir"));
          yield* recordCreatedWorktree(f.sql, alias, f.checkout);
          const rows = yield* f.sql<{
            repository_path: string;
            state: string;
          }>`SELECT * FROM storage_owned_entries`;
          assert.strictEqual(rows[0]!.repository_path, f.repo);
          assert.strictEqual(rows[0]!.state, "owned");
          const checkoutAlias = path.join(f.root, "checkout-alias");
          yield* io(() => fs.symlink(f.checkout, checkoutAlias, "dir"));
          yield* recordCreatedWorktree(f.sql, alias, checkoutAlias);
          assert.strictEqual(
            (yield* f.sql<{ state: string }>`SELECT state FROM storage_owned_entries`)[0]!.state,
            "unverified",
          );
        }),
      ),
    );
    it.effect(
      "rejects expired and cross-principal previews and leaves interrupted removal protected",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            const preview = yield* f.service.preview("owner", [f.entry.id]);
            assert.strictEqual(
              (yield* Effect.exit(f.service.execute("another-owner", preview.token)))._tag,
              "Failure",
            );
            yield* f.sql`UPDATE storage_cleanup_previews SET expires_at = ${old}`;
            assert.strictEqual(
              (yield* Effect.exit(f.service.execute("owner", preview.token)))._tag,
              "Failure",
            );
            yield* f.sql`UPDATE storage_owned_entries SET state = 'removing'`;
            yield* f.service.runRetention;
            const scan = yield* f.service.scan();
            assert.include(
              scan.entries.find((entry) => entry.id === f.entry.id)!.reason,
              "Interrupted",
            );
            assert.isTrue(yield* isStoragePathBlocked(f.sql, f.checkout));
          }),
        ),
    );
    it.effect("requires explicit staging completion and does not remove staging repositories", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const staging = yield* f.service.createTemporaryDirectory(projectId);
          assert.isFalse(
            (yield* f.service.scan()).entries.find((entry) => entry.id === staging.id)!.eligible,
          );
          yield* f.service.completeTemporaryDirectory(staging.id);
          yield* f.sql`UPDATE storage_owned_entries SET created_at = ${old} WHERE id = ${staging.id}`;
          const preview = yield* f.service.preview("owner", [staging.id]);
          yield* f.git(staging.path, ["init"]);
          assert.strictEqual(
            (yield* f.service.execute("owner", preview.token)).results[0]?.status,
            "protected",
          );
        }),
      ),
    );
    it.effect(
      "reports bounded/unavailable sizes and protects symlinks, ignored data and changed identities",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            const bounded = yield* io(() =>
              measureDirectory(f.checkout, { remaining: 0, deadline: Date.now() + 1000 }),
            );
            assert.strictEqual(bounded.sizeStatus, "bounded");
            const missing = yield* io(() =>
              measureDirectory(path.join(f.root, "missing"), {
                remaining: 100,
                deadline: Date.now() + 1000,
              }),
            );
            assert.strictEqual(missing.bytes, null);
            yield* io(() => fs.writeFile(path.join(f.checkout, ".gitignore"), "user-archive\n"));
            yield* f.git(f.checkout, ["add", ".gitignore"]);
            yield* f.git(f.checkout, ["commit", "-m", "ignore fixture"]);
            yield* f.git(f.repo, ["merge", "--ff-only", "fixture-branch"]);
            yield* io(() => fs.writeFile(path.join(f.checkout, "user-archive"), "keep"));
            assert.strictEqual(
              (yield* Effect.exit(io(() => assertCleanWorktree(f.checkout, f.repo))))._tag,
              "Failure",
            );
            const alias = path.join(f.root, "alias");
            yield* io(() => fs.symlink(f.checkout, alias, "dir"));
            assert.strictEqual(
              (yield* Effect.exit(io(() => assertCanonicalPath(alias))))._tag,
              "Failure",
            );
            yield* f.sql`UPDATE storage_owned_entries SET identity_json = '{}'`;
            assert.isFalse(
              (yield* f.service.scan()).entries.find((entry) => entry.id === f.entry.id)!.eligible,
            );
          }),
        ),
    );
    it.effect("creation admission prevents removal and pending cleanup prevents replacement", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const preview = yield* f.service.preview("owner", [f.entry.id]);
          const release = yield* acquireWorktreeCreationLease(f.sql, path.join(f.checkout, "src"));
          const refused = yield* f.service.execute("owner", preview.token);
          assert.strictEqual(refused.results[0]?.status, "protected");
          assert.include(refused.results[0]!.detail, "creation/hydration");
          yield* release;
          yield* f.sql`UPDATE storage_owned_entries SET state = 'removing'`;
          assert.strictEqual(
            (yield* Effect.exit(acquireWorktreeCreationLease(f.sql, path.join(f.checkout, "src"))))
              ._tag,
            "Failure",
          );
          assert.strictEqual(
            (yield* Effect.exit(recordCreatedWorktree(f.sql, f.repo, f.checkout)))._tag,
            "Failure",
          );
          const rows = yield* f.sql<{
            id: string;
            state: string;
          }>`SELECT id, state FROM storage_owned_entries`;
          assert.strictEqual(rows[0]!.id, f.entry.id);
          assert.strictEqual(rows[0]!.state, "removing");
        }),
      ),
    );
    it.effect(
      "matches canonical ancestors, aliases and missing descendants without wildcard/prefix mistakes",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            yield* f.sql`UPDATE storage_owned_entries SET state = 'removing'`;
            const alias = path.join(f.root, "alias");
            yield* io(() => fs.symlink(f.checkout, alias, "dir"));
            const nested = yield* io(() =>
              canonicalStoragePath(path.join(alias, "src", "not-created")),
            );
            assert.strictEqual(nested, path.join(f.checkout, "src", "not-created"));
            assert.isTrue(yield* isStoragePathBlocked(f.sql, nested));
            assert.isFalse(yield* isStoragePathBlocked(f.sql, f.checkout + "-other/src"));
            assert.isTrue(
              yield* isStoragePathBlocked(f.sql, f.checkout.toUpperCase() + "/src", "darwin"),
            );
            const wildcardRoot = path.join(f.root, "literal%_checkout");
            yield* f.sql`INSERT INTO storage_owned_entries (id, path, category, identity_json, created_at, state) VALUES ('wildcard', ${wildcardRoot}, 'worktree', '{}', ${old}, 'removed')`;
            assert.isTrue(yield* isStoragePathBlocked(f.sql, wildcardRoot + "/src"));
            assert.isFalse(
              yield* isStoragePathBlocked(f.sql, path.join(f.root, "literalXXcheckout/src")),
            );
          }),
        ),
    );
    it.effect(
      "non-forced git removal refuses an external file arriving at the final boundary",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            const preview = yield* f.service.preview("owner", [f.entry.id]);
            f.beforeRemove(() =>
              io(() => fs.writeFile(path.join(f.checkout, "external-work.txt"), "keep")).pipe(
                Effect.orDie,
              ),
            );
            assert.strictEqual(
              (yield* f.service.execute("owner", preview.token)).results[0]?.status,
              "failed",
            );
            assert.strictEqual(
              yield* io(() => fs.readFile(path.join(f.checkout, "external-work.txt"), "utf8")),
              "keep",
            );
            assert.isTrue(yield* isStoragePathBlocked(f.sql, path.join(f.checkout, "src")));
            assert.include(
              (yield* f.service.scan()).entries.find((entry) => entry.id === f.entry.id)!.reason,
              "Interrupted",
            );
          }),
        ),
    );
    it.effect("replays an interrupted partial batch without removing remaining entries", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const preview = yield* f.service.preview("owner", [f.entry.id]);
          const recorded = {
            results: [
              { id: "already-recorded", status: "removed", detail: "Recorded before restart." },
            ],
          };
          yield* f.sql`UPDATE storage_cleanup_previews SET state = 'executing', result_json = ${JSON.stringify(recorded)}`;
          const result = yield* f.service.execute("owner", preview.token);
          assert.strictEqual(result.results.length, 2);
          assert.strictEqual(result.results[1]?.status, "failed");
          assert.isTrue(yield* io(() => fs.lstat(f.checkout).then(() => true)));
          assert.deepEqual(yield* f.service.execute("owner", preview.token), result);
        }),
      ),
    );
    it.effect(
      "explicit retention removes only due completed data and preserves measured history",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            const staging = yield* f.service.createTemporaryDirectory(projectId);
            yield* io(() => fs.writeFile(path.join(staging.path, "staged.txt"), "owned staging"));
            yield* f.service.completeTemporaryDirectory(staging.id);
            yield* f.sql`UPDATE storage_owned_entries SET created_at = ${old}, completed_at = ${old} WHERE id = ${staging.id}`;
            f.setSettings({
              ...DEFAULT_SERVER_SETTINGS,
              storageRetention: {
                automatic: true,
                completedWorktreeDays: 30,
                temporaryDataDays: 7,
              },
            });
            const historical = yield* f.sql<{
              measured_bytes: number;
            }>`SELECT measured_bytes FROM storage_usage_history`;
            yield* f.service.runRetention;
            assert.strictEqual(
              (yield* f.sql<{
                state: string;
              }>`SELECT state FROM storage_owned_entries WHERE id = ${f.entry.id}`)[0]!.state,
              "removed",
            );
            assert.strictEqual(
              (yield* f.sql<{
                state: string;
              }>`SELECT state FROM storage_owned_entries WHERE id = ${staging.id}`)[0]!.state,
              "removed",
            );
            assert.deepEqual(
              yield* f.sql<{
                measured_bytes: number;
              }>`SELECT measured_bytes FROM storage_usage_history`,
              historical,
            );
            assert.isTrue(
              (yield* f.git(f.repo, ["rev-parse", "refs/heads/fixture-branch"])).stdout.length > 0,
            );
          }),
        ),
    );
    it.effect("protects submodule checkouts and inventory that exceeds lifecycle bounds", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* io(() =>
            fs.writeFile(path.join(f.checkout, ".gitmodules"), "# fixture submodule modes\n"),
          );
          yield* f.git(f.checkout, ["add", ".gitmodules"]);
          yield* f.git(f.checkout, ["commit", "-m", "submodule fixture"]);
          yield* f.git(f.repo, ["merge", "--ff-only", "fixture-branch"]);
          assert.include(
            (yield* f.service.scan()).entries.find((entry) => entry.id === f.entry.id)!.reason,
            "Submodule",
          );
          f.setSnapshot((s) => ({
            ...s,
            threads: Array.from({ length: 5001 }, (_, index) => ({
              ...s.threads[0]!,
              id: ThreadId.make(`fixture-${index}`),
            })),
          }));
          const bounded = yield* f.service.scan();
          assert.isTrue(bounded.truncated);
          assert.include(
            bounded.entries.find((entry) => entry.id === f.entry.id)!.reason,
            "inventory exceeds",
          );
        }),
      ),
    );
    it.effect(
      "previews selected entries beyond the first inventory page without inventing ownership",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            yield* f.sql`UPDATE storage_owned_entries SET id = 'zz-real-checkout'`;
            for (let index = 0; index < 257; index++) {
              yield* f.sql`INSERT INTO storage_owned_entries (id, path, category, identity_json, created_at, state) VALUES (${String(index).padStart(3, "0")}, ${path.join(f.root, "missing-" + index)}, 'worktree', '{}', ${old}, 'unverified')`;
            }
            yield* f.sql`DELETE FROM storage_usage_history`;
            const first = yield* f.service.scan();
            assert.strictEqual(first.nextCursor, "255");
            assert.isTrue(first.history.every((sample) => sample.incompleteEntries > 0));
            const second = yield* f.service.scan(undefined, first.nextCursor!);
            assert.isTrue(
              second.entries.some((entry) => entry.id === "zz-real-checkout" && entry.eligible),
            );
            assert.strictEqual(
              (yield* f.service.preview("owner", ["zz-real-checkout"])).entries[0]!.path,
              f.checkout,
            );
          }),
        ),
    );

    it.effect(
      "protects active descendant and ancestor sessions without registration or worktree ids",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            yield* io(() => fs.mkdir(path.join(f.checkout, "src")));
            yield* f.sql`UPDATE storage_owned_entries SET created_at = ${old}`;
            for (const kind of ["active", "pending", "background", "ancestor"]) {
              f.setSnapshot((s) => ({
                ...s,
                worktrees: [],
                threads: s.threads.map((thread) => ({
                  ...thread,
                  worktreeId: null,
                  worktreePath: kind === "ancestor" ? f.root : path.join(f.checkout, "src"),
                  archivedAt: kind === "active" || kind === "ancestor" ? null : old,
                  hasPendingUserInput: kind === "pending",
                  backgroundLiveness: kind === "background" ? "working" : null,
                })),
              }));
              assert.isFalse(
                (yield* f.service.scan()).entries.find((entry) => entry.id === f.entry.id)!
                  .eligible,
                kind,
              );
            }
          }),
        ),
    );

    it.effect(
      "protects declared provider exports/database files and settings changed after preview",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            const exportPath = path.join(f.checkout, "cursor-export.json");
            yield* io(() => fs.writeFile(exportPath, "{}"));
            yield* f.git(f.checkout, ["add", "cursor-export.json"]);
            yield* f.git(f.checkout, ["commit", "-m", "tracked export fixture"]);
            yield* f.git(f.repo, ["merge", "--ff-only", "fixture-branch"]);
            const archiveInstance = ProviderInstanceId.make("archive-fixture");
            const settingsForSource = (declaredPath: string) => ({
              ...DEFAULT_SERVER_SETTINGS,
              providerInstances: {
                [archiveInstance]: {
                  driver: ProviderDriverKind.make("cursor"),
                  enabled: false,
                  config: { usageExportPath: declaredPath },
                },
              },
            });
            const providerHome = path.join(f.root, "provider-home");
            f.setProtectedSources((settings) =>
              resolveUsageProtectedPaths(settings, { HOME: providerHome }, providerHome),
            );
            f.setSettings(settingsForSource(exportPath));
            assert.include(
              (yield* f.service.scan()).entries.find((entry) => entry.id === f.entry.id)!.reason,
              "provider archive",
            );
            f.setSettings(settingsForSource(""));
            const preview = yield* f.service.preview("owner", [f.entry.id]);
            f.setSettings(settingsForSource(exportPath));
            assert.strictEqual(
              (yield* f.service.execute("owner", preview.token)).results[0]?.status,
              "protected",
            );
            assert.strictEqual(yield* io(() => fs.readFile(exportPath, "utf8")), "{}");
            const staging = yield* f.service.createTemporaryDirectory(projectId);
            const databasePath = path.join(staging.path, "opencode.db");
            yield* io(() => fs.writeFile(databasePath, "fixture-not-real-account-data"));
            yield* f.service.completeTemporaryDirectory(staging.id);
            yield* f.sql`UPDATE storage_owned_entries SET created_at = ${old} WHERE id = ${staging.id}`;
            f.setSettings({
              ...DEFAULT_SERVER_SETTINGS,
              providerInstances: {
                [archiveInstance]: {
                  driver: ProviderDriverKind.make("opencode"),
                  enabled: false,
                  config: {},
                  environment: [{ name: "OPENCODE_DB", value: databasePath, sensitive: false }],
                },
              },
            });
            assert.isFalse(
              (yield* f.service.scan()).entries.find((entry) => entry.id === staging.id)!.eligible,
            );
            assert.strictEqual(
              yield* io(() => fs.readFile(databasePath, "utf8")),
              "fixture-not-real-account-data",
            );
            // Legacy provider settings are also authoritative, even without instances.
            const historyRoot = path.join(f.checkout, "legacy-history");
            const historyFile = path.join(historyRoot, "sessions", "history.json");
            yield* io(async () => {
              await fs.mkdir(path.dirname(historyFile), { recursive: true });
              await fs.writeFile(historyFile, "synthetic-history");
            });
            yield* f.git(f.checkout, ["add", "legacy-history"]);
            yield* f.git(f.checkout, ["commit", "-m", "legacy history fixture"]);
            yield* f.git(f.repo, ["merge", "--ff-only", "fixture-branch"]);
            f.setSettings({ ...DEFAULT_SERVER_SETTINGS, providerInstances: {} });
            const legacyPreview = yield* f.service.preview("owner", [f.entry.id]);
            f.setSettings({
              ...DEFAULT_SERVER_SETTINGS,
              providerInstances: {},
              providers: {
                ...DEFAULT_SERVER_SETTINGS.providers,
                codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, homePath: historyRoot },
              },
            });
            assert.strictEqual(
              (yield* f.service.execute("owner", legacyPreview.token)).results[0]?.status,
              "protected",
            );
            assert.strictEqual(
              yield* io(() => fs.readFile(historyFile, "utf8")),
              "synthetic-history",
            );
            f.setProtectedSources(null);
            assert.isFalse(
              (yield* f.service.scan()).entries.find((entry) => entry.id === f.entry.id)!.eligible,
            );
          }),
        ),
    );
    it.effect(
      "rechecks provider-only setting changes made during the final filesystem inspection",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            const archiveInstance = ProviderInstanceId.make("late-archive");
            const providerHome = path.join(f.root, "late-provider-home");
            f.setProtectedSources((settings) =>
              resolveUsageProtectedPaths(settings, {}, providerHome),
            );
            const exportPath = path.join(f.checkout, "tracked-usage.json");
            yield* io(() => fs.writeFile(exportPath, "{}"));
            yield* f.git(f.checkout, ["add", "tracked-usage.json"]);
            yield* f.git(f.checkout, ["commit", "-m", "late provider history fixture"]);
            yield* f.git(f.repo, ["merge", "--ff-only", "fixture-branch"]);
            const preview = yield* f.service.preview("owner", [f.entry.id]);
            let changed = false;
            f.duringListWorktrees(() =>
              Effect.gen(function* () {
                const rows = yield* f.sql<{
                  state: string;
                }>`SELECT state FROM storage_owned_entries WHERE id = ${f.entry.id}`;
                if (rows[0]?.state === "removing") {
                  changed = true;
                  f.setSettings({
                    ...DEFAULT_SERVER_SETTINGS,
                    providerInstances: {
                      [archiveInstance]: {
                        driver: ProviderDriverKind.make("cursor"),
                        enabled: false,
                        config: { usageExportPath: exportPath },
                      },
                    },
                  });
                }
              }).pipe(Effect.orDie),
            );
            const result = yield* f.service.execute("owner", preview.token);
            assert.isTrue(changed);
            assert.strictEqual(result.results[0]?.status, "protected");
            assert.strictEqual(yield* io(() => fs.readFile(exportPath, "utf8")), "{}");
          }),
        ),
    );
    it.effect(
      "refuses parent provider admission after a nested checkout's final preflight and permits parents after removal",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            const nested = path.join(f.repo, "nested-checkout");
            yield* f.git(f.repo, ["worktree", "move", f.checkout, nested]);
            yield* recordCreatedWorktree(f.sql, f.repo, nested);
            f.setSnapshot((snapshot) => ({
              ...snapshot,
              threads: snapshot.threads.map((thread) => ({ ...thread, worktreePath: nested })),
              worktrees: (snapshot.worktrees ?? []).map((worktree) =>
                Object.assign({}, worktree, { worktreePath: nested }),
              ),
            }));
            const owned = (yield* f.service.scan()).entries.find((entry) => entry.path === nested)!;
            const preview = yield* f.service.preview("owner", [owned.id]);
            let admissionRefused = false;
            f.beforeRemove(() =>
              Effect.gen(function* () {
                const result = yield* Effect.exit(acquireStoragePathUseLease(f.sql, f.repo));
                admissionRefused = result._tag === "Failure";
                if (result._tag === "Success") yield* result.value;
              }),
            );
            assert.strictEqual(
              (yield* f.service.execute("owner", preview.token)).results[0]?.status,
              "removed",
            );
            assert.isTrue(admissionRefused);
            const release = yield* acquireStoragePathUseLease(f.sql, f.repo);
            yield* release;
          }),
        ),
    );
    it.effect("protects a nested checkout used by an existing ancestor terminal", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          f.setTerminals([
            {
              threadId: "unrelated-terminal",
              terminalId: "parent",
              cwd: f.root,
              worktreePath: null,
              status: "running",
              pid: 42,
              hasRunningSubprocess: true,
            } as DiagnosticsTerminalProcess,
          ]);
          const entry = (yield* f.service.scan()).entries.find((item) => item.id === f.entry.id)!;
          assert.isFalse(entry.eligible);
          assert.include(entry.reason, "terminal");
        }),
      ),
    );
    it.effect(
      "quarantines and preserves additions or modifications at temporary removal boundaries without replaying deletion",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            for (const mutation of [
              "added-at-rename",
              "changed-at-file-rename",
              "added-during-delete",
              "external-settings-change",
            ]) {
              const f = yield* fixture;
              const staging = yield* f.service.createTemporaryDirectory(projectId);
              yield* io(() => fs.writeFile(path.join(staging.path, "owned.txt"), "completed data"));
              yield* f.service.completeTemporaryDirectory(staging.id);
              yield* f.sql`UPDATE storage_owned_entries SET created_at = ${old} WHERE id = ${staging.id}`;
              const preview = yield* f.service.preview("owner", [staging.id]);
              const originalRename = fs.rename;
              const originalUnlink = fs.unlink;
              let quarantine = "";
              let preservedPath = "";
              const rename = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
                await originalRename(source, target);
                if (source === staging.path) {
                  quarantine = String(target);
                  if (mutation === "external-settings-change") {
                    preservedPath = path.join(quarantine, "owned.txt");
                    noteStorageSettingsChange();
                  }
                  if (mutation === "added-at-rename") {
                    preservedPath = path.join(quarantine, "external.txt");
                    await fs.writeFile(preservedPath, "external data");
                  }
                } else if (
                  mutation === "changed-at-file-rename" &&
                  String(target).includes(".verified-")
                ) {
                  preservedPath = String(target);
                  await fs.writeFile(preservedPath, "external data");
                }
              });
              const unlink = vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
                await originalUnlink(target);
                if (mutation === "added-during-delete") {
                  preservedPath = path.join(quarantine, "external.txt");
                  await fs.writeFile(preservedPath, "external data");
                }
              });
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  rename.mockRestore();
                  unlink.mockRestore();
                }),
              );
              const result = yield* f.service.execute("owner", preview.token);
              rename.mockRestore();
              unlink.mockRestore();
              assert.strictEqual(result.results[0]?.status, "failed", mutation);
              assert.strictEqual(
                yield* io(() => fs.readFile(preservedPath, "utf8")),
                mutation === "external-settings-change" ? "completed data" : "external data",
              );
              const rows = yield* f.sql<{
                state: string;
                identity_json: string;
              }>`SELECT state, identity_json FROM storage_owned_entries WHERE id = ${staging.id}`;
              assert.strictEqual(rows[0]?.state, "removing");
              assert.strictEqual(JSON.parse(rows[0]!.identity_json).quarantinePath, quarantine);
              assert.isTrue(yield* isStoragePathBlocked(f.sql, path.join(quarantine, "nested")));
              assert.deepEqual(yield* f.service.execute("owner", preview.token), result);
              assert.strictEqual(
                yield* io(() => fs.readFile(preservedPath, "utf8")),
                mutation === "external-settings-change" ? "completed data" : "external data",
              );
            }
          }),
        ),
    );
    it.effect(
      "refuses ignored archives and untracked files introduced at the Git service boundary",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            for (const ignored of [true, false]) {
              const f = yield* fixture;
              if (ignored) {
                yield* io(() =>
                  fs.writeFile(path.join(f.checkout, ".gitignore"), "external-archive.json\n"),
                );
                yield* f.git(f.checkout, ["add", ".gitignore"]);
                yield* f.git(f.checkout, ["commit", "-m", "merged ignore rule"]);
                yield* f.git(f.repo, ["merge", "--ff-only", "fixture-branch"]);
              } else {
                yield* f.git(f.repo, ["config", "status.showUntrackedFiles", "no"]);
              }
              const external = path.join(
                f.checkout,
                ignored ? "external-archive.json" : "external.txt",
              );
              const preview = yield* f.service.preview("owner", [f.entry.id]);
              f.beforeRemove(() =>
                io(() => fs.writeFile(external, "external archive")).pipe(Effect.orDie),
              );
              const result = yield* f.service.execute("owner", preview.token);
              assert.strictEqual(result.results[0]?.status, "failed");
              assert.strictEqual(
                yield* io(() => fs.readFile(external, "utf8")),
                "external archive",
              );
              assert.deepEqual(yield* f.service.execute("owner", preview.token), result);
              assert.strictEqual(
                yield* io(() => fs.readFile(external, "utf8")),
                "external archive",
              );
            }
          }),
        ),
    );
    it.effect("protects Git-locked owned worktrees in verified cleanup mode", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const preview = yield* f.service.preview("owner", [f.entry.id]);
          f.beforeRemove(() =>
            f.git(f.repo, ["worktree", "lock", f.checkout]).pipe(Effect.asVoid, Effect.orDie),
          );
          const result = yield* f.service.execute("owner", preview.token);
          assert.strictEqual(result.results[0]?.status, "failed");
          assert.include(result.results[0]!.detail, "Locked");
          assert.strictEqual(
            yield* io(() => fs.readFile(path.join(f.checkout, "tracked.txt"), "utf8")),
            "fixture\n",
          );
          assert.isNotEmpty(
            (yield* f.git(f.repo, ["rev-parse", "refs/heads/fixture-branch"])).stdout,
          );
        }),
      ),
    );
    it.effect(
      "keeps cleanup settings admission until interrupted removal callbacks fully settle",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            f.beforeRemove(() =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            );
            const preview = yield* f.service.preview("owner", [f.entry.id]);
            const execution = yield* Effect.forkChild(f.service.execute("owner", preview.token));
            yield* Deferred.await(entered);
            const cancellation = yield* Effect.forkChild(Fiber.interrupt(execution));
            yield* Effect.yieldNow;
            const writer = yield* storageLifecycleLock
              .withPermit(Effect.sync(acquireStorageSettingsUpdateLease))
              .pipe(Effect.exit);
            assert.equal(writer._tag, "Failure");
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(cancellation);
            const finish = yield* storageLifecycleLock.withPermit(
              Effect.sync(acquireStorageSettingsUpdateLease),
            );
            finish();
            assert.isTrue(yield* isStoragePathBlocked(f.sql, f.checkout));
            assert.isNotEmpty(
              (yield* f.git(f.repo, ["rev-parse", "refs/heads/fixture-branch"])).stdout,
            );
          }),
        ),
    );
    it.effect(
      "serializes live retries after the first persisted result without declaring interruption",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            const secondPath = path.join(f.root, "second-checkout");
            yield* f.git(f.repo, ["worktree", "add", "-b", "second-branch", secondPath]);
            yield* recordCreatedWorktree(f.sql, f.repo, secondPath);
            const second = (yield* f.sql<{
              id: string;
            }>`SELECT id FROM storage_owned_entries WHERE path = ${secondPath}`)[0]!;
            f.setSnapshot((s) => ({
              ...s,
              threads: [
                ...s.threads,
                {
                  ...s.threads[0]!,
                  id: ThreadId.make("second-thread"),
                  worktreeId: WorktreeId.make("second-worktree"),
                  worktreePath: secondPath,
                },
              ],
              worktrees: [
                ...s.worktrees!,
                {
                  ...s.worktrees![0]!,
                  worktreeId: WorktreeId.make("second-worktree"),
                  branch: "second-branch",
                  worktreePath: secondPath,
                },
              ],
            }));
            const preview = yield* f.service.preview("owner", [f.entry.id, second.id]);
            const paused = yield* Deferred.make<void>();
            const resume = yield* Deferred.make<void>();
            let removals = 0;
            f.beforeRemove(() =>
              Effect.gen(function* () {
                if (++removals === 2) {
                  yield* Deferred.succeed(paused, undefined);
                  yield* Deferred.await(resume);
                }
              }),
            );
            const original = yield* Effect.forkChild(f.service.execute("owner", preview.token));
            yield* Deferred.await(paused);
            const retry = yield* Effect.forkChild(f.service.execute("owner", preview.token));
            yield* Effect.yieldNow;
            const live = (yield* f.sql<{
              state: string;
              result_json: string;
            }>`SELECT state, result_json FROM storage_cleanup_previews WHERE token = ${preview.token}`)[0]!;
            assert.strictEqual(live.state, "executing");
            assert.strictEqual(JSON.parse(live.result_json).results.length, 1);
            yield* Deferred.succeed(resume, undefined);
            const result = yield* Fiber.join(original);
            assert.deepEqual(yield* Fiber.join(retry), result);
            assert.isTrue(result.results.every((item) => item.status === "removed"));
            assert.strictEqual(removals, 2);
          }),
        ),
    );
    it.effect(
      "filters due retention before the operation cap and rejects shared special files",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            for (let index = 0; index < 21; index++) {
              const staging = yield* f.service.createTemporaryDirectory(projectId);
              yield* f.service.completeTemporaryDirectory(staging.id);
              yield* f.sql`UPDATE storage_owned_entries SET id = ${String(index).padStart(3, "0")}, created_at = ${old}, completed_at = ${index === 20 ? old : new Date().toISOString()} WHERE id = ${staging.id}`;
            }
            f.setSettings({
              ...DEFAULT_SERVER_SETTINGS,
              storageRetention: {
                automatic: true,
                completedWorktreeDays: null,
                temporaryDataDays: 7,
              },
            });
            yield* f.service.runRetention;
            const rows = yield* f.sql<{
              id: string;
              state: string;
            }>`SELECT id, state FROM storage_owned_entries WHERE category = 'temporary' ORDER BY id`;
            assert.isTrue(rows.slice(0, 20).every((row) => row.state === "owned"));
            assert.strictEqual(rows[20]!.state, "removed");
            const staging = yield* f.service.createTemporaryDirectory(projectId);
            yield* io(() =>
              fs.link(path.join(f.repo, "tracked.txt"), path.join(staging.path, "shared-file")),
            );
            assert.strictEqual(
              (yield* Effect.exit(f.service.completeTemporaryDirectory(staging.id)))._tag,
              "Failure",
            );
            yield* f.sql`UPDATE storage_owned_entries SET created_at = ${old} WHERE id = ${staging.id}`;
            assert.isFalse(
              (yield* f.service.scan()).entries.find((entry) => entry.id === staging.id)!.eligible,
            );
          }),
        ),
    );
    it.effect("protects external files added or changed after staging completion", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const staging = yield* f.service.createTemporaryDirectory(projectId);
          yield* io(() => fs.writeFile(path.join(staging.path, "staged.txt"), "owned"));
          yield* f.service.completeTemporaryDirectory(staging.id);
          yield* f.sql`UPDATE storage_owned_entries SET created_at = ${old} WHERE id = ${staging.id}`;
          const preview = yield* f.service.preview("owner", [staging.id]);
          yield* io(() => fs.writeFile(path.join(staging.path, "external-work.txt"), "keep"));
          assert.strictEqual(
            (yield* f.service.execute("owner", preview.token)).results[0]?.status,
            "protected",
          );
          assert.strictEqual(
            yield* io(() => fs.readFile(path.join(staging.path, "external-work.txt"), "utf8")),
            "keep",
          );
        }),
      ),
    );

    it.effect(
      "counts unregistered managed checkouts separately from their containing repository",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            const nested = path.join(f.repo, "managed-checkout");
            yield* f.git(f.repo, ["worktree", "add", "-b", "nested-fixture", nested]);
            yield* recordCreatedWorktree(f.sql, f.repo, nested);
            const before = yield* f.service.scan();
            const repoBefore = before.entries.find((entry) => entry.path === f.repo)!;
            yield* io(() =>
              fs.writeFile(path.join(nested, "external-large-file.txt"), "x".repeat(128 * 1024)),
            );
            const after = yield* f.service.scan();
            // Git administrative data may change; the candidate's payload is never double-counted.
            assert.isTrue(
              (after.entries.find((entry) => entry.path === f.repo)!.bytes ?? 0) -
                (repoBefore.bytes ?? 0) <
                128 * 1024,
            );
            assert.isTrue(
              (after.entries.find((entry) => entry.path === nested)!.bytes ?? 0) >= 128 * 1024,
            );
            assert.isFalse(after.entries.find((entry) => entry.path === nested)!.eligible);
          }),
        ),
    );

    it.effect(
      "protects the actual provider cwd after thread metadata moves and refuses unknown runtime paths",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            yield* f.sql`UPDATE storage_owned_entries SET created_at = ${old}`;
            f.setSnapshot((s) => ({
              ...s,
              worktrees: [],
              threads: s.threads.map((thread) => ({
                ...thread,
                worktreeId: null,
                worktreePath: f.repo,
              })),
            }));
            f.setBindings([
              {
                threadId,
                provider: ProviderDriverKind.make("fixture"),
                runtimePayload: { cwd: path.join(f.checkout, "src") },
              },
            ]);
            assert.isFalse(
              (yield* f.service.scan()).entries.find((entry) => entry.id === f.entry.id)!.eligible,
            );
            f.setBindings([
              { threadId, provider: ProviderDriverKind.make("fixture"), runtimePayload: null },
            ]);
            assert.isFalse(
              (yield* f.service.scan()).entries.find((entry) => entry.id === f.entry.id)!.eligible,
            );
          }),
        ),
    );
  },
);
