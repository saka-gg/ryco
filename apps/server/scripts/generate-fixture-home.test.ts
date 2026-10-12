// @effect-diagnostics nodeBuiltinImport:off
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { generateFixtureHome } from "./generate-fixture-home.ts";

const directory = mkdtempSync(join(tmpdir(), "ryco-fixture-home-test-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("generateFixtureHome", () => {
  it("writes a consistent, deterministic home through the real engine", async () => {
    const options = { projects: 2, threads: 6, turns: 2, archivedShare: 0.5, seed: 7 };
    const first = await generateFixtureHome({ ...options, out: join(directory, "a") });
    const second = await generateFixtureHome({ ...options, out: join(directory, "b") });
    expect(first.threads).toBe(6);
    expect({ ...second, dbPath: "", durationMs: 0, dbBytes: 0 }).toEqual({
      ...first,
      dbPath: "",
      durationMs: 0,
      dbBytes: 0,
    });

    const db = new DatabaseSync(first.dbPath, { readOnly: true });
    try {
      const count = (query: string) =>
        (db.prepare(query).get() as { readonly count: number }).count;
      const maxSequence = count("SELECT MAX(sequence) AS count FROM orchestration_events");
      // Every projector applied every event: the server boots without catch-up.
      expect(
        count(
          `SELECT COUNT(*) AS count FROM projection_state WHERE last_applied_sequence <> ${maxSequence}`,
        ),
      ).toBe(0);
      expect(count("SELECT COUNT(*) AS count FROM projection_projects")).toBe(2);
      expect(count("SELECT COUNT(*) AS count FROM projection_threads")).toBe(6);
      expect(
        count("SELECT COUNT(*) AS count FROM projection_threads WHERE archived_at IS NOT NULL"),
      ).toBe(first.archivedThreads);
      expect(count("SELECT COUNT(*) AS count FROM projection_turns")).toBe(first.turns);
      // A user and an assistant message per turn.
      expect(count("SELECT COUNT(*) AS count FROM projection_thread_messages")).toBe(
        first.turns * 2,
      );
      expect(
        count(
          "SELECT COUNT(*) AS count FROM projection_thread_activities WHERE kind = 'context-window.updated'",
        ),
      ).toBe(first.turns);
    } finally {
      db.close();
    }
  });
});
