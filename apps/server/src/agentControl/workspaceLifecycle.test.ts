import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  copyFileSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Schema } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  OrchestrationWorktreeShell,
  type AgentControlWorkspaceLifecyclePlan,
  type OrchestrationShellSnapshot,
  ProjectId,
  ThreadId,
} from "@ryco/contracts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GitVcsDriver, type GitVcsDriverShape } from "../vcs/GitVcsDriver.ts";
import { WorkspaceAccessPolicyLayer } from "../workspace/Layers/WorkspaceAccessPolicy.ts";
import {
  AgentControlWorkspaces,
  AgentControlWorkspacesLive,
  workspacePlanBlockers,
} from "./workspaceLifecycle.ts";
import { isRoutineAgentControlAction } from "./routineActions.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const NOW = "2026-09-15T00:00:00.000Z";
const projectId = ProjectId.make("p");
const callerId = ThreadId.make("caller");
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ryco-workspace-lifecycle-")));
  roots.push(root);
  const repo = path.join(root, "repo");
  const checkout = path.join(root, "checkout");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  git(root, "init", "-b", "main", repo);
  git(
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "base",
  );
  git(repo, "worktree", "add", "-b", "topic", checkout);
  const project = Schema.decodeUnknownSync(OrchestrationProjectShell)({
    id: projectId,
    title: "P",
    workspaceRoot: repo,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  });
  const thread = (id: string, worktreePath: string | null, worktreeId: string | null) =>
    Schema.decodeUnknownSync(OrchestrationThreadShell)({
      id,
      projectId,
      title: id,
      modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath,
      worktreeId,
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    });
  const row = (id: string, worktreePath: string | null, origin: string, branch: string) =>
    Schema.decodeUnknownSync(OrchestrationWorktreeShell)({
      worktreeId: id,
      projectId,
      title: "Manual",
      branch,
      worktreePath,
      origin,
      prNumber: null,
      issueNumber: null,
      prTitle: null,
      issueTitle: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      manualPosition: 0,
    });
  let snapshot: OrchestrationShellSnapshot = {
    snapshotSequence: 1,
    projects: [project],
    worktrees: [row("main", null, "main", "main"), row("topic", checkout, "manual", "topic")],
    threads: [thread("caller", null, "main"), thread("history", checkout, "topic")],
    updatedAt: NOW,
  };
  const driver = {
    execute: (input: Parameters<GitVcsDriverShape["execute"]>[0]) =>
      Effect.sync(() => ({
        stdout: git(input.cwd, ...input.args),
        stderr: "",
        exitCode: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      })),
  } as unknown as GitVcsDriverShape;
  const layer = AgentControlWorkspacesLive.pipe(
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getShellSnapshot: () => Effect.sync(() => snapshot),
      } as unknown as ProjectionSnapshotQueryShape),
    ),
    Layer.provide(Layer.succeed(GitVcsDriver, driver)),
    Layer.provide(WorkspaceAccessPolicyLayer(root)),
    Layer.provide(NodeServices.layer),
  );
  const run = <A, E>(fn: (service: typeof AgentControlWorkspaces.Service) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* fn(yield* AgentControlWorkspaces);
      }).pipe(Effect.provide(layer)),
    );
  const read = () => run((s) => s.read(projectId, "topic", callerId));
  const plan = async (
    overrides: Partial<AgentControlWorkspaceLifecyclePlan> = {},
  ): Promise<AgentControlWorkspaceLifecyclePlan> => ({
    kind: "workspaceLifecycle",
    projectId,
    expected: await read(),
    action: "delete",
    checkoutMode: "remove-checkout",
    sessions: "preserve",
    deleteBranch: false,
    ...overrides,
  });
  return {
    root,
    repo,
    checkout,
    git,
    read,
    plan,
    run,
    get snapshot() {
      return snapshot;
    },
    set snapshot(value) {
      snapshot = value;
    },
    thread,
  };
}

