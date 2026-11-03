/**
 * Integration harness for pull request watches: the real orchestration engine, decider,
 * projections and watch repository on in-memory SQLite, the real server wake fence, and a
 * scripted forge behind a fake source-control registry that counts every host read by kind.
 * No provider reactor runs, so a wake stays a pending turn start until a test binds it.
 * Time is a manual clock the watch reads (the engine keeps real time).
 *
 * Shared by `PullRequestWatchService.test.ts` and `scripts/measure-pr-watch-reads.ts`.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderError,
  ThreadId,
  WorktreeId,
  type ChangeRequest,
  type ChangeRequestActivity,
  type ChangeRequestReviewThread,
  type ChangeRequestTimelineItem,
  type OrchestrationCommand,
  type RuntimeMode,
  type SourceControlChangeRequestDetail,
  type SourceControlCheckRollupItem,
  type SourceControlProviderKind,
} from "@ryco/contracts";
import { readWorktreePullRequestLinks } from "@ryco/shared/worktreePullRequests";
import { Clock, DateTime, Duration, Effect, Layer, ManagedRuntime, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { AgentControlPolicy } from "../agentControl/Services/AgentControlPolicy.ts";
import { ServerConfig } from "../config.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { makeServerWakeFence } from "../orchestration/Layers/ServerWakeFence.ts";
import { OrchestrationCommandApplication } from "../orchestration/Services/OrchestrationCommandApplication.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ServerWakeFence } from "../orchestration/Services/ServerWakeFence.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadPullRequestWatchRepositoryLive } from "../persistence/Layers/ProjectionThreadPullRequestWatches.ts";
import { ProjectionWorktreeRepositoryLive } from "../persistence/Layers/ProjectionWorktrees.ts";
import { ProjectionWorktreeRepository } from "../persistence/Services/ProjectionWorktrees.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectAvatarStore } from "../project/Services/ProjectAvatarStore.ts";
import { RepositoryIdentityResolverLive } from "../project/Layers/RepositoryIdentityResolver.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import type { PullRequestWatchRuntime } from "./pullRequestWatchSweep.ts";
import { pullRequestWatchRuntimeDeps } from "./PullRequestWatchService.ts";
import type { SourceControlProviderShape } from "./SourceControlProvider.ts";
import { SourceControlProviderRegistry } from "./SourceControlProviderRegistry.ts";

// ── The scripted forge ───────────────────────────────────────────────

export type ForgeReadKind =
  | "fingerprint"
  | "detail"
  | "activity"
  | "reviewThread"
  | "changeRequest"
  | "pullRequestState";

export interface FakeCheck {
  readonly name: string;
  /** e.g. SUCCESS, FAILURE, CANCELLED, ACTION_REQUIRED; absent while it runs. */
  readonly conclusion?: string;
  readonly isRequired?: boolean;
}

export interface FakePullRequest {
  readonly number: number;
  readonly url: string;
  state: "open" | "closed" | "merged";
  headSha: string;
  headBranch: string;
  baseBranch: string;
  mergeability: "mergeable" | "conflicting" | "unknown";
  checks: FakeCheck[];
  timeline: ChangeRequestTimelineItem[];
  reviewThreads: ChangeRequestReviewThread[];
  author: string;
}

export interface FakeForge {
  readonly kind: SourceControlProviderKind;
  readonly pullRequests: Map<number, FakePullRequest>;
  /** The host offers the one-point fingerprint (GitHub). */
  fingerprints: boolean;
  /** Fail every read of this kind with the error until cleared. */
  readonly failing: Map<ForgeReadKind, unknown>;
  readonly calls: Record<ForgeReadKind, number>;
  /** The pull request the checkout's branch has (discovery), if any. */
  discoverable: number | null;
  /** The viewer (the agent's host account). */
  viewer: string;
}

export const fakeForge = (kind: SourceControlProviderKind = "github"): FakeForge => ({
  kind,
  pullRequests: new Map(),
  fingerprints: kind === "github",
  failing: new Map(),
  calls: {
    fingerprint: 0,
    detail: 0,
    activity: 0,
    reviewThread: 0,
    changeRequest: 0,
    pullRequestState: 0,
  },
  discoverable: null,
  viewer: "agent-user",
});

