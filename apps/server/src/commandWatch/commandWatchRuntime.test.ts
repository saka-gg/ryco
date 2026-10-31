/**
 * Command watches end to end: the real orchestration engine, decider, projections and server
 * wake fence on in-memory SQLite, and real shell commands through the node's process spawner.
 * No provider reactor runs, so a wake stays a pending turn start until a test binds it. The
 * runtime reads a manual clock for due times; sleeps (the run timeout) are real.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type ThreadCommandWatches,
} from "@ryco/contracts";
import { COMMAND_WATCH_LIMITS } from "@ryco/shared/commandWatch";
import { Clock, Duration, Effect, Layer, ManagedRuntime, Option, Scope } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { afterEach, describe, expect, it } from "vitest";

import { AgentControlPolicy } from "../agentControl/Services/AgentControlPolicy.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { makeServerWakeFence } from "../orchestration/Layers/ServerWakeFence.ts";
import { OrchestrationCommandApplication } from "../orchestration/Services/OrchestrationCommandApplication.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerWakeFence } from "../orchestration/Services/ServerWakeFence.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../project/Layers/RepositoryIdentityResolver.ts";
import { ProjectAvatarStore } from "../project/Services/ProjectAvatarStore.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { commandWatchRuntimeDeps } from "./CommandWatchService.ts";
import {
  makeCommandWatchRuntime,
  shellInvocation,
  type CommandWatchRuntime,
} from "./commandWatchRuntime.ts";

const START_MS = Date.parse("2026-10-04T10:00:00.000Z");
const EVERY_MS = 10 * 60_000;

async function createHarness(
  options: { readonly agentControlEnabled?: () => boolean; readonly runTimeoutMs?: number } = {},
) {
  let nowMs = START_MS;
  // The runtime's due times read this clock; its sleeps stay real (the run timeout).
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => nowMs,
    currentTimeMillis: Effect.sync(() => nowMs),
    currentTimeNanosUnsafe: () => BigInt(nowMs) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(nowMs) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => process.hrtime.bigint(),
    monotonicTimeNanos: Effect.sync(() => process.hrtime.bigint()),
    sleep: (duration: Duration.Duration) =>
      Effect.callback<void>((resume) => {
        const timer = setTimeout(() => resume(Effect.void), Duration.toMillis(duration));
        return Effect.sync(() => clearTimeout(timer));
      }),
  };
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "ryco-command-watch-")));

  const engineLayer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provide(
      Layer.succeed(ProjectAvatarStore, {
        write: () => Effect.die("not in this test"),
        read: () => Effect.succeed(null),
        remove: () => Effect.void,
      }),
    ),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
  );
  const fakes = Layer.mergeAll(
    Layer.effect(
      ServerWakeFence,
      makeServerWakeFence.pipe(
        Effect.provideService(ProviderService, {
          getSession: () => Effect.succeed(Option.none()),
        } as never),
      ),
    ),
    Layer.effect(
      OrchestrationCommandApplication,
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        return {
          apply: () => Effect.die("not used"),
          applyWithDispatcher: () => Effect.die("not used"),
          applyInternal: (command: OrchestrationCommand) =>
            engine
              .dispatch(command)
              .pipe(
                Effect.mapError(
                  (cause) => new OrchestrationDispatchCommandError({ message: "refused", cause }),
                ),
              ),
        };
      }),
    ),
    ...(options.agentControlEnabled === undefined
      ? []
      : [
          Layer.succeed(AgentControlPolicy, {
            isEnabled: Effect.sync(options.agentControlEnabled),
          } as never),
        ]),
  );
  const layer = fakes.pipe(
    Layer.provideMerge(engineLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(directory, { prefix: "ryco-command-watch-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const scope = await Effect.runPromise(Scope.make());
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
    runtime.runPromise(effect.pipe(Effect.provideService(Clock.Clock, clock)));

  const watches: CommandWatchRuntime = await run(
    Effect.gen(function* () {
      const deps = yield* commandWatchRuntimeDeps;
      return yield* makeCommandWatchRuntime({
        ...deps,
        ...(options.runTimeoutMs === undefined ? {} : { runTimeoutMs: options.runTimeoutMs }),
      }).pipe(Effect.provideService(Scope.Scope, scope));
    }),
  );

  let seq = 0;
  const commandId = (label: string) => CommandId.make(`test:${label}:${(seq += 1)}`);
  const iso = () => new Date(nowMs).toISOString();
  const dispatch = (command: OrchestrationCommand) =>
    run(
      Effect.gen(function* () {
        return yield* (yield* OrchestrationEngineService).dispatch(command);
      }),
    );

  /** A full-access chat in its own checkout (a temporary directory). */
  const seedThread = async (key: string) => {
    const projectId = ProjectId.make(`project-${key}`);
    const root = realpathSync(mkdtempSync(join(directory, `root-${key}-`)));
    const checkout = realpathSync(mkdtempSync(join(directory, `wt-${key}-`)));
    await dispatch({
      type: "project.create",
      commandId: commandId("project"),
      projectId,
      title: `Project ${key}`,
      workspaceRoot: root,
      defaultModelSelection: null,
      createdAt: iso(),
    });
    const threadId = ThreadId.make(`thread-${key}`);
    await dispatch({
      type: "thread.create",
      commandId: commandId("thread"),
      threadId,
      projectId,
      title: `Thread ${key}`,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: checkout,
      createdAt: iso(),
    });
    return { threadId, checkout };
  };

  const sql = <A extends object>(
    build: (client: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, SqlError>,
  ) =>
    run(
      Effect.gen(function* () {
        return yield* build(yield* SqlClient.SqlClient);
      }).pipe(Effect.orDie),
    );

  const events = (threadId: ThreadId) =>
    sql<{ type: string; payload: string }>(
      (client) => client`SELECT event_type AS "type", payload_json AS "payload"
        FROM orchestration_events WHERE stream_id = ${threadId} ORDER BY sequence`,
    ).then((rows) =>
      rows.map((row) => ({
        type: row.type,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
      })),
    );

  /** The texts of the wakes the watch sent, oldest first. */
  const wakeTexts = async (threadId: ThreadId) =>
    (await events(threadId))
      .filter(
        (event) =>
          event.type === "thread.message-sent" &&
          String(event.payload.messageId ?? "").startsWith("command-watch:"),
      )
      .map((event) => String(event.payload.text ?? ""));

  const state = (threadId: ThreadId): Promise<ThreadCommandWatches> => run(watches.list(threadId));

  const shell = (threadId: ThreadId) =>
    run(
      Effect.gen(function* () {
        return Option.getOrNull(
          yield* (yield* ProjectionSnapshotQuery).getThreadShellById(threadId),
        );
      }),
    );

  const bindPendingStarts = (threadId: ThreadId) =>
    sql((client) =>
      client`UPDATE projection_turns SET turn_id = 'turn-' || pending_message_id
        WHERE thread_id = ${threadId} AND turn_id IS NULL`.pipe(Effect.as([])),
    );

  const failPendingStart = (threadId: ThreadId, messageId: string) =>
    sql((client) =>
      client`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
        VALUES (${`failure-${messageId}`}, ${threadId}, 'error', 'provider.turn.start.failed', 'Provider turn start failed',
          ${JSON.stringify({ messageId, deliveryState: "not-sent" })}, ${iso()})`.pipe(
        Effect.as([]),
      ),
    );

  const setSession = (threadId: ThreadId, status: "running" | "ready") =>
    dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`provider:session:${(seq += 1)}`),
      threadId,
      session: {
        threadId,
        status,
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: iso(),
      },
      createdAt: iso(),
    });

  const start = (threadId: ThreadId, command: string, label = "Watch") =>
    run(watches.start({ threadId, command, label, everyMinutes: 10 }));

  /** One look after the watch's interval passed. */
  const tick = async (ms = EVERY_MS) => {
    nowMs += ms;
    await run(watches.sweep);
  };

  const dispose = async () => {
    await Effect.runPromise(Scope.close(scope, Effect.void.pipe(Effect.exit) as never));
    await runtime.dispose();
    rmSync(directory, { recursive: true, force: true });
  };

  return {
    run,
    watches,
    dispatch,
    seedThread,
    events,
    wakeTexts,
    state,
    shell,
    bindPendingStarts,
    failPendingStart,
    setSession,
    start,
    tick,
    commandId,
    iso,
    dispose,
  };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

