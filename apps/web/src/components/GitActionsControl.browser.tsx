import "../index.css";

import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  EnvironmentId,
  GitActionResultUnavailableError,
  GitActionStoppedError,
  ProjectId,
  ThreadId,
  type EnvironmentApi,
  type GitActionProgressEvent,
  type GitActionRecoveryState,
  type ServerConfig,
  type VcsStatusResult,
} from "@ryco/contracts";
import { useLayoutEffect, useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const SHARED_THREAD_ID = ThreadId.make("thread-shared");
const ENVIRONMENT_A = EnvironmentId.make("environment-local");
const ENVIRONMENT_B = EnvironmentId.make("environment-remote");
const GIT_CWD = "/repo/project";
const PROJECT_ID = ProjectId.make("project-shared");
const WORKTREE_CWD = "/repo/worktrees/0a1b_task";
const BRANCH_NAME = "feature/toast-scope";

function createDeferredPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

const {
  activeRunStackedActionDeferredRef,
  activeDraftThreadRef,
  gitActionActivityRef,
  gitStatusOverridesRef,
  localApiRef,
  primaryServerConfigRef,
  pullMutateAsyncSpy,
  liveBranchRef,
  hasServerThreadRef,
  serverThreadWorktreePathRef,
  refreshGitStatusSpy,
  runStackedActionMutateAsyncSpy,
  runStackedActionMutationRef,
  setDraftThreadContextSpy,
  setThreadBranchSpy,
  toastAddSpy,
  toastCloseSpy,
  toastUpdateSpy,
} = vi.hoisted(() => ({
  activeRunStackedActionDeferredRef: { current: createDeferredPromise<never>() },
  activeDraftThreadRef: { current: null as unknown },
  gitActionActivityRef: { current: false },
  gitStatusOverridesRef: { current: {} as Partial<VcsStatusResult> },
  localApiRef: { current: null as unknown },
  primaryServerConfigRef: { current: null as ServerConfig | null },
  pullMutateAsyncSpy: vi.fn(() =>
    Promise.resolve({ status: "pulled", refName: "feature/toast-scope", upstreamRef: null }),
  ),
  liveBranchRef: { current: "" },
  hasServerThreadRef: { current: true },
  serverThreadWorktreePathRef: { current: null as string | null },
  refreshGitStatusSpy: vi.fn(() => Promise.resolve(null)),
  runStackedActionMutateAsyncSpy: vi.fn(() => activeRunStackedActionDeferredRef.current.promise),
  /** The runner's stacked-action mutation, as handed to `useGitMutation`. */
  runStackedActionMutationRef: { current: null as MockGitMutationOptions | null },
  setDraftThreadContextSpy: vi.fn(),
  setThreadBranchSpy: vi.fn(),
  toastAddSpy: vi.fn(() => "toast-1"),
  toastCloseSpy: vi.fn(),
  toastUpdateSpy: vi.fn(),
}));

interface MockGitMutationOptions {
  readonly trackingKey?: string | null;
  readonly mutationFn: (args: unknown) => Promise<unknown>;
}

vi.mock("~/rpc/serverState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/rpc/serverState")>()),
  useServerConfig: () => primaryServerConfigRef.current,
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: {
    add: toastAddSpy,
    close: toastCloseSpy,
    update: toastUpdateSpy,
  },
  stackedThreadToast: vi.fn((options: unknown) => options),
}));

vi.mock("~/editorPreferences", () => ({
  openInPreferredEditor: vi.fn(),
}));

vi.mock("~/rpc/useGit", () => ({
  GIT_USER_ACTION_KIND: {
    runStackedAction: "run-stacked-action",
    pull: "pull",
    publishRepository: "publish-repository",
  },
  gitMutationTrackingKey: (kind: string, environmentId: string | null, cwd: string | null) =>
    `git-mutation:${kind}:${environmentId ?? ""}:${cwd ?? ""}`,
  gitScopeKey: (cwd: string | null) => `git:${cwd ?? ""}`,
  invalidateScopes: vi.fn(),
  useGitActionActivity: vi.fn(() => gitActionActivityRef.current),
  useIsGitMutating: vi.fn(() => false),
  useGitMutation: vi.fn((options: MockGitMutationOptions) => {
    const trackingKey = options.trackingKey ?? "";
    if (typeof trackingKey === "string" && trackingKey.includes("run-stacked-action")) {
      runStackedActionMutationRef.current = options;
      return {
        mutate: vi.fn(),
        mutateAsync: runStackedActionMutateAsyncSpy,
        isPending: false,
        error: null,
        reset: vi.fn(),
      };
    }
    if (typeof trackingKey === "string" && trackingKey.includes(":pull:")) {
      return {
        mutate: vi.fn(),
        mutateAsync: pullMutateAsyncSpy,
        isPending: false,
        error: null,
        reset: vi.fn(),
      };
    }
    return {
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
      error: null,
      reset: vi.fn(),
    };
  }),
}));

vi.mock("~/lib/gitStatusState", () => ({
  refreshGitStatus: refreshGitStatusSpy,
  resetGitStatusStateForTests: () => undefined,
  useGitStatus: vi.fn(() => ({
    data: {
      isRepo: true,
      sourceControlProvider: {
        kind: "github",
        name: "GitHub",
        baseUrl: "https://github.com",
      },
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: liveBranchRef.current,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 1,
      behindCount: 0,
      pr: null,
      ...gitStatusOverridesRef.current,
    },
    error: null,
    isPending: false,
  })),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: vi.fn(() => {
    throw new Error("ensureLocalApi not implemented in browser test");
  }),
  readLocalApi: vi.fn(() => localApiRef.current),
}));