export const pullRequestUrl = (number: number, repository = "o/r") =>
  `https://github.com/${repository}/pull/${number}`;

export const addPullRequest = (
  forge: FakeForge,
  number: number,
  overrides: Partial<FakePullRequest> = {},
): FakePullRequest => {
  const pr: FakePullRequest = {
    number,
    url: pullRequestUrl(number),
    state: "open",
    headSha: "aaaaaaa1111111111111111111111111111111aa",
    headBranch: `feature/${number}`,
    baseBranch: "main",
    mergeability: "mergeable",
    checks: [],
    timeline: [],
    reviewThreads: [],
    author: "agent-user",
    ...overrides,
  };
  forge.pullRequests.set(number, pr);
  return pr;
};

const forgeError = (operation: string, detail: string) =>
  new SourceControlProviderError({ provider: "github", operation, detail });

/** GitHub's normalized rate-limit wording (what `classifyPullRequestWatchReadFailure` reads). */
export const rateLimitError = () =>
  forgeError("read", "GitHub API rate limit exceeded. Try again later.");

export const readError = () => forgeError("read", "Could not reach the host.");

const rollupItem = (check: FakeCheck): SourceControlCheckRollupItem => ({
  kind: "check-run",
  name: check.name,
  workflowName: "CI",
  status: Option.some(check.conclusion === undefined ? "IN_PROGRESS" : "COMPLETED"),
  conclusion: check.conclusion === undefined ? Option.none() : Option.some(check.conclusion),
  url: Option.some(`https://github.com/o/r/actions/runs/1/job/${encodeURIComponent(check.name)}`),
  startedAt: Option.none(),
  completedAt: Option.none(),
  ...(check.isRequired === undefined ? {} : { isRequired: check.isRequired }),
});

const timeOf = (item: ChangeRequestTimelineItem) => DateTime.formatIso(item.createdAt);

/** Status moves with state, mergeability, head and check outcomes; remarks with the conversation. */
export const fakeFingerprintOf = (pr: FakePullRequest) => ({
  status: JSON.stringify([
    pr.state,
    pr.mergeability,
    pr.headSha,
    pr.checks.map((check) => `${check.name}:${check.conclusion ?? "running"}`).toSorted(),
  ]),
  remarks: JSON.stringify([
    pr.timeline.length,
    pr.timeline.map(timeOf).toSorted().at(-1) ?? null,
    pr.reviewThreads.length,
  ]),
});

