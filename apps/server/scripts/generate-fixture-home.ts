/**
 * Generates a realistic, sanitized Ryco home for performance work; run with Node (server runtime).
 *
 *   node apps/server/scripts/generate-fixture-home.ts --out /tmp/ryco-fixture-home \
 *     [--projects 30] [--threads 2000] [--turns 4] [--archived 0.6] [--seed 1]
 *
 * Every row is written the way a running server writes it: commands are dispatched through the
 * real orchestration engine, so events, projections and projector cursors are consistent and the
 * server boots on the result without repairs. The defaults model a heavy user: 30 projects,
 * 2,000 threads (60% archived), a few workspaces per project, and per turn a user prompt, tool
 * activity, a context-window token report, an assistant reply and a checkpoint with files.
 * Composer drafts live in the client, not in the home, so none are generated.
 *
 * The output works with `bun run perf:external --fixture-home <out>` (copied per iteration) and
 * with `--base-dir <out>` for any `ryco serve` run. Deterministic for a given seed and size.
 */
import { mkdirSync, rmSync, statSync, existsSync } from "node:fs";
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
  WorktreeId,
  type OrchestrationCommand,
} from "@ryco/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../src/config.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../src/orchestration/ThreadBackgroundLiveness.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../src/project/Layers/RepositoryIdentityResolver.ts";
import { ProjectAvatarStore } from "../src/project/Services/ProjectAvatarStore.ts";

export interface FixtureHomeOptions {
  readonly out: string;
  readonly projects: number;
  readonly threads: number;
  /** Average turns per thread; each thread gets 1..2*turns-1. */
  readonly turns: number;
  readonly archivedShare: number;
  readonly seed: number;
}

export interface FixtureHomeSummary {
  readonly dbPath: string;
  readonly projects: number;
  readonly threads: number;
  readonly archivedThreads: number;
  readonly worktrees: number;
  readonly turns: number;
  readonly commands: number;
  readonly durationMs: number;
  readonly dbBytes: number;
}

/** mulberry32: small, fast, deterministic. */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: ReadonlyArray<T>): T => items[Math.floor(next() * items.length)]!,
  };
}

const WORDS =
  "refactor the session supervisor so reconnects keep the shell snapshot and replay only missing events add tests for the projection pipeline check the sqlite plan for the thread list index review error handling in the provider adapter measure boot time on a large database update the sidebar grouping when a worktree is archived fix the flaky browser test around hover state document the migration and its backfill keep wire compatibility with older clients".split(
    " ",
  );
const MODELS = [
  { instanceId: "codex", model: "gpt-5.4" },
  { instanceId: "codex", model: "gpt-5.5-codex" },
  { instanceId: "claudeAgent", model: "claude-opus-5-5" },
  { instanceId: "claudeAgent", model: "claude-sonnet-5" },
] as const;
const TOOLS = ["Read", "Edit", "Bash", "Grep", "Write"] as const;

