import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorktreeId,
  type ProviderRuntimeEvent,
  type VcsStatusLocalResult,
  type VcsStatusResult,
} from "@ryco/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, ManagedRuntime, Option, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadGitMetadataReactor } from "../Services/ThreadGitMetadataReactor.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import { gitSyncTriggerFor } from "../threadGitMetadata.ts";
import { locateCheckoutHead, type ThreadGitMetadataOptions } from "../threadGitMetadataRuntime.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import {
  makeThreadGitMetadataReactorLive,
  mayRequestThreadGitSync,
} from "./ThreadGitMetadataReactor.ts";

const PROJECT_ID = ProjectId.make("project-1");
const TEMPORARY_BRANCH = "ryco/1234abcd";
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };

function git(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.email=test@test.com",
      "-c",
      "user.name=Test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  );
}

interface VcsCalls {
  readonly local: string[];
  readonly full: string[];
}

interface HarnessOptions {
  readonly reactor?: ThreadGitMetadataOptions;
  /** What the stubbed `refreshLocalStatus` answers (the git fallback); default: a repo on `main`. */
  readonly localStatus?: (cwd: string, call: number) => Effect.Effect<VcsStatusLocalResult>;
  readonly wrapSnapshotQuery?: (
    query: ProjectionSnapshotQueryShape,
    engine: () => OrchestrationEngineShape,
  ) => ProjectionSnapshotQueryShape;
}

