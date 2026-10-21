// Hosted Tasks show the tasks of the node under the selection cursor.
//
// The file exists because the mode is read at module scope: `isHostedHubMode()`
// answers a build-time flag, so the hoisted `vi.mock` below applies to the
// whole file, as in `SettingsPageHosted.browser.tsx`.
//
// What is pinned here: the Tasks address names no node, so a reload or a new
// tab on it has no node under the cursor. The page then offers the nodes to
// choose from instead of staying blank, and a choice moves the cursor in place.
// While it shows a node's tasks the page holds that node's demand itself, also
// when an older address that named the node opened it.
import "../../index.css";

import { appAtomRegistry, serverConfigAtom } from "@ryco/client-runtime/rpc";
import { useLocalTasksStore } from "@ryco/client-runtime/state/tasks";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type EnvironmentApi,
  type LocalTask,
  type ServerConfig,
} from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const navigate = vi.fn(async () => undefined);
// Rendered outside a `RouterProvider`: the page opens chats through the router,
// and the device choice would leave through it, which it must not.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
  useRouter: () => ({ state: { matches: [] }, navigate }),
}));

// Hosted mode, which no browser test gets by default: there is no `.env` in
// this harness, so `isHostedHubMode()` answers false and every hosted gate runs
// as the standard client.
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  readRycoClientMode: () => "hosted-hub" as const,
  isHostedHubMode: () => true,
}));

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../../environments/primary";
import { hostedWebConnectionScopes } from "../../hostedHub/hostedConnectionScopes";
import {
  installHostedNodeHistory,
  resetHostedNodeRoutesForTests,
} from "../../hostedHub/nodeRoutes";
import {
  resetHostedNodeRouteOrchestratorForTests,
  startHostedNodeRouteOrchestrator,
} from "../../hostedHub/nodeRouteOrchestrator";
import {
  getHostedEnvironmentSessions,
  hostedHubController,
  useHostedHubStore,
} from "../../hostedHub/state";
import type { HostedHubNode } from "../../hostedHub/types";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { useStore } from "../../store";
import { createFakeHistoryWindow, type FakeHistoryWindow } from "../../../test/fakeHistoryWindow";
import { SidebarProvider } from "../ui/sidebar";
import { TasksPage } from "./TasksPage";

const account = {
  id: "acct_aaaaaaaaaaaaaaaaaaaaaa",
  displayName: "Ada",
  role: "owner" as const,
  createdAt: 1,
  disabledAt: null,
};
const session = {
  id: "sess_aaaaaaaaaaaaaaaaaaaaaa",
  accountId: account.id,
  createdAt: 1,
  expiresAt: 2,
  lastSeenAt: 1,
  revokedAt: null,
  revocationReasonCode: null,
};