const fakeProvider = (forge: FakeForge): SourceControlProviderShape => {
  const pullRequest = (operation: string, reference: string) =>
    Effect.suspend(() => {
      const number = Number.parseInt(reference.replace(/^.*\//u, "").replace(/^#/u, ""), 10);
      const pr = forge.pullRequests.get(number);
      return pr === undefined
        ? Effect.fail(forgeError(operation, `No pull request #${reference}.`))
        : Effect.succeed(pr);
    });
  const counted = <A>(
    kind: ForgeReadKind,
    operation: string,
    read: Effect.Effect<A, SourceControlProviderError>,
  ) =>
    Effect.suspend(() => {
      forge.calls[kind] += 1;
      const failure = forge.failing.get(kind);
      return failure === undefined ? read : Effect.fail(failure as SourceControlProviderError);
    }).pipe(Effect.withSpan(`fakeForge.${operation}`));
  const changeRequestOf = (pr: FakePullRequest): ChangeRequest => ({
    provider: forge.kind,
    number: pr.number,
    title: `Pull request ${pr.number}`,
    url: pr.url,
    baseRefName: pr.baseBranch,
    headRefName: pr.headBranch,
    state: pr.state,
    updatedAt: Option.none(),
    isDraft: false,
  });
  const provider = {
    kind: forge.kind,
    getChangeRequest: ({ reference }: { readonly reference: string }) =>
      counted(
        "changeRequest",
        "getChangeRequest",
        pullRequest("getChangeRequest", reference).pipe(Effect.map(changeRequestOf)),
      ),
    getPullRequestState: ({ number }: { readonly number: number }) =>
      counted(
        "pullRequestState",
        "getPullRequestState",
        pullRequest("getPullRequestState", String(number)).pipe(
          Effect.map((pr) => ({ state: pr.state, isDraft: false })),
        ),
      ),
    getChangeRequestDetail: ({ reference }: { readonly reference: string }) =>
      counted(
        "detail",
        "getChangeRequestDetail",
        pullRequest("getChangeRequestDetail", reference).pipe(
          Effect.map((pr): SourceControlChangeRequestDetail => ({
            ...changeRequestOf(pr),
            headSha: pr.headSha,
            mergeability: pr.mergeability,
            checkRollup: pr.checks.map(rollupItem),
            author: pr.author,
            body: "",
            comments: [],
            truncated: false,
          })),
        ),
      ),
    getChangeRequestActivity: ({ reference }: { readonly reference: string }) =>
      counted(
        "activity",
        "getChangeRequestActivity",
        pullRequest("getChangeRequestActivity", reference).pipe(
          Effect.map((pr): ChangeRequestActivity => ({
            provider: forge.kind,
            number: pr.number,
            headSha: pr.headSha,
            viewer: {
              login: forge.viewer,
              isAuthor: forge.viewer === pr.author,
              canUpdate: true,
              canMerge: true,
              canReview: true,
              canUpdateBranch: true,
              canEnableAutoMerge: true,
              canDisableAutoMerge: true,
            },
            timeline: pr.timeline,
            timelineTruncated: false,
            reviewThreads: pr.reviewThreads,
            reviewThreadsTruncated: false,
            pendingReview: null,
          })),
        ),
      ),
    getChangeRequestReviewThread: ({ threadId }: { readonly threadId: string }) =>
      counted(
        "reviewThread",
        "getChangeRequestReviewThread",
        Effect.sync(() => {
          for (const pr of forge.pullRequests.values()) {
            const thread = pr.reviewThreads.find((candidate) => candidate.id === threadId);
            if (thread !== undefined) return thread;
          }
          return null;
        }),
      ),
    ...(forge.fingerprints
      ? {
          getChangeRequestWatchFingerprint: ({ number }: { readonly number: number }) =>
            counted(
              "fingerprint",
              "getChangeRequestWatchFingerprint",
              pullRequest("getChangeRequestWatchFingerprint", String(number)).pipe(
                Effect.map(fakeFingerprintOf),
              ),
            ),
        }
      : {}),
  };
  return provider as unknown as SourceControlProviderShape;
};

// ── The manual clock ─────────────────────────────────────────────────

export interface ManualClock {
  readonly clock: Clock.Clock;
  readonly now: () => number;
  readonly set: (ms: number) => void;
  readonly advance: (ms: number) => void;
}

export const makeManualClock = (startMs: number): ManualClock => {
  let nowMs = startMs;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => nowMs,
    currentTimeMillis: Effect.sync(() => nowMs),
    currentTimeNanosUnsafe: () => BigInt(nowMs) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(nowMs) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(nowMs) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(nowMs) * 1_000_000n),
    // The watch never sleeps in a pass; the loop is not driven by this clock.
    sleep: (duration: Duration.Duration) =>
      Effect.sync(() => {
        nowMs += Duration.toMillis(duration);
      }),
  };
  return {
    clock,
    now: () => nowMs,
    set: (ms) => {
      nowMs = ms;
    },
    advance: (ms) => {
      nowMs += ms;
    },
  };
};

// ── The harness ──────────────────────────────────────────────────────

export interface PullRequestWatchHarnessOptions {
  readonly forge?: FakeForge;
  /** Agent Control's switch; absent = no policy service (treated as on). */
  readonly agentControlEnabled?: () => boolean;
  /** Threads whose provider session is live (a wake does not count against the cold budget). */
  readonly liveSessions?: Set<string>;
  /** Branch, cleanliness and HEAD of every checkout Auto-fix CI reads. */
  readonly checkout?: () => {
    readonly branch: string | null;
    readonly clean: boolean;
    readonly headSha: string;
  };
  readonly startMs?: number;
}