describe("governed workspace preflight", () => {
  it("reports clean registered Manual entries and preserved sessions without mutation", async () => {
    const f = fixture();
    const plan = await f.plan();
    expect(plan.expected).toMatchObject({
      registration: "registered",
      origin: "manual",
      checkout: "present",
      gitRegistered: true,
      dirty: false,
      unmerged: false,
      current: false,
      main: false,
    });
    expect(plan.expected.sessions.map((s) => s.threadId)).toEqual(["history"]);
    expect(workspacePlanBlockers(plan)).toEqual([]);
    await f.run((s) => s.revalidate(plan, callerId));
    expect(f.git(f.repo, "worktree", "list")).toContain(f.checkout);
  });
  it("supports the missing-checkout Manual-record cleanup case without deleting history", async () => {
    const f = fixture();
    f.git(f.repo, "worktree", "remove", f.checkout);
    const plan = await f.plan({ checkoutMode: "record-only" });
    expect(plan.expected).toMatchObject({
      checkout: "missing",
      gitRegistered: false,
      registration: "registered",
    });
    expect(workspacePlanBlockers(plan)).toEqual([]);
    expect(workspacePlanBlockers({ ...plan, deleteBranch: true }).join(" ")).toContain(
      "branches are retained",
    );
    expect(f.git(f.repo, "branch", "--list", "topic")).toContain("topic");
  });
  it("blocks ignored changes and branch identity mismatches at the same commit", async () => {
    const f = fixture();
    writeFileSync(path.join(f.repo, ".git", "info", "exclude"), "ignored-output\n");
    writeFileSync(path.join(f.checkout, "ignored-output"), "retain user output");
    expect((await f.read()).dirty).toBe(true);
    rmSync(path.join(f.checkout, "ignored-output"));
    f.git(f.checkout, "switch", "-c", "different-branch");
    expect(workspacePlanBlockers(await f.plan()).length).toBeGreaterThan(0);
  });
  it("rejects replaced checkout inodes and symlinks", async () => {
    const f = fixture();
    const approved = await f.plan();
    const moved = path.join(f.root, "moved");
    renameSync(f.checkout, moved);
    mkdirSync(f.checkout);
    copyFileSync(path.join(moved, ".git"), path.join(f.checkout, ".git"));
    await expect(f.run((s) => s.revalidate(approved, callerId))).rejects.toThrow("changed");
    rmSync(f.checkout, { recursive: true });
    symlinkSync(f.repo, f.checkout, "dir");
    expect(workspacePlanBlockers(await f.plan()).length).toBeGreaterThan(0);
  });
  it("blocks dirty, unmerged, and still registered missing checkouts", async () => {
    const f = fixture();
    writeFileSync(path.join(f.checkout, "user.txt"), "keep");
    expect(workspacePlanBlockers(await f.plan()).join(" ")).toContain("clean checkout");
    f.git(f.checkout, "add", ".");
    f.git(
      f.checkout,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "user changes",
    );
    expect((await f.read()).unmerged).toBe(true);
    expect(workspacePlanBlockers(await f.plan()).length).toBeGreaterThan(0);
    rmSync(f.checkout, { recursive: true });
    expect(
      workspacePlanBlockers(await f.plan({ checkoutMode: "record-only" })).length,
    ).toBeGreaterThan(0);
  });
  it("rejects stale revisions, changed paths and new sessions", async () => {
    const f = fixture();
    const plan = await f.plan();
    f.snapshot = {
      ...f.snapshot,
      threads: [...f.snapshot.threads, f.thread("new", f.checkout, "topic")],
    };
    await expect(f.run((s) => s.revalidate(plan, callerId))).rejects.toThrow("changed");
    f.snapshot = {
      ...f.snapshot,
      threads: f.snapshot.threads.slice(0, 2),
      worktrees: f.snapshot.worktrees?.map((w) =>
        w.worktreeId === "topic" ? { ...w, updatedAt: "2026-09-15T01:00:00.000Z" } : w,
      ),
    };
    await expect(f.run((s) => s.revalidate(plan, callerId))).rejects.toThrow("changed");
    f.snapshot = {
      ...f.snapshot,
      worktrees: f.snapshot.worktrees?.map((w) =>
        w.worktreeId === "topic" ? { ...w, worktreePath: f.repo } : w,
      ),
    };
    expect(workspacePlanBlockers(await f.plan()).join(" ")).toContain("main workspace");
  });
  it("protects current/main, cross-project access, synthetic groups and active sessions", async () => {
    const f = fixture();
    await expect(f.run((s) => s.read(ProjectId.make("other"), "topic", callerId))).rejects.toThrow(
      "scope",
    );
    const main = await f.run((s) => s.read(projectId, "main", callerId));
    expect(workspacePlanBlockers({ ...(await f.plan()), expected: main }).join(" ")).toContain(
      "current workspace",
    );
    f.snapshot = {
      ...f.snapshot,
      threads: f.snapshot.threads.map((t) =>
        t.id === "history" ? { ...t, backgroundLiveness: "working" } : t,
      ),
    };
    expect(workspacePlanBlockers(await f.plan()).join(" ")).toContain("active work");
    f.snapshot = {
      ...f.snapshot,
      worktrees: f.snapshot.worktrees?.filter((w) => w.worktreeId !== "topic"),
    };
    const listed = await f.run((s) => s.list(projectId, callerId));
    expect(listed.workspaces.some((w) => w.registration === "synthetic")).toBe(true);
    const page = await f.run((s) => s.list(projectId, callerId, undefined, 1));
    expect(page.workspaces).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
  });
  it("requires explicit cascade and retained branches for restore; never authorizes itself", async () => {
    const f = fixture();
    const plan = await f.plan();
    expect(
      workspacePlanBlockers({ ...plan, action: "archive", sessions: "delete" }).join(" "),
    ).toContain("Only delete");
    expect(
      workspacePlanBlockers({ ...plan, action: "restore", checkoutMode: "restore-checkout" })
        .length,
    ).toBeGreaterThan(0);
    expect(
      isRoutineAgentControlAction(
        { kind: "provider-session", threadId: callerId, providerInstanceId: "codex" as never },
        plan,
      ),
    ).toBe(false);
  });
});