const runtimes: Array<ManagedRuntime.ManagedRuntime<unknown, unknown>> = [];
const scopes: Scope.Closeable[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void));
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function makeRepository(): string {
  const repo = makeTempDir("ryco-thread-git-metadata-");
  git(repo, ["init"]);
  git(repo, ["commit", "--allow-empty", "-m", "init"]);
  return repo;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function createHarness(options: HarnessOptions = {}) {
  const repo = makeRepository();
  const pubsub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  // The reactor only subscribes to the provider's runtime events.
  const providerService = {
    get streamEvents() {
      return Stream.fromPubSub(pubsub);
    },
  } as unknown as ProviderServiceShape;

  const calls: VcsCalls = { local: [], full: [] };
  let localCall = 0;
  const vcsStatusLayer = Layer.succeed(VcsStatusBroadcaster, {
    getStatus: () => Effect.die("getStatus is not used by the reactor"),
    refreshLocalStatus: (cwd: string) => {
      calls.local.push(cwd);
      localCall += 1;
      return (
        options.localStatus?.(cwd, localCall) ??
        Effect.succeed({
          isRepo: true,
          hasPrimaryRemote: false,
          isDefaultRef: true,
          refName: "main",
          hasWorkingTreeChanges: false,
          workingTree: { files: [], insertions: 0, deletions: 0 },
        })
      );
    },
    refreshStatus: (cwd: string) =>
      Effect.sync(() => {
        calls.full.push(cwd);
        // The reactor never reads the result.
        return {} as VcsStatusResult;
      }),
    streamStatus: () => Stream.empty,
  });

  let engineRef: OrchestrationEngineShape | null = null;
  const baseSnapshots = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provide(SqlitePersistenceMemory),
  );
  const wrap = options.wrapSnapshotQuery;
  const snapshotsLayer = wrap
    ? Layer.effect(
        ProjectionSnapshotQuery,
        Effect.map(Effect.service(ProjectionSnapshotQuery), (query) =>
          wrap(query, () => engineRef!),
        ),
      ).pipe(Layer.provide(baseSnapshots))
    : baseSnapshots;
  const engineLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(
      Layer.succeed(ProjectAvatarStore, {
        write: () => Effect.die("ProjectAvatarStore.write not implemented in test"),
        read: () => Effect.succeed(null),
        remove: () => Effect.void,
      }),
    ),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provide(SqlitePersistenceMemory),
  );

  const layer = makeThreadGitMetadataReactorLive({
    midTurnSettleMs: 20,
    remoteRefreshMinIntervalMs: 200,
    ...options.reactor,
  }).pipe(
    Layer.provideMerge(engineLayer),
    Layer.provideMerge(snapshotsLayer),
    Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
    Layer.provideMerge(vcsStatusLayer),
    Layer.provideMerge(ServerSettingsService.layerTest({ worktreeBranchPrefix: "ryco" })),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "ryco-thread-git-metadata-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  runtimes.push(runtime as ManagedRuntime.ManagedRuntime<unknown, unknown>);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  engineRef = engine;
  const snapshots = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const reactor = await runtime.runPromise(Effect.service(ThreadGitMetadataReactor));
  const scope = await Effect.runPromise(Scope.make("sequential"));
  scopes.push(scope);
  await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));

  const dispatch = (command: Parameters<OrchestrationEngineShape["dispatch"]>[0]) =>
    Effect.runPromise(engine.dispatch(command));
  const now = () => new Date().toISOString();

  await dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-project-create"),
    projectId: PROJECT_ID,
    title: "Project",
    workspaceRoot: repo,
    defaultModelSelection: MODEL,
    createdAt: now(),
  });

  let eventCount = 0;
  const emit = (event: Record<string, unknown>) => {
    eventCount += 1;
    Effect.runSync(
      PubSub.publish(pubsub, {
        eventId: EventId.make(`evt-${eventCount}`),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now(),
        ...event,
      } as unknown as ProviderRuntimeEvent),
    );
  };

  const createThread = async (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath?: string | null;
    readonly projectId?: ProjectId;
  }) => {
    await dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-thread-create-${input.threadId}`),
      threadId: input.threadId,
      projectId: input.projectId ?? PROJECT_ID,
      title: "Thread",
      modelSelection: MODEL,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: input.branch,
      worktreePath: input.worktreePath ?? null,
      createdAt: now(),
    });
  };

  /** A linked worktree on a temporary branch, its workspace record and its thread. */
  const createWorktreeThread = async (threadId: ThreadId) => {
    const worktreePath = path.join(makeTempDir("ryco-thread-git-worktree-"), "wt");
    const branch = TEMPORARY_BRANCH;
    git(repo, ["worktree", "add", "-b", branch, worktreePath]);
    const worktreeId = WorktreeId.make("worktree-1");
    await dispatch({
      type: "worktree.create",
      commandId: CommandId.make("cmd-worktree-create"),
      worktreeId,
      projectId: PROJECT_ID,
      branch,
      worktreePath,
      origin: "branch",
      prNumber: null,
      issueNumber: null,
      prTitle: null,
      issueTitle: null,
      createdAt: now(),
    });
    await createThread({ threadId, branch, worktreePath });
    await dispatch({
      type: "thread.attach-to-worktree",
      commandId: CommandId.make("cmd-attach"),
      threadId,
      worktreeId,
      attachedAt: now(),
    });
    return { worktreePath, worktreeId, branch };
  };

  const threadBranch = async (threadId: ThreadId) =>
    Option.getOrUndefined(await Effect.runPromise(snapshots.getThreadShellById(threadId)))
      ?.branch ?? null;
  const worktreeBranch = async (worktreeId: WorktreeId) =>
    Option.getOrUndefined(await Effect.runPromise(snapshots.getWorktreeShellById!(worktreeId)))
      ?.branch ?? null;

  const turnStarted = (threadId: ThreadId, turnId: string) =>
    emit({ type: "turn.started", threadId, turnId: TurnId.make(turnId), payload: {} });
  const turnCompleted = (threadId: ThreadId, turnId?: string) =>
    emit({
      type: "turn.completed",
      threadId,
      ...(turnId === undefined ? {} : { turnId: TurnId.make(turnId) }),
      payload: { state: "completed" },
    });
  const turnAborted = (threadId: ThreadId, turnId: string) =>
    emit({
      type: "turn.aborted",
      threadId,
      turnId: TurnId.make(turnId),
      payload: { reason: "stopped" },
    });
  const commandCompleted = (threadId: ThreadId, command: string) =>
    emit({
      type: "item.completed",
      threadId,
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Command run",
        data: { item: { command } },
      },
    });

  // A barrier: a local thread in a repository of its own. Events are offered in emit
  // order, so once its stopped turn was synced every earlier event was offered too.
  // (A stopped turn refreshes the local status, which no spacing holds back.)
  const barrierRepo = makeRepository();
  const BARRIER_PROJECT = ProjectId.make("project-barrier");
  const BARRIER = ThreadId.make("thread-barrier");
  await dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-project-barrier"),
    projectId: BARRIER_PROJECT,
    title: "Barrier",
    workspaceRoot: barrierRepo,
    defaultModelSelection: MODEL,
    createdAt: now(),
  });
  await createThread({ threadId: BARRIER, branch: "main", projectId: BARRIER_PROJECT });
  const local = (cwd: string) => calls.local.filter((entry) => entry === cwd);
  const full = (cwd: string) => calls.full.filter((entry) => entry === cwd);

  /** Waits until every event emitted so far was offered and every queued sync ran. */
  let barriers = 0;
  const settle = async () => {
    const before = local(barrierRepo).length;
    barriers += 1;
    turnStarted(BARRIER, `barrier-${barriers}`);
    turnAborted(BARRIER, `barrier-${barriers}`);
    await waitFor(() => local(barrierRepo).length > before, "the barrier");
    await Effect.runPromise(reactor.drain);
  };

  return {
    repo,
    engine,
    dispatch,
    calls,
    emit,
    createThread,
    createWorktreeThread,
    threadBranch,
    worktreeBranch,
    turnStarted,
    turnCompleted,
    turnAborted,
    commandCompleted,
    local,
    full,
    settle,
    drain: () => Effect.runPromise(reactor.drain),
  };
}

describe("mayRequestThreadGitSync", () => {
  it("lets through only events that can ask for a sync", () => {
    const of = (value: Record<string, unknown>) => value as unknown as ProviderRuntimeEvent;
    expect(mayRequestThreadGitSync(of({ type: "turn.started" }))).toBe(true);
    expect(mayRequestThreadGitSync(of({ type: "turn.aborted" }))).toBe(true);
    expect(mayRequestThreadGitSync(of({ type: "session.exited" }))).toBe(true);
    expect(
      mayRequestThreadGitSync(
        of({ type: "item.completed", payload: { itemType: "command_execution" } }),
      ),
    ).toBe(true);
    expect(
      mayRequestThreadGitSync(of({ type: "item.completed", payload: { itemType: "file_change" } })),
    ).toBe(false);
    expect(mayRequestThreadGitSync(of({ type: "content.delta", payload: {} }))).toBe(false);
    expect(mayRequestThreadGitSync(of({ type: "runtime.error", payload: {} }))).toBe(false);
  });

  it("lets through every event the runtime turns into a sync (the two filters agree)", () => {
    const of = (value: Record<string, unknown>) =>
      ({
        eventId: "evt",
        provider: "codex",
        threadId: "thread-1",
        createdAt: "2026-10-28T00:00:00.000Z",
        ...value,
      }) as unknown as ProviderRuntimeEvent;
    const events = [
      of({ type: "turn.started", turnId: "t1", payload: {} }),
      of({ type: "turn.completed", turnId: "t1", payload: { state: "completed" } }),
      of({ type: "turn.aborted", turnId: "t1", payload: { reason: "stopped" } }),
      of({ type: "session.exited", payload: {} }),
      of({
        type: "item.completed",
        payload: { itemType: "command_execution", status: "completed", detail: "git push" },
      }),
      of({
        type: "item.completed",
        payload: {
          itemType: "dynamic_tool_call",
          status: "completed",
          data: { item: { command: "git push" } },
        },
      }),
      of({ type: "item.updated", payload: { itemType: "command_execution", detail: "git push" } }),
      of({ type: "runtime.error", turnId: "t1", payload: { message: "x" } }),
      of({ type: "content.delta", turnId: "t1", payload: { delta: "git push" } }),
    ];
    const triggering = events.filter((event) => gitSyncTriggerFor(event) !== null);
    expect(triggering.map((event) => event.type)).toEqual([
      "turn.started",
      "turn.completed",
      "turn.aborted",
      "session.exited",
      "item.completed",
    ]);
    for (const event of triggering) expect(mayRequestThreadGitSync(event)).toBe(true);
  });
});

describe("locateCheckoutHead", () => {
  it("reads the nearest repository's HEAD, and none for a checkout folder that is gone", async () => {
    const repo = makeRepository();
    const subfolder = path.join(repo, "packages", "app");
    fs.mkdirSync(subfolder, { recursive: true });
    const run = (cwd: string) => Effect.runPromise(locateCheckoutHead(cwd));

    expect(await run(repo)).toEqual({ _tag: "head", root: repo, branch: "main" });
    expect(await run(subfolder)).toEqual({ _tag: "head", root: repo, branch: "main" });
    // A removed worktree inside the repository must not read the repository's branch.
    expect(await run(path.join(repo, "worktrees", "removed"))).toEqual({ _tag: "none" });
    expect(await run(makeTempDir("ryco-thread-git-plain-"))).toEqual({ _tag: "none" });
  });
});

describe("ThreadGitMetadataReactor", () => {
  const A = ThreadId.make("thread-a");
  const B = ThreadId.make("thread-b");

  it("follows a branch the agent checks out mid-turn into the thread and its workspace", async () => {
    const harness = await createHarness();
    const { worktreePath, worktreeId } = await harness.createWorktreeThread(A);
    harness.turnStarted(A, "turn-1");
    await harness.settle();

    git(worktreePath, ["checkout", "-b", "feat/agent"]);
    harness.commandCompleted(A, "git checkout -b feat/agent");

    await waitFor(async () => (await harness.threadBranch(A)) === "feat/agent", "thread branch");
    await waitFor(
      async () => (await harness.worktreeBranch(worktreeId)) === "feat/agent",
      "workspace branch",
    );
    await harness.settle();
    expect(harness.local(worktreePath)).toHaveLength(1);
    // A checkout reaches neither the remote nor the forge.
    expect(harness.full(worktreePath)).toEqual([]);
  });

  it("follows a branch changed by an unrecognised script at turn end", async () => {
    const harness = await createHarness();
    const { worktreePath, worktreeId } = await harness.createWorktreeThread(A);
    harness.turnStarted(A, "turn-1");
    await harness.settle();
    git(worktreePath, ["checkout", "-b", "feat/script"]);
    harness.commandCompleted(A, "./scripts/prepare.sh");
    await harness.settle();
    expect(await harness.threadBranch(A)).toBe(TEMPORARY_BRANCH);

    harness.turnCompleted(A, "turn-1");
    await waitFor(async () => (await harness.threadBranch(A)) === "feat/script", "thread branch");
    expect(await harness.worktreeBranch(worktreeId)).toBe("feat/script");
  });

  it("follows the branch when the turn is stopped, and refreshes the local status", async () => {
    const harness = await createHarness();
    const { worktreePath } = await harness.createWorktreeThread(A);
    harness.turnStarted(A, "turn-1");
    await harness.settle();
    git(worktreePath, ["checkout", "-b", "feat/stopped"]);
    harness.turnAborted(A, "turn-1");

    await waitFor(async () => (await harness.threadBranch(A)) === "feat/stopped", "thread branch");
    await harness.settle();
    expect(harness.local(worktreePath)).toHaveLength(1);
  });

  it("never follows a detached HEAD", async () => {
    const harness = await createHarness();
    const { worktreePath, worktreeId, branch } = await harness.createWorktreeThread(A);
    harness.turnStarted(A, "turn-1");
    git(worktreePath, ["checkout", "--detach"]);
    harness.commandCompleted(A, "git checkout --detach");
    harness.turnCompleted(A, "turn-1");
    await harness.settle();

    expect(await harness.threadBranch(A)).toBe(branch);
    expect(await harness.worktreeBranch(worktreeId)).toBe(branch);
  });

  it("never follows a temporary branch", async () => {
    const harness = await createHarness();
    const { worktreePath, worktreeId, branch } = await harness.createWorktreeThread(A);
    harness.turnStarted(A, "turn-1");
    git(worktreePath, ["checkout", "-b", "ryco/deadbeef"]);
    harness.commandCompleted(A, "git checkout -b ryco/deadbeef");
    harness.turnCompleted(A, "turn-1");
    await harness.settle();

    expect(await harness.threadBranch(A)).toBe(branch);
    expect(await harness.worktreeBranch(worktreeId)).toBe(branch);
  });

  it("skips a project checkout two threads worked in at the same time", async () => {
    const harness = await createHarness();
    await harness.createThread({ threadId: A, branch: "main" });
    await harness.createThread({ threadId: B, branch: "main" });
    harness.turnStarted(A, "a-1");
    harness.turnStarted(B, "b-1");
    await harness.settle();
    git(harness.repo, ["checkout", "-b", "feat/whose"]);
    harness.commandCompleted(B, "git checkout -b feat/whose");
    harness.turnCompleted(B, "b-1");
    harness.turnCompleted(A, "a-1");
    await harness.settle();

    expect(await harness.threadBranch(A)).toBe("main");
    expect(await harness.threadBranch(B)).toBe("main");
  });

  it("follows a project checkout at turn end when the thread worked in it alone", async () => {
    const harness = await createHarness();
    await harness.createThread({ threadId: A, branch: "main" });
    await harness.createThread({ threadId: B, branch: "main" });
    harness.turnStarted(A, "a-1");
    await harness.settle();
    git(harness.repo, ["checkout", "-b", "feat/alone"]);
    harness.turnCompleted(A, "a-1");

    await waitFor(async () => (await harness.threadBranch(A)) === "feat/alone", "thread branch");
    // B ran no turn: it keeps what it recorded until its own next turn.
    expect(await harness.threadBranch(B)).toBe("main");
  });

  it("does not let an untargeted or stray turn end end the running turn", async () => {
    const harness = await createHarness();
    await harness.createThread({ threadId: A, branch: "main" });
    await harness.createThread({ threadId: B, branch: "main" });
    harness.turnStarted(A, "a-2");
    // Claude's resume handshake (no turn id) and a late end of an earlier turn.
    harness.turnCompleted(A);
    harness.turnCompleted(A, "a-1");
    harness.turnStarted(B, "b-1");
    await harness.settle();
    git(harness.repo, ["checkout", "-b", "feat/shared"]);
    harness.turnCompleted(B, "b-1");
    await harness.settle();
    // A's turn still ran, so B's turn shared the checkout with it.
    expect(await harness.threadBranch(B)).toBe("main");

    harness.turnCompleted(A, "a-2");
    await harness.settle();
    expect(await harness.threadBranch(A)).toBe("main");

    harness.turnStarted(A, "a-3");
    await waitFor(async () => (await harness.threadBranch(A)) === "feat/shared", "thread branch");
  });

  it("refreshes nothing when an idle session exits", async () => {
    const harness = await createHarness();
    const { worktreePath } = await harness.createWorktreeThread(A);
    git(worktreePath, ["checkout", "-b", "feat/idle"]);
    harness.emit({ type: "session.exited", threadId: A, payload: { reason: "idle" } });
    await harness.settle();
    expect(harness.local(worktreePath)).toEqual([]);
    expect(harness.full(worktreePath)).toEqual([]);
    expect(await harness.threadBranch(A)).toBe(TEMPORARY_BRANCH);
  });

  it("runs no git and no refresh for a turn without git commands", async () => {
    const harness = await createHarness();
    const { worktreePath } = await harness.createWorktreeThread(A);
    harness.turnStarted(A, "turn-1");
    harness.commandCompleted(A, "npm test");
    harness.emit({
      type: "item.completed",
      threadId: A,
      payload: { itemType: "file_change", status: "completed", data: {} },
    });
    harness.turnCompleted(A, "turn-1");
    await harness.settle();
    expect(harness.local(worktreePath)).toEqual([]);
    expect(harness.full(worktreePath)).toEqual([]);
  });

  it("refreshes only the local status for a turn that only committed", async () => {
    const harness = await createHarness();
    const { worktreePath } = await harness.createWorktreeThread(A);
    harness.turnStarted(A, "turn-1");
    git(worktreePath, ["commit", "--allow-empty", "-m", "one"]);
    harness.commandCompleted(A, 'git commit -m "one"');
    await harness.settle();
    harness.commandCompleted(A, "git stash list");
    harness.turnCompleted(A, "turn-1");
    await harness.settle();
    expect(harness.full(worktreePath)).toEqual([]);
    expect(harness.local(worktreePath).length).toBeGreaterThanOrEqual(1);
  });

  it("refreshes the full status after a pull request command", async () => {
    const harness = await createHarness();
    const { worktreePath } = await harness.createWorktreeThread(A);
    harness.turnStarted(A, "turn-1");
    harness.commandCompleted(A, "gh pr create --fill");
    await harness.settle();
    expect(harness.full(worktreePath)).toHaveLength(1);
    expect(harness.local(worktreePath)).toEqual([]);
  });

  it("merges a burst of commands into few local refreshes", async () => {
    const harness = await createHarness();
    const { worktreePath } = await harness.createWorktreeThread(A);
    harness.turnStarted(A, "turn-1");
    await harness.settle();
    for (let index = 0; index < 30; index += 1) {
      harness.commandCompleted(A, `git commit -m c${index}`);
    }
    await harness.settle();
    expect(harness.local(worktreePath).length).toBeGreaterThanOrEqual(1);
    expect(harness.local(worktreePath).length).toBeLessThanOrEqual(2);
    expect(harness.full(worktreePath)).toEqual([]);
  });

  it("spaces full refreshes per checkout and delivers a held-back one at turn end", async () => {
    const harness = await createHarness({ reactor: { remoteRefreshMinIntervalMs: 5_000 } });
    const { worktreePath } = await harness.createWorktreeThread(A);
    harness.turnStarted(A, "turn-1");
    for (let index = 0; index < 5; index += 1) harness.commandCompleted(A, "git push");
    await harness.settle();
    expect(harness.full(worktreePath)).toHaveLength(1);
    for (let index = 0; index < 5; index += 1) harness.commandCompleted(A, "git push");
    await harness.settle();
    // Held back: the checkout refreshed less than the spacing ago.
    expect(harness.full(worktreePath)).toHaveLength(1);
    harness.turnCompleted(A, "turn-1");
    await harness.settle();
    expect(harness.full(worktreePath)).toHaveLength(2);
  });

  it("delivers a held-back full refresh once the spacing allows, mid-turn", async () => {
    const harness = await createHarness({ reactor: { remoteRefreshMinIntervalMs: 300 } });
    const { worktreePath } = await harness.createWorktreeThread(A);
    harness.turnStarted(A, "turn-1");
    harness.commandCompleted(A, "git push");
    await harness.settle();
    expect(harness.full(worktreePath)).toHaveLength(1);
    harness.commandCompleted(A, "gh pr create --fill");
    await harness.settle();
    await waitFor(() => harness.full(worktreePath).length === 2, "the held-back full refresh");
    await sleep(400);
    await harness.settle();
    expect(harness.full(worktreePath)).toHaveLength(2);
  });

  it("keeps forge work bounded over a busy turn (20 commits, 3 pushes, 1 pull request)", async () => {
    const harness = await createHarness();
    const { worktreePath } = await harness.createWorktreeThread(A);
    harness.turnStarted(A, "turn-1");
    const commands = [
      ...Array.from({ length: 20 }, (_, index) => `git commit -m step-${index}`),
      "git push -u origin HEAD",
      "git push",
      "gh pr create --fill",
      "git push",
    ];
    for (const command of commands) {
      harness.commandCompleted(A, command);
      await sleep(25);
    }
    harness.turnCompleted(A, "turn-1");
    await harness.settle();
    await sleep(300);
    await harness.settle();
    expect(harness.full(worktreePath).length).toBeGreaterThanOrEqual(1);
    expect(harness.full(worktreePath).length).toBeLessThanOrEqual(5);
    expect(harness.local(worktreePath).length).toBeLessThanOrEqual(21);
  });

  it("keeps a branch recorded meanwhile when it wins the race, and converges on the next sync", async () => {
    let raceArmed = false;
    const harness = await createHarness({
      wrapSnapshotQuery: (query, engine) => ({
        ...query,
        getThreadShellById: (threadId) =>
          query.getThreadShellById(threadId).pipe(
            Effect.tap(() => {
              if (!raceArmed || threadId !== A) return Effect.void;
              raceArmed = false;
              // A client records another branch right after the reactor read the thread.
              return engine()
                .dispatch({
                  type: "thread.meta.update",
                  commandId: CommandId.make("cmd-client-branch"),
                  threadId: A,
                  branch: "feat/other",
                })
                .pipe(Effect.orDie);
            }),
          ),
      }),
    });
    const { worktreePath, worktreeId } = await harness.createWorktreeThread(A);
    harness.turnStarted(A, "turn-1");
    await harness.settle();
    git(worktreePath, ["checkout", "-b", "feat/agent"]);
    raceArmed = true;
    harness.commandCompleted(A, "git checkout -b feat/agent");
    await harness.settle();
    // The workspace guard held; the thread's guard lost to the newer branch.
    expect(await harness.worktreeBranch(worktreeId)).toBe("feat/agent");
    expect(await harness.threadBranch(A)).toBe("feat/other");

    harness.turnCompleted(A, "turn-1");
    await waitFor(async () => (await harness.threadBranch(A)) === "feat/agent", "convergence");
  });

  it("follows a branch switched by hand before the send at turn start", async () => {
    const harness = await createHarness();
    await harness.createThread({ threadId: A, branch: "main" });
    git(harness.repo, ["checkout", "-b", "feat/manual"]);
    harness.turnStarted(A, "turn-1");
    await waitFor(async () => (await harness.threadBranch(A)) === "feat/manual", "thread branch");
    await harness.settle();
    expect(harness.local(harness.repo)).toHaveLength(1);
  });

  it("follows the repository's branch for a project rooted in a subfolder", async () => {
    const harness = await createHarness();
    const subfolder = path.join(harness.repo, "packages", "app");
    fs.mkdirSync(subfolder, { recursive: true });
    const subProject = ProjectId.make("project-sub");
    await harness.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-project-sub"),
      projectId: subProject,
      title: "App",
      workspaceRoot: subfolder,
      defaultModelSelection: MODEL,
      createdAt: new Date().toISOString(),
    });
    await harness.createThread({ threadId: A, branch: "main", projectId: subProject });
    harness.turnStarted(A, "turn-1");
    await harness.settle();
    git(harness.repo, ["checkout", "-b", "feat/sub"]);
    harness.turnCompleted(A, "turn-1");
    await waitFor(async () => (await harness.threadBranch(A)) === "feat/sub", "thread branch");
    await harness.settle();
    // HEAD came from the repository's files; git ran only to publish the new status.
    expect(harness.local(subfolder)).toHaveLength(1);
  });

  it("asks git when the file read cannot follow the layout, and cuts a hung read off", async () => {
    const harness = await createHarness({
      reactor: { syncTimeoutMs: 200 },
      localStatus: (_cwd, call) =>
        call === 1
          ? Effect.never
          : Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: false,
              isDefaultRef: false,
              refName: "feat/from-git",
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
    });
    // A reftable repository keeps a placeholder HEAD only git can resolve.
    const checkout = makeTempDir("ryco-thread-git-reftable-");
    fs.mkdirSync(path.join(checkout, ".git"));
    fs.writeFileSync(path.join(checkout, ".git", "HEAD"), "ref: refs/heads/.invalid\n");
    const project = ProjectId.make("project-reftable");
    await harness.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-project-reftable"),
      projectId: project,
      title: "Reftable",
      workspaceRoot: checkout,
      defaultModelSelection: MODEL,
      createdAt: new Date().toISOString(),
    });
    await harness.createThread({ threadId: A, branch: "main", projectId: project });
    harness.turnStarted(A, "turn-1");
    await harness.settle();
    expect(harness.local(checkout)).toHaveLength(1);
    expect(await harness.threadBranch(A)).toBe("main");

    // The lane survived the timeout.
    harness.turnCompleted(A, "turn-1");
    await waitFor(async () => (await harness.threadBranch(A)) === "feat/from-git", "thread branch");
    await harness.settle();
    // git's read published the status, so no second local refresh followed the adoption.
    expect(harness.local(checkout)).toHaveLength(2);
  });

  it("never reads or refreshes a chat's folder", async () => {
    const harness = await createHarness();
    // A repository on purpose: chats are skipped by kind, not by the folder's layout.
    const chatFolder = makeRepository();
    const chatProject = ProjectId.make("project-chat");
    await harness.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-project-chat"),
      projectId: chatProject,
      kind: "chat",
      title: "Chat",
      workspaceRoot: chatFolder,
      defaultModelSelection: MODEL,
      createdAt: new Date().toISOString(),
    });
    await harness.createThread({ threadId: A, branch: null, projectId: chatProject });
    git(chatFolder, ["checkout", "-b", "feat/chat"]);
    harness.turnStarted(A, "turn-1");
    harness.commandCompleted(A, "git checkout -b feat/chat && git push");
    harness.turnAborted(A, "turn-1");
    await harness.settle();
    expect(await harness.threadBranch(A)).toBeNull();
    expect(harness.local(chatFolder)).toEqual([]);
    expect(harness.full(chatFolder)).toEqual([]);
  });

  it("does no work for streaming deltas", async () => {
    const harness = await createHarness();
    const { worktreePath } = await harness.createWorktreeThread(A);
    git(worktreePath, ["checkout", "-b", "feat/deltas"]);
    for (let index = 0; index < 10_000; index += 1) {
      harness.emit({
        type: "content.delta",
        threadId: A,
        turnId: TurnId.make("turn-1"),
        payload: { streamKind: "assistant_text", delta: "git checkout -b x && git push " },
      });
    }
    await harness.settle();
    expect(harness.local(worktreePath)).toEqual([]);
    expect(harness.full(worktreePath)).toEqual([]);
    expect(await harness.threadBranch(A)).toBe(TEMPORARY_BRANCH);
  });
});
