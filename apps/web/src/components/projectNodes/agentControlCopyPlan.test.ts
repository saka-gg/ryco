import type {
  AgentControlCopyProjectToNodePlan,
  EnvironmentApi,
  EnvironmentId,
  ProjectId,
  ServerConfig,
  ServerProvider,
} from "@ryco/contracts";
import type {
  NodePathHints,
  ProjectDestinationPreview,
  ProjectExportArtifactKind,
  ProjectExportInspection,
} from "@ryco/contracts/project-copy";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  agentControlCopyDestinationRequest,
  agentControlSetupMismatch,
  planAgentControlCopy,
  resolveAgentControlCopy,
  sameAgentControlCopyPreview,
  type AgentControlCopyFacts,
} from "./agentControlCopyPlan";

const SOURCE = "env-laptop" as EnvironmentId;
const TARGET = "env-mini" as EnvironmentId;
const MIB = 1024 * 1024;

const miniHints: NodePathHints = {
  homeDirectory: "/Users/me",
  pathSeparator: "/",
  defaultProjectDirectory: "/Users/me/Code",
  defaultProjectDirectorySource: "existing-projects",
  codeRoots: [],
  workspaceAccessRoot: null,
};

const preview = (
  resolvedPath: string,
  overrides: Partial<ProjectDestinationPreview> = {},
): ProjectDestinationPreview => ({
  resolvedPath,
  state: "available",
  existingProjectId: null,
  existingRepositoryCanonicalKey: null,
  suggestedPath: null,
  detail: null,
  ...overrides,
});

function inspection(
  overrides: {
    readonly unpushed?: number;
    readonly headOnRemote?: boolean;
    readonly changes?: number;
    readonly estimates?: Partial<Record<ProjectExportArtifactKind, number>>;
  } = {},
): ProjectExportInspection {
  const estimates = {
    "commits-bundle": MIB,
    "repository-bundle": 10 * MIB,
    "changes-patch": MIB,
    avatar: 10_000,
    ...overrides.estimates,
  };
  return {
    projectId: "project-ryco" as ProjectId,
    repository: {
      rootPath: "/Users/laptop/Developer/ryco",
      isGitRepository: true,
      branch: "main",
      headOid: "a".repeat(40),
      isDetached: false,
      remotes: [{ name: "origin", url: "git@github.com:me/ryco.git" }],
      primaryRemoteName: "origin",
      cloneRemoteName: "origin",
      canonicalKey: "github.com/me/ryco",
      isShallow: false,
      hasSubmodules: false,
      usesLfs: false,
    },
    pushedState: {
      headOnRemote: overrides.headOnRemote ?? true,
      upstreamBranch: "origin/main",
      unpushedCommitCount: overrides.unpushed ?? 0,
    },
    workingTree: {
      trackedChangeCount: overrides.changes ?? 0,
      untrackedCount: 0,
      hasConflicts: false,
      ignoredCandidates: [{ path: ".env", byteLength: 20 }],
    },
    settings: {
      title: "ryco",
      scripts: [],
      customSystemPrompt: null,
      preferredRemoteName: "origin",
      projectMetadataDir: ".ryco",
      hasCustomAvatar: true,
      overrides: {},
      relativeRootInRepository: "",
    },
    estimates: Object.entries(estimates).map(([kind, estimatedBytes]) => ({
      kind: kind as ProjectExportArtifactKind,
      estimatedBytes,
      skippedReason: null,
    })),
  };
}

const claude = {
  instanceId: "claude",
  driver: "claudeAgent",
  displayName: "Claude",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-22T10:00:00.000Z",
  models: [{ slug: "claude-opus-5-5", name: "Opus 5.5" }],
  slashCommands: [],
} as unknown as ServerProvider;

const miniConfig = (providers: ReadonlyArray<ServerProvider> = [claude]) =>
  ({
    providers,
    settings: { initialModelSelection: null },
  }) as unknown as Pick<ServerConfig, "providers" | "settings">;

function copyPlan(
  overrides: Partial<AgentControlCopyProjectToNodePlan> = {},
): AgentControlCopyProjectToNodePlan {
  return {
    kind: "copyProjectToNode",
    source: {
      kind: "project",
      projectId: "project-ryco" as ProjectId,
      title: "ryco",
      expectedUpdatedAt: "2026-10-22T09:00:00.000Z",
    },
    target: { environmentId: TARGET, label: "Mac mini" },
    destination: { kind: "default" },
    bringCommits: false,
    bringChanges: false,
    copySettings: true,
    setup: { command: "bun install", saveAsScript: false },
    followUpThread: {
      title: "Finish setting up ryco",
      prompt: "Install the toolchain and run the tests.",
      runtimeMode: "approval-required",
      envMode: "local",
      modelSelection: null,
    },
    ...overrides,
  } as AgentControlCopyProjectToNodePlan;
}

