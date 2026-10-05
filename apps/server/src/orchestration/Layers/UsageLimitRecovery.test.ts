import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ServerProvider,
  type ThreadUsageLimit,
} from "@ryco/contracts";
import { usageLimitIdForTurn, usageLimitResumeIds } from "@ryco/shared/usageLimit";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import {
  makeUsageLimitRecovery,
  planUsageLimitRecovery,
  type UsageLimitRecoveryCandidate,
  type UsageLimitRecoveryDeps,
} from "./UsageLimitRecovery.ts";

const NOW_MS = Date.parse("2026-10-04T16:00:00.000Z");
const LIMITED_AT = "2026-10-04T10:00:00.000Z";
const RESET_AT = "2026-10-04T15:00:00.000Z";
const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");

function limitFor(threadId: string, overrides: Partial<ThreadUsageLimit> = {}): ThreadUsageLimit {
  return {
    limitId: usageLimitIdForTurn(threadId, "turn-1"),
    provider: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: claude,
    turnId: TurnId.make("turn-1"),
    message: "Claude usage limit reached.",
    limitedAt: LIMITED_AT,
    resetAt: RESET_AT,
    autoResume: null,
    updatedAt: LIMITED_AT,
    ...overrides,
  };
}

function shell(
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    title: id,
    modelSelection: { instanceId: claude, model: "claude-sonnet-4-5" },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    goal: null,
    createdAt: LIMITED_AT,
    updatedAt: LIMITED_AT,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: LIMITED_AT,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    usageLimit: limitFor(id),
    ...overrides,
  };
}

const candidate = (
  thread: OrchestrationThreadShell,
  delegatedReturnTerminal = false,
): UsageLimitRecoveryCandidate => ({ thread, delegatedReturnTerminal });

const plan = (
  candidates: ReadonlyArray<UsageLimitRecoveryCandidate>,
  options: {
    readonly autoResume?: boolean;
    readonly snooze?: boolean;
    readonly enabled?: ReadonlyArray<ProviderInstanceId>;
    readonly attempted?: ReadonlyArray<string>;
    readonly nowMs?: number;
  } = {},
) =>
  planUsageLimitRecovery({
    candidates,
    settings: {
      autoResumeLimitedThreads: options.autoResume ?? true,
      snoozeLimitedThreads: options.snooze ?? false,
    },
    enabledInstanceIds: new Set(options.enabled ?? [claude]),
    attempted: new Set(options.attempted ?? []),
    nowMs: options.nowMs ?? NOW_MS,
  });

