import { beginWorktreeSetup } from "../project/worktreeSetupState.ts";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  GitCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorktreeId,
  type DiagnosticsTerminalProcess,
} from "@ryco/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectAvatarStore } from "../project/Services/ProjectAvatarStore.ts";
import { RepositoryIdentityResolverLive } from "../project/Layers/RepositoryIdentityResolver.ts";
import { ServerConfig } from "../config.ts";
import {
  acquireStoragePathUseLease,
  acquireWorktreeCreationLease,
  isStoragePathBlocked,
  recordCreatedWorktree,
} from "../storage/lifecycle.ts";
import { captureWorktreeIdentity } from "../storage/filesystem.ts";
import { makeWorkspaceAccessPolicy } from "./Layers/WorkspaceAccessPolicy.ts";
import { makeWorkspaceLifecycle, type WorkspaceLifecycleDeps } from "./WorkspaceLifecycle.ts";
import { makeSqlCheckoutFence } from "./checkoutFence.ts";
import { makeClientWorkspaceUse } from "./clientWorkspaceUse.ts";

const projectId = ProjectId.make("legacy-project-id");
const worktreeId = WorktreeId.make("topic");
const threadId = ThreadId.make("current");
const createdAt = "2026-10-01T00:00:00.000Z";
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "fixture" };

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ryco-worktree-move-")));
  const repo = path.join(root, "repo");
  const source = path.join(root, "original-root", projectId, "fix-login__pearl");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  git(root, "init", "-b", "main", repo);
  git(
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  );
  git(repo, "worktree", "add", "-b", "fix/login", source);
  await fs.writeFile(path.join(source, "keep.txt"), "unsaved-on-disk");
  const layer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(
      Layer.succeed(ProjectAvatarStore, {
        write: () => Effect.die("unused"),
        read: () => Effect.succeed(null),
        remove: () => Effect.void,
      }),
    ),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(root, root)),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const snapshots = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const config = await runtime.runPromise(Effect.service(ServerConfig));
  await runtime.runPromise(
    engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("project-create"),
      projectId,
      title: "Ryco",
      workspaceRoot: repo,
      defaultModelSelection: modelSelection,
      createdAt,
    }),
  );
  await runtime.runPromise(
    engine.dispatch({
      type: "worktree.create",
      commandId: CommandId.make("worktree-create"),
      worktreeId,
      projectId,
      branch: "fix/login",
      worktreePath: source,
      origin: "branch",
      prNumber: null,
      issueNumber: null,
      prTitle: null,
      issueTitle: null,
      createdAt,
    }),
  );
  for (const id of [threadId, ThreadId.make("archived"), ThreadId.make("trashed")]) {
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${id}`),
        threadId: id,
        projectId,
        title: "Keep conversation",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "fix/login",
        worktreePath: source,
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.attach-to-worktree",
        commandId: CommandId.make(`attach:${id}`),
        threadId: id,
        worktreeId,
        attachedAt: createdAt,
      }),
    );
  }
  // Include persisted archived/Trash rows that shell snapshots do not all expose.
  await runtime.runPromise(
    sql`UPDATE projection_threads SET archived_at = ${createdAt} WHERE thread_id = 'archived'`,
  );
  await runtime.runPromise(
    sql`UPDATE projection_threads SET trashed_at = ${createdAt}, deleted_at = ${createdAt} WHERE thread_id = 'trashed'`,
  );
  await runtime.runPromise(recordCreatedWorktree(sql, repo, source));
  const busy = {
    provider: false,
    terminals: [] as DiagnosticsTerminalProcess[],
    failMove: false,
    failInvalidation: false,
    moves: 0,
  };
  const policy = await runtime.runPromise(makeWorkspaceAccessPolicy(root));
  const deps = {
    snapshots,
    threads: { listTrashed: () => Effect.succeed([]) },
    engine,
    providers: null,
    sessionDirectory: {
      listBindings: () =>
        Effect.succeed(
          busy.provider
            ? [{ threadId, provider: "codex", status: "running", lastSeenAt: createdAt }]
            : [],
        ),
    },
    terminals: { listDiagnostics: Effect.sync(() => busy.terminals), close: () => Effect.void },
    policy,
    gitDriver: {
      execute: (input: { cwd: string; args: readonly string[] }) =>
        Effect.gen(function* () {
          busy.moves++;
          expect(input.args).toEqual(["worktree", "move", expect.any(String), expect.any(String)]);
          expect(yield* isStoragePathBlocked(sql, input.args[2]!)).toBe(true);
          expect(yield* isStoragePathBlocked(sql, input.args[3]!)).toBe(true);
          if (busy.failMove)
            return yield* new GitCommandError({
              operation: "test",
              cwd: repo,
              command: "git worktree move",
              detail: "locked",
            });
          return {
            stdout: git(input.cwd, ...input.args),
            stderr: "",
            exitCode: 0,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    },
    git: {
      invalidateStatus: () =>
        busy.failInvalidation
          ? Effect.fail(new Error("fixture status cache unavailable"))
          : Effect.void,
    },
    settings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
    fence: makeSqlCheckoutFence(sql),
    migration: { sql, stateDir: config.stateDir },
  } as unknown as WorkspaceLifecycleDeps;
  const service = makeWorkspaceLifecycle(deps);
  const migrate = () => runtime.runPromise(service.migrateManagedWorktrees!());
  const journal = () =>
    runtime.runPromise(
      sql<{
        state: string;
        destination_path: string;
        source_path: string;
      }>`SELECT * FROM managed_worktree_relocations`,
    );
  const seedJournal = async (destination: string, state = "moving") => {
    const identity = await captureWorktreeIdentity(repo, source);
    const worktree = (await runtime.runPromise(snapshots.getShellSnapshot())).worktrees![0]!;
    await runtime.runPromise(sql`INSERT INTO managed_worktree_relocations (worktree_id, project_id, repository_path, source_path, destination_path, identity_json, expected_updated_at, state, created_at)
      VALUES (${worktreeId}, ${projectId}, ${repo}, ${source}, ${destination}, ${JSON.stringify(identity)}, ${worktree.updatedAt}, ${state}, ${createdAt})`);
  };
  return {
    root,
    repo,
    source,
    sql,
    engine,
    snapshots,
    runtime,
    busy,
    git,
    migrate,
    recover: () => runtime.runPromise(service.recoverManagedWorktrees!()),
    journal,
    seedJournal,
    dispose: async () => {
      await runtime.dispose();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

describe("managed worktree migration", () => {
  it("moves dirty checkouts in their original root and atomically retargets current, archived and trashed conversations", async () => {
    const f = await fixture();
    try {
      await f.migrate();
      const rows = await f.journal();
      expect(rows[0]?.state).toBe("complete");
      const target = rows[0]!.destination_path;
      expect(target).toMatch(/original-root\/[a-f0-9]{8}_ryco\/[a-f0-9]{8}_fix-login$/);
      expect(await fs.readFile(path.join(target, "keep.txt"), "utf8")).toBe("unsaved-on-disk");
      expect(f.git(f.repo, "worktree", "list", "--porcelain")).toContain(`worktree ${target}`);
      const snapshot = await f.runtime.runPromise(f.snapshots.getShellSnapshot());
      expect(snapshot.worktrees?.[0]?.relocatedFromPath).toBe(f.source);
      expect(
        await f.runtime.runPromise(f.snapshots.getWorktreeShellById!(worktreeId)),
      ).toMatchObject({
        _tag: "Some",
        value: { worktreePath: target, relocatedFromPath: f.source },
      });
      const threads = await f.runtime.runPromise(
        f.sql<{
          worktree_path: string;
          archived_at: string | null;
          trashed_at: string | null;
        }>`SELECT worktree_path, archived_at, trashed_at FROM projection_threads`,
      );
      expect(threads).toHaveLength(3);
      expect(threads.every((t) => t.worktree_path === target)).toBe(true);
      expect(threads.filter((t) => t.archived_at !== null)).toHaveLength(1);
      expect(threads.filter((t) => t.trashed_at !== null)).toHaveLength(1);
      expect(await f.runtime.runPromise(isStoragePathBlocked(f.sql, f.source))).toBe(true);
      expect(await f.runtime.runPromise(isStoragePathBlocked(f.sql, target))).toBe(false);
      await expect(
        f.runtime.runPromise(acquireWorktreeCreationLease(f.sql, f.source)),
      ).rejects.toThrow("retired checkout path");
      await f.migrate();
      expect(f.busy.moves).toBe(1);
      const owned = await f.runtime.runPromise(
        f.sql<{ path: string }>`SELECT path FROM storage_owned_entries WHERE state = 'owned'`,
      );
      expect(owned.map((r) => r.path)).toEqual([target]);
    } finally {
      await f.dispose();
    }
  });

  it.each(["provider", "terminal", "editor", "creation", "continuation"])(
    "defers a busy %s and retries after release",
    async (kind) => {
      const f = await fixture();
      let release: Effect.Effect<void> = Effect.void;
      try {
        if (kind === "provider") f.busy.provider = true;
        if (kind === "terminal")
          f.busy.terminals = [
            {
              threadId,
              terminalId: "shell",
              cwd: f.source,
              worktreePath: f.source,
              status: "running",
              pid: 1234,
              hasRunningSubprocess: false,
              exitCode: null,
              exitSignal: null,
              updatedAt: createdAt,
            },
          ];
        if (kind === "editor" || kind === "creation")
          release = await f.runtime.runPromise(
            kind === "editor"
              ? acquireStoragePathUseLease(f.sql, f.source)
              : acquireWorktreeCreationLease(f.sql, f.source),
          );
        if (kind === "continuation")
          await f.runtime.runPromise(
            f.sql`INSERT INTO restart_continuations (thread_id, source_turn_id, kind, status, captured_at, last_observed_at, record_json) VALUES (${threadId}, 'turn', 'in-flight', 'pending', ${createdAt}, ${createdAt}, '{}')`,
          );
        await f.migrate();
        expect(f.busy.moves).toBe(0);
        expect(await f.journal()).toEqual([]);
        f.busy.provider = false;
        f.busy.terminals = [];
        await f.runtime.runPromise(release);
        await f.runtime.runPromise(f.sql`DELETE FROM restart_continuations`);
        await f.migrate();
        expect((await f.journal())[0]?.state).toBe("complete");
      } finally {
        await f.runtime.runPromise(release);
        await f.dispose();
      }
    },
  );

  it.each(["source", "destination"])(
    "recovers an interrupted move with only the verified %s present",
    async (present) => {
      const f = await fixture();
      try {
        const target = path.join(f.root, "original-root", "a7c3b9d2_ryco", "b7c3b9d2_fix-login");
        await f.seedJournal(target);
        if (present === "destination") {
          await fs.mkdir(path.dirname(target), { recursive: true });
          f.git(f.repo, "worktree", "move", f.source, target);
        }
        await f.migrate();
        expect((await f.journal())[0]?.state).toBe("complete");
        expect(await fs.readFile(path.join(target, "keep.txt"), "utf8")).toBe("unsaved-on-disk");
      } finally {
        await f.dispose();
      }
    },
  );

  it.each(["source", "destination"])(
    "recovers the verified %s before provider resume without starting a new move",
    async (present) => {
      const f = await fixture();
      try {
        const target = path.join(f.root, "original-root", "a7c3b9d2_ryco", "b7c3b9d2_fix-login");
        await f.seedJournal(target);
        if (present === "destination") {
          await fs.mkdir(path.dirname(target), { recursive: true });
          f.git(f.repo, "worktree", "move", f.source, target);
        }
        f.busy.provider = true;
        await f.recover();
        expect((await f.journal())[0]?.state).toBe(
          present === "destination" ? "complete" : "deferred",
        );
        expect(f.busy.moves).toBe(0);
        const current = (await f.runtime.runPromise(f.snapshots.getShellSnapshot())).threads.find(
          (t) => t.id === threadId,
        )!;
        expect(current.worktreePath).toBe(present === "destination" ? target : f.source);
        expect(await f.runtime.runPromise(isStoragePathBlocked(f.sql, current.worktreePath!))).toBe(
          false,
        );
      } finally {
        await f.dispose();
      }
    },
  );

  it.each(["manual", "unverified", "incomplete", "external-editor"])(
    "protects %s checkouts from automatic migration",
    async (kind) => {
      const f = await fixture();
      try {
        if (kind === "manual")
          await f.runtime.runPromise(
            f.sql`UPDATE projection_worktrees SET origin = 'manual' WHERE worktree_id = ${worktreeId}`,
          );
        if (kind === "unverified")
          await f.runtime.runPromise(
            f.sql`UPDATE storage_owned_entries SET state = 'unverified' WHERE path = ${f.source}`,
          );
        if (kind === "external-editor") {
          const client = await f.runtime.runPromise(makeClientWorkspaceUse);
          await f.runtime.runPromise(client.externalEditor(f.source, Effect.void));
          await f.runtime.runPromise(client.release);
        }
        if (kind === "incomplete") {
          const config = await f.runtime.runPromise(Effect.service(ServerConfig));
          await f.runtime.runPromise(beginWorktreeSetup(config.stateDir, f.source, f.repo));
        }
        await f.migrate();
        expect(f.busy.moves).toBe(0);
        expect(await f.journal()).toEqual([]);
        expect(await fs.readFile(path.join(f.source, "keep.txt"), "utf8")).toBe("unsaved-on-disk");
      } finally {
        await f.dispose();
      }
    },
  );

  it("keeps the planned folder stable when a deferred checkout's branch is renamed", async () => {
    const f = await fixture();
    try {
      const target = path.join(f.root, "original-root", "a7c3b9d2_ryco", "b7c3b9d2_fix-login");
      await f.seedJournal(target, "deferred");
      f.git(f.source, "branch", "-m", "fix/login-timeout");
      await f.runtime.runPromise(
        f.engine.dispatch({
          type: "worktree.meta.update",
          commandId: CommandId.make("rename"),
          worktreeId,
          branch: "fix/login-timeout",
          title: "Better title",
          changedAt: "2026-10-02T00:00:00.000Z",
        }),
      );
      await f.migrate();
      expect((await f.journal())[0]?.state).toBe("complete");
      expect((await f.journal())[0]?.destination_path).toBe(target);
      expect(f.git(target, "branch", "--show-current").trim()).toBe("fix/login-timeout");
      const worktree = (await f.runtime.runPromise(f.snapshots.getShellSnapshot())).worktrees![0]!;
      expect(worktree.title).toBe("Better title");
    } finally {
      await f.dispose();
    }
  });

  it("defers concurrent branch metadata during a fenced move", async () => {
    const f = await fixture();
    try {
      const target = path.join(f.root, "original-root", "a7c3b9d2_ryco", "b7c3b9d2_fix-login");
      await f.seedJournal(target);
      const result = await f.runtime.runPromise(
        f.engine
          .dispatch({
            type: "worktree.meta.update",
            commandId: CommandId.make("rename-fenced"),
            worktreeId,
            branch: "fix/login-timeout",
            changedAt: "2026-10-02T00:00:00.000Z",
          })
          .pipe(Effect.exit),
      );
      expect(result._tag).toBe("Failure");
      expect(
        (await f.runtime.runPromise(f.snapshots.getShellSnapshot())).worktrees![0]!.branch,
      ).toBe("fix/login");
      await f.migrate();
      expect((await f.journal())[0]?.state).toBe("complete");
    } finally {
      await f.dispose();
    }
  });

  it("migrates an idle sibling while a provider keeps another checkout in the legacy parent", async () => {
    const f = await fixture();
    try {
      const sibling = path.join(path.dirname(f.source), "other__pearl");
      const siblingId = WorktreeId.make("idle-sibling");
      f.git(f.repo, "worktree", "add", "-b", "fix/other", sibling);
      await f.runtime.runPromise(
        f.engine.dispatch({
          type: "worktree.create",
          commandId: CommandId.make("sibling-create"),
          worktreeId: siblingId,
          projectId,
          branch: "fix/other",
          worktreePath: sibling,
          origin: "branch",
          prNumber: null,
          issueNumber: null,
          prTitle: null,
          issueTitle: null,
          createdAt,
        }),
      );
      await f.runtime.runPromise(recordCreatedWorktree(f.sql, f.repo, sibling));
      f.busy.provider = true;
      await f.migrate();
      expect(f.busy.moves).toBe(1);
      expect((await f.journal())[0]?.source_path).toBe(sibling);
      expect(await fs.readFile(path.join(f.source, "keep.txt"), "utf8")).toBe("unsaved-on-disk");
      f.busy.provider = false;
      await f.migrate();
      const rows = await f.journal();
      expect(rows.every((row) => row.state === "complete")).toBe(true);
      expect(new Set(rows.map((row) => path.dirname(row.destination_path))).size).toBe(1);
      await expect(fs.lstat(path.dirname(f.source))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await f.dispose();
    }
  });

  it("rolls back all recorded paths and ownership together when projection fails after a verified move", async () => {
    const f = await fixture();
    try {
      await f.runtime
        .runPromise(f.sql`CREATE TRIGGER reject_relocation BEFORE UPDATE OF path ON storage_owned_entries
        BEGIN SELECT RAISE(ABORT, 'fixture projection failure'); END`);
      await f.migrate();
      const rows = await f.journal();
      expect(rows[0]?.state).toBe("attention");
      expect(await fs.readFile(path.join(rows[0]!.destination_path, "keep.txt"), "utf8")).toBe(
        "unsaved-on-disk",
      );
      const worktree = (await f.runtime.runPromise(f.snapshots.getShellSnapshot())).worktrees![0]!;
      expect(worktree.worktreePath).toBe(f.source);
      const threads = await f.runtime.runPromise(
        f.sql<{ worktree_path: string }>`SELECT worktree_path FROM projection_threads`,
      );
      expect(threads.every((thread) => thread.worktree_path === f.source)).toBe(true);
      expect(
        (
          await f.runtime.runPromise(
            f.sql<{ path: string }>`SELECT path FROM storage_owned_entries`,
          )
        )[0]!.path,
      ).toBe(f.source);
      expect(
        await f.runtime.runPromise(isStoragePathBlocked(f.sql, rows[0]!.destination_path)),
      ).toBe(true);
    } finally {
      await f.dispose();
    }
  });

  it("keeps a committed destination usable when post-commit cache invalidation fails", async () => {
    const f = await fixture();
    try {
      f.busy.failInvalidation = true;
      await f.migrate();
      const row = (await f.journal())[0]!;
      expect(row.state).toBe("complete");
      expect(
        (await f.runtime.runPromise(f.snapshots.getShellSnapshot())).worktrees?.[0]?.worktreePath,
      ).toBe(row.destination_path);
      expect(await f.runtime.runPromise(isStoragePathBlocked(f.sql, row.destination_path))).toBe(
        false,
      );
      expect(await fs.readFile(path.join(row.destination_path, "keep.txt"), "utf8")).toBe(
        "unsaved-on-disk",
      );
    } finally {
      await f.dispose();
    }
  });

  it("retains both paths and fences ambiguous recovery instead of overwriting files", async () => {
    const f = await fixture();
    try {
      const target = path.join(f.root, "original-root", "a7c3b9d2_ryco", "b7c3b9d2_fix-login");
      await f.seedJournal(target);
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, "foreign.txt"), "foreign");
      await f.migrate();
      expect((await f.journal())[0]?.state).toBe("attention");
      expect(f.busy.moves).toBe(0);
      expect(await fs.readFile(path.join(target, "foreign.txt"), "utf8")).toBe("foreign");
      expect(await fs.readFile(path.join(f.source, "keep.txt"), "utf8")).toBe("unsaved-on-disk");
      expect(await f.runtime.runPromise(isStoragePathBlocked(f.sql, target))).toBe(true);
      await f.migrate();
      expect(f.busy.moves).toBe(0);
    } finally {
      await f.dispose();
    }
  });

  it("refuses a corrupted journal that redirects the checkout outside its original root", async () => {
    const f = await fixture();
    try {
      const target = path.join(f.root, "another-root", "a7c3b9d2_ryco", "b7c3b9d2_fix-login");
      await f.seedJournal(target);
      await f.recover();
      expect((await f.journal())[0]?.state).toBe("attention");
      expect(f.busy.moves).toBe(0);
      expect(await fs.readFile(path.join(f.source, "keep.txt"), "utf8")).toBe("unsaved-on-disk");
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await f.dispose();
    }
  });

  it("honors a real Git worktree lock without forcing or deleting the checkout", async () => {
    const f = await fixture();
    try {
      f.git(f.repo, "worktree", "lock", f.source);
      await f.migrate();
      expect(await f.journal()).toEqual([]);
      expect(await fs.readFile(path.join(f.source, "keep.txt"), "utf8")).toBe("unsaved-on-disk");
      expect(f.git(f.repo, "worktree", "list", "--porcelain")).toContain("locked");
      await f.migrate();
      expect(f.busy.moves).toBe(0);
    } finally {
      await f.dispose();
    }
  });

  it("retains unsupported moves, releases unchanged source admission and does not force or repeatedly retry", async () => {
    const f = await fixture();
    try {
      f.busy.failMove = true;
      await f.migrate();
      expect((await f.journal())[0]?.state).toBe("failed");
      expect(await f.runtime.runPromise(isStoragePathBlocked(f.sql, f.source))).toBe(false);
      expect(await fs.readFile(path.join(f.source, "keep.txt"), "utf8")).toBe("unsaved-on-disk");
      await f.migrate();
      expect(f.busy.moves).toBe(1);
    } finally {
      await f.dispose();
    }
  });

  it("pins connected editor reads, releases them on disconnect, and refuses stale writers after migration", async () => {
    const f = await fixture();
    try {
      const client = await f.runtime.runPromise(makeClientWorkspaceUse);
      await f.runtime.runPromise(client.use(f.source, Effect.void));
      await f.migrate();
      expect(f.busy.moves).toBe(0);
      await f.runtime.runPromise(client.release);
      await f.migrate();
      const staleClient = await f.runtime.runPromise(makeClientWorkspaceUse);
      const denied = await f.runtime.runPromise(
        staleClient.use(f.source, Effect.void).pipe(Effect.flip),
      );
      expect(denied.detail).toContain("cleanup is pending or complete");
    } finally {
      await f.dispose();
    }
  });
});
