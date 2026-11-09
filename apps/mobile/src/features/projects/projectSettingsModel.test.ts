import { describe, expect, it, vi } from "vite-plus/test";

import type { Project } from "@ryco/client-runtime/state/threads";
import type {
  EnvironmentId,
  ProjectId,
  WorkspaceLifecycleSummary,
  WorktreeId,
} from "@ryco/contracts";

import {
  atlassianConnectionLabel,
  checkProjectRoot,
  copyProjectRouteParams,
  instructionsDraftView,
  projectCheckouts,
  projectSectionLabel,
  projectSettingsAccess,
  projectSettingsGroups,
  projectWorkspacesView,
  runSettingsWrite,
  workspaceReviewConversationCopy,
  workspaceRowDetail,
} from "./projectSettingsModel";
import { openCopyProject } from "./projectSettingsNavigation";

const NODE_A = "node-a" as EnvironmentId;
const NODE_B = "node-b" as EnvironmentId;
const NODE_C = "node-c" as EnvironmentId;

function project(input: {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly cwd: string;
  readonly canonicalKey?: string;
}): Project {
  return {
    environmentId: input.environmentId,
    id: input.id as ProjectId,
    name: "Ryco",
    cwd: input.cwd,
    defaultModelSelection: null,
    scripts: [],
    ...(input.canonicalKey
      ? {
          repositoryIdentity: {
            canonicalKey: input.canonicalKey,
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: `git@github.com:${input.canonicalKey}.git`,
            },
            remotes: [],
          },
        }
      : {}),
  };
}

const machine = (
  environmentId: EnvironmentId,
  label: string,
  connectionState: "connected" | "reconnecting" | "offline" | "read-only" = "connected",
) => ({ environmentId, label, connectionState });

describe("projectSettingsAccess", () => {
  it("lets an owner on a live machine change everything", () => {
    expect(
      projectSettingsAccess({
        label: "Mac mini",
        connectionState: "connected",
        role: "owner",
        mutationReady: true,
      }),
    ).toEqual({
      canEdit: true,
      reason: null,
      canManageNode: true,
      nodeReason: null,
      canInspectWorkspaces: true,
      canChangeWorkspaces: true,
    });
  });

  it("keeps the machine's own settings for its owner", () => {
    const operator = projectSettingsAccess({
      label: "Mac mini",
      connectionState: "connected",
      role: "operator",
      mutationReady: true,
    });
    expect(operator.canEdit).toBe(true);
    expect(operator.canManageNode).toBe(false);
    expect(operator.nodeReason).toContain("Only the owner of Mac mini");
    expect(operator.canChangeWorkspaces).toBe(true);
  });

  it("says once why nothing can change", () => {
    expect(projectSettingsAccess(null).reason).toBe("This machine is not connected to this phone.");
    expect(
      projectSettingsAccess({ label: "Mac mini", connectionState: "read-only", role: "viewer" }),
    ).toMatchObject({ canEdit: false, reason: "Your access to Mac mini is view-only." });
    expect(
      projectSettingsAccess({ label: "Mac mini", connectionState: "connected", role: "client" })
        .reason,
    ).toBe("Your access to Mac mini is view-only.");
    expect(
      projectSettingsAccess({ label: "Mac mini", connectionState: "reconnecting", role: "owner" })
        .reason,
    ).toBe("Connecting to Mac mini…");
    expect(
      projectSettingsAccess({
        label: "Mac mini",
        connectionState: "offline",
        role: "owner",
        stale: true,
      }).reason,
    ).toContain("cached copy");
    expect(
      projectSettingsAccess({
        label: "Mac mini",
        connectionState: "connected",
        role: "owner",
        mutationReady: false,
      }),
    ).toMatchObject({ canEdit: false, reason: "Connecting to Mac mini…" });
  });
});