describe("planUsageLimitRecovery", () => {
  it("follows the node setting while a limit is pending and lets an override win", () => {
    const pending = candidate(shell("thread-a"));
    expect(plan([pending], { autoResume: true }).map((action) => action.kind)).toEqual(["resume"]);
    expect(plan([pending], { autoResume: false })).toEqual([]);
    const optedOut = candidate(
      shell("thread-a", { usageLimit: limitFor("thread-a", { autoResume: false }) }),
    );
    expect(plan([optedOut], { autoResume: true })).toEqual([]);
    const optedIn = candidate(
      shell("thread-a", { usageLimit: limitFor("thread-a", { autoResume: true }) }),
    );
    expect(plan([optedIn], { autoResume: false }).map((action) => action.kind)).toEqual(["resume"]);
  });

  it("builds a guarded continuation with the shared resume identity", () => {
    const [action] = plan([candidate(shell("thread-a"))]);
    expect(action?.kind).toBe("resume");
    if (action?.kind !== "resume") return;
    const ids = usageLimitResumeIds(limitFor("thread-a").limitId);
    expect(action.command).toMatchObject({
      type: "thread.turn.start",
      commandId: ids.commandId,
      threadId: "thread-a",
      message: { messageId: ids.messageId, text: "Continue where you left off." },
      modelSelection: { instanceId: claude },
      usageLimitResumeGuard: { limitId: limitFor("thread-a").limitId, origin: "auto" },
    });
  });

  it("resumes one thread per provider instance per sweep, oldest limit first", () => {
    const older = candidate(
      shell("thread-older", {
        usageLimit: limitFor("thread-older", { limitedAt: "2026-10-04T09:00:00.000Z" }),
      }),
    );
    const newer = candidate(shell("thread-newer"));
    const actions = plan([newer, older]);
    expect(actions.map((action) => action.threadId)).toEqual(["thread-older"]);
  });

  it("snoozes until the reset with a deterministic command id", () => {
    const beforeReset = Date.parse(RESET_AT) - 3_600_000;
    const [action] = plan([candidate(shell("thread-a"))], {
      snooze: true,
      autoResume: false,
      nowMs: beforeReset,
    });
    expect(action).toEqual({
      kind: "snooze",
      threadId: "thread-a",
      command: {
        type: "thread.snooze",
        commandId: `usage-limit-snooze:${limitFor("thread-a").limitId}:${Date.parse(RESET_AT)}`,
        threadId: "thread-a",
        snoozedUntil: RESET_AT,
      },
    });
    const snoozed = candidate(shell("thread-a", { snoozedUntil: RESET_AT }));
    expect(plan([snoozed], { snooze: true, autoResume: false, nowMs: beforeReset })).toEqual([]);
  });

  it("plans the reset lookup once per limit", () => {
    const unknown = candidate(
      shell("thread-a", { usageLimit: limitFor("thread-a", { resetAt: null }) }),
    );
    const nowMs = Date.parse(LIMITED_AT) + 60_000;
    expect(plan([unknown], { nowMs }).map((action) => action.kind)).toEqual(["fill-reset"]);
    expect(
      plan([unknown], {
        nowMs,
        attempted: [`usage-limit-reset:${limitFor("thread-a").limitId}`],
      }),
    ).toEqual([]);
  });

  it("skips terminal delegated children, disabled instances and other instances", () => {
    expect(plan([candidate(shell("thread-a"), true)])).toEqual([]);
    expect(plan([candidate(shell("thread-a"))], { enabled: [codex] })).toEqual([]);
    expect(
      plan([
        candidate(shell("thread-a", { modelSelection: { instanceId: codex, model: "gpt-5.4" } })),
      ]),
    ).toEqual([]);
  });
});

function fakeDeps(
  overrides: Partial<UsageLimitRecoveryDeps<Error>> = {},
): UsageLimitRecoveryDeps<Error> {
  // The sweep reads the real clock: the limit reset an hour ago.
  const thread = shell("thread-a", {
    usageLimit: limitFor("thread-a", {
      limitedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      resetAt: new Date(Date.now() - 3_600_000).toISOString(),
    }),
  });
  return {
    listLimitedThreadIds: () => Effect.succeed([thread.id]),
    getThreadShell: () => Effect.succeed(Option.some(thread)),
    getDelegatedReturnStatus: () => Effect.succeed(undefined),
    getSettings: Effect.succeed({ autoResumeLimitedThreads: true, snoozeLimitedThreads: false }),
    getProviders: Effect.succeed([
      { instanceId: claude, enabled: true } as unknown as ServerProvider,
    ]),
    refreshInstance: () => Effect.succeed([]),
    apply: () => Effect.succeed({ sequence: 1 }),
    dispatchInternal: () => Effect.succeed({ sequence: 1 }),
    ...overrides,
  };
}

const runSweeps = (deps: UsageLimitRecoveryDeps<Error>, sweeps: number) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const recovery = yield* makeUsageLimitRecovery(deps);
      for (let index = 0; index < sweeps; index += 1) yield* recovery.sweep();
    }),
  );

