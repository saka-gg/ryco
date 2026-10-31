/**
 * "Fork from here" → "Another machine" in the full app: the real client runtime and two
 * environments. The source machine (A) is reached through an environment API override that only
 * answers history reads; the target machine (B) is this app's own connected node (the test WS
 * harness). Picking B must read the conversation from A and send exactly one
 * `threads.forkCarried`, to B.
 */
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  type EnvironmentApi,
  EnvironmentId,
  MessageId,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RepositoryIdentity,
  type ServerConfig,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  type ThreadForkResult,
  TurnId,
  WS_METHODS,
} from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { setGitStatusForCwdForTests, setGitStatusForTests } from "../../test/gitStatusStateMock";
import type { NormalizedWsRpcRequestBody } from "../../test/wsRpcHarness";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { useStore } from "../store";
import {
  DEFAULT_VIEWPORT,
  NOW_ISO,
  PROJECT_ID,
  createSnapshotForTargetUser,
  fixture,
  isoAt,
  mountChatView,
  setupChatViewBrowserSuite,
  waitForServerConfigToApply,
  wsRequests,
} from "./ChatView.browser.helpers";
import { openForkThreadDialog } from "./chat/forkThreadDialogStore";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

/** Methods the shared capability policy refuses on every machine, as a stale hosted session does. */
const refusedMethods = vi.hoisted(() => new Set<string>());
vi.mock("../hostedHub/capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hostedHub/capabilities")>();
  const refused = Object.freeze({
    hosted: true,
    allowed: false,
    reason: "This action is unavailable while Hub authorization or the relay is stale.",
    kind: "stale" as const,
  });
  return {
    ...actual,
    useHostedRpcCapability: (...args: Parameters<typeof actual.useHostedRpcCapability>) => {
      const capability = actual.useHostedRpcCapability(...args);
      return refusedMethods.has(args[0]) ? refused : capability;
    },
    readHostedRpcCapability: (...args: Parameters<typeof actual.readHostedRpcCapability>) =>
      refusedMethods.has(args[0]) ? refused : actual.readHostedRpcCapability(...args),
  };
});

const SOURCE = EnvironmentId.make("environment-source");
const SOURCE_PROJECT = ProjectId.make("project-on-source");
const SOURCE_THREAD = ThreadId.make("thread-on-source");
const SOURCE_CWD = "/Users/me/app";
const TURN_1 = TurnId.make("turn-source-1");
const TURN_2 = TurnId.make("turn-source-2");
const REPLY_1 = MessageId.make("msg-source-reply-1");
const REPLY_2 = MessageId.make("msg-source-reply-2");
const CARRIED_FORK_THREAD = ThreadId.make("fork-carried-on-target");

const identity = (rootPath: string): RepositoryIdentity => ({
  canonicalKey: "github.com/acme/app",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "https://github.com/acme/app.git",
  },
  rootPath,
  remotes: [],
});

const HEAD_COMMIT = "c0ffee".padEnd(40, "0");

const PUSHED_STATUS = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/login",
  hasWorkingTreeChanges: true,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  upstreamRef: "origin/feature/login",
  headCommit: HEAD_COMMIT,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
} as const;

/** The target's own snapshot: its copy of the project carries the same repository identity. */
function targetSnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: MessageId.make("msg-target-unused"),
    targetText: "unused",
  });
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === PROJECT_ID
        ? Object.assign({}, project, { repositoryIdentity: identity(project.workspaceRoot) })
        : project,
    ),
  };
}

const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  turnId: TurnId | null,
  offsetSeconds: number,
) => ({
  id: MessageId.make(id),
  role,
  text,
  turnId,
  streaming: false,
  createdAt: isoAt(offsetSeconds),
  updatedAt: isoAt(offsetSeconds + 1),
});

const SOURCE_MESSAGES = [
  message("msg-source-user-1", "user", "Plan the login fix", null, 0),
  message(REPLY_1, "assistant", "Split the session check first.", TURN_1, 5),
  message("msg-source-user-2", "user", "Do it", null, 10),
  message(REPLY_2, "assistant", "Done on feature/login.", TURN_2, 15),
];

