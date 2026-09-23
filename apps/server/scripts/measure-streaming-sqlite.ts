/** Fresh-file production event-store/projection fixture; run with Node (server runtime).
 * node apps/server/scripts/measure-streaming-sqlite.ts [bytes=200000] [messages=1] [profile=buffered]
 * Profiles model persisted batch sizes; provider/network/timer waiting is excluded.
 * Reports WAL growth, not physical disk writes or whole-application savings.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointRef,
  TurnId,
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
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { RepositoryIdentityResolver } from "../src/project/Services/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../src/orchestration/ThreadBackgroundLiveness.ts";
import {
  ThreadPriorityCandidateQuery,
  ThreadPriorityCandidateQueryLive,
} from "../src/threadPriority/ThreadPriorityCandidateQuery.ts";

const bytes = Number(process.argv[2] ?? 200000);
const profile = process.argv[4] ?? "buffered";
const batchChars =
  profile === "buffered" ? 24040 : profile === "streaming" ? 4096 : profile === "timer" ? 320 : 40;
if (!["buffered", "streaming", "timer", "stress", "reads"].includes(profile))
  throw new Error("Unknown profile");
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
  OrchestrationProjectionSnapshotQueryLive,
  ThreadPriorityCandidateQueryLive,
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) })),
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
  const expected = delta.repeat(bytes / 40);
  const send = (index: number, text: string, streaming: boolean) =>
    apply({
      type: "thread.message-sent",
      payload: {
        threadId,
        messageId: MessageId.make(`message-${index}`),
        role: "assistant",
        text,
        turnId: profile === "reads" ? TurnId.make("fixture-turn") : null,
        streaming,
        createdAt: now,
        updatedAt: now,
      },
    });
  if (profile === "reads") {
    const query = yield* ProjectionSnapshotQuery;
    const priority = yield* ThreadPriorityCandidateQuery;
    const turnId = TurnId.make("fixture-turn");
    const count = 2000;
    const body = 'ordinary completed report: "quoted" line with a backslash \\ and newline\n'
      .repeat(80)
      .slice(0, 4200);
    yield* send(0, "seed", false);
    yield* apply({
      type: "thread.turn-diff-completed",
      payload: {
        threadId,
        turnId,
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("refs/fixture/1"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.make("message-0"),
        completedAt: now,
      },
    });
    yield* repository.deleteByThreadId({ threadId });
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (let i = 0; i < count; i++)
          yield* repository.upsert({
            messageId: MessageId.make(`read-${String(i).padStart(4, "0")}`),
            threadId,
            turnId,
            role: i === 0 ? "user" : "assistant",
            text: body,
            isStreaming: false,
            createdAt: now,
            updatedAt: now,
          });
      }),
    );
    yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
    const results: Record<string, number[]> = {};
    const measure = <E, R>(
      name: string,
      operation: Effect.Effect<readonly string[], E, R>,
      expectedCount: number,
      expectedText = body,
    ) =>
      Effect.gen(function* () {
        const times: number[] = [];
        for (let run = 0; run < 23; run++) {
          const started = performance.now();
          const texts = yield* operation;
          const elapsed = performance.now() - started;
          if (texts.length !== expectedCount || texts.some((text) => text !== expectedText))
            throw new Error(`Read mismatch: ${name}`);
          if (run >= 3) times.push(elapsed);
        }
        results[name] = times;
      });
    yield* measure(
      "repositoryList",
      repository
        .listByThreadId({ threadId })
        .pipe(Effect.map((rows) => rows.map((row) => row.text))),
      count,
    );
    yield* measure(
      "repositoryGet",
      repository
        .getByMessageId({ messageId: MessageId.make("read-1000") })
        .pipe(Effect.map((row) => [Option.getOrThrow(row).text])),
      1,
    );
    yield* measure(
      "snapshot",
      query
        .getSnapshot()
        .pipe(
          Effect.map((snapshot) =>
            snapshot.threads.flatMap((thread) => thread.messages.map((message) => message.text)),
          ),
        ),
      count,
    );
    yield* measure(
      "detail",
      query
        .getThreadDetailById(threadId)
        .pipe(
          Effect.map((thread) => Option.getOrThrow(thread).messages.map((message) => message.text)),
        ),
      count,
    );
    const windowInput = {
      threadId,
      limits: { messages: 100, activities: 10, proposedPlans: 10, checkpoints: 10 },
    };
    yield* measure(
      "window100",
      query.getThreadWindow!(windowInput).pipe(
        Effect.map((window) => window.thread.messages.map((message) => message.text)),
      ),
      100,
    );
    const window = yield* query.getThreadWindow!(windowInput);
    yield* measure(
      "history100",
      query.getThreadHistoryPage!({
        threadId,
        collection: "messages",
        mode: { kind: "before", cursor: window.history.messages.oldestCursor! },
        limit: 100,
      }).pipe(
        Effect.map((page) =>
          page.collection === "messages" ? page.items.map((message) => message.text) : [],
        ),
      ),
      100,
    );
    yield* measure(
      "turn100",
      query.listThreadMessagesByTurn!({ threadId, turnId, limit: 100 }).pipe(
        Effect.map((rows) => rows.map((row) => row.text)),
      ),
      100,
    );
    yield* measure(
      "queryMessage",
      query.getThreadMessageById!({ threadId, messageId: MessageId.make("read-1000") }).pipe(
        Effect.map((row) => [Option.getOrThrow(row).text]),
      ),
      1,
    );
    yield* measure(
      "commandReadModel",
      query
        .getCommandReadModel()
        .pipe(
          Effect.map((snapshot) =>
            snapshot.threads.flatMap((thread) => thread.messages.map((message) => message.text)),
          ),
        ),
      1,
    );
    yield* measure(
      "search50",
      query
        .searchThreadMessages({ query: "ordinary", threadId, limit: 50 })
        .pipe(Effect.map((rows) => rows.map((row) => row.snippet))),
      50,
      body.slice(0, 180).replace(/\s+/g, " ").trim() + "...",
    );
    yield* measure(
      "priority",
      priority.listActive.pipe(
        Effect.map((rows) => rows.map((row) => row.latestUserRequest ?? "")),
      ),
      1,
    );
    yield* measure(
      "sideContext201",
      query.getCompletedSideQuestionContext!(threadId).pipe(
        Effect.map((context) => context.messages.map((message) => message.text)),
      ),
      201,
    );
    yield* measure(
      "revertIncludingSummary",
      Effect.suspend(() =>
        apply({ type: "thread.reverted", payload: { threadId, turnCount: 1 } }),
      ).pipe(Effect.as([] as string[])),
      0,
    );
    const retained = yield* repository.listByThreadId({ threadId });
    if (retained.length !== count || retained.some((row) => row.text !== body))
      throw new Error("Revert changed retained text");
    console.log(
      JSON.stringify({
        profile,
        settings,
        runtime: process.version,
        rows: count,
        charsPerRow: body.length,
        warmup: 3,
        samples: 20,
        results,
        finalContentMatches: true,
        sha256: createHash("sha256")
          .update(retained.map((row) => row.text).join(""))
          .digest("hex"),
      }),
    );
    return;
  }
  const start = performance.now();
  for (let offset = 0; offset < bytes; offset += batchChars)
    for (let m = 0; m < messages; m++)
      yield* send(m, expected.slice(offset, offset + batchChars), true);
  const streamingMs = performance.now() - start;
  const completionStart = performance.now();
  for (let m = 0; m < messages; m++) yield* send(m, "", false);
  const completionMs = performance.now() - completionStart;
  const walBytes = statSync(`${filename}-wal`).size;
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
      profile,
      batchChars,
      eventsPerMessage: Math.ceil(bytes / batchChars) + 1,
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
