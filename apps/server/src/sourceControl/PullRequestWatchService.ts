/**
 * The server's pull request watch: it follows a thread's pull request with no client connected
 * and wakes the thread's agent when a check fails, the required checks pass, someone else
 * comments or reviews, or the branch starts to conflict (and, with Auto-fix CI on, starts one
 * bounded fix turn for a failing head). See `docs/pull-request-watch.md`.
 *
 * This module is the thin, always-on part on the boot path: the service tag and a layer that
 * captures the services the watch runs on. The sweep, the read planner, the decision rules and
 * the host-read adapters load through `import()` once commands are admitted (or with the first
 * `setWatch`), so none of them costs boot time.
 *
 * Provided once beneath the runtime services (`server.ts`), so the WebSocket RPC and Agent
 * Control share one instance, one read cache and one per-thread lock.
 *
 * @module PullRequestWatchService
 */
import {
  CommandId,
  PullRequestWatchError,
  type SourceControlSetPullRequestWatchResult,
  type ThreadId,
} from "@ryco/contracts";
import { threadUserAnchorTimestamp } from "@ryco/shared/threadSettlement";
import { isThreadSnoozed } from "@ryco/shared/threadSnooze";
import {
  readWorktreePullRequestLinks,
  resolveThreadPullRequestLink,
} from "@ryco/shared/worktreePullRequests";
import { Context, Duration, Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { AgentControlPolicy } from "../agentControl/Services/AgentControlPolicy.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { logOnceEvery } from "../logOnceEvery.ts";
import {
  makePullRequestWatchRejections,
  pullRequestWatchUpdateCommandId,
  pullRequestWatchWakeMessageId,
} from "../orchestration/pullRequestWatchUpdates.ts";
import { serverWakeGuard, serverWakeInScope } from "../orchestration/serverWake.ts";
import { OrchestrationCommandApplication } from "../orchestration/Services/OrchestrationCommandApplication.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerWakeFence } from "../orchestration/Services/ServerWakeFence.ts";
import { isThreadWaitWakeEvent } from "../orchestration/threadWaitWakeEvents.ts";
import { ProjectionThreadPullRequestWatchRepository } from "../persistence/Services/ProjectionThreadPullRequestWatches.ts";
import { ProjectionWorktreeRepository } from "../persistence/Services/ProjectionWorktrees.ts";
import { inBackgroundProcessLane } from "../processGovernor.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { readCheckoutHead } from "../vcs/gitCheckoutHead.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import {
  changeRequestNumberFromUrl,
  changeRequestRepositoryKey,
} from "./changeRequestRepositoryKey.ts";
import {
  isWrongRepositoryLinkFailure,
  linkPullRequestToWorkspace,
  pullRequestLinkFailure,
} from "./manualPullRequestLink.ts";
import type {
  PullRequestWatchRuntime,
  PullRequestWatchRuntimeDeps,
} from "./pullRequestWatchSweep.ts";
import { refreshWorktreeSourceControlState } from "./refreshWorktreeSourceControlState.ts";
import { SourceControlProviderRegistry } from "./SourceControlProviderRegistry.ts";

/** The first sweep waits this long after commands are admitted, off the shell-load path. */
export const PULL_REQUEST_WATCH_FIRST_SWEEP_DELAY_MS = 30_000;

export interface PullRequestWatchSetInput {
  readonly threadId: ThreadId;
  /** Default: the pull request of the thread's workspace. */
  readonly number?: number | undefined;
  /** A pull request's web URL; names its repository (validated against the checkout). */
  readonly url?: string | undefined;
  /** Start or stop waking the agent with news. */
  readonly news?: boolean | undefined;
  /** Auto-fix CI on or off (the user's switch; an agent may not set it). */
  readonly autoFix?: boolean | undefined;
  /** "user": the client switch; "agent": Agent Control on the agent's behalf. */
  readonly origin: "user" | "agent";
}

/** An agent links a pull request it names to its chat's workspace (`ryco_link_pull_request`). */
export interface PullRequestLinkInput {
  readonly threadId: ThreadId;
  readonly number?: number | undefined;
  readonly url?: string | undefined;
}

export interface PullRequestLinkResult {
  readonly number: number;
  readonly url: string | null;
  readonly title: string | null;
  readonly state: string | null;
  /** It was linked before the call (to this chat's workspace or another of the project's). */
  readonly alreadyLinked: boolean;
}

export interface PullRequestWatchServiceShape {
  /**
   * Start, change or stop a thread's watch. Reads the pull request once (interactive lane)
   * before a watch starts; stopping never needs a read. Idempotent: the same settings again
   * answer with the current state.
   */
  readonly setWatch: (
    input: PullRequestWatchSetInput,
  ) => Effect.Effect<SourceControlSetPullRequestWatchResult, PullRequestWatchError>;
  /** Links a named pull request to the chat's workspace, without watching it. */
  readonly linkPullRequest: (
    input: PullRequestLinkInput,
  ) => Effect.Effect<PullRequestLinkResult, PullRequestWatchError>;
  /** One full pass now (tests, the measurement script). */
  readonly sweep: Effect.Effect<void>;
}

export class PullRequestWatchService extends Context.Service<
  PullRequestWatchService,
  PullRequestWatchServiceShape
>()("ryco/sourceControl/PullRequestWatchService") {}

/**
 * What the lazy runtime runs on: service instances and the boot-path helpers it calls. Handed
 * over instead of imported, so the runtime's chunk imports no boot module (see the note in
 * `pullRequestWatchSweep.ts`).
 */
export const pullRequestWatchRuntimeDeps = Effect.gen(function* () {
  const registry = yield* SourceControlProviderRegistry;
  const gitWorkflow = yield* GitWorkflowService;
  const engine = yield* OrchestrationEngineService;
  // What a workspace refresh reads (the database too, for a checkout found missing).
  const refreshContext = yield* Effect.context<
    | ProjectionWorktreeRepository
    | OrchestrationEngineService
    | SourceControlProviderRegistry
    | SqlClient.SqlClient
  >();
  return {
    commands: yield* OrchestrationCommandApplication,
    engine,
    projections: yield* ProjectionSnapshotQuery,
    watchRows: yield* ProjectionThreadPullRequestWatchRepository,
    worktrees: yield* ProjectionWorktreeRepository,
    registry,
    fence: yield* ServerWakeFence,
    git: yield* GitVcsDriver,
    sql: yield* SqlClient.SqlClient,
    // Agent-started news holds while Agent Control is off; absent in tests and CLI layers.
    policy: Option.getOrUndefined(yield* Effect.serviceOption(AgentControlPolicy)),
    helpers: {
      refreshWorkspace: (input) =>
        refreshWorktreeSourceControlState(input).pipe(
          Effect.provideContext(refreshContext),
          Effect.catchCause((cause) =>
            logOnceEvery({
              key: `pullRequestWatch.refreshWorkspace:${input.worktreeId}`,
              message: "Pull request watch could not refresh a workspace's pull requests",
              fields: { worktreeId: input.worktreeId },
              cause,
            }),
          ),
        ),
      discoverPullRequest: (cwd) =>
        gitWorkflow.refSummary(cwd).pipe(Effect.map((summary) => summary.pr)),
      linkPullRequest: (input) => linkPullRequestToWorkspace({ ...input, registry }),
      isWrongRepositoryLinkFailure,
      readCheckoutHead,
      logOnceEvery,
      inBackgroundLane: inBackgroundProcessLane,
      isThreadWaitWakeEvent,
      serverWakeGuard,
      serverWakeInScope,
      updateCommandId: pullRequestWatchUpdateCommandId,
      wakeMessageId: pullRequestWatchWakeMessageId,
      makeRejections: makePullRequestWatchRejections,
      repositoryKey: changeRequestRepositoryKey,
      numberFromUrl: changeRequestNumberFromUrl,
      dispatchLinks: (update) =>
        engine
          .dispatch({
            type: "worktree.pull-requests.update",
            commandId: CommandId.make(`server:pr-watch-link:${crypto.randomUUID()}`),
            updatedAt: new Date().toISOString(),
            ...update,
          })
          .pipe(
            Effect.asVoid,
            Effect.mapError((cause) =>
              pullRequestLinkFailure(
                "watchPullRequest",
                "Could not link the pull request to the workspace.",
                cause,
              ),
            ),
          ),
      watchError: (reason, detail) => new PullRequestWatchError({ reason, detail }),
      readWorktreePullRequestLinks,
      resolveThreadPullRequestLink,
      threadUserAnchorTimestamp,
      isThreadSnoozed,
    },
  } satisfies PullRequestWatchRuntimeDeps;
});

/**
 * The watch's runtime, loaded once. `firstSweepDelayMs` is how long the background loop waits
 * after commands are admitted; tests pass `null` to drive passes with `sweep` alone.
 */
export const makePullRequestWatchService = (options: {
  readonly firstSweepDelayMs: number | null;
}) =>
  Effect.gen(function* () {
    const deps = yield* pullRequestWatchRuntimeDeps;
    const startup = yield* ServerRuntimeStartup;

    const runtime: Effect.Effect<PullRequestWatchRuntime> = yield* Effect.cached(
      Effect.promise(() => import("./pullRequestWatchSweep.ts")).pipe(
        Effect.flatMap(({ makePullRequestWatchRuntime }) => makePullRequestWatchRuntime(deps)),
      ),
    );

    if (options.firstSweepDelayMs !== null) {
      const delayMs = options.firstSweepDelayMs;
      yield* Effect.forkScoped(
        startup.awaitCommandReady.pipe(
          Effect.andThen(Effect.sleep(Duration.millis(delayMs))),
          Effect.andThen(runtime),
          Effect.flatMap((loaded) => loaded.run),
          Effect.catchCause((cause) => Effect.logWarning("Pull request watch stopped", { cause })),
        ),
      );
    }

    // A watch change is a command like any other: it waits for startup to admit commands (the
    // client's own commands queue behind the same gate).
    const commandReady = startup.awaitCommandReady.pipe(
      Effect.mapError(
        () =>
          new PullRequestWatchError({
            reason: "thread-unavailable",
            detail: "The node is still starting. Try again in a moment.",
          }),
      ),
    );

    return {
      setWatch: (input) =>
        commandReady.pipe(
          Effect.andThen(runtime),
          Effect.flatMap((loaded) => loaded.setWatch(input)),
        ),
      linkPullRequest: (input) =>
        commandReady.pipe(
          Effect.andThen(runtime),
          Effect.flatMap((loaded) => loaded.linkPullRequest(input)),
        ),
      sweep: runtime.pipe(Effect.flatMap((loaded) => loaded.sweep)),
    } satisfies PullRequestWatchServiceShape;
  });

export const PullRequestWatchServiceLive = Layer.effect(
  PullRequestWatchService,
  makePullRequestWatchService({ firstSweepDelayMs: PULL_REQUEST_WATCH_FIRST_SWEEP_DELAY_MS }),
);