vi.mock("~/composerDraftStore", async () => {
  const draftStoreState = {
    getDraftThreadByRef: () => activeDraftThreadRef.current,
    getDraftSession: () => activeDraftThreadRef.current,
    getDraftThread: () => activeDraftThreadRef.current,
    getDraftSessionByLogicalProjectKey: () => null,
    setDraftThreadContext: setDraftThreadContextSpy,
    setLogicalProjectDraftThreadId: vi.fn(),
    setProjectDraftThreadId: vi.fn(),
    hasDraftThreadsInEnvironment: () => false,
    clearDraftThread: vi.fn(),
  };

  return {
    DraftId: {
      makeUnsafe: (value: string) => value,
    },
    useComposerDraftStore: Object.assign(
      (selector: (state: unknown) => unknown) => selector(draftStoreState),
      { getState: () => draftStoreState },
    ),
    markPromotedDraftThread: vi.fn(),
    markPromotedDraftThreadByRef: vi.fn(),
    markPromotedDraftThreads: vi.fn(),
    markPromotedDraftThreadsByRef: vi.fn(),
    finalizePromotedDraftThreadByRef: vi.fn(),
    finalizePromotedDraftThreadsByRef: vi.fn(),
  };
});

vi.mock("~/store", () => ({
  selectEnvironmentState: (
    state: { environmentStateById: Record<string, unknown> },
    environmentId: string | null,
  ) => {
    if (!environmentId) {
      throw new Error("Missing environment id");
    }
    const environmentState = state.environmentStateById[environmentId];
    if (!environmentState) {
      throw new Error(`Unknown environment: ${environmentId}`);
    }
    return environmentState;
  },
  selectProjectsForEnvironment: () => [],
  selectProjectsAcrossEnvironments: () => [],
  selectThreadsForEnvironment: () => [],
  selectThreadsAcrossEnvironments: () => [],
  selectThreadShellsAcrossEnvironments: () => [],
  selectSidebarThreadsAcrossEnvironments: () => [],
  selectSidebarThreadsForProjectRef: () => [],
  selectSidebarThreadsForProjectRefs: () => [],
  selectBootstrapCompleteForActiveEnvironment: () => true,
  selectProjectByRef: () => null,
  selectThreadByRef: () => null,
  selectSidebarThreadSummaryByRef: () => null,
  selectThreadIdsByProjectRef: () => [],
  useStore: (selector: (state: unknown) => unknown) =>
    selector({
      setThreadBranch: setThreadBranchSpy,
      environmentStateById: {
        [ENVIRONMENT_A]: {
          threadShellById: hasServerThreadRef.current
            ? {
                [SHARED_THREAD_ID]: {
                  id: SHARED_THREAD_ID,
                  projectId: PROJECT_ID,
                  branch: BRANCH_NAME,
                  worktreePath: serverThreadWorktreePathRef.current,
                },
              }
            : {},
          projectById: { [PROJECT_ID]: { id: PROJECT_ID, cwd: GIT_CWD } },
          threadSessionById: {},
          threadTurnStateById: {},
          messageIdsByThreadId: {},
          messageByThreadId: {},
          activityIdsByThreadId: {},
          activityByThreadId: {},
          proposedPlanIdsByThreadId: {},
          proposedPlanByThreadId: {},
          turnDiffIdsByThreadId: {},
          turnDiffSummaryByThreadId: {},
        },
        [ENVIRONMENT_B]: {
          threadShellById: hasServerThreadRef.current
            ? {
                [SHARED_THREAD_ID]: {
                  id: SHARED_THREAD_ID,
                  projectId: PROJECT_ID,
                  branch: BRANCH_NAME,
                  worktreePath: serverThreadWorktreePathRef.current,
                },
              }
            : {},
          projectById: { [PROJECT_ID]: { id: PROJECT_ID, cwd: GIT_CWD } },
          threadSessionById: {},
          threadTurnStateById: {},
          messageIdsByThreadId: {},
          messageByThreadId: {},
          activityIdsByThreadId: {},
          activityByThreadId: {},
          proposedPlanIdsByThreadId: {},
          proposedPlanByThreadId: {},
          turnDiffIdsByThreadId: {},
          turnDiffSummaryByThreadId: {},
        },
      },
    }),
}));

vi.mock("~/terminal-links", () => ({
  resolvePathLinkTarget: vi.fn(),
}));

import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "~/environments/primary";
import {
  resetSavedEnvironmentRuntimeStoreForTests,
  useSavedEnvironmentRuntimeStore,
} from "~/environments/runtime";

function setEnvironmentConfig(
  environmentId: EnvironmentId,
  prefix: string | null,
  capabilities: Partial<ServerConfig["environment"]["capabilities"]> = {},
) {
  // Only the branch prefix and the capabilities are consumed by this
  // component's configuration seam.
  const serverConfig =
    prefix === null
      ? null
      : ({
          settings: { worktreeBranchPrefix: prefix },
          environment: { capabilities },
        } as unknown as ServerConfig);
  if (environmentId === ENVIRONMENT_A) {
    primaryServerConfigRef.current = serverConfig;
  } else {
    useSavedEnvironmentRuntimeStore.getState().patch(environmentId, { serverConfig });
  }
}

