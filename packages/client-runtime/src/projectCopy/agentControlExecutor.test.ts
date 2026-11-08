import type { ProjectCopyJobRecord } from "./index.ts";
import type { AcquiredNode, NodeCatalogEntry, NodeCatalogSnapshot } from "../state/nodes/index.ts";
import type {
  AgentControlCopyProjectToNodePlan,
  AgentControlProposalId,
  AgentControlProposalReceiptView,
  AgentControlProposalStatus,
  AgentControlProposalView,
  EnvironmentApi,
  EnvironmentId,
  ProjectId,
  ServerConfig,
  ServerProvider,
} from "@ryco/contracts";
import { AgentControlRpcError } from "@ryco/contracts/agent-control";
import type {
  NodePathHints,
  ProjectDestinationPreview,
  ProjectExportInspection,
} from "@ryco/contracts/project-copy";
import { describe, expect, it, vi, type Mock } from "vite-plus/test";

import {
  rebuildAgentControlCopyPlanWith,
  startAgentControlCopyExecutor,
  type AgentControlClientExecutionPreviewState,
  type AgentControlCopyExecutorDeps,
} from "./agentControlExecutor.ts";

const LAPTOP = "env-laptop" as EnvironmentId;
const MINI = "env-mini" as EnvironmentId;
const PROPOSAL = "proposal-1" as AgentControlProposalId;
const EXECUTOR_ID = "c0a8f3d2-4b1e-4f6a-9d2c-7e5b3a1f0c9d";

function node(overrides: Partial<NodeCatalogEntry> = {}): NodeCatalogEntry {
  return {
    environmentId: MINI,
    label: "Mac mini",
    isPrimary: false,
    isThisDevice: false,
    presence: "online",
    platformOs: "darwin",
    iconKind: null,
    canMutate: true,
    mutateBlockedReason: null,
    projectCopySupport: "yes",
    transport: "direct",
    lastSeenAt: null,
    ...overrides,
  };
}

const laptop = node({ environmentId: LAPTOP, label: "Laptop", isPrimary: true });

const catalogOf = (
  nodes: ReadonlyArray<NodeCatalogEntry>,
  owners: ReadonlyArray<EnvironmentId> = [],
): NodeCatalogSnapshot => ({ nodes, ownerEnvironmentIds: new Set(owners) });

const hints: NodePathHints = {
  homeDirectory: "/Users/me",
  pathSeparator: "/",
  defaultProjectDirectory: "/Users/me/Code",
  defaultProjectDirectorySource: "existing-projects",
  codeRoots: [],
  workspaceAccessRoot: null,
};

const preview = (resolvedPath: string): ProjectDestinationPreview => ({
  resolvedPath,
  state: "available",
  existingProjectId: null,
  existingRepositoryCanonicalKey: null,
  suggestedPath: null,
  detail: null,
});

const inspection = {
  projectId: "project-ryco",
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
  pushedState: { headOnRemote: true, upstreamBranch: "origin/main", unpushedCommitCount: 0 },
  workingTree: {
    trackedChangeCount: 0,
    untrackedCount: 0,
    hasConflicts: false,
    ignoredCandidates: [],
  },
  settings: {
    title: "ryco",
    scripts: [],
    customSystemPrompt: null,
    preferredRemoteName: "origin",
    projectMetadataDir: ".ryco",
    hasCustomAvatar: false,
    overrides: {},
    relativeRootInRepository: "",
  },
  estimates: [],
} as unknown as ProjectExportInspection;

const config = {
  providers: [
    {
      instanceId: "claude",
      driver: "claudeAgent",
      displayName: "Claude",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: [{ slug: "claude-opus-5-5", name: "Opus 5.5" }],
      slashCommands: [],
    } as unknown as ServerProvider,
  ],
  settings: { initialModelSelection: null },
} as unknown as ServerConfig;

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
    target: { environmentId: MINI, label: "Mac mini" },
    destination: { kind: "default" },
    bringCommits: false,
    bringChanges: false,
    copySettings: true,
    setup: { command: "bun install", saveAsScript: false },
    followUpThread: {
      title: "Finish setting up ryco",
      prompt: "Install the toolchain.",
      runtimeMode: "approval-required",
      envMode: "local",
      modelSelection: null,
    },
    ...overrides,
  } as AgentControlCopyProjectToNodePlan;
}

