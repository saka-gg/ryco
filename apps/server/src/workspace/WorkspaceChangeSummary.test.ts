import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  type ModelSelection,
  OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  OrchestrationWorktreeShell,
  ProjectId,
  ProviderInstanceId,
  TextGenerationError,
  WorktreeId,
} from "@ryco/contracts";

import type { WorkspaceChangesSummaryGenerationInput } from "../textGeneration/TextGeneration.ts";
import type { GitVcsDriverShape } from "../vcs/GitVcsDriver.ts";
import { makeWorkspaceAccessPolicy } from "./Layers/WorkspaceAccessPolicy.ts";
import {
  makeWorkspaceChangeSummary,
  type WorkspaceChangeSummaryDeps,
} from "./WorkspaceChangeSummary.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ISO = "2026-10-01T00:00:00.000Z";
const projectId = ProjectId.make("project");
const topicId = WorktreeId.make("topic");
const mainId = WorktreeId.make("main");
const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ryco-change-summary-")));
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
  writeFileSync(path.join(repo, "app.ts"), "export const greeting = 'hello';\n");
  git(repo, "add", "app.ts");
  commit(repo, "base");
  git(repo, "worktree", "add", "-b", "topic", checkout);

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
      createdAt: ISO,
      updatedAt: ISO,
      archivedAt: null,
      manualPosition: 0,
    });
  const snapshot = {
    snapshotSequence: 1,
    projects: [
      Schema.decodeUnknownSync(OrchestrationProjectShell)({
        id: projectId,
        title: "Project",
        workspaceRoot: repo,
        defaultModelSelection: null,
        scripts: [],
        createdAt: ISO,
        updatedAt: ISO,
      }),
    ],
    worktrees: [
      worktree(mainId, null, "main", "main"),
      worktree(topicId, checkout, "branch", "topic"),
    ],
    threads: [],
    updatedAt: ISO,
  } as unknown as OrchestrationShellSnapshot;

  const state = {
    calls: [] as WorkspaceChangesSummaryGenerationInput[],
    gitCalls: [] as string[],
    fail: false,
    summary: "Adds a **farewell** greeting.",
  };

  const gitDriver = {
    execute: (input: Parameters<GitVcsDriverShape["execute"]>[0]) =>
      Effect.try({
        try: () => {
          state.gitCalls.push(input.args.join(" "));
          return {
            // As the real driver: read-only commands skip optional locks.
            stdout: execFileSync("git", input.args, {
              cwd: input.cwd,
              encoding: "utf8",
              stdio: ["pipe", "pipe", "pipe"],
              ...(input.readOnly ? { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } } : {}),
            }),
            stderr: "",
            exitCode: 0,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        },
        catch: (cause) => ({ message: String(cause) }) as never,
      }),
  } as unknown as GitVcsDriverShape;

  const deps = (policy: WorkspaceChangeSummaryDeps["policy"]): WorkspaceChangeSummaryDeps => ({
    snapshots: {
      getShellSnapshot: () => Effect.succeed(snapshot),
    } as WorkspaceChangeSummaryDeps["snapshots"],
    policy,
    gitDriver,
    textGeneration: {
      summarizeWorkspaceChanges: (input) =>
        Effect.suspend(() => {
          state.calls.push(input);
          return state.fail
            ? Effect.fail(
                new TextGenerationError({
                  operation: "summarizeWorkspaceChanges",
                  detail: "model unavailable",
                }),
              )
            : Effect.succeed({ summary: state.summary });
        }),
    },
    settings: {
      getSettings: Effect.succeed({ textGenerationModelSelection: modelSelection } as never),
    },
  });

  // One service per fixture, so its summary cache spans the calls of a test.
  const service = Effect.runPromise(
    makeWorkspaceAccessPolicy(root).pipe(
      Effect.map((policy) => makeWorkspaceChangeSummary(deps(policy))),
      Effect.provide(NodeServices.layer),
    ),
  );
  const summarize = async (worktreeId: WorktreeId = topicId) =>
    Effect.runPromise((await service).summarize({ worktreeId }));

  return { repo, checkout, git, commit, state, summarize };
}

