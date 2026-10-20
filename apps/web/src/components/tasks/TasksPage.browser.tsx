import "../../index.css";

const navigate = vi.fn(async (_options: unknown) => undefined);
const router = { state: { matches: [] }, navigate };
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => router,
}));

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
  WorktreeId,
  type EnvironmentApi,
  type LocalTask,
  type LocalTaskAddFileInput,
  type LocalTaskChange,
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

import { useComposerDraftStore } from "../../composerDraftStore";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../../environments/primary";
import { resetNewDraftDefaultsCacheForTests } from "../../hooks/newDraftDefaults";
import { resetWorktreeSendPrefetchForTests } from "../../hooks/worktreeSendPrefetch";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { useStore } from "../../store";
import { SidebarProvider } from "../ui/sidebar";
import { TasksPage } from "./TasksPage";
import { taskDraftSend } from "./taskDraft";
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

/**
 * Gives `node` a change stream the way the server runs one: list pages and the stream's word to
 * read everything carry the node's change position, and the word comes half a round trip after
 * the subscription, while the first list read is still out (as on a node switch). Call it before
 * `mount`, which binds the node's methods.
 */
function withChangeStream(
  node: ReturnType<typeof fakeNode>,
  { roundTripMs = 30 }: { readonly roundTripMs?: number } = {},
) {
  const feed = "feed-1";
  let sequence = 0;
  let listener: ((change: LocalTaskChange) => void) | null = null;
  const emit = (change: LocalTaskChange) => listener?.(change);
  const server = node.server as unknown as Record<string, unknown>;
  server.listLocalTasks = vi.fn(() => {
    // The position is read before the page's query, as the node does.
    const result = {
      tasks: [...node.tasks.values()],
      nextCursor: null,
      position: { feed, sequence },
    };
    return new Promise((resolve) => setTimeout(() => resolve(result), roundTripMs));
  });
  server.subscribeLocalTaskChanges = vi.fn((next: (change: LocalTaskChange) => void) => {
    listener = next;
    const timer = setTimeout(() => emit({ position: { feed, sequence } }), roundTripMs / 2);
    return () => {
      clearTimeout(timer);
      if (listener === next) listener = null;
    };
  });
  return {
    position: () => ({ feed, sequence }),
    emit,
    /** A change on the node: the task is saved, then its change goes out. */
    publish: (taskId: string, next: LocalTask) => {
      node.tasks.set(taskId, next);
      sequence += 1;
      emit({ taskId });
    },
  };
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
  navigate.mockClear();
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
});

/** The draft the task's Start opened. */
const taskDraft = (taskId: string) =>
  useComposerDraftStore.getState().getLocalTaskDraftSession(ENV, taskId);

