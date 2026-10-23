/** Fresh-file production event-store/projection fixture; run with Node (server runtime).
 * node apps/server/scripts/measure-streaming-sqlite.ts [bytes=200000] [messages=1] [profile=buffered]
 * node apps/server/scripts/measure-streaming-sqlite.ts [updates=2000] [cadenceMs=20] tools
 * Profiles model persisted batch sizes; provider/network/timer waiting is excluded.
 * Reports WAL growth, not physical disk writes or whole-application savings.
 *
 * `streaming-turn` is `streaming` inside a running turn, with each event's time 1 ms after the
 * previous one as in production. `tools` models one OpenCode bash call: a pending update, then
 * `updates` running updates `cadenceMs` apart whose activity time is the tool's start, then the
 * completion. The other write profiles keep one constant event time, so a write that only moves
 * `updated_at` is a no-op there: quote `streaming-turn`/`tools` for per-event row writes.
 * `rowWrites` comes from TEMP-trigger counters inside the timed loops; set
 * RYCO_SQLITE_FIXTURE_ROW_WRITES=0 for timings without them (compare-streaming-sqlite.ts does).
 *
 * Any `apps/server/src` module imported statically must exist at the
 * RYCO_SQLITE_FIXTURE_REF baseline (streaming-sqlite-revision.ts loads it from there).
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
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  ThreadId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
} from "@ryco/contracts";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
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
import { installRowWriteProbe } from "./sqliteRowWriteProbe.ts";

const profile = process.argv[4] ?? "buffered";
if (
  !["buffered", "streaming", "streaming-turn", "timer", "stress", "reads", "tools"].includes(
    profile,
  )
)
  throw new Error("Unknown profile");
const isTools = profile === "tools";
// `tools`: provider updates and their cadence (ms) instead of bytes and messages.
const bytes = Number(process.argv[2] ?? (isTools ? 2000 : 200000));
const messages = Number(process.argv[3] ?? (isTools ? 20 : 1));
const batchChars =
  profile === "buffered"
    ? 24040
    : profile === "streaming" || profile === "streaming-turn"
      ? 4096
      : profile === "timer"
        ? 320
        : 40;
if (isTools) {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || !Number.isSafeInteger(messages) || messages < 1)
    throw new Error("Use a positive update count and a positive cadence in ms");
} else if (
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
  const nowMs = Date.parse(now);
  const isoAt = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();
  const threadId = ThreadId.make("fixture-thread");
  const projectId = ProjectId.make("fixture-project");
  const turnId = TurnId.make("fixture-turn");
  let id = 0;
  const apply = (event: Pick<OrchestrationEvent, "type" | "payload">, occurredAt = now) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const key = String(++id);
          const persisted = yield* store.append({
            ...event,
            eventId: EventId.make(key),
            aggregateKind: event.type === "project.created" ? "project" : "thread",
            aggregateId: event.type === "project.created" ? projectId : threadId,
            occurredAt,
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
  const inTurn = profile === "streaming-turn" || isTools;
  if (inTurn)
    yield* apply({
      type: "thread.session-set",
      payload: {
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "opencode",
          runtimeMode: "full-access",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: now,
        },
      },
    });
  // Row writes per table, counted by TEMP triggers on the writer connection (they never reach the
  // main database or its WAL). Each counted write adds one temp-table UPDATE inside the timed
  // loops, so RYCO_SQLITE_FIXTURE_ROW_WRITES=0 times without them and prints `rowWrites: null`.
  const countRowWrites = profile !== "reads" && process.env.RYCO_SQLITE_FIXTURE_ROW_WRITES !== "0";
  const threadRowWrites = countRowWrites
    ? yield* installRowWriteProbe({ name: "fixture_threads", table: "projection_threads" })
    : undefined;
  const turnRowWrites = countRowWrites
    ? yield* installRowWriteProbe({ name: "fixture_turns", table: "projection_turns" })
    : undefined;
  const rowWrites = () =>
    threadRowWrites === undefined || turnRowWrites === undefined
      ? Effect.succeed(null)
      : Effect.all({ threads: threadRowWrites, turns: turnRowWrites });
  const persistedEventsSince = (sequence: number) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_events WHERE sequence > ${sequence}
    `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));
  const [setupHead] = yield* sql<{ readonly sequence: number | null }>`
    SELECT MAX(sequence) AS sequence FROM orchestration_events
  `;
  const setupSequence = setupHead?.sequence ?? 0;
  yield* sql`PRAGMA wal_autocheckpoint = 0`;
  yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
  const settings = {
    sqlite: yield* sql`SELECT sqlite_version() AS version`,
    synchronous: yield* sql`PRAGMA synchronous`,
    pageSize: yield* sql`PRAGMA page_size`,
  };
  const delta = "0123456789abcdefghij0123456789abcdefghij";
  const expected = delta.repeat(bytes / 40);
  // streaming-turn: each event 1 ms after the previous one (a reply's updatedAt is its flush time).
  let eventClockMs = 0;
  const send = (index: number, text: string, streaming: boolean) => {
    const occurredAt = profile === "streaming-turn" ? isoAt(++eventClockMs) : now;
    return apply(
      {
        type: "thread.message-sent",
        payload: {
          threadId,
          messageId: MessageId.make(`message-${index}`),
          role: "assistant",
          text,
          turnId: profile === "reads" || profile === "streaming-turn" ? turnId : null,
          streaming,
          createdAt: now,
          updatedAt: occurredAt,
        },
      },
      occurredAt,
    );
  };
  if (isTools) {
    // One OpenCode bash call, shaped like OpenCodeAdapter's tool emission: `item.started`
    // (pending) carries its own emission time, every running update the tool's start time
    // (constant), the completion its end time. Bash streams its output into
    // `state.metadata.output`, one update per chunk; the persisted payload drops it.
    const { runtimeEventToActivities } = yield* Effect.promise(
      () => import("../src/orchestration/Layers/ProviderRuntimeIngestion.ts"),
    );
    const updates = bytes;
    const cadenceMs = messages;
    const callId = "fixture-call";
    const input = { command: "bun run test", description: "Run tests" };
    const pendingAtMs = 1;
    const startMs = 2;
    const endMs = startMs + updates * cadenceMs;
    const outputLine = (index: number) =>
      `line ${String(index).padStart(6, "0")} `.padEnd(79, ".") + "\n";
    const toolEvent = (
      index: number,
      type: "item.started" | "item.updated" | "item.completed",
      state: Record<string, unknown>,
      createdAt: string,
    ): ProviderRuntimeEvent =>
      ({
        eventId: EventId.make(`fixture-tool-${index}`),
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        createdAt,
        turnId,
        itemId: RuntimeItemId.make(callId),
        type,
        payload: {
          itemType: "command_execution",
          status: type === "item.completed" ? "completed" : ("inProgress" as const),
          title: "bash",
          data: { tool: "bash", state },
        },
      }) as ProviderRuntimeEvent;
    let output = "";
    const events: ProviderRuntimeEvent[] = [
      toolEvent(0, "item.started", { status: "pending", input: {}, raw: "" }, isoAt(pendingAtMs)),
    ];
    for (let index = 1; index <= updates; index++) {
      output += outputLine(index);
      events.push(
        toolEvent(
          index,
          "item.updated",
          { status: "running", input, metadata: { output }, time: { start: nowMs + startMs } },
          isoAt(startMs),
        ),
      );
    }
    events.push(
      toolEvent(
        updates + 1,
        "item.completed",
        {
          status: "completed",
          input,
          output,
          title: "bash",
          metadata: { output },
          time: { start: nowMs + startMs, end: nowMs + endMs },
        },
        isoAt(endMs),
      ),
    );
    const start = performance.now();
    for (const event of events) {
      const [activity] = runtimeEventToActivities(event);
      if (activity === undefined) throw new Error(`No activity for ${event.type}`);
      // decider: an activity append occurs at the activity's own time.
      yield* apply(
        { type: "thread.activity-appended", payload: { threadId, activity } },
        activity.createdAt,
      );
    }
    const elapsedMs = performance.now() - start;
    const walBytes = statSync(`${filename}-wal`).size;
    const persistedEvents = yield* persistedEventsSince(setupSequence);
    const [activityCount] = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM projection_thread_activities WHERE thread_id = ${threadId}
    `;
    const [thread] = yield* sql<{ readonly updatedAt: string }>`
      SELECT updated_at AS "updatedAt" FROM projection_threads WHERE thread_id = ${threadId}
    `;
    const activityRows = activityCount?.count ?? 0;
    if (activityRows !== updates + 2 || thread?.updatedAt !== isoAt(endMs))
      throw new Error("Tool activity projection mismatch");
    console.log(
      JSON.stringify({
        runtime: process.version,
        bun: process.versions.bun ?? null,
        profile,
        providerUpdates: updates,
        cadenceMs,
        persistedEvents,
        walBytes,
        walBytesPerEvent: Math.round(walBytes / persistedEvents),
        rowWrites: yield* rowWrites(),
        activityRows,
        settings,
        elapsedMs,
      }),
    );
    return;
  }
  if (profile === "reads") {
    const query = yield* ProjectionSnapshotQuery;
    const priority = yield* ThreadPriorityCandidateQuery;
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
      priority
        .listActive({ autoSettleAfterDays: null, nowMs: Date.now() })
        .pipe(Effect.map((rows) => rows.map((row) => row.latestUserRequest ?? ""))),
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
  const persistedEvents = yield* persistedEventsSince(setupSequence);
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
      persistedEvents,
      walBytesPerEvent: Math.round(walBytes / persistedEvents),
      rowWrites: yield* rowWrites(),
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