describe("projectSettingsGroups", () => {
  it("orders sections as the web does and leaves out what the phone cannot edit", () => {
    expect(
      projectSettingsGroups({ canManageNode: true }).flatMap((group) => group.sections),
    ).toEqual([
      "devices",
      "location",
      "repository",
      "workspaces",
      "defaults",
      "actions",
      "instructions",
      "integrations",
      "danger",
    ]);
    const visitor = projectSettingsGroups({ canManageNode: false });
    expect(visitor.map((group) => group.label)).toEqual(["Project", "Agents", null]);
    expect(visitor.flatMap((group) => group.sections)).not.toContain("defaults");
    expect(projectSectionLabel("devices")).toBe("Machines");
    expect(projectSectionLabel("instructions")).toBe("Agent instructions");
  });
});

describe("projectCheckouts", () => {
  it("lists every machine with the repository, the one being edited first", () => {
    const here = project({ environmentId: NODE_B, id: "p-b", cwd: "/b/ryco", canonicalKey: "k" });
    const result = projectCheckouts({
      project: here,
      projects: [
        project({ environmentId: NODE_A, id: "p-a", cwd: "/a/ryco", canonicalKey: "k" }),
        here,
        project({ environmentId: NODE_A, id: "other", cwd: "/a/other", canonicalKey: "x" }),
      ],
      environments: [
        machine(NODE_A, "Alpha", "offline"),
        machine(NODE_B, "Beta"),
        machine(NODE_C, "Gamma"),
      ],
    });
    expect(result.checkouts.map((row) => [row.label, row.path, row.status, row.current])).toEqual([
      ["Beta", "/b/ryco", "Online", true],
      ["Alpha", "/a/ryco", "Offline", false],
    ]);
    expect(result.missing).toEqual([{ environmentId: NODE_C, label: "Gamma" }]);
  });

  it("never says an offline or cached machine lacks the project", () => {
    const here = project({ environmentId: NODE_A, id: "p", cwd: "/a/app" });
    const result = projectCheckouts({
      project: here,
      projects: [here, project({ environmentId: NODE_B, id: "q", cwd: "/a/app" })],
      environments: [
        machine(NODE_A, "Alpha"),
        machine(NODE_B, "Beta", "offline"),
        { ...machine(NODE_C, "Gamma"), stale: true },
      ],
    });
    // Without a repository identity, only the project's own machine has it.
    expect(result.checkouts.map((row) => row.environmentId)).toEqual([NODE_A]);
    expect(result.missing).toEqual([]);
  });

  it("opens the copy flow from this checkout to the machine picked", () => {
    const params = copyProjectRouteParams(
      { environmentId: NODE_A, projectId: "p" as ProjectId },
      { environmentId: NODE_C },
    );
    expect(params).toEqual({ environmentId: NODE_A, projectId: "p", targetEnvironmentId: NODE_C });
    const navigate = vi.fn();
    openCopyProject({ navigate }, params);
    expect(navigate).toHaveBeenCalledWith("CopyProject", params);
  });
});

describe("checkProjectRoot", () => {
  it("moves only to a different absolute folder", () => {
    expect(checkProjectRoot("/srv/app", "  ")).toEqual({ kind: "unchanged" });
    expect(checkProjectRoot("/srv/app", " /srv/app ")).toEqual({ kind: "unchanged" });
    expect(checkProjectRoot("/srv/app", "~/code/app")).toEqual({
      kind: "move",
      next: "~/code/app",
    });
    expect(checkProjectRoot("/srv/app", "code/app").kind).toBe("invalid");
  });
});

describe("instructionsDraftView", () => {
  it("shows Save only while the draft differs from the saved text", () => {
    expect(instructionsDraftView("Run tests.", null)).toMatchObject({
      value: "Run tests.",
      dirty: false,
      counterTone: "muted",
    });
    expect(instructionsDraftView("Run tests.", "Run tests.  ").dirty).toBe(false);
    const edited = instructionsDraftView(null, "  Prefer Effect.  ");
    expect(edited).toMatchObject({ dirty: true, next: "Prefer Effect." });
    expect(edited.counter).toBe(`18 / ${edited.max.toLocaleString("en-US")}`);
    expect(instructionsDraftView("Old", "   ").next).toBeNull();
    expect(instructionsDraftView(null, "x".repeat(edited.max)).counterTone).toBe("danger");
    expect(instructionsDraftView(null, "x".repeat(Math.floor(edited.max * 0.95))).counterTone).toBe(
      "warning",
    );
  });
});