const sourceThread = {
  id: SOURCE_THREAD,
  projectId: SOURCE_PROJECT,
  title: "Login fix",
  modelSelection: { instanceId: ProviderInstanceId.make("my-codex"), model: "gpt-5" },
  runtimeMode: "approval-required" as const,
  interactionMode: "default" as const,
  branch: "feature/login",
  worktreePath: null,
  latestTurn: {
    turnId: TURN_2,
    state: "completed" as const,
    requestedAt: isoAt(10),
    startedAt: isoAt(10),
    completedAt: isoAt(16),
    assistantMessageId: REPLY_2,
  },
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  session: null,
};

/** The source machine's shell, as this client holds it after syncing that machine. */
function sourceShellSnapshot(): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 7,
    projects: [
      {
        id: SOURCE_PROJECT,
        title: "App",
        workspaceRoot: SOURCE_CWD,
        repositoryIdentity: identity(SOURCE_CWD),
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    ],
    worktrees: [],
    threads: [
      {
        ...sourceThread,
        worktreeId: null,
        latestUserMessageAt: isoAt(10),
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      },
    ],
    updatedAt: NOW_ISO,
  } as unknown as OrchestrationShellSnapshot;
}

/**
 * The source machine: it answers history reads (and a push, recording its options), and records
 * every call it gets.
 */
function sourceApi(calls: string[], pushes: unknown[] = []): EnvironmentApi {
  const window = {
    snapshotSequence: 7,
    thread: {
      ...sourceThread,
      messages: SOURCE_MESSAGES,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
    },
    history: {
      messages: { oldestCursor: null, newestCursor: null, hasMoreBefore: false },
      proposedPlans: { oldestCursor: null, newestCursor: null, hasMoreBefore: false },
      activities: { oldestCursor: null, newestCursor: null, hasMoreBefore: false },
      checkpoints: { oldestCursor: null, newestCursor: null, hasMoreBefore: false },
    },
  };
  const record = (name: string) => () => {
    calls.push(name);
    return Promise.reject(new Error(`${name} must not run on the source machine`));
  };
  return {
    orchestration: {
      getThreadWindow: () => {
        calls.push("getThreadWindow");
        return Promise.resolve(window);
      },
      getThreadHistoryPage: () => {
        calls.push("getThreadHistoryPage");
        return Promise.reject(new Error("nothing older"));
      },
      dispatchCommand: record("dispatchCommand"),
    },
    threads: {
      setManualBucket: record("setManualBucket"),
      setManualPosition: record("setManualPosition"),
      fork: record("fork"),
      forkCarried: record("forkCarried"),
    },
    git: {
      runStackedAction: (input: unknown, options: unknown) => {
        calls.push("runStackedAction");
        pushes.push({ input, options });
        return Promise.resolve({ action: "push" });
      },
    },
  } as unknown as EnvironmentApi;
}

function sourceConfig(): ServerConfig {
  return {
    ...fixture.serverConfig,
    providers: [
      {
        ...fixture.serverConfig.providers[0]!,
        instanceId: ProviderInstanceId.make("my-codex"),
        driver: ProviderDriverKind.make("codex"),
      },
    ],
  };
}

function carriedRequests(): NormalizedWsRpcRequestBody[] {
  return wsRequests.filter((request) => request._tag === WS_METHODS.threadsForkCarried);
}

const FORK_RESULT: ThreadForkResult = {
  threadId: CARRIED_FORK_THREAD,
  projectId: PROJECT_ID,
  replayed: false,
  providerContext: "handoff",
  checkout: {
    kind: "new-worktree",
    worktreeId: "worktree-fork-carried" as never,
    worktreePath: "/repo/worktrees/fork",
    branch: "ryco/fork-1a2b3c4d",
    start: "base-ref",
    baseRef: "origin/feature/login",
  },
  notices: [],
};