import GitActionsControl, { GitThreadSync } from "./GitActionsControl";
import { CROWN_SHIP_GRACE_MS, useCrownShipBinding } from "./chat/useCrownShipBinding";
import type { CrownShipBinding } from "./overview/crown/crownTypes";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "~/environmentApi";
import {
  GIT_ACTION_RECONNECTING_DESCRIPTION,
  presentGitActionNotices,
  type GitActionNotice,
} from "~/gitActionNotices";

/**
 * Ends the git action a test left running and hands the next test a fresh
 * one. A run that never settles keeps ticking its elapsed time and would
 * report into whatever presents the same checkout in a later test.
 */
async function settleRunningStackedAction() {
  const running = activeRunStackedActionDeferredRef.current;
  running.promise.catch(() => undefined);
  running.reject(new Error("The test ended."));
  activeRunStackedActionDeferredRef.current = createDeferredPromise<never>();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function findButtonByText(text: string): HTMLButtonElement | null {
  return (Array.from(document.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text),
  ) ?? null) as HTMLButtonElement | null;
}

function Harness() {
  const [activeThreadRef, setActiveThreadRef] = useState(
    scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID),
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setActiveThreadRef(scopeThreadRef(ENVIRONMENT_B, SHARED_THREAD_ID))}
      >
        Switch environment
      </button>
      <GitActionsControl gitCwd={GIT_CWD} activeThreadRef={activeThreadRef} />
    </>
  );
}

