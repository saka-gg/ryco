import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { type EnvironmentState, useStore } from "../store";
import { type ChatMessage, type Thread } from "../types";

import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  buildExpiredTerminalContextToastCopy,
  buildLocalDraftThread,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  deriveProviderSelectionPolicy,
  hasServerAcknowledgedLocalDispatch,
  normalizeInteractionModeForProviderTarget,
  reconcileMountedTerminalThreadIds,
  resolveHeaderLiveAgentCount,
  resolveSendEnvMode,
  resolveChatSendWorktreePlan,
  shouldShowNewThreadSurface,
  buildChatSendTitleSeed,
  shouldWriteThreadErrorToCurrentServerThread,
  selectionAllowedAtSendBoundary,
  threadIsPromotedAndPersisted,
  waitForStartedServerThread,
} from "./ChatView.logic";

const localEnvironmentId = EnvironmentId.make("environment-local");

const idleProviderSelectionPolicyInput = {
  threadStarted: true,
  canonicalProvider: ProviderDriverKind.make("codex"),
  phase: "ready" as const,
  orchestrationStatus: "idle" as const,
  isConnecting: false,
  isSendBusy: false,
  isPreparingWorktree: false,
  hasPendingApproval: false,
  hasPendingUserInput: false,
  hasQueuedMessage: false,
  isRevertingCheckpoint: false,
  mutationAllowed: true,
  environmentAvailable: true,
  isPhoneTier: false,
};

describe("resolveHeaderLiveAgentCount", () => {
  it("suppresses only the redundant badge while the Agents roster is visible", () => {
    expect(
      resolveHeaderLiveAgentCount({
        liveCount: 4,
        workspacePanelOpen: true,
        workspaceTab: "agents",
      }),
    ).toBe(0);
    expect(
      resolveHeaderLiveAgentCount({
        liveCount: 4,
        workspacePanelOpen: true,
        workspaceTab: "files",
      }),
    ).toBe(4);
    expect(
      resolveHeaderLiveAgentCount({
        liveCount: 4,
        workspacePanelOpen: false,
        workspaceTab: "agents",
      }),
    ).toBe(4);
  });
});

describe("buildLocalDraftThread", () => {
  const draft = {
    threadId: ThreadId.make("thread-draft"),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make("project-draft"),
    logicalProjectKey: "environment-local:project-draft",
    createdAt: "2026-10-08T10:00:00.000Z",
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    envMode: "local" as const,
  };
  const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

  it("titles an unsent chat as the sidebar's Chats section does", () => {
    const thread = (pendingChat: boolean) =>
      buildLocalDraftThread(draft.threadId, { ...draft, pendingChat }, modelSelection, null);
    expect(thread(true).title).toBe("New chat");
    expect(thread(false).title).toBe("New thread");
  });
});

describe("deriveProviderSelectionPolicy", () => {
  it("exposes every ready provider on a started, truly idle desktop thread", () => {
    expect(deriveProviderSelectionPolicy(idleProviderSelectionPolicyInput)).toEqual({
      mode: "all-ready",
      lockedProvider: null,
      reason: null,
    });
  });

  it("keeps empty threads configurable even before mutation state is ready", () => {
    expect(
      deriveProviderSelectionPolicy({
        ...idleProviderSelectionPolicyInput,
        threadStarted: false,
        mutationAllowed: false,
        environmentAvailable: false,
        isPhoneTier: true,
      }),
    ).toEqual({ mode: "all-ready", lockedProvider: null, reason: null });
  });

  it.each([
    ["running", { phase: "running" as const }],
    ["starting", { orchestrationStatus: "starting" as const }],
    ["connecting", { phase: "connecting" as const }],
    ["local-dispatch", { isSendBusy: true }],
    ["worktree-preparation", { isPreparingWorktree: true }],
    ["pending-approval", { hasPendingApproval: true }],
    ["pending-input", { hasPendingUserInput: true }],
    ["queued-message", { hasQueuedMessage: true }],
    ["checkpoint-revert", { isRevertingCheckpoint: true }],
    ["mutation-unavailable", { mutationAllowed: false }],
    ["environment-unavailable", { environmentAvailable: false }],
    ["phone-tier", { isPhoneTier: true }],
  ] as const)("uses continuation-only mode for %s", (reason, override) => {
    expect(
      deriveProviderSelectionPolicy({
        ...idleProviderSelectionPolicyInput,
        ...override,
      }),
    ).toEqual({
      mode: "continuation-only",
      lockedProvider: ProviderDriverKind.make("codex"),
      reason,
    });
  });
});

