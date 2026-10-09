import "../index.css";

import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import { EnvironmentId, ThreadId, type ServerConfig, type VcsStatusResult } from "@ryco/contracts";
import { useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const SHARED_THREAD_ID = ThreadId.make("thread-shared");
const ENVIRONMENT_A = EnvironmentId.make("environment-local");
const ENVIRONMENT_B = EnvironmentId.make("environment-remote");
const GIT_CWD = "/repo/project";
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
  refreshGitStatusSpy,
  runStackedActionMutateAsyncSpy,
  setDraftThreadContextSpy,
  setThreadBranchSpy,
  toastAddSpy,
  toastCloseSpy,
  toastPromiseSpy,
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
  refreshGitStatusSpy: vi.fn(() => Promise.resolve(null)),
  runStackedActionMutateAsyncSpy: vi.fn(() => activeRunStackedActionDeferredRef.current.promise),
  setDraftThreadContextSpy: vi.fn(),
  setThreadBranchSpy: vi.fn(),
  toastAddSpy: vi.fn(() => "toast-1"),
  toastCloseSpy: vi.fn(),
  toastPromiseSpy: vi.fn(),
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
    promise: toastPromiseSpy,
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
                  branch: BRANCH_NAME,
                  worktreePath: null,
                },
              }
            : {},
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
                  branch: BRANCH_NAME,
                  worktreePath: null,
                },
              }
            : {},
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

  it("does not overwrite a selected base branch while a new worktree draft is being configured", async () => {
    hasServerThreadRef.current = false;
    activeDraftThreadRef.current = {
      threadId: SHARED_THREAD_ID,
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

describe('GitActionsControl appearance="actions"', () => {
  const changedFiles = ["a.ts", "b.ts", "c.ts"].map((path) => ({
    path,
    insertions: 2,
    deletions: 1,
  }));

  const mounted: Array<{ unmount: () => Promise<void> | void; host: HTMLElement }> = [];

  beforeEach(() => {
    liveBranchRef.current = BRANCH_NAME;
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

  async function mountActions(overrides: Partial<VcsStatusResult>) {
    gitStatusOverridesRef.current = overrides;
    const host = document.createElement("div");
    host.style.width = "244px";
    document.body.append(host);
    const screen = await render(
      <GitActionsControl
        gitCwd={GIT_CWD}
        activeThreadRef={scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID)}
        appearance="actions"
      />,
      { container: host },
    );
    mounted.push({ unmount: () => screen.unmount(), host });
    const tile = (id: string) => host.querySelector<HTMLButtonElement>(`[data-tile="${id}"]`)!;
    /** The disabled reason a tile's tooltip shows, linked as its accessible description. */
    const reason = (id: string) => {
      const describedBy = tile(id).getAttribute("aria-describedby");
      return describedBy ? (document.getElementById(describedBy)?.textContent ?? null) : null;
    };
    const remove = async () => {
      mounted.splice(
        mounted.findIndex((mount) => mount.host === host),
        1,
      );
      await screen.unmount();
      host.remove();
    };
    return { host, tile, reason, remove };
  }

  it("names, counts and explains each button, and marks the recommended step", async () => {
    const { host, tile, reason } = await mountActions({
      hasWorkingTreeChanges: true,
      workingTree: { files: changedFiles, insertions: 6, deletions: 3 },
      aheadCount: 2,
      behindCount: 1,
    });

    await expect.element(page.getByRole("group", { name: "Git actions" })).toBeVisible();
    expect(
      [...host.querySelectorAll("[data-tile]")].map((el) => el.getAttribute("aria-label")),
    ).toEqual(["Commit 3 files", "Push 2 commits", "Create PR", "Pull 1 commit"]);
    // A disabled tile drops its count badge: it cannot move what it counts.
    expect([...host.querySelectorAll("[data-tile]")].map((el) => el.textContent)).toEqual([
      "3Commit",
      "Push",
      "Create PR",
      "1Pull",
    ]);

    expect(tile("commit").getAttribute("aria-disabled")).toBeNull();
    expect(tile("commit").dataset.recommended).toBe("true");
    expect(tile("push").getAttribute("aria-disabled")).toBe("true");
    expect(reason("push")).toBe("Commit or stash local changes before pushing.");
    expect(reason("pr")).toBe("Commit local changes before creating a pull request.");
    expect(tile("pull").getAttribute("aria-disabled")).toBeNull();
    expect(tile("pull").hasAttribute("aria-describedby")).toBe(false);
    for (const id of ["push", "pr", "pull"]) expect(tile(id).dataset.recommended).toBeUndefined();

    // Four equal tiles in one row inside a 244px column.
    const rects = [...host.querySelectorAll<HTMLElement>("[data-tile]")].map((el) =>
      el.getBoundingClientRect(),
    );
    expect(new Set(rects.map((rect) => Math.round(rect.top))).size).toBe(1);
    expect(new Set(rects.map((rect) => Math.round(rect.width))).size).toBe(1);
    for (const el of host.querySelectorAll<HTMLElement>("[data-tile] > span:last-child")) {
      expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
    }

    // A disabled tile stays focusable but does nothing.
    tile("push").focus();
    expect(document.activeElement).toBe(tile("push"));
    await page.getByRole("button", { name: "Push 2 commits" }).click({ force: true });
    expect(runStackedActionMutateAsyncSpy).not.toHaveBeenCalled();
  });

  it("shows a disabled tile's reason in a tooltip on hover", async () => {
    await mountActions({
      hasWorkingTreeChanges: true,
      workingTree: { files: changedFiles, insertions: 6, deletions: 3 },
      aheadCount: 2,
      behindCount: 1,
    });
    await page.getByRole("button", { name: "Push 2 commits" }).hover();
    await vi.waitFor(() => {
      const popup = document.querySelector('[data-slot="tooltip-popup"]');
      expect(popup?.textContent).toBe("Commit or stash local changes before pushing.");
    });
  });

  it("tells keyboard focus apart from the recommended step", async () => {
    const { tile } = await mountActions({
      hasWorkingTreeChanges: true,
      workingTree: { files: changedFiles, insertions: 6, deletions: 3 },
      behindCount: 1,
    });
    expect(tile("commit").dataset.recommended).toBe("true");
    tile("commit").focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(tile("push"));
    await userEvent.keyboard("{Tab}{Tab}");
    expect(document.activeElement).toBe(tile("pull"));
    const focused = getComputedStyle(tile("pull"));
    expect(focused.outlineStyle).toBe("solid");
    expect(focused.outlineColor).not.toBe(getComputedStyle(tile("commit")).borderTopColor);
    expect(focused.outlineColor).not.toBe(focused.borderTopColor);
  });

  it("keeps ticking a started action's elapsed time after the control unmounts", async () => {
    const { tile, remove } = await mountActions({ aheadCount: 2 });
    vi.useFakeTimers();
    try {
      tile("push").click();
      await remove();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(toastUpdateSpy).toHaveBeenLastCalledWith(
        "toast-1",
        expect.objectContaining({ type: "loading", title: "Pushing..." }),
      );
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

  it("opens the commit dialog from Commit instead of committing", async () => {
    await mountActions({
      hasWorkingTreeChanges: true,
      workingTree: { files: changedFiles, insertions: 6, deletions: 3 },
    });

    await page.getByRole("button", { name: "Commit 3 files" }).click();
    await expect.element(page.getByRole("dialog", { name: "Commit changes" })).toBeVisible();
    expect(runStackedActionMutateAsyncSpy).not.toHaveBeenCalled();
  });

  it("pushes and creates the change request through the shared git action", async () => {
    const { tile } = await mountActions({ aheadCount: 2 });
    expect(tile("pr").dataset.recommended).toBe("true");

    await page.getByRole("button", { name: "Push 2 commits" }).click();
    expect(runStackedActionMutateAsyncSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "push", worktreeId: null }),
    );
    expect(toastAddSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Pushing...", type: "loading" }),
    );

    await page.getByRole("button", { name: "Create PR" }).click();
    expect(runStackedActionMutateAsyncSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "create_pr" }),
    );
  });

  it("asks before pushing to the default ref", async () => {
    await mountActions({ aheadCount: 1, isDefaultRef: true });

    await page.getByRole("button", { name: "Push 1 commit" }).click();
    await expect.element(page.getByRole("dialog", { name: "Push to default ref?" })).toBeVisible();
    expect(runStackedActionMutateAsyncSpy).not.toHaveBeenCalled();
  });

  it("pulls only with an upstream that is ahead", async () => {
    const { tile, remove } = await mountActions({ aheadCount: 0, behindCount: 1 });
    expect(tile("pull").dataset.recommended).toBe("true");
    await page.getByRole("button", { name: "Pull 1 commit" }).click();
    expect(pullMutateAsyncSpy).toHaveBeenCalledTimes(1);
    expect(toastPromiseSpy).toHaveBeenCalledWith(
      expect.any(Promise),
      expect.objectContaining({ loading: expect.objectContaining({ title: "Pulling..." }) }),
    );
    await remove();

    const upToDate = await mountActions({ aheadCount: 0 });
    expect(upToDate.reason("pull")).toBe("Up to date");
    expect(upToDate.tile("pull").getAttribute("aria-label")).toBe("Pull");
    await upToDate.remove();

    const noUpstream = await mountActions({ hasUpstream: false, behindCount: 1 });
    expect(noUpstream.reason("pull")).toBe("No upstream");
    await page.getByRole("button", { name: "Pull 1 commit" }).click({ force: true });
    expect(pullMutateAsyncSpy).toHaveBeenCalledTimes(1);
  });

  it("views an open change request instead of creating one", async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    localApiRef.current = { shell: { openExternal } };
    const { tile } = await mountActions({
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
    expect(tile("pr").dataset.recommended).toBe("true");

    await page.getByRole("button", { name: "View PR" }).click();
    expect(openExternal).toHaveBeenCalledWith("https://github.com/ryco/ryco/pull/12");
  });

  it("offers Publish in place of Push without a primary remote", async () => {
    const { tile, reason } = await mountActions({ hasPrimaryRemote: false, hasUpstream: false });
    expect(tile("push").getAttribute("aria-label")).toBe("Publish repository");
    expect(tile("push").textContent).toBe("Publish");
    expect(tile("push").dataset.recommended).toBe("true");
    expect(tile("pr").getAttribute("aria-disabled")).toBe("true");
    expect(reason("pr")).toBe('Add an "origin" remote before creating a pull request.');

    await page.getByRole("button", { name: "Publish repository" }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
  });

  it("disables every button while a git action runs", async () => {
    gitActionActivityRef.current = true;
    const { host, reason } = await mountActions({
      hasWorkingTreeChanges: true,
      workingTree: { files: changedFiles, insertions: 6, deletions: 3 },
      behindCount: 1,
    });
    const tiles = [...host.querySelectorAll<HTMLElement>("[data-tile]")];
    expect(tiles).toHaveLength(4);
    for (const el of tiles) {
      expect(el.getAttribute("aria-disabled")).toBe("true");
      expect(reason(el.dataset.tile!)).toBe("Git action in progress.");
      expect(el.dataset.recommended).toBeUndefined();
    }
  });
});
