/**
 * Times the server's per-action reads of one long thread; run with Node (server runtime).
 *
 *   node apps/server/scripts/bench-long-thread-reads.ts [--items 5000,20000] [--runs 15]
 *     [--keep <dir>] [--home <dir>] [--thread <id> ...] [--only <path,...>] [--out results.json]
 *
 * Seeds a home (or reuses one written earlier with `--keep`, through `--home`) with a few short
 * threads and one long thread per `--items` size, every row written through the real
 * orchestration engine, so projections are what a running server holds. A turn is a user
 * message, eight tool calls (started + completed), two context-window reports and an assistant
 * reply (20 items), plus a subagent task every fifth turn and a checkpoint. Tool outputs carry about
 * 1.5 KB and replies about 0.8 KB, so reads that touch every row pay for realistic row sizes.
 *
 * With `--home <dir> --thread <id>` it measures existing threads of a home instead, such as a
 * copy of a real one (`sqlite3 'file:<db>?mode=ro' "VACUUM INTO '<dir>/userdata/state.sqlite'"`
 * takes a consistent copy of a running node's database).
 *
 * Then, per long thread, it times each read path a client action or an agent tool call runs:
 * the warm median of `--runs` calls after the first call, and that first call. Each measurement
 * runs on a copy of the database. `getThreadDetailById`
 * (the whole thread) is listed as the reference for what an unbounded read costs. The send path
 * times one `thread.turn.start` through the engine (decider + projection writes), followed by an
 * untimed session reset so the next send is accepted.
 *
 * It is a script, not a test: the numbers depend on the machine. Compare before and after on
 * the same machine and the same seed.
 */
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThreadHistoryCursor,
} from "@ryco/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../src/config.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../src/orchestration/ThreadBackgroundLiveness.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../src/project/Layers/RepositoryIdentityResolver.ts";
import { ProjectAvatarStore } from "../src/project/Services/ProjectAvatarStore.ts";

const MockProjectAvatarStoreLive = Layer.succeed(ProjectAvatarStore, {
  write: () => Effect.die("unused"),
  read: () => Effect.succeed(null),
  remove: () => Effect.void,
});

/** The window a client subscription asks for (`THREAD_WINDOW_LIMITS` in client-runtime). */
const CLIENT_WINDOW_LIMITS = { messages: 150, proposedPlans: 30, activities: 150, checkpoints: 30 };
const TOOL_CALLS_PER_TURN = 8;
const USAGE_REPORTS_PER_TURN = 2;
const ITEMS_PER_TURN = 1 + TOOL_CALLS_PER_TURN * 2 + USAGE_REPORTS_PER_TURN + 1;

const PROSE =
  "The projection pipeline tests pass and the plan is unchanged. The session supervisor now keeps the shell snapshot across reconnects and replays only the missing events. ".repeat(
    40,
  );
/** About 1.5 KB of tool output, as a finished command carries. */
const toolOutput = (turn: number, tool: number) =>
  `$ bun run test (turn ${turn}, call ${tool})\n${PROSE.slice(0, 1_500)}`;

const median = (values: ReadonlyArray<number>) =>
  values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)]!;
const round = (value: number) => Math.round(value * 100) / 100;