function proposal(
  plan: AgentControlCopyProjectToNodePlan = copyPlan(),
  status: AgentControlProposalStatus = "pending-user-approval",
): AgentControlProposalView {
  return {
    proposalId: PROPOSAL,
    status,
    plan,
    result: null,
  } as unknown as AgentControlProposalView;
}

const receipt = (
  status: AgentControlProposalStatus,
  result: AgentControlProposalReceiptView["result"] = null,
) => ({ proposalId: PROPOSAL, status, result }) as unknown as AgentControlProposalReceiptView;

function heldNode(
  environmentId: EnvironmentId,
  api: unknown,
): AcquiredNode & { readonly release: Mock<() => void> } {
  return {
    environmentId,
    api: api as EnvironmentApi,
    transport: "direct",
    isCurrent: () => true,
    isConnected: () => true,
    withLease: (call) => call(api as EnvironmentApi),
    release: vi.fn<() => void>(),
  };
}

function harness(overrides: Partial<AgentControlCopyExecutorDeps> = {}) {
  const events: string[] = [];
  let catalog = catalogOf([laptop, node()]);
  let catalogListener: () => void = () => undefined;
  let tier: "phone" | "desktop" = "desktop";
  let tierListener: () => void = () => undefined;
  const proposals = new Map<AgentControlProposalId, AgentControlProposalView>();
  const followers = new Set<(proposal: AgentControlProposalView) => void>();
  const setStreamStatus = (status: AgentControlProposalStatus) => {
    const next = proposal(copyPlan(), status);
    proposals.set(PROPOSAL, next);
    if (status === "executing") events.push("executing");
    for (const follower of followers) follower(next);
  };
  const holds: Array<ReturnType<typeof heldNode>> = [];
  const hold = {
    release: vi.fn<() => void>(() => {
      events.push("release");
    }),
    reportNotStarted: vi.fn<(message: string) => void>(),
  };
  const targetApi = {
    projects: {
      pathHints: vi.fn(async () => hints),
      previewDestination: vi.fn(async ({ path }: { path: string }) => preview(path)),
      checkRemoteAccess: vi.fn(async () => ({
        reachable: true,
        alternateRemoteUrl: null,
        detail: null,
      })),
    },
  };
  const sourceApi = {
    projects: {
      exportInspect: vi.fn(async () => inspection),
      pathHints: vi.fn(async () => ({ ...hints, homeDirectory: "/Users/laptop" })),
    },
    agentControl: {
      getProposal: vi.fn(async () => ({ proposal: proposals.get(PROPOSAL) ?? null })),
    },
  };
  const agentControlApi = {
    acceptProposal: vi.fn(async (_input: unknown): Promise<AgentControlProposalReceiptView> => {
      events.push("accept");
      return receipt("approved");
    }),
    getProposal: vi.fn(async () => ({ proposal: proposals.get(PROPOSAL) ?? null })),
  };
  const deps: AgentControlCopyExecutorDeps = {
    readCatalog: () => catalog,
    subscribeCatalog: (listener) => {
      catalogListener = listener;
      return () => undefined;
    },
    readTier: () => tier,
    subscribeTier: (listener) => {
      tierListener = listener;
      return () => undefined;
    },
    isHosted: () => false,
    acquireForRead: async (environmentId) => {
      const held = heldNode(environmentId, environmentId === MINI ? targetApi : sourceApi);
      holds.push(held);
      return held;
    },
    readServerConfig: async () => config,
    readProjectUpdatedAt: () => "2026-10-22T09:00:00.000Z",
    readAgentControlApi: () => agentControlApi as unknown as EnvironmentApi["agentControl"],
    followProposal: (_environmentId, proposalId, onProposal) => {
      const current = proposals.get(proposalId);
      if (current) onProposal(current);
      followers.add(onProposal);
      return () => {
        followers.delete(onProposal);
      };
    },
    startCopy: vi.fn(async () => {
      events.push("start");
      return { copyId: "copy-1", done: new Promise(() => undefined) } as never;
    }),
    holdCopyStart: vi.fn(async () => {
      events.push("hold");
      return hold;
    }),
    uuid: () => EXECUTOR_ID,
    executingTimeoutMs: 1_000,
    acceptRetryDelayMs: 0,
    ...overrides,
  };
  const source = startAgentControlCopyExecutor(deps);
  return {
    source,
    deps,
    hold,
    events,
    followers,
    holds,
    targetApi,
    sourceApi,
    agentControlApi,
    setStreamStatus,
    setCatalog: (next: NodeCatalogSnapshot) => {
      catalog = next;
      catalogListener();
    },
    setTier: (next: "phone" | "desktop") => {
      tier = next;
      tierListener();
    },
  };
}