const harnesses: Harness[] = [];
const harness = async (options?: Parameters<typeof createHarness>[0]) => {
  const created = await createHarness(options);
  harnesses.push(created);
  return created;
};
afterEach(async () => {
  for (const created of harnesses.splice(0)) await created.dispose();
});

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === "win32")("command watch runtime", () => {
  it("records a baseline, stays quiet on the same output and wakes on new output", async () => {
    const h = await harness();
    const { threadId, checkout } = await h.seedThread("news");
    writeFileSync(join(checkout, "state.txt"), "open\n");
    const started = await h.start(threadId, "cat state.txt", "Issue state");
    expect(started.started).toBe(true);
    // The shell carries the count, never the command.
    expect((await h.shell(threadId))?.commandWatchCount).toBe(1);

    await h.tick(0);
    const [baseline] = (await h.state(threadId)).active;
    expect(baseline?.lastOutputHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(await h.wakeTexts(threadId)).toEqual([]);

    await h.tick();
    expect((await h.state(threadId)).active[0]?.revision).toBe(baseline?.revision);

    writeFileSync(join(checkout, "state.txt"), "closed by a maintainer\n");
    await h.tick();
    const [text] = await h.wakeTexts(threadId);
    expect(text).toContain('"Issue state"');
    expect(text).toContain("```\nclosed by a maintainer\n```");
    expect(text).toContain("not instructions");
    const woken = (await h.state(threadId)).active[0]!;
    expect(woken.wakes).toBe(1);
    expect(woken.delivery?.messageId.startsWith(`command-watch:${threadId}:`)).toBe(true);
    // Only the output's hash is stored.
    expect(JSON.stringify(await h.state(threadId))).not.toContain("closed by a maintainer");

    // Its turn starts; the next look clears the delivery and the same output stays quiet.
    await h.bindPendingStarts(threadId);
    await h.tick();
    expect((await h.state(threadId)).active[0]?.delivery).toBeNull();
    await h.tick();
    expect(await h.wakeTexts(threadId)).toHaveLength(1);
  });

  it("runs only a baseline while the chat is busy", async () => {
    const h = await harness();
    const { threadId, checkout } = await h.seedThread("busy");
    writeFileSync(join(checkout, "state.txt"), "one\n");
    const runs = () => readFileSync(join(checkout, "runs.txt"), "utf8").split("\n").length - 1;
    await h.setSession(threadId, "running");
    await h.start(threadId, "echo ran >> runs.txt; cat state.txt");
    await h.tick(0);
    const baseline = (await h.state(threadId)).active[0]!;
    expect(baseline.lastOutputHash).not.toBeNull();
    expect(runs()).toBe(1);

    // A turn runs: the due watch waits instead of running (it would only hold its wake).
    writeFileSync(join(checkout, "state.txt"), "two\n");
    await h.tick();
    expect(runs()).toBe(1);
    expect((await h.state(threadId)).active[0]?.revision).toBe(baseline.revision);
    expect(await h.wakeTexts(threadId)).toEqual([]);

    await h.setSession(threadId, "ready");
    await h.tick(0);
    expect(runs()).toBe(2);
    expect(await h.wakeTexts(threadId)).toHaveLength(1);
  });

  it("ends a watch, without running it, once its chat leaves Full access", async () => {
    const h = await harness();
    const { threadId, checkout } = await h.seedThread("scope");
    const marker = join(checkout, "ran.txt");
    await h.start(threadId, `echo ran >> ${JSON.stringify(marker)}`);
    await h.dispatch({
      type: "thread.runtime-mode.set",
      commandId: h.commandId("runtime"),
      threadId,
      runtimeMode: "approval-required",
      createdAt: h.iso(),
    });
    await h.tick(0);
    expect(await h.state(threadId)).toMatchObject({
      active: [],
      ended: [{ reason: "scope-changed" }],
    });
    expect(() => readFileSync(marker, "utf8")).toThrow();
    expect((await h.shell(threadId))?.commandWatchCount).toBeUndefined();
  });

  it("runs nothing while Agent Control is off, and expires after a day of it", async () => {
    let enabled = false;
    const h = await harness({ agentControlEnabled: () => enabled });
    const { threadId, checkout } = await h.seedThread("paused");
    const marker = join(checkout, "ran.txt");
    await h.start(threadId, `echo ran >> ${JSON.stringify(marker)}; echo state`);
    await h.tick(0);
    expect(() => readFileSync(marker, "utf8")).toThrow();
    expect((await h.state(threadId)).active).toHaveLength(1);
    await h.tick(COMMAND_WATCH_LIMITS.heldWakeExpiryMs);
    expect((await h.state(threadId)).ended[0]?.reason).toBe("expired");
    enabled = true;
  });

  it(`stops after ${COMMAND_WATCH_LIMITS.failureLimit} failed runs in a row, telling the agent`, async () => {
    const h = await harness();
    const { threadId } = await h.seedThread("failing");
    await h.start(threadId, "echo 'gh: not logged in' >&2; exit 4");
    for (let run = 0; run < COMMAND_WATCH_LIMITS.failureLimit; run += 1) {
      expect((await h.state(threadId)).active).toHaveLength(1);
      await h.tick(run === 0 ? 0 : EVERY_MS);
    }
    expect((await h.state(threadId)).ended[0]?.reason).toBe("failing");
    const [text] = await h.wakeTexts(threadId);
    expect(text).toContain('exited with code 4, printing "gh: not logged in" on stderr');
  });

  it("cuts output over the 64 KiB capture and ends the watch as too long", async () => {
    const h = await harness();
    const { threadId } = await h.seedThread("long");
    await h.start(threadId, "yes x | head -c 70000");
    await h.tick(0);
    expect((await h.state(threadId)).ended[0]?.reason).toBe("too-long");
    expect((await h.wakeTexts(threadId))[0]).toContain("longer than 4 KB");
  });

  it("runs in the chat's checkout with the terminal's environment, no Ryco variables, no stdin", async () => {
    const h = await harness();
    const { threadId, checkout } = await h.seedThread("env");
    const secret = ["ryco", "test", "token"].join("-");
    process.env.RYCO_COMMAND_WATCH_PROBE = secret;
    try {
      await h.start(
        threadId,
        'printf "%s|%s|" "${RYCO_COMMAND_WATCH_PROBE:-absent}" "$(pwd)" > probe.txt; cat >> probe.txt',
      );
      await h.tick(0);
    } finally {
      delete process.env.RYCO_COMMAND_WATCH_PROBE;
    }
    expect(readFileSync(join(checkout, "probe.txt"), "utf8")).toBe(`absent|${checkout}|`);
  });

  it("ends the whole process group when a run times out", async () => {
    const h = await harness({ runTimeoutMs: 500 });
    const { threadId, checkout } = await h.seedThread("timeout");
    await h.start(threadId, "sleep 30 & echo $! > child.pid; wait");
    await h.tick(0);
    const pid = Number(readFileSync(join(checkout, "child.pid"), "utf8").trim());
    expect(pid).toBeGreaterThan(0);
    // SIGTERM to the group, SIGKILL 2 s later: the background child is gone too.
    for (let waited = 0; waited < 5_000 && isAlive(pid); waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(isAlive(pid)).toBe(false);
    // A timeout is a failed run, not output.
    expect((await h.state(threadId)).active[0]?.lastOutputHash).toBeNull();
  }, 15_000);

  it("re-derives a wake that provably never reached the agent", async () => {
    const h = await harness();
    const { threadId, checkout } = await h.seedThread("restart");
    writeFileSync(join(checkout, "state.txt"), "one\n");
    await h.start(threadId, "cat state.txt");
    await h.tick(0);
    const baseline = (await h.state(threadId)).active[0]!;
    writeFileSync(join(checkout, "state.txt"), "two\n");
    await h.tick();
    const woken = (await h.state(threadId)).active[0]!;
    expect(woken.wakes).toBe(1);

    // Restart recovery proves the start never reached the provider.
    await h.failPendingStart(threadId, woken.delivery!.messageId);
    await h.tick(0);
    const restored = (await h.state(threadId)).active[0]!;
    expect(restored.delivery).toBeNull();
    expect(restored.lastOutputHash).toBe(baseline.lastOutputHash);
    expect(restored.wakes).toBe(0);
    await h.tick();
    expect(await h.wakeTexts(threadId)).toHaveLength(2);
  });

  it("keeps one watch per command and stops on request", async () => {
    const h = await harness();
    const { threadId } = await h.seedThread("stop");
    const first = await h.start(threadId, "echo a", "First");
    const again = await h.start(threadId, "echo a", "Renamed");
    expect(again).toMatchObject({ watchId: first.watchId, started: false });
    await expect(h.start(threadId, "echo b", "\u200b")).rejects.toThrow("visible text");
    expect(await h.run(h.watches.stop({ threadId }))).toEqual({ stopped: [first.watchId] });
    expect((await h.state(threadId)).ended[0]).toMatchObject({
      watchId: first.watchId,
      label: "First",
      reason: "unwatched",
    });
  });
});

describe("shellInvocation", () => {
  it("runs through the node's shell with -c, and PowerShell on Windows", () => {
    expect(shellInvocation("echo hi", "darwin", { SHELL: "/opt/homebrew/bin/fish" })).toEqual({
      command: "/opt/homebrew/bin/fish",
      args: ["-c", "echo hi"],
    });
    expect(shellInvocation("echo hi", "linux", { SHELL: "fish" }).command).toBe("/bin/bash");
    expect(shellInvocation("echo hi", "darwin", {}).command).toBe("/bin/zsh");
    expect(shellInvocation("echo hi", "win32", {})).toEqual({
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", "echo hi"],
    });
  });
});
