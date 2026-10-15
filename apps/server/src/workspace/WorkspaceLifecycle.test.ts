import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Option, Schema } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_LIFECYCLE_SUGGESTION_POLICY,
  type DiagnosticsTerminalProcess,
  type OrchestrationCommand,
  OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  OrchestrationThreadShell,
  OrchestrationWorktreeShell,
  ProjectId,
  ThreadId,
  type WorkspaceLifecycleSummary,
  WorktreeId,
} from "@ryco/contracts";

import type { GitVcsDriverShape } from "../vcs/GitVcsDriver.ts";
import { makeWorkspaceAccessPolicy } from "./Layers/WorkspaceAccessPolicy.ts";
import type { CheckoutFence, CheckoutFenceClaim } from "./checkoutFence.ts";
import {
  makeWorkspaceLifecycle,
  toTrashedThreadSummary,
  type WorkspaceLifecycleDeps,
} from "./WorkspaceLifecycle.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const DAY = 86_400_000;
const NOW_MS = Date.parse("2026-10-01T00:00:00.000Z");
const iso = (daysAgo: number) => new Date(NOW_MS - daysAgo * DAY).toISOString();
const projectId = ProjectId.make("project");
const topicId = WorktreeId.make("topic");
const mainId = WorktreeId.make("main");
const activeId = ThreadId.make("active");
const archivedId = ThreadId.make("archived");
const pristineId = ThreadId.make("pristine");

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ryco-lifecycle-service-")));
  roots.push(root);
  const repo = path.join(root, "repo");
  const checkout = path.join(root, "checkout");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const commit = (cwd: string, message: string) =>
    git(
      cwd,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      message,
    );
  git(root, "init", "-b", "main", repo);
  commit(repo, "base");
  git(repo, "worktree", "add", "-b", "topic", checkout);

  const thread = (
    id: ThreadId,
    overrides: Partial<Record<string, unknown>> = {},
  ): OrchestrationThreadShell =>
    Schema.decodeUnknownSync(OrchestrationThreadShell)({
      id,
      projectId,
      title: `Thread ${id}`,
      modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "topic",
      worktreePath: checkout,
      worktreeId: topicId,
      latestTurn: null,
      createdAt: iso(40),
      updatedAt: iso(40),
      archivedAt: null,
      session: null,
      latestUserMessageAt: iso(40),
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      ...overrides,
    });
  const worktree = (id: WorktreeId, worktreePath: string | null, origin: string, branch: string) =>
    Schema.decodeUnknownSync(OrchestrationWorktreeShell)({
      worktreeId: id,
      projectId,
      title: id,
      branch,
      worktreePath,
      origin,
      prNumber: null,
      issueNumber: null,
      prTitle: null,
      issueTitle: null,
      createdAt: iso(50),
      updatedAt: iso(50),
      archivedAt: null,
      manualPosition: 0,
    });
  const state = {
    snapshot: {
      snapshotSequence: 1,
      projects: [
        Schema.decodeUnknownSync(OrchestrationProjectShell)({
          id: projectId,
          title: "Project",
          workspaceRoot: repo,
          defaultModelSelection: null,
          scripts: [],
          createdAt: iso(60),
          updatedAt: iso(60),
        }),
      ],
      worktrees: [
        worktree(mainId, null, "main", "main"),
        worktree(topicId, checkout, "branch", "topic"),
      ],
      threads: [
        thread(activeId, {
          session: {
            threadId: activeId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: iso(40),
          },
        }),
        thread(archivedId, { archivedAt: iso(20) }),
        thread(pristineId, { latestUserMessageAt: null }),
      ],
      updatedAt: iso(0),
    } as OrchestrationShellSnapshot,
    trashed: [] as Array<{ threadId: ThreadId; worktreeId: WorktreeId | null }>,
    terminals: [] as DiagnosticsTerminalProcess[],
    commands: [] as OrchestrationCommand[],
    stopped: [] as ThreadId[],
    closedTerminals: [] as ThreadId[],
    fence: [] as string[],
    removals: 0,
    failCommand: new Set<OrchestrationCommand["type"]>(),
    failStop: false,
    failRemoval: false,
    gitCalls: [] as string[],
  };

  const updateWorktree = (id: WorktreeId, patch: Record<string, unknown>) => {
    state.snapshot = {
      ...state.snapshot,
      worktrees: state.snapshot.worktrees?.map((row) =>
        row.worktreeId === id ? { ...row, ...patch } : row,
      ),
    };
  };
  const updateThread = (id: ThreadId, patch: Record<string, unknown>) => {
    state.snapshot = {
      ...state.snapshot,
      threads: state.snapshot.threads.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    };
  };
  /** A minimal engine: records commands and applies the projections the service reads. */
  const dispatch = (command: OrchestrationCommand) =>
    Effect.suspend(() => {
      if (state.failCommand.has(command.type)) {
        state.failCommand.delete(command.type);
        return Effect.fail({ message: `refused ${command.type}` } as never);
      }
      state.commands.push(command);
      switch (command.type) {
        case "worktree.archive":
          updateWorktree(command.worktreeId, { archivedAt: command.archivedAt });
          break;
        case "worktree.restore":
          updateWorktree(command.worktreeId, { archivedAt: null });
          break;
        case "worktree.checkout.remove": {
          const row = state.snapshot.worktrees?.find((w) => w.worktreeId === command.worktreeId);
          updateWorktree(command.worktreeId, {
            checkoutRemovedAt: command.removedAt,
            checkoutRemovalReason: command.reason,
            archivedAt: row?.archivedAt ?? command.removedAt,
          });
          break;
        }
        case "worktree.checkout.restore":
          updateWorktree(command.worktreeId, {
            checkoutRemovedAt: null,
            checkoutRemovalReason: null,
            worktreePath: command.worktreePath,
          });
          break;
        case "thread.archive":
          updateThread(command.threadId, { archivedAt: iso(0) });
          break;
        case "thread.session.stop":
          updateThread(command.threadId, { session: null });
          break;
        case "thread.trash":
          state.snapshot = {
            ...state.snapshot,
            threads: state.snapshot.threads.filter((row) => row.id !== command.threadId),
          };
          state.trashed.push({ threadId: command.threadId, worktreeId: topicId });
          break;
        case "worktree.delete":
          state.snapshot = {
            ...state.snapshot,
            worktrees: state.snapshot.worktrees?.filter(
              (row) => row.worktreeId !== command.worktreeId,
            ),
          };
          break;
      }
      return Effect.succeed({ sequence: state.commands.length });
    });

  const runGit = (cwd: string, args: readonly string[]) => {
    state.gitCalls.push(`${cwd}\u0000${args.join(" ")}`);
    return git(cwd, ...args);
  };
  const gitDriver = {
    execute: (input: Parameters<GitVcsDriverShape["execute"]>[0]) =>
      Effect.try({
        try: () => ({
          stdout: runGit(input.cwd, input.args),
          stderr: "",
          exitCode: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
        catch: (cause) => ({ message: String(cause) }) as never,
      }),
  } as unknown as GitVcsDriverShape;

  const fence: CheckoutFence = {
    claim: (input) =>
      Effect.sync(() => {
        state.fence.push(`claim:${input.path}`);
        return { id: "fence", path: input.path, previousState: null } satisfies CheckoutFenceClaim;
      }),
    release: () => Effect.sync(() => void state.fence.push("release")),
    complete: () => Effect.sync(() => void state.fence.push("complete")),
  };

  const deps = (policy: WorkspaceLifecycleDeps["policy"]): WorkspaceLifecycleDeps => ({
    snapshots: {
      getShellSnapshot: () => Effect.sync(() => state.snapshot),
      getThreadShellById: (id) =>
        Effect.sync(() => Option.fromNullishOr(state.snapshot.threads.find((t) => t.id === id))),
    } as WorkspaceLifecycleDeps["snapshots"],
    threads: {
      listTrashed: () =>
        Effect.sync(() =>
          state.trashed.map((row) => ({
            ...row,
            projectId,
            projectTitle: "Project",
            projectKind: "project" as const,
            projectDeletedAt: null,
            title: "Trashed",
            branch: "topic",
            worktreePath: checkout,
            archivedAt: null,
            trashedAt: iso(1),
            createdAt: iso(30),
            updatedAt: iso(1),
          })),
        ),
    },
    engine: { dispatch: dispatch as never },
    providers: {
      stopSession: ({ threadId }) =>
        state.failStop
          ? Effect.fail({ message: "adapter did not stop" } as never)
          : Effect.sync(() => void state.stopped.push(threadId)),
    },
    sessionDirectory: {
      listBindings: () =>
        Effect.sync(() =>
          state.snapshot.threads
            .filter((t) => t.session !== null)
            .map((t) => ({
              threadId: t.id,
              provider: "codex",
              status: state.stopped.includes(t.id) ? "stopped" : "running",
              lastSeenAt: iso(0),
            })),
        ) as never,
    },
    terminals: {
      listDiagnostics: Effect.sync(() => state.terminals),
      close: ({ threadId }) =>
        Effect.sync(() => void state.closedTerminals.push(ThreadId.make(threadId))),
    },
    policy,
    gitDriver,
    git: {
      removeWorktree: (input) =>
        Effect.suspend(() => {
          state.removals++;
          if (state.failRemoval) return Effect.fail({ message: "git refused" } as never);
          return Effect.try({
            try: () => {
              runGit(input.cwd, [
                "worktree",
                "remove",
                ...(input.force ? ["--force"] : []),
                input.path,
              ]);
            },
            catch: (cause) => ({ message: String(cause) }) as never,
          });
        }),
      createWorktree: (input) =>
        Effect.try({
          try: () => {
            runGit(input.cwd, ["worktree", "add", input.path!, input.refName]);
            return { worktree: { path: input.path!, refName: input.refName } };
          },
          catch: (cause) => ({ message: String(cause) }) as never,
        }) as never,
      listWorktreePaths: (cwd) =>
        Effect.sync(() =>
          runGit(cwd, ["worktree", "list", "--porcelain"])
            .split("\n")
            .filter((line) => line.startsWith("worktree "))
            .map((line) => line.slice(9)),
        ),
      invalidateStatus: () => Effect.void,
    },
    settings: {
      getSettings: Effect.succeed({
        lifecycleSuggestions: DEFAULT_LIFECYCLE_SUGGESTION_POLICY,
        projectLifecycleSuggestions: {},
      } as never),
    },
    fence,
    now: () => NOW_MS,
  });

  const run = <A, E>(
    fn: (service: ReturnType<typeof makeWorkspaceLifecycle>) => Effect.Effect<A, E>,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const policy = yield* makeWorkspaceAccessPolicy(root);
        return yield* fn(makeWorkspaceLifecycle(deps(policy)));
      }).pipe(Effect.provide(NodeServices.layer)),
    );

  const previewAndApply = (
    request: Parameters<ReturnType<typeof makeWorkspaceLifecycle>["preview"]>[0],
  ) =>
    run((service) =>
      Effect.gen(function* () {
        const preview = yield* service.preview(request);
        const result = yield* service.apply({
          ...preview.request,
          expectedFingerprint: preview.fingerprint,
        });
        return { preview, result };
      }),
    );

  const branchExists = (branch: string) => git(repo, "branch", "--list", branch).trim().length > 0;
  const commandTypes = () => state.commands.map((command) => command.type);

  return {
    root,
    repo,
    checkout,
    git,
    commit,
    state,
    run,
    previewAndApply,
    branchExists,
    commandTypes,
    updateThread,
  };
}