describe("GitActionsControl thread-scoped progress toast and GitThreadSync", () => {
  beforeEach(() => {
    writePrimaryEnvironmentDescriptor({
      environmentId: ENVIRONMENT_A,
      label: "Local environment",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
        threadSettlement: false,
      },
    });
    setEnvironmentConfig(ENVIRONMENT_A, "ryco");
    setEnvironmentConfig(ENVIRONMENT_B, "team/saved");
    liveBranchRef.current = BRANCH_NAME;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await settleRunningStackedAction();
    vi.clearAllMocks();
    activeDraftThreadRef.current = null;
    hasServerThreadRef.current = true;
    serverThreadWorktreePathRef.current = null;
    primaryServerConfigRef.current = null;
    resetPrimaryEnvironmentDescriptorForTests();
    resetSavedEnvironmentRuntimeStoreForTests();
    __resetEnvironmentApiOverridesForTests();
    liveBranchRef.current = "";
    document.body.innerHTML = "";
  });

  it("keeps an in-flight git action toast pinned to the thread ref that started it", async () => {
    vi.useFakeTimers();

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<Harness />, { container: host });

    try {
      const quickActionButton = findButtonByText("Push & create PR");
      expect(quickActionButton, 'Unable to find button containing "Push & create PR"').toBeTruthy();
      if (!(quickActionButton instanceof HTMLButtonElement)) {
        throw new Error('Unable to find button containing "Push & create PR"');
      }
      quickActionButton.click();

      expect(toastAddSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { threadRef: scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID) },
          title: "Pushing...",
          type: "loading",
        }),
      );

      await vi.advanceTimersByTimeAsync(1_000);

      expect(toastUpdateSpy).toHaveBeenLastCalledWith(
        "toast-1",
        expect.objectContaining({
          data: { threadRef: scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID) },
          title: "Pushing...",
          type: "loading",
        }),
      );

      const switchEnvironmentButton = findButtonByText("Switch environment");
      expect(
        switchEnvironmentButton,
        'Unable to find button containing "Switch environment"',
      ).toBeTruthy();
      if (!(switchEnvironmentButton instanceof HTMLButtonElement)) {
        throw new Error('Unable to find button containing "Switch environment"');
      }
      switchEnvironmentButton.click();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(toastUpdateSpy).toHaveBeenLastCalledWith(
        "toast-1",
        expect.objectContaining({
          data: { threadRef: scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID) },
          title: "Pushing...",
          type: "loading",
        }),
      );
    } finally {
      activeRunStackedActionDeferredRef.current.reject(new Error("test cleanup"));
      await Promise.resolve();
      vi.useRealTimers();
      await screen.unmount();
      host.remove();
    }
  });

  it("debounces focus-driven git status refreshes", async () => {
    vi.useFakeTimers();

    const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");
    let visibilityState: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <GitThreadSync
        gitCwd={GIT_CWD}
        activeThreadRef={scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID)}
      />,
      {
        container: host,
      },
    );

    try {
      window.dispatchEvent(new Event("focus"));
      visibilityState = "visible";
      document.dispatchEvent(new Event("visibilitychange"));

      expect(refreshGitStatusSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(249);
      expect(refreshGitStatusSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(refreshGitStatusSpy).toHaveBeenCalledTimes(1);
      expect(refreshGitStatusSpy).toHaveBeenCalledWith({
        environmentId: ENVIRONMENT_A,
        cwd: GIT_CWD,
      });
    } finally {
      if (originalVisibilityState) {
        Object.defineProperty(document, "visibilityState", originalVisibilityState);
      }
      vi.useRealTimers();
      await screen.unmount();
      host.remove();
    }
  });

  it("syncs the live branch into the active draft thread when no server thread exists", async () => {
    hasServerThreadRef.current = false;
    activeDraftThreadRef.current = {
      threadId: SHARED_THREAD_ID,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_A,
      branch: null,
      worktreePath: null,
    };

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <GitThreadSync
        gitCwd={GIT_CWD}
        activeThreadRef={scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID)}
      />,
      {
        container: host,
      },
    );

    try {
      await Promise.resolve();

      expect(setDraftThreadContextSpy).toHaveBeenCalledWith(
        scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID),
        {
          branch: BRANCH_NAME,
          worktreePath: null,
        },
      );
      expect(setThreadBranchSpy).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  describe.each([
    { environment: "primary", environmentId: ENVIRONMENT_A },
    { environment: "saved", environmentId: ENVIRONMENT_B },
  ])("$environment environment draft", ({ environmentId }) => {
    it.each(["ryco", "team/custom", ""])(
      "waits for configuration, then syncs with prefix %j",
      async (worktreeBranchPrefix) => {
        hasServerThreadRef.current = false;
        activeDraftThreadRef.current = {
          threadId: SHARED_THREAD_ID,
          projectId: PROJECT_ID,
          environmentId,
          branch: null,
          worktreePath: null,
        };
        setEnvironmentConfig(environmentId, null);
        const threadRef = scopeThreadRef(environmentId, SHARED_THREAD_ID);
        const screen = await render(<GitThreadSync gitCwd={GIT_CWD} activeThreadRef={threadRef} />);

        try {
          expect(setDraftThreadContextSpy).not.toHaveBeenCalled();
          expect(setThreadBranchSpy).not.toHaveBeenCalled();

          setEnvironmentConfig(environmentId, worktreeBranchPrefix);
          await screen.rerender(<GitThreadSync gitCwd={GIT_CWD} activeThreadRef={threadRef} />);

          expect(setDraftThreadContextSpy).toHaveBeenCalledExactlyOnceWith(threadRef, {
            branch: BRANCH_NAME,
            worktreePath: null,
          });
          expect(setThreadBranchSpy).not.toHaveBeenCalled();
        } finally {
          await screen.unmount();
        }
      },
    );

    it("preserves a semantic branch only for its own temporary namespace", async () => {
      hasServerThreadRef.current = false;
      activeDraftThreadRef.current = {
        threadId: SHARED_THREAD_ID,
        projectId: PROJECT_ID,
        environmentId,
        branch: "feature/meaningful-name",
        worktreePath: null,
      };
      setEnvironmentConfig(ENVIRONMENT_A, "team/primary");
      liveBranchRef.current =
        environmentId === ENVIRONMENT_A ? "team/primary/deadbeef" : "team/saved/deadbeef";
      const threadRef = scopeThreadRef(environmentId, SHARED_THREAD_ID);
      const screen = await render(<GitThreadSync gitCwd={GIT_CWD} activeThreadRef={threadRef} />);

      try {
        expect(setDraftThreadContextSpy).not.toHaveBeenCalled();

        liveBranchRef.current =
          environmentId === ENVIRONMENT_A ? "team/saved/deadbeef" : "team/primary/deadbeef";
        await screen.rerender(<GitThreadSync gitCwd={GIT_CWD} activeThreadRef={threadRef} />);

        expect(setDraftThreadContextSpy).toHaveBeenCalledExactlyOnceWith(threadRef, {
          branch: liveBranchRef.current,
          worktreePath: null,
        });
        expect(setThreadBranchSpy).not.toHaveBeenCalled();
      } finally {
        await screen.unmount();
      }
    });
  });

  it("records only the branch of the thread's own checkout", async () => {
    serverThreadWorktreePathRef.current = WORKTREE_CWD;
    liveBranchRef.current = "main";
    const threadRef = scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID);
    // The project root's status while the view still follows the promoted draft.
    const screen = await render(<GitThreadSync gitCwd={GIT_CWD} activeThreadRef={threadRef} />);

    try {
      await Promise.resolve();
      expect(setThreadBranchSpy).not.toHaveBeenCalled();

      liveBranchRef.current = "fix/live-name";
      await screen.rerender(<GitThreadSync gitCwd={WORKTREE_CWD} activeThreadRef={threadRef} />);
      expect(setThreadBranchSpy).toHaveBeenCalledExactlyOnceWith(
        threadRef,
        "fix/live-name",
        WORKTREE_CWD,
      );
    } finally {
      await screen.unmount();
    }
  });

  describe.each([
    { environment: "primary", environmentId: ENVIRONMENT_A },
    { environment: "saved", environmentId: ENVIRONMENT_B },
  ])("$environment environment started thread", ({ environmentId }) => {
    function stubDispatch() {
      const dispatchCommand = vi.fn((_command: unknown) => Promise.resolve({ sequence: 1 }));
      __setEnvironmentApiOverrideForTests(environmentId, {
        orchestration: { dispatchCommand },
      } as unknown as EnvironmentApi);
      return dispatchCommand;
    }

    it("leaves the branch to a node that records it", async () => {
      const dispatchCommand = stubDispatch();
      serverThreadWorktreePathRef.current = WORKTREE_CWD;
      setEnvironmentConfig(environmentId, "ryco", { threadBranchAdoption: true });
      liveBranchRef.current = "feat/agent-branch";
      const threadRef = scopeThreadRef(environmentId, SHARED_THREAD_ID);
      const screen = await render(
        <GitThreadSync gitCwd={WORKTREE_CWD} activeThreadRef={threadRef} />,
      );

      try {
        await Promise.resolve();
        liveBranchRef.current = "feat/agent-other";
        await screen.rerender(<GitThreadSync gitCwd={WORKTREE_CWD} activeThreadRef={threadRef} />);
        await Promise.resolve();

        expect(setThreadBranchSpy).not.toHaveBeenCalled();
        expect(dispatchCommand).not.toHaveBeenCalled();
      } finally {
        await screen.unmount();
      }
    });

    it("still records it for an older node", async () => {
      const dispatchCommand = stubDispatch();
      serverThreadWorktreePathRef.current = WORKTREE_CWD;
      // An older node's config has no `threadBranchAdoption` key.
      setEnvironmentConfig(environmentId, "ryco");
      liveBranchRef.current = "feat/agent-branch";
      const threadRef = scopeThreadRef(environmentId, SHARED_THREAD_ID);
      const screen = await render(
        <GitThreadSync gitCwd={WORKTREE_CWD} activeThreadRef={threadRef} />,
      );

      try {
        await Promise.resolve();

        expect(setThreadBranchSpy).toHaveBeenCalledExactlyOnceWith(
          threadRef,
          "feat/agent-branch",
          WORKTREE_CWD,
        );
        expect(dispatchCommand).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            type: "thread.meta.update",
            threadId: SHARED_THREAD_ID,
            branch: "feat/agent-branch",
            worktreePath: WORKTREE_CWD,
          }),
        );
      } finally {
        await screen.unmount();
      }
    });

    it("keeps following the checkout into a draft on a node that records started threads", async () => {
      const dispatchCommand = stubDispatch();
      hasServerThreadRef.current = false;
      activeDraftThreadRef.current = {
        threadId: SHARED_THREAD_ID,
        projectId: PROJECT_ID,
        environmentId,
        branch: null,
        worktreePath: null,
      };
      setEnvironmentConfig(environmentId, "ryco", { threadBranchAdoption: true });
      const threadRef = scopeThreadRef(environmentId, SHARED_THREAD_ID);
      const screen = await render(<GitThreadSync gitCwd={GIT_CWD} activeThreadRef={threadRef} />);

      try {
        await Promise.resolve();

        expect(setDraftThreadContextSpy).toHaveBeenCalledExactlyOnceWith(threadRef, {
          branch: BRANCH_NAME,
          worktreePath: null,
        });
        expect(setThreadBranchSpy).not.toHaveBeenCalled();
        expect(dispatchCommand).not.toHaveBeenCalled();
      } finally {
        await screen.unmount();
      }
    });
  });

  it("does not overwrite a selected base branch while a new worktree draft is being configured", async () => {
    hasServerThreadRef.current = false;
    activeDraftThreadRef.current = {
      threadId: SHARED_THREAD_ID,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_A,
      branch: "feature/base-branch",
      worktreePath: null,
      envMode: "worktree",
    };

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <GitThreadSync
        gitCwd={GIT_CWD}
        activeThreadRef={scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID)}
      />,
      {
        container: host,
      },
    );

    try {
      await Promise.resolve();

      expect(setDraftThreadContextSpy).not.toHaveBeenCalled();
      expect(setThreadBranchSpy).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});

