import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectId, WorktreeId, type NotesCommand } from "@ryco/contracts";
import { WorktreeNotesService, WorktreeNotesServiceLive } from "./WorktreeNotesService.ts";
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
const seed = Effect.gen(function* () {
  yield* putProject(projectId);
  yield* putProject(otherProjectId);
  yield* putWorktree("main", "main");
  yield* putWorktree("feature", "branch");
  yield* putWorktree("foreign", "branch", otherProjectId);
});
const save = (overrides: Partial<NotesCommand> = {}): NotesCommand => ({
  kind: "save",
  projectId,
  scope: "worktree",
  worktreeId: WorktreeId.make("feature"),
  body: "Check the fence",
  expectedRevision: 0,
  ...overrides,
});
const tick = TestClock.adjust(Duration.seconds(1));
const reasonOf = <A>(effect: Effect.Effect<A, { readonly reason: string }>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((failure) => failure.reason),
  );

describe("notes documents service", () => {
  it.effect("creates a document on first save and bumps its revision on each change", () =>
    Effect.gen(function* () {
      yield* seed;
      const notes = yield* WorktreeNotesService;
      assert.deepEqual((yield* notes.list({ projectId })).documents, []);
      const first = yield* notes.command(save({ body: "  Keep whitespace\n" }));
      assert.deepEqual(first.documents, [
        {
          projectId,
          scope: "worktree",
          worktreeId: WorktreeId.make("feature"),
          body: "  Keep whitespace\n",
          revision: 1,
          updatedAt: "1970-01-01T00:00:00.000Z",
        },
      ]);
      yield* tick;
      const second = yield* notes.command(save({ body: "", expectedRevision: 1 }));
      assert.deepInclude(second.documents[0], {
        body: "",
        revision: 2,
        updatedAt: "1970-01-01T00:00:01.000Z",
      });
      assert.equal(
        yield* reasonOf(notes.command({ ...save(), threadId: "thread" } as never)),
        "invalid",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses a stale revision and keeps the revision for a save that changes nothing", () =>
    Effect.gen(function* () {
      yield* seed;
      const notes = yield* WorktreeNotesService;
      yield* notes.command(save({ body: "Same" }));
      assert.equal(yield* reasonOf(notes.command(save({ body: "Stale" }))), "conflict");
      assert.equal(
        yield* reasonOf(notes.command(save({ body: "Ahead", expectedRevision: 5 }))),
        "conflict",
      );
      const unchanged = yield* notes.command(save({ body: "Same", expectedRevision: 1 }));
      assert.deepInclude(unchanged.documents[0], { revision: 1, body: "Same" });
      // A blank document that was never saved stays unlisted.
      const blank = yield* notes.command(save({ scope: "project", worktreeId: null, body: "" }));
      assert.equal(blank.documents.length, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps project, main-checkout and worktree documents apart", () =>
    Effect.gen(function* () {
      yield* seed;
      const notes = yield* WorktreeNotesService;
      yield* notes.command(save({ body: "Feature" }));
      yield* notes.command(save({ scope: "project", worktreeId: null, body: "Project" }));
      // The main worktree row and `null` are the same checkout.
      yield* notes.command(save({ worktreeId: WorktreeId.make("main"), body: "Main" }));
      const snapshot = yield* notes.command(
        save({ worktreeId: null, body: "Main again", expectedRevision: 1 }),
      );
      assert.deepEqual(
        snapshot.documents.map((document) => [
          document.scope,
          document.worktreeId,
          document.body,
          document.revision,
        ]),
        [
          ["project", null, "Project", 1],
          ["worktree", null, "Main again", 2],
          ["worktree", "feature", "Feature", 1],
        ],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects foreign or missing worktrees, projects and a worktree on project notes", () =>
    Effect.gen(function* () {
      yield* seed;
      const notes = yield* WorktreeNotesService;
      for (const worktreeId of ["foreign", "missing"])
        assert.equal(
          yield* reasonOf(notes.command(save({ worktreeId: WorktreeId.make(worktreeId) }))),
          "invalid",
        );
      assert.equal(
        yield* reasonOf(notes.command(save({ projectId: ProjectId.make("nowhere") }))),
        "invalid",
      );
      assert.equal(yield* reasonOf(notes.command(save({ scope: "project" }))), "invalid");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("hides documents of removed worktrees and deleted projects", () =>
    Effect.gen(function* () {
      yield* seed;
      const notes = yield* WorktreeNotesService;
      const sql = yield* SqlClient.SqlClient;
      yield* notes.command(save({ body: "Feature" }));
      yield* notes.command(save({ scope: "project", worktreeId: null, body: "Project" }));
      yield* notes.command(save({ worktreeId: null, body: "Main" }));
      yield* sql`DELETE FROM projection_worktrees WHERE worktree_id = 'feature'`;
      assert.deepEqual(
        (yield* notes.list({ projectId })).documents.map((document) => document.body),
        ["Project", "Main"],
      );
      yield* sql`UPDATE projection_projects SET deleted_at = ${AT} WHERE project_id = ${projectId}`;
      assert.deepEqual((yield* notes.list({ projectId })).documents, []);
      assert.equal(
        yield* reasonOf(notes.command(save({ worktreeId: null, expectedRevision: 1 }))),
        "invalid",
      );
    }).pipe(Effect.provide(layer)),
  );
});