function node(id: string, label: string): HostedHubNode {
  return {
    id,
    environmentId: EnvironmentId.make(`env_${id.slice(5).padEnd(22, "a").slice(0, 22)}`),
    label,
    platformOs: "linux",
    platformArch: "x64",
    clientVersion: "0.9.0",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant_${id.slice(5)}`, role: "owner" },
    effectiveRole: "owner",
    presence: { online: true, lastHeartbeatAt: 1 },
  };
}

const studio = node("node_aaaaaaaaaaaaaaaaaaaaaa", "Studio node");
const laptop = node("node_bbbbbbbbbbbbbbbbbbbbbb", "Travel laptop");
const revoked = { ...node("node_cccccccccccccccccccccc", "Retired node"), revokedAt: 5 };

const PROJECT = ProjectId.make("project-ryco");
const CREATED_AT = "2026-10-17T09:00:00.000Z";

function task(taskId: string, title: string): LocalTask {
  return {
    taskId,
    title,
    revision: 1,
    notes: "",
    priority: "normal",
    dueAt: null,
    projectId: PROJECT,
    links: [],
    files: [],
    state: "todo",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    status: "todo",
    delegations: [],
  };
}

/** A node answering the task list with `tasks`. */
function fakeNodeApi(tasks: ReadonlyArray<LocalTask>) {
  const server = {
    listLocalTasks: vi.fn(async () => ({ tasks: [...tasks], nextCursor: null })),
    getLocalTask: vi.fn(async ({ taskId }: { taskId: string }) =>
      tasks.find((entry) => entry.taskId === taskId),
    ),
  };
  return { server, api: { server, git: {}, vcs: {} } as unknown as EnvironmentApi };
}

/**
 * Selecting is the lifecycle owner's: as it would, the selection moves the
 * shared node and the primary environment, and here the node's session is
 * ready at once and its config says it has tasks.
 */
function selectingNode() {
  return vi.spyOn(hostedHubController, "selectNode").mockImplementation(async (nodeId: string) => {
    const target = useHostedHubStore.getState().nodes.find((entry) => entry.id === nodeId);
    if (!target) return;
    useHostedHubStore.setState({
      selectedNode: target,
      selectionStatus: "online",
      effectiveRole: "owner",
      transportStatus: "online",
      sessionStatus: "ready",
      sessionEstablished: true,
    });
    const environment = {
      environmentId: target.environmentId,
      label: target.label,
      platform: { os: "linux" as const, arch: "x64" as const },
      serverVersion: "0.9.0",
      capabilities: {
        repositoryIdentity: false,
        threadSettlement: false,
        threadPriorityRanking: false,
        localTasks: true,
      },
    };
    writePrimaryEnvironmentDescriptor(environment);
    appAtomRegistry.set(serverConfigAtom, {
      environment,
      providers: [],
      settings: DEFAULT_SERVER_SETTINGS,
    } as unknown as ServerConfig);
  });
}

function interactiveDemand(target: HostedHubNode) {
  return expect.objectContaining({
    environmentId: target.environmentId,
    scope: { type: "interactive" },
  });
}

let mounted: Awaited<ReturnType<typeof render>> | null = null;
let fakeWindow: FakeHistoryWindow | null = null;
let stopOrchestrator: (() => void) | null = null;

async function mount() {
  mounted = await render(
    <AppAtomRegistryProvider>
      <SidebarProvider>
        <TasksPage search={{}} onSearchChange={() => undefined} />
      </SidebarProvider>
    </AppAtomRegistryProvider>,
  );
}

beforeEach(() => {
  hostedHubController.resetForTests();
  getHostedEnvironmentSessions().clear();
  resetHostedNodeRouteOrchestratorForTests();
  resetHostedNodeRoutesForTests();
  navigate.mockClear();
  useHostedHubStore.setState({
    accountStatus: "authenticated",
    account,
    session,
    directoryStatus: "ready",
    browserStatus: "current",
    nodes: [studio, laptop, revoked],
  });
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  // The retained task sync lets go at the end of the task that released it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  stopOrchestrator?.();
  stopOrchestrator = null;
  fakeWindow = null;
  hostedHubController.resetForTests();
  getHostedEnvironmentSessions().clear();
  resetHostedNodeRouteOrchestratorForTests();
  resetHostedNodeRoutesForTests();
  __resetEnvironmentApiOverridesForTests();
  appAtomRegistry.set(serverConfigAtom, null);
  resetPrimaryEnvironmentDescriptorForTests();
  useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
  useLocalTasksStore.setState({ byEnvironment: {}, forbidden: {} });
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("hosted tasks follow the selection cursor", () => {
  it("offers the nodes to choose from when the cursor is on none, then shows the chosen node's tasks", async () => {
    await page.viewport(1_280, 720);
    fakeWindow = createFakeHistoryWindow("/tasks");
    installHostedNodeHistory(fakeWindow as unknown as Window & typeof globalThis);
    const selectNode = selectingNode();
    const laptopNode = fakeNodeApi([task("t-laptop", "Pack the travel charger")]);
    __setEnvironmentApiOverrideForTests(laptop.environmentId, laptopNode.api);

    await mount();

    await expect.element(page.getByText("Choose a device")).toBeVisible();
    const choices = page.getByRole("group", { name: "Devices" });
    await expect.element(choices.getByRole("button", { name: studio.label })).toBeVisible();
    // Every node this browser may open, and no revoked one.
    await expect
      .element(choices.getByRole("button", { name: revoked.label }))
      .not.toBeInTheDocument();
    // Nothing is shown, so nothing is held.
    expect(hostedWebConnectionScopes.list()).toEqual([]);

    await choices.getByRole("button", { name: laptop.label }).click();

    // The cursor moves; the address names no node and stays as it is.
    await vi.waitFor(() => expect(selectNode).toHaveBeenCalledWith(laptop.id));
    expect(fakeWindow.location.pathname).toBe("/tasks");
    expect(fakeWindow.entries()).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();

    // The chosen node's tasks load, and the page holds that node's demand.
    await expect.element(page.getByText("Pack the travel charger")).toBeVisible();
    expect(laptopNode.server.listLocalTasks).toHaveBeenCalled();
    expect(hostedWebConnectionScopes.list()).toEqual([interactiveDemand(laptop)]);
    await expect.element(page.getByText("Choose a device")).not.toBeInTheDocument();
  });

  it("holds the demand of the node an older tasks address named while the page shows it", async () => {
    await page.viewport(1_280, 720);
    fakeWindow = createFakeHistoryWindow(`/node/${studio.id}/tasks`);
    installHostedNodeHistory(fakeWindow as unknown as Window & typeof globalThis);
    const selectNode = selectingNode();
    const studioNode = fakeNodeApi([task("t-studio", "Calibrate the studio monitor")]);
    __setEnvironmentApiOverrideForTests(studio.environmentId, studioNode.api);
    stopOrchestrator = startHostedNodeRouteOrchestrator();

    await mount();

    // The address moves the cursor to its node and drops the segment in place.
    await vi.waitFor(() => expect(fakeWindow!.location.pathname).toBe("/tasks"));
    expect(selectNode).toHaveBeenCalledWith(studio.id);
    // The older address holds no demand; the page shows the node's tasks and
    // holds its demand, with no device choice in between.
    await expect.element(page.getByText("Calibrate the studio monitor")).toBeVisible();
    expect(hostedWebConnectionScopes.list()).toEqual([interactiveDemand(studio)]);
    expect(document.body.textContent).not.toContain("Choose a device");

    // Leaving the page lets the node go.
    await mounted?.unmount();
    mounted = null;
    expect(hostedWebConnectionScopes.list()).toEqual([]);
  });
});
