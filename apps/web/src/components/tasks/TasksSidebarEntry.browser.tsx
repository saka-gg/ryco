import "../../index.css";

import { appAtomRegistry, serverConfigAtom } from "@ryco/client-runtime/rpc";
import { useLocalTasksStore } from "@ryco/client-runtime/state/tasks";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type EnvironmentApi,
  type LocalTask,
  type OrchestrationShellSnapshot,
  type ServerConfig,
} from "@ryco/contracts";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../../environments/primary";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { useStore } from "../../store";
import { TasksSidebarEntry } from "./TasksSidebarEntry";

const ENV = EnvironmentId.make("env-tasks-badge");
const PROJECT = ProjectId.make("project-badge");
const CHAT = ThreadId.make("thread-badge");
const AT = "2026-10-17T09:00:00.000Z";

const TASK: LocalTask = {
  taskId: "t-badge",
  revision: 1,
  title: "Upgrade Effect",
  notes: "",
  priority: "normal",
  dueAt: null,
  projectId: PROJECT,
  links: [],
  files: [],
  state: "todo",
  createdAt: AT,
  updatedAt: AT,
  status: "running",
  delegations: [
    {
      commandId: CommandId.make("task-start:t-badge:m-1"),
      threadId: CHAT,
      messageId: MessageId.make("m-1"),
      sequence: 1,
      branch: "task/upgrade-effect",
      dispatched: true,
      status: "running",
      error: null,
      createdAt: AT,
    },
  ],
};

function seed() {
  const environment = {
    environmentId: ENV,
    label: "Laptop",
    platform: { os: "darwin" as const, arch: "arm64" as const },
    serverVersion: "1",
    capabilities: {
      repositoryIdentity: true,
      threadSettlement: true,
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
}

/** The thread store's copy of the task's chat, waiting on the user or not. */
function syncChat(sequence: number, waitingOnUser: boolean) {
  useStore.getState().syncServerShellSnapshot(
    {
      snapshotSequence: sequence,
      projects: [
        {
          id: PROJECT,
          title: "ryco",
          workspaceRoot: "/repo/ryco",
          defaultModelSelection: null,
          scripts: [],
          createdAt: AT,
          updatedAt: AT,
        },
      ],
      worktrees: [],
      threads: [
        {
          id: CHAT,
          projectId: PROJECT,
          title: "Upgrade Effect",
          modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "task/upgrade-effect",
          worktreePath: null,
          worktreeId: null,
          manualStatusBucket: null,
          manualPosition: 0,
          latestTurn: null,
          createdAt: AT,
          updatedAt: new Date(Date.UTC(2026, 9, 17, 9, 0, sequence)).toISOString(),
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          session: null,
          latestUserMessageAt: AT,
          hasPendingApprovals: false,
          hasPendingUserInput: waitingOnUser,
          hasActionableProposedPlan: false,
        },
      ],
      updatedAt: AT,
    } as unknown as OrchestrationShellSnapshot,
    ENV,
  );
}

let mounted: Awaited<ReturnType<typeof render>> | null = null;

async function mountEntry() {
  const listLocalTasks = vi.fn(async () => ({ tasks: [TASK], nextCursor: null }));
  __setEnvironmentApiOverrideForTests(ENV, {
    server: { listLocalTasks },
  } as unknown as EnvironmentApi);
  const rootRoute = createRootRoute({
    component: () => <TasksSidebarEntry folded={false} index={0} current={false} />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  mounted = await render(
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
    </AppAtomRegistryProvider>,
  );
  return { listLocalTasks };
}

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  await new Promise((resolve) => setTimeout(resolve, 0));
  __resetEnvironmentApiOverridesForTests();
  appAtomRegistry.set(serverConfigAtom, null);
  resetPrimaryEnvironmentDescriptorForTests();
  useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
  useLocalTasksStore.setState({ byEnvironment: {}, forbidden: {} });
  document.body.innerHTML = "";
});

describe("TasksSidebarEntry", () => {
  it("badges open tasks whose chat waits on the user, following the thread store", async () => {
    seed();
    syncChat(1, false);
    const { listLocalTasks } = await mountEntry();

    const link = page.getByTestId("sidebar-tasks-link");
    await expect.element(link).toHaveAccessibleName("Tasks");
    await vi.waitFor(() => expect(listLocalTasks).toHaveBeenCalledTimes(1));

    // The chat asks a question: the task needs the user.
    syncChat(2, true);
    await expect.element(link).toHaveAccessibleName("Tasks, 1 needs you");
    expect(link.element().textContent).toContain("1");

    // Answered: the badge goes away again.
    syncChat(3, false);
    await expect.element(link).toHaveAccessibleName("Tasks");
    expect(link.element().querySelector(".sidebar-fold-badge")).toBeNull();
  });

  it("links to the Tasks page", async () => {
    seed();
    syncChat(1, false);
    await mountEntry();
    await expect.element(page.getByTestId("sidebar-tasks-link")).toHaveAttribute("href", "/tasks");
  });
});