const MockProjectAvatarStoreLive = Layer.succeed(ProjectAvatarStore, {
  write: () => Effect.die("ProjectAvatarStore.write not implemented in test"),
  read: () => Effect.succeed(null),
  remove: () => Effect.void,
});

export const PULL_REQUEST_WATCH_TEST_START = Date.parse("2026-10-04T10:10:00.000Z");

export async function createPullRequestWatchHarness(options: PullRequestWatchHarnessOptions = {}) {
  const forge = options.forge ?? fakeForge();
  const liveSessions = options.liveSessions ?? new Set<string>();
  const manual = makeManualClock(options.startMs ?? PULL_REQUEST_WATCH_TEST_START);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "ryco-pr-watch-")));
  const checkout =
    options.checkout ??
    (() => ({ branch: null, clean: true, headSha: "0000000000000000000000000000000000000000" }));

  const engineLayer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provide(MockProjectAvatarStoreLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
  );
  const provider = fakeProvider(forge);
  const serviceFakes = Layer.mergeAll(
    Layer.effect(
      ServerWakeFence,
      makeServerWakeFence.pipe(
        Effect.provideService(ProviderService, {
          getSession: (threadId: ThreadId) =>
            Effect.succeed(
              liveSessions.has(threadId)
                ? Option.some({ threadId, runtimeSessionId: `${threadId}-runtime` })
                : Option.none(),
            ),
        } as never),
      ),
    ),
    Layer.effect(
      OrchestrationCommandApplication,
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const applyInternal = (command: OrchestrationCommand) =>
          engine.dispatch(command).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationDispatchCommandError({
                  message: "Failed to dispatch orchestration command",
                  cause,
                }),
            ),
          );
        return {
          apply: () => Effect.die("apply is not used by the watch"),
          applyWithDispatcher: () => Effect.die("applyWithDispatcher is not used by the watch"),
          applyInternal,
        };
      }),
    ),
    Layer.succeed(SourceControlProviderRegistry, {
      resolve: () => Effect.succeed(provider),
      resolveHandle: () => Effect.succeed({ provider, context: undefined }),
    } as never),
    Layer.succeed(GitVcsDriver, {
      statusDetailsLocal: () =>
        Effect.sync(() => ({
          branch: checkout().branch,
          hasWorkingTreeChanges: !checkout().clean,
        })),
      execute: () =>
        Effect.sync(() => ({ stdout: `${checkout().headSha}\n`, stderr: "", code: 0 })),
    } as never),
    Layer.succeed(GitWorkflowService, {
      refSummary: () =>
        Effect.sync(() => {
          const pr =
            forge.discoverable === null ? undefined : forge.pullRequests.get(forge.discoverable);
          return {
            pr:
              pr === undefined
                ? null
                : {
                    number: pr.number,
                    title: `Pull request ${pr.number}`,
                    url: pr.url,
                    state: pr.state,
                    headRef: pr.headBranch,
                    baseRef: pr.baseBranch,
                  },
          };
        }),
    } as never),
    Layer.succeed(ServerRuntimeStartup, {
      awaitCommandReady: Effect.void,
    } as never),
    ...(options.agentControlEnabled === undefined
      ? []
      : [
          Layer.succeed(AgentControlPolicy, {
            isEnabled: Effect.sync(options.agentControlEnabled),
          } as never),
        ]),
  );

  const layer = Layer.mergeAll(
    serviceFakes,
    ProjectionThreadPullRequestWatchRepositoryLive,
    ProjectionWorktreeRepositoryLive,
  ).pipe(
    Layer.provideMerge(engineLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(directory, { prefix: "ryco-pr-watch-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);

  /** Run with the watch's manual clock. */
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
    runtime.runPromise(effect.pipe(Effect.provideService(Clock.Clock, manual.clock)));

  const watchRuntime: PullRequestWatchRuntime = await run(
    Effect.gen(function* () {
      const { makePullRequestWatchRuntime } = yield* Effect.promise(
        () => import("./pullRequestWatchSweep.ts"),
      );
      return yield* makePullRequestWatchRuntime(yield* pullRequestWatchRuntimeDeps);
    }),
  );

  let seq = 0;
  const commandId = (label: string) => CommandId.make(`test:${label}:${(seq += 1)}`);
  const iso = () => new Date(manual.now()).toISOString();
  const dispatch = (command: OrchestrationCommand) =>
    run(
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        return yield* engine.dispatch(command);
      }),
    );

  /** A project with a temporary root; its main workspace is created the way the server does. */
  const seedProject = async (key: string) => {
    const projectId = ProjectId.make(`project-${key}`);
    const root = realpathSync(mkdtempSync(join(directory, `root-${key}-`)));
    await dispatch({
      type: "project.create",
      commandId: commandId("project"),
      projectId,
      title: `Project ${key}`,
      workspaceRoot: root,
      defaultModelSelection: null,
      createdAt: iso(),
    });
    return { projectId, root };
  };

  /** A workspace (`origin` branch, or the project's main one) with an optional linked pull request. */
  const seedWorkspace = async (input: {
    readonly key: string;
    readonly projectId: ProjectId;
    readonly origin?: "branch" | "main";
    readonly root?: string;
    readonly link?: FakePullRequest;
  }) => {
    const worktreeId = WorktreeId.make(`worktree-${input.key}`);
    const worktreePath =
      input.origin === "main"
        ? null
        : realpathSync(mkdtempSync(join(directory, `wt-${input.key}-`)));
    await dispatch({
      type: "worktree.create",
      commandId: commandId("worktree"),
      worktreeId,
      projectId: input.projectId,
      branch: input.link?.headBranch ?? `branch-${input.key}`,
      worktreePath,
      origin: input.origin ?? "branch",
      prNumber: null,
      issueNumber: null,
      prTitle: null,
      issueTitle: null,
      createdAt: iso(),
    });
    if (input.link !== undefined) await linkPullRequest(worktreeId, input.link);
    return { worktreeId, worktreePath };
  };

  const linkPullRequest = (worktreeId: WorktreeId, pr: FakePullRequest) =>
    dispatch({
      type: "worktree.pull-requests.update",
      commandId: commandId("link"),
      worktreeId,
      upserts: [
        {
          number: pr.number,
          title: `Pull request ${pr.number}`,
          url: pr.url,
          state: pr.state,
          isDraft: false,
          headRefName: pr.headBranch,
          baseRefName: pr.baseBranch,
          source: "discovered",
        },
      ],
      updatedAt: iso(),
    });

  const seedThread = async (input: {
    readonly key: string;
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
    readonly runtimeMode?: RuntimeMode;
  }) => {
    const threadId = ThreadId.make(`thread-${input.key}`);
    await dispatch({
      type: "thread.create",
      commandId: commandId("thread"),
      threadId,
      projectId: input.projectId,
      title: `Thread ${input.key}`,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: input.runtimeMode ?? "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: input.worktreePath,
      createdAt: iso(),
    });
    return threadId;
  };

  /** One thread in its own workspace that links `pr` (the common case). */
  const seedWatchedSetup = async (key: string, pr: FakePullRequest) => {
    const { projectId, root } = await seedProject(key);
    const { worktreeId, worktreePath } = await seedWorkspace({ key, projectId, link: pr });
    const threadId = await seedThread({ key, projectId, worktreePath });
    return { projectId, root, worktreeId, worktreePath, threadId };
  };

  const sql = <A extends object>(
    build: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, SqlError>,
  ) =>
    run(
      Effect.gen(function* () {
        const client = yield* SqlClient.SqlClient;
        return yield* build(client);
      }).pipe(Effect.orDie),
    );

  /** The thread's watch events and turn starts, in order. */
  const events = (threadId: ThreadId) =>
    sql<{ type: string; payload: string; commandId: string | null }>(
      (
        client,
      ) => client`SELECT event_type AS "type", payload_json AS "payload", command_id AS "commandId"
        FROM orchestration_events WHERE stream_id = ${threadId} ORDER BY sequence`,
    ).then((rows) =>
      rows.map((row) => ({
        type: row.type,
        commandId: row.commandId,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
      })),
    );

  const wakes = async (threadId: ThreadId) =>
    (await events(threadId)).filter((event) => event.type === "thread.turn-start-requested");

  const wakeTexts = async (threadId: ThreadId) =>
    (await events(threadId))
      .filter(
        (event) =>
          event.type === "thread.message-sent" &&
          String((event.payload as { messageId?: string }).messageId ?? "").startsWith(
            "pull-request-watch:",
          ),
      )
      .map((event) => String((event.payload as { text?: string }).text ?? ""));

  /** The stored watches of a thread (full state). */
  const watches = (threadId: ThreadId) =>
    sql<{ watches: string }>(
      (client) =>
        client`SELECT watches_json AS "watches" FROM projection_thread_pull_request_watches WHERE thread_id = ${threadId}`,
    ).then((rows) =>
      rows[0] === undefined
        ? { active: [], ended: [] }
        : (JSON.parse(rows[0].watches) as {
            active: Array<import("@ryco/contracts").ThreadPullRequestWatch>;
            ended: Array<{ watchId: string; reason: string }>;
          }),
    );

  /** The pending wake's turn start binds (the provider took it). */
  const bindPendingStarts = (threadId: ThreadId) =>
    sql((client) =>
      client`UPDATE projection_turns SET turn_id = 'turn-' || pending_message_id
        WHERE thread_id = ${threadId} AND turn_id IS NULL`.pipe(Effect.as([])),
    );

  /** The pending wake's turn start ends without a turn (restart recovery or a failure). */
  const failPendingStart = (
    threadId: ThreadId,
    messageId: string,
    deliveryState: "not-sent" | "uncertain",
  ) =>
    sql((client) =>
      client`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
        VALUES (${`failure-${messageId}`}, ${threadId}, 'error', 'provider.turn.start.failed', 'Provider turn start failed',
          ${JSON.stringify({ messageId, deliveryState })}, ${iso()})`.pipe(Effect.as([])),
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

  const lastWakeMessageId = async (threadId: ThreadId) => {
    const turnStarts = await wakes(threadId);
    const last = turnStarts.at(-1);
    return last === undefined ? null : MessageId.make(String(last.payload.messageId));
  };

  /** The workspace's pull request links as the projection stores them. */
  const workspaceLinks = (worktreeId: WorktreeId) =>
    run(
      Effect.gen(function* () {
        const repository = yield* ProjectionWorktreeRepository;
        const row = yield* repository.getById({ worktreeId });
        return Option.isSome(row) ? readWorktreePullRequestLinks(row.value) : [];
      }),
    );

  const dispose = async () => {
    await runtime.dispose();
    rmSync(directory, { recursive: true, force: true });
  };

  return {
    forge,
    clock: manual,
    runtime,
    run,
    watch: watchRuntime,
    dispatch,
    seedProject,
    seedWorkspace,
    seedThread,
    seedWatchedSetup,
    linkPullRequest,
    events,
    wakes,
    wakeTexts,
    watches,
    bindPendingStarts,
    failPendingStart,
    setSession,
    lastWakeMessageId,
    workspaceLinks,
    commandId,
    liveSessions,
    dispose,
  };
}

export type PullRequestWatchHarness = Awaited<ReturnType<typeof createPullRequestWatchHarness>>;

/** A comment on the pull request's conversation. */
export const forgeComment = (
  id: string,
  createdAtIso: string,
  overrides: Partial<Extract<ChangeRequestTimelineItem, { kind: "comment" }>> = {},
): ChangeRequestTimelineItem => ({
  id,
  kind: "comment",
  createdAt: DateTime.makeUnsafe(createdAtIso),
  actor: { login: "reviewer" },
  body: "Please rename this.",
  authorAssociation: "MEMBER",
  ...overrides,
});
