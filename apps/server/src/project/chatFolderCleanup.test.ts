import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type ChatFolderCleanupAfterDays,
  DEFAULT_SERVER_SETTINGS,
  type DiagnosticsTerminalProcess,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@ryco/contracts";
import { Effect, Layer, type Scope } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  type ProjectionProject,
  ProjectionProjectRepository,
} from "../persistence/Services/ProjectionProjects.ts";
import type { ProviderRuntimeBindingWithMetadata } from "../provider/Services/ProviderSessionDirectory.ts";
import { acquireStoragePathUseLease } from "../storage/lifecycle.ts";
import { removeIdleChatFolders } from "./chatFolderCleanup.ts";
import { chatFolderSuffix } from "./chatFolderNames.ts";
import { isRemovedChatFolder, restoreChatFolder } from "./chatFolderRestore.ts";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const FOUR_DAYS_AGO = "2026-10-15T12:00:00.000Z";
const YESTERDAY = "2026-10-18T12:00:00.000Z";

let scratch: string;
let chatsRoot: string;
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), "ryco-chat-cleanup-")));
  chatsRoot = path.join(scratch, "chats");
  await mkdir(chatsRoot);
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A chat whose folder carries the name Ryco would have given it. */
const chat = (id: string, overrides: Partial<ProjectionProject> = {}): ProjectionProject => ({
  projectId: ProjectId.make(id),
  kind: "chat",
  title: id,
  workspaceRoot: path.join(chatsRoot, `2026-10-15-chat-${chatFolderSuffix(id, 0)}`),
  projectMetadataDir: ".ryco",
  defaultModelSelection: null,
  customAvatarContentHash: null,
  preferredRemoteName: null,
  scripts: [],
  createdAt: FOUR_DAYS_AGO,
  updatedAt: FOUR_DAYS_AGO,
  deletedAt: null,
  ...overrides,
});

const exists = (folder: string) =>
  lstat(folder).then(
    () => true,
    () => false,
  );

interface World {
  readonly projects: ReadonlyArray<ProjectionProject>;
  /** Thread rows by project, with their `updated_at`. */
  readonly threads?: ReadonlyArray<{ readonly projectId: string; readonly updatedAt: string }>;
  readonly pendingTurnFor?: string;
  readonly days?: ChatFolderCleanupAfterDays;
  readonly bindings?: ReadonlyArray<ProviderRuntimeBindingWithMetadata>;
  readonly terminals?: ReadonlyArray<DiagnosticsTerminalProcess>;
  /** Paths outside the chats root the sweep must treat as foreign. */
  readonly outsideRoot?: boolean;
}

const seed = (world: World) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projects = yield* ProjectionProjectRepository;
    for (const row of world.projects) yield* projects.upsert(row);
    for (const [index, row] of (world.threads ?? []).entries()) {
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          created_at, updated_at
        ) VALUES (
          ${`thread-${row.projectId}-${index}`}, ${row.projectId}, 'Thread',
          '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 'default', ${FOUR_DAYS_AGO},
          ${row.updatedAt}
        )
      `;
    }
    if (world.pendingTurnFor !== undefined) {
      yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
        VALUES (${`thread-${world.pendingTurnFor}-0`}, NULL, 'message', 'pending', ${FOUR_DAYS_AGO}, '[]')`;
    }
    return sql;
  });

const sweepWith = (
  world: World,
  before?: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, never, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const sql = yield* seed(world);
    if (before) yield* before(sql);
    return yield* removeIdleChatFolders({
      sql,
      settings: {
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          chatFolderCleanupAfterDays: world.days === undefined ? 3 : world.days,
        }),
      },
      chatFolders: {
        isInsideChatsRoot: (candidate) =>
          Effect.succeed(!world.outsideRoot && path.dirname(candidate) === chatsRoot),
      },
      sessionDirectory: { listBindings: () => Effect.succeed(world.bindings ?? []) },
      terminals: { listDiagnostics: Effect.succeed(world.terminals ?? []) },
      now: () => NOW,
    });
  });

const run = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient | ProjectionProjectRepository | Scope.Scope>,
) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(
        ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
      ),
    ),
  );

const terminal = (
  overrides: Partial<DiagnosticsTerminalProcess> & { readonly cwd: string },
): DiagnosticsTerminalProcess => ({
  threadId: "thread-elsewhere",
  terminalId: "default",
  worktreePath: null,
  status: "running",
  pid: 42,
  hasRunningSubprocess: false,
  exitCode: null,
  exitSignal: null,
  updatedAt: FOUR_DAYS_AGO,
  ...overrides,
});

