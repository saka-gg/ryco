import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  hasTaskLink,
  LOCAL_TASKS_FOCUS_REFRESH_MS,
  LOCAL_TASKS_READ_ERROR,
  listTaskChats,
  refreshLocalTasks,
  selectLocalTasksEnvironment,
  selectTaskIds,
  selectTaskView,
  taskLiveStatus,
  taskProjectLocked,
  useLocalTasksStore,
  type LocalTaskChat,
  type LocalTaskView,
  type LocalTasksEnvironmentState,
} from "@ryco/client-runtime/state/tasks";
import { fullThreadEntry, type SidebarThreadOrStub } from "@ryco/client-runtime/state/threads";
import {
  LOCAL_TASK_MAX_LINKS,
  ProjectId,
  WS_METHODS,
  type EnvironmentId,
  type ModelSelection,
  type ServerConfig,
  type ServerProvider,
  type ThreadId,
} from "@ryco/contracts";
import { excludeChatProjects } from "@ryco/shared/projectKind";
import { useRouter } from "@tanstack/react-router";
import { CloudOffIcon, LockIcon, MonitorSmartphoneIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { isHostedHubMode } from "~/env";
import { useEnvironmentServerConfigSelector } from "~/hooks/useChatsAvailability";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { prefetchWorktreeSend } from "~/hooks/worktreeSendPrefetch";
import { preloadRouteChunk } from "~/lib/routeChunkPreload";
import { useHostedRpcCapability } from "~/hostedHub/capabilities";
import { getRoutedHostedNode, subscribeRoutedHostedNode } from "~/hostedHub/nodeRoutes";
import { useHostedHubStore } from "~/hostedHub/state";
import { useHostedNodePageDemand } from "~/hostedHub/useHostedNodePageDemand";
import { getProjectOrderKey } from "~/logicalProject";
import { selectEnvironmentState, useStore } from "~/store";
import { buildThreadRouteParams } from "~/threadRoutes";
import type { Project } from "~/types";
import { useUiStateStore } from "~/uiStateStore";

import { HostedNodeChooser } from "../hostedHub/HostedNodeChooser";
import { modelDisplayName } from "../inboxSidebar/inboxSidebarModel";
import { StatePanel } from "../settings/statistics/parts";
import { orderItemsByPreferredIds } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { openTaskDraft } from "./taskDraft";
import { projectRepositoryKey, taskDraftPlacement, taskStartHint } from "./taskDraft.logic";
import {
  addTaskFiles,
  cancelPendingTaskFile,
  isPendingTaskFileKey,
  taskFileViews,
  useTaskFileUploadsStore,
  type PendingTaskFile,
} from "./taskFiles";
import { TasksPageLayout } from "./TasksPageLayout";
import type { TasksSearch } from "./tasksSearch";
import { TasksView } from "./TasksView";
import type {
  TaskChatOption,
  TaskChatView,
  TaskProjectOption,
  TaskStatusWord,
  TaskView,
  TasksViewHandlers,
  TasksViewModel,
} from "./tasksViewModel";
import { localTaskWriterFor, taskThreadSummaryReader, useLocalTasksSync } from "./useLocalTasks";
import { tasksAvailable, useTasksEnvironment } from "./useTasksEnvironment";

/**
 * The Tasks page: the node's tasks as one checklist. This is the wiring
 * between the presentational `TasksView` and the data: the retained task
 * sync and its writer (`useLocalTasks`), the live thread store for each
 * chat's status, the node's projects, file uploads and the start flow.
 */
export function TasksPage(props: {
  readonly search: TasksSearch;
  readonly onSearchChange: (next: TasksSearch) => void;
}) {
  const tasks = useTasksEnvironment();
  // Hosted, the tasks are the node's under the selection cursor, and the
  // address names no node, so the page holds that node's demand while it
  // shows its tasks.
  useHostedNodePageDemand(tasks.environmentId);
  if (tasks.denied) {
    return (
      <TasksPageLayout
        state={
          <StatePanel
            icon={LockIcon}
            title="Tasks aren’t available here"
            description={tasks.reason ?? "This session can’t open this node’s tasks."}
          />
        }
      />
    );
  }
  if (tasks.environmentId === null && isHostedHubMode()) {
    return <TasksPageLayout state={<HostedChooseNodePanel />} />;
  }
  // Hub authorization not known yet, or the node's config (which tells whether
  // it has tasks) still on its way with the connection. Once allowed, a relay
  // reconnect keeps the tasks on screen.
  if (!tasks.allowed || tasks.environmentId === null || tasks.supported === null)
    return <TasksPageLayout />;
  if (!tasksAvailable(tasks)) return <TasksPageLayout state={<UnsupportedPanel />} />;
  return (
    <TasksPageContent
      environmentId={tasks.environmentId}
      search={props.search}
      onSearchChange={props.onSearchChange}
    />
  );
}

/**
 * Hosted, with the selection cursor on no node: a reload or a new tab on
 * Tasks, whose address names no node. Once the directory has answered, and no
 * older address is moving the cursor to its node, the page offers the nodes to
 * choose from.
 */
function HostedChooseNodePanel() {
  const routedNodeId = useSyncExternalStore(
    subscribeRoutedHostedNode,
    () => getRoutedHostedNode().nodeId,
    () => null,
  );
  const directorySettled = useHostedHubStore(
    (state) => state.directoryStatus === "ready" || state.directoryStatus === "stale",
  );
  if (routedNodeId !== null || !directorySettled) return null;
  return (
    <StatePanel
      icon={MonitorSmartphoneIcon}
      title="Choose a device"
      description="Tasks belong to one device. Open a thread on it, or choose it here."
      action={<HostedNodeChooser label="Devices" />}
    />
  );
}

function UnsupportedPanel() {
  return (
    <StatePanel
      icon={CloudOffIcon}
      title="This node doesn’t have tasks yet"
      description="Update Ryco on it to keep tasks and start chats from them."
    />
  );
}

const selectProviders = (config: ServerConfig | null): ReadonlyArray<ServerProvider> | null =>
  config?.providers ?? null;

const CHAT_OPTION_LIMIT = 50;

/** What every task's view is built from, besides the task itself. */
interface TaskViewContext {
  readonly summaries: Readonly<Record<string, SidebarThreadOrStub | undefined>>;
  readonly projectById: ReadonlyMap<ProjectId, Project>;
  readonly providers: ReadonlyArray<ServerProvider> | null;
  readonly uploads: Readonly<Record<string, ReadonlyArray<PendingTaskFile>>>;
  /** The node can create a worktree for a pull request, issue or Jira item. */
  readonly sourceWorktrees: boolean;
  /** The node's unsent task drafts (`useTaskDraftKeys`). */
  readonly draftKeys: ReadonlySet<string>;
}

function chatThreadIds(task: LocalTaskView): ThreadId[] {
  return [
    ...task.delegations.map((delegation) => delegation.threadId),
    ...task.optimisticStarts.map((start) => start.threadId),
    ...task.links.flatMap((link) => (link.kind === "thread" ? [link.threadId] : [])),
  ];
}

function sameDeps(left: ReadonlyArray<unknown>, right: ReadonlyArray<unknown>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Each task's last view and what it was built from: a row whose inputs did
 * not change gets the same object, so the memoized `TaskRow` skips it. Keyed
 * on the store's task view, which is itself stable while the task is.
 */
const taskViewCache = new WeakMap<
  LocalTaskView,
  { readonly deps: ReadonlyArray<unknown>; readonly view: TaskView }
>();

function chatModel(
  summary: { readonly modelSelection?: ModelSelection | undefined } | undefined,
  providers: ReadonlyArray<ServerProvider> | null,
): Pick<TaskChatView, "modelLabel" | "providerDriver"> {
  const selection = summary?.modelSelection;
  return {
    modelLabel: modelDisplayName(selection, providers) ?? selection?.model ?? "Chat",
    providerDriver:
      providers?.find((provider) => provider.instanceId === selection?.instanceId)?.driver ?? null,
  };
}

/**
 * Whether a task's chat is listed: a deleted chat leaves the list (there is
 * nothing left to open), while one this client keeps only a stub of (an
 * archived chat) stays, as archived.
 */
function isListedChat(
  chat: Pick<LocalTaskChat, "status" | "threadId">,
  summaries: TaskViewContext["summaries"],
): boolean {
  return chat.status !== "unavailable" || summaries[chat.threadId] !== undefined;
}

/** The branches a task's earlier starts asked for (new worktrees only). */
function taskStartBranches(task: LocalTaskView): string[] {
  return [...task.delegations, ...task.optimisticStarts].flatMap((start) =>
    start.branch ? [start.branch] : [],
  );
}

function buildTaskView(task: LocalTaskView, context: TaskViewContext): TaskView {
  const threadIds = chatThreadIds(task);
  const project = task.projectId ? (context.projectById.get(task.projectId) ?? null) : null;
  const hasDraft = context.draftKeys.has(taskDraftKey(task.taskId, task.projectId));
  const deps = [
    hasDraft,
    context.uploads[task.taskId],
    project,
    context.providers,
    context.sourceWorktrees,
    ...threadIds.map((threadId) => context.summaries[threadId]),
  ];
  const cached = taskViewCache.get(task);
  if (cached && sameDeps(cached.deps, deps)) return cached.view;

  const getSummary = (threadId: ThreadId) => fullThreadEntry(context.summaries[threadId]);
  const chats: TaskChatView[] = listTaskChats(task, getSummary).flatMap((chat) => {
    if (!isListedChat(chat, context.summaries)) return [];
    const summary = getSummary(chat.threadId);
    return [
      {
        key: chat.key,
        threadId: chat.threadId,
        title: summary?.title.trim() || null,
        ...chatModel(summary, context.providers),
        status:
          chat.status === "unavailable"
            ? "archived"
            : chat.status === "failed" && !chat.startFailed
              ? "error"
              : chat.status,
        branch: chat.branch,
        linked: chat.linked,
        error: chat.error,
      },
    ];
  });
  const aggregate = taskLiveStatus(task, getSummary);
  // The row says "Failed to start" only when a start itself failed; chats that
  // ran and then stopped on an error read "Error", as in the sidebar.
  const status: TaskStatusWord | null =
    aggregate === "failed" && !chats.some((chat) => chat.status === "failed") ? "error" : aggregate;
  const view: TaskView = {
    id: task.taskId,
    title: task.title,
    notes: task.notes,
    done: task.state === "done",
    projectId: task.projectId,
    dueAt: task.dueAt,
    links: task.links,
    files: taskFileViews(task.files, context.uploads[task.taskId]),
    chats,
    status,
    startHint: project
      ? taskStartHint(
          taskDraftPlacement({
            title: task.title,
            links: task.links,
            projectRepository: projectRepositoryKey(project.repositoryIdentity),
            startBranches: taskStartBranches(task),
            sourceWorktrees: context.sourceWorktrees,
          }),
        )
      : null,
    hasDraft,
    starting: task.optimisticStarts.length > 0,
    // The node fixes the project while a start may have a chat in it.
    projectLocked: taskProjectLocked(task, (threadId) => context.summaries[threadId] !== undefined),
  };
  taskViewCache.set(task, { deps, view });
  return view;
}

function buildTaskViews(
  ids: ReadonlyArray<string>,
  slice: Parameters<typeof selectTaskView>[0],
  environmentId: EnvironmentId,
  context: TaskViewContext,
): TaskView[] {
  return ids.flatMap((taskId) => {
    const task = selectTaskView(slice, environmentId, taskId);
    return task ? [buildTaskView(task, context)] : [];
  });
}

function sameProjectOptions(
  left: ReadonlyArray<TaskProjectOption>,
  right: ReadonlyArray<TaskProjectOption>,
): boolean {
  return (
    left.length === right.length &&
    left.every((option, index) => {
      const other = right[index]!;
      return (
        option.projectId === other.projectId &&
        option.name === other.name &&
        option.environmentId === other.environmentId &&
        option.cwd === other.cwd &&
        option.avatarHash === other.avatarHash
      );
    })
  );
}

/** Local "now", renewed after every local midnight so due labels move with the calendar. */
function useLocalDayNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const timer = setTimeout(() => setNow(Date.now()), midnight.getTime() - Date.now() + 1_000);
    // A machine waking from sleep past midnight catches up on focus.
    const onFocus = () => {
      if (Date.now() >= midnight.getTime()) setNow(Date.now());
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [now]);
  return now;
}

/** A task's unsent draft in a project, as `useTaskDraftKeys` lists it. */
const taskDraftKey = (taskId: string, projectId: ProjectId | null) =>
  `${taskId}\u0000${projectId ?? ""}`;

/**
 * The node's unsent task drafts (`taskDraftKey`); the same set while they
 * stay the same. Start reopens a task's draft only in the task's project.
 */
function useTaskDraftKeys(environmentId: EnvironmentId): ReadonlySet<string> {
  const key = useComposerDraftStore((state) => {
    const keys: string[] = [];
    for (const draft of Object.values(state.draftThreadsByThreadKey)) {
      if (draft.environmentId === environmentId && draft.localTaskId && !draft.promotedTo)
        keys.push(taskDraftKey(draft.localTaskId, draft.projectId));
    }
    return keys.toSorted().join("\n");
  });
  return useMemo(() => new Set(key ? key.split("\n") : []), [key]);
}

let taskIdSequence = 0;

/**
 * A new task's id. Ids sort in creation order, so tasks added together
 * (a pasted list) keep their order when their creation times tie.
 */
function newLocalTaskId(): string {
  taskIdSequence = (taskIdSequence + 1) % 36 ** 4;
  const time = Date.now().toString(36).padStart(9, "0");
  const sequence = taskIdSequence.toString(36).padStart(4, "0");
  const random = Math.floor(Math.random() * 36 ** 6)
    .toString(36)
    .padStart(6, "0");
  return `task-${time}${sequence}${random}`;
}

function TasksPageContent(props: {
  readonly environmentId: EnvironmentId;
  readonly search: TasksSearch;
  readonly onSearchChange: (next: TasksSearch) => void;
}) {
  const { environmentId } = props;
  useLocalTasksSync(environmentId, true);
  // Another surface (the sidebar badge) may have kept the tasks since long
  // ago; opening the page reads them again unless that read is recent.
  useEffect(() => {
    void refreshLocalTasks(environmentId, { staleAfterMs: LOCAL_TASKS_FOCUS_REFRESH_MS });
  }, [environmentId]);
  const writer = localTaskWriterFor(environmentId);
  const router = useRouter({ warn: false });
  const { handleNewTaskChat } = useNewThreadHandler();

  const tasksState = useLocalTasksStore((state) =>
    selectLocalTasksEnvironment(state, environmentId),
  );
  const summaries = useStore(
    (state) => selectEnvironmentState(state, environmentId).sidebarThreadSummaryById,
  );
  const projectIds = useStore((state) => selectEnvironmentState(state, environmentId).projectIds);
  const projectRecord = useStore(
    (state) => selectEnvironmentState(state, environmentId).projectById,
  );
  const projectOrder = useUiStateStore((state) => state.projectOrder);
  const providers = useEnvironmentServerConfigSelector(environmentId, selectProviders);
  const uploads = useTaskFileUploadsStore((state) => state.byTask);
  const sourceWorktrees = useHostedRpcCapability(
    WS_METHODS.gitCreateWorktreeForProject,
    environmentId,
  ).allowed;
  const draftKeys = useTaskDraftKeys(environmentId);

  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const now = useLocalDayNow();

  // ── Projects of the tasks' node, in sidebar order ───────────────────
  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: excludeChatProjects(projectIds.flatMap((id) => projectRecord[id] ?? [])),
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
      }),
    [projectIds, projectOrder, projectRecord],
  );
  const projectById = useMemo(
    () => new Map<ProjectId, Project>(orderedProjects.map((project) => [project.id, project])),
    [orderedProjects],
  );
  const nextProjectOptions = useMemo(
    () =>
      orderedProjects.map((project): TaskProjectOption => ({
        projectId: project.id,
        name: project.name,
        environmentId: project.environmentId,
        cwd: project.cwd,
        avatarHash: project.customAvatarContentHash ?? null,
      })),
    [orderedProjects],
  );
  // The rows are memoized on this list: keep it while no project's name changed.
  const [projects, setProjects] = useState(nextProjectOptions);
  if (projects !== nextProjectOptions && !sameProjectOptions(projects, nextProjectOptions)) {
    setProjects(nextProjectOptions);
  }

  // ── The tasks shown ──────────────────────────────────────────────────
  const filterProjectId = props.search.project ? ProjectId.make(props.search.project) : null;
  const slice = useMemo(
    () => ({ byEnvironment: { [environmentId]: tasksState } }),
    [environmentId, tasksState],
  );
  const openIds = selectTaskIds(slice, environmentId, { done: false, projectId: filterProjectId });
  const doneIds = selectTaskIds(slice, environmentId, { done: true, projectId: filterProjectId });
  const everyOpenId = selectTaskIds(slice, environmentId, { done: false, projectId: null });
  const everyDoneId = selectTaskIds(slice, environmentId, { done: true, projectId: null });

  const context = useMemo<TaskViewContext>(
    () => ({ summaries, projectById, providers, uploads, sourceWorktrees, draftKeys }),
    [draftKeys, projectById, providers, sourceWorktrees, summaries, uploads],
  );
  const openTasks = useMemo(
    () => buildTaskViews(openIds, slice, environmentId, context),
    [context, environmentId, openIds, slice],
  );
  const doneTasks = useMemo(
    () => buildTaskViews(doneIds, slice, environmentId, context),
    [context, doneIds, environmentId, slice],
  );

  const filterProjects = useMemo(() => {
    const used = new Set<string>();
    for (const taskId of [...everyOpenId, ...everyDoneId]) {
      const projectId = selectTaskView(slice, environmentId, taskId)?.projectId;
      if (projectId) used.add(projectId);
    }
    return projects.filter((project) => used.has(project.projectId));
  }, [environmentId, everyDoneId, everyOpenId, projects, slice]);

  const loading = tasksState.readAt === null && tasksState.status !== "error";
  const model = useMemo<TasksViewModel>(
    () => ({
      openTasks,
      doneTasks,
      projects,
      filterProjects,
      filterProjectId,
      expandedTaskId,
      showDone,
      now,
      loading,
    }),
    [
      doneTasks,
      expandedTaskId,
      filterProjectId,
      filterProjects,
      loading,
      now,
      openTasks,
      projects,
      showDone,
    ],
  );

  // ── Handlers: one object for the page's life, reading the latest state ─
  const latest = {
    model,
    context,
    onSearchChange: props.onSearchChange,
    router,
    openDraft: handleNewTaskChat,
  };
  const latestRef = useRef(latest);
  useLayoutEffect(() => {
    latestRef.current = latest;
  });

  const handlers = useMemo<TasksViewHandlers>(() => {
    const readTask = (taskId: string) =>
      selectTaskView(useLocalTasksStore.getState(), environmentId, taskId);
    const readProject = (task: LocalTaskView | undefined) =>
      task?.projectId ? (latestRef.current.context.projectById.get(task.projectId) ?? null) : null;
    const readSummary = (threadId: ThreadId) =>
      taskThreadSummaryReader(useStore.getState(), environmentId)(threadId);
    const readThreadTitle = (threadId: ThreadId) =>
      fullThreadEntry(
        selectEnvironmentState(useStore.getState(), environmentId).sidebarThreadSummaryById[
          threadId
        ],
      )?.title ?? null;
    const chatCount = (taskId: string) => {
      const task = readTask(taskId);
      const summaries = selectEnvironmentState(
        useStore.getState(),
        environmentId,
      ).sidebarThreadSummaryById;
      return task
        ? listTaskChats(task, readSummary).filter((chat) => isListedChat(chat, summaries)).length
        : 0;
    };
    const setLinks = (
      taskId: string,
      update: (links: LocalTaskView["links"]) => LocalTaskView["links"],
    ) => {
      const task = readTask(taskId);
      if (task) writer.update(taskId, { links: update(task.links) });
    };

    const start = (taskId: string) => {
      const task = readTask(taskId);
      if (!task || task.state === "done") return;
      const project = readProject(task);
      if (!project) {
        // The chat needs a project to run in: open the row on its project chip.
        if (latestRef.current.model.expandedTaskId !== taskId) setExpandedTaskId(taskId);
        toastManager.add({ type: "info", title: "Pick a project for this task first" });
        return;
      }
      void openTaskDraft({
        environmentId,
        taskId,
        project: {
          projectRef: scopeProjectRef(environmentId, project.id),
          cwd: project.cwd,
          repository: projectRepositoryKey(project.repositoryIdentity),
        },
        sourceWorktrees: latestRef.current.context.sourceWorktrees,
        describeThread: readThreadTitle,
        open: latestRef.current.openDraft,
      });
    };

    return {
      onFilterChange: (projectId) =>
        latestRef.current.onSearchChange(projectId ? { project: projectId } : {}),
      onAdd: (inputs, options) => {
        const ids = inputs.map((input) => {
          const taskId = newLocalTaskId();
          void writer.create({
            taskId,
            title: input.title,
            notes: "",
            priority: "normal",
            dueAt: input.dueAt,
            projectId: input.projectId,
          });
          return taskId;
        });
        if (ids.length > 1)
          toastManager.add({ type: "success", title: `${ids.length} tasks added` });
        if (options.start && ids.length === 1) start(ids[0]!);
      },
      onToggleDone: (taskId, done) => {
        writer.update(taskId, { state: done ? "done" : "todo" });
        if (!done) return;
        const chats = chatCount(taskId);
        toastManager.add({
          type: "success",
          title: chats > 0 ? "Done · its chats stay in the sidebar" : "Done",
        });
      },
      onToggleExpanded: (taskId) =>
        setExpandedTaskId((current) => (current === taskId ? null : taskId)),
      onToggleShowDone: () => setShowDone((current) => !current),
      onTitleChange: (taskId, title) => writer.update(taskId, { title }),
      onNotesChange: (taskId, notes) => writer.update(taskId, { notes }),
      onProjectChange: (taskId, projectId) => writer.update(taskId, { projectId }),
      onDueChange: (taskId, dueAt) => writer.update(taskId, { dueAt }),
      onAddLink: (taskId, link) =>
        setLinks(taskId, (links) => {
          if (hasTaskLink(links, link)) return links;
          if (links.length >= LOCAL_TASK_MAX_LINKS) {
            toastManager.add({
              type: "error",
              title: `A task holds up to ${LOCAL_TASK_MAX_LINKS} links`,
            });
            return links;
          }
          return [...links, link];
        }),
      onRemoveLink: (taskId, index) =>
        setLinks(taskId, (links) => links.filter((_, position) => position !== index)),
      onAddFiles: (taskId, files) => {
        const task = readTask(taskId);
        if (!task) return;
        addTaskFiles({ environmentId, writer, taskId, files, stored: task.files });
      },
      onRemoveFile: (taskId, fileKey) => {
        if (isPendingTaskFileKey(fileKey)) cancelPendingTaskFile(taskId, fileKey);
        else void writer.removeFile(taskId, fileKey);
      },
      onStart: start,
      onOpenChat: (_taskId, threadId) => {
        const currentRouter = latestRef.current.router;
        if (!currentRouter) return;
        void currentRouter.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
        });
      },
      onDelete: (taskId) => {
        const chats = chatCount(taskId);
        setExpandedTaskId((current) => (current === taskId ? null : current));
        // Files still on their way have nowhere to go.
        for (const file of useTaskFileUploadsStore.getState().byTask[taskId] ?? [])
          cancelPendingTaskFile(taskId, file.key);
        void writer.remove(taskId);
        toastManager.add({
          type: "success",
          title: chats > 0 ? "Task deleted · its chats are kept" : "Task deleted",
        });
      },
      onPrepareStart: (taskId) => {
        // The draft Start opens loads while the pointer is still on its way.
        void preloadRouteChunk("/_chat/draft/$draftId");
        const project = readProject(readTask(taskId));
        if (!project) return;
        // Fetches the new worktree's base and reads the project's defaults; it
        // dedupes repeats itself, and a start that is not a new worktree only
        // gains the defaults.
        prefetchWorktreeSend({
          environmentId,
          projectId: project.id,
          cwd: project.cwd,
          refName: "origin/HEAD",
        });
      },
      getChatOptions: (taskId) => {
        const task = readTask(taskId);
        const environment = selectEnvironmentState(useStore.getState(), environmentId);
        const ids = task?.projectId
          ? (environment.threadIdsByProjectId[task.projectId] ?? [])
          : environment.threadIds;
        const toOption = (threadId: ThreadId): TaskChatOption | null => {
          const summary = fullThreadEntry(environment.sidebarThreadSummaryById[threadId]);
          if (!summary) return null;
          return {
            threadId,
            title: summary.title.trim() || "Untitled chat",
            subtitle:
              summary.branch ??
              latestRef.current.context.projectById.get(summary.projectId)?.name ??
              "",
          };
        };
        const recent = ids
          .flatMap((threadId) => {
            const summary = fullThreadEntry(environment.sidebarThreadSummaryById[threadId]);
            return summary && summary.archivedAt === null ? [summary] : [];
          })
          .toSorted((left, right) =>
            (right.latestUserMessageAt ?? right.createdAt).localeCompare(
              left.latestUserMessageAt ?? left.createdAt,
            ),
          )
          .slice(0, CHAT_OPTION_LIMIT)
          .map((summary) => summary.id);
        // The task's own linked chats always have their titles, wherever they are.
        const linked = (task?.links ?? []).flatMap((link) =>
          link.kind === "thread" ? [link.threadId] : [],
        );
        return [...new Set([...recent, ...linked])].flatMap((threadId) => toOption(threadId) ?? []);
      },
    };
  }, [environmentId, writer]);

  if (tasksState.status === "error" && tasksState.readAt === null) {
    return (
      <TasksPageLayout
        state={
          tasksState.error?.kind === "unsupported" ? (
            <UnsupportedPanel />
          ) : (
            <LoadErrorPanel environmentId={environmentId} state={tasksState} />
          )
        }
      />
    );
  }
  return (
    <TasksPageLayout>
      <TasksView model={model} handlers={handlers} />
    </TasksPageLayout>
  );
}

function LoadErrorPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly state: LocalTasksEnvironmentState;
}) {
  return (
    <StatePanel
      icon={CloudOffIcon}
      title="Couldn’t load the tasks"
      description={props.state.error?.message ?? LOCAL_TASKS_READ_ERROR.message}
      action={
        <Button
          size="sm"
          variant="outline"
          onClick={() => void refreshLocalTasks(props.environmentId)}
        >
          <RefreshCwIcon /> Try again
        </Button>
      }
    />
  );
}