describe("projectWorkspacesView", () => {
  const summary = (overrides: Partial<WorkspaceLifecycleSummary>) =>
    ({
      worktreeId: "wt-1" as WorktreeId,
      projectId: "p" as ProjectId,
      title: "Feature",
      branch: "feature",
      main: false,
      archivedAt: null,
      checkoutRemovedAt: null,
      checkout: "present",
      unmerged: false,
      changes: {
        modified: 2,
        untracked: 0,
        protectedIgnored: 0,
        protectedIgnoredSample: [],
        regenerableIgnored: 0,
        regenerableIgnoredSample: [],
        truncated: false,
      },
      conversations: { active: 1, archived: 0, trashed: 0 },
      activeWork: [],
      ...overrides,
    }) as WorkspaceLifecycleSummary;

  it("lists workspaces with their facts and size, the main checkout in the total only", () => {
    const view = projectWorkspacesView({
      summaries: [
        summary({ worktreeId: "main" as WorktreeId, main: true, title: "", branch: "main" }),
        summary({ title: "  ", archivedAt: "2026-11-01T00:00:00.000Z" }),
      ],
      disk: {
        status: "ready",
        refreshing: false,
        workspaces: [
          {
            worktreeId: "main" as WorktreeId,
            main: true,
            bytes: 1024 * 1024 * 1024,
            partial: false,
            measuredAt: "2026-11-01T00:00:00.000Z",
          },
          {
            worktreeId: "wt-1" as WorktreeId,
            main: false,
            bytes: 512 * 1024 * 1024,
            partial: true,
            measuredAt: "2026-11-01T00:00:00.000Z",
          },
        ],
      },
    });
    expect(view.diskTotal).toBe("At least 1.5 GB");
    expect(view.diskPartial).toBe(true);
    expect(view.rows).toHaveLength(1);
    const row = view.rows[0]!;
    expect(row).toMatchObject({
      title: "feature",
      archived: true,
      disk: "≥ 512 MB",
      actions: ["restore", "delete-workspace"],
    });
    expect(workspaceRowDetail(row)).toBe("Archived · 2 modified");
  });

  it("says when sizes are still being measured", () => {
    expect(projectWorkspacesView({ summaries: [], disk: { status: "loading" } }).diskTotal).toBe(
      "Measuring…",
    );
    expect(
      projectWorkspacesView({ summaries: [], disk: { status: "unavailable" } }).diskTotal,
    ).toBe("Unavailable");
  });
});

describe("small copy", () => {
  it("names connections and the conversation switch", () => {
    const connections = [{ connectionId: "atl-1", label: "Acme Jira" }];
    expect(atlassianConnectionLabel("Not configured", connections)).toBe("Not linked");
    expect(atlassianConnectionLabel("atl-1", connections)).toBe("Acme Jira");
    expect(workspaceReviewConversationCopy(1, false)).toEqual({
      label: "Also delete 1 conversation",
      detail: "They stay in the archive.",
    });
    expect(workspaceReviewConversationCopy(3, true).detail).toBe(
      "They are deleted with the workspace.",
    );
  });
});

describe("runSettingsWrite", () => {
  it("returns failures instead of throwing", async () => {
    await expect(
      runSettingsWrite({ canEdit: true, write: async () => undefined, fallback: "x" }),
    ).resolves.toEqual({ ok: true });
    await expect(
      runSettingsWrite({
        canEdit: true,
        write: async () => {
          throw new Error("Node said no.");
        },
        fallback: "x",
      }),
    ).resolves.toEqual({ ok: false, message: "Node said no." });
    const write = vi.fn();
    const refused = await runSettingsWrite({ canEdit: false, write, fallback: "x" });
    expect(refused.ok).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