function makeRuntime(dbPath: string, baseDir: string) {
  const layer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(MockProjectAvatarStoreLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provideMerge(makeSqlitePersistenceLive(dbPath, { checkpointWorker: false })),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
  return ManagedRuntime.make(layer);
}

type Runtime = ReturnType<typeof makeRuntime>;

const longThreadId = (items: number) => ThreadId.make(`bench-long-thread-${items}`);
const PROJECT_ID = ProjectId.make("bench-project");

async function seed(home: string, sizes: ReadonlyArray<number>) {
  const stateDir = join(home, "userdata");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(home, "workspace"), { recursive: true });
  const runtime = makeRuntime(join(stateDir, "state.sqlite"), home);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  let serial = 0;
  let clockMs = Date.parse("2026-06-01T09:00:00.000Z");
  const at = (stepMs = 1_000) => new Date((clockMs += stepMs)).toISOString();
  const dispatch = (command: Record<string, unknown>) =>
    runtime.runPromise(
      engine.dispatch({
        ...command,
        commandId: CommandId.make(`bench-command-${(serial += 1)}`),
      } as unknown as OrchestrationCommand),
    );
  await dispatch({
    type: "project.create",
    projectId: PROJECT_ID,
    title: "Bench project",
    workspaceRoot: join(home, "workspace"),
    createdAt: at(),
  });
  const seedThread = async (threadId: ThreadId, turns: number) => {
    await dispatch({
      type: "thread.create",
      threadId,
      projectId: PROJECT_ID,
      title: `Bench ${threadId}`,
      modelSelection: { instanceId: "codex", model: "gpt-5.5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: at(),
    });
    for (let turn = 1; turn <= turns; turn += 1) {
      await seedTurn(threadId, turn);
    }
  };
  const session = (threadId: ThreadId, status: "running" | "ready", turnId: TurnId | null) => ({
    threadId,
    status,
    providerName: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeSessionId: RuntimeSessionId.make(`bench-runtime-${threadId}`),
    runtimeMode: "full-access",
    activeTurnId: turnId,
    lastError: null,
    updatedAt: new Date(clockMs).toISOString(),
  });
  const seedTurn = async (threadId: ThreadId, turn: number) => {
    const turnId = TurnId.make(`${threadId}-turn-${turn}`);
    await dispatch({
      type: "thread.turn.start",
      threadId,
      message: {
        messageId: MessageId.make(`${threadId}-user-${turn}`),
        role: "user",
        text: `Turn ${turn}: refactor the session supervisor and keep the shell snapshot.`,
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: at(),
    });
    await dispatch({
      type: "thread.session.set",
      threadId,
      session: session(threadId, "running", turnId),
      createdAt: at(),
    });
    const activity = (id: string, kind: string, payload: Record<string, unknown>) => {
      const createdAt = at(200);
      return dispatch({
        type: "thread.activity.append",
        threadId,
        activity: {
          id: EventId.make(id),
          tone: kind.startsWith("tool") ? "tool" : "info",
          kind,
          summary: kind,
          payload,
          turnId,
          createdAt,
        },
        createdAt,
      });
    };
    if (turn % 5 === 0) {
      await activity(`${threadId}-task-${turn}-started`, "task.started", {
        taskId: `${threadId}-task-${turn}`,
        title: `Subagent ${turn}`,
      });
    }
    for (let tool = 1; tool <= TOOL_CALLS_PER_TURN; tool += 1) {
      for (const kind of ["tool.started", "tool.completed"] as const) {
        await activity(`${threadId}-tool-${turn}-${tool}-${kind}`, kind, {
          itemType: "command_execution",
          title: "Bash",
          detail: kind === "tool.completed" ? toolOutput(turn, tool) : undefined,
        });
      }
    }
    if (turn % 5 === 0) {
      await activity(`${threadId}-task-${turn}-completed`, "task.completed", {
        taskId: `${threadId}-task-${turn}`,
        status: "completed",
        outputFile: `/tmp/bench/${threadId}-task-${turn}.output`,
      });
    }
    for (let report = 1; report <= USAGE_REPORTS_PER_TURN; report += 1) {
      await activity(`${threadId}-usage-${turn}-${report}`, "context-window.updated", {
        usedTokens: 40_000 + turn,
        maxTokens: 400_000,
        lastInputTokens: 30_000,
        lastOutputTokens: 2_000,
      });
    }
    const assistantMessageId = MessageId.make(`${threadId}-assistant-${turn}`);
    await dispatch({
      type: "thread.message.assistant.complete",
      threadId,
      messageId: assistantMessageId,
      text: `Done with turn ${turn}. ${PROSE.slice(0, 800)}`,
      turnId,
      createdAt: at(),
    });
    await dispatch({
      type: "thread.turn.diff.complete",
      threadId,
      turnId,
      completedAt: at(),
      checkpointRef: CheckpointRef.make(`refs/ryco/checkpoints/${threadId}/turn/${turn}`),
      status: "ready",
      files: [{ path: `src/file-${turn % 40}.ts`, kind: "modified", additions: 3, deletions: 1 }],
      assistantMessageId,
      checkpointTurnCount: turn,
      createdAt: at(),
    });
    const completedAt = at();
    await dispatch({
      type: "thread.session.set",
      threadId,
      session: session(threadId, "ready", null),
      // How ingestion releases a turn the provider reported completed.
      turnOutcome: { turnId, state: "completed", reason: "provider-turn-completed", completedAt },
      createdAt: completedAt,
    });
  };

  for (let index = 1; index <= 20; index += 1) {
    await seedThread(ThreadId.make(`bench-short-thread-${index}`), 3);
  }
  for (const items of sizes) {
    const startedAt = performance.now();
    await seedThread(longThreadId(items), Math.ceil(items / ITEMS_PER_TURN));
    console.error(
      `seeded ${items} items in ${Math.round((performance.now() - startedAt) / 1000)} s`,
    );
  }
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  await runtime.runPromise(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
  await runtime.dispose();
}

interface PathResult {
  readonly firstMs: number;
  readonly medianMs: number;
}

async function time(
  runtime: Runtime,
  runs: number,
  task: () => Effect.Effect<unknown, object, never>,
  after?: () => Effect.Effect<unknown, object, never>,
): Promise<PathResult> {
  const once = async () => {
    const startedAt = performance.now();
    await runtime.runPromise(task());
    const elapsed = performance.now() - startedAt;
    if (after) await runtime.runPromise(after());
    return elapsed;
  };
  const firstMs = await once();
  const samples: number[] = [];
  for (let run = 0; run < runs; run += 1) samples.push(await once());
  return { firstMs: round(firstMs), medianMs: round(median(samples)) };
}

interface Target {
  readonly label: string;
  readonly threadId: ThreadId;
}

async function measure(
  home: string,
  targets: ReadonlyArray<Target>,
  runs: number,
  only?: Set<string>,
) {
  // Measured on a copy (an APFS clone where possible): the send path writes, and a kept or real
  // home must stay as it was.
  const work = mkdtempSync(join(tmpdir(), "ryco-bench-long-run-"));
  const dbPath = join(work, "state.sqlite");
  copyFileSync(join(home, "userdata", "state.sqlite"), dbPath, constants.COPYFILE_FICLONE);
  const runtime = makeRuntime(dbPath, work);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  const results: Record<string, Record<string, PathResult | string>> = {};
  let serial = 0;

  for (const { label, threadId } of targets) {
    // Ids the per-turn paths ask about, read the same way for seeded and real threads.
    const [ids] = await runtime.runPromise(
      sql<{
        readonly messages: number;
        readonly activities: number;
        readonly turns: number;
        readonly latestTurnId: string | null;
        readonly firstUserMessageId: string | null;
        readonly latestUserMessageId: string | null;
        readonly taskId: string | null;
      }>`
        SELECT
          (SELECT COUNT(*) FROM projection_thread_messages WHERE thread_id = ${threadId}) AS messages,
          (SELECT COUNT(*) FROM projection_thread_activities WHERE thread_id = ${threadId}) AS activities,
          (SELECT COUNT(*) FROM projection_turns WHERE thread_id = ${threadId}) AS turns,
          (SELECT latest_turn_id FROM projection_threads WHERE thread_id = ${threadId}) AS "latestTurnId",
          (SELECT message_id FROM projection_thread_messages WHERE thread_id = ${threadId}
            AND role = 'user' ORDER BY created_at ASC LIMIT 1) AS "firstUserMessageId",
          (SELECT message_id FROM projection_thread_messages WHERE thread_id = ${threadId}
            AND role = 'user' ORDER BY created_at DESC LIMIT 1) AS "latestUserMessageId",
          (SELECT json_extract(payload_json, '$.taskId') FROM projection_thread_activities
            WHERE thread_id = ${threadId} AND kind = 'task.started'
            ORDER BY sequence DESC LIMIT 1) AS "taskId"
      `,
    );
    console.error(
      `${label} (${threadId}): ${ids!.messages} messages + ${ids!.activities} activities, ${ids!.turns} turns`,
    );
    const latestTurnId = TurnId.make(ids!.latestTurnId ?? "none");
    const window = await runtime.runPromise(
      query.getThreadWindow!({
        threadId,
        limits: CLIENT_WINDOW_LIMITS,
        activityPayloads: "preview",
      }),
    );
    const paths: Record<string, () => Effect.Effect<unknown, object, never>> = {
      "reference.getThreadDetailById": () => query.getThreadDetailById(threadId),
      "open.getThreadWindow": () =>
        query.getThreadWindow!({
          threadId,
          limits: CLIENT_WINDOW_LIMITS,
          activityPayloads: "preview",
        }),
      "open.historyPage.activities": () =>
        query.getThreadHistoryPage!({
          threadId,
          collection: "activities",
          mode: {
            kind: "before",
            cursor: window.history.activities.oldestCursor as OrchestrationThreadHistoryCursor,
          },
          limit: 150,
          activityPayloads: "preview",
        }),
      "open.historyPage.messages": () =>
        query.getThreadHistoryPage!({
          threadId,
          collection: "messages",
          mode: {
            kind: "before",
            cursor: window.history.messages.oldestCursor as OrchestrationThreadHistoryCursor,
          },
          limit: 150,
        }),
      "shell.getThreadShellById": () => query.getThreadShellById(threadId),
      "shell.getShellSnapshot": () => query.getShellSnapshot(),
      "turnStart.getThreadMessageById": () =>
        query.getThreadMessageById!({
          threadId,
          messageId: MessageId.make(ids!.firstUserMessageId ?? "none"),
        }),
      "turnStart.countThreadUserMessages": () => query.countThreadUserMessages!(threadId),
      "turnStart.countThreadUserMessages.bound": () =>
        query.countThreadUserMessages!(threadId, {
          createdAtOrBefore: "2099-01-01T00:00:00.000Z",
          excludingMessageId: MessageId.make(ids!.latestUserMessageId ?? "none"),
        }),
      "turnStart.getThreadCheckpointContext": () => query.getThreadCheckpointContext(threadId),
      "turn.listThreadPendingRequestActivities": () =>
        query.listThreadPendingRequestActivities!(threadId),
      "turn.hasThreadAssistantMessageForTurn": () =>
        query.hasThreadAssistantMessageForTurn!({
          threadId,
          turnId: latestTurnId,
          streamingOnly: true,
        }),
      "turn.listThreadMessagesByTurn": () =>
        query.listThreadMessagesByTurn!({ threadId, turnId: latestTurnId, limit: 20 }),
      "turn.listThreadTaskActivities": () =>
        query.listThreadTaskActivities!({ threadId, taskId: ids!.taskId ?? "none" }),
      "turn.getThreadHistoryRepairContext": () =>
        query.getThreadHistoryRepairContext!({
          threadId,
          turnIds: [latestTurnId],
          messageIds: [],
          activityIds: [],
          includeTurnlessActivities: false,
        }),
      "turn.getLatestCheckpointRevert": () => query.getLatestCheckpointRevert!(threadId),
      "tasks.listThreadTaskPathRefs": () => query.listThreadTaskPathRefs!(threadId),
      "sideQuestion.getCompletedSideQuestionContext": () =>
        query.getCompletedSideQuestionContext!(threadId),
      "artifacts.listThreadArtifactMessages": () =>
        query.listThreadArtifactMessages!({ threadId, limit: 50 }),
    };
    const threadResults: Record<string, PathResult | string> = {};
    for (const [name, task] of Object.entries(paths)) {
      if (only && !only.has(name)) continue;
      threadResults[name] = await time(runtime, runs, task);
    }
    if (!only || only.has("send.turnStart")) {
      threadResults["send.turnStart"] = await time(
        runtime,
        runs,
        () =>
          engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`bench-send-${(serial += 1)}`),
            threadId,
            message: {
              messageId: MessageId.make(`bench-send-message-${serial}`),
              role: "user",
              text: "One more change, please.",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: new Date().toISOString(),
          } as unknown as OrchestrationCommand),
        () =>
          engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(`bench-send-reset-${(serial += 1)}`),
            threadId,
            session: {
              threadId,
              status: "ready",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeSessionId: RuntimeSessionId.make(`bench-runtime-${threadId}`),
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: new Date().toISOString(),
            },
            createdAt: new Date().toISOString(),
          } as unknown as OrchestrationCommand),
      ).catch((cause: unknown) => `skipped: ${String(cause).slice(0, 200)}`);
    }
    results[label] = threadResults;
  }
  await runtime.dispose();
  rmSync(work, { recursive: true, force: true });
  return results;
}

