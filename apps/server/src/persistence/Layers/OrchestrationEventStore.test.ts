import { CommandId, EventId, ProjectId, ThreadId, WorktreeId } from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventStore", (it) => {
  it.effect("stores json columns as strings and replays decoded events", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      const appended = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-store-roundtrip"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-roundtrip"),
        occurredAt: now,
        commandId: CommandId.make("cmd-store-roundtrip"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-store-roundtrip"),
        metadata: {
          adapterKey: "codex",
        },
        payload: {
          projectId: ProjectId.make("project-roundtrip"),
          title: "Roundtrip Project",
          workspaceRoot: "/tmp/project-roundtrip",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const storedRows = yield* sql<{
        readonly payloadJson: string;
        readonly metadataJson: string;
      }>`
        SELECT
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE event_id = ${appended.eventId}
      `;
      assert.equal(storedRows.length, 1);
      assert.equal(typeof storedRows[0]?.payloadJson, "string");
      assert.equal(typeof storedRows[0]?.metadataJson, "string");

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0]?.type, "project.created");
      assert.equal(replayed[0]?.metadata.adapterKey, "codex");
    }),
  );

  it.effect("fails with PersistenceDecodeError when stored json is invalid", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.make("evt-store-invalid-json")},
          ${"project"},
          ${ProjectId.make("project-invalid-json")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.make("cmd-store-invalid-json")},
          ${null},
          ${null},
          ${"server"},
          ${"{"},
          ${"{}"}
        )
      `;

      const replayResult = yield* Effect.result(
        Stream.runCollect(eventStore.readFromSequence(0, 10)),
      );
      assert.equal(replayResult._tag, "Failure");
      if (replayResult._tag === "Failure") {
        assert.ok(Schema.is(PersistenceDecodeError)(replayResult.failure));
        assert.ok(
          replayResult.failure.operation.includes(
            "OrchestrationEventStore.readFromSequence:decodeRows",
          ),
        );
      }
    }),
  );

  it.effect("reads bounded event pages with next sequence and hasMore metadata", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();
      const maxSequenceRows = yield* sql<{ readonly maxSequence: number | null }>`
        SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
      `;
      const startSequence = maxSequenceRows[0]?.maxSequence ?? 0;

      for (const index of [1, 2, 3]) {
        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.make(`evt-store-page-${index}`),
          aggregateKind: "project",
          aggregateId: ProjectId.make(`project-page-${index}`),
          occurredAt: now,
          commandId: CommandId.make(`cmd-store-page-${index}`),
          causationEventId: null,
          correlationId: CommandId.make(`cmd-store-page-${index}`),
          metadata: {},
          payload: {
            projectId: ProjectId.make(`project-page-${index}`),
            title: `Paged Project ${index}`,
            workspaceRoot: `/tmp/project-page-${index}`,
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
      }

      const firstPage = yield* eventStore.readPage(startSequence, 2);
      assert.deepEqual(
        firstPage.events.map((event) => event.sequence),
        [startSequence + 1, startSequence + 2],
      );
      assert.equal(firstPage.nextSequence, startSequence + 2);
      assert.equal(firstPage.hasMore, true);

      const secondPage = yield* eventStore.readPage(firstPage.nextSequence, 2);
      assert.deepEqual(
        secondPage.events.map((event) => event.sequence),
        [startSequence + 3],
      );
      assert.equal(secondPage.nextSequence, startSequence + 3);
      assert.equal(secondPage.hasMore, false);

      assert.equal(yield* eventStore.latestSequence, startSequence + 3);
      const boundedReplay = yield* Stream.runCollect(
        eventStore.readThroughSequence(startSequence, startSequence + 2),
      ).pipe(Effect.map((events) => Array.from(events)));
      assert.deepEqual(
        boundedReplay.map((event) => event.sequence),
        [startSequence + 1, startSequence + 2],
      );
    }),
  );

  it.effect("reads recent events newest first and clamps the requested page", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const since = "2026-08-18T00:00:00.000Z";
      for (const index of [0, 1, 2, 3, 4]) {
        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.make(`evt-store-recent-${index}`),
          aggregateKind: "project",
          aggregateId: ProjectId.make(`project-recent-${index}`),
          // Event 0 is older than `since`, event 4 newer than every later probe.
          occurredAt: index === 0 ? "2026-08-17T23:59:59.000Z" : `2026-08-18T00:00:0${index}.000Z`,
          commandId: CommandId.make(
            index === 2 ? `provider:recent-${index}` : `cmd-store-recent-${index}`,
          ),
          causationEventId: null,
          correlationId: CommandId.make(`cmd-store-recent-${index}`),
          metadata: index === 3 ? { providerTurnId: "turn-recent" } : {},
          payload: {
            projectId: ProjectId.make(`project-recent-${index}`),
            title: `Recent Project ${index}`,
            workspaceRoot: `/secret/recent-project-${index}`,
            defaultModelSelection: null,
            scripts: [],
            createdAt: `2026-08-18T00:00:0${index}.000Z`,
            updatedAt: `2026-08-18T00:00:0${index}.000Z`,
          },
        });
      }

      const recent = yield* eventStore.readRecent!({ since, limit: 3 });
      assert.deepEqual(
        recent.map((event) => [event.eventId, event.providerAttributed]),
        [
          [EventId.make("evt-store-recent-4"), false],
          [EventId.make("evt-store-recent-3"), true],
          [EventId.make("evt-store-recent-2"), true],
        ],
      );
      assert.notProperty(recent[0], "payload");
      assert.deepEqual(
        (yield* eventStore.readRecent!({ since, limit: 50 }))
          .map((event) => event.eventId)
          .filter((eventId) => eventId.startsWith("evt-store-recent-")),
        [4, 3, 2, 1].map((index) => EventId.make(`evt-store-recent-${index}`)),
        "nothing older than since",
      );
      assert.isFalse(
        (yield* eventStore.readRecent!({ since: "2026-08-18T00:00:05.000Z", limit: 50 })).some(
          (event) => event.eventId.startsWith("evt-store-recent-"),
        ),
      );
    }),
  );
  it.effect("probes resumption from the sequence key and stream index alone", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendProject = (key: string) =>
        eventStore.append({
          type: "project.created",
          eventId: EventId.make(`evt-probe-${key}`),
          aggregateKind: "project",
          aggregateId: ProjectId.make(`project-probe-${key}`),
          occurredAt: "2026-10-01T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            projectId: ProjectId.make(`project-probe-${key}`),
            title: `Probe ${key}`,
            workspaceRoot: `/tmp/probe-${key}`,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T00:00:00.000Z",
          },
        });
      const anchor = yield* appendProject("anchor");
      for (const key of ["a", "b", "c", "d"]) yield* appendProject(key);
      const watched = yield* appendProject("watched");
      // A payload the probe would fail to parse proves it never reads one.
      yield* sql`UPDATE orchestration_events SET payload_json = 'not json' WHERE sequence > ${anchor.sequence}`;

      const probe = eventStore.probeResume!;
      assert.deepEqual(yield* probe({ sequence: anchor.sequence, limit: 10 }), {
        anchored: true,
        eventsAfter: 5,
        streamEventsAfter: null,
      });
      // Counting stops one row past the limit.
      assert.equal((yield* probe({ sequence: anchor.sequence, limit: 2 })).eventsAfter, 3);
      assert.deepEqual(
        yield* probe({
          sequence: anchor.sequence,
          limit: 10,
          stream: { aggregateKind: "project", streamId: watched.aggregateId, limit: 10 },
        }),
        { anchored: true, eventsAfter: 5, streamEventsAfter: 1 },
      );
      assert.equal((yield* probe({ sequence: watched.sequence + 100, limit: 10 })).anchored, false);
    }),
  );

  it.effect("anchors a resume inside a compacted hole of the log", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appended: Array<number> = [];
      for (const key of ["1", "2", "3", "4", "5"]) {
        const event = yield* eventStore.append({
          type: "project.created",
          eventId: EventId.make(`evt-hole-${key}`),
          aggregateKind: "project",
          aggregateId: ProjectId.make(`project-hole-${key}`),
          occurredAt: "2026-10-01T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            projectId: ProjectId.make(`project-hole-${key}`),
            title: `Hole ${key}`,
            workspaceRoot: `/tmp/hole-${key}`,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T00:00:00.000Z",
          },
        });
        appended.push(event.sequence);
      }
      const middle = appended[2]!;
      // Compaction removes superseded events: the client's cursor may name one of them.
      yield* sql`DELETE FROM orchestration_events WHERE sequence = ${middle}`;

      const probe = eventStore.probeResume!;
      assert.deepEqual(yield* probe({ sequence: middle, limit: 10 }), {
        anchored: true,
        eventsAfter: 2,
        streamEventsAfter: null,
      });
      // Outside the log's range stays unanchored.
      assert.equal((yield* probe({ sequence: appended[4]! + 1, limit: 10 })).anchored, false);
      assert.equal((yield* probe({ sequence: 0, limit: 10 })).anchored, false);
      // The range is two seeks at the ends of the sequence key, never a scan.
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN SELECT
          (3 >= (SELECT MIN(sequence) FROM orchestration_events)
            AND 3 <= (SELECT MAX(sequence) FROM orchestration_events)) AS anchored
      `;
      assert.isFalse(
        plan.some((row) => row.detail.startsWith("SCAN orchestration_events")),
        JSON.stringify(plan),
      );
    }),
  );

  it.effect("pages events without payloads, with only the ids and paths readers need", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const before = yield* eventStore.latestSequence;
      const base = {
        occurredAt: "2026-10-02T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
      } as const;
      const project = ProjectId.make("project-headers");
      const thread = ThreadId.make("thread-headers");
      const worktree = WorktreeId.make("worktree-headers");
      yield* eventStore.append({
        ...base,
        type: "project.deleted",
        eventId: EventId.make("evt-headers-project"),
        aggregateKind: "project",
        aggregateId: project,
        payload: { projectId: project, deletedAt: base.occurredAt },
      });
      yield* eventStore.append({
        ...base,
        type: "thread.deleted",
        eventId: EventId.make("evt-headers-thread"),
        aggregateKind: "thread",
        aggregateId: thread,
        payload: { threadId: thread, deletedAt: base.occurredAt },
      });
      yield* eventStore.append({
        ...base,
        type: "worktree.relocated",
        eventId: EventId.make("evt-headers-worktree"),
        aggregateKind: "worktree",
        aggregateId: worktree,
        payload: {
          worktreeId: worktree,
          projectId: project,
          sourcePath: "/tmp/from",
          destinationPath: "/tmp/to",
          relocatedAt: base.occurredAt,
        },
      } as never);

      const page = yield* eventStore.readEventHeadersPage!(before, 2);
      assert.equal(page.hasMore, true);
      assert.equal(page.nextSequence, before + 2);
      const rest = yield* eventStore.readEventHeadersPage!(page.nextSequence, 10);
      assert.equal(rest.hasMore, false);
      assert.deepEqual(
        [...page.events, ...rest.events].map(({ sequence: _sequence, ...header }) => header),
        [
          {
            type: "project.deleted",
            aggregateKind: "project",
            aggregateId: project,
            payload: { projectId: project },
          },
          {
            type: "thread.deleted",
            aggregateKind: "thread",
            aggregateId: thread,
            payload: { threadId: thread },
          },
          {
            type: "worktree.relocated",
            aggregateKind: "worktree",
            aggregateId: worktree,
            payload: {
              projectId: project,
              worktreeId: worktree,
              sourcePath: "/tmp/from",
              destinationPath: "/tmp/to",
            },
          },
        ],
      );
    }),
  );

  it.effect("pages one aggregate stream through the stream index", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendProject = (projectKey: string, key: string) =>
        eventStore.append({
          type: "project.created",
          eventId: EventId.make(`evt-stream-page-${projectKey}-${key}`),
          aggregateKind: "project",
          aggregateId: ProjectId.make(`project-stream-${projectKey}`),
          occurredAt: "2026-10-02T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            projectId: ProjectId.make(`project-stream-${projectKey}`),
            title: `Stream ${projectKey} ${key}`,
            workspaceRoot: `/tmp/stream-${projectKey}`,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-10-02T00:00:00.000Z",
            updatedAt: "2026-10-02T00:00:00.000Z",
          },
        });
      const watched: Array<number> = [];
      const before = yield* eventStore.latestSequence;
      for (const key of ["1", "2", "3"]) {
        watched.push((yield* appendProject("watched", key)).sequence);
        // Interleaved events of other streams are never read, decoded or counted.
        yield* appendProject(`other-${key}`, key);
      }
      const streamId = ProjectId.make("project-stream-watched");

      const first = yield* eventStore.readStreamEventsPage({
        aggregateKind: "project",
        streamId,
        fromSequenceExclusive: before,
        limit: 2,
      });
      assert.deepEqual(
        first.events.map((event) => event.sequence),
        watched.slice(0, 2),
      );
      assert.equal(first.nextSequence, watched[1]);
      assert.equal(first.hasMore, true);

      const second = yield* eventStore.readStreamEventsPage({
        aggregateKind: "project",
        streamId,
        fromSequenceExclusive: first.nextSequence,
        limit: 2,
      });
      assert.deepEqual(
        second.events.map((event) => event.sequence),
        watched.slice(2),
      );
      assert.equal(second.hasMore, false);

      const empty = yield* eventStore.readStreamEventsPage({
        aggregateKind: "thread",
        streamId,
        fromSequenceExclusive: before,
        limit: 2,
      });
      assert.deepEqual(empty, { events: [], nextSequence: before, hasMore: false });

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN SELECT payload_json FROM orchestration_events
        WHERE aggregate_kind = 'project' AND stream_id = 'p' AND sequence > 0
        ORDER BY sequence ASC LIMIT 3
      `;
      assert.isTrue(
        plan.some((row) =>
          row.detail.includes(
            "USING INDEX idx_orch_events_stream_sequence (aggregate_kind=? AND stream_id=? AND sequence>?)",
          ),
        ),
        JSON.stringify(plan),
      );
      assert.isFalse(
        plan.some((row) => row.detail.includes("TEMP B-TREE")),
        JSON.stringify(plan),
      );
    }),
  );
});
