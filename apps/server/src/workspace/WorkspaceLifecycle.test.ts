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
  WorktreeId,
} from "@ryco/contracts";

import type { GitVcsDriverShape } from "../vcs/GitVcsDriver.ts";
import { makeWorkspaceAccessPolicy } from "./Layers/WorkspaceAccessPolicy.ts";
import type { CheckoutFence, CheckoutFenceClaim } from "./checkoutFence.ts";
import { makeWorkspaceLifecycle, type WorkspaceLifecycleDeps } from "./WorkspaceLifecycle.ts";

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
      }
      return Effect.succeed({ sequence: state.commands.length });
    });

  const runGit = (cwd: string, args: readonly string[]) => git(cwd, ...args);
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