const { values } = parseArgs({
  options: {
    items: { type: "string", default: "5000,20000" },
    runs: { type: "string", default: "15" },
    keep: { type: "string" },
    home: { type: "string" },
    thread: { type: "string", multiple: true },
    only: { type: "string" },
    out: { type: "string" },
  },
});
const sizes = values.items.split(",").map((value) => Number(value.trim()));
let home: string;
let cleanup = false;
if (values.home) {
  home = resolve(values.home);
} else {
  home = values.keep ? resolve(values.keep) : mkdtempSync(join(tmpdir(), "ryco-bench-long-"));
  if (values.keep && existsSync(home)) rmSync(home, { recursive: true, force: true });
  cleanup = !values.keep;
  await seed(home, sizes);
}
const targets: ReadonlyArray<Target> = values.thread?.length
  ? values.thread.map((threadId) => ({ label: threadId, threadId: ThreadId.make(threadId) }))
  : sizes.map((items) => ({ label: `${items} items`, threadId: longThreadId(items) }));
try {
  const only = values.only ? new Set(values.only.split(",")) : undefined;
  const results = await measure(home, targets, Number(values.runs), only);
  const report = JSON.stringify(results, null, 2);
  if (values.out) writeFileSync(values.out, report);
  console.log(report);
} finally {
  if (cleanup) rmSync(home, { recursive: true, force: true });
}