/** The app with this node as the target machine and the source machine's thread synced. */
async function mountTwoMachines(input: {
  readonly answer: (body: NormalizedWsRpcRequestBody) => unknown;
  readonly pushes?: unknown[];
}) {
  const mounted = await mountChatView({
    viewport: DEFAULT_VIEWPORT,
    snapshot: targetSnapshot(),
    configureFixture: (nextFixture) => {
      nextFixture.serverConfig = {
        ...nextFixture.serverConfig,
        environment: {
          ...nextFixture.serverConfig.environment,
          capabilities: {
            ...nextFixture.serverConfig.environment.capabilities,
            threadFork: true,
            threadForkCarried: true,
          },
        },
      };
    },
    resolveRpc: (body) =>
      body._tag === WS_METHODS.threadsForkCarried ? input.answer(body) : undefined,
  });
  await waitForServerConfigToApply();
  const sourceCalls: string[] = [];
  __setEnvironmentApiOverrideForTests(SOURCE, sourceApi(sourceCalls, input.pushes));
  useSavedEnvironmentRuntimeStore.getState().patch(SOURCE, { serverConfig: sourceConfig() });
  useStore.getState().syncServerShellSnapshot(sourceShellSnapshot(), SOURCE);
  return { mounted, sourceCalls };
}

async function openAnotherMachine() {
  openForkThreadDialog({
    sourceThreadRef: scopeThreadRef(SOURCE, SOURCE_THREAD),
    sourceMessageId: REPLY_1,
    sourceTurnId: TURN_1,
    boundaryText: "Split the session check first.",
    checkpointAvailable: false,
  });
  await expect.element(page.getByTestId("fork-thread-dialog")).toBeVisible();
  await page.getByTestId("fork-thread-machine-other").click();
  await expect.element(page.getByTestId("carried-fork-branch")).toBeVisible();
}

const carriedPhase = () =>
  document.querySelector("[data-carried-fork-phase]")?.getAttribute("data-carried-fork-phase") ??
  null;