const target = {
  environmentId: MINI,
  label: "Mac mini",
} as AgentControlCopyProjectToNodePlan["target"];

async function loadPreview(
  test: ReturnType<typeof harness>,
  view: AgentControlProposalView = proposal(),
): Promise<AgentControlClientExecutionPreviewState | null> {
  const previews = test.source.getExecutor().previews!;
  previews.load({ environmentId: LAPTOP, proposal: view });
  await vi.waitFor(() => expect(previews.read(PROPOSAL)?.status).toBe("ready"));
  return previews.read(PROPOSAL);
}

describe("canExecute", () => {
  it("runs copies only against reachable, writable nodes this client knows, never on a phone", () => {
    const test = harness();
    const canExecute = () => test.source.getExecutor().canExecute(target);
    expect(canExecute()).toBe(true);

    test.setCatalog(catalogOf([laptop]));
    expect(canExecute()).toBe(false);

    test.setCatalog(catalogOf([laptop, node({ projectCopySupport: "no" })]));
    expect(canExecute()).toBe(false);

    test.setCatalog(
      catalogOf([laptop, node({ canMutate: false, mutateBlockedReason: "Pair again as owner" })]),
    );
    expect(canExecute()).toBe(false);

    // Offline or not connected yet: worth connecting to find out.
    test.setCatalog(
      catalogOf([
        laptop,
        node({
          presence: "offline",
          canMutate: false,
          projectCopySupport: "unknown",
          transport: null,
        }),
      ]),
    );
    expect(canExecute()).toBe(true);

    test.setTier("phone");
    expect(canExecute()).toBe(false);
  });

  it("needs owner access through the Hub", () => {
    const test = harness({ isHosted: () => true });
    expect(test.source.getExecutor().canExecute(target)).toBe(false);
    test.setCatalog(catalogOf([laptop, node()], [MINI]));
    expect(test.source.getExecutor().canExecute(target)).toBe(true);
  });

  it("hands out a new executor when the catalog or the tier changes", () => {
    const test = harness();
    const listener = vi.fn();
    test.source.subscribe(listener);
    const first = test.source.getExecutor();

    test.setCatalog(catalogOf([laptop, node({ presence: "connecting" })]));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(test.source.getExecutor()).not.toBe(first);

    const second = test.source.getExecutor();
    test.setTier("phone");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(test.source.getExecutor()).not.toBe(second);
  });
});

describe("previews", () => {
  it("resolves the destination and the setup thread's model on the target", async () => {
    const test = harness();
    const state = await loadPreview(test);

    expect(state).toEqual({
      status: "ready",
      preview: {
        targetLabel: "Mac mini",
        destination: {
          path: "/Users/me/Code/ryco",
          tag: "new folder",
          note: "Mac mini's code directory.",
        },
        followUpModel: "Opus 5.5 · Claude",
        problem: null,
      },
    });
    expect(test.sourceApi.projects.exportInspect).toHaveBeenCalledWith({
      projectId: "project-ryco",
    });
    // The agent's default destination: a suggestion, never a reason to open a guarded folder.
    expect(test.targetApi.projects.previewDestination).toHaveBeenCalledWith({
      path: "/Users/me/Code/ryco",
      suggested: true,
    });
    // Both nodes were held only for the reads.
    expect(test.holds.map((hold) => hold.release.mock.calls.length)).toEqual([1, 1]);
  });

  it("refuses a target this client does not know, and a source changed since the agent asked", async () => {
    const unknown = harness();
    unknown.setCatalog(catalogOf([laptop]));
    expect(await loadPreview(unknown)).toEqual({
      status: "ready",
      preview: expect.objectContaining({ problem: "Mac mini is not a device Ryco knows here." }),
    });

    const changed = harness({ readProjectUpdatedAt: () => "2026-10-22T09:30:00.000Z" });
    expect(await loadPreview(changed)).toEqual({
      status: "ready",
      preview: expect.objectContaining({
        problem: "ryco changed on Laptop since the agent asked. Ask it again.",
      }),
    });
  });
});

