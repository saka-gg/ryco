import "../../index.css";
import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render, renderHook } from "vitest-browser-react";

import { resetGitStatusStateForTests } from "../../lib/gitStatusState";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { InboxSidebar, type InboxSidebarProps } from "./InboxSidebar";
import {
  INBOX_PREVIEW_INTENT_DWELL_MS,
  INBOX_PREVIEW_INTENT_LINGER_MS,
  useInboxRowPreviewIntent,
} from "./useInboxRowPreviewIntent";

const harness = vi.hoisted(() => ({
  onStatus: vi.fn(
    (_input: { readonly cwd: string; readonly view?: string }, _listener: unknown) => {
      return () => undefined;
    },
  ),
  hover: vi.fn(),
  hoverEnd: vi.fn(),
  press: vi.fn(),
}));

vi.mock("../../environments/runtime/service", () => ({
  readEnvironmentConnection: () => ({
    environmentId: "inbox-status-machine",
    client: { vcs: { onStatus: harness.onStatus } },
  }),
  subscribeEnvironmentConnections: () => () => undefined,
  getPrimaryEnvironmentConnection: () => null,
  listEnvironmentConnections: () => [],
  addSavedEnvironment: vi.fn(),
  connectPrimaryEnvironment: vi.fn(),
  connectDesktopWorkspaceEnvironment: vi.fn(),
  connectDesktopSshEnvironment: vi.fn(),
  disconnectSavedEnvironment: vi.fn(),
  disconnectPrimaryEnvironment: vi.fn(),
  ensureEnvironmentConnectionBootstrapped: vi.fn(),
  reconnectSavedEnvironment: vi.fn(),
  removeSavedEnvironment: vi.fn(),
  requireEnvironmentConnection: vi.fn(),
  resetEnvironmentServiceForTests: vi.fn(),
  startEnvironmentConnectionService: vi.fn(),
  updateEnvironmentServerSettings: vi.fn(),
}));
vi.mock("../sidebar/threadNavigationIntent", async () => ({
  isNavigationPress: (await import("../sidebar/threadNavigationIntent.logic")).isNavigationPress,
  noteThreadHoverIntent: harness.hover,
  noteThreadHoverEnd: harness.hoverEnd,
  noteThreadPressIntent: harness.press,
  preloadDraftRoute: vi.fn(),
}));
vi.mock("../../rpc/useSourceControl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../rpc/useSourceControl")>()),
  useSourceControlChangeRequestDetail: () => ({
    data: null,
    error: null,
    isLoading: false,
    isFetching: false,
  }),
}));

afterEach(() => {
  resetGitStatusStateForTests();
  harness.onStatus.mockClear();
  harness.hover.mockClear();
  harness.hoverEnd.mockClear();
  harness.press.mockClear();
  document.body.innerHTML = "";
});

const environmentId = EnvironmentId.make("inbox-status-machine");
const projectId = ProjectId.make("inbox-status-project");
const threadId = ThreadId.make("inbox-status-thread");

function props(): InboxSidebarProps {
  return {
    projects: [
      {
        id: projectId,
        environmentId,
        name: "Repo",
        cwd: "/repo/root",
        defaultModelSelection: null,
        scripts: [],
      },
    ],
    worktrees: [],
    threads: [
      {
        id: threadId,
        environmentId,
        projectId,
        title: "Status thread",
        interactionMode: "default",
        session: null,
        createdAt: "2026-09-01T00:00:00.000Z",
        archivedAt: null,
        latestTurn: null,
        branch: "feature",
        worktreePath: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      },
    ],
    environments: [
      {
        environmentId,
        label: "Machine",
        connectionState: "connected",
        stale: false,
        role: "viewer",
        trust: "verified",
        deliveryUnknown: false,
        threadSettlementSupported: true,
        mutationReady: false,
        shellCurrent: true,
      },
    ],
    deliveryUnknownThreadKeys: new Set(),
    localQueuedThreadKeys: new Set(),
    activeThreadKey: null,
    aiFocusEnabled: false,
    autoSettleAfterDays: null,
    pinnedThreadKeys: new Set(),
    onOpenThread: vi.fn(),
  };
}

const views = () => harness.onStatus.mock.calls.map(([input]) => input.view ?? "full");

/**
 * Moves the pointer to the far corner. It stays where an earlier test left it,
 * and a row rendering under it would receive pointerenter (hover intent).
 */
async function parkPointer() {
  const corner = document.createElement("div");
  corner.style.cssText = "position:fixed;right:0;bottom:0;width:4px;height:4px";
  document.body.append(corner);
  try {
    await userEvent.hover(corner);
  } finally {
    corner.remove();
  }
}

it("reads the badge summary per row and full status only while the row is hovered", async () => {
  await page.viewport(1280, 800);
  await parkPointer();
  const mounted = await render(
    <AppAtomRegistryProvider>
      <InboxSidebar {...props()} />
    </AppAtomRegistryProvider>,
  );
  try {
    await vi.waitFor(() => expect(views()).toEqual(["summary"]));
    await new Promise((resolve) => setTimeout(resolve, INBOX_PREVIEW_INTENT_DWELL_MS * 3));
    expect(views()).toEqual(["summary"]);
    // Resting on it reads the working tree for the hover card, and the row
    // signals navigation intent for the thread.
    await page.getByTestId("inbox-thread-row").hover();
    await vi.waitFor(() => expect(views()).toEqual(["summary", "full"]));
    expect(harness.hover).toHaveBeenCalledWith({ environmentId, threadId });
    await page.getByTestId("inbox-thread-row").click();
    expect(harness.press).toHaveBeenCalledWith({ environmentId, threadId });
  } finally {
    await mounted.unmount();
  }
});

it("turns preview intent on after a dwell and off after the linger", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { result, act } = await renderHook(() => useInboxRowPreviewIntent());
    // A pointer crossing the row never activates it.
    await act(() => result.current.start());
    await act(() => vi.advanceTimersByTime(INBOX_PREVIEW_INTENT_DWELL_MS - 1));
    await act(() => result.current.end());
    await act(() => vi.advanceTimersByTime(INBOX_PREVIEW_INTENT_DWELL_MS));
    expect(result.current.active).toBe(false);

    await act(() => result.current.start());
    await act(() => vi.advanceTimersByTime(INBOX_PREVIEW_INTENT_DWELL_MS));
    expect(result.current.active).toBe(true);
    // Leaving keeps it on while the card can still be read; coming back renews it.
    await act(() => result.current.end());
    await act(() => vi.advanceTimersByTime(INBOX_PREVIEW_INTENT_LINGER_MS - 1));
    await act(() => result.current.start());
    await act(() => vi.advanceTimersByTime(INBOX_PREVIEW_INTENT_LINGER_MS));
    expect(result.current.active).toBe(true);
    await act(() => result.current.end());
    await act(() => vi.advanceTimersByTime(INBOX_PREVIEW_INTENT_LINGER_MS));
    expect(result.current.active).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