describe("selectionAllowedAtSendBoundary", () => {
  const canonicalSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5",
    options: [{ id: "reasoningEffort", value: "medium" }],
  };
  const busyPolicy = deriveProviderSelectionPolicy({
    ...idleProviderSelectionPolicyInput,
    isSendBusy: true,
  });

  it("rejects an instance handoff but allows a same-instance model change when busy", () => {
    expect(
      selectionAllowedAtSendBoundary({
        threadStarted: true,
        policy: busyPolicy,
        canonicalSelection,
        targetSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
        },
      }),
    ).toBe(false);
    expect(
      selectionAllowedAtSendBoundary({
        threadStarted: true,
        policy: busyPolicy,
        canonicalSelection,
        targetSelection: { ...canonicalSelection, model: "gpt-5.1" },
      }),
    ).toBe(true);
  });

  it("allows options-only continuation changes while constrained", () => {
    const targetSelection = {
      ...canonicalSelection,
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    expect(
      selectionAllowedAtSendBoundary({
        threadStarted: true,
        policy: busyPolicy,
        canonicalSelection,
        targetSelection,
      }),
    ).toBe(true);
  });
});

describe("normalizeInteractionModeForProviderTarget", () => {
  it("drops Ask when the staged target cannot honor it", () => {
    expect(normalizeInteractionModeForProviderTarget("ask", false)).toBe("default");
    expect(normalizeInteractionModeForProviderTarget("ask", true)).toBe("ask");
    expect(normalizeInteractionModeForProviderTarget("plan", false)).toBe("plan");
  });
});

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.make("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.make("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats clear empty-state guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
  });

  it("formats omission guidance for sent messages", () => {
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("resolveSendEnvMode", () => {
  it("keeps worktree mode for git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: true })).toBe("worktree");
  });

  it("forces local mode for non-git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: false })).toBe("local");
    expect(resolveSendEnvMode({ requestedEnvMode: "local", isGitRepo: false })).toBe("local");
  });
});

describe("resolveChatSendWorktreePlan", () => {
  it("prepares a first-message worktree when send mode is worktree", () => {
    expect(
      resolveChatSendWorktreePlan({
        isServerThread: true,
        isFirstMessage: true,
        threadWorktreePath: null,
        activeThreadBranch: "main",
        currentGitRefName: "main",
        sendEnvMode: "worktree",
      }),
    ).toEqual({
      shouldMaterializeLegacyBranchWorktree: false,
      baseBranchForWorktree: "main",
      shouldCreateWorktree: true,
    });
  });

  it("materializes a legacy branch-only thread into a worktree on later sends", () => {
    expect(
      resolveChatSendWorktreePlan({
        isServerThread: true,
        isFirstMessage: false,
        threadWorktreePath: null,
        activeThreadBranch: "feature/foo",
        currentGitRefName: "main",
        sendEnvMode: "local",
      }),
    ).toEqual({
      shouldMaterializeLegacyBranchWorktree: true,
      baseBranchForWorktree: "feature/foo",
      shouldCreateWorktree: true,
    });
  });

  it("skips worktree creation for local send mode on an existing thread", () => {
    expect(
      resolveChatSendWorktreePlan({
        isServerThread: true,
        isFirstMessage: false,
        threadWorktreePath: null,
        activeThreadBranch: "main",
        currentGitRefName: "main",
        sendEnvMode: "local",
      }),
    ).toEqual({
      shouldMaterializeLegacyBranchWorktree: false,
      baseBranchForWorktree: null,
      shouldCreateWorktree: false,
    });
  });
});