const available = (path: string) =>
  ({
    path,
    status: "available",
    basis: "default-directory",
    missingMirroredParent: null,
    takenPath: null,
    existingProjectId: null,
    detail: null,
    preview: preview(path),
  }) as const;

function facts(overrides: Partial<AgentControlCopyFacts> = {}): AgentControlCopyFacts {
  return {
    plan: copyPlan(),
    proposalId: "proposal-1",
    source: { environmentId: SOURCE, label: "Laptop", platformOs: "darwin", transport: "direct" },
    inspection: inspection(),
    target: {
      environmentId: TARGET,
      label: "Mac mini",
      platformOs: "darwin",
      transport: "direct",
      projectCopySupport: "yes",
    },
    targetPathSeparator: "/",
    remoteAccess: { reachable: true, alternateRemoteUrl: null, detail: null },
    destination: available("/Users/me/Code/ryco"),
    targetConfig: miniConfig(),
    ...overrides,
  };
}

describe("agentControlCopyDestinationRequest", () => {
  it("puts default and child-of-default copies into the target's code directory", () => {
    const sourceRepository = {
      rootPath: "/Users/laptop/Developer/ryco",
      pathSeparator: "/",
    } as const;
    expect(
      agentControlCopyDestinationRequest({
        plan: copyPlan(),
        sourceRepository,
        targetHints: miniHints,
      }),
    ).toEqual({
      kind: "candidate",
      request: expect.objectContaining({ leafName: "ryco", placement: "default" }),
    });
    expect(
      agentControlCopyDestinationRequest({
        plan: copyPlan({ destination: { kind: "child-of-default", name: "ryco-mini" } }),
        sourceRepository,
        targetHints: miniHints,
      }),
    ).toEqual({
      kind: "candidate",
      request: expect.objectContaining({ leafName: "ryco-mini", placement: "default" }),
    });
    expect(
      agentControlCopyDestinationRequest({
        plan: copyPlan({
          source: {
            kind: "repository",
            remoteUrl: "https://github.com/me/tools.git",
            title: "tools",
          },
        }),
        sourceRepository: null,
        targetHints: miniHints,
      }),
    ).toEqual({ kind: "candidate", request: expect.objectContaining({ leafName: "tools" }) });
    expect(
      agentControlCopyDestinationRequest({
        plan: copyPlan({ destination: { kind: "path", path: "~/work/ryco" } }),
        sourceRepository,
        targetHints: miniHints,
      }),
    ).toEqual({ kind: "path", path: "~/work/ryco" });
  });
});

