import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ThreadId,
  TurnId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
} from "@ryco/contracts";
import { Deferred, Effect, Exit, Layer, ManagedRuntime, Option, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadViewers from "../../orchestration/ThreadViewers.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderValidationError } from "../Errors.ts";
import { ProviderSessionReaper } from "../Services/ProviderSessionReaper.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import type { ProviderRuntimeBinding } from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { makeProviderSessionReaperLive } from "./ProviderSessionReaper.ts";

const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };

  return poll();
}

const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;

function makeReadModel(
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly session: {
      readonly threadId: ThreadId;
      readonly status: "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
      readonly providerName: "codex" | "claudeAgent";
      readonly runtimeMode: "approval-required" | "full-access" | "auto-accept-edits";
      readonly activeTurnId: TurnId | null;
      readonly lastError: string | null;
      readonly updatedAt: string;
    } | null;
    readonly backgroundLiveness?: "working" | "monitoring" | null;
  }>,
) {
  const now = new Date().toISOString();
  const projectId = ProjectId.make("project-provider-session-reaper");

  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [
      {
        id: projectId,
        title: "Provider Reaper Project",
        workspaceRoot: "/tmp/provider-reaper-project",
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: threads.map((thread) => ({
      id: thread.id,
      projectId,
      title: `Thread ${thread.id}`,
      modelSelection: defaultModelSelection,
      interactionMode: "default" as const,
      runtimeMode: "full-access" as const,
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      latestTurn: null,
      messages: [],
      session: thread.session,
      backgroundLiveness: thread.backgroundLiveness ?? null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    })),
  };
}

describe("ProviderSessionReaper", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    ProviderSessionReaper | ProviderSessionRuntimeRepository,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  async function createHarness(input: {
    readonly readModel: ReturnType<typeof makeReadModel>;
    readonly stopSessionImplementation?: (input: {
      readonly threadId: ThreadId;
    }) => ReturnType<ProviderServiceShape["stopSession"]>;
    readonly staleBindings?: ReadonlyArray<ProviderRuntimeBinding>;
    /** Threads a client views (counted through the real viewer registry). */
    readonly viewedThreadIds?: ReadonlyArray<ThreadId>;
    readonly maxViewedIdleSessions?: number;
  }) {
    const stoppedThreadIds = new Set<ThreadId>();
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(
      (request) =>
        (input.stopSessionImplementation
          ? input.stopSessionImplementation(request)
          : Effect.sync(() => {
              stoppedThreadIds.add(request.threadId);
            })) as ReturnType<ProviderServiceShape["stopSession"]>,
    );
    const stopSessionBinding = vi.fn<ProviderServiceShape["stopSessionBinding"]>(() =>
      Effect.succeed("stopped"),
    );

    const providerService: ProviderServiceShape = {
      startSession: () => unsupported(),
      startFreshSession: () => unsupported(),
      getSession: () => Effect.succeed(Option.none()),
      restoreSessionBinding: () => Effect.succeed(false),
      retireSessionBinding: () => Effect.succeed(false),
      stopSessionBinding,
      listStaleSessionBindings: () => Effect.succeed(input.staleBindings ?? []),
      sendTurn: () => unsupported(),
      steerTurn: () => unsupported(),
      interruptTurn: () => unsupported(),
      stopBackgroundTask: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession,
      listSessions: () => Effect.succeed([]),
      getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
      getInstanceInfo: (instanceId) => {
        const driverKind = ProviderDriverKind.make(String(instanceId));
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey: `${driverKind}:instance:${instanceId}`,
          },
        });
      },
      rollbackConversation: () => unsupported(),
      streamEvents: Stream.empty,
    };

    const getThreadShellById = vi.fn((threadId: ThreadId) =>
      Effect.sync(() =>
        Option.fromNullishOr(input.readModel.threads.find((thread) => thread.id === threadId)),
      ),
    );

    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(runtimeRepositoryLayer),
    );
    const viewers = ThreadViewers.make();
    // Held for the whole test: these threads stay viewed.
    const viewerLeases = (input.viewedThreadIds ?? []).map((threadId) =>
      Effect.runSync(viewers.retain(threadId)),
    );
    const layer = makeProviderSessionReaperLive({
      inactivityThresholdMs: 1_000,
      sweepIntervalMs: 60_000,
      viewedInactivityThresholdMs: 60_000,
      ...(input.maxViewedIdleSessions !== undefined
        ? { maxViewedIdleSessions: input.maxViewedIdleSessions }
        : {}),
    }).pipe(
      Layer.provideMerge(Layer.succeed(ThreadViewers.ThreadViewersService, viewers)),
      Layer.provideMerge(providerSessionDirectoryLayer),
      Layer.provideMerge(runtimeRepositoryLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () =>
            Effect.succeed({ snapshotSequence: input.readModel.snapshotSequence }),
          getCounts: () => Effect.die("unused"),
          getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
          getProjectShellById: () => Effect.die("unused"),
          getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
          getThreadCheckpointContext: () => Effect.die("unused"),
          getThreadShellById,
          getThreadDetailById: () => Effect.die("unused"),
          searchThreadMessages: () => Effect.die("unused"),
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    return { stopSession, stopSessionBinding, stoppedThreadIds, viewerLeases, getThreadShellById };
  }

  it("retries exact stale instance/runtime bindings before inactivity cleanup", async () => {
    const threadId = ThreadId.make("thread-reaper-stale-epoch");
    const staleBinding: ProviderRuntimeBinding = {
      threadId,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeSessionId: RuntimeSessionId.make("runtime-reaper-stale-epoch"),
      runtimeMode: "full-access",
      status: "running",
    };
    const harness = await createHarness({
      readModel: makeReadModel([]),
      staleBindings: [staleBinding],
    });

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => harness.stopSessionBinding.mock.calls.length === 1);
    expect(harness.stopSessionBinding.mock.calls[0]).toEqual([staleBinding]);
    expect(harness.stopSession.mock.calls).toHaveLength(0);
  });

  it("keeps the idle sessions of a few viewed threads, and reaps the rest", async () => {
    const at = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();
    const threads = {
      viewedRecent: ThreadId.make("thread-reaper-viewed-recent"),
      viewedOlder: ThreadId.make("thread-reaper-viewed-older"),
      viewedForgotten: ThreadId.make("thread-reaper-viewed-forgotten"),
      unviewed: ThreadId.make("thread-reaper-unviewed"),
    };
    const lastSeen = {
      [threads.viewedRecent]: at(5_000),
      [threads.viewedOlder]: at(10_000),
      [threads.viewedForgotten]: "2026-04-14T00:00:00.000Z",
      [threads.unviewed]: at(5_000),
    };
    const harness = await createHarness({
      readModel: makeReadModel(
        Object.values(threads).map((threadId) => ({
          id: threadId,
          session: {
            threadId,
            status: "ready" as const,
            providerName: "claudeAgent" as const,
            runtimeMode: "full-access" as const,
            activeTurnId: null,
            lastError: null,
            updatedAt: new Date().toISOString(),
          },
        })),
      ),
      viewedThreadIds: [threads.viewedRecent, threads.viewedOlder, threads.viewedForgotten],
      maxViewedIdleSessions: 1,
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));
    for (const threadId of Object.values(threads)) {
      await runtime!.runPromise(
        repository.upsert({
          threadId,
          providerName: "claudeAgent",
          providerInstanceId: null,
          adapterKey: "claudeAgent",
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt: lastSeen[threadId]!,
          resumeCursor: { opaque: `resume-${threadId}` },
          runtimePayload: null,
        }),
      );
    }

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => harness.stopSession.mock.calls.length === 3);
    // Let the sweep finish: a fourth stop would land now.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.stopSession).toHaveBeenCalledTimes(3);
    // Unviewed: the usual threshold. Viewed: kept, but only the most recent one (the cap),
    // and never past the viewed idle limit.
    expect([...harness.stoppedThreadIds].toSorted()).toEqual(
      [threads.unviewed, threads.viewedOlder, threads.viewedForgotten].toSorted(),
    );
    expect(harness.stopSession).not.toHaveBeenCalledWith({ threadId: threads.viewedRecent });
  });

  it("does not stop a session whose thread started a turn while earlier sessions stopped", async () => {
    const first = ThreadId.make("thread-reaper-race-first");
    const second = ThreadId.make("thread-reaper-race-second");
    const now = new Date().toISOString();
    const readModel = makeReadModel(
      [first, second].map((threadId) => ({
        id: threadId,
        session: {
          threadId,
          status: "ready" as const,
          providerName: "claudeAgent" as const,
          runtimeMode: "full-access" as const,
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
      })),
    );
    const releaseFirstStop = Effect.runSync(Deferred.make<void>());
    const harness = await createHarness({
      readModel,
      stopSessionImplementation: (request) =>
        request.threadId === first ? Deferred.await(releaseFirstStop) : Effect.void,
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));
    for (const [threadId, lastSeenAt] of [
      [first, "2026-04-14T00:00:00.000Z"],
      [second, "2026-04-14T00:01:00.000Z"],
    ] as const) {
      await runtime!.runPromise(
        repository.upsert({
          threadId,
          providerName: "claudeAgent",
          providerInstanceId: null,
          adapterKey: "claudeAgent",
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt,
          resumeCursor: { opaque: `resume-${threadId}` },
          runtimePayload: null,
        }),
      );
    }

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    // Both were idle when the sweep looked; the first stop is still running when the user
    // sends a turn on the second thread.
    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    expect(harness.stopSession.mock.calls[0]?.[0]).toEqual({ threadId: first });
    readModel.threads[1]!.session = {
      ...readModel.threads[1]!.session!,
      status: "running",
      activeTurnId: TurnId.make("turn-reaper-race-second"),
    };
    Effect.runSync(Deferred.succeed(releaseFirstStop, undefined));
    // Either the second thread was checked again (and kept), or it was stopped.
    await waitFor(
      () =>
        harness.getThreadShellById.mock.calls.length === 4 ||
        harness.stopSession.mock.calls.length === 2,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.stopSession).toHaveBeenCalledTimes(1);
  });

  it("reaps stale persisted sessions without active turns", async () => {
    const threadId = ThreadId.make("thread-reaper-stale");
    const now = new Date().toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-stale",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => harness.stopSession.mock.calls.length === 1);

    expect(harness.stopSession.mock.calls[0]?.[0]).toEqual({ threadId });
    expect(harness.stoppedThreadIds.has(threadId)).toBe(true);
  });

  it("skips stale sessions when the thread still has an active turn", async () => {
    const threadId = ThreadId.make("thread-reaper-active-turn");
    const turnId = TurnId.make("turn-reaper-active");
    const now = new Date().toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-active-turn",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("skips stale sessions while background work is still live", async () => {
    const threadId = ThreadId.make("thread-reaper-background-work");
    const now = new Date().toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          backgroundLiveness: "working",
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-background-work",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("does not reap sessions that are still within the inactivity threshold", async () => {
    const threadId = ThreadId.make("thread-reaper-fresh");
    const now = new Date().toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: now,
        resumeCursor: {
          opaque: "resume-fresh",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("skips persisted sessions that are already marked stopped", async () => {
    const threadId = ThreadId.make("thread-reaper-stopped");
    const now = new Date().toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "stopped",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "stopped",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-stopped",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("continues reaping other sessions when one stop attempt fails", async () => {
    const failedThreadId = ThreadId.make("thread-reaper-stop-failure");
    const reapedThreadId = ThreadId.make("thread-reaper-stop-success");
    const now = new Date().toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: failedThreadId,
          session: {
            threadId: failedThreadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
        {
          id: reapedThreadId,
          session: {
            threadId: reapedThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      stopSessionImplementation: (request) =>
        request.threadId === failedThreadId
          ? Effect.fail(
              new ProviderValidationError({
                operation: "ProviderSessionReaper.test",
                issue: "simulated stop failure",
              }),
            )
          : Effect.void,
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId: failedThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-failure",
        },
        runtimePayload: null,
      }),
    );
    await runtime!.runPromise(
      repository.upsert({
        threadId: reapedThreadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:01:00.000Z",
        resumeCursor: {
          opaque: "resume-success",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => harness.stopSession.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.map(([request]) => request.threadId)).toEqual([
      failedThreadId,
      reapedThreadId,
    ]);
  });

  it("continues reaping other sessions when one stop attempt defects", async () => {
    const defectThreadId = ThreadId.make("thread-reaper-stop-defect");
    const reapedThreadId = ThreadId.make("thread-reaper-stop-after-defect");
    const now = new Date().toISOString();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: defectThreadId,
          session: {
            threadId: defectThreadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
        {
          id: reapedThreadId,
          session: {
            threadId: reapedThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      stopSessionImplementation: (request) =>
        request.threadId === defectThreadId
          ? Effect.die(new Error("simulated stop defect"))
          : Effect.void,
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderSessionRuntimeRepository));

    await runtime!.runPromise(
      repository.upsert({
        threadId: defectThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-defect",
        },
        runtimePayload: null,
      }),
    );
    await runtime!.runPromise(
      repository.upsert({
        threadId: reapedThreadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:01:00.000Z",
        resumeCursor: {
          opaque: "resume-after-defect",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => harness.stopSession.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.map(([request]) => request.threadId)).toEqual([
      defectThreadId,
      reapedThreadId,
    ]);
  });
});