describe("buildChatSendTitleSeed", () => {
  it("prefers trimmed prompt text", () => {
    expect(
      buildChatSendTitleSeed({
        trimmedPrompt: "Fix sidebar perf",
        firstImageName: "shot.png",
        firstTerminalContextLabel: "Terminal 1",
      }),
    ).toBe("Fix sidebar perf");
  });

  it("falls back to image and terminal labels", () => {
    expect(
      buildChatSendTitleSeed({
        trimmedPrompt: "",
        firstImageName: "shot.png",
        firstTerminalContextLabel: null,
      }),
    ).toBe("Attachment: shot.png");
    expect(
      buildChatSendTitleSeed({
        trimmedPrompt: "   ",
        firstImageName: null,
        firstTerminalContextLabel: "Terminal 1",
      }),
    ).toBe("Terminal 1");
    expect(
      buildChatSendTitleSeed({
        trimmedPrompt: "",
        firstImageName: null,
        firstTerminalContextLabel: null,
      }),
    ).toBe("New thread");
  });
});

describe("reconcileMountedTerminalThreadIds", () => {
  it("keeps previously mounted open threads and adds the active open thread", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [ThreadId.make("thread-hidden"), ThreadId.make("thread-stale")],
        openThreadIds: [ThreadId.make("thread-hidden"), ThreadId.make("thread-active")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadTerminalOpen: true,
      }),
    ).toEqual([ThreadId.make("thread-hidden"), ThreadId.make("thread-active")]);
  });

  it("drops mounted threads once their terminal drawer is no longer open", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [ThreadId.make("thread-closed")],
        openThreadIds: [],
        activeThreadId: ThreadId.make("thread-closed"),
        activeThreadTerminalOpen: false,
      }),
    ).toEqual([]);
  });

  it("keeps only the most recently active hidden terminal threads", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [
          ThreadId.make("thread-1"),
          ThreadId.make("thread-2"),
          ThreadId.make("thread-3"),
        ],
        openThreadIds: [
          ThreadId.make("thread-1"),
          ThreadId.make("thread-2"),
          ThreadId.make("thread-3"),
          ThreadId.make("thread-4"),
        ],
        activeThreadId: ThreadId.make("thread-4"),
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual([ThreadId.make("thread-2"), ThreadId.make("thread-3"), ThreadId.make("thread-4")]);
  });

  it("moves the active thread to the end so it is treated as most recently used", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [
          ThreadId.make("thread-a"),
          ThreadId.make("thread-b"),
          ThreadId.make("thread-c"),
        ],
        openThreadIds: [
          ThreadId.make("thread-a"),
          ThreadId.make("thread-b"),
          ThreadId.make("thread-c"),
        ],
        activeThreadId: ThreadId.make("thread-a"),
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual([ThreadId.make("thread-b"), ThreadId.make("thread-c"), ThreadId.make("thread-a")]);
  });

  it("defaults to the hidden mounted terminal cap", () => {
    const currentThreadIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => ThreadId.make(`thread-${index + 1}`),
    );

    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds,
        openThreadIds: currentThreadIds,
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
    ).toEqual(currentThreadIds.slice(-MAX_HIDDEN_MOUNTED_TERMINAL_THREADS));
  });
});

describe("shouldWriteThreadErrorToCurrentServerThread", () => {
  it("routes errors to the active server thread when route and target match", () => {
    const threadId = ThreadId.make("thread-1");
    const routeThreadRef = scopeThreadRef(localEnvironmentId, threadId);

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: {
          environmentId: localEnvironmentId,
          id: threadId,
        },
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(true);
  });

  it("does not route draft-thread errors into server-backed state", () => {
    const threadId = ThreadId.make("thread-1");

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: undefined,
        routeThreadRef: scopeThreadRef(localEnvironmentId, threadId),
        targetThreadId: threadId,
      }),
    ).toBe(false);
  });
});

