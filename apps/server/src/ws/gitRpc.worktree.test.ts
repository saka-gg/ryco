import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, ProjectId, WS_METHODS } from "@ryco/contracts";
import { selectWorktreeSubmodules } from "@ryco/shared/worktreeSubmodules";
import type { GitWorkflowServiceShape } from "../git/GitWorkflowService.ts";
import { toGitManagerError } from "./context/gitErrors.ts";
import type { GitVcsDriverShape } from "../vcs/GitVcsDriver.ts";
import { makeGitHandlers } from "./gitRpc.ts";
import type { WsRpcContext } from "./context.ts";

// Exercise the real VCS handler boundary. Server-derived project context must
// accompany explicit paths as well as computed paths, without a client policy input.
describe("VCS worktree project policy context", () => {
  it.each([null, "/authorized/checkouts/explicit"])(
    "passes registered project context for path %s",
    async (checkoutPath) => {
      const projectId = ProjectId.make("registered-project");
      const createWorktree = vi.fn((_input: Parameters<GitVcsDriverShape["createWorktree"]>[0]) =>
        Effect.succeed({ worktree: { path: "/authorized/checkouts/created", refName: "feature" } }),
      );
      const getProject = vi.fn(() => Effect.succeed(Option.some({ id: projectId })));
      const ctx = {
        ownerEffect: (_method: string, effect: Effect.Effect<unknown>) => effect,
        gitWorkflow: { createWorktree },
        refreshGitStatus: () => Effect.void,
        projectionSnapshotQuery: { getActiveProjectByWorkspaceRoot: getProject },
        serverSettings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
        config: { worktreesDir: "/authorized/checkouts" },
        toGitManagerError: (_op: string, message: string) => new Error(message),
      } as unknown as WsRpcContext;
      const handlers = makeGitHandlers(ctx);
      await Effect.runPromise(
        handlers[WS_METHODS.vcsCreateWorktree]({
          cwd: "/authorized/project",
          path: checkoutPath,
          refName: "main",
          newRefName: "feature",
        }),
      );
      expect(getProject).toHaveBeenCalledWith("/authorized/project");
      expect(createWorktree.mock.calls[0]?.[0]).toMatchObject({
        projectId,
        cwd: "/authorized/project",
      });
      expect(createWorktree.mock.calls[0]?.[0].settingsSnapshot).toBe(DEFAULT_SERVER_SETTINGS);
      if (checkoutPath !== null)
        expect(createWorktree.mock.calls[0]?.[0]).toMatchObject({ path: checkoutPath });
    },
  );
});

