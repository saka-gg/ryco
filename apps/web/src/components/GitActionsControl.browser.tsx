import "../index.css";

import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
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
  setDraftThreadContextSpy: vi.fn(),
  setThreadBranchSpy: vi.fn(),
  toastAddSpy: vi.fn(() => "toast-1"),
  toastCloseSpy: vi.fn(),
  toastUpdateSpy: vi.fn(),
}));

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
  useGitMutation: vi.fn((options: { trackingKey?: string | null }) => {
    const trackingKey = options.trackingKey ?? "";
    if (typeof trackingKey === "string" && trackingKey.includes("run-stacked-action")) {
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

function setEnvironmentConfig(environmentId: EnvironmentId, prefix: string | null) {
  // Only the branch prefix is consumed by this component's configuration seam.
  const serverConfig =
    prefix === null ? null : ({ settings: { worktreeBranchPrefix: prefix } } as ServerConfig);
  if (environmentId === ENVIRONMENT_A) {
    primaryServerConfigRef.current = serverConfig;
  } else {
    useSavedEnvironmentRuntimeStore.getState().patch(environmentId, { serverConfig });
  }
}

import GitActionsControl, { GitThreadSync } from "./GitActionsControl";
import { CROWN_SHIP_GRACE_MS, useCrownShipBinding } from "./chat/useCrownShipBinding";
import type { CrownShipBinding } from "./overview/crown/crownTypes";
import { presentGitActionNotices, type GitActionNotice } from "~/gitActionNotices";

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
        threadPriorityRanking: false,
      },
    });
    setEnvironmentConfig(ENVIRONMENT_A, "ryco");
    setEnvironmentConfig(ENVIRONMENT_B, "team/saved");
    liveBranchRef.current = BRANCH_NAME;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    activeRunStackedActionDeferredRef.current = createDeferredPromise<never>();
    activeDraftThreadRef.current = null;
    hasServerThreadRef.current = true;
    serverThreadWorktreePathRef.current = null;
    primaryServerConfigRef.current = null;
    resetPrimaryEnvironmentDescriptorForTests();
    resetSavedEnvironmentRuntimeStoreForTests();
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
    vi.clearAllMocks();
    activeRunStackedActionDeferredRef.current = createDeferredPromise<never>();
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
