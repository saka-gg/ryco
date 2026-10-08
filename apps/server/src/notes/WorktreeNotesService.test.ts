import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectId, ThreadId, WorktreeId, type NotesCommand } from "@ryco/contracts";
import {
  WORKTREE_NOTES_LIST_LIMIT,
  WorktreeNotesService,
  WorktreeNotesServiceLive,
} from "./WorktreeNotesService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

const layer = WorktreeNotesServiceLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const projectId = ProjectId.make("project");
const otherProjectId = ProjectId.make("other-project");
const AT = "2026-10-01T00:00:00.000Z";

const putProject = (id: string, deletedAt: string | null = null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
      VALUES (${id}, 'Project', ${`/tmp/${id}`}, '[]', ${AT}, ${AT}, ${deletedAt})`;
  });
const putWorktree = (id: string, origin: string, project: string = projectId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_worktrees (worktree_id, project_id, branch, worktree_path, origin, created_at, updated_at)
      VALUES (${id}, ${project}, ${id}, ${`/tmp/${id}`}, ${origin}, ${AT}, ${AT})`;
  });
const putThread = (id: string, project: string = projectId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${id}, ${project}, 'Thread', '{"instanceId":"codex","model":"gpt-5"}', 'approval-required', 'default', ${AT}, ${AT})`;
  });
const seed = Effect.gen(function* () {
  yield* putProject(projectId);
  yield* putProject(otherProjectId);
  yield* putWorktree("main", "main");
  yield* putWorktree("feature", "branch");
  yield* putWorktree("foreign", "branch", otherProjectId);
  yield* putThread("thread");
  yield* putThread("foreign-thread", otherProjectId);
});
type CreateCommand = Extract<NotesCommand, { kind: "create" }>;
const create = (noteId: string, overrides: Partial<CreateCommand> = {}): CreateCommand => ({
  kind: "create",
  noteId,
  projectId,
  worktreeId: WorktreeId.make("feature"),
  scope: "worktree",
  body: `Note ${noteId}`,
  threadId: ThreadId.make("thread"),
  ...overrides,
});
const tick = TestClock.adjust(Duration.seconds(1));
const reasonOf = <A>(effect: Effect.Effect<A, { readonly reason: string }>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((failure) => failure.reason),
  );

describe("worktree notes service", () => {
  it.effect("creates idempotently by note id and refuses a different payload for the same id", () =>
    Effect.gen(function* () {
      yield* seed;
      const notes = yield* WorktreeNotesService;
      const first = yield* notes.command(create("note", { body: "  Check the fence  " }));
      assert.equal(first.notes.length, 1);
      assert.deepInclude(first.notes[0], {
        noteId: "note",
        revision: 0,
        worktreeId: WorktreeId.make("feature"),
        scope: "worktree",
        body: "Check the fence",
        threadId: ThreadId.make("thread"),
      });
      yield* tick;
      const retried = yield* notes.command(create("note", { body: "  Check the fence  " }));
      assert.deepEqual(retried, first);
      assert.equal(
        yield* reasonOf(notes.command(create("note", { body: "Different" }))),
        "conflict",
      );
      assert.equal(yield* reasonOf(notes.command(create("blank", { body: "   \n " }))), "invalid");
      assert.equal(
        yield* reasonOf(notes.command({ ...create("extra"), revision: 3 } as never)),
        "invalid",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses an empty update and keeps the revision for one that changes nothing", () =>
    Effect.gen(function* () {
      yield* seed;
      const notes = yield* WorktreeNotesService;
      yield* notes.command(create("note", { body: "Same" }));
      const base = { kind: "update", noteId: "note", projectId, expectedRevision: 0 } as const;
      assert.equal(yield* reasonOf(notes.command(base)), "invalid");
      const unchanged = yield* notes.command({ ...base, body: "  Same ", scope: "worktree" });
      assert.deepInclude(unchanged.notes[0], { revision: 0, body: "Same" });
      // Another editor still holding revision 0 is not refused.
      const edited = yield* notes.command({ ...base, body: "Changed" });
      assert.deepInclude(edited.notes[0], { revision: 1, body: "Changed" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("checks revisions on update and delete, and a tombstone blocks re-creation", () =>
    Effect.gen(function* () {
      yield* seed;
      const notes = yield* WorktreeNotesService;
      yield* notes.command(create("note"));
      yield* tick;
      const updated = yield* notes.command({
        kind: "update",
        noteId: "note",
        projectId,
        expectedRevision: 0,
        body: "[x] Done",
        scope: "project",
      });
      assert.deepInclude(updated.notes[0], {
        revision: 1,
        body: "[x] Done",
        scope: "project",
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:01.000Z",
      });
      const stale = { kind: "update", noteId: "note", projectId, expectedRevision: 0 } as const;
      assert.equal(yield* reasonOf(notes.command({ ...stale, body: "Stale" })), "conflict");
      assert.equal(
        yield* reasonOf(notes.command({ ...stale, expectedRevision: 1, body: " " })),
        "invalid",
      );
      assert.equal(
        yield* reasonOf(
          notes.command({
            ...stale,
            projectId: otherProjectId,
            expectedRevision: 1,
            body: "Elsewhere",
          }),
        ),
        "not-found",
      );
      assert.equal(
        yield* reasonOf(
          notes.command({ kind: "delete", noteId: "note", projectId, expectedRevision: 0 }),
        ),
        "conflict",
      );
      const deleted = yield* notes.command({
        kind: "delete",
        noteId: "note",
        projectId,
        expectedRevision: 1,
      });
      assert.deepEqual(deleted.notes, []);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ revision: number; body: string; deleted: number }>`
        SELECT revision, body, deleted_at IS NOT NULL AS deleted FROM worktree_notes WHERE note_id = 'note'`;
      assert.deepEqual(rows, [{ revision: 2, body: "", deleted: 1 }]);
      assert.equal(yield* reasonOf(notes.command(create("note"))), "conflict");
      assert.equal(
        yield* reasonOf(notes.command({ ...stale, expectedRevision: 2, body: "Back" })),
        "not-found",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "normalises the main checkout, rejects foreign or missing worktrees, drops foreign threads",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const notes = yield* WorktreeNotesService;
        const main = yield* notes.command(
          create("main-note", { worktreeId: WorktreeId.make("main") }),
        );
        assert.equal(main.notes[0]?.worktreeId, null);
        for (const worktreeId of ["foreign", "missing"])
          assert.equal(
            yield* reasonOf(
              notes.command(create(`n-${worktreeId}`, { worktreeId: WorktreeId.make(worktreeId) })),
            ),
            "invalid",
          );
        assert.equal(
          yield* reasonOf(
            notes.command(create("orphan", { projectId: ProjectId.make("nowhere") })),
          ),
          "invalid",
        );
        yield* tick;
        const backlinks = yield* notes.command(
          create("foreign-thread", { threadId: ThreadId.make("foreign-thread") }),
        );
        assert.equal(backlinks.notes[0]?.noteId, "foreign-thread");
        assert.equal(backlinks.notes[0]?.threadId, null);
        yield* tick;
        const missing = yield* notes.command(
          create("missing-thread", { threadId: ThreadId.make("missing-thread"), worktreeId: null }),
        );
        assert.deepInclude(missing.notes[0], { threadId: null, worktreeId: null });
      }).pipe(Effect.provide(layer)),
  );

  it.effect("hides notes of removed worktrees and deleted projects but keeps pinned ones", () =>
    Effect.gen(function* () {
      yield* seed;
      const notes = yield* WorktreeNotesService;
      const sql = yield* SqlClient.SqlClient;
      yield* notes.command(create("worktree-note"));
      yield* tick;
      yield* notes.command(create("pinned-note", { scope: "project" }));
      yield* tick;
      yield* notes.command(create("main-note", { worktreeId: null }));
      yield* sql`DELETE FROM projection_worktrees WHERE worktree_id = 'feature'`;
      const visible = yield* notes.list({ projectId });
      assert.deepEqual(
        visible.notes.map((note) => note.noteId),
        ["main-note", "pinned-note"],
      );
      assert.equal(
        yield* reasonOf(
          notes.command({
            kind: "update",
            noteId: "pinned-note",
            projectId,
            expectedRevision: 0,
            scope: "worktree",
          }),
        ),
        "invalid",
      );
      yield* sql`UPDATE projection_projects SET deleted_at = ${AT} WHERE project_id = ${projectId}`;
      assert.deepEqual((yield* notes.list({ projectId })).notes, []);
      assert.equal(
        yield* reasonOf(
          notes.command({ kind: "delete", noteId: "main-note", projectId, expectedRevision: 0 }),
        ),
        "not-found",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("returns the newest notes first and marks a truncated view", () =>
    Effect.gen(function* () {
      yield* seed;
      const notes = yield* WorktreeNotesService;
      const sql = yield* SqlClient.SqlClient;
      yield* notes.command(create("older"));
      yield* tick;
      const ordered = yield* notes.command(create("newer"));
      assert.deepEqual(
        ordered.notes.map((note) => note.noteId),
        ["newer", "older"],
      );
      assert.equal(ordered.truncated, false);
      assert.equal(ordered.limit, WORKTREE_NOTES_LIST_LIMIT);
      for (let index = 0; index < WORKTREE_NOTES_LIST_LIMIT; index += 1) {
        const createdAt = new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString();
        yield* sql`INSERT INTO worktree_notes (note_id, project_id, worktree_id, scope, body, thread_id,
          revision, create_digest, created_at, updated_at, deleted_at)
          VALUES (${`bulk-${index}`}, ${projectId}, NULL, 'worktree', 'Bulk', NULL, 0, 'digest', ${createdAt}, ${createdAt}, NULL)`;
      }
      const truncated = yield* notes.list({ projectId });
      assert.equal(truncated.truncated, true);
      assert.equal(truncated.notes.length, WORKTREE_NOTES_LIST_LIMIT);
      // The 2020 fixtures are newer than the test clock's 1970 notes, so they fill the view.
      assert.equal(truncated.notes[0]?.noteId, `bulk-${WORKTREE_NOTES_LIST_LIMIT - 1}`);
      assert.notInclude(
        truncated.notes.map((note) => note.noteId),
        "older",
      );
    }).pipe(Effect.provide(layer)),
  );
});
