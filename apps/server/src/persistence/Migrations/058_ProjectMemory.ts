import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS project_memory_settings (
    project_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0), dispatch_id TEXT, dispatch_thread_id TEXT, dispatch_owner_pid INTEGER, dispatch_owner TEXT, dispatch_runtime_json TEXT
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS project_memories (
    id TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('fact','convention','decision','preference')),
    text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 500 AND length(CAST(text AS BLOB)) <= 2048),
    revision INTEGER NOT NULL CHECK(revision > 0), pinned INTEGER NOT NULL CHECK(pinned IN (0,1)),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, affirmed_at TEXT NOT NULL, provenance_json TEXT NOT NULL,
    PRIMARY KEY(project_id,id)
  )`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS project_memory_cap BEFORE INSERT ON project_memories
    WHEN (SELECT count(*) FROM project_memories WHERE project_id = NEW.project_id) >= 200
    BEGIN SELECT RAISE(ABORT, 'project memory capacity reached'); END`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS project_memory_delete_guard BEFORE DELETE ON projection_projects
    WHEN EXISTS(SELECT 1 FROM project_memory_settings WHERE project_id = OLD.project_id AND dispatch_id IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'project memory submission is pending'); END`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS project_memory_soft_delete_guard BEFORE UPDATE OF deleted_at ON projection_projects
    WHEN NEW.deleted_at IS NOT NULL AND EXISTS(SELECT 1 FROM project_memory_settings WHERE project_id = NEW.project_id AND dispatch_id IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'project memory submission is pending'); END`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS project_memory_project_deleted AFTER UPDATE OF deleted_at ON projection_projects
    WHEN NEW.deleted_at IS NOT NULL
    BEGIN
      DELETE FROM project_memories WHERE project_id = NEW.project_id;
      UPDATE project_memory_settings SET enabled = 0, revision = revision + 1 WHERE project_id = NEW.project_id;
    END`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS project_memory_project_removed AFTER DELETE ON projection_projects
    BEGIN
      DELETE FROM project_memories WHERE project_id = OLD.project_id;
      UPDATE project_memory_settings SET enabled = 0, revision = revision + 1 WHERE project_id = OLD.project_id;
    END`;
});
