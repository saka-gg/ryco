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
  ThreadId,
  type ThreadForkResult,
  TurnId,
  WS_METHODS,
} from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

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

const PUSHED_STATUS = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/login",
  hasWorkingTreeChanges: true,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
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

/** The source machine: it only answers history reads, and records every call it gets. */
function sourceApi(calls: string[]): EnvironmentApi {
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

describe("Fork from here → Another machine (full app)", () => {
  setupChatViewBrowserSuite();

  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    useSavedEnvironmentRuntimeStore.getState().clear(SOURCE);
  });

  it("reads the conversation from the source and sends one threads.forkCarried to the picked machine", async () => {
    setGitStatusForTests(null);
    setGitStatusForCwdForTests(SOURCE_CWD, PUSHED_STATUS);
    const result: ThreadForkResult = {
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
      resolveRpc: (body) => (body._tag === WS_METHODS.threadsForkCarried ? result : undefined),
    });
    try {
      await waitForServerConfigToApply();
      const sourceCalls: string[] = [];
      __setEnvironmentApiOverrideForTests(SOURCE, sourceApi(sourceCalls));
      useSavedEnvironmentRuntimeStore.getState().patch(SOURCE, { serverConfig: sourceConfig() });
      useStore.getState().syncServerShellSnapshot(sourceShellSnapshot(), SOURCE);

      openForkThreadDialog({
        sourceThreadRef: scopeThreadRef(SOURCE, SOURCE_THREAD),
        sourceMessageId: REPLY_1,
        sourceTurnId: TURN_1,
        boundaryText: "Split the session check first.",
        checkpointAvailable: false,
      });
      await expect.element(page.getByTestId("fork-thread-dialog")).toBeVisible();
      await page.getByTestId("fork-thread-machine-other").click();
      await vi.waitFor(() =>
        expect(
          document.querySelector('[data-testid="carried-fork-branch"]')?.textContent ?? "",
        ).toContain("from origin/feature/login."),
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
        start: { kind: "base-ref", baseRef: "origin/feature/login" },
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
});