describe("removeIdleChatFolders", () => {
  it("removes the empty folder of a chat idle past the setting, keeping the chat", async () => {
    const idle = chat("chat-idle");
    await mkdir(idle.workspaceRoot);
    const result = await run(
      sweepWith({
        projects: [idle],
        threads: [{ projectId: "chat-idle", updatedAt: FOUR_DAYS_AGO }],
      }),
    );
    expect(result).toEqual({ candidates: 1, removed: 1, kept: 0 });
    expect(await exists(idle.workspaceRoot)).toBe(false);
  });

  it("treats a folder holding only .DS_Store as empty", async () => {
    const idle = chat("chat-finder");
    await mkdir(idle.workspaceRoot);
    await writeFile(path.join(idle.workspaceRoot, ".DS_Store"), "");
    const result = await run(sweepWith({ projects: [idle] }));
    expect(result.removed).toBe(1);
    expect(await exists(idle.workspaceRoot)).toBe(false);
  });

  it("keeps a folder with files in it", async () => {
    const used = chat("chat-used");
    await mkdir(used.workspaceRoot);
    await writeFile(path.join(used.workspaceRoot, "notes.md"), "kept");
    const result = await run(sweepWith({ projects: [used] }));
    expect(result).toEqual({ candidates: 1, removed: 0, kept: 1 });
    expect(await readdir(used.workspaceRoot)).toEqual(["notes.md"]);
  });

  it.each([
    ["the chat changed recently", { updatedAt: YESTERDAY }, []],
    ["a thread changed recently", {}, [{ projectId: "chat-a", updatedAt: YESTERDAY }]],
  ] as const)("keeps the folder when %s", async (_label, overrides, threads) => {
    const recent = chat("chat-a", overrides);
    await mkdir(recent.workspaceRoot);
    const result = await run(sweepWith({ projects: [recent], threads }));
    expect(result.removed).toBe(0);
    expect(await exists(recent.workspaceRoot)).toBe(true);
  });

  it("does nothing when cleanup is off", async () => {
    const idle = chat("chat-off");
    await mkdir(idle.workspaceRoot);
    const result = await run(sweepWith({ projects: [idle], days: null }));
    expect(result).toEqual({ candidates: 0, removed: 0, kept: 0 });
    expect(await exists(idle.workspaceRoot)).toBe(true);
  });

  it("honors a longer setting", async () => {
    const idle = chat("chat-week");
    await mkdir(idle.workspaceRoot);
    const result = await run(sweepWith({ projects: [idle], days: 7 }));
    expect(result.removed).toBe(0);
  });

  it("never removes a regular project's folder or a folder Ryco did not name for the chat", async () => {
    const project = chat("project-a", { kind: "project" });
    const renamed = chat("chat-renamed", {
      workspaceRoot: path.join(chatsRoot, "someone-elses-folder"),
    });
    await mkdir(project.workspaceRoot);
    await mkdir(renamed.workspaceRoot);
    const result = await run(sweepWith({ projects: [project, renamed] }));
    expect(result.removed).toBe(0);
    expect(await exists(project.workspaceRoot)).toBe(true);
    expect(await exists(renamed.workspaceRoot)).toBe(true);
  });

  it("keeps a folder outside the current chats root", async () => {
    const idle = chat("chat-old-root");
    await mkdir(idle.workspaceRoot);
    const result = await run(sweepWith({ projects: [idle], outsideRoot: true }));
    expect(result.removed).toBe(0);
  });

  it("keeps the folder while a turn is pending", async () => {
    const busy = chat("chat-busy");
    await mkdir(busy.workspaceRoot);
    const result = await run(
      sweepWith({
        projects: [busy],
        threads: [{ projectId: "chat-busy", updatedAt: FOUR_DAYS_AGO }],
        pendingTurnFor: "chat-busy",
      }),
    );
    expect(result.removed).toBe(0);
  });

  it("keeps the folder while a provider session of the chat is not stopped", async () => {
    const live = chat("chat-session");
    await mkdir(live.workspaceRoot);
    const result = await run(
      sweepWith({
        projects: [live],
        threads: [{ projectId: "chat-session", updatedAt: FOUR_DAYS_AGO }],
        bindings: [
          {
            threadId: ThreadId.make("thread-chat-session-0"),
            provider: ProviderDriverKind.make("codex"),
            status: "running",
            lastSeenAt: FOUR_DAYS_AGO,
          },
        ],
      }),
    );
    expect(result.removed).toBe(0);
  });

  it("keeps the folder while a terminal runs in it", async () => {
    const shell = chat("chat-terminal");
    await mkdir(shell.workspaceRoot);
    const result = await run(
      sweepWith({ projects: [shell], terminals: [terminal({ cwd: shell.workspaceRoot })] }),
    );
    expect(result.removed).toBe(0);
  });

  it("keeps the folder while something holds its use lease", async () => {
    const leased = chat("chat-leased");
    await mkdir(leased.workspaceRoot);
    const result = await run(
      sweepWith({ projects: [leased] }, (sql) =>
        acquireStoragePathUseLease(sql, leased.workspaceRoot).pipe(
          Effect.tap((release) => Effect.addFinalizer(() => release)),
          Effect.orDie,
        ),
      ),
    );
    expect(result.removed).toBe(0);
    expect(await exists(leased.workspaceRoot)).toBe(true);
  });
});

describe("restoreChatFolder", () => {
  it("recreates an active chat's removed folder, and the chats root with it", async () => {
    const removed = chat("chat-removed");
    await rm(chatsRoot, { recursive: true });
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* seed({ projects: [removed] });
        const listedAsRemoved = yield* isRemovedChatFolder(sql, removed.workspaceRoot);
        const restored = yield* restoreChatFolder(sql, removed.workspaceRoot);
        const again = yield* restoreChatFolder(sql, removed.workspaceRoot);
        return { listedAsRemoved, restored, again };
      }),
    );
    expect(result).toEqual({ listedAsRemoved: true, restored: true, again: false });
    expect(await exists(removed.workspaceRoot)).toBe(true);
  });

  it.each([
    ["a regular project", () => chat("project-a", { kind: "project" })],
    ["a deleted chat", () => chat("chat-deleted", { deletedAt: FOUR_DAYS_AGO })],
    [
      "a folder Ryco did not name for the chat",
      () =>
        chat("chat-renamed", { workspaceRoot: path.join("/nonexistent", "someone-elses-folder") }),
    ],
  ] as const)("leaves the missing folder of %s alone", async (_label, makeRow) => {
    const row = makeRow();
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* seed({ projects: [row] });
        return yield* restoreChatFolder(sql, row.workspaceRoot);
      }),
    );
    expect(result).toBe(false);
    expect(await exists(row.workspaceRoot)).toBe(false);
  });
});
