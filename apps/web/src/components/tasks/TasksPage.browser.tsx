import "../../index.css";

import { appAtomRegistry, serverConfigAtom } from "@ryco/client-runtime/rpc";
import { useLocalTasksStore } from "@ryco/client-runtime/state/tasks";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  LocalTaskError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorktreeId,
  type EnvironmentApi,
  type LocalTask,
  type LocalTaskAddFileInput,
  type LocalTaskCreateInput,
  type LocalTaskDelegateInput,
  type LocalTaskUpdateInput,
  type ModelSelection,
  type OrchestrationShellSnapshot,
  type ServerConfig,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../../environments/primary";
import { resetWorktreeSendPrefetchForTests } from "../../hooks/worktreeSendPrefetch";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { useStore } from "../../store";
import { SidebarProvider } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { TasksPage } from "./TasksPage";
import { useTaskFileUploadsStore } from "./taskFiles";

const ENV = EnvironmentId.make("env-tasks-page");
const PROJECT = ProjectId.make("project-ryco");
const MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-opus-5-5",
  options: [],
};
const CREATED_AT = "2026-10-17T09:00:00.000Z";

function task(overrides: Partial<LocalTask> & Pick<LocalTask, "taskId" | "title">): LocalTask {
  return {
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
    ...overrides,
  };
}

/** A node holding tasks in memory, answering the task methods the way the server does. */
function fakeNode(initial: ReadonlyArray<LocalTask>) {
  const tasks = new Map(initial.map((entry) => [entry.taskId, entry]));
  const now = () => new Date().toISOString();
  const require = (taskId: string) => {
    const found = tasks.get(taskId);
    if (!found) throw new Error(`no task ${taskId}`);
    return found;
  };
  const save = (next: LocalTask) => {
    tasks.set(next.taskId, next);
    return next;
  };
  const server = {
    listLocalTasks: vi.fn(async () => ({ tasks: [...tasks.values()], nextCursor: null })),
    getLocalTask: vi.fn(async ({ taskId }: { taskId: string }) => require(taskId)),
    createLocalTask: vi.fn(async (input: LocalTaskCreateInput) =>
      save(task({ ...input, revision: 0, createdAt: now(), updatedAt: now() })),
    ),
    updateLocalTask: vi.fn(async ({ taskId, ...patch }: LocalTaskUpdateInput) => {
      const current = require(taskId);
      // Absent fields stay as they are; the revision is the node's own.
      const changed = Object.fromEntries(
        Object.entries(patch).filter(
          ([key, value]) => key !== "expectedRevision" && value !== undefined,
        ),
      ) as Partial<LocalTask>;
      return save({
        ...current,
        ...changed,
        revision: current.revision + 1,
        updatedAt: now(),
        status: (patch.state ?? current.state) === "done" ? "done" : current.status,
      });
    }),
    deleteLocalTask: vi.fn(async ({ taskId }: { taskId: string }) => {
      tasks.delete(taskId);
      return { deleted: true as const };
    }),
    delegateLocalTask: vi.fn(async ({ taskId, command }: LocalTaskDelegateInput) => {
      const current = require(taskId);
      return save({
        ...current,
        status: "starting",
        delegations: [
          ...current.delegations,
          {
            commandId: command.commandId,
            threadId: command.threadId,
            messageId: command.message.messageId,
            sequence: current.delegations.length + 1,
            branch: command.bootstrap?.prepareWorktree?.branch ?? null,
            dispatched: true,
            status: "starting",
            error: null,
            createdAt: now(),
          },
        ],
      });
    }),
    addLocalTaskFile: vi.fn(async (input: LocalTaskAddFileInput) => {
      const current = require(input.taskId);
      return save({
        ...current,
        revision: current.revision + 1,
        files: [
          ...current.files,
          {
            fileId: `file-${current.files.length + 1}`,
            type: input.mimeType.startsWith("image/") ? "image" : "file",
            name: input.name,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            addedAt: now(),
          },
        ],
      });
    }),
  };
  const git = {
    createWorktreeForProject: vi.fn(async () => ({
      worktreeId: WorktreeId.make("worktree-pr-746"),
      sessionId: ThreadId.make("thread-pr-746"),
    })),
  };
  const vcs = {
    // A branch with the task's first name exists already.
    listRefs: vi.fn(async () => ({
      refs: [
        {
          name: "task/fix-login-redirect-loop",
          current: false,
          isDefault: false,
          worktreePath: null,
        },
      ],
      isRepo: true,
      hasPrimaryRemote: true,
      nextCursor: null,
      totalCount: 1,
    })),
    prefetchWorktreeBase: vi.fn(async () => undefined),
  };
  return { tasks, server, git, vcs, api: { server, git, vcs } as unknown as EnvironmentApi };
}

