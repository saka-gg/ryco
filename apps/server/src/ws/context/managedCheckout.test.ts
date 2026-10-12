import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { GitCommandError, ProjectId, type ServerSettings } from "@ryco/contracts";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { WorkspaceAccessDeniedError } from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import {
  cleanupOwnedCheckout,
  createManagedCheckout,
  isManagedCheckoutPathRefusal,
  type ManagedCheckoutDeps,
  removeOwnedCheckout,
  resolveManagedCheckoutPath,
} from "./managedCheckout.ts";

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "ryco-managed-checkout-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const project = () => ({
  id: ProjectId.make("project-1"),
  title: "Project One",
  workspaceRoot: path.join(root, "repo"),
});

const settings = () =>
  ({
    worktreeRoot: path.join(root, "worktrees"),
    projectWorktreeRoots: {},
  }) as unknown as ServerSettings;

function fixture(options: { readonly createdPath?: (requested: string) => string } = {}) {
  const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
  const failures = new Map<string, GitCommandError>();
  const deps = {
    config: { worktreesDir: path.join(root, "managed"), workspaceAccessRoot: undefined },
    workspaceAccessPolicy: {
      accessRoot: undefined,
      isRestricted: false,
      assertPath: ({ path: candidate }: { readonly path: string }) => Effect.succeed(candidate),
      assertExistingPath: ({ path: candidate }: { readonly path: string }) =>
        Effect.succeed(candidate),
    },
    gitWorkflow: {
      createWorktree: (input: { readonly path: string | null; readonly refName: string }) =>
        Effect.sync(() => {
          calls.push({ method: "createWorktree", input });
          return {
            worktree: {
              path: options.createdPath?.(input.path!) ?? input.path!,
              refName: input.refName,
            },
            submoduleInitialization: undefined,
          };
        }),
      removeWorktree: (input: unknown) => {
        calls.push({ method: "removeWorktree", input });
        const failure = failures.get("removeWorktree");
        return failure ? Effect.fail(failure) : Effect.void;
      },
      deleteBranch: (input: unknown) => {
        calls.push({ method: "deleteBranch", input });
        const failure = failures.get("deleteBranch");
        return failure ? Effect.fail(failure) : Effect.void;
      },
    },
  } as unknown as ManagedCheckoutDeps;
  return { deps, calls, failures };
}

const gitError = (detail: string) =>
  new GitCommandError({ operation: "test", command: "git", cwd: "/repo", detail });

describe("createManagedCheckout", () => {
  it("allocates under the configured root and owns exactly what it created", async () => {
    const { deps, calls } = fixture();
    const created = await Effect.runPromise(
      createManagedCheckout(deps, {
        operation: "test.create",
        project: project(),
        settings: settings(),
        initialName: "Fix the bug (fork)",
        branchName: "ryco/fork-1234abcd",
        refName: "0123456789abcdef0123456789abcdef01234567",
        newRefName: "ryco/fork-1234abcd",
        fetchOrigin: false,
      }),
    );
    expect(created.worktreePath.startsWith(path.join(root, "worktrees") + path.sep)).toBe(true);
    expect(created.owned).toEqual({
      worktreePath: created.worktreePath,
      branch: "ryco/fork-1234abcd",
    });
    expect(calls).toEqual([
      {
        method: "createWorktree",
        input: expect.objectContaining({
          cwd: project().workspaceRoot,
          refName: "0123456789abcdef0123456789abcdef01234567",
          newRefName: "ryco/fork-1234abcd",
          fetchOrigin: false,
          path: created.worktreePath,
          projectId: "project-1",
        }),
      },
    ]);
  });

  it("creates at a path the caller recorded before Git ran, without allocating another", async () => {
    const { deps, calls } = fixture();
    const recorded = await Effect.runPromise(
      resolveManagedCheckoutPath(deps, {
        operation: "test.allocate",
        project: project(),
        settings: settings(),
        initialName: "Fork",
        branchName: "ryco/fork-aaaabbbb",
      }),
    );
    const created = await Effect.runPromise(
      createManagedCheckout(deps, {
        operation: "test.create",
        project: project(),
        settings: settings(),
        initialName: "Fork",
        branchName: "ryco/fork-aaaabbbb",
        refName: "HEAD",
        newRefName: "ryco/fork-aaaabbbb",
        fetchOrigin: false,
        path: recorded,
      }),
    );
    expect(created.worktreePath).toBe(recorded);
    expect(calls.map((call) => (call.input as { path: string }).path)).toEqual([recorded]);
  });

  it("does not own a branch it only checked out", async () => {
    const { deps } = fixture();
    const created = await Effect.runPromise(
      createManagedCheckout(deps, {
        operation: "test.create",
        project: project(),
        settings: settings(),
        initialName: "feature",
        branchName: "feature",
        refName: "feature",
      }),
    );
    expect(created.owned.branch).toBeNull();
  });

  it("refuses the project root before and after Git runs", async () => {
    const before = fixture();
    const refused = await Effect.runPromiseExit(
      createManagedCheckout(before.deps, {
        operation: "test.create",
        project: project(),
        settings: settings(),
        initialName: "Fork",
        branchName: "b",
        refName: "HEAD",
        path: `${project().workspaceRoot}/`,
      }),
    );
    expect(refused._tag).toBe("Failure");
    expect(before.calls).toEqual([]);

    const after = fixture({ createdPath: () => project().workspaceRoot });
    const resolvedToRoot = await Effect.runPromiseExit(
      createManagedCheckout(after.deps, {
        operation: "test.create",
        project: project(),
        settings: settings(),
        initialName: "Fork",
        branchName: "b",
        refName: "HEAD",
        newRefName: "b",
      }),
    );
    expect(resolvedToRoot._tag).toBe("Failure");
    expect(String(resolvedToRoot)).toContain("resolved to the project root");
  });
});

