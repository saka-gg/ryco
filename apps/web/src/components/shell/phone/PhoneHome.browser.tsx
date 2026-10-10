// Production CSS is part of the behavior under test: row heights and the
// phone tier variants drive the touch-target assertions.
import "../../../index.css";

import {
  DEFAULT_PROJECT_METADATA_DIR,
  type DispatchableClientOrchestrationCommand,
  EnvironmentId,
  ProviderInstanceId,
  type EnvironmentApi,
  type OrchestrationShellSnapshot,
  type ProjectId,
  type ThreadId,
  type WorktreeId,
} from "@ryco/contracts";
import {
  createEnvironmentConnection,
  type EnvironmentConnection,
} from "@ryco/client-runtime/connection";
import {
  recordWsConnectionAttempt,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
  type WsRpcClient,
} from "@ryco/client-runtime/rpc";
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const navigate = vi.fn(async () => undefined);
const routerStub = { navigate, state: { matches: [], location: { href: "/" } } };
vi.mock("../../../environments/runtime", { spy: true });
vi.mock("../../../hooks/useHandleNewThread", { spy: true });
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
  useRouter: () => routerStub,
}));

vi.mock("../../../lib/gitStatusState", () => ({
  useGitStatus: () => ({ data: null, error: null, cause: null, isPending: false }),
  useGitStatuses: () => new Map(),
  refreshGitStatus: () => Promise.resolve(null),
  resetGitStatusStateForTests: () => undefined,
}));

import { __resetContextMenuSheetForTests } from "../../../contextMenuSheetState";
import { setCoarsePointerEmulation } from "../../../../test/browserPointer";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../../environmentApi";
import { clearHostedNodeScopedState } from "../../../hostedHub/environment";
import { HOSTED_CONNECTION_STATUS_INDICATORS } from "../../../hostedHub/connectionStatus";
import {
  applyWebE2eeChannelStatus,
  hostedConnectionStatusRepresentatives,
} from "../../../../test/hostedConnectionVocabulary";
import { resetWebE2eeSession } from "../../../hostedHub/e2eeSession";
import { hostedHubController, useHostedHubStore } from "../../../hostedHub/state";
import { resetHubRoutesForTests } from "../../../hostedHub/hubRoutes";
import type { HostedHubNode } from "../../../hostedHub/types";
import { syncDocumentPresentationTier } from "../../../lib/presentationTier";
import { useStore, type EnvironmentState } from "../../../store";
import type { SidebarThreadSummary } from "../../../types";
import { useUiStateStore } from "../../../uiStateStore";
import { readEnvironmentConnection } from "../../../environments/runtime";
import { useNewThreadHandler } from "../../../hooks/useHandleNewThread";
import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../../../environments/primary";
import { sidebarUndo } from "../../../sidebarUndo";
import { toastManager } from "../../ui/toast";
import { SidebarProvider } from "../../ui/sidebar";
import { ContextMenuActionSheetHost } from "./ContextMenuActionSheetHost";
import { PhoneHome } from "./PhoneHome";

const ENV_ID = EnvironmentId.make("environment-local");
const PROJECT_A = "project-a" as ProjectId;
const PROJECT_B = "project-b" as ProjectId;
const THREAD_A = "thread-a" as ThreadId;
const THREAD_B = "thread-b" as ThreadId;
const THREAD_C = "thread-c" as ThreadId;
const WORKTREE_MAIN = "worktree-main" as WorktreeId;
const WORKTREE_FEATURE = "worktree-feature" as WorktreeId;
const THREAD_A_KEY = scopedThreadKey(scopeThreadRef(ENV_ID, THREAD_A));
const NOW_ISO = "2026-07-20T00:00:00.000Z";
const LONG_PRESS_HOLD_MS = 600;

async function dispatchLongPress(element: HTMLElement, moveByPx = 0): Promise<void> {
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  element.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerId: 11,
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: y,
      pointerType: "touch",
    }),
  );
  if (moveByPx > 0) {
    element.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        pointerId: 11,
        isPrimary: true,
        clientX: x,
        clientY: y + moveByPx,
        pointerType: "touch",
      }),
    );
  }
  await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_HOLD_MS));
  element.dispatchEvent(
    new PointerEvent("pointerup", {
      bubbles: true,
      cancelable: true,
      pointerId: 11,
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: y + moveByPx,
      pointerType: "touch",
    }),
  );
}