describe("useCrownShipBinding", () => {
  const changedFiles = ["a.ts", "b.ts", "c.ts"].map((path) => ({
    path,
    insertions: 2,
    deletions: 1,
  }));
  const dirty = {
    hasWorkingTreeChanges: true,
    workingTree: { files: changedFiles, insertions: 6, deletions: 3 },
    aheadCount: 0,
  } satisfies Partial<VcsStatusResult>;

  const mounted: Array<{ unmount: () => Promise<void> | void; host: HTMLElement }> = [];
  /** The probe's latest binding, read by the assertions. */
  const shipRef: { current: CrownShipBinding | undefined } = { current: undefined };

  beforeEach(() => {
    liveBranchRef.current = BRANCH_NAME;
    shipRef.current = undefined;
  });

  afterEach(async () => {
    for (const mount of mounted.splice(0)) {
      await mount.unmount();
      mount.host.remove();
    }
    await settleRunningStackedAction();
    vi.clearAllMocks();
    gitStatusOverridesRef.current = {};
    gitActionActivityRef.current = false;
    localApiRef.current = null;
    liveBranchRef.current = "";
    document.body.innerHTML = "";
  });

  function ShipProbe() {
    const { ship, dialog } = useCrownShipBinding({
      gitCwd: GIT_CWD,
      activeThreadRef: scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID),
      enabled: true,
    });
    useLayoutEffect(() => {
      shipRef.current = ship;
    });
    return (
      <>
        <button type="button" onClick={ship?.ship}>
          Ship
        </button>
        {ship?.pull ? (
          <button type="button" onClick={ship.pull}>
            Pull only
          </button>
        ) : null}
        {dialog}
      </>
    );
  }

  async function mountShip(overrides: Partial<VcsStatusResult>) {
    gitStatusOverridesRef.current = overrides;
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<ShipProbe />, { container: host });
    mounted.push({ unmount: () => screen.unmount(), host });
    const remove = async () => {
      mounted.splice(
        mounted.findIndex((mount) => mount.host === host),
        1,
      );
      await screen.unmount();
      host.remove();
    };
    return { remove };
  }

  function collectNotices() {
    const notices: GitActionNotice[] = [];
    const release = presentGitActionNotices(ENVIRONMENT_A, GIT_CWD, (notice) =>
      notices.push(notice),
    );
    return { notices, release };
  }

  it("ships local changes in one click once the grace has passed", async () => {
    const { notices, release } = collectNotices();
    await mountShip(dirty);
    expect(shipRef.current?.steps).toEqual(["commit", "push", "pr"]);
    expect(shipRef.current?.label).toBe("Commit, push & create PR");

    await page.getByRole("button", { name: "Ship" }).click();
    expect(shipRef.current?.phase).toBe("arming");
    expect(notices.at(-1)).toMatchObject({ status: "running", title: "Shipping in a moment…" });
    expect(runStackedActionMutateAsyncSpy).not.toHaveBeenCalled();

    await expect
      .poll(() => runStackedActionMutateAsyncSpy.mock.calls.length, {
        timeout: CROWN_SHIP_GRACE_MS + 1_000,
      })
      .toBe(1);
    expect(runStackedActionMutateAsyncSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "commit_push_pr" }),
    );
    expect(shipRef.current?.phase).toBe("running");
    expect(shipRef.current?.runSteps).toEqual(["commit", "push", "pr"]);
    expect(notices.at(-1)?.title).not.toBe("Shipping in a moment…");
    release();
  });

  it("follows the server's phases as the running step", async () => {
    await mountShip(dirty);
    await page.getByRole("button", { name: "Ship" }).click();
    await expect
      .poll(() => runStackedActionMutateAsyncSpy.mock.calls.length, {
        timeout: CROWN_SHIP_GRACE_MS + 1_000,
      })
      .toBe(1);
    expect(shipRef.current?.activeStep).toBe("commit");
    const [args] = runStackedActionMutateAsyncSpy.mock.calls[0] as unknown as [
      { actionId: string; onProgress: (event: unknown) => void },
    ];
    args.onProgress({
      kind: "phase_started",
      actionId: args.actionId,
      cwd: GIT_CWD,
      phase: "push",
      label: "Pushing...",
    });
    await expect.poll(() => shipRef.current?.activeStep).toBe("push");
  });

  it("takes the click back with a second click or Escape", async () => {
    const { notices, release } = collectNotices();
    await mountShip(dirty);

    await page.getByRole("button", { name: "Ship" }).click();
    await page.getByRole("button", { name: "Ship" }).click();
    expect(shipRef.current?.phase).toBe("idle");
    expect(notices.at(-1)).toMatchObject({ status: "cancelled", title: "Ship cancelled" });

    await page.getByRole("button", { name: "Ship" }).click();
    expect(shipRef.current?.phase).toBe("arming");
    await userEvent.keyboard("{Escape}");
    expect(shipRef.current?.phase).toBe("idle");

    await new Promise((resolve) => setTimeout(resolve, CROWN_SHIP_GRACE_MS + 300));
    expect(runStackedActionMutateAsyncSpy).not.toHaveBeenCalled();
    release();
  });

  it("pulls first when the branch is behind, then runs the rest", async () => {
    await mountShip({ ...dirty, behindCount: 2 });
    expect(shipRef.current?.steps).toEqual(["pull", "commit", "push", "pr"]);

    await page.getByRole("button", { name: "Ship" }).click();
    await expect
      .poll(() => runStackedActionMutateAsyncSpy.mock.calls.length, {
        timeout: CROWN_SHIP_GRACE_MS + 1_000,
      })
      .toBe(1);
    expect(pullMutateAsyncSpy).toHaveBeenCalledTimes(1);
    expect(pullMutateAsyncSpy.mock.invocationCallOrder[0]).toBeLessThan(
      runStackedActionMutateAsyncSpy.mock.invocationCallOrder[0]!,
    );
  });

  it("stops when the pull fails", async () => {
    pullMutateAsyncSpy.mockImplementationOnce(() => Promise.reject(new Error("not fast-forward")));
    await mountShip({ ...dirty, behindCount: 2 });
    await page.getByRole("button", { name: "Ship" }).click();
    await expect
      .poll(() => shipRef.current?.phase, { timeout: CROWN_SHIP_GRACE_MS + 1_000 })
      .toBe("idle");
    expect(pullMutateAsyncSpy).toHaveBeenCalledTimes(1);
    expect(runStackedActionMutateAsyncSpy).not.toHaveBeenCalled();
  });

  it("cannot ship a diverged branch", async () => {
    await mountShip({ aheadCount: 1, behindCount: 2 });
    expect(shipRef.current?.steps).toEqual([]);
    expect(shipRef.current?.disabledReason).toContain("diverged");
    expect(shipRef.current?.pull).toBeNull();
  });

  it("asks before pushing to the default ref", async () => {
    await mountShip({ aheadCount: 1, isDefaultRef: true });
    await page.getByRole("button", { name: "Ship" }).click();
    await expect
      .element(page.getByRole("dialog", { name: "Push to default ref?" }), {
        timeout: CROWN_SHIP_GRACE_MS + 1_000,
      })
      .toBeVisible();
    expect(runStackedActionMutateAsyncSpy).not.toHaveBeenCalled();
  });

  it("keeps ticking a started action's elapsed time after the crown unmounts", async () => {
    const { remove } = await mountShip({ aheadCount: 2 });
    vi.useFakeTimers();
    try {
      shipRef.current?.ship();
      await vi.advanceTimersByTimeAsync(CROWN_SHIP_GRACE_MS);
      expect(runStackedActionMutateAsyncSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: "create_pr" }),
      );
      await remove();
      await vi.advanceTimersByTimeAsync(3_000);
      const ticks = toastUpdateSpy.mock.calls.length;
      expect(ticks).toBeGreaterThanOrEqual(3);

      // The action settles: the ticker stops with it.
      activeRunStackedActionDeferredRef.current.reject(new Error("push failed"));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(toastUpdateSpy).toHaveBeenCalledTimes(ticks + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a pull to the crown presenting the checkout instead of toasting", async () => {
    const { notices, release } = collectNotices();
    await mountShip({ aheadCount: 0, behindCount: 1 });
    toastAddSpy.mockClear();
    await page.getByRole("button", { name: "Pull only" }).click();
    await expect.poll(() => notices.map((notice) => notice.status)).toEqual(["running", "success"]);
    expect(notices[1]).toMatchObject({ kind: "pull", title: "Pulled" });
    expect(toastAddSpy).not.toHaveBeenCalled();
    release();
  });

  it("opens the pull request when nothing is left to ship", async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    localApiRef.current = { shell: { openExternal } };
    await mountShip({
      aheadCount: 0,
      pr: {
        number: 12,
        title: "Crown",
        url: "https://github.com/ryco/ryco/pull/12",
        baseRef: "main",
        headRef: BRANCH_NAME,
        state: "open",
      },
    });
    expect(shipRef.current?.steps).toEqual([]);
    await page.getByRole("button", { name: "Ship" }).click();
    expect(openExternal).toHaveBeenCalledWith("https://github.com/ryco/ryco/pull/12");
    expect(shipRef.current?.phase).toBe("idle");
  });

  it("waits while another git action runs", async () => {
    gitActionActivityRef.current = true;
    await mountShip(dirty);
    expect(shipRef.current?.steps).toEqual([]);
    expect(shipRef.current?.disabledReason).toBe("Git action in progress.");
  });
});