describe("makeUsageLimitRecovery", () => {
  it("retries a transient dispatch failure at most five times", async () => {
    let calls = 0;
    await runSweeps(
      fakeDeps({
        apply: () => {
          calls += 1;
          return Effect.fail(
            new OrchestrationDispatchCommandError({
              message: "storage busy",
              cause: new Error("SQLITE_BUSY"),
            }),
          );
        },
      }),
      8,
    );
    expect(calls).toBe(5);
  });

  it("never retries a rejected resume", async () => {
    let calls = 0;
    await runSweeps(
      fakeDeps({
        apply: () => {
          calls += 1;
          return Effect.fail(
            new OrchestrationDispatchCommandError({
              message: "stale",
              cause: new OrchestrationCommandInvariantError({
                commandType: "thread.turn.start",
                detail: "stale",
              }),
            }),
          );
        },
      }),
      3,
    );
    expect(calls).toBe(1);
  });

  it("keeps sweeping after a defect", async () => {
    let settingsReads = 0;
    let applied = 0;
    await runSweeps(
      fakeDeps({
        getSettings: Effect.suspend(() => {
          settingsReads += 1;
          return settingsReads === 1
            ? Effect.die(new Error("boom"))
            : Effect.succeed({ autoResumeLimitedThreads: true, snoozeLimitedThreads: false });
        }),
        apply: () => {
          applied += 1;
          return Effect.succeed({ sequence: 1 });
        },
      }),
      2,
    );
    expect(settingsReads).toBe(2);
    expect(applied).toBe(1);
  });

  it("fills an unknown reset from the provider probe through the internal record", async () => {
    const recentLimit = limitFor("thread-a", {
      resetAt: null,
      limitedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
    const dispatched: OrchestrationCommand[] = [];
    let probes = 0;
    await runSweeps(
      fakeDeps({
        getThreadShell: () =>
          Effect.succeed(Option.some(shell("thread-a", { usageLimit: recentLimit }))),
        refreshInstance: () => {
          probes += 1;
          return Effect.succeed([
            {
              instanceId: claude,
              enabled: true,
              rateLimits: { primary: { usedPercent: 100, resetsAt } },
            } as unknown as ServerProvider,
          ]);
        },
        dispatchInternal: (command) => {
          dispatched.push(command);
          return Effect.succeed({ sequence: 1 });
        },
      }),
      3,
    );
    expect(probes).toBe(1);
    expect(dispatched).toMatchObject([
      {
        type: "thread.usage-limit.record",
        commandId: `usage-limit-reset:${recentLimit.limitId}`,
        limitId: recentLimit.limitId,
        resetAt: new Date(resetsAt * 1000).toISOString(),
      },
    ]);
  });
});

describe("usage-limit recovery against the engine", () => {
  async function createSystem() {
    const layer = Layer.mergeAll(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(OrchestrationProjectionPipelineLive),
      ),
      OrchestrationProjectionSnapshotQueryLive,
      ProjectionThreadRepositoryLive,
    ).pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(
        Layer.succeed(ProjectAvatarStore, {
          write: () => Effect.die("not implemented"),
          read: () => Effect.succeed(null),
          remove: () => Effect.void,
        }),
      ),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolverLive),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-usage-limit-" })),
      Layer.provideMerge(NodeServices.layer),
    );
    const runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshots = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const threads = await runtime.runPromise(Effect.service(ProjectionThreadRepository));
    const dispatch = (command: OrchestrationCommand) =>
      runtime.runPromise(engine.dispatch(command));
    const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
    const hour = 3_600_000;
    await dispatch({
      type: "project.create",
      commandId: CommandId.make("project-create"),
      projectId: ProjectId.make("project-1"),
      title: "Limits",
      workspaceRoot: "/tmp/ryco-usage-limit-recovery",
      defaultModelSelection: { instanceId: claude, model: "claude-sonnet-4-5" },
      createdAt: at(-3 * hour),
    });

    async function seedLimited(id: string) {
      const threadId = ThreadId.make(id);
      const turnId = TurnId.make(`${id}-turn`);
      const session = {
        threadId,
        status: "running" as const,
        providerName: "claudeAgent",
        providerInstanceId: claude,
        runtimeSessionId: RuntimeSessionId.make(`${id}-runtime`),
        runtimeMode: "full-access" as const,
        activeTurnId: turnId,
        lastError: null,
        updatedAt: at(-2 * hour),
      };
      const commands: OrchestrationCommand[] = [
        {
          type: "thread.create",
          commandId: CommandId.make(`${id}-create`),
          threadId,
          projectId: ProjectId.make("project-1"),
          title: id,
          modelSelection: { instanceId: claude, model: "claude-sonnet-4-5" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: at(-3 * hour),
        },
        {
          type: "thread.turn.start",
          commandId: CommandId.make(`${id}-start`),
          threadId,
          message: {
            messageId: MessageId.make(`${id}-message`),
            role: "user",
            text: "Work",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: at(-3 * hour),
        },
        {
          type: "thread.session.set",
          commandId: CommandId.make(`${id}-running`),
          threadId,
          session,
          createdAt: at(-2 * hour),
        },
        {
          type: "thread.session.set",
          commandId: CommandId.make(`${id}-limited`),
          threadId,
          session: { ...session, status: "error", activeTurnId: null, lastError: "Limited" },
          turnOutcome: { turnId, state: "error", reason: "usage-limit" },
          createdAt: at(-2 * hour),
        },
        {
          type: "thread.usage-limit.record",
          commandId: CommandId.make(`${id}-record`),
          threadId,
          limitId: usageLimitIdForTurn(threadId, turnId),
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claude,
          turnId,
          message: "Claude usage limit reached.",
          resetAt: at(-hour),
          createdAt: at(-2 * hour),
        },
      ];
      for (const command of commands) await dispatch(command);
      return threadId;
    }

    const applied: string[] = [];
    const deps = (
      beforeApply: (command: ClientOrchestrationCommand) => Promise<void> = async () => {},
    ): UsageLimitRecoveryDeps<unknown> => ({
      listLimitedThreadIds: () => threads.listUsageLimitedThreadIds(),
      getThreadShell: (threadId) => snapshots.getThreadShellById(threadId),
      getDelegatedReturnStatus: () => Effect.succeed(undefined),
      getSettings: Effect.succeed({ autoResumeLimitedThreads: true, snoozeLimitedThreads: false }),
      getProviders: Effect.succeed([
        { instanceId: claude, enabled: true } as unknown as ServerProvider,
      ]),
      refreshInstance: () => Effect.succeed([]),
      apply: (command) =>
        Effect.promise(() => beforeApply(command)).pipe(
          Effect.andThen(() => {
            applied.push(`${command.type}:${"threadId" in command ? command.threadId : ""}`);
            return engine.dispatch(command as OrchestrationCommand);
          }),
          Effect.mapError(
            (cause) => new OrchestrationDispatchCommandError({ message: "rejected", cause }),
          ),
        ),
      dispatchInternal: (command) => engine.dispatch(command),
    });
    const sweep = async (recoveryDeps: UsageLimitRecoveryDeps<unknown>, sweeps: number) => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const recovery = yield* makeUsageLimitRecovery(recoveryDeps);
          for (let index = 0; index < sweeps; index += 1) yield* recovery.sweep();
        }),
      );
    };
    const readShell = async (threadId: ThreadId) =>
      Option.getOrUndefined(await runtime.runPromise(snapshots.getThreadShellById(threadId)));
    return { runtime, dispatch, seedLimited, deps, sweep, applied, readShell, at };
  }

  it("marks a resume rejected by an interleaved user send as attempted", async () => {
    const system = await createSystem();
    try {
      const threadId = await system.seedLimited("thread-interleaved");
      const deps = system.deps(async (command) => {
        if (command.type !== "thread.turn.start") return;
        await system.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("user-send"),
          threadId,
          message: {
            messageId: MessageId.make("user-send"),
            role: "user",
            text: "I'm back",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: system.at(0),
        });
      });
      await system.sweep(deps, 3);
      expect(system.applied).toEqual([`thread.turn.start:${threadId}`]);
      const thread = await system.readShell(threadId);
      expect(thread?.usageLimit ?? null).toBeNull();
    } finally {
      await system.runtime.dispose();
    }
  });

  it("resumes live limited threads only, never archived, deleted or settled ones", async () => {
    const system = await createSystem();
    try {
      const live = await system.seedLimited("thread-live");
      const archived = await system.seedLimited("thread-archived");
      const deleted = await system.seedLimited("thread-deleted");
      const settled = await system.seedLimited("thread-settled");
      await system.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive"),
        threadId: archived,
      });
      // Trash hides a thread like deletion did; it must never resume either.
      await system.dispatch({
        type: "thread.trash",
        commandId: CommandId.make("delete"),
        threadId: deleted,
      });
      await system.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle"),
        threadId: settled,
      });
      // Four sweeps: staggering resumes at most one thread per instance per sweep.
      await system.sweep(system.deps(), 4);
      expect(system.applied).toEqual([`thread.turn.start:${live}`]);
      expect((await system.readShell(live))?.usageLimit ?? null).toBeNull();
      expect((await system.readShell(settled))?.usageLimit?.limitId).toBe(
        usageLimitIdForTurn(settled, `${settled}-turn`),
      );
    } finally {
      await system.runtime.dispose();
    }
  });
});