function sentence(random: ReturnType<typeof makeRandom>, words: number): string {
  const parts: string[] = [];
  for (let index = 0; index < words; index += 1) parts.push(random.pick(WORDS));
  const text = parts.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

function paragraph(random: ReturnType<typeof makeRandom>, sentences: number): string {
  return Array.from({ length: sentences }, () => sentence(random, random.int(8, 20))).join(" ");
}

const MockProjectAvatarStoreLive = Layer.succeed(ProjectAvatarStore, {
  write: () => Effect.die("ProjectAvatarStore.write is not used by the fixture generator"),
  read: () => Effect.succeed(null),
  remove: () => Effect.void,
});

export async function generateFixtureHome(
  options: FixtureHomeOptions,
): Promise<FixtureHomeSummary> {
  const startedAt = performance.now();
  const out = resolve(options.out);
  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  const stateDir = join(out, "userdata");
  const workspacesDir = join(out, "workspaces");
  mkdirSync(stateDir, { recursive: true });
  const dbPath = join(stateDir, "state.sqlite");

  const layer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(MockProjectAvatarStoreLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), out)),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const random = makeRandom(options.seed);
  let commands = 0;
  let commandSerial = 0;
  const dispatch = async (command: Record<string, unknown>) => {
    commands += 1;
    try {
      await runtime.runPromise(
        engine.dispatch({
          ...command,
          commandId: CommandId.make(`fixture-command-${(commandSerial += 1)}`),
        } as unknown as OrchestrationCommand),
      );
    } catch (cause) {
      throw new Error(`Fixture command ${String(command.type)} failed`, { cause });
    }
  };

  // Spread history over the last ~120 days, oldest first, so ordering looks lived-in.
  const historyStartMs = Date.parse("2026-06-01T09:00:00.000Z");
  let clockMs = historyStartMs;
  const tick = (minMs: number, maxMs: number) => {
    clockMs += random.int(minMs, maxMs);
    return new Date(clockMs).toISOString();
  };
  const totalSpanMs = 120 * 24 * 3600 * 1000;
  const perThreadSpanMs = Math.floor(totalSpanMs / Math.max(1, options.threads));

  const projects: Array<{
    readonly id: ProjectId;
    readonly root: string;
    readonly worktrees: Array<{ id: WorktreeId; branch: string; path: string }>;
  }> = [];
  for (let index = 0; index < options.projects; index += 1) {
    const id = ProjectId.make(`fixture-project-${index + 1}`);
    const root = join(workspacesDir, `project-${index + 1}`);
    mkdirSync(root, { recursive: true });
    await dispatch({
      type: "project.create",
      projectId: id,
      title: `Project ${index + 1} ${random.pick(WORDS)}`,
      workspaceRoot: root,
      createdAt: tick(1_000, 5_000),
    });
    const worktrees: Array<{ id: WorktreeId; branch: string; path: string }> = [];
    const worktreeCount = random.int(0, 5);
    for (let worktree = 0; worktree < worktreeCount; worktree += 1) {
      const branch = `feature/${random.pick(WORDS)}-${index + 1}-${worktree + 1}`;
      const path = join(out, "worktrees", `project-${index + 1}`, `wt-${worktree + 1}`);
      const worktreeId = WorktreeId.make(`fixture-worktree-${index + 1}-${worktree + 1}`);
      await dispatch({
        type: "worktree.create",
        worktreeId,
        projectId: id,
        branch,
        worktreePath: path,
        origin: random.next() < 0.3 ? "pr" : "branch",
        prNumber: null,
        issueNumber: null,
        prTitle: null,
        issueTitle: null,
        createdAt: tick(1_000, 5_000),
      });
      worktrees.push({ id: worktreeId, branch, path });
    }
    projects.push({ id, root, worktrees });
  }

  let archivedThreads = 0;
  let turnCount = 0;
  for (let index = 0; index < options.threads; index += 1) {
    clockMs = Math.max(clockMs, historyStartMs + index * perThreadSpanMs);
    const project = projects[index % projects.length]!;
    const threadId = ThreadId.make(`fixture-thread-${index + 1}`);
    const model = random.pick(MODELS);
    const workspace =
      project.worktrees.length > 0 && random.next() < 0.4 ? random.pick(project.worktrees) : null;
    await dispatch({
      type: "thread.create",
      threadId,
      projectId: project.id,
      title: sentence(random, random.int(3, 8)).slice(0, -1),
      modelSelection: model,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: workspace?.branch ?? null,
      worktreePath: workspace?.path ?? null,
      createdAt: tick(1_000, 60_000),
    });
    if (workspace !== null) {
      await dispatch({
        type: "thread.attach-to-worktree",
        threadId,
        worktreeId: workspace.id,
        attachedAt: tick(100, 1_000),
      });
    }
    const runtimeSessionId = RuntimeSessionId.make(`fixture-runtime-${index + 1}`);
    const turns = random.int(1, Math.max(1, options.turns * 2 - 1));
    for (let turn = 0; turn < turns; turn += 1) {
      turnCount += 1;
      const turnId = TurnId.make(`fixture-turn-${index + 1}-${turn + 1}`);
      await dispatch({
        type: "thread.turn.start",
        threadId,
        message: {
          messageId: MessageId.make(`fixture-user-${index + 1}-${turn + 1}`),
          role: "user",
          text: paragraph(random, random.int(1, 4)),
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: tick(5_000, 120_000),
      });
      const session = (status: "running" | "ready", activeTurnId: TurnId | null) => ({
        threadId,
        status,
        providerName: model.instanceId,
        providerInstanceId: ProviderInstanceId.make(model.instanceId),
        runtimeSessionId,
        runtimeMode: "full-access",
        activeTurnId,
        lastError: null,
        updatedAt: new Date(clockMs).toISOString(),
      });
      tick(500, 3_000);
      await dispatch({
        type: "thread.session.set",
        threadId,
        session: session("running", turnId),
        createdAt: new Date(clockMs).toISOString(),
      });
      const tools = random.int(2, 8);
      for (let tool = 0; tool < tools; tool += 1) {
        const name = random.pick(TOOLS);
        for (const kind of ["tool.started", "tool.completed"] as const) {
          const createdAt = tick(200, 8_000);
          await dispatch({
            type: "thread.activity.append",
            threadId,
            activity: {
              id: EventId.make(`fixture-activity-${index + 1}-${turn + 1}-${tool + 1}-${kind}`),
              tone: "tool",
              kind,
              summary: `${name} ${random.pick(WORDS)}`,
              payload: {
                itemType: "command_execution",
                title: name,
                detail: kind === "tool.completed" ? sentence(random, 12) : undefined,
              },
              turnId,
              createdAt,
            },
            createdAt,
          });
        }
      }
      const input = random.int(2_000, 60_000);
      const output = random.int(200, 6_000);
      const usageAt = tick(100, 2_000);
      await dispatch({
        type: "thread.activity.append",
        threadId,
        activity: {
          id: EventId.make(`fixture-usage-${index + 1}-${turn + 1}`),
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload: {
            usedTokens: input + output,
            maxTokens: 400_000,
            lastInputTokens: input,
            lastOutputTokens: output,
            lastCachedInputTokens: Math.floor(input * 0.6),
            lastUsedTokens: input + output,
          },
          turnId,
          createdAt: usageAt,
        },
        createdAt: usageAt,
      });
      const assistantMessageId = MessageId.make(`fixture-assistant-${index + 1}-${turn + 1}`);
      await dispatch({
        type: "thread.message.assistant.complete",
        threadId,
        messageId: assistantMessageId,
        text: paragraph(random, random.int(3, 14)),
        turnId,
        createdAt: tick(1_000, 10_000),
      });
      const files = Array.from({ length: random.int(0, 6) }, (_, file) => ({
        path: `src/${random.pick(WORDS)}/${random.pick(WORDS)}-${file}.ts`,
        kind: random.pick(["modified", "added", "deleted"] as const),
        additions: random.int(0, 120),
        deletions: random.int(0, 60),
      }));
      const completedAt = tick(500, 3_000);
      await dispatch({
        type: "thread.turn.diff.complete",
        threadId,
        turnId,
        completedAt,
        checkpointRef: CheckpointRef.make(`refs/ryco/checkpoints/${threadId}/turn/${turn + 1}`),
        status: "ready",
        files,
        assistantMessageId,
        checkpointTurnCount: turn + 1,
        createdAt: completedAt,
      });
      tick(100, 1_000);
      await dispatch({
        type: "thread.session.set",
        threadId,
        session: session("ready", null),
        createdAt: new Date(clockMs).toISOString(),
      });
      if (turn === 0 && random.next() < 0.15) {
        const planAt = tick(100, 1_000);
        await dispatch({
          type: "thread.proposed-plan.upsert",
          threadId,
          proposedPlan: {
            id: `fixture-plan-${index + 1}`,
            turnId,
            planMarkdown: `# Plan\n\n${paragraph(random, random.int(4, 12))}`,
            implementedAt: null,
            implementationThreadId: null,
            createdAt: planAt,
            updatedAt: planAt,
          },
          createdAt: planAt,
        });
      }
    }
    if (random.next() < options.archivedShare) {
      archivedThreads += 1;
      await dispatch({ type: "thread.archive", threadId });
    }
  }

  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  await runtime.runPromise(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
  const [worktreeRow] = await runtime.runPromise(
    sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM projection_worktrees`,
  );
  await runtime.dispose();
  return {
    dbPath,
    projects: options.projects,
    threads: options.threads,
    archivedThreads,
    worktrees: worktreeRow?.count ?? 0,
    turns: turnCount,
    commands,
    durationMs: Math.round(performance.now() - startedAt),
    dbBytes: statSync(dbPath).size,
  };
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      projects: { type: "string", default: "30" },
      threads: { type: "string", default: "2000" },
      turns: { type: "string", default: "4" },
      archived: { type: "string", default: "0.6" },
      seed: { type: "string", default: "1" },
    },
  });
  if (!values.out) {
    console.error("Usage: node apps/server/scripts/generate-fixture-home.ts --out <dir> [...]");
    process.exit(2);
  }
  const summary = await generateFixtureHome({
    out: values.out,
    projects: Number(values.projects),
    threads: Number(values.threads),
    turns: Number(values.turns),
    archivedShare: Number(values.archived),
    seed: Number(values.seed),
  });
  console.log(JSON.stringify(summary, null, 2));
}