describe("Fork from here → Another machine (full app)", () => {
  setupChatViewBrowserSuite();

  beforeEach(() => {
    refusedMethods.clear();
  });

  afterEach(() => {
    refusedMethods.clear();
    __resetEnvironmentApiOverridesForTests();
    useSavedEnvironmentRuntimeStore.getState().clear(SOURCE);
  });

  it("reads the conversation from the source and sends one threads.forkCarried to the picked machine", async () => {
    setGitStatusForTests(null);
    setGitStatusForCwdForTests(SOURCE_CWD, PUSHED_STATUS);
    const { mounted, sourceCalls } = await mountTwoMachines({ answer: () => FORK_RESULT });
    try {
      await openAnotherMachine();
      await vi.waitFor(() =>
        expect(
          document.querySelector('[data-testid="carried-fork-branch"]')?.textContent ?? "",
        ).toContain("from origin/feature/login at c0ffee0."),
      );
      await page.getByTestId("carried-fork-submit").click();

      await vi.waitFor(() => expect(carriedRequests()).toHaveLength(1), { timeout: 10_000 });
      const sent = carriedRequests()[0] as unknown as {
        readonly forkKey: string;
        readonly projectId: string;
        readonly destination: unknown;
        readonly history: {
          readonly source: Record<string, string>;
          readonly messages: ReadonlyArray<{ readonly text: string }>;
          readonly model: unknown;
          readonly runtimeMode: string;
        };
      };
      expect(sent.forkKey).toMatch(/^fork-[0-9a-f]{32}$/);
      expect(sent.projectId).toBe(PROJECT_ID);
      expect(sent.destination).toEqual({
        kind: "new-worktree",
        start: { kind: "base-ref", baseRef: "origin/feature/login", commit: HEAD_COMMIT },
      });
      // Up to and including the picked reply, nothing after it.
      expect(sent.history.messages.map((entry) => entry.text)).toEqual([
        "Plan the login fix",
        "Split the session check first.",
      ]);
      expect(sent.history.source).toMatchObject({
        threadId: SOURCE_THREAD,
        environmentId: SOURCE,
        threadTitle: "Login fix",
      });
      expect(sent.history.model).toEqual({ driver: "codex", model: "gpt-5" });
      expect(sent.history.runtimeMode).toBe("approval-required");

      // The source machine was only read; the original is not archived unless asked.
      expect(sourceCalls.every((call) => call === "getThreadWindow")).toBe(true);
      expect(sourceCalls.length).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(carriedRequests()).toHaveLength(1);
      expect(wsRequests.filter((request) => request._tag === WS_METHODS.threadsFork)).toEqual([]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps sending to the picked machine when it drops off the list mid-send", async () => {
    setGitStatusForTests(null);
    setGitStatusForCwdForTests(SOURCE_CWD, PUSHED_STATUS);
    let answer!: (result: ThreadForkResult) => void;
    const answered = new Promise<ThreadForkResult>((resolve) => (answer = resolve));
    const { mounted } = await mountTwoMachines({ answer: () => answered });
    try {
      await openAnotherMachine();
      await page.getByTestId("carried-fork-submit").click();
      await vi.waitFor(() => expect(carriedRequests()).toHaveLength(1), { timeout: 10_000 });
      expect(carriedPhase()).toBe("sending");
      // The source's project now names another repository: no machine qualifies any more.
      const moved = sourceShellSnapshot();
      useStore.getState().syncServerShellSnapshot(
        {
          ...moved,
          snapshotSequence: 8,
          projects: moved.projects.map((project) =>
            Object.assign({}, project, {
              repositoryIdentity: {
                ...identity(SOURCE_CWD),
                canonicalKey: "github.com/acme/moved",
              },
            }),
          ),
        } as OrchestrationShellSnapshot,
        SOURCE,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The dialog still shows the request in flight to the machine it went to.
      expect(carriedPhase()).toBe("sending");
      expect(
        document.querySelector('[data-testid="carried-fork-status"]')?.textContent ?? "",
      ).toMatch(/^Creating the fork on (?!the other machine)/);
      answer(FORK_RESULT);
      // It goes on to open the fork on that machine.
      await vi.waitFor(() => expect(carriedPhase()).toBe("opening"), { timeout: 10_000 });
      expect(carriedRequests()).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("gates Push and the archive afterwards with the shared capability policy", async () => {
    setGitStatusForTests(null);
    setGitStatusForCwdForTests(SOURCE_CWD, { ...PUSHED_STATUS, aheadCount: 1 });
    refusedMethods.add(WS_METHODS.gitRunStackedAction);
    refusedMethods.add(ORCHESTRATION_WS_METHODS.dispatchCommand);
    const { mounted, sourceCalls } = await mountTwoMachines({ answer: () => FORK_RESULT });
    try {
      await openAnotherMachine();
      await expect.element(page.getByTestId("carried-fork-push")).toBeDisabled();
      await expect
        .element(page.getByTestId("carried-fork-archive").getByRole("checkbox"))
        .toBeDisabled();
      expect(sourceCalls).not.toContain("runStackedAction");
    } finally {
      await mounted.cleanup();
    }
  });

  it("pushes through the git controls' recoverable push", async () => {
    setGitStatusForTests(null);
    setGitStatusForCwdForTests(SOURCE_CWD, { ...PUSHED_STATUS, aheadCount: 1 });
    const pushes: unknown[] = [];
    const { mounted } = await mountTwoMachines({ answer: () => FORK_RESULT, pushes });
    try {
      await openAnotherMachine();
      await page.getByTestId("carried-fork-push").click();
      await vi.waitFor(() => expect(pushes).toHaveLength(1));
      expect(pushes[0]).toMatchObject({
        input: { action: "push", cwd: SOURCE_CWD },
        options: { recoverable: true },
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not archive the original when the capability policy refuses it by then", async () => {
    setGitStatusForTests(null);
    setGitStatusForCwdForTests(SOURCE_CWD, PUSHED_STATUS);
    let answer!: (result: ThreadForkResult) => void;
    const answered = new Promise<ThreadForkResult>((resolve) => (answer = resolve));
    const { mounted, sourceCalls } = await mountTwoMachines({ answer: () => answered });
    try {
      await openAnotherMachine();
      await page.getByTestId("carried-fork-archive").getByRole("checkbox").click();
      await page.getByTestId("carried-fork-submit").click();
      await vi.waitFor(() => expect(carriedRequests()).toHaveLength(1), { timeout: 10_000 });
      // The source's session went stale while the other machine created the fork.
      refusedMethods.add(ORCHESTRATION_WS_METHODS.dispatchCommand);
      answer(FORK_RESULT);
      await vi.waitFor(() => expect(carriedPhase()).toBe("opening"), { timeout: 10_000 });
      expect(sourceCalls).not.toContain("dispatchCommand");
      // The user is told to archive it themselves, and why it was not.
      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("The fork was created, but the original couldn't be archived.");
        expect(text).toContain("unavailable while Hub authorization or the relay is stale");
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