describe("planAgentControlCopy", () => {
  it("builds the run plan with the plan's options, setup and the target's default model", () => {
    const resolution = planAgentControlCopy(facts());

    expect(resolution.preview).toEqual({
      targetLabel: "Mac mini",
      destination: {
        path: "/Users/me/Code/ryco",
        tag: "new folder",
        note: "Mac mini's code directory.",
      },
      followUpModel: "Opus 5.5 · Claude",
      problem: null,
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.runPlan).toMatchObject({
      title: "ryco",
      source: { kind: "export", environmentId: SOURCE, projectId: "project-ryco" },
      target: { environmentId: TARGET, label: "Mac mini", pathSeparator: "/" },
      destinationPath: "/Users/me/Code/ryco",
      choices: {
        mode: "clone",
        bringCommits: false,
        bringChanges: false,
        ignoredPaths: [],
        copySettings: true,
        copyAvatar: true,
      },
      setup: { command: "bun install", saveAsScript: false },
      followUpThread: {
        title: "Finish setting up ryco",
        runtimeMode: "approval-required",
        envMode: "local",
        modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
      },
      origin: { kind: "agent-control", sourceLabel: "Laptop", proposalId: "proposal-1" },
      // A failed clone is never retried by sending more than the plan names.
      sendFilesFallback: false,
    });
  });

  it("names the model the plan pins, and refuses a setup thread with no model", () => {
    const pinned = planAgentControlCopy(
      facts({
        plan: copyPlan({
          followUpThread: {
            title: "Finish setting up ryco",
            prompt: "Go.",
            runtimeMode: "approval-required",
            envMode: "local",
            modelSelection: { instanceId: "claude", model: "claude-opus-5-5" } as never,
          },
        }),
        targetConfig: null,
      }),
    );
    expect(pinned.preview.followUpModel).toBe("claude-opus-5-5");
    expect(pinned.ok).toBe(true);

    const none = planAgentControlCopy(facts({ targetConfig: miniConfig([]) }));
    expect(none.ok).toBe(false);
    expect(none.preview.problem).toBe(
      "No agent provider is ready on Mac mini, so the setup thread can't start.",
    );
  });

  it("shows a taken folder as renamed and a checkout of the same repository as linked", () => {
    const renamed = planAgentControlCopy(
      facts({
        destination: {
          ...available("/Users/me/Code/ryco-2"),
          status: "renamed",
          takenPath: "/Users/me/Code/ryco",
        },
      }),
    );
    expect(renamed.preview.destination).toEqual({
      path: "/Users/me/Code/ryco-2",
      tag: "renamed, folder exists",
      note: "/Users/me/Code/ryco is taken on Mac mini.",
    });

    const linked = planAgentControlCopy(
      facts({
        destination: {
          ...available("/Users/me/Code/ryco"),
          status: "link",
          preview: preview("/Users/me/Code/ryco", {
            state: "is-git-repository",
            existingRepositoryCanonicalKey: "github.com/me/ryco",
          }),
        },
      }),
    );
    expect(linked.preview.destination?.tag).toBe("existing checkout");
    expect(linked.ok && linked.runPlan.choices.mode).toBe("link");
  });

  it("brings nothing when there is nothing to bring, and refuses what it can't send", () => {
    // Asked for, but nothing is unpushed and nothing changed: fine.
    const nothing = planAgentControlCopy(
      facts({ plan: copyPlan({ bringCommits: true, bringChanges: true }) }),
    );
    expect(nothing.ok).toBe(true);

    // Over the Hub's cap, the commits can't travel.
    const relayed = planAgentControlCopy(
      facts({
        plan: copyPlan({ bringCommits: true }),
        inspection: inspection({
          unpushed: 3,
          headOnRemote: false,
          estimates: { "commits-bundle": 40 * MIB },
        }),
        target: { ...facts().target, transport: "relay" },
      }),
    );
    expect(relayed.ok).toBe(false);
    expect(relayed.preview.problem).toMatch(/^Can't bring the unpushed commits: Too large to send/);

    // The changes need the unpushed commits, which the plan leaves out.
    const forced = planAgentControlCopy(
      facts({
        plan: copyPlan({ bringChanges: true }),
        inspection: inspection({ unpushed: 2, headOnRemote: false, changes: 3 }),
      }),
    );
    expect(forced.preview.problem).toBe(
      "The uncommitted changes need the unpushed commits, which this request does not bring.",
    );
  });

  it("never falls back to sending the files", () => {
    const unreachable = planAgentControlCopy(
      facts({
        remoteAccess: {
          reachable: false,
          alternateRemoteUrl: null,
          detail: "host-key-unknown github.com",
        },
      }),
    );
    expect(unreachable.ok).toBe(false);
    expect(unreachable.preview.problem).toBe(
      "Mac mini can't reach the remote (host-key-unknown github.com). Copy it from the Projects page to send the files instead.",
    );

    const local = planAgentControlCopy(
      facts({
        inspection: {
          ...inspection(),
          repository: {
            ...inspection().repository,
            remotes: [{ name: "origin", url: "/srv/git/ryco.git" }],
          },
        },
      }),
    );
    expect(local.ok).toBe(false);
    expect(local.preview.problem).toBe(
      "Its remote can only be reached from the source; send the files instead. Copy it from the Projects page to do that.",
    );
  });

  it("refuses a destination that is already this project, and an unknown target support", () => {
    const existing = planAgentControlCopy(
      facts({
        destination: {
          ...available("/Users/me/Code/ryco"),
          status: "existing-project",
          existingProjectId: "project-mini" as ProjectId,
        },
      }),
    );
    expect(existing.preview.problem).toBe("ryco is already on Mac mini at /Users/me/Code/ryco.");
    expect(existing.preview.destination?.tag).toBe("unavailable");

    const old = planAgentControlCopy(
      facts({ target: { ...facts().target, projectCopySupport: "no" } }),
    );
    expect(old.preview.problem).toBe("Update Ryco on Mac mini to copy projects here.");
  });
});

describe("agentControlSetupMismatch", () => {
  it("passes only the approved command, as the target reads it", () => {
    const approved = { command: "bun install", saveAsScript: true };
    expect(agentControlSetupMismatch(approved, { ...approved })).toBeNull();
    expect(agentControlSetupMismatch(null, null)).toBeNull();
    const refused =
      "The setup command this copy would run differs from the approved one, so nothing was run.";
    expect(agentControlSetupMismatch(approved, { command: "bun i", saveAsScript: true })).toBe(
      refused,
    );
    expect(agentControlSetupMismatch(approved, { ...approved, saveAsScript: false })).toBe(refused);
    expect(agentControlSetupMismatch(approved, null)).toBe(refused);
    expect(agentControlSetupMismatch(null, approved)).toBe(refused);
    // The target trims what it decodes: an untrimmed approved command would change on the way.
    expect(
      agentControlSetupMismatch(
        { command: " bun install ", saveAsScript: false },
        { command: " bun install ", saveAsScript: false },
      ),
    ).toBe(refused);
  });

  it("makes the run fail before anything is sent", () => {
    const resolution = planAgentControlCopy(
      facts({ plan: copyPlan({ setup: { command: "bun install\n", saveAsScript: false } }) }),
    );
    expect(resolution.ok).toBe(false);
    expect(resolution.preview.problem).toBe(
      "The setup command this copy would run differs from the approved one, so nothing was run.",
    );
  });
});

describe("sameAgentControlCopyPreview", () => {
  it("compares what the card shows", () => {
    const shown = planAgentControlCopy(facts()).preview;
    expect(sameAgentControlCopyPreview(shown, { ...shown })).toBe(true);
    expect(
      sameAgentControlCopyPreview(shown, {
        ...shown,
        destination: { path: "/Users/me/Code/ryco-2", tag: "renamed, folder exists", note: null },
      }),
    ).toBe(false);
    expect(sameAgentControlCopyPreview(shown, { ...shown, followUpModel: "GPT-5.6 · Codex" })).toBe(
      false,
    );
  });
});

describe("resolveAgentControlCopy", () => {
  it("inspects the source, previews the target's folder and checks its remote access", async () => {
    const exportInspect = vi.fn(async () => inspection());
    const previewDestination = vi.fn(async ({ path }: { path: string }) => preview(path));
    const checkRemoteAccess = vi.fn(async () => ({
      reachable: true,
      alternateRemoteUrl: null,
      detail: null,
    }));
    const sourceApi = {
      projects: {
        exportInspect,
        pathHints: async () => ({ ...miniHints, homeDirectory: "/Users/laptop" }),
      },
    } as unknown as EnvironmentApi;
    const targetApi = {
      projects: { pathHints: async () => miniHints, previewDestination, checkRemoteAccess },
    } as unknown as EnvironmentApi;

    const resolution = await resolveAgentControlCopy({
      plan: copyPlan(),
      proposalId: "proposal-1",
      source: {
        environmentId: SOURCE,
        label: "Laptop",
        platformOs: "darwin",
        transport: "direct",
        api: sourceApi,
      },
      target: {
        environmentId: TARGET,
        label: "Mac mini",
        platformOs: "darwin",
        transport: "relay",
        projectCopySupport: "yes",
        api: targetApi,
      },
      readTargetConfig: async () => miniConfig() as ServerConfig,
    });

    expect(exportInspect).toHaveBeenCalledWith({ projectId: "project-ryco" });
    expect(previewDestination).toHaveBeenCalledWith({
      path: "/Users/me/Code/ryco",
      suggested: true,
    });
    expect(checkRemoteAccess).toHaveBeenCalledWith({ remoteUrl: "git@github.com:me/ryco.git" });
    expect(resolution.ok && resolution.runPlan.destinationPath).toBe("/Users/me/Code/ryco");
    expect(resolution.preview.followUpModel).toBe("Opus 5.5 · Claude");
  });

  it("asks for an update when the target lacks project copy", async () => {
    const resolution = await resolveAgentControlCopy({
      plan: copyPlan(),
      proposalId: "proposal-1",
      source: {
        environmentId: SOURCE,
        label: "Laptop",
        platformOs: null,
        transport: null,
        api: null,
      },
      target: {
        environmentId: TARGET,
        label: "Mac mini",
        platformOs: null,
        transport: null,
        projectCopySupport: "yes",
        api: { projects: {} } as unknown as EnvironmentApi,
      },
      readTargetConfig: async () => null,
    }).catch((error: Error) => error);
    expect(resolution).toBeInstanceOf(Error);
    expect((resolution as Error).message).toBe("Update Ryco on Mac mini to copy projects.");
  });
});