afterEach(async () => {
  vi.restoreAllMocks();
  await mounted?.unmount();
  mounted = null;
  // The retained sync lets go at the end of the task that released it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  __resetEnvironmentApiOverridesForTests();
  resetNewDraftDefaultsCacheForTests();
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

  it("reads the node's tasks once when the page opens on a node, and again only for what changes", async () => {
    const node = fakeNode([
      task({ taskId: "t-open", title: "Fix login redirect loop" }),
      task({ taskId: "t-next", title: "Simplify chat header" }),
    ]);
    seedNode(true);
    const roundTripMs = 30;
    const stream = withChangeStream(node, { roundTripMs });
    await mount(node);
    const roundTrips = (count: number) =>
      new Promise((resolve) => setTimeout(resolve, count * roundTripMs));

    await vi.waitFor(() => expect(rowElement("t-open")).not.toBeNull());
    await roundTrips(4);
    // The stream's first word came while the list read was out, and that read covered it.
    expect(node.server.listLocalTasks).toHaveBeenCalledTimes(1);

    // Listening again with nothing new since reads nothing.
    stream.emit({ position: stream.position() });
    await roundTrips(2);
    expect(node.server.listLocalTasks).toHaveBeenCalledTimes(1);

    // A change reads the task it names, not the list.
    stream.publish("t-open", {
      ...node.tasks.get("t-open")!,
      revision: 2,
      title: "Fix the login loop",
    });
    await vi.waitFor(() =>
      expect(rowElement("t-open")!.textContent).toContain("Fix the login loop"),
    );
    expect(node.server.getLocalTask).toHaveBeenCalledTimes(1);
    expect(node.server.listLocalTasks).toHaveBeenCalledTimes(1);

    // A word after that change is past what the list read covers: it reads the list.
    stream.emit({ position: stream.position() });
    await vi.waitFor(() => expect(node.server.listLocalTasks).toHaveBeenCalledTimes(2));

    // So does a restarted node's.
    stream.emit({ position: { feed: "feed-2", sequence: 0 } });
    await vi.waitFor(() => expect(node.server.listLocalTasks).toHaveBeenCalledTimes(3));
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

  it("opens a draft prefilled with the task, in a new worktree on the task's own branch", async () => {
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

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    const draft = taskDraft("t-login")!;
    expect(navigate).toHaveBeenLastCalledWith({
      to: "/draft/$draftId",
      params: { draftId: draft.draftId },
    });
    expect(draft).toMatchObject({
      projectId: PROJECT,
      envMode: "worktree",
      branch: null,
      worktreePath: null,
      worktreeSource: null,
      fetchOrigin: true,
      runtimeMode: "full-access",
    });
    expect(useComposerDraftStore.getState().getComposerDraft(draft.draftId)?.prompt).toBe(
      "Fix the login redirect loop\n\nAfter the cookie expires.",
    );
    // The task's branch exists already: the draft moves on to the next free one.
    await vi.waitFor(() =>
      expect(taskDraft("t-login")?.worktreeBranchName).toBe("task/fix-login-redirect-loop-2"),
    );
    // Nothing is sent from here: the draft is where the model and worktree are picked.
    expect(node.server.delegateLocalTask).not.toHaveBeenCalled();
    expect(node.git.createWorktreeForProject).not.toHaveBeenCalled();

    // Start again reopens the draft not sent yet.
    await vi.waitFor(() => expect(rowButton("t-login", "Open draft")).toBeTruthy());
    await userEvent.click(rowButton("t-login", "Open draft"));
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(2));
    expect(navigate).toHaveBeenLastCalledWith({
      to: "/draft/$draftId",
      params: { draftId: draft.draftId },
    });
    expect(Object.keys(useComposerDraftStore.getState().draftThreadsByThreadKey)).toEqual([
      draft.draftId,
    ]);
  });

  it("picks a linked pull request as the draft's worktree source", async () => {
    const node = fakeNode([
      task({
        taskId: "t-pr",
        title: "Address review on 746",
        links: [{ kind: "pr", number: 746, title: "Fix login" }],
      }),
    ]);
    seedNode(true);
    await mount(node);
    await vi.waitFor(() => expect(rowElement("t-pr")).not.toBeNull());

    await openRow("t-pr", "Address review on 746");
    await expect.element(page.getByText("in the PR #746 worktree")).toBeVisible();
    await userEvent.click(rowButton("t-pr", "Start chat"));

    await vi.waitFor(() => expect(taskDraft("t-pr")).not.toBeNull());
    expect(taskDraft("t-pr")).toMatchObject({
      envMode: "worktree",
      worktreeSource: { kind: "pr", number: 746, label: "#746 Fix login" },
      worktreeBranchName: null,
    });
    expect(
      useComposerDraftStore.getState().getComposerDraft(taskDraft("t-pr")!.draftId)?.prompt,
    ).toBe("Address review on 746\n\nLinked:\n- Pull request #746: Fix login");
    // The worktree is created when the draft is sent, not now.
    expect(node.git.createWorktreeForProject).not.toHaveBeenCalled();
  });

  it("takes a linked branch as it is in the checkout, on a new task branch", async () => {
    const node = fakeNode([
      task({
        taskId: "t-branch",
        title: "Finish the parser",
        links: [{ kind: "branch", name: "feature/parser" }],
      }),
    ]);
    seedNode(true);
    await mount(node);
    await vi.waitFor(() => expect(rowElement("t-branch")).not.toBeNull());

    await openRow("t-branch", "Finish the parser");
    await userEvent.click(rowButton("t-branch", "Start chat"));
    await vi.waitFor(() => expect(taskDraft("t-branch")).not.toBeNull());
    // Not origin's copy: the branch may have commits that were never pushed.
    expect(taskDraft("t-branch")).toMatchObject({
      envMode: "worktree",
      branch: "feature/parser",
      fetchOrigin: false,
      worktreeSource: null,
      worktreeBranchName: "task/finish-parser",
    });
  });

  it("lists an archived linked chat as archived, and a deleted one not at all", async () => {
    const archived = ThreadId.make("thread-archived");
    const node = fakeNode([
      task({
        taskId: "t-linked",
        title: "Collect the findings",
        links: [
          { kind: "thread", threadId: archived },
          { kind: "thread", threadId: ThreadId.make("thread-gone") },
        ],
      }),
    ]);
    seedNode(true);
    // This client keeps only a stub of an archived chat.
    useStore.setState((state) => {
      const environment = state.environmentStateById[ENV]!;
      return {
        environmentStateById: {
          ...state.environmentStateById,
          [ENV]: {
            ...environment,
            sidebarThreadSummaryById: {
              ...environment.sidebarThreadSummaryById,
              [archived]: {
                shellDetail: "archived-stub",
                id: archived,
                environmentId: ENV,
                projectId: PROJECT,
                title: "Old findings",
                createdAt: CREATED_AT,
                updatedAt: CREATED_AT,
                archivedAt: CREATED_AT,
                branch: null,
                worktreePath: null,
                worktreeId: null,
                latestUserMessageAt: null,
                lineage: null,
              },
            },
          },
        },
      };
    });
    await mount(node);
    await vi.waitFor(() => expect(rowElement("t-linked")).not.toBeNull());

    await openRow("t-linked", "Collect the findings");
    const chats = rowElement("t-linked")!.querySelectorAll(".tsk-chat");
    expect(chats).toHaveLength(1);
    expect(chats[0]!.textContent).toContain("Archived");
  });

  it("checks a task draft's task before anything is created for the send", async () => {
    const node = fakeNode([
      task({ taskId: "t-done", title: "Shipped already", state: "done", status: "done" }),
    ]);
    seedNode(true);
    await mount(node);
    await vi.waitFor(() => expect(node.server.listLocalTasks).toHaveBeenCalled());

    await expect(taskDraftSend(ENV, "t-done").preflight()).rejects.toThrow("The task is done");
    await expect(taskDraftSend(ENV, "t-missing").preflight()).rejects.toThrow(
      "The task was deleted",
    );
  });

  it("sends a task draft's first message as the task's chat", async () => {
    const node = fakeNode([task({ taskId: "t-send", title: "Tidy the changelog" })]);
    seedNode(true);
    await mount(node);
    await vi.waitFor(() => expect(rowElement("t-send")).not.toBeNull());

    const threadId = ThreadId.make("thread-send");
    const messageId = MessageId.make("message-send");
    const command: LocalTaskDelegateInput["command"] = {
      type: "thread.turn.start",
      commandId: CommandId.make(`composer-send:${threadId}:${messageId}`),
      threadId,
      message: { messageId, role: "user", text: "Tidy the changelog", attachments: [] },
      modelSelection: MODEL,
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: PROJECT,
          title: "Tidy the changelog",
          modelSelection: MODEL,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: CREATED_AT,
        },
        prepareWorktree: {
          projectCwd: "/repo/ryco",
          baseBranch: "origin/HEAD",
          branch: "task/tidy-changelog",
        },
      },
      createdAt: CREATED_AT,
    };
    await taskDraftSend(ENV, "t-send").delegate(command);

    expect(node.server.delegateLocalTask).toHaveBeenCalledWith({ taskId: "t-send", command });
    await vi.waitFor(() => expect(rowElement("t-send")!.textContent).toContain("Starting"));

    // A task the node no longer has refuses the send, so the composer keeps the message.
    await expect(taskDraftSend(ENV, "t-missing").delegate(command)).rejects.toThrow(
      "The task was deleted",
    );
  });

  it("leaves a deleted chat off the task, which reads as having none", async () => {
    const node = fakeNode([
      task({
        taskId: "t-deleted",
        title: "Old experiment",
        delegations: [
          {
            commandId: CommandId.make("command-old"),
            threadId: ThreadId.make("thread-old"),
            messageId: MessageId.make("message-old"),
            sequence: 1,
            branch: "task/old-experiment",
            dispatched: true,
            status: "unavailable",
            error: null,
            createdAt: CREATED_AT,
          },
        ],
      }),
    ]);
    seedNode(true);
    await mount(node);
    await vi.waitFor(() => expect(rowElement("t-deleted")).not.toBeNull());

    await openRow("t-deleted", "Old experiment");
    expect(rowElement("t-deleted")!.querySelector(".tsk-chat")).toBeNull();
    expect(rowElement("t-deleted")!.textContent).not.toContain("Chat deleted");
    expect(rowButton("t-deleted", "Start chat")).toBeTruthy();
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
