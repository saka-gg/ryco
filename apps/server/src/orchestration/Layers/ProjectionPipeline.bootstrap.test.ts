import {
  CommandId,
  CorrelationId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@ryco/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlStatement from "effect/sql/Statement";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import {
  BOOTSTRAP_REPLAY_BATCH_SIZE,
  ORCHESTRATION_EVENT_PROJECTORS,
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
  projectorEventTypes,
} from "./ProjectionPipeline.ts";

const layer = it.layer(
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "ryco-projection-bootstrap-test-" }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      Layer.succeed(ProjectAvatarStore, {
        write: () => Effect.die("unused"),
        read: () => Effect.succeed(null),
        remove: () => Effect.void,
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

it("selects exactly the event types routed to the given projectors", () => {
  const types = projectorEventTypes([ORCHESTRATION_PROJECTOR_NAMES.projects]);
  assert.deepEqual(
    [...types].toSorted(),
    Object.entries(ORCHESTRATION_EVENT_PROJECTORS)
      .filter(([, routed]) =>
        (routed as ReadonlyArray<string>).includes(ORCHESTRATION_PROJECTOR_NAMES.projects),
      )
      .map(([type]) => type)
      .toSorted(),
  );
  assert.include(types, "project.created");
  assert.notInclude(types, "thread.created");
});

layer("projector bootstrap replay", (it) => {
  it.effect(
    "replays only a lagging projector's events, in batched transactions, and passes the rest",
    () =>
      Effect.gen(function* () {
        const pipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-10-12T00:00:00.000Z";
        const projectCount = BOOTSTRAP_REPLAY_BATCH_SIZE * 2 + 1;

        for (let index = 0; index < projectCount; index += 1) {
          const projectId = ProjectId.make(`replay-project-${index}`);
          const commandId = CommandId.make(`replay-project-cmd-${index}`);
          yield* eventStore.append({
            type: "project.created",
            eventId: EventId.make(`replay-project-evt-${index}`),
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: now,
            commandId,
            causationEventId: null,
            correlationId: CorrelationId.make(commandId),
            metadata: {},
            payload: {
              projectId,
              title: `Replay ${index}`,
              workspaceRoot: `/tmp/replay-${index}`,
              defaultModelSelection: null,
              scripts: [],
              createdAt: now,
              updatedAt: now,
            },
          });
        }
        // The log ends with events the lagging projector does not consume.
        let last = 0;
        for (let index = 0; index < 3; index += 1) {
          const threadId = ThreadId.make(`replay-thread-${index}`);
          const commandId = CommandId.make(`replay-thread-cmd-${index}`);
          const appended = yield* eventStore.append({
            type: "thread.created",
            eventId: EventId.make(`replay-thread-evt-${index}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: "2026-10-12T00:00:09.000Z",
            commandId,
            causationEventId: null,
            correlationId: CorrelationId.make(commandId),
            metadata: {},
            payload: {
              threadId,
              projectId: ProjectId.make("replay-project-0"),
              title: "Thread",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
              runtimeMode: "full-access",
              branch: null,
              worktreePath: null,
              createdAt: now,
              updatedAt: now,
            },
          });
          last = appended.sequence;
        }
        // Every projector is current except `projects`, which an upgrade just added.
        for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
          const sequence = projector === ORCHESTRATION_PROJECTOR_NAMES.projects ? 0 : last;
          yield* sql`
            INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
            VALUES (${projector}, ${sequence}, ${now})
            ON CONFLICT (projector) DO UPDATE SET
              last_applied_sequence = excluded.last_applied_sequence,
              updated_at = excluded.updated_at
          `;
        }

        const statements: string[] = [];
        const capture: SqlStatement.Transformer = (statement) =>
          Effect.sync(() => {
            statements.push(statement.compile()[0]);
            return statement;
          });
        yield* pipeline.bootstrap.pipe(
          Effect.provideService(SqlStatement.CurrentTransformer, capture),
        );

        const [{ count } = { count: 0 }] = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM projection_projects WHERE project_id LIKE 'replay-project-%'
        `;
        assert.equal(count, projectCount);
        const cursors = yield* sql<{ readonly projector: string; readonly sequence: number }>`
          SELECT projector, last_applied_sequence AS sequence FROM projection_state
        `;
        for (const cursor of cursors) assert.equal(cursor.sequence, last, cursor.projector);
        const [projectsCursor] = yield* sql<{ readonly updatedAt: string }>`
          SELECT updated_at AS "updatedAt" FROM projection_state
          WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.projects}
        `;
        // Stamped with the head event's time, like a per-event replay.
        assert.equal(projectsCursor?.updatedAt, "2026-10-12T00:00:09.000Z");

        // Only the lagging projector's event types are read from the log.
        const reads = statements.filter((statement) =>
          statement.includes("FROM orchestration_events"),
        );
        assert.isTrue(reads.length > 0);
        for (const read of reads.filter((statement) => statement.includes("sequence <="))) {
          assert.match(read, /event_type IN/);
        }
        // One cursor write per batch plus one for the unread tail, not one per event.
        const cursorWrites = statements.filter((statement) =>
          statement.includes("INSERT INTO projection_state"),
        );
        assert.equal(
          cursorWrites.length,
          Math.ceil(projectCount / BOOTSTRAP_REPLAY_BATCH_SIZE) + 1,
        );

        // Nothing lags any more: a second boot reads nothing.
        statements.length = 0;
        yield* pipeline.bootstrap.pipe(
          Effect.provideService(SqlStatement.CurrentTransformer, capture),
        );
        assert.isFalse(statements.some((statement) => statement.includes("sequence <=")));
      }),
  );
});