const neverDeletesConversations = (types: ReadonlyArray<string>) =>
  expect(types.filter((type) => type === "thread.delete" || type === "thread.trash")).toEqual([]);

describe("workspace lifecycle service", () => {
  it("archives a workspace without touching its checkout, branch or conversations", async () => {
    const f = fixture();
    const { preview, result } = await f.previewAndApply({ worktreeId: topicId, action: "archive" });
    expect(preview.summary).toBe(
      "Archive 1 workspace. Its checkout, branch and conversations stay as they are.",
    );
    expect(result.outcome).toBe("completed");
    expect(f.commandTypes()).toEqual(["worktree.archive"]);
    expect(existsSync(f.checkout)).toBe(true);
    expect(f.branchExists("topic")).toBe(true);
    expect(f.state.removals).toBe(0);

    const restored = await f.previewAndApply({ worktreeId: topicId, action: "restore" });
    expect(restored.result.outcome).toBe("completed");
    expect(f.commandTypes()).toEqual(["worktree.archive", "worktree.restore"]);
  });

  it("removes only the checkout: conversations are archived, history and branch are kept", async () => {
    const f = fixture();
    f.state.trashed.push({ threadId: ThreadId.make("in-trash"), worktreeId: topicId });
    const { preview, result } = await f.previewAndApply({
      worktreeId: topicId,
      action: "remove-checkout",
    });
    expect(preview.summary).toBe(
      "Remove 1 checkout, archive 1 conversation, keep history and branch.",
    );
    expect(preview.effects.archiveConversationIds).toEqual([activeId]);
    expect(preview.effects.unchangedConversations).toBe(2);
    expect(preview.details.join(" ")).toContain("1 conversation in Trash stay in Trash");
    expect(result.outcome).toBe("completed");
    expect(existsSync(f.checkout)).toBe(false);
    expect(f.git(f.repo, "worktree", "list")).not.toContain(f.checkout);
    expect(f.branchExists("topic")).toBe(true);
    expect(f.state.stopped).toEqual([activeId]);
    expect(f.state.fence).toEqual([`claim:${f.checkout}`, "complete"]);
    const types = f.commandTypes();
    expect(types).toContain("worktree.checkout.remove");
    expect(types).toContain("thread.archive");
    neverDeletesConversations(types);
    const record = f.state.snapshot.worktrees?.find((w) => w.worktreeId === topicId);
    expect(record).toMatchObject({
      branch: "topic",
      worktreePath: f.checkout,
      checkoutRemovalReason: "removed",
    });
  });

  it("archives a fork that has not sent anything yet: it holds its inherited conversation", async () => {
    const f = fixture();
    const forkId = ThreadId.make("fork-unused");
    const pristine = f.state.snapshot.threads.find((thread) => thread.id === pristineId)!;
    f.state.snapshot = {
      ...f.state.snapshot,
      threads: [
        ...f.state.snapshot.threads,
        Schema.decodeUnknownSync(OrchestrationThreadShell)({
          ...pristine,
          id: forkId,
          title: "Thread active (fork)",
          latestUserMessageAt: null,
          lineage: {
            parentThreadId: activeId,
            rootThreadId: activeId,
            relationship: "forked",
            sourceMessageId: "message-reply",
            sourceTurnId: "turn-1",
          },
        }),
      ],
    };
    const { preview, result } = await f.previewAndApply({
      worktreeId: topicId,
      action: "remove-checkout",
    });
    expect(preview.effects.archiveConversationIds.toSorted()).toEqual(
      [activeId, forkId].toSorted(),
    );
    // The never-used thread stays where it is; the archived one already is archived.
    expect(preview.effects.unchangedConversations).toBe(2);
    expect(result.outcome).toBe("completed");
    expect(
      f.state.commands.flatMap((command) =>
        command.type === "thread.archive" ? [command.threadId] : [],
      ),
    ).toContain(forkId);
    neverDeletesConversations(f.commandTypes());
  });

  it("blocks modified, untracked, protected ignored content and unmerged work", async () => {
    const f = fixture();
    const blockers = async () =>
      (
        await f.run((s) => s.preview({ worktreeId: topicId, action: "remove-checkout" }))
      ).blockers.join(" ");
    writeFileSync(path.join(f.checkout, "notes.txt"), "user work");
    expect(await blockers()).toContain("untracked file");
    rmSync(path.join(f.checkout, "notes.txt"));

    writeFileSync(path.join(f.repo, ".git", "info", "exclude"), "node_modules/\n.env\nlocal.db\n");
    mkdirSync(path.join(f.checkout, "node_modules", "dep"), { recursive: true });
    writeFileSync(path.join(f.checkout, "node_modules", "dep", "index.js"), "cache");
    const cacheOnly = await f.run((s) =>
      s.preview({ worktreeId: topicId, action: "remove-checkout" }),
    );
    expect(cacheOnly.blockers).toEqual([]);
    expect(cacheOnly.details.join(" ")).toContain("node_modules/");

    writeFileSync(path.join(f.checkout, ".env"), "TOKEN=secret");
    writeFileSync(path.join(f.checkout, "local.db"), "data");
    expect(await blockers()).toContain("not a known cache");
    rmSync(path.join(f.checkout, ".env"));
    rmSync(path.join(f.checkout, "local.db"));

    f.commit(f.checkout, "unmerged work");
    expect(await blockers()).toContain("commits that the project HEAD does not contain");
    expect(existsSync(f.checkout)).toBe(true);
    expect(f.state.removals).toBe(0);
  });

  it("does not treat ignored directories holding only empty directories as protected content", async () => {
    const f = fixture();
    writeFileSync(
      path.join(f.repo, ".git", "info", "exclude"),
      "node_modules/\nscratch-cache/\nuserdata/\n",
    );
    mkdirSync(path.join(f.checkout, "node_modules", "dep"), { recursive: true });
    writeFileSync(path.join(f.checkout, "node_modules", "dep", "index.js"), "cache");
    // Matching mode lists these; nothing in them can be lost.
    mkdirSync(path.join(f.checkout, "scratch-cache", "a", "b"), { recursive: true });
    const emptyOnly = await f.run((s) =>
      s.preview({ worktreeId: topicId, action: "remove-checkout" }),
    );
    expect(emptyOnly.blockers).toEqual([]);

    // A file anywhere below keeps the directory protected.
    mkdirSync(path.join(f.checkout, "userdata", "profiles"), { recursive: true });
    writeFileSync(path.join(f.checkout, "userdata", "profiles", "state.json"), "{}");
    const withContent = await f.run((s) =>
      s.preview({ worktreeId: topicId, action: "remove-checkout" }),
    );
    expect(withContent.blockers.join(" ")).toContain("userdata/");
    expect(withContent.blockers.join(" ")).not.toContain("scratch-cache/");

    // Listing shares the project's repository facts and reports the same.
    const summary = (await f.run((s) => s.list(projectId))).find(
      (row) => row.worktreeId === topicId,
    );
    expect(
      summary?.actions.find((action) => action.action === "remove-checkout")?.blockers.join(" "),
    ).toContain("userdata/");
  });

  it("blocks active work and running terminal commands; idle shells are closed with history", async () => {
    const f = fixture();
    f.updateThread(activeId, {
      session: {
        threadId: activeId,
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: "turn-1",
        lastError: null,
        updatedAt: iso(0),
      },
    });
    const running = await f.run((s) =>
      s.preview({ worktreeId: topicId, action: "remove-checkout" }),
    );
    expect(running.blockers.join(" ")).toContain("a turn is running");
    f.updateThread(activeId, { session: null, goal: null });

    const terminal = (
      overrides: Partial<DiagnosticsTerminalProcess>,
    ): DiagnosticsTerminalProcess => ({
      threadId: activeId,
      terminalId: "default",
      cwd: f.checkout,
      worktreePath: f.checkout,
      status: "running",
      pid: 42,
      hasRunningSubprocess: false,
      exitCode: null,
      exitSignal: null,
      updatedAt: iso(0),
      ...overrides,
    });
    f.state.terminals = [terminal({ hasRunningSubprocess: true })];
    const busyTerminal = await f.run((s) =>
      s.preview({ worktreeId: topicId, action: "remove-checkout" }),
    );
    expect(busyTerminal.blockers.join(" ")).toContain("terminal is running a command");

    f.state.terminals = [terminal({})];
    const { result } = await f.previewAndApply({ worktreeId: topicId, action: "remove-checkout" });
    expect(result.outcome).toBe("completed");
    expect(f.state.closedTerminals).toContain(activeId);
  });

  it("records an already-missing checkout as a stale record without deleting history", async () => {
    const f = fixture();
    f.git(f.repo, "worktree", "remove", f.checkout);
    const removal = await f.run((s) =>
      s.preview({ worktreeId: topicId, action: "remove-checkout" }),
    );
    expect(removal.blockers).toEqual([]);
    expect(removal.effects.removeCheckout).toBe(false);
    const { preview, result } = await f.previewAndApply({
      worktreeId: topicId,
      action: "remove-stale-record",
    });
    expect(preview.summary).toBe(
      "Record 1 missing checkout as removed, archive 1 conversation, keep history and branch.",
    );
    expect(result.outcome).toBe("completed");
    expect(f.state.removals).toBe(0);
    expect(f.state.fence).toEqual([]);
    const record = f.state.snapshot.worktrees?.find((w) => w.worktreeId === topicId);
    expect(record?.checkoutRemovalReason).toBe("missing");
    neverDeletesConversations(f.commandTypes());
  });

  it("asks for a prune instead of guessing when Git still registers a missing checkout", async () => {
    const f = fixture();
    rmSync(f.checkout, { recursive: true, force: true });
    const removal = await f.run((s) =>
      s.preview({ worktreeId: topicId, action: "remove-checkout" }),
    );
    expect(removal.blockers.join(" ")).toContain("git worktree prune");
    const stale = await f.run((s) =>
      s.preview({ worktreeId: topicId, action: "remove-stale-record" }),
    );
    expect(stale.blockers).toEqual([]);
    expect(stale.details.join(" ")).toContain("git worktree prune");
  });

  it("does not touch the checkout when a session fails to stop", async () => {
    const f = fixture();
    f.state.failStop = true;
    const { result } = await f.previewAndApply({ worktreeId: topicId, action: "remove-checkout" });
    expect(result.outcome).toBe("failed");
    expect(existsSync(f.checkout)).toBe(true);
    expect(f.state.removals).toBe(0);
    expect(f.state.fence).toEqual([]);
    expect(f.commandTypes()).toEqual([]);
  });

  it("releases the fence and keeps everything when Git refuses removal", async () => {
    const f = fixture();
    f.state.failRemoval = true;
    const { result } = await f.previewAndApply({ worktreeId: topicId, action: "remove-checkout" });
    expect(result.outcome).toBe("failed");
    expect(result.message).toContain("Conversations, history and the branch are unchanged");
    expect(existsSync(f.checkout)).toBe(true);
    expect(f.state.fence).toEqual([`claim:${f.checkout}`, "release"]);
    expect(f.commandTypes()).not.toContain("worktree.checkout.remove");
    expect(f.commandTypes()).not.toContain("thread.archive");
  });

  it("reports a partial failure truthfully and resumes safely on retry", async () => {
    const f = fixture();
    f.state.failCommand.add("worktree.checkout.remove");
    const first = await f.previewAndApply({ worktreeId: topicId, action: "remove-checkout" });
    expect(first.result.outcome).toBe("partial");
    expect(first.result.steps.find((step) => step.id === "remove-checkout")?.status).toBe("done");
    expect(first.result.steps.find((step) => step.id === "update-record")?.status).toBe("failed");
    expect(existsSync(f.checkout)).toBe(false);

    const retry = await f.previewAndApply({ worktreeId: topicId, action: "remove-checkout" });
    expect(retry.preview.effects.removeCheckout).toBe(false);
    expect(retry.result.outcome).toBe("completed");
    expect(f.state.removals).toBe(1);
    expect(f.commandTypes().filter((type) => type === "worktree.checkout.remove")).toHaveLength(1);
    expect(f.commandTypes()).toContain("thread.archive");
  });

  it("refuses an apply whose reviewed state changed, and serializes concurrent applies", async () => {
    const f = fixture();
    const preview = await f.run((s) =>
      s.preview({ worktreeId: topicId, action: "remove-checkout" }),
    );
    writeFileSync(path.join(f.checkout, "late.txt"), "written after review");
    const stale = await f.run((s) =>
      s.apply({ ...preview.request, expectedFingerprint: preview.fingerprint }),
    );
    expect(stale.outcome).toBe("blocked");
    expect(stale.message).toContain("changed since you reviewed it");
    expect(existsSync(path.join(f.checkout, "late.txt"))).toBe(true);
    rmSync(path.join(f.checkout, "late.txt"));

    const fresh = await f.run((s) => s.preview({ worktreeId: topicId, action: "remove-checkout" }));
    const results = await f.run((s) =>
      Effect.all(
        [0, 1].map(() => s.apply({ ...fresh.request, expectedFingerprint: fresh.fingerprint })),
        { concurrency: 2 },
      ),
    );
    expect(results.map((r) => r.outcome).toSorted()).toEqual(["blocked", "completed"]);
    expect(f.state.removals).toBe(1);
  });

  it("never treats the project root/main checkout as a disposable workspace", async () => {
    const f = fixture();
    for (const action of ["archive", "remove-checkout", "remove-stale-record"] as const) {
      const preview = await f.run((s) => s.preview({ worktreeId: mainId, action }));
      expect(preview.blockers).toEqual([
        "The project root/main checkout is never a disposable workspace.",
      ]);
    }
  });

  it("measures each checkout's disk usage; a missing checkout is unmeasured", async () => {
    const f = fixture();
    writeFileSync(path.join(f.checkout, "large.bin"), Buffer.alloc(512 * 1024));
    const measured = await f.run((s) => s.diskUsage({ projectId }));
    const topic = measured.workspaces.find((workspace) => workspace.worktreeId === topicId);
    expect(topic?.bytes).toBeGreaterThanOrEqual(512 * 1024);
    expect(topic?.partial).toBe(false);
    expect(measured.workspaces.some((workspace) => workspace.worktreeId === mainId)).toBe(true);

    rmSync(f.checkout, { recursive: true, force: true });
    const after = await f.run((s) => s.diskUsage({ projectId, refresh: true }));
    expect(after.workspaces.find((workspace) => workspace.worktreeId === topicId)).toMatchObject({
      bytes: null,
      partial: false,
    });
  });

  it("recreates a removed checkout on its existing branch", async () => {
    const f = fixture();
    await f.previewAndApply({ worktreeId: topicId, action: "remove-checkout" });
    const { preview, result } = await f.previewAndApply({
      worktreeId: topicId,
      action: "recreate-checkout",
    });
    expect(preview.blockers).toEqual([]);
    expect(result.outcome).toBe("completed");
    expect(existsSync(f.checkout)).toBe(true);
    expect(f.git(f.checkout, "symbolic-ref", "--short", "HEAD").trim()).toBe("topic");
    expect(f.commandTypes()).toEqual(
      expect.arrayContaining(["worktree.checkout.restore", "worktree.restore"]),
    );
  });

  it("deletes a branch only on explicit request and only when merged", async () => {
    const f = fixture();
    const kept = await f.run((s) => s.preview({ worktreeId: topicId, action: "remove-checkout" }));
    expect(kept.effects.deleteBranch).toBe(false);
    const { preview, result } = await f.previewAndApply({
      worktreeId: topicId,
      action: "remove-checkout",
      deleteBranch: true,
    });
    expect(preview.summary).toContain("delete merged branch topic");
    expect(result.outcome).toBe("completed");
    expect(f.branchExists("topic")).toBe(false);
  });

  it("deletes a workspace with unsaved and unmerged work only when discarding", async () => {
    const f = fixture();
    writeFileSync(path.join(f.checkout, "tracked.txt"), "v1");
    f.git(f.checkout, "add", "tracked.txt");
    f.commit(f.checkout, "unmerged work");
    writeFileSync(path.join(f.checkout, "tracked.txt"), "v2");
    writeFileSync(path.join(f.checkout, "scratch.txt"), "untracked");

    const kept = await f.run((s) => s.preview({ worktreeId: topicId, action: "remove-checkout" }));
    expect(kept.blockers.join(" ")).toContain("uncommitted changes");
    expect(kept.workspace.discardBlockers).toEqual([]);

    const { preview, result } = await f.previewAndApply({
      worktreeId: topicId,
      action: "remove-checkout",
      discard: true,
      // Ignored: a delete always deletes the branch and archives what it keeps.
      deleteBranch: false,
      archiveConversations: false,
    });
    expect(preview.blockers).toEqual([]);
    expect(preview.request).toMatchObject({
      deleteBranch: true,
      archiveConversations: true,
      deleteConversations: false,
    });
    expect(preview.summary).toBe(
      "Delete 1 workspace: remove its checkout, delete branch topic, archive 1 conversation, delete 1 unused conversation. Kept conversations stay in the archive; the workspace is hidden. Work that exists only here is lost.",
    );
    expect(preview.effects).toMatchObject({
      discard: true,
      discardsWork: true,
      archiveConversationIds: [activeId],
      trashConversationIds: [pristineId],
      unchangedConversations: 1,
      deleteRecord: false,
    });
    const details = preview.details.join(" ");
    expect(details).toContain("git worktree remove --force");
    expect(details).toContain("Discards uncommitted changes to 1 tracked file.");
    expect(details).toContain("Deletes 1 untracked file.");
    expect(details).toContain("including commits the project HEAD does not contain");
    expect(details).toContain("Kept conversations stay in the archive; the workspace is hidden.");

    expect(result.outcome).toBe("completed");
    expect(existsSync(f.checkout)).toBe(false);
    expect(f.git(f.repo, "worktree", "list")).not.toContain(f.checkout);
    expect(f.branchExists("topic")).toBe(false);
    expect(f.state.stopped).toEqual([activeId]);
    const types = f.commandTypes();
    expect(types.filter((type) => type === "thread.archive")).toHaveLength(1);
    expect(
      f.state.commands.flatMap((command) =>
        command.type === "thread.trash" ? [command.threadId] : [],
      ),
    ).toEqual([pristineId]);
    expect(types).not.toContain("thread.delete");
    expect(types).not.toContain("worktree.delete");
    // The workspace is hidden last, as deleted: its record stays only as provenance.
    expect(types.at(-1)).toBe("worktree.checkout.remove");
    const record = f.state.snapshot.worktrees?.find((w) => w.worktreeId === topicId);
    expect(record?.checkoutRemovalReason).toBe("deleted");
  });

  it("deletes the conversations too when asked", async () => {
    const f = fixture();
    const { preview, result } = await f.previewAndApply({
      worktreeId: topicId,
      action: "remove-checkout",
      discard: true,
      deleteConversations: true,
    });
    expect(preview.blockers).toEqual([]);
    expect(preview.summary).toBe(
      "Delete 1 workspace: remove its checkout, delete branch topic, delete 3 conversations.",
    );
    expect(preview.effects.archiveConversationIds).toEqual([]);
    expect(preview.effects.trashConversationIds?.toSorted()).toEqual(
      [activeId, archivedId, pristineId].toSorted(),
    );
    expect(preview.details.join(" ")).toContain(
      "The workspace is hidden; its record is dropped once its conversations are deleted.",
    );
    expect(result.outcome).toBe("completed");
    const types = f.commandTypes();
    expect(types.filter((type) => type === "thread.trash")).toHaveLength(3);
    expect(types).not.toContain("thread.archive");
    // Deleted conversations still reference the record until they are purged.
    expect(types).not.toContain("worktree.delete");
    expect(
      f.state.snapshot.worktrees?.find((w) => w.worktreeId === topicId)?.checkoutRemovalReason,
    ).toBe("deleted");
    expect(f.branchExists("topic")).toBe(false);
  });

  it("binds the conversation choice to the reviewed fingerprint", async () => {
    const f = fixture();
    const kept = await f.run((s) =>
      s.preview({ worktreeId: topicId, action: "remove-checkout", discard: true }),
    );
    const result = await f.run((s) =>
      s.apply({
        ...kept.request,
        deleteConversations: true,
        expectedFingerprint: kept.fingerprint,
      }),
    );
    expect(result.outcome).toBe("blocked");
    expect(f.commandTypes()).toEqual([]);
  });

  it("refuses a discard when the checkout changed after review, and while work is active", async () => {
    const f = fixture();
    writeFileSync(path.join(f.checkout, "scratch.txt"), "untracked");
    const request = {
      worktreeId: topicId,
      action: "remove-checkout",
      discard: true,
    } as const;
    const preview = await f.run((s) => s.preview(request));
    expect(preview.blockers).toEqual([]);
    expect(preview.details.join(" ")).toContain("Deletes the merged branch topic");
    writeFileSync(path.join(f.checkout, "late.txt"), "written after review");
    const stale = await f.run((s) =>
      s.apply({ ...preview.request, expectedFingerprint: preview.fingerprint }),
    );
    expect(stale.outcome).toBe("blocked");
    expect(existsSync(path.join(f.checkout, "late.txt"))).toBe(true);

    f.updateThread(activeId, {
      session: {
        threadId: activeId,
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: "turn-1",
        lastError: null,
        updatedAt: iso(0),
      },
    });
    const running = await f.run((s) => s.preview(request));
    expect(running.blockers.join(" ")).toContain("a turn is running");
    expect(running.workspace.discardBlockers?.join(" ")).toContain("a turn is running");
    expect(f.state.removals).toBe(0);
    expect(f.commandTypes()).toEqual([]);
  });

  it("deletes a workspace whose checkout was already removed, and hides it", async () => {
    const f = fixture();
    await f.previewAndApply({ worktreeId: topicId, action: "remove-checkout" });
    // Conversations in Trash never block deleting the workspace.
    f.state.trashed.push({ threadId: ThreadId.make("in-trash"), worktreeId: topicId });
    const { preview, result } = await f.previewAndApply({
      worktreeId: topicId,
      action: "remove-checkout",
      discard: true,
    });
    expect(preview.blockers).toEqual([]);
    expect(preview.summary).toBe(
      "Delete 1 workspace: delete branch topic, delete 1 unused conversation. Kept conversations stay in the archive; the workspace is hidden.",
    );
    expect(preview.details.join(" ")).toContain("The checkout is already removed.");
    expect(result.outcome).toBe("completed");
    expect(f.state.removals).toBe(1);
    expect(f.branchExists("topic")).toBe(false);
    expect(
      f.state.commands.flatMap((command) =>
        command.type === "worktree.checkout.remove" ? [command.reason] : [],
      ),
    ).toEqual(["removed", "deleted"]);
    expect(f.commandTypes()).not.toContain("worktree.delete");

    // A deleted workspace allows nothing and is listed nowhere.
    for (const action of ["restore", "recreate-checkout", "remove-checkout"] as const) {
      const again = await f.run((s) => s.preview({ worktreeId: topicId, action, discard: true }));
      expect(again.blockers).toEqual(["The workspace was deleted."]);
      expect(again.workspace.actions.every((entry) => !entry.available)).toBe(true);
    }
    const listed = await f.run((s) => s.list(projectId));
    expect(listed.map((summary) => summary.worktreeId)).toEqual([mainId]);
    const blocked = await f.run((s) => s.applyCurrent({ worktreeId: topicId, action: "restore" }));
    expect(blocked.outcome).toBe("blocked");
  });

  it("deletes an archived workspace without conversations in one step", async () => {
    const f = fixture();
    f.state.snapshot = { ...f.state.snapshot, threads: [] };
    await f.previewAndApply({ worktreeId: topicId, action: "archive" });
    const { preview, result } = await f.previewAndApply({
      worktreeId: topicId,
      action: "remove-checkout",
      discard: true,
    });
    expect(preview.blockers).toEqual([]);
    expect(preview.effects.deleteRecord).toBe(true);
    expect(preview.summary).toBe("Delete 1 workspace: remove its checkout, delete branch topic.");
    expect(result.outcome).toBe("completed");
    expect(f.git(f.repo, "worktree", "list")).not.toContain(f.checkout);
    expect(f.commandTypes()).toEqual([
      "worktree.archive",
      "worktree.checkout.remove",
      "worktree.delete",
    ]);
    expect(f.state.snapshot.worktrees?.some((w) => w.worktreeId === topicId)).toBe(false);
  });

  it("keeps a branch another checkout uses when deleting", async () => {
    const f = fixture();
    await f.previewAndApply({ worktreeId: topicId, action: "remove-checkout" });
    const other = path.join(f.root, "other");
    f.git(f.repo, "worktree", "add", other, "topic");
    const { preview, result } = await f.previewAndApply({
      worktreeId: topicId,
      action: "remove-checkout",
      discard: true,
    });
    expect(preview.blockers).toEqual([]);
    expect(preview.effects.deleteBranch).toBe(false);
    expect(preview.details.join(" ")).toContain("Keeps branch topic: Branch is checked out");
    expect(result.outcome).toBe("completed");
    expect(f.branchExists("topic")).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(
      f.state.snapshot.worktrees?.find((w) => w.worktreeId === topicId)?.checkoutRemovalReason,
    ).toBe("deleted");
  });

  it("restores a removed checkout on its existing branch", async () => {
    const f = fixture();
    await f.previewAndApply({ worktreeId: topicId, action: "remove-checkout" });
    const listed = (await f.run((s) => s.list(projectId))).find((w) => w.worktreeId === topicId);
    expect(listed?.actions.find((entry) => entry.action === "restore")?.available).toBe(true);
    const { preview, result } = await f.previewAndApply({ worktreeId: topicId, action: "restore" });
    expect(preview.blockers).toEqual([]);
    expect(preview.effects).toMatchObject({ recreateCheckout: true, restoreWorkspace: true });
    expect(preview.summary).toBe(
      "Restore 1 workspace: recreate its checkout on branch topic. Conversations stay as they are.",
    );
    expect(result.outcome).toBe("completed");
    expect(existsSync(f.checkout)).toBe(true);
    expect(f.git(f.checkout, "symbolic-ref", "--short", "HEAD").trim()).toBe("topic");
    expect(f.commandTypes().slice(-2)).toEqual(["worktree.checkout.restore", "worktree.restore"]);
    const record = f.state.snapshot.worktrees?.find((w) => w.worktreeId === topicId);
    expect(record).toMatchObject({ archivedAt: null, checkoutRemovedAt: null });
  });

  it("recreates a missing checkout of a workspace that is not archived", async () => {
    const f = fixture();
    f.git(f.repo, "worktree", "remove", f.checkout);
    const { preview, result } = await f.previewAndApply({ worktreeId: topicId, action: "restore" });
    expect(preview.blockers).toEqual([]);
    expect(preview.effects).toMatchObject({ recreateCheckout: true, restoreWorkspace: false });
    expect(result.outcome).toBe("completed");
    expect(existsSync(f.checkout)).toBe(true);
    expect(f.commandTypes()).toEqual([]);
  });

  it("only unarchives a workspace whose branch is gone", async () => {
    const f = fixture();
    await f.previewAndApply({ worktreeId: topicId, action: "remove-checkout", deleteBranch: true });
    expect(f.branchExists("topic")).toBe(false);
    const { preview, result } = await f.previewAndApply({ worktreeId: topicId, action: "restore" });
    expect(preview.blockers).toEqual([]);
    expect(preview.effects).toMatchObject({ recreateCheckout: false, restoreWorkspace: true });
    expect(preview.details.join(" ")).toContain("The checkout stays removed");
    expect(preview.details.join(" ")).toContain("Branch topic no longer exists");
    expect(result.outcome).toBe("completed");
    expect(f.commandTypes().at(-1)).toBe("worktree.restore");
    const record = f.state.snapshot.worktrees?.find((w) => w.worktreeId === topicId);
    expect(record?.archivedAt).toBeNull();
    expect(record?.checkoutRemovalReason).toBe("removed");

    // Nothing is left to restore now.
    const again = await f.run((s) => s.preview({ worktreeId: topicId, action: "restore" }));
    expect(again.blockers.join(" ")).toContain("Branch topic no longer exists");
  });

  it("suggests only eligible conversations and finished checkouts", async () => {
    const f = fixture();
    // `active` has been idle 40 days; `archived` was archived 20 days ago.
    const first = await f.run((s) => s.suggestions());
    expect(first.threads.map((t) => t.threadId)).toEqual([activeId]);
    expect(first.checkouts).toEqual([]);

    f.updateThread(activeId, { goal: { objective: "ship", status: "active" } as never });
    const withGoal = await f.run((s) => s.suggestions());
    expect(withGoal.threads).toEqual([]);

    f.updateThread(activeId, { goal: null, archivedAt: iso(10) });
    f.updateThread(pristineId, { archivedAt: iso(9) });
    const finished = await f.run((s) => s.suggestions());
    expect(finished.checkouts.map((c) => c.worktreeId)).toEqual([topicId]);

    f.state.terminals = [
      {
        threadId: archivedId,
        terminalId: "default",
        cwd: f.checkout,
        worktreePath: f.checkout,
        status: "running",
        pid: 1,
        hasRunningSubprocess: false,
        exitCode: null,
        exitSignal: null,
        updatedAt: iso(0),
      },
    ];
    expect((await f.run((s) => s.suggestions())).checkouts).toEqual([]);
    // Suggestions never act on their own.
    expect(f.state.commands).toEqual([]);
    expect(existsSync(f.checkout)).toBe(true);
  });
});