describe("git actions that outlive their connection", () => {
  interface RunArgs {
    readonly actionId: string;
    readonly onProgress: (event: GitActionProgressEvent) => void;
    readonly onRecoveryState: (state: GitActionRecoveryState) => void;
  }
  interface ShownToast {
    readonly type?: string;
    readonly title?: string;
    readonly description?: string;
    readonly actionProps?: { readonly children: string; readonly onClick: () => void };
  }

  const mounted: Array<() => Promise<void>> = [];
  const cancelStackedAction = vi.fn((_input: { actionId: string }) =>
    Promise.resolve({ cancelled: true }),
  );

  beforeEach(() => {
    writePrimaryEnvironmentDescriptor({
      environmentId: ENVIRONMENT_A,
      label: "Local environment",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
        threadSettlement: false,
      },
    });
    setEnvironmentConfig(ENVIRONMENT_A, "ryco");
    liveBranchRef.current = BRANCH_NAME;
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_A, {
      git: { cancelStackedAction },
    } as unknown as EnvironmentApi);
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const unmount of mounted.splice(0)) await unmount();
    await settleRunningStackedAction();
    vi.clearAllMocks();
    __resetEnvironmentApiOverridesForTests();
    primaryServerConfigRef.current = null;
    resetPrimaryEnvironmentDescriptorForTests();
    liveBranchRef.current = "";
    document.body.innerHTML = "";
  });

  /** Clicks the quick action ("Push & create PR") and returns what the runner sent. */
  async function startQuickAction(): Promise<RunArgs> {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<Harness />, { container: host });
    mounted.push(async () => {
      await screen.unmount();
      host.remove();
    });
    findButtonByText("Push & create PR")?.click();
    await vi.waitFor(() => expect(runStackedActionMutateAsyncSpy).toHaveBeenCalledTimes(1));
    const [args] = runStackedActionMutateAsyncSpy.mock.calls[0] as unknown as [RunArgs];
    return args;
  }

  function lastToast(): ShownToast {
    const update = toastUpdateSpy.mock.calls.at(-1) as unknown as [string, ShownToast] | undefined;
    if (update) return update[1];
    const added = toastAddSpy.mock.calls.at(-1) as unknown as [ShownToast] | undefined;
    return added?.[0] ?? {};
  }

  const progress = {
    started: (actionId: string): GitActionProgressEvent => ({
      kind: "action_started",
      actionId,
      cwd: GIT_CWD,
      action: "create_pr",
      phases: ["push", "pr"],
    }),
    pushing: (actionId: string): GitActionProgressEvent => ({
      kind: "phase_started",
      actionId,
      cwd: GIT_CWD,
      action: "create_pr",
      phase: "push",
      label: "Pushing...",
    }),
  };

  it("asks the node to keep the action running when the connection drops", async () => {
    const runStackedAction = vi.fn(() => new Promise<never>(() => undefined));
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_A, {
      git: { runStackedAction, cancelStackedAction },
    } as unknown as EnvironmentApi);
    const screen = await render(
      <GitActionsControl
        gitCwd={GIT_CWD}
        activeThreadRef={scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID)}
      />,
    );
    mounted.push(() => screen.unmount());
    const onProgress = vi.fn();
    const onRecoveryState = vi.fn();
    void runStackedActionMutationRef.current?.mutationFn({
      actionId: "action-1",
      action: "push",
      onProgress,
      onRecoveryState,
    });
    expect(runStackedAction).toHaveBeenCalledWith(
      { action: "push", actionId: "action-1", cwd: GIT_CWD },
      { recoverable: true, onProgress, onRecoveryState },
    );
  });

  it("offers Stop on the running toast and stops the action through its own id", async () => {
    const args = await startQuickAction();
    args.onRecoveryState({ kind: "started", recoverable: true });
    args.onProgress(progress.started(args.actionId));
    await vi.waitFor(() =>
      expect(lastToast()).toMatchObject({ type: "loading", actionProps: { children: "Stop" } }),
    );

    lastToast().actionProps?.onClick();
    expect(cancelStackedAction).toHaveBeenCalledExactlyOnceWith({ actionId: args.actionId });
    expect(lastToast()).toMatchObject({ description: "Stopping...", actionProps: undefined });

    activeRunStackedActionDeferredRef.current.reject(
      new GitActionStoppedError({ actionId: args.actionId, phase: "push", reason: "requested" }),
    );
    await vi.waitFor(() =>
      expect(lastToast()).toMatchObject({
        type: "info",
        title: "Stopped",
        description: "Steps that already finished stay done.",
        actionProps: undefined,
      }),
    );
    // Some steps may have run: the checkout is read again.
    expect(refreshGitStatusSpy).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_A,
      cwd: GIT_CWD,
    });
  });

  it("offers no Stop when the node keeps request-owned actions", async () => {
    const args = await startQuickAction();
    args.onRecoveryState({ kind: "started", recoverable: false });
    args.onProgress(progress.started(args.actionId));
    args.onProgress(progress.pushing(args.actionId));
    await vi.waitFor(() => expect(lastToast()).toMatchObject({ title: "Pushing..." }));
    expect(lastToast().actionProps).toBeUndefined();
  });

  it("says it is reconnecting, and keeps the step's clock when the node replays it", async () => {
    vi.useFakeTimers();
    const args = await startQuickAction();
    args.onRecoveryState({ kind: "started", recoverable: true });
    args.onProgress(progress.started(args.actionId));
    args.onProgress(progress.pushing(args.actionId));
    await vi.advanceTimersByTimeAsync(5_000);
    const elapsedSeconds = () =>
      Number(/^Running for (\d+)s$/.exec(lastToast().description ?? "")?.[1]);
    const beforeDrop = elapsedSeconds();
    expect(beforeDrop).toBeGreaterThanOrEqual(4);
    expect(lastToast()).toMatchObject({ title: "Pushing..." });

    args.onRecoveryState({ kind: "reconnecting" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(lastToast()).toMatchObject({
      title: "Pushing...",
      description: GIT_ACTION_RECONNECTING_DESCRIPTION,
      actionProps: { children: "Stop" },
    });

    // Re-attached: the node replays the start and the current phase first.
    args.onRecoveryState({ kind: "reattached" });
    args.onProgress(progress.started(args.actionId));
    args.onProgress(progress.pushing(args.actionId));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lastToast()).toMatchObject({ title: "Pushing..." });
    expect(elapsedSeconds()).toBe(beforeDrop + 4);
  });

  it("asks to check the repository when the result is unavailable", async () => {
    const args = await startQuickAction();
    args.onRecoveryState({ kind: "started", recoverable: true });
    activeRunStackedActionDeferredRef.current.reject(
      new GitActionResultUnavailableError({ actionId: args.actionId, reason: "missing" }),
    );
    await vi.waitFor(() =>
      expect(lastToast()).toMatchObject({
        type: "error",
        title: "Couldn't confirm the Git action",
        description: "Check the repository status before trying again.",
      }),
    );
    expect(refreshGitStatusSpy).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_A,
      cwd: GIT_CWD,
    });
  });

  it("keeps the crown's live notice and its Stop when a Stop fails", async () => {
    const notices: GitActionNotice[] = [];
    const release = presentGitActionNotices(ENVIRONMENT_A, GIT_CWD, (notice) =>
      notices.push(notice),
    );
    mounted.push(() => Promise.resolve(release()));
    cancelStackedAction.mockRejectedValueOnce(new Error("Request timed out."));
    const args = await startQuickAction();
    args.onRecoveryState({ kind: "started", recoverable: true });
    args.onProgress(progress.started(args.actionId));
    args.onProgress(progress.pushing(args.actionId));
    await vi.waitFor(() => expect(notices.at(-1)?.action?.label).toBe("Stop"));

    notices.at(-1)?.action?.onClick();
    expect(cancelStackedAction).toHaveBeenCalledExactlyOnceWith({ actionId: args.actionId });
    await vi.waitFor(() =>
      expect(notices.at(-1)).toMatchObject({
        id: args.actionId,
        status: "running",
        title: "Pushing...",
        description: "Couldn't stop: Request timed out.",
        action: { label: "Stop" },
      }),
    );
    expect(toastAddSpy).not.toHaveBeenCalled();
  });
});