function worktreeSummary(
  worktreeId: WorktreeId,
  branch: string,
  worktreePath: string | null,
  origin: "main" | "branch",
) {
  return {
    id: worktreeId,
    environmentId: ENV_ID,
    projectId: PROJECT_B,
    title: null,
    branch,
    worktreePath,
    origin,
    prNumber: null,
    issueNumber: null,
    prTitle: null,
    issueTitle: null,
    prState: null,
    prIsDraft: null,
    issueState: null,
    workItemProvider: null,
    workItemKey: null,
    workItemTitle: null,
    workItemState: null,
    workItemStateName: null,
    workItemUrl: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    archivedAt: null,
    manualPosition: origin === "main" ? 0 : 1,
  };
}

function summary(
  threadId: ThreadId,
  projectId: ProjectId,
  title: string,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  return {
    id: threadId,
    environmentId: ENV_ID,
    projectId,
    title,
    interactionMode: "default",
    session: null,
    createdAt: NOW_ISO,
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: NOW_ISO,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function project(projectId: ProjectId, name: string, cwd: string) {
  return {
    id: projectId,
    environmentId: ENV_ID,
    name,
    cwd,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
  };
}

function environmentState(): EnvironmentState {
  return {
    projectIds: [PROJECT_A, PROJECT_B],
    projectById: {
      [PROJECT_A]: project(PROJECT_A, "Alpha", "/repo/alpha"),
      [PROJECT_B]: project(PROJECT_B, "Beta", "/repo/beta"),
    },
    worktreeIds: [],
    worktreeIdsByProjectId: {},
    worktreeById: {},
    threadIds: [THREAD_A, THREAD_B],
    threadIdsByProjectId: { [PROJECT_A]: [THREAD_A], [PROJECT_B]: [THREAD_B] },
    threadShellById: {
      [THREAD_A]: {
        id: THREAD_A,
        environmentId: ENV_ID,
        codexThreadId: null,
        projectId: PROJECT_A,
        title: "Alpha thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        error: null,
        createdAt: NOW_ISO,
        archivedAt: null,
        branch: null,
        worktreePath: null,
      },
    },
    threadSessionById: { [THREAD_A]: null },
    threadTurnStateById: {},
    messageIdsByThreadId: {},
    messageByThreadId: {},
    pendingMessagesByThreadId: {},
    activityIdsByThreadId: {},
    activityByThreadId: {},
    proposedPlanIdsByThreadId: {},
    proposedPlanByThreadId: {},
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
    sidebarThreadSummaryById: {
      [THREAD_A]: summary(THREAD_A, PROJECT_A, "Alpha thread"),
      [THREAD_B]: summary(THREAD_B, PROJECT_B, "Beta running thread", {
        hasPendingApprovals: true,
      }),
    },
    bootstrapComplete: true,
  };
}

function seedStores() {
  useStore.setState({
    activeEnvironmentId: ENV_ID,
    environmentStateById: { [ENV_ID]: environmentState() },
  });
  useUiStateStore.setState({ pinnedThreadKeys: { [THREAD_A_KEY]: true } });
}

function installActionConnection(
  sidebarUndoCapability: boolean | undefined,
  acceptSnapshot = true,
) {
  const dispatchCommand = vi.fn(async (_command: DispatchableClientOrchestrationCommand) => ({
    sequence: 1,
  }));
  const state = environmentState();
  const snapshot: OrchestrationShellSnapshot = {
    snapshotSequence: 1,
    updatedAt: NOW_ISO,
    projects: Object.values(state.projectById).map((project) => ({
      id: project.id,
      title: project.name,
      workspaceRoot: project.cwd,
      projectMetadataDir: DEFAULT_PROJECT_METADATA_DIR,
      defaultModelSelection: null,
      customAvatarContentHash: null,
      preferredRemoteName: null,
      scripts: [],
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    })),
    threads: Object.values(state.sidebarThreadSummaryById).map((thread) =>
      Object.assign({}, thread, {
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access" as const,
        updatedAt: NOW_ISO,
        goal: null,
        settledOverride: null,
        settledAt: null,
        worktreeId: null,
        session: null,
      }),
    ),
  };
  const client = {
    orchestration: {
      dispatchCommand,
      subscribeShell: (listener: Parameters<WsRpcClient["orchestration"]["subscribeShell"]>[0]) => {
        if (acceptSnapshot) listener({ kind: "snapshot", snapshot });
        return () => {};
      },
    },
    terminal: { onEvent: () => () => {} },
    dispose: async () => {},
  } as unknown as WsRpcClient;
  recordWsConnectionAttempt("ws://example.test", { environmentId: ENV_ID });
  recordWsConnectionOpened({ environmentId: ENV_ID });
  connectionFixture.connection = createEnvironmentConnection({
    kind: "primary",
    knownEnvironment: {
      id: "phone-home-fixture",
      environmentId: ENV_ID,
      label: "Synthetic node",
      source: "configured",
      target: { httpBaseUrl: "http://example.test", wsBaseUrl: "ws://example.test" },
    },
    client,
    pushSequenceMonitor: { recordEvent: () => {}, recordSnapshot: () => {} },
    resetShellProjection: () => {},
    applyShellEvent: (event, environmentId) =>
      useStore.getState().applyShellEvent(event, environmentId),
    syncShellSnapshot: (shell, environmentId) =>
      useStore.getState().syncServerShellSnapshot(shell, environmentId),
    applyTerminalEvent: () => {},
  });
  writePrimaryEnvironmentDescriptor({
    environmentId: ENV_ID,
    label: "Synthetic node",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0-test",
    capabilities: {
      repositoryIdentity: false,
      threadSettlement: false,
      threadPriorityRanking: false,
      ...(sidebarUndoCapability === undefined ? {} : { threadSidebarUndo: sidebarUndoCapability }),
    },
  });
  __setEnvironmentApiOverrideForTests(ENV_ID, {
    orchestration: { dispatchCommand },
  } as unknown as EnvironmentApi);
  return dispatchCommand;
}

const connectionFixture = { connection: null as EnvironmentConnection | null };
let mounted: Awaited<ReturnType<typeof render>> | null = null;

describe("PhoneHome", () => {
  beforeAll(() => {
    syncDocumentPresentationTier();
  });

  beforeEach(async () => {
    const original = await vi.importActual<typeof import("../../../environments/runtime")>(
      "../../../environments/runtime",
    );
    vi.mocked(readEnvironmentConnection).mockImplementation((environmentId) =>
      connectionFixture.connection?.environmentId === environmentId
        ? connectionFixture.connection
        : original.readEnvironmentConnection(environmentId),
    );
    await page.viewport(390, 844);
    localStorage.clear();
    navigate.mockClear();
    routerStub.state.matches = [];
    routerStub.state.location.href = "/";
    seedStores();
  });

  afterEach(async () => {
    sidebarUndo.dispose();
    __resetContextMenuSheetForTests();
    await mounted?.unmount();
    mounted = null;
    await connectionFixture.connection?.dispose();
    connectionFixture.connection = null;
    resetWsConnectionStateForTests();
    resetPrimaryEnvironmentDescriptorForTests();
    hostedHubController.resetForTests();
    resetHubRoutesForTests();
    // Module state, not store state: `resetForTests()` does not reach the §13
    // projection, and a channel left locked would rename every later status.
    resetWebE2eeSession();
    __resetEnvironmentApiOverridesForTests();
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
    useUiStateStore.setState({ pinnedThreadKeys: {}, projectExpandedById: {} });
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    await page.viewport(1_280, 720);
  });

  it("renders the project-grouped thread list from the live stores with visible status and touch-sized rows", async () => {
    mounted = await render(
      <SidebarProvider>
        <PhoneHome />
      </SidebarProvider>,
    );

    await expect.element(page.getByRole("heading", { name: "Threads" })).toBeVisible();
    await expect.element(page.getByText("Alpha", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Beta", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Alpha thread")).toBeVisible();
    await expect.element(page.getByText("Beta running thread")).toBeVisible();
    // Always-visible status: text plus indicator, not a hover affordance.
    await expect.element(page.getByText("Pending Approval")).toBeVisible();
    // Pinned marker from the live uiState store.
    await expect.element(page.getByRole("img", { name: "Pinned" })).toBeVisible();

    // Rows and kebabs meet the 44 px phone touch target.
    const row = page.getByText("Alpha thread").element().closest('[role="listitem"]');
    expect(row).not.toBeNull();
    expect((row as HTMLElement).getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    const kebab = page.getByRole("button", { name: "Thread actions for Alpha thread" }).element();
    expect(kebab.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(kebab.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    // No page-level horizontal overflow at the phone viewport.
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });

  it("contains the Home surface at 320px and on a coarse landscape phone", async () => {
    // Acceptance-matrix gap fill (delivery step 10): the per-step suite
    // proves Home at 390×844; this covers the narrowest portrait phone and
    // the coarse-pointer landscape classification.
    const assertHomeContained = async (width: number) => {
      await expect.element(page.getByRole("heading", { name: "Threads" })).toBeVisible();
      await expect.element(page.getByText("Alpha thread")).toBeVisible();
      // No page-level horizontal overflow.
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      expect(document.body.scrollWidth).toBeLessThanOrEqual(width);
      // Rows and kebabs keep the 44px phone touch-target floor.
      const row = page.getByText("Alpha thread").element().closest('[role="listitem"]');
      expect(row).not.toBeNull();
      expect((row as HTMLElement).getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      const kebab = page.getByRole("button", { name: "Thread actions for Alpha thread" }).element();
      expect(kebab.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      expect(kebab.getBoundingClientRect().right).toBeLessThanOrEqual(width + 0.5);
      // The app-bar affordances stay reachable inside the viewport.
      for (const label of ["Search threads", "Open settings"]) {
        const control = page.getByRole("button", { name: label }).element() as HTMLElement;
        const box = control.getBoundingClientRect();
        expect(box.left, `${label} off-screen left at ${width}px`).toBeGreaterThanOrEqual(0);
        expect(box.right, `${label} off-screen right at ${width}px`).toBeLessThanOrEqual(
          width + 0.5,
        );
      }
    };

    await page.viewport(320, 568);
    mounted = await render(
      <SidebarProvider>
        <PhoneHome />
      </SidebarProvider>,
    );
    await assertHomeContained(320);
    await mounted.unmount();
    mounted = null;

    // 844×390 classifies as a phone only through the coarse-pointer clause;
    // the phone: CSS variants must keep the touch density there.
    await page.viewport(844, 390);
    await setCoarsePointerEmulation(true);
    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      mounted = await render(
        <SidebarProvider>
          <PhoneHome />
        </SidebarProvider>,
      );
      await assertHomeContained(844);
    } finally {
      await setCoarsePointerEmulation(false);
    }
  });

  it("keeps the Home title readable beside the collapsed indicator at 320px in every bounded state", async () => {
    // The audited Home bar: a 176px connection pill that crowded the title out
    // entirely at 320px, rendering a truncated node label and a truncated
    // state in the space it took.
    //
    // Seeding only ready/online would make the width bounds meaningless — that
    // is the ONE state whose short label is also its full text. The whole
    // vocabulary is swept instead.
    const hostedNode: HostedHubNode = {
      id: "node_aaaaaaaaaaaaaaaaaaaaaa",
      environmentId: EnvironmentId.make("env_aaaaaaaaaaaaaaaaaaaaaa"),
      label: "MacBook Pro M5",
      platformOs: "linux",
      platformArch: "x64",
      clientVersion: "0.9.0",
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1,
      revokedAt: null,
      revocationReasonCode: null,
      grant: { id: "grant_a", role: "operator" },
      effectiveRole: "operator",
      presence: { online: true, lastHeartbeatAt: 1 },
    };
    await page.viewport(320, 568);
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      directoryStatus: "ready",
      browserStatus: "current",
      nodes: [hostedNode],
      selectedNode: hostedNode,
      selectionStatus: "online",
      effectiveRole: "operator",
      transportStatus: "online",
      sessionStatus: "ready",
      sessionEstablished: true,
    });
    mounted = await render(
      <SidebarProvider>
        <PhoneHome />
      </SidebarProvider>,
    );

    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="hosted-connection-pill"]')).not.toBeNull();
    });
    await expect.element(page.getByRole("heading", { name: "Threads" })).toBeVisible();
    const chip = () =>
      document.querySelector<HTMLElement>('[data-testid="hosted-connection-pill"]')!;
    const status = () =>
      document.querySelector<HTMLElement>('[data-slot="mobile-status-chip-status"]')!;
    const title = () => document.querySelector<HTMLElement>("h1")!;

    for (const [text, statusInput] of hostedConnectionStatusRepresentatives()) {
      const { shortLabel } = HOSTED_CONNECTION_STATUS_INDICATORS[text];
      useHostedHubStore.setState({
        browserStatus: statusInput.browserStatus,
        sessionStatus: statusInput.sessionStatus,
        selectionStatus: statusInput.selectionStatus,
        transportStatus: statusInput.transportStatus,
      });
      // The §4.4 channel dimension, from the real §13 publishers: `Legacy`,
      // `Unsigned web`, and `Securing` are reachable in the shipped app and are
      // measured here like every other state.
      applyWebE2eeChannelStatus(statusInput.e2eeStatus ?? "unavailable");
      await vi.waitFor(() => {
        expect(status().textContent, `collapsed label for "${text}"`).toBe(shortLabel);
      });

      // The title renders in full — not truncated, not dropped.
      expect(
        title().scrollWidth,
        `the title renders without truncation beside "${shortLabel}"`,
      ).toBeLessThanOrEqual(title().clientWidth);
      expect(
        title().getBoundingClientRect().width,
        `title width beside "${shortLabel}"`,
      ).toBeGreaterThan(160);
      expect(
        chip().getBoundingClientRect().width,
        `indicator width for "${shortLabel}"`,
      ).toBeLessThanOrEqual(136.5);
      expect(chip().getBoundingClientRect().right).toBeLessThanOrEqual(320.5);
      // Node identity is still announced, and the state is visible text.
      expect(chip().getAttribute("aria-label")).toBe(`Connection: MacBook Pro M5, ${text}`);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
    }
  });

  it("leaves chats out of the project list and the New thread choice", async () => {
    const handleNewThread = vi.fn<ReturnType<typeof useNewThreadHandler>["handleNewThread"]>(
      async () => undefined,
    );
    vi.mocked(useNewThreadHandler).mockReturnValue({
      handleNewThread,
      handleNewChat: vi.fn(async () => undefined),
    });
    const state = environmentState();
    useStore.setState({
      activeEnvironmentId: ENV_ID,
      environmentStateById: {
        [ENV_ID]: {
          ...state,
          projectById: {
            ...state.projectById,
            [PROJECT_B]: { ...state.projectById[PROJECT_B]!, name: "Plan a trip", kind: "chat" },
          },
        },
      },
    });
    mounted = await render(
      <SidebarProvider>
        <PhoneHome />
      </SidebarProvider>,
    );

    await expect.element(page.getByText("Alpha thread")).toBeVisible();
    // A chat is not a project row, and its thread is not listed under one.
    expect(document.body.textContent).not.toContain("Plan a trip");
    expect(document.body.textContent).not.toContain("Beta running thread");

    // The only project left takes the new thread; the chat is never a choice.
    await page.getByRole("button", { name: "New thread", exact: true }).click();
    await vi.waitFor(() => expect(handleNewThread).toHaveBeenCalledOnce());
    expect(handleNewThread.mock.calls[0]?.[0]).toEqual({
      environmentId: ENV_ID,
      projectId: PROJECT_A,
    });
    expect(document.body.textContent).not.toContain("Choose a project for the new thread.");
  });

  it("navigates into a thread from a row", async () => {
    mounted = await render(
      <SidebarProvider>
        <PhoneHome />
      </SidebarProvider>,
    );

    await page.getByText("Alpha thread").click();
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/$environmentId/$threadId",
        params: expect.objectContaining({ threadId: THREAD_A }),
      }),
    );
  });

  it.each([false, undefined])(
    "exposes the full shared action inventory and dispatches with Undo capability %s",
    async (capability) => {
      const dispatchCommand = installActionConnection(capability);
      const addedToasts = vi.spyOn(toastManager, "add");
      const generation = connectionFixture.connection!.shellSnapshotReadiness.read();
      expect(generation).not.toBeNull();
      expect(connectionFixture.connection!.shellSnapshotReadiness.read()).toBe(generation);

      mounted = await render(
        <SidebarProvider>
          <PhoneHome />
        </SidebarProvider>,
      );

      // Full inventory for a pinned, archivable thread.
      await page.getByRole("button", { name: "Thread actions for Alpha thread" }).click();
      for (const label of [
        "Unpin thread",
        "Rename thread",
        "Mark unread",
        "Copy Path",
        "Copy Thread ID",
        "Archive thread",
        "Move to Trash",
      ]) {
        await expect.element(page.getByRole("button", { name: label })).toBeVisible();
      }

      // Pin round-trip through the live uiState store.
      await page.getByRole("button", { name: "Unpin thread" }).click();
      await vi.waitFor(() => {
        expect(useUiStateStore.getState().pinnedThreadKeys[THREAD_A_KEY]).toBeUndefined();
      });

      // Rename round-trip through the existing environment-api mock.
      await page.getByRole("button", { name: "Thread actions for Alpha thread" }).click();
      await page.getByRole("button", { name: "Pin thread" }).click();
      await page.getByRole("button", { name: "Thread actions for Alpha thread" }).click();
      await page.getByRole("button", { name: "Rename thread" }).click();
      const renameInput = page.getByLabelText("Thread title");
      await expect.element(renameInput).toBeVisible();
      await renameInput.fill("Alpha thread renamed");
      await page.getByRole("button", { name: "Rename", exact: true }).click();
      await vi.waitFor(() => {
        expect(dispatchCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "thread.meta.update",
            threadId: THREAD_A,
            title: "Alpha thread renamed",
          }),
        );
      });

      // Archive round-trip through the same shared handler.
      await page.getByRole("button", { name: "Thread actions for Alpha thread" }).click();
      await page.getByRole("button", { name: "Archive thread" }).click();
      await vi.waitFor(() => {
        expect(dispatchCommand).toHaveBeenCalledWith(
          expect.objectContaining({ type: "thread.archive", threadId: THREAD_A }),
        );
      });
      expect(
        dispatchCommand.mock.calls.filter(([command]) => command.type === "thread.archive"),
      ).toHaveLength(1);
      expect(dispatchCommand).toHaveBeenCalledTimes(2);
      expect(
        addedToasts.mock.calls.some(([toast]) =>
          toast.actionProps?.["aria-label"]?.startsWith("Undo archive"),
        ),
      ).toBe(false);
      expect(dispatchCommand).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "thread.sidebar.undo" }),
      );
    },
  );

  it("refuses Archive without an accepted owning shell attempt even when the API exists", async () => {
    const dispatchCommand = installActionConnection(false, false);
    const addedToasts = vi.spyOn(toastManager, "add");
    expect(connectionFixture.connection!.shellSnapshotReadiness.read()).toBeNull();
    mounted = await render(
      <SidebarProvider>
        <PhoneHome />
      </SidebarProvider>,
    );
    await page.getByRole("button", { name: "Thread actions for Alpha thread" }).click();
    await page.getByRole("button", { name: "Archive thread" }).click();
    await vi.waitFor(() => {
      expect(addedToasts).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: "Failed to archive thread",
          description: "The owning node is not ready for this action.",
        }),
      );
    });
    expect(dispatchCommand).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("supports the keyboard flow from a thread row through the kebab action sheet", async () => {
    mounted = await render(
      <SidebarProvider>
        <PhoneHome />
      </SidebarProvider>,
    );

    // The row and its kebab are reachable in tab order: the kebab follows
    // the row button directly.
    const rowButton = page
      .getByText("Alpha thread")
      .element()
      .closest("button") as HTMLButtonElement;
    expect(rowButton).not.toBeNull();
    rowButton.focus();
    expect(document.activeElement).toBe(rowButton);
    await userEvent.keyboard("{Tab}");
    const kebab = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Thread actions for Alpha thread"]',
    )!;
    expect(document.activeElement).toBe(kebab);

    // Enter opens the bottom-sheet action inventory and moves focus inside.
    await userEvent.keyboard("{Enter}");
    const sheet = await vi.waitFor(() => {
      const popup = document.querySelector<HTMLElement>('[data-slot="sheet-popup"]');
      expect(popup).not.toBeNull();
      return popup!;
    });
    await vi.waitFor(() => {
      expect(sheet.contains(document.activeElement)).toBe(true);
    });

    // Focus is trapped: tabbing cycles within the sheet.
    for (let index = 0; index < 12; index += 1) {
      await userEvent.keyboard("{Tab}");
      expect(sheet.contains(document.activeElement)).toBe(true);
    }

    // Escape closes the sheet and focus returns to the kebab.
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      expect(document.querySelector('[data-slot="sheet-popup"]')).toBeNull();
    });
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(kebab);
    });
  });

  it("opens the thread action sheet from a long-press without hijacking scroll", async () => {
    mounted = await render(
      <SidebarProvider>
        <PhoneHome />
      </SidebarProvider>,
    );
    const rowButton = await vi.waitFor(() => {
      const button = page.getByText("Alpha thread").element().closest("button");
      expect(button).not.toBeNull();
      return button as HTMLButtonElement;
    });

    // A >10px drag (scroll gesture) cancels the press: no sheet opens.
    await dispatchLongPress(rowButton, 24);
    expect(document.querySelector('[data-slot="sheet-popup"]')).toBeNull();
    expect(window.getSelection()?.toString() ?? "").toBe("");

    // A stationary long-press opens the same shared action inventory as the
    // visible kebab.
    await dispatchLongPress(rowButton);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-slot="sheet-popup"]')).not.toBeNull();
    });
    await expect.element(page.getByRole("button", { name: "Unpin thread" })).toBeVisible();
    // The long-press did not also navigate into the thread.
    expect(navigate).not.toHaveBeenCalled();
  });

  it("exposes the desktop project action inventory from the header kebab through the shared sheet", async () => {
    const clipboardWriteText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });

    try {
      mounted = await render(
        <SidebarProvider>
          <ContextMenuActionSheetHost />
          <PhoneHome />
        </SidebarProvider>,
      );

      const sheetRow = (label: string): HTMLButtonElement | null => {
        const popup = document.querySelector<HTMLElement>('[data-slot="sheet-popup"]');
        if (!popup) return null;
        return (
          [...popup.querySelectorAll<HTMLButtonElement>("button")].find(
            (button) => button.textContent?.trim() === label,
          ) ?? null
        );
      };

      // The kebab presents the existing desktop project context-menu
      // inventory through the shared bottom sheet.
      await page.getByRole("button", { name: "Project actions for Alpha" }).click();
      for (const label of [
        "Project overview",
        "Project settings",
        "Rename project",
        "Project grouping…",
        "Copy Project Path",
        "Remove project",
      ]) {
        await vi.waitFor(() => {
          expect(sheetRow(label), `project menu row "${label}"`).not.toBeNull();
        });
        expect(sheetRow(label)!.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      }
      expect(sheetRow("Remove project")!.className).toContain("text-destructive");

      // Non-destructive round-trip through the shared clipboard handler.
      sheetRow("Copy Project Path")!.click();
      await vi.waitFor(() => {
        expect(clipboardWriteText).toHaveBeenCalledWith("/repo/alpha");
      });
      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="sheet-popup"]')).toBeNull();
      });

      // A long-press on the project header opens the same menu.
      const header = page.getByRole("button", { name: /^Alpha 1$/ }).element() as HTMLButtonElement;
      await dispatchLongPress(header);
      await vi.waitFor(() => {
        expect(sheetRow("Project overview")).not.toBeNull();
      });
    } finally {
      delete (navigator as unknown as Record<string, unknown>)["clipboard"];
    }
  });

  it("layers worktree sections into project groups with collapsed-by-default touch and keyboard rows", async () => {
    const state = environmentState();
    state.threadIds = [THREAD_A, THREAD_B, THREAD_C];
    state.threadIdsByProjectId = {
      [PROJECT_A]: [THREAD_A],
      [PROJECT_B]: [THREAD_B, THREAD_C],
    };
    state.sidebarThreadSummaryById = {
      ...state.sidebarThreadSummaryById,
      [THREAD_C]: summary(THREAD_C, PROJECT_B, "Beta worktree thread", {
        branch: "feat-x",
        worktreePath: "/repo/beta-wt",
      }),
    };
    state.worktreeIds = [WORKTREE_MAIN, WORKTREE_FEATURE];
    state.worktreeIdsByProjectId = { [PROJECT_B]: [WORKTREE_MAIN, WORKTREE_FEATURE] };
    state.worktreeById = {
      [WORKTREE_MAIN]: worktreeSummary(WORKTREE_MAIN, "main", null, "main"),
      [WORKTREE_FEATURE]: worktreeSummary(WORKTREE_FEATURE, "feat-x", "/repo/beta-wt", "branch"),
    };
    useStore.setState({
      activeEnvironmentId: ENV_ID,
      environmentStateById: { [ENV_ID]: state },
    });

    mounted = await render(
      <SidebarProvider>
        <PhoneHome />
      </SidebarProvider>,
    );

    // The multi-worktree project renders collapsed sections; its threads are
    // not in the flat list.
    const mainHeader = await vi.waitFor(() => {
      const header = page.getByRole("button", { name: "main 1" }).element() as HTMLButtonElement;
      expect(header).not.toBeNull();
      return header;
    });
    const featureHeader = page
      .getByRole("button", { name: "feat-x 1" })
      .element() as HTMLButtonElement;
    expect(mainHeader.getAttribute("aria-expanded")).toBe("false");
    expect(featureHeader.getAttribute("aria-expanded")).toBe("false");
    expect(mainHeader.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(featureHeader.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await expect.element(page.getByText("Beta running thread")).not.toBeInTheDocument();
    await expect.element(page.getByText("Beta worktree thread")).not.toBeInTheDocument();

    // The single-worktree project keeps its flat list.
    await expect.element(page.getByText("Alpha thread")).toBeVisible();

    // Tap expands a section and reveals its sessions in tree order.
    featureHeader.click();
    await expect.element(page.getByText("Beta worktree thread")).toBeVisible();
    expect(featureHeader.getAttribute("aria-expanded")).toBe("true");

    // Keyboard: Enter toggles the section, matching the desktop tree rows.
    mainHeader.focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText("Beta running thread")).toBeVisible();
    expect(mainHeader.getAttribute("aria-expanded")).toBe("true");
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText("Beta running thread")).not.toBeInTheDocument();
  });

  it("preserves cached rows and presentation state across a hosted transport switch", async () => {
    mounted = await render(
      <SidebarProvider>
        <PhoneHome />
      </SidebarProvider>,
    );
    await expect.element(page.getByText("Alpha thread")).toBeVisible();

    // Transport disposal demotes live state; only account teardown may erase
    // the unified cross-node list or its presentation state.
    clearHostedNodeScopedState(ENV_ID);

    await expect.element(page.getByText("Alpha thread")).toBeVisible();
    await expect.element(page.getByRole("region", { name: "Beta" })).toBeVisible();
    expect(useUiStateStore.getState().pinnedThreadKeys).toEqual({ [THREAD_A_KEY]: true });
    expect(useStore.getState().environmentStateById[ENV_ID]).toMatchObject({
      bootstrapComplete: false,
    });
  });
});