function seedNode(localTasks: boolean) {
  const environment = {
    environmentId: ENV,
    label: "Laptop",
    platform: { os: "darwin" as const, arch: "arm64" as const },
    serverVersion: "1",
    capabilities: {
      repositoryIdentity: true,
      threadSettlement: true,
      threadPriorityRanking: false,
      localTasks,
    },
  };
  writePrimaryEnvironmentDescriptor(environment);
  appAtomRegistry.set(serverConfigAtom, {
    environment,
    providers: [],
    settings: { ...DEFAULT_SERVER_SETTINGS, initialModelSelection: MODEL },
  } as unknown as ServerConfig);
  useStore.getState().syncServerShellSnapshot(
    {
      snapshotSequence: 1,
      projects: [
        {
          id: PROJECT,
          title: "ryco",
          workspaceRoot: "/repo/ryco",
          defaultModelSelection: null,
          scripts: [],
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        },
      ],
      worktrees: [],
      threads: [],
      updatedAt: CREATED_AT,
    } as unknown as OrchestrationShellSnapshot,
    ENV,
  );
}

let mounted: Awaited<ReturnType<typeof render>> | null = null;

async function mount(node: ReturnType<typeof fakeNode>) {
  __setEnvironmentApiOverrideForTests(ENV, node.api);
  mounted = await render(
    <AppAtomRegistryProvider>
      <SidebarProvider>
        <TasksPage search={{}} onSearchChange={() => undefined} />
      </SidebarProvider>
    </AppAtomRegistryProvider>,
  );
}

function rowElement(taskId: string, list?: "open" | "done"): HTMLElement | null {
  const scope = list ? `[data-task-list="${list}"] ` : "";
  return document.querySelector<HTMLElement>(`${scope}[data-task-id="${taskId}"]`);
}

function rowButton(taskId: string, name: string): HTMLButtonElement {
  const buttons = Array.from(rowElement(taskId)?.querySelectorAll("button") ?? []);
  const found = buttons.find(
    (button) => (button.getAttribute("aria-label") ?? button.textContent ?? "").trim() === name,
  );
  if (!found) throw new Error(`no button ${name} in ${taskId}`);
  return found;
}

async function openRow(taskId: string, title: string) {
  await userEvent.click(rowButton(taskId, title));
  await vi.waitFor(() => expect(rowElement(taskId)?.hasAttribute("data-open")).toBe(true));
}

beforeEach(() => {
  resetWorktreeSendPrefetchForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await mounted?.unmount();
  mounted = null;
  // The retained sync lets go at the end of the task that released it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  __resetEnvironmentApiOverridesForTests();
  appAtomRegistry.set(serverConfigAtom, null);
  resetPrimaryEnvironmentDescriptorForTests();
  useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
  useLocalTasksStore.setState({ byEnvironment: {}, forbidden: {} });
  useTaskFileUploadsStore.setState({ byTask: {} });
  document.body.innerHTML = "";
});

