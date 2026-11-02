/**
 * A fork carried from another node, end to end on this node ("B"): real SQLite, the real Git
 * driver, and a bare origin with two clones (the source machine "A" pushes, B fetches).
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type CarriedThreadHistory,
  CommandId,
  CONTEXT_HANDOFF_ACTIVITY_KIND,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  THREAD_FORKED_ACTIVITY_KIND,
  type ThreadForkCarriedRequest,
  ThreadForkError,
  ThreadId,
} from "@ryco/contracts";
import { readThreadForkedActivity } from "@ryco/shared/threadFork";
import { Effect } from "effect";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { buildContextHandoffDocument } from "../../orchestration/contextHandoff/ContextHandoffBuilder.ts";
import { threadForkIdentity } from "../forkLedger.ts";
import {
  createForkHarness,
  type ForkHarness,
  type ForkHarnessOptions,
  historyAt,
  seedProject,
} from "../threadFork.fixtures.ts";

const roots: string[] = [];
const harnesses: ForkHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const projectId = ProjectId.make("project-on-b");

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configure(repo: string) {
  git(repo, "config", "user.name", "Carried fixture");
  git(repo, "config", "user.email", "carried@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
}

/**
 * A bare origin, machine A's clone and machine B's clone. B cloned before A pushed `feature`,
 * so only a fetch on B can see it.
 */
async function machines() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ryco-carried-git-")));
  roots.push(root);
  const origin = path.join(root, "origin.git");
  const a = path.join(root, "a");
  const b = path.join(root, "b");
  await mkdir(origin);
  git(origin, "init", "--bare", "--initial-branch=main");
  git(root, "clone", origin, a);
  configure(a);
  await writeFile(path.join(a, "app.txt"), "v1\n");
  git(a, "add", ".");
  git(a, "commit", "-m", "first");
  git(a, "push", "origin", "main");
  git(root, "clone", origin, b);
  configure(b);
  git(a, "checkout", "-b", "feature");
  await writeFile(path.join(a, "app.txt"), "feature work\n");
  git(a, "commit", "-am", "feature work");
  git(a, "push", "-u", "origin", "feature");
  return { root, a, b, featureCommit: git(a, "rev-parse", "HEAD") };
}

async function harness(root: string, options: ForkHarnessOptions = {}) {
  const created = await createForkHarness({
    ...options,
    settings: { worktreeRoot: path.join(root, "worktrees"), ...options.settings },
  });
  harnesses.push(created);
  return created;
}

const turn = (index: number) =>
  `turn-on-a-${index}` as NonNullable<CarriedThreadHistory["messages"][number]["turnId"]>;

const history: CarriedThreadHistory = {
  schemaVersion: 1,
  source: {
    machineLabel: "Machine A",
    threadTitle: "Feature work",
    threadId: "thread-on-a" as CarriedThreadHistory["source"]["threadId"],
    environmentId: "environment-a" as CarriedThreadHistory["source"]["environmentId"],
  },
  messages: [
    { role: "user", text: "Start the feature", createdAt: historyAt(0), turnId: turn(1) },
    { role: "assistant", text: "Started in app.txt", createdAt: historyAt(3), turnId: turn(1) },
    { role: "user", text: "Now push it", createdAt: historyAt(10), turnId: turn(2) },
    { role: "assistant", text: "Pushed feature", createdAt: historyAt(13), turnId: turn(2) },
  ],
  proposedPlans: [],
  turnOutcomes: [],
  model: { driver: ProviderDriverKind.make("codex"), model: "gpt-fixture" },
  runtimeMode: "full-access",
  interactionMode: "default",
};

const carried = (
  forkKey: string,
  commit: string,
  baseRef = "origin/feature",
): ThreadForkCarriedRequest => ({
  forkKey,
  projectId,
  destination: { kind: "new-worktree", start: { kind: "base-ref", baseRef, commit } },
  history,
});

const carriedChat = (forkKey: string): ThreadForkCarriedRequest => ({
  forkKey,
  projectId: null,
  destination: { kind: "new-chat" },
  history,
});

/** Machine A adds a commit to `feature` and pushes it; returns the new commit. */
async function pushAnotherCommit(a: string, text: string) {
  await writeFile(path.join(a, "app.txt"), `${text}\n`);
  git(a, "commit", "-am", text);
  git(a, "push", "origin", "feature");
  return git(a, "rev-parse", "HEAD");
}

const forkWorktrees = (repo: string) =>
  git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("branch refs/heads/ryco/fork-"));

