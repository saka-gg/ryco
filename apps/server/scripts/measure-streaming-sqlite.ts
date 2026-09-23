/** Fresh-file production event-store/projection fixture; run with Node (server runtime).
 * node apps/server/scripts/measure-streaming-sqlite.ts [bytes=200000] [messages=1]
 * Reports WAL growth, not physical disk writes or whole-application savings.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@ryco/contracts";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../src/config.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../src/orchestration/Services/ProjectionPipeline.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../src/persistence/Services/OrchestrationEventStore.ts";
import { ProjectionThreadMessageRepositoryLive } from "../src/persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepository } from "../src/persistence/Services/ProjectionThreadMessages.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { ProjectAvatarStore } from "../src/project/Services/ProjectAvatarStore.ts";

const bytes = Number(process.argv[2] ?? 200000);
const messages = Number(process.argv[3] ?? 1);
if (
  !Number.isSafeInteger(bytes) ||
  bytes < 40 ||
  bytes % 40 ||
  !Number.isSafeInteger(messages) ||
  messages < 1
)
  throw new Error("Use positive multiples of 40 bytes and positive message count");
const directory = mkdtempSync(join(tmpdir(), "ryco-streaming-measure-"));
const filename = join(directory, "fixture.sqlite");
const persistence = makeSqlitePersistenceLive(filename);
const layer = Layer.mergeAll(
  OrchestrationProjectionPipelineLive,
  ProjectionThreadMessageRepositoryLive,
).pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(persistence),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "ryco-streaming-measure-config-" }),
  ),
  Layer.provide(
    Layer.succeed(ProjectAvatarStore, {
      write: () => Effect.die("unused"),
      read: () => Effect.succeed(null),
      remove: () => Effect.void,
    }),
  ),
  Layer.provide(NodeServices.layer),
);
const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* OrchestrationEventStore;
  const pipeline = yield* OrchestrationProjectionPipeline;
  const repository = yield* ProjectionThreadMessageRepository;
  const now = "2026-09-01T00:00:00.000Z";
  const threadId = ThreadId.make("fixture-thread");
  const projectId = ProjectId.make("fixture-project");
  let id = 0;
  const apply = (event: Pick<OrchestrationEvent, "type" | "payload">) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const key = String(++id);
          const persisted = yield* store.append({
            ...event,
            eventId: EventId.make(key),
            aggregateKind: event.type === "project.created" ? "project" : "thread",
            aggregateId: event.type === "project.created" ? projectId : threadId,
            occurredAt: now,
            commandId: CommandId.make(key),
            causationEventId: null,
            correlationId: CommandId.make(key),
            metadata: {},
          } as Parameters<typeof store.append>[0]);
          return yield* pipeline.projectEventInTransaction(persisted);
        }),
      )
      .pipe(Effect.flatMap((postCommit) => postCommit));
  yield* apply({
    type: "project.created",
    payload: {
      projectId,
      title: "Fixture",
      workspaceRoot: directory,
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  yield* apply({
    type: "thread.created",
    payload: {
      threadId,
      projectId,
      title: "Fixture",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  yield* sql`PRAGMA wal_autocheckpoint = 0`;
  yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
  const settings = {
    sqlite: yield* sql`SELECT sqlite_version() AS version`,
    synchronous: yield* sql`PRAGMA synchronous`,
    pageSize: yield* sql`PRAGMA page_size`,
  };
  const delta = "0123456789abcdefghij0123456789abcdefghij";
  const send = (index: number, text: string, streaming: boolean) =>
    apply({
      type: "thread.message-sent",
      payload: {
        threadId,
        messageId: MessageId.make(`message-${index}`),
        role: "assistant",
        text,
        turnId: null,
        streaming,
        createdAt: now,
        updatedAt: now,
      },
    });
  const start = performance.now();
  for (let n = 0; n < bytes / 40; n++)
    for (let m = 0; m < messages; m++) yield* send(m, delta, true);
  const streamingMs = performance.now() - start;
  const completionStart = performance.now();
  for (let m = 0; m < messages; m++) yield* send(m, "", false);
  const completionMs = performance.now() - completionStart;
  const walBytes = statSync(`${filename}-wal`).size;
  const expected = delta.repeat(bytes / 40);
  const hashes: string[] = [];
  for (let m = 0; m < messages; m++) {
    const row = Option.getOrThrow(
      yield* repository.getByMessageId({ messageId: MessageId.make(`message-${m}`) }),
    );
    if (row.text !== expected || row.isStreaming) throw new Error("Final content mismatch");
    hashes.push(createHash("sha256").update(row.text).digest("hex"));
  }
  console.log(
    JSON.stringify({
      runtime: process.version,
      bun: process.versions.bun ?? null,
      bytesPerMessage: bytes,
      messages,
      deltaBytes: 40,
      settings,
      streamingMs,
      completionMs,
      walBytes,
      finalContentMatches: true,
      sha256: hashes,
    }),
  );
});
try {
  await Effect.runPromise(program.pipe(Effect.provide(layer)));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