describe("TasksPage", () => {
  it("lists the node's tasks, open ones counted and completed ones grouped", async () => {
    const node = fakeNode([
      task({ taskId: "t-open", title: "Fix login redirect loop" }),
      task({ taskId: "t-done", title: "Simplify chat header", state: "done", status: "done" }),
    ]);
    seedNode(true);
    await mount(node);

    await vi.waitFor(() => expect(rowElement("t-open", "open")).not.toBeNull());
    await expect.element(page.getByText("1 open")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Completed · 1" })).toBeVisible();
    expect(rowElement("t-open")!.textContent).toContain("ryco");
    expect(node.server.listLocalTasks).toHaveBeenCalledTimes(1);
  });

  it("shows the owner-only panel when the node refuses this session its tasks", async () => {
    const node = fakeNode([]);
    node.server.listLocalTasks.mockRejectedValue(
      Object.assign(new Error("Only owner sessions can call server.listLocalTasks."), {
        _tag: "AuthRpcError",
      }),
    );
    seedNode(true);
    await mount(node);
    await expect.element(page.getByText("Tasks aren’t available here")).toBeVisible();
    await expect.element(page.getByText("Only the node’s owner can use its tasks.")).toBeVisible();
    expect(page.getByText("Couldn’t load the tasks").elements()).toHaveLength(0);
  });

  it("says so when the node has no tasks", async () => {
    seedNode(false);
    await mount(fakeNode([]));
    await expect.element(page.getByText("This node doesn’t have tasks yet")).toBeVisible();
  });

  it("adds a task on Enter, and checking it off saves it as done", async () => {
    const node = fakeNode([]);
    seedNode(true);
    await mount(node);
    await expect.element(page.getByText("0 open")).toBeVisible();

    const input = page.getByRole("textbox", { name: "Add a task" });
    await input.fill("Write the release notes");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(node.server.createLocalTask).toHaveBeenCalledTimes(1));
    const created = node.server.createLocalTask.mock.calls[0]![0];
    expect(created).toMatchObject({
      title: "Write the release notes",
      notes: "",
      priority: "normal",
      dueAt: null,
      projectId: null,
    });
    await expect.element(page.getByText("1 open")).toBeVisible();

    await userEvent.click(rowButton(created.taskId, "Done: Write the release notes"));
    await vi.waitFor(() =>
      expect(node.server.updateLocalTask).toHaveBeenCalledWith({
        taskId: created.taskId,
        expectedRevision: 0,
        state: "done",
      }),
    );
    // It moves to Completed once its check has settled.
    await vi.waitFor(() => expect(rowElement(created.taskId, "open")).toBeNull());
    await expect.element(page.getByRole("button", { name: "Completed · 1" })).toBeVisible();
  });

  it("starts a chat in a new worktree on the task's own branch", async () => {
    const node = fakeNode([
      task({
        taskId: "t-login",
        title: "Fix the login redirect loop",
        notes: "After the cookie expires.",
      }),
    ]);
    seedNode(true);
    await mount(node);
    await vi.waitFor(() => expect(rowElement("t-login")).not.toBeNull());

    await openRow("t-login", "Fix the login redirect loop");
    await expect
      .element(page.getByText("task/fix-login-redirect-loop", { exact: true }))
      .toBeVisible();
    await userEvent.click(rowButton("t-login", "Start chat"));

    await vi.waitFor(() => expect(node.server.delegateLocalTask).toHaveBeenCalledTimes(1));
    const { taskId, command } = node.server.delegateLocalTask.mock.calls[0]![0];
    expect(taskId).toBe("t-login");
    expect(command.commandId).toBe(`task-start:t-login:${command.message.messageId}`);
    expect(command.message).toMatchObject({
      role: "user",
      text: "Fix the login redirect loop\n\nAfter the cookie expires.",
      attachments: [],
    });
    expect(command).toMatchObject({
      type: "thread.turn.start",
      modelSelection: MODEL,
      titleSeed: "Fix the login redirect loop",
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    // The branch the task would take exists, so the next free one is used.
    expect(command.bootstrap).toMatchObject({
      requireWorktree: true,
      createThread: { projectId: PROJECT, modelSelection: MODEL, worktreePath: null },
      prepareWorktree: {
        projectCwd: "/repo/ryco",
        baseBranch: "origin/HEAD",
        fetchOrigin: true,
        branch: "task/fix-login-redirect-loop-2",
      },
    });
    expect(node.git.createWorktreeForProject).not.toHaveBeenCalled();
    // The chat shows on the task; the project is fixed now.
    await vi.waitFor(() => expect(rowElement("t-login")!.textContent).toContain("Starting"));
  });

  it("retries a start the node recorded as failed as a new start, never calling it started", async () => {
    const node = fakeNode([task({ taskId: "t-retry", title: "Fix the login redirect loop" })]);
    // The worktree could not be created: the node records the start failed and says why.
    node.server.delegateLocalTask.mockImplementationOnce(
      async ({ taskId, command }: LocalTaskDelegateInput) => {
        const current = node.tasks.get(taskId)!;
        node.tasks.set(taskId, {
          ...current,
          status: "failed",
          delegations: [
            {
              commandId: command.commandId,
              threadId: command.threadId,
              messageId: command.message.messageId,
              sequence: 1,
              branch: command.bootstrap?.prepareWorktree?.branch ?? null,
              dispatched: false,
              status: "failed",
              error: "Worktree setup failed.",
              createdAt: new Date().toISOString(),
            },
          ],
        });
        throw new LocalTaskError({ reason: "persistence", message: "Worktree setup failed." });
      },
    );
    const toasts = vi.spyOn(toastManager, "add");
    seedNode(true);
    await mount(node);
    await vi.waitFor(() => expect(rowElement("t-retry")).not.toBeNull());
    await openRow("t-retry", "Fix the login redirect loop");
    await userEvent.click(rowButton("t-retry", "Start chat"));

    const failureToast = () =>
      toasts.mock.calls.find(([toast]) => toast.title === "Couldn’t start the chat")?.[0];
    await vi.waitFor(() => expect(failureToast()).toBeDefined());
    // The failure is read back from the node before Retry decides what to send.
    await vi.waitFor(() => expect(rowElement("t-retry")!.textContent).toContain("Failed to start"));
    const retry = failureToast()!.actionProps as { onClick: () => void };
    retry.onClick();

    await vi.waitFor(() => expect(node.server.delegateLocalTask).toHaveBeenCalledTimes(2), {
      timeout: 10_000,
    });
    const [failed, fresh] = node.server.delegateLocalTask.mock.calls.map(
      ([input]) => input.command,
    );
    expect(fresh!.commandId).not.toBe(failed!.commandId);
    expect(fresh!.message.messageId).not.toBe(failed!.message.messageId);
    expect(fresh!.threadId).not.toBe(failed!.threadId);
    // The failed start's branch counts as taken.
    expect(failed!.bootstrap?.prepareWorktree?.branch).toBe("task/fix-login-redirect-loop-2");
    expect(fresh!.bootstrap?.prepareWorktree?.branch).toBe("task/fix-login-redirect-loop-3");
    await vi.waitFor(() =>
      expect(toasts.mock.calls.filter(([toast]) => toast.type === "success")).toHaveLength(1),
    );
  });

  it("starts a pull request task in that pull request's worktree", async () => {
    const node = fakeNode([
      task({
        taskId: "t-pr",
        title: "Address review on 746",
        links: [{ kind: "pr", number: 746 }],
      }),
    ]);
    seedNode(true);
    await mount(node);
    await vi.waitFor(() => expect(rowElement("t-pr")).not.toBeNull());

    await openRow("t-pr", "Address review on 746");
    await expect.element(page.getByText("in the PR #746 worktree")).toBeVisible();
    await userEvent.click(rowButton("t-pr", "Start chat"));

    await vi.waitFor(() => expect(node.server.delegateLocalTask).toHaveBeenCalledTimes(1));
    expect(node.git.createWorktreeForProject).toHaveBeenCalledWith({
      projectId: PROJECT,
      intent: { kind: "pr", number: 746 },
      fetchOrigin: true,
    });
    const { command } = node.server.delegateLocalTask.mock.calls[0]![0];
    expect(command.threadId).toBe("thread-pr-746");
    expect(command).not.toHaveProperty("bootstrap");
    expect(command.message.text).toBe("Address review on 746\n\nLinked:\n- Pull request #746");
  });

  it("starts in the project folder from the where menu, creating only the thread", async () => {
    const node = fakeNode([task({ taskId: "t-local", title: "Tidy the changelog" })]);
    seedNode(true);
    await mount(node);
    await vi.waitFor(() => expect(rowElement("t-local")).not.toBeNull());

    await openRow("t-local", "Tidy the changelog");
    await userEvent.click(rowButton("t-local", "Where"));
    await page.getByRole("menuitem", { name: /Project folder/ }).click();

    // Without a live status for the checkout, its branch is read for a moment first.
    await vi.waitFor(() => expect(node.server.delegateLocalTask).toHaveBeenCalledTimes(1), {
      timeout: 10_000,
    });
    const { command } = node.server.delegateLocalTask.mock.calls[0]![0];
    expect(command.bootstrap).toEqual({
      createThread: expect.objectContaining({
        projectId: PROJECT,
        title: "Tidy the changelog",
        worktreePath: null,
        branch: null,
      }),
    });
    expect(node.vcs.listRefs).not.toHaveBeenCalled();
  });

  it("adds a file inline when the node can't take streamed uploads", async () => {
    const node = fakeNode([task({ taskId: "t-file", title: "Look at the screenshot" })]);
    seedNode(true);
    await mount(node);
    await vi.waitFor(() => expect(rowElement("t-file")).not.toBeNull());
    await openRow("t-file", "Look at the screenshot");

    const picker = rowElement("t-file")!.querySelector<HTMLInputElement>("[data-task-file-input]")!;
    const transfer = new DataTransfer();
    transfer.items.add(new File(["hello"], "notes.txt", { type: "text/plain" }));
    picker.files = transfer.files;
    picker.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(node.server.addLocalTaskFile).toHaveBeenCalledTimes(1));
    expect(node.server.addLocalTaskFile.mock.calls[0]![0]).toMatchObject({
      taskId: "t-file",
      expectedRevision: 1,
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      dataUrl: "data:text/plain;base64,aGVsbG8=",
    });
    await vi.waitFor(() =>
      expect(rowButton("t-file", "Remove notes.txt").closest("[aria-busy]")).toBeNull(),
    );
  });

  it("deletes a task", async () => {
    const node = fakeNode([task({ taskId: "t-gone", title: "Old idea" })]);
    seedNode(true);
    await mount(node);
    await vi.waitFor(() => expect(rowElement("t-gone")).not.toBeNull());

    await openRow("t-gone", "Old idea");
    await userEvent.click(rowButton("t-gone", "Delete"));
    await vi.waitFor(() => expect(rowElement("t-gone")).toBeNull());
    await vi.waitFor(() =>
      expect(node.server.deleteLocalTask).toHaveBeenCalledWith({
        taskId: "t-gone",
        expectedRevision: 1,
      }),
    );
  });
});