describe("workspace change summary", () => {
  it("returns no summary for a clean checkout without calling a model", async () => {
    const f = fixture();
    expect(await f.summarize()).toEqual({ summary: null });
    expect(f.state.calls).toEqual([]);
  });

  it("never summarizes the main checkout", async () => {
    const f = fixture();
    writeFileSync(path.join(f.repo, "app.ts"), "export const greeting = 'changed';\n");
    expect(await f.summarize(mainId)).toEqual({ summary: null });
    expect(f.state.calls).toEqual([]);
  });

  it("describes uncommitted, untracked and unmerged work from read-only Git context", async () => {
    const f = fixture();
    writeFileSync(path.join(f.checkout, "app.ts"), "export const greeting = 'goodbye';\n");
    writeFileSync(path.join(f.checkout, "notes.md"), "todo\n");
    f.commit(f.checkout, "Add farewell flow");

    expect(await f.summarize()).toEqual({ summary: "Adds a **farewell** greeting." });
    expect(f.state.calls).toHaveLength(1);
    const call = f.state.calls[0]!;
    expect(call.cwd).toBe(f.checkout);
    expect(call.branch).toBe("topic");
    expect(call.modelSelection).toEqual(modelSelection);
    expect(call.diffPatch).toContain("+export const greeting = 'goodbye';");
    expect(call.statusSummary).toContain("app.ts");
    expect(call.untrackedFiles).toContain("notes.md");
    expect(call.unmergedLog).toContain("Add farewell flow");
    // Nothing is staged or written: the index still matches HEAD.
    expect(f.state.gitCalls.some((args) => /\b(add|commit|stash|reset)\b/.test(args))).toBe(false);
    expect(f.git(f.checkout, "diff", "--cached", "--name-only").trim()).toBe("");
  });

  it("leaves the checkout's index untouched when files only changed stat data", async () => {
    const f = fixture();
    writeFileSync(path.join(f.checkout, "app.ts"), "export const greeting = 'goodbye';\n");
    writeFileSync(path.join(f.checkout, "other.ts"), "export const other = 1;\n");
    f.git(f.checkout, "add", "other.ts");
    f.commit(f.checkout, "Add other");
    // Same content, newer mtime: a refreshing `git diff` would rewrite the index.
    const later = new Date(Date.now() + 60_000);
    utimesSync(path.join(f.checkout, "other.ts"), later, later);
    const index = path.resolve(
      f.checkout,
      f.git(f.checkout, "rev-parse", "--git-path", "index").trim(),
    );
    const before = { bytes: readFileSync(index), mtimeMs: statSync(index).mtimeMs };

    expect(await f.summarize()).toEqual({ summary: "Adds a **farewell** greeting." });
    expect(readFileSync(index).equals(before.bytes)).toBe(true);
    expect(statSync(index).mtimeMs).toBe(before.mtimeMs);
    const call = f.state.calls[0]!;
    expect(call.diffPatch).toContain("+export const greeting = 'goodbye';");
    expect(call.diffPatch).not.toContain("other.ts");
  });

  it("summarizes unmerged commits on an otherwise clean checkout", async () => {
    const f = fixture();
    f.commit(f.checkout, "Wire up billing export");
    await f.summarize();
    expect(f.state.calls).toHaveLength(1);
    expect(f.state.calls[0]!.unmergedLog).toContain("Wire up billing export");
    expect(f.state.calls[0]!.diffPatch).toBe("");
  });

  it("returns no summary when the model fails, and does not keep the failure", async () => {
    const f = fixture();
    writeFileSync(path.join(f.checkout, "app.ts"), "export const greeting = 'goodbye';\n");
    f.state.fail = true;
    expect(await f.summarize()).toEqual({ summary: null });
    f.state.fail = false;
    expect(await f.summarize()).toEqual({ summary: "Adds a **farewell** greeting." });
    expect(f.state.calls).toHaveLength(2);
  });

  it("reuses a summary for unchanged work, joins concurrent requests, and refreshes on change", async () => {
    const f = fixture();
    writeFileSync(path.join(f.checkout, "app.ts"), "export const greeting = 'goodbye';\n");
    const [first, second] = await Promise.all([f.summarize(), f.summarize()]);
    expect(first).toEqual(second);
    expect(await f.summarize()).toEqual(first);
    expect(f.state.calls).toHaveLength(1);

    writeFileSync(path.join(f.checkout, "app.ts"), "export const greeting = 'see you';\n");
    f.state.summary = "Changes the greeting.";
    expect(await f.summarize()).toEqual({ summary: "Changes the greeting." });
    expect(f.state.calls).toHaveLength(2);
  });

  it("fails for an unknown workspace", async () => {
    const f = fixture();
    await expect(f.summarize(WorktreeId.make("missing"))).rejects.toThrow(
      "The workspace no longer exists.",
    );
  });
});