describe("PR worktree project binding", () => {
  let base: string;
  let cwdA: string;
  let cwdB: string;
  const idA = ProjectId.make("project-a");
  const idB = ProjectId.make("project-b");
  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(os.tmpdir(), "ryco-pr-binding-")));
    cwdA = path.join(base, "a");
    cwdB = path.join(base, "b");
    await mkdir(cwdA);
    await mkdir(cwdB);
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function harness() {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectWorktreeSubmodules: { [idA]: "none" as const, [idB]: "recursive" as const },
      projectWorktreeRoots: { [idA]: path.join(base, "root-a"), [idB]: path.join(base, "root-b") },
    };
    const projects = [
      { id: idA, workspaceRoot: cwdA, projectMetadataDir: ".meta-a" },
      { id: idB, workspaceRoot: cwdB, projectMetadataDir: ".meta-b" },
    ];
    const getProject = vi.fn((cwd: string) =>
      Effect.succeed(Option.fromNullishOr(projects.find((p) => p.workspaceRoot === cwd))),
    );
    const getById = vi.fn(() => Effect.die("Caller ID lookup must not be used"));
    const prepare = vi.fn(
      (_input: Parameters<GitWorkflowServiceShape["preparePullRequestThread"]>[0]) =>
        Effect.succeed({}),
    );
    const authorize = vi.fn(({ path: cwd }: { path: string }) => Effect.succeed(path.resolve(cwd)));
    const loadSettings = vi.fn(() => settings);
    const ctx = {
      ownerEffect: (_method: string, effect: Effect.Effect<unknown>) => effect,
      workspaceAccessPolicy: { assertExistingPath: authorize },
      projectionSnapshotQuery: {
        getActiveProjectByWorkspaceRoot: getProject,
        getProjectShellById: getById,
      },
      serverSettings: { getSettings: Effect.sync(loadSettings) },
      gitWorkflow: { preparePullRequestThread: prepare },
      refreshGitStatus: () => Effect.void,
      config: { worktreesDir: path.join(base, "default") },
      toGitManagerError,
    } as unknown as WsRpcContext;
    return {
      prepare,
      getProject,
      getById,
      authorize,
      loadSettings,
      settings,
      run: (input: {
        cwd: string;
        projectId?: ProjectId;
        worktreesDir?: string;
        worktreeLocation?: "appManaged" | "projectMetadata";
      }) =>
        Effect.runPromise(
          makeGitHandlers(ctx)[WS_METHODS.gitPreparePullRequestThread]({
            reference: "1",
            mode: "worktree",
            ...input,
          }),
        ),
    };
  }

  it.each(["project-a", "stale", "unknown"])(
    "rejects unrelated or stale ID %s before Git or settings selection",
    async (id) => {
      const h = harness();
      await expect(h.run({ cwd: cwdB, projectId: ProjectId.make(id) })).rejects.toThrow(
        "does not match",
      );
      expect(h.prepare).not.toHaveBeenCalled();
      expect(h.loadSettings).not.toHaveBeenCalled();
      expect(h.getById).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])("derives B policy from cwd with explicit ID %s", async (explicit) => {
    const h = harness();
    await h.run({ cwd: cwdB, ...(explicit ? { projectId: idB } : {}) });
    const input = h.prepare.mock.calls[0]![0];
    expect(input.projectId).toBe(idB);
    expect(input.worktreesDir).toBe(path.join(base, "root-b", idB));
    expect(input.settingsSnapshot).toBe(h.settings);
    expect(
      selectWorktreeSubmodules({ settings: input.settingsSnapshot!, projectId: input.projectId })
        .mode,
    ).toBe("recursive");
    expect(selectWorktreeSubmodules({ settings: h.settings, projectId: idA }).mode).toBe("none");
  });

  it("accepts canonical aliases while preserving explicit directories and project metadata selection", async () => {
    const alias = path.join(base, "alias-b");
    await symlink(cwdB, alias, "dir");
    const h = harness();
    await h.run({ cwd: alias, projectId: idB, worktreesDir: path.join(base, "explicit") });
    expect(h.prepare.mock.calls[0]![0]).toMatchObject({
      cwd: alias,
      projectId: idB,
      worktreesDir: path.join(base, "explicit"),
    });
    await h.run({ cwd: alias, projectId: idB, worktreeLocation: "projectMetadata" });
    expect(h.prepare.mock.calls[1]![0].worktreesDir).toBe(path.join(alias, ".meta-b", "worktrees"));
    await expect(h.run({ cwd: alias, projectId: idA })).rejects.toThrow("does not match");
  });

  it("uses node defaults for an unregistered repository but rejects an explicit ID", async () => {
    const h = harness();
    await expect(h.run({ cwd: base, projectId: idA })).rejects.toThrow("does not match");
    await h.run({ cwd: base });
    expect(h.prepare.mock.calls[0]![0].projectId).toBeUndefined();
  });

  it("rejects unauthorized cwd before project discovery", async () => {
    const h = harness();
    h.authorize.mockReturnValueOnce(Effect.fail(toGitManagerError("authorize", "denied")) as never);
    await expect(h.run({ cwd: cwdB })).rejects.toThrow("denied");
    expect(h.getProject).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled();
  });
});