describe("managed checkout path refusals", () => {
  /** The path's failure, with a policy that refuses every path inside the worktree root. */
  const pathFailure = (
    options: {
      readonly worktreeRoot?: string;
      readonly denied?: WorkspaceAccessDeniedError["reason"];
    } = {},
  ) => {
    const { deps } = fixture();
    const worktrees = path.join(root, "worktrees");
    const deny = (candidate: string, operation: string) =>
      options.denied !== undefined && candidate.startsWith(worktrees + path.sep)
        ? Effect.fail(
            new WorkspaceAccessDeniedError({
              operation,
              requestedPath: candidate,
              accessRoot: root,
              reason: options.denied,
            }),
          )
        : Effect.succeed(candidate);
    return Effect.runPromise(
      Effect.flip(
        resolveManagedCheckoutPath(
          {
            ...deps,
            workspaceAccessPolicy: {
              ...deps.workspaceAccessPolicy,
              assertPath: ({ path: candidate, operation }) => deny(candidate, operation),
            },
          },
          {
            operation: "test.allocate",
            project: project(),
            settings: {
              ...settings(),
              ...(options.worktreeRoot === undefined ? {} : { worktreeRoot: options.worktreeRoot }),
            },
            initialName: "Fork",
            branchName: "ryco/fork-ccccdddd",
          },
        ),
      ),
    );
  };

  it("refuses for good what only a change of settings or policy can fix", async () => {
    // The policy places the path outside its root.
    expect(isManagedCheckoutPathRefusal(await pathFailure({ denied: "outsideRoot" }))).toBe(true);
    // The worktree root setting cannot be used.
    expect(isManagedCheckoutPathRefusal(await pathFailure({ worktreeRoot: "relative/root" }))).toBe(
      true,
    );
  });

  it("lets a path the policy could not resolve, or could not reserve, be tried again", async () => {
    expect(isManagedCheckoutPathRefusal(await pathFailure({ denied: "unresolvable" }))).toBe(false);
    expect(isManagedCheckoutPathRefusal(gitError("database is locked"))).toBe(false);
  });
});

describe("owned checkout cleanup", () => {
  it("removes only owned resources and treats already-missing ones as removed", async () => {
    const { deps, calls, failures } = fixture();
    failures.set("removeWorktree", gitError("fatal: '/x' is not a working tree"));
    await Effect.runPromise(
      removeOwnedCheckout(deps, {
        operation: "test.cleanup",
        repositoryRoot: "/repo",
        owned: { worktreePath: "/worktrees/fork", branch: "ryco/fork-1" },
      }),
    );
    expect(calls).toEqual([
      { method: "removeWorktree", input: { cwd: "/repo", path: "/worktrees/fork", force: true } },
      { method: "deleteBranch", input: { cwd: "/repo", refName: "ryco/fork-1", force: true } },
    ]);

    calls.length = 0;
    await Effect.runPromise(
      removeOwnedCheckout(deps, {
        operation: "test.cleanup",
        repositoryRoot: "/repo",
        owned: { worktreePath: null, branch: null },
      }),
    );
    expect(calls).toEqual([]);
  });

  it("reports other failures, and the after-failure variant only logs them", async () => {
    const { deps, failures } = fixture();
    failures.set("deleteBranch", gitError("fatal: cannot lock ref"));
    const input = {
      operation: "test.cleanup",
      repositoryRoot: "/repo",
      owned: { worktreePath: null, branch: "ryco/fork-1" },
    };
    expect((await Effect.runPromiseExit(removeOwnedCheckout(deps, input)))._tag).toBe("Failure");
    expect((await Effect.runPromiseExit(cleanupOwnedCheckout(deps, input)))._tag).toBe("Success");
  });
});