describe("ThreadFork carried from another machine", () => {
  it("fetches the branch with this node's remote and creates the fork in a new worktree", async () => {
    const { root, a, b, featureCommit } = await machines();
    const h = await harness(root);
    await seedProject(h, { projectId, workspaceRoot: b });
    expect(git(b, "branch", "-r")).not.toContain("origin/feature");
    const aBefore = git(a, "for-each-ref", "--format=%(refname) %(objectname)");

    const forkKey = "carried-worktree-key-0001";
    const result = await h.run(h.forks.forkCarried(carried(forkKey, featureCommit)));
    const forkThreadId = threadForkIdentity(forkKey).forkThreadId;
    expect(result).toMatchObject({
      threadId: forkThreadId,
      projectId,
      replayed: false,
      providerContext: "handoff",
      checkout: { kind: "new-worktree", start: "base-ref", baseRef: "origin/feature" },
    });
    if (result.checkout.kind !== "new-worktree") throw new Error("expected a new worktree");
    // B fetched origin/feature itself and started the fork's own branch there.
    expect(git(b, "rev-parse", "refs/remotes/origin/feature")).toBe(featureCommit);
    expect(git(result.checkout.worktreePath, "rev-parse", "HEAD")).toBe(featureCommit);
    expect(result.checkout.branch).toMatch(/^ryco\/fork-[0-9a-f]{8}$/);
    expect(await readFile(path.join(result.checkout.worktreePath, "app.txt"), "utf8")).toBe(
      "feature work\n",
    );
    expect(result.checkout.worktreePath.startsWith(path.join(root, "worktrees"))).toBe(true);
    expect(forkWorktrees(b)).toHaveLength(1);
    // Machine A was never touched.
    expect(git(a, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(aBefore);

    const fork = await h.detail(forkThreadId);
    expect(fork?.worktreePath).toBe(result.checkout.worktreePath);
    expect(fork?.messages.map((message) => message.text)).toEqual(
      history.messages.map((message) => message.text),
    );
    expect(fork?.lineage).toMatchObject({ relationship: "forked" });
    const provenance = fork?.activities.find(
      (activity) => activity.kind === THREAD_FORKED_ACTIVITY_KIND,
    );
    expect(provenance === undefined ? null : readThreadForkedActivity(provenance)).toMatchObject({
      providerContext: "handoff",
      checkout: { kind: "new-worktree", baseRef: "origin/feature" },
      origin: { kind: "other-machine", machineLabel: "Machine A", sourceThreadId: "thread-on-a" },
    });

    // The first send hands the carried conversation to a fresh session as a fork handoff.
    const firstMessageId = MessageId.make("carried-first-own-message");
    await h.run(
      h.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("carried-first-turn"),
        threadId: forkThreadId,
        message: { messageId: firstMessageId, role: "user", text: "Continue", attachments: [] },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: new Date().toISOString(),
      }),
    );
    const sent = await h.detail(forkThreadId);
    const handoff = sent?.activities.find(
      (activity) => activity.kind === CONTEXT_HANDOFF_ACTIVITY_KIND,
    );
    expect(handoff?.payload).toMatchObject({ reason: "fork", status: "requested" });
    const endpoint = {
      providerInstanceId: ProviderInstanceId.make("codex"),
      driverKind: ProviderDriverKind.make("codex"),
      modelSlug: "gpt-fixture",
    };
    const built = buildContextHandoffDocument({
      thread: sent!,
      targetMessageId: firstMessageId,
      source: endpoint,
      target: endpoint,
    });
    expect(built.document.messages.map((message) => message.text)).toEqual(
      history.messages.map((message) => message.text),
    );
  });

  it("refuses a branch this node cannot fetch, before recording anything", async () => {
    const { root, b, featureCommit } = await machines();
    const h = await harness(root);
    await seedProject(h, { projectId, workspaceRoot: b });
    const missing = await h.run(
      Effect.flip(
        h.forks.forkCarried(carried("carried-missing-0001", featureCommit, "origin/not-pushed")),
      ),
    );
    expect(missing).toBeInstanceOf(ThreadForkError);
    expect(missing).toMatchObject({ reason: "base-ref-unavailable", attempt: "none" });
    const elsewhere = await h.run(
      Effect.flip(
        h.forks.forkCarried(carried("carried-upstream-0001", featureCommit, "upstream/feature")),
      ),
    );
    expect(elsewhere).toMatchObject({ reason: "base-ref-invalid", attempt: "none" });
    expect(await h.ledgerRows()).toEqual([]);
    expect(forkWorktrees(b)).toEqual([]);
  });

  it("starts from the carried commit, not a newer tip of origin", async () => {
    const { root, a, b, featureCommit } = await machines();
    const newer = await pushAnotherCommit(a, "work pushed after the conversation");
    const h = await harness(root);
    await seedProject(h, { projectId, workspaceRoot: b });
    const result = await h.run(h.forks.forkCarried(carried("carried-pinned-0001", featureCommit)));
    if (result.checkout.kind !== "new-worktree") throw new Error("expected a new worktree");
    expect(git(b, "rev-parse", "refs/remotes/origin/feature")).toBe(newer);
    expect(git(result.checkout.worktreePath, "rev-parse", "HEAD")).toBe(featureCommit);
    expect(result.checkout.baseRef).toBe("origin/feature");
  });

  it("refuses unless this node's origin holds the carried commit", async () => {
    const { root, a, b } = await machines();
    const h = await harness(root);
    await seedProject(h, { projectId, workspaceRoot: b });
    // A commit only machine A has (never pushed), as when B's origin is another repository.
    await writeFile(path.join(a, "app.txt"), "not pushed\n");
    git(a, "commit", "-am", "not pushed");
    const unpushed = git(a, "rev-parse", "HEAD");
    const unknown = await h.run(
      Effect.flip(h.forks.forkCarried(carried("carried-unknown-0001", unpushed))),
    );
    expect(unknown).toMatchObject({
      reason: "base-ref-unavailable",
      retryable: true,
      attempt: "none",
    });
    expect(unknown.message).toContain(`does not contain ${unpushed.slice(0, 12)}`);
    // A commit B knows, but not on origin/feature (the branch was rewritten, or another branch).
    git(a, "checkout", "-b", "side", "main");
    await writeFile(path.join(a, "side.txt"), "side\n");
    git(a, "add", ".");
    git(a, "commit", "-m", "side");
    git(a, "push", "origin", "side");
    const side = git(a, "rev-parse", "HEAD");
    git(b, "fetch", "origin", "side");
    const elsewhere = await h.run(
      Effect.flip(h.forks.forkCarried(carried("carried-elsewhere-0001", side))),
    );
    expect(elsewhere).toMatchObject({ reason: "base-ref-unavailable", attempt: "none" });
    expect(await h.ledgerRows()).toEqual([]);
    expect(forkWorktrees(b)).toEqual([]);
  });

  it("fetches the branch again even right after another fetch of it", async () => {
    const { root, a, b } = await machines();
    const h = await harness(root);
    await seedProject(h, { projectId, workspaceRoot: b });
    // The composer prefetched origin/feature a moment ago; then A pushed again.
    await h.run(
      Effect.flatMap(Effect.service(GitWorkflowService), (gitWorkflow) =>
        gitWorkflow.prefetchWorktreeBase({ cwd: b, refName: "origin/feature" }),
      ),
    );
    const pushed = await pushAnotherCommit(a, "pushed right before the fork");
    const result = await h.run(h.forks.forkCarried(carried("carried-fresh-0001", pushed)));
    if (result.checkout.kind !== "new-worktree") throw new Error("expected a new worktree");
    expect(git(result.checkout.worktreePath, "rev-parse", "HEAD")).toBe(pushed);
  });

  it("fetches before it takes a fork permit, so a slow remote holds up no other fork", async () => {
    const { root, b, featureCommit } = await machines();
    let fetchStarted!: () => void;
    const fetching = new Promise<void>((resolve) => (fetchStarted = resolve));
    let releaseFetch!: () => void;
    const released = new Promise<void>((resolve) => (releaseFetch = resolve));
    const h = await harness(root, {
      chatsRoot: path.join(root, "chats"),
      service: { maxConcurrentForks: 1 },
      prefetchWorktreeBase: (real) => (input) =>
        Effect.promise(async () => {
          fetchStarted();
          await released;
        }).pipe(Effect.andThen(real(input))),
    });
    await seedProject(h, { projectId, workspaceRoot: b });
    const slow = h.run(h.forks.forkCarried(carried("carried-slow-remote-0001", featureCommit)));
    await fetching;
    // The only permit is free while the slow fork waits for its remote.
    const chat = await h.run(h.forks.forkCarried(carriedChat("carried-while-fetching-0001")));
    expect(chat).toMatchObject({ replayed: false, checkout: { kind: "new-chat" } });
    releaseFetch();
    expect(await slow).toMatchObject({ replayed: false, checkout: { kind: "new-worktree" } });
  });

  it("finishes once after a restart that stopped it past checkout-ready", async () => {
    const { root, b, featureCommit } = await machines();
    const databasePath = path.join(root, "state.sqlite");
    const forkKey = "carried-restart-key-0001";
    const forkThreadId = threadForkIdentity(forkKey).forkThreadId;
    const first = await harness(root, {
      databasePath,
      service: {
        onRunPoint: (point) =>
          point === "provider-ready" ? Effect.die(new Error("simulated crash")) : Effect.void,
      },
    });
    await seedProject(first, { projectId, workspaceRoot: b });
    const stopped = await first.run(
      Effect.flip(first.forks.forkCarried(carried(forkKey, featureCommit))),
    );
    expect(stopped).toMatchObject({ retryable: true, attempt: "running" });
    expect(await first.ledgerRows()).toEqual([{ forkKey, phase: "provider-ready" }]);
    expect(forkWorktrees(b)).toHaveLength(1);
    await first.dispose();
    harnesses.splice(harnesses.indexOf(first), 1);

    const second = await harness(root, { databasePath });
    await second.run(second.forks.recover());
    expect(await second.ledgerRows()).toEqual([{ forkKey, phase: "completed" }]);
    expect((await second.threadIds()).filter((id) => id === forkThreadId)).toHaveLength(1);
    expect(forkWorktrees(b)).toHaveLength(1);
    expect((await second.detail(forkThreadId))?.messages).toHaveLength(history.messages.length);
    const replay = await second.run(second.forks.forkCarried(carried(forkKey, featureCommit)));
    expect(replay).toMatchObject({ threadId: forkThreadId, replayed: true });
  });

  it("refuses a carried publication that names a local source, inherits activity or shares a checkout", async () => {
    const { root, b } = await machines();
    const h = await harness(root);
    await seedProject(h, { projectId, workspaceRoot: b });
    const forkThreadId = ThreadId.make("fork-forged-carried");
    const localThread = ThreadId.make("local-thread-on-b");
    await h.run(
      h.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("seed-local-thread-on-b"),
        threadId: localThread,
        projectId,
        title: "Local",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-fixture" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: historyAt(0),
      }),
    );
    const sourceMessageId = MessageId.make("carried-0001");
    const message = (id: string) => ({
      id: MessageId.make(`${forkThreadId}:inherited:${id}`),
      role: "assistant" as const,
      text: "Reply",
      turnId: turn(1),
      streaming: false,
      createdAt: historyAt(3),
      updatedAt: historyAt(3),
    });
    const publication = (sourceThreadId: ThreadId, overrides: Record<string, unknown> = {}) => ({
      type: "thread.fork.create" as const,
      commandId: CommandId.make(
        `forged-carried-${Object.keys(overrides).join("-") || sourceThreadId}`,
      ),
      threadId: forkThreadId,
      projectId,
      title: "Forged (fork)",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-fixture" },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      createdAt: historyAt(20),
      sourceThreadId,
      sourceMessageId,
      sourceTurnId: turn(1),
      worktreeId: null,
      newWorktree: null,
      messages: [message("carried-0001")],
      proposedPlans: [],
      activities: [],
      forked: {
        schemaVersion: 1 as const,
        sourceThreadId,
        sourceMessageId,
        sourceTurnId: turn(1),
        sourceTitle: "Forged",
        inheritedMessageCount: 1,
        providerContext: "handoff" as const,
        checkout: { kind: "new-chat" as const, folder: b },
        notices: [],
        origin: {
          kind: "other-machine" as const,
          machineLabel: "Machine A",
          sourceEnvironmentId: "environment-a" as never,
          sourceThreadId: "thread-on-a" as never,
          sourceThreadTitle: "Forged",
        },
      },
      ...overrides,
    });
    const refused = (command: ReturnType<typeof publication>) =>
      h.run(Effect.flip(h.engine.dispatch(command as never))).then((error) => String(error));
    const placeholder = ThreadId.make(`${forkThreadId}:origin`);
    expect(await refused(publication(localThread))).toContain("has no local source");
    expect(
      await refused(
        publication(placeholder, {
          activities: [
            {
              id: `${forkThreadId}:inherited:tool`,
              tone: "tool",
              kind: "tool.completed",
              summary: "Ran a tool",
              payload: {},
              turnId: turn(1),
              createdAt: historyAt(2),
            },
          ],
        }),
      ),
    ).toContain("inherits only user and assistant text");
    expect(
      await refused(publication(placeholder, { worktreeId: "worktree-shared-on-b" })),
    ).toContain("has a checkout of its own");
    expect(await h.threadIds()).toEqual([localThread]);
  });
});