const makeThread = (input?: {
  id?: ThreadId;
  messages?: ChatMessage[];
  latestTurn?: {
    turnId: TurnId;
    state: "running" | "completed";
    requestedAt: string;
    startedAt: string | null;
    completedAt: string | null;
  } | null;
}): Thread => ({
  id: input?.id ?? ThreadId.make("thread-1"),
  environmentId: localEnvironmentId,
  codexThreadId: null,
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  session: null,
  messages: input?.messages ?? [],
  proposedPlans: [],
  error: null,
  createdAt: "2026-03-29T00:00:00.000Z",
  archivedAt: null,
  updatedAt: "2026-03-29T00:00:00.000Z",
  latestTurn: input?.latestTurn
    ? {
        ...input.latestTurn,
        assistantMessageId: null,
      }
    : null,
  branch: null,
  worktreePath: null,
  turnDiffSummaries: [],
  activities: [],
});

function setStoreThreads(threads: ReadonlyArray<ReturnType<typeof makeThread>>) {
  const projectId = ProjectId.make("project-1");
  const environmentState: EnvironmentState = {
    projectIds: [projectId],
    projectById: {
      [projectId]: {
        id: projectId,
        environmentId: localEnvironmentId,
        name: "Project",
        cwd: "/tmp/project",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        createdAt: "2026-03-29T00:00:00.000Z",
        updatedAt: "2026-03-29T00:00:00.000Z",
        scripts: [],
      },
    },
    threadIds: threads.map((thread) => thread.id),
    threadIdsByProjectId: {
      [projectId]: threads.map((thread) => thread.id),
    },
    threadShellById: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        {
          id: thread.id,
          environmentId: thread.environmentId,
          codexThreadId: thread.codexThreadId,
          projectId: thread.projectId,
          title: thread.title,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          error: thread.error,
          createdAt: thread.createdAt,
          archivedAt: thread.archivedAt,
          updatedAt: thread.updatedAt,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
        },
      ]),
    ),
    threadSessionById: Object.fromEntries(threads.map((thread) => [thread.id, thread.session])),
    threadTurnStateById: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        {
          latestTurn: thread.latestTurn,
          ...(thread.pendingSourceProposedPlan
            ? { pendingSourceProposedPlan: thread.pendingSourceProposedPlan }
            : {}),
        },
      ]),
    ),
    messageIdsByThreadId: Object.fromEntries(
      threads.map((thread) => [thread.id, thread.messages.map((message) => message.id)]),
    ),
    messageByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        Object.fromEntries(thread.messages.map((message) => [message.id, message])),
      ]),
    ),
    pendingMessagesByThreadId: {},
    activityIdsByThreadId: Object.fromEntries(
      threads.map((thread) => [thread.id, thread.activities.map((activity) => activity.id)]),
    ),
    activityByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        Object.fromEntries(thread.activities.map((activity) => [activity.id, activity])),
      ]),
    ),
    proposedPlanIdsByThreadId: Object.fromEntries(
      threads.map((thread) => [thread.id, thread.proposedPlans.map((plan) => plan.id)]),
    ),
    proposedPlanByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        Object.fromEntries(thread.proposedPlans.map((plan) => [plan.id, plan])),
      ]),
    ),
    turnDiffIdsByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        thread.turnDiffSummaries.map((summary) => summary.turnId),
      ]),
    ),
    turnDiffSummaryByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        Object.fromEntries(thread.turnDiffSummaries.map((summary) => [summary.turnId, summary])),
      ]),
    ),
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
  };
  useStore.setState({
    activeEnvironmentId: localEnvironmentId,
    environmentStateById: {
      [localEnvironmentId]: environmentState,
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setStoreThreads([]);
});

describe("threadIsPromotedAndPersisted", () => {
  it("does not promote an empty thread", () => {
    expect(threadIsPromotedAndPersisted(makeThread({ latestTurn: null, messages: [] }))).toBe(
      false,
    );
  });

  it("does not promote a bare session before any thread messages are visible", () => {
    expect(
      threadIsPromotedAndPersisted({
        ...makeThread({ latestTurn: null }),
        session: {
          provider: ProviderDriverKind.make("codex"),
          status: "running",
          createdAt: "2026-03-29T00:00:00.000Z",
          updatedAt: "2026-03-29T00:00:01.000Z",
          orchestrationStatus: "running",
          activeTurnId: TurnId.make("turn-1"),
        },
      }),
    ).toBe(false);
  });

  it("returns true once a latest turn is visible", () => {
    expect(
      threadIsPromotedAndPersisted(
        makeThread({
          latestTurn: {
            turnId: TurnId.make("turn-1"),
            state: "running",
            requestedAt: "2026-03-29T00:00:00.000Z",
            startedAt: "2026-03-29T00:00:01.000Z",
            completedAt: null,
          },
        }),
      ),
    ).toBe(true);
  });

  it("returns true once a message is visible", () => {
    expect(
      threadIsPromotedAndPersisted({
        ...makeThread({ latestTurn: null }),
        messages: [
          {
            id: MessageId.make("message-1"),
            role: "user",
            text: "hello",
            createdAt: "2026-03-29T00:00:00.000Z",
            streaming: false,
          },
        ],
      }),
    ).toBe(true);
  });
});

describe("waitForStartedServerThread", () => {
  it("resolves immediately when the thread is already started", async () => {
    const threadId = ThreadId.make("thread-started");
    setStoreThreads([
      makeThread({
        id: threadId,
        latestTurn: {
          turnId: TurnId.make("turn-started"),
          state: "running",
          requestedAt: "2026-03-29T00:00:01.000Z",
          startedAt: "2026-03-29T00:00:01.000Z",
          completedAt: null,
        },
      }),
    ]);

    await expect(
      waitForStartedServerThread(scopeThreadRef(localEnvironmentId, threadId)),
    ).resolves.toBe(true);
  });

  it("waits for the thread to start via subscription updates", async () => {
    const threadId = ThreadId.make("thread-wait");
    setStoreThreads([makeThread({ id: threadId })]);

    const promise = waitForStartedServerThread(scopeThreadRef(localEnvironmentId, threadId), 500);

    setStoreThreads([
      makeThread({
        id: threadId,
        latestTurn: {
          turnId: TurnId.make("turn-started"),
          state: "running",
          requestedAt: "2026-03-29T00:00:01.000Z",
          startedAt: "2026-03-29T00:00:01.000Z",
          completedAt: null,
        },
      }),
    ]);

    await expect(promise).resolves.toBe(true);
  });

  it("handles the thread starting between the initial read and subscription setup", async () => {
    const threadId = ThreadId.make("thread-race");
    setStoreThreads([makeThread({ id: threadId })]);

    const originalSubscribe = useStore.subscribe.bind(useStore);
    let raced = false;
    vi.spyOn(useStore, "subscribe").mockImplementation((listener) => {
      if (!raced) {
        raced = true;
        setStoreThreads([
          makeThread({
            id: threadId,
            latestTurn: {
              turnId: TurnId.make("turn-race"),
              state: "running",
              requestedAt: "2026-03-29T00:00:01.000Z",
              startedAt: "2026-03-29T00:00:01.000Z",
              completedAt: null,
            },
          }),
        ]);
      }
      return originalSubscribe(listener);
    });

    await expect(
      waitForStartedServerThread(scopeThreadRef(localEnvironmentId, threadId), 500),
    ).resolves.toBe(true);
  });

  it("returns false after the timeout when the thread never starts", async () => {
    vi.useFakeTimers();

    const threadId = ThreadId.make("thread-timeout");
    setStoreThreads([makeThread({ id: threadId })]);
    const promise = waitForStartedServerThread(scopeThreadRef(localEnvironmentId, threadId), 500);

    await vi.advanceTimersByTimeAsync(500);

    await expect(promise).resolves.toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  const projectId = ProjectId.make("project-1");
  const previousLatestTurn = {
    turnId: TurnId.make("turn-1"),
    state: "completed" as const,
    requestedAt: "2026-03-29T00:00:00.000Z",
    startedAt: "2026-03-29T00:00:01.000Z",
    completedAt: "2026-03-29T00:00:10.000Z",
    assistantMessageId: null,
  };

  const previousSession = {
    provider: ProviderDriverKind.make("codex"),
    status: "ready" as const,
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:10.000Z",
    orchestrationStatus: "idle" as const,
  };

  it("does not clear local dispatch before server state changes", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: previousLatestTurn,
        session: previousSession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("clears local dispatch when a new turn is already settled", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: {
          ...previousLatestTurn,
          turnId: TurnId.make("turn-2"),
          requestedAt: "2026-03-29T00:01:00.000Z",
          startedAt: "2026-03-29T00:01:01.000Z",
          completedAt: "2026-03-29T00:01:30.000Z",
        },
        session: {
          ...previousSession,
          updatedAt: "2026-03-29T00:01:30.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("does not clear local dispatch while the session is running a newer turn than latestTurn", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: previousLatestTurn,
        session: {
          ...previousSession,
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: TurnId.make("turn-2"),
          updatedAt: "2026-03-29T00:01:00.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("does not clear local dispatch while the session is running but latestTurn has not advanced yet", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: previousLatestTurn,
        session: {
          ...previousSession,
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: undefined,
          updatedAt: "2026-03-29T00:01:00.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("clears local dispatch once the running latestTurn matches the active session turn", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: {
          ...previousLatestTurn,
          turnId: TurnId.make("turn-2"),
          state: "running",
          requestedAt: "2026-03-29T00:01:00.000Z",
          startedAt: "2026-03-29T00:01:01.000Z",
          completedAt: null,
        },
        session: {
          ...previousSession,
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: TurnId.make("turn-2"),
          updatedAt: "2026-03-29T00:01:01.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("clears local dispatch when the session changes without an observed running phase", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: previousLatestTurn,
        session: {
          ...previousSession,
          updatedAt: "2026-03-29T00:00:11.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });
});

describe("shouldShowNewThreadSurface", () => {
  const base = {
    hasThread: true,
    messageCount: 0,
    optimisticMessageCount: 0,
    timelineEntryCount: 0,
    presentationTier: "desktop",
  };

  it("shows on an empty desktop thread", () => {
    expect(shouldShowNewThreadSurface(base)).toBe(true);
  });

  it("hides without a thread", () => {
    expect(shouldShowNewThreadSurface({ ...base, hasThread: false })).toBe(false);
  });

  it("hides once a message exists", () => {
    expect(shouldShowNewThreadSurface({ ...base, messageCount: 1 })).toBe(false);
  });

  it("hides on an optimistic send, before the server acknowledges", () => {
    expect(shouldShowNewThreadSurface({ ...base, optimisticMessageCount: 1 })).toBe(false);
  });

  it("hides when non-message timeline entries exist", () => {
    // Setup-script activity from worktree creation, work logs, or a proposed
    // plan can arrive with no chat messages; the hero would bury them.
    expect(shouldShowNewThreadSurface({ ...base, timelineEntryCount: 1 })).toBe(false);
  });

  it("hides on the frozen web phone tier", () => {
    expect(shouldShowNewThreadSurface({ ...base, presentationTier: "phone" })).toBe(false);
  });
});
