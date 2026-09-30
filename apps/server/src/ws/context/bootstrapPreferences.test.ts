import { describe, expect, it, vi } from "vitest";
import { Effect, Option } from "effect";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationProjectShell,
  type ThreadTurnStartBootstrap,
} from "@ryco/contracts";
import { applyServerSettingsPatch } from "@ryco/shared/serverSettings";
import { resolveBootstrapPreferences } from "./bootstrapPreferences.ts";

const id = ProjectId.make("project");
const explicitModel = {
  instanceId: ProviderInstanceId.make("caller"),
  model: "caller",
  options: [{ id: "fastMode", value: true }],
};
const createThread = {
  projectId: id,
  title: "Draft",
  modelSelection: explicitModel,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  createdAt: "2026-08-18T00:00:00.000Z",
};
const prepareWorktree = { projectCwd: "/fixture/project", baseBranch: "main" };

function fixture(
  runSetupScript: boolean,
  project: OrchestrationProjectShell | null = {
    id,
    workspaceRoot: prepareWorktree.projectCwd,
    defaultModelSelection: null,
  } as OrchestrationProjectShell,
) {
  const readSettings = vi.fn(() =>
    applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      initialModelSelection: { instanceId: ProviderInstanceId.make("node"), model: "node" },
      projectPreferences: {
        [id]: {
          runSetupScript,
          worktreeBranchPrefix: "project/tasks",
          defaultThreadEnvMode: "worktree",
        },
      },
    }),
  );
  const readProject = vi.fn(() => Effect.succeed(Option.fromNullishOr(project)));
  const readProjectByRoot = vi.fn(() =>
    Effect.succeed(Option.fromNullishOr(project ? { ...project, deletedAt: null } : null)),
  );
  const authorize = vi.fn(({ path }: { path: string }) => Effect.succeed(path));
  return {
    input: {
      settings: { getSettings: Effect.sync(readSettings) },
      projects: {
        getProjectShellById: readProject,
        getActiveProjectByWorkspaceRoot: readProjectByRoot,
      },
      workspaceAccess: { assertExistingPath: authorize },
    },
    readSettings,
    readProject,
    authorize,
  };
}

describe("authoritative bootstrap preferences", () => {
  it.each([true, false])(
    "inherits setup=%s for a new checkout using one authorized snapshot",
    async (runSetupScript) => {
      const f = fixture(runSetupScript);
      const result = await Effect.runPromise(
        resolveBootstrapPreferences({ ...f.input, bootstrap: { createThread, prepareWorktree } }),
      );
      expect(result.runSetupScript).toBe(runSetupScript);
      expect(result.choices.modelSelection).toEqual(explicitModel);
      expect(result.choices.worktreeBranchPrefix).toBe("project/tasks");
      expect(result.choices.envMode).toBe("worktree");
      expect(f.readSettings).toHaveBeenCalledOnce();
      expect(f.readProject).toHaveBeenCalledOnce();
      expect(f.authorize).toHaveBeenCalledOnce();
    },
  );

  it.each([true, false])(
    "preserves an explicit setup=%s instead of the opposite inherited value",
    async (runSetupScript) => {
      const f = fixture(!runSetupScript);
      const result = await Effect.runPromise(
        resolveBootstrapPreferences({
          ...f.input,
          bootstrap: { createThread, prepareWorktree, runSetupScript },
        }),
      );
      expect(result.runSetupScript).toBe(runSetupScript);
    },
  );

  it("keeps setup opt-in for an existing checkout and resolves project by root when no createThread is supplied", async () => {
    const f = fixture(true);
    const existing: ThreadTurnStartBootstrap = {
      createThread: { ...createThread, worktreePath: "/fixture/existing" },
    };
    expect(
      (await Effect.runPromise(resolveBootstrapPreferences({ ...f.input, bootstrap: existing })))
        .runSetupScript,
    ).toBe(false);
    const resolved = await Effect.runPromise(
      resolveBootstrapPreferences({ ...f.input, bootstrap: { prepareWorktree } }),
    );
    expect(resolved.runSetupScript).toBe(true);
    expect(resolved.project?.id).toBe(id);
  });

  it("rejects deleted projects and a mismatched checkout root before any mutation", async () => {
    const missing = fixture(true, null);
    await expect(
      Effect.runPromise(
        resolveBootstrapPreferences({
          ...missing.input,
          bootstrap: { createThread, prepareWorktree },
        }),
      ),
    ).rejects.toThrow("unavailable");
    expect(missing.authorize).not.toHaveBeenCalled();
    const f = fixture(true);
    await expect(
      Effect.runPromise(
        resolveBootstrapPreferences({
          ...f.input,
          bootstrap: {
            createThread,
            prepareWorktree: { ...prepareWorktree, projectCwd: "/fixture/other" },
          },
        }),
      ),
    ).rejects.toThrow("does not match");
    expect(f.authorize).toHaveBeenCalledTimes(2);
  });

  it("propagates a denied workspace instead of resolving authority from defaults", async () => {
    const f = fixture(true);
    const workspaceAccess = {
      assertExistingPath: () => Effect.fail(new Error("Workspace denied")),
    };
    await expect(
      Effect.runPromise(
        resolveBootstrapPreferences({
          ...f.input,
          workspaceAccess: workspaceAccess as never,
          bootstrap: { createThread, prepareWorktree },
        }),
      ),
    ).rejects.toThrow("Workspace denied");
  });

  it("rejects a mismatched project result and uses only the selected project snapshot for a batch", async () => {
    const f = fixture(false);
    const bootstrap = { createThread, prepareWorktree, requireWorktree: true };
    const resolved = await Effect.runPromise(
      resolveBootstrapPreferences({ ...f.input, bootstrap }),
    );
    expect(resolved.runSetupScript).toBe(false);
    expect(f.readSettings).toHaveBeenCalledOnce();
    expect(f.readProject).toHaveBeenCalledExactlyOnceWith(id);
    const wrongProject = fixture(false, {
      id: ProjectId.make("other"),
      workspaceRoot: prepareWorktree.projectCwd,
      defaultModelSelection: null,
    } as OrchestrationProjectShell);
    await expect(
      Effect.runPromise(resolveBootstrapPreferences({ ...wrongProject.input, bootstrap })),
    ).rejects.toThrow("selected node project");
    expect(wrongProject.authorize).not.toHaveBeenCalled();
  });
});