describe("preview retries", () => {
  it("resolves a preview again once its unreachable target comes online, not before", async () => {
    let catalog = catalogOf([laptop, node({ presence: "offline", transport: null })]);
    const test = harness({
      readCatalog: () => catalog,
      acquireForRead: async () => {
        throw new Error("Mac mini is offline");
      },
    });
    expect(await loadPreview(test)).toMatchObject({
      preview: { problem: "Mac mini is offline" },
    });
    const previews = test.source.getExecutor().previews!;
    const listener = vi.fn();
    previews.subscribe(listener);

    // Not online yet: nothing is resolved again, so a failing node is not asked in a loop.
    catalog = catalogOf([laptop, node({ presence: "connecting", transport: null })]);
    test.setCatalog(catalog);
    expect(previews.read(PROPOSAL)?.status).toBe("ready");
    expect(listener).not.toHaveBeenCalled();

    // Online: the card loads it again.
    catalog = catalogOf([laptop, node()]);
    test.setCatalog(catalog);
    expect(previews.read(PROPOSAL)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps a planning problem until the user acts", async () => {
    const test = harness({ readServerConfig: async () => ({ ...config, providers: [] }) });
    const state = await loadPreview(test);
    expect(state).toMatchObject({
      preview: {
        problem: "No agent provider is ready on Mac mini, so the setup thread can't start.",
      },
    });
    test.setCatalog(catalogOf([laptop, node({ presence: "connecting" })]));
    test.setCatalog(catalogOf([laptop, node()]));
    expect(test.source.getExecutor().previews?.read(PROPOSAL)?.status).toBe("ready");
  });
});

describe("approve", () => {
  it("accepts with executeOnClient, waits until the node runs it, then starts the copy", async () => {
    const test = harness();
    await loadPreview(test);
    const approving = test.source
      .getExecutor()
      .approve({ environmentId: LAPTOP, proposal: proposal() });

    await vi.waitFor(() => expect(test.agentControlApi.acceptProposal).toHaveBeenCalled());
    expect(test.agentControlApi.acceptProposal).toHaveBeenCalledWith({
      proposalId: PROPOSAL,
      executeOnClient: { executorId: EXECUTOR_ID },
    });
    // The receipt said `approved`: nothing starts until the stream says `executing`.
    await Promise.resolve();
    expect(test.deps.startCopy).not.toHaveBeenCalled();
    test.setStreamStatus("executing");
    await approving;

    // The approval was held before anything went out, and let go once the copy ran.
    expect(test.events).toEqual(["hold", "accept", "executing", "start", "release"]);
    expect(test.hold.reportNotStarted).not.toHaveBeenCalled();
    // It followed the proposal only while it waited.
    expect(test.followers.size).toBe(0);
    expect(test.deps.startCopy).toHaveBeenCalledWith({
      plan: expect.objectContaining({
        destinationPath: "/Users/me/Code/ryco",
        setup: { command: "bun install", saveAsScript: false },
        origin: { kind: "agent-control", sourceLabel: "Laptop", proposalId: PROPOSAL },
      }),
      agentControl: { environmentId: LAPTOP, proposalId: PROPOSAL, executorId: EXECUTOR_ID },
    });
  });

  it("shows what approving would do before it accepts anything", async () => {
    const test = harness();
    const executor = test.source.getExecutor();
    await expect(executor.approve({ environmentId: LAPTOP, proposal: proposal() })).rejects.toThrow(
      "Check where the copy goes on Mac mini (updated above), then approve again.",
    );
    expect(executor.previews?.read(PROPOSAL)?.status).toBe("ready");
    expect(test.agentControlApi.acceptProposal).not.toHaveBeenCalled();

    // The folder got taken since the card showed it.
    test.targetApi.projects.previewDestination.mockImplementation(async ({ path }) =>
      path === "/Users/me/Code/ryco"
        ? { ...preview(path), state: "exists-not-empty", suggestedPath: "/Users/me/Code/ryco-2" }
        : preview(path),
    );
    await expect(executor.approve({ environmentId: LAPTOP, proposal: proposal() })).rejects.toThrow(
      "Check where the copy goes on Mac mini",
    );
    expect(executor.previews?.read(PROPOSAL)).toMatchObject({
      preview: { destination: { path: "/Users/me/Code/ryco-2", tag: "renamed, folder exists" } },
    });
    expect(test.agentControlApi.acceptProposal).not.toHaveBeenCalled();
  });

  it("refuses a setup command the target would run differently, before accepting", async () => {
    const test = harness();
    const untrimmed = proposal(
      copyPlan({ setup: { command: "bun install ", saveAsScript: false } }),
    );
    await loadPreview(test, untrimmed);
    await expect(
      test.source.getExecutor().approve({ environmentId: LAPTOP, proposal: untrimmed }),
    ).rejects.toThrow(
      "The setup command this copy would run differs from the approved one, so nothing was run.",
    );
    expect(test.agentControlApi.acceptProposal).not.toHaveBeenCalled();
    expect(test.deps.startCopy).not.toHaveBeenCalled();
  });

  it("fails with the node's reason when the request ends instead of running", async () => {
    const test = harness();
    test.agentControlApi.acceptProposal.mockResolvedValueOnce(
      receipt("failed", {
        outcome: "failed",
        error: { code: "conflict", message: "ryco changed since the agent asked." },
        failedAt: "2026-10-22T10:00:00.000Z",
      } as never),
    );
    await loadPreview(test);
    await expect(
      test.source.getExecutor().approve({ environmentId: LAPTOP, proposal: proposal() }),
    ).rejects.toThrow("ryco changed since the agent asked.");
    expect(test.deps.startCopy).not.toHaveBeenCalled();
    // The node ended it: nothing runs for this executor and nothing is left to report.
    expect(test.hold.reportNotStarted).not.toHaveBeenCalled();
    expect(test.hold.release).toHaveBeenCalled();
  });

  it("reports a copy that was accepted but could not start", async () => {
    const test = harness({
      startCopy: vi.fn(async () => {
        throw new Error("The copy runtime failed to load.");
      }),
    });
    test.agentControlApi.acceptProposal.mockResolvedValueOnce(receipt("executing"));
    await loadPreview(test);
    await expect(
      test.source.getExecutor().approve({ environmentId: LAPTOP, proposal: proposal() }),
    ).rejects.toThrow("The copy runtime failed to load.");
    expect(test.deps.holdCopyStart).toHaveBeenCalledWith({
      environmentId: LAPTOP,
      proposalId: PROPOSAL,
      executorId: EXECUTOR_ID,
    });
    expect(test.hold.reportNotStarted).toHaveBeenCalledWith("The copy runtime failed to load.");
    expect(test.hold.release).not.toHaveBeenCalled();
  });

  it("accepts again with the same executor when an accept's answer is lost, then runs the copy", async () => {
    const test = harness();
    // The node bound the proposal, but the answer never arrived (a relay drop).
    test.agentControlApi.acceptProposal
      .mockRejectedValueOnce(new Error("The connection closed."))
      .mockResolvedValueOnce(receipt("executing"));
    await loadPreview(test);
    await test.source.getExecutor().approve({ environmentId: LAPTOP, proposal: proposal() });

    expect(test.agentControlApi.acceptProposal.mock.calls).toEqual([
      [{ proposalId: PROPOSAL, executeOnClient: { executorId: EXECUTOR_ID } }],
      [{ proposalId: PROPOSAL, executeOnClient: { executorId: EXECUTOR_ID } }],
    ]);
    expect(test.deps.startCopy).toHaveBeenCalledTimes(1);
    expect(test.hold.reportNotStarted).not.toHaveBeenCalled();
  });

  it("finishes binding a proposal a storage failure left approved, with the same executor", async () => {
    const test = harness();
    test.agentControlApi.acceptProposal
      .mockRejectedValueOnce(
        new AgentControlRpcError({ code: "storage", message: "Agent Control storage failed." }),
      )
      .mockResolvedValueOnce(receipt("executing"));
    await loadPreview(test);
    await test.source.getExecutor().approve({ environmentId: LAPTOP, proposal: proposal() });
    expect(test.agentControlApi.acceptProposal).toHaveBeenCalledTimes(2);
    expect(test.deps.startCopy).toHaveBeenCalledTimes(1);
  });

  it("ends a proposal it may have bound when no accept is answered", async () => {
    const test = harness();
    test.agentControlApi.acceptProposal.mockRejectedValue(new Error("The connection closed."));
    await loadPreview(test);
    await expect(
      test.source.getExecutor().approve({ environmentId: LAPTOP, proposal: proposal() }),
    ).rejects.toThrow("The connection closed.");

    // Every attempt carried the one executor the node may have bound.
    expect(
      new Set(test.agentControlApi.acceptProposal.mock.calls.map((call) => JSON.stringify(call))),
    ).toEqual(
      new Set([
        JSON.stringify([{ proposalId: PROPOSAL, executeOnClient: { executorId: EXECUTOR_ID } }]),
      ]),
    );
    expect(test.agentControlApi.acceptProposal.mock.calls.length).toBeGreaterThan(1);
    expect(test.deps.startCopy).not.toHaveBeenCalled();
    expect(test.hold.reportNotStarted).toHaveBeenCalledWith("The connection closed.");
    expect(test.hold.release).not.toHaveBeenCalled();
  });

  it("ends a proposal whose state it can't read after accepting", async () => {
    const test = harness({ executingTimeoutMs: 10 });
    test.agentControlApi.getProposal.mockRejectedValueOnce(new Error("The connection closed."));
    await loadPreview(test);
    await expect(
      test.source.getExecutor().approve({ environmentId: LAPTOP, proposal: proposal() }),
    ).rejects.toThrow("The connection closed.");
    expect(test.deps.startCopy).not.toHaveBeenCalled();
    expect(test.hold.reportNotStarted).toHaveBeenCalledWith("The connection closed.");
  });

  it("lets go when the node refuses the accept: nothing was bound", async () => {
    const test = harness();
    test.agentControlApi.acceptProposal.mockRejectedValueOnce(
      new AgentControlRpcError({
        code: "conflict",
        message: "Another app is running this request.",
      }),
    );
    await loadPreview(test);
    await expect(
      test.source.getExecutor().approve({ environmentId: LAPTOP, proposal: proposal() }),
    ).rejects.toThrow("Another app is running this request.");
    expect(test.agentControlApi.acceptProposal).toHaveBeenCalledTimes(1);
    expect(test.hold.release).toHaveBeenCalled();
    expect(test.hold.reportNotStarted).not.toHaveBeenCalled();
  });

  it("finishes a bind a crash left at approved once the stream stays quiet", async () => {
    const test = harness({ executingTimeoutMs: 10 });
    test.agentControlApi.getProposal.mockResolvedValueOnce({
      proposal: proposal(copyPlan(), "approved"),
    });
    test.agentControlApi.acceptProposal
      .mockResolvedValueOnce(receipt("approved"))
      .mockResolvedValueOnce(receipt("executing"));
    await loadPreview(test);
    await test.source.getExecutor().approve({ environmentId: LAPTOP, proposal: proposal() });
    expect(test.agentControlApi.acceptProposal).toHaveBeenCalledTimes(2);
    expect(test.agentControlApi.acceptProposal).toHaveBeenLastCalledWith({
      proposalId: PROPOSAL,
      executeOnClient: { executorId: EXECUTOR_ID },
    });
    expect(test.deps.startCopy).toHaveBeenCalledTimes(1);
  });
});

describe("rebuildAgentControlCopyPlanWith", () => {
  const record = { targetEnvironmentId: MINI } as ProjectCopyJobRecord;
  const context = {
    environmentId: LAPTOP,
    proposalId: PROPOSAL,
    executorId: EXECUTOR_ID as never,
  };

  it("rebuilds the plan of a copy whose proposal still runs", async () => {
    const test = harness();
    test.setStreamStatus("executing");
    const plan = await rebuildAgentControlCopyPlanWith(
      { ...(test.deps as AgentControlCopyExecutorDeps) },
      record,
      context,
    );
    expect(test.sourceApi.agentControl.getProposal).toHaveBeenCalledWith({ proposalId: PROPOSAL });
    expect(plan).toMatchObject({
      destinationPath: "/Users/me/Code/ryco",
      target: { environmentId: MINI },
      setup: { command: "bun install", saveAsScript: false },
    });
  });

  it("gives up on a proposal that ended or names another target", async () => {
    const ended = harness();
    ended.setStreamStatus("failed");
    expect(
      await rebuildAgentControlCopyPlanWith(
        ended.deps as AgentControlCopyExecutorDeps,
        record,
        context,
      ),
    ).toBeNull();

    const moved = harness();
    moved.setStreamStatus("executing");
    expect(
      await rebuildAgentControlCopyPlanWith(
        moved.deps as AgentControlCopyExecutorDeps,
        { targetEnvironmentId: "env-other" as EnvironmentId } as ProjectCopyJobRecord,
        context,
      ),
    ).toBeNull();
  });
});