describe("workspace listing reads", () => {
  const statusCalls = (calls: ReadonlyArray<string>, checkout: string) =>
    calls.filter((call) => call.startsWith(`${checkout}\u0000`) && call.includes(" status "));

  it("reuses a checkout's Git reads across listings until the checkout changes", async () => {
    const f = fixture();
    await f.run((service) =>
      Effect.gen(function* () {
        const first = yield* service.list(projectId);
        const afterFirst = statusCalls(f.state.gitCalls, f.checkout).length;
        expect(afterFirst).toBe(1);
        // Listing again (and the suggestions next to it) reuses the reads.
        const second = yield* service.list(projectId);
        yield* service.suggestions();
        expect(statusCalls(f.state.gitCalls, f.checkout)).toHaveLength(afterFirst);
        expect(second).toEqual(first);

        // Staging a file rewrites the worktree's index: the next listing reads again.
        writeFileSync(path.join(f.checkout, "staged.txt"), "work");
        f.git(f.checkout, "add", "staged.txt");
        const third = yield* service.list(projectId);
        expect(statusCalls(f.state.gitCalls, f.checkout)).toHaveLength(afterFirst + 1);
        const topic = third.find((summary) => summary.worktreeId === topicId);
        expect(topic?.changes?.modified ?? 0).toBeGreaterThan(0);
      }),
    );
  });

  it("tells diverged branches apart in one read for the whole listing", async () => {
    const f = fixture();
    await f.run((service) =>
      Effect.gen(function* () {
        const topic = (summaries: ReadonlyArray<WorkspaceLifecycleSummary>) =>
          summaries.find((summary) => summary.worktreeId === topicId);
        expect(topic(yield* service.list(projectId))?.unmerged).toBe(false);
        f.commit(f.checkout, "unmerged work");
        expect(topic(yield* service.list(projectId))?.unmerged).toBe(true);
        expect(f.state.gitCalls.filter((call) => call.includes(" rev-list "))).toEqual([]);
        // A preview still counts it on its own, from scratch, and agrees.
        const preview = yield* service.preview({ worktreeId: topicId, action: "remove-checkout" });
        expect(preview.blockers.join(" ")).toContain(
          "commits that the project HEAD does not contain",
        );
      }),
    );
  });

  it("previews always inspect from scratch", async () => {
    const f = fixture();
    await f.run((service) =>
      Effect.gen(function* () {
        yield* service.list(projectId);
        const before = statusCalls(f.state.gitCalls, f.checkout).length;
        writeFileSync(path.join(f.checkout, "notes.txt"), "user work");
        const preview = yield* service.preview({ worktreeId: topicId, action: "remove-checkout" });
        expect(statusCalls(f.state.gitCalls, f.checkout)).toHaveLength(before + 1);
        expect(preview.blockers.join(" ")).toContain("untracked file");
      }),
    );
  });
});

describe("toTrashedThreadSummary", () => {
  const row = {
    threadId: ThreadId.make("trashed-chat"),
    projectId: ProjectId.make("chat-project"),
    projectTitle: "Plan the offsite",
    projectKind: "chat" as const,
    projectDeletedAt: null,
    title: "Plan the offsite",
    branch: null,
    worktreePath: null,
    worktreeId: null,
    archivedAt: null,
    trashedAt: iso(1),
    createdAt: iso(3),
    updatedAt: iso(1),
  };

  it("carries the project's kind, also for a deleted project record", () => {
    expect(toTrashedThreadSummary(row)).toMatchObject({
      projectKind: "chat",
      projectAvailable: true,
    });
    expect(toTrashedThreadSummary({ ...row, projectDeletedAt: iso(0) })).toMatchObject({
      projectKind: "chat",
      projectAvailable: false,
    });
  });

  it("omits the kind when the project record is gone", () => {
    const summary = toTrashedThreadSummary({ ...row, projectTitle: null, projectKind: null });
    expect(summary).not.toHaveProperty("projectKind");
    expect(summary.projectAvailable).toBe(false);
  });
});
