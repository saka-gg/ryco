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
    const options = {
      projects: 2,
      threads: 6,
      turns: 2,
      archivedShare: 0.5,
      usageReportsPerTurn: 2,
      seed: 7,
    };
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
      ).toBe(first.turns * 2);
    } finally {
      db.close();
    }
  });

  it("adds superseded latest-state history only when asked, with per-emission command ids", async () => {
    const options = {
      projects: 1,
      threads: 2,
      turns: 1,
      archivedShare: 0,
      usageReportsPerTurn: 1,
      seed: 3,
    };
    const plain = await generateFixtureHome({ ...options, out: join(directory, "plain") });
    const zero = await generateFixtureHome({
      ...options,
      out: join(directory, "zero"),
      progressTicksPerTurn: 0,
      reasoningFlushesPerTurn: 0,
      subagentFlushesPerTurn: 0,
    });
    expect({ ...zero, dbPath: "", durationMs: 0 }).toEqual({ ...plain, dbPath: "", durationMs: 0 });

    const rich = await generateFixtureHome({
      ...options,
      out: join(directory, "rich"),
      progressTicksPerTurn: 8,
      reasoningFlushesPerTurn: 3,
      subagentFlushesPerTurn: 2,
    });
    expect(rich.turns).toBe(plain.turns);
    expect(rich.reasoningWrites).toBe(rich.turns * 4);
    expect(rich.subagentWrites).toBe(rich.turns * 3);
    // Eight progress ticks plus a usage tick every fourth.
    expect(rich.progressWrites).toBe(rich.turns * 10);
    expect(rich.commands).toBe(
      plain.commands + rich.progressWrites + rich.reasoningWrites + rich.subagentWrites,
    );

    const db = new DatabaseSync(rich.dbPath, { readOnly: true });
    try {
      const count = (query: string) =>
        (db.prepare(query).get() as { readonly count: number }).count;
      const kindCount = (kind: string) =>
        count(
          `SELECT COUNT(*) AS count FROM orchestration_events WHERE event_type = 'thread.activity-appended' AND json_extract(payload_json, '$.activity.kind') = '${kind}'`,
        );
      expect(kindCount("task.progress")).toBe(rich.progressWrites);
      expect(kindCount("reasoning")).toBe(rich.reasoningWrites);
      expect(kindCount("agent.message")).toBe(rich.subagentWrites);
      // The projection keeps one row per activity id: one reasoning block and one subagent
      // message per turn.
      expect(
        count(
          "SELECT COUNT(*) AS count FROM projection_thread_activities WHERE kind = 'reasoning'",
        ),
      ).toBe(rich.turns);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM projection_thread_activities WHERE kind = 'agent.message'",
        ),
      ).toBe(rich.turns);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM orchestration_command_receipts WHERE command_id GLOB 'provider:????????-????-4???-????-????????????:thread-activity-append:*'",
        ),
      ).toBe(rich.progressWrites + rich.reasoningWrites + rich.subagentWrites);
    } finally {
      db.close();
    }
  });
});
