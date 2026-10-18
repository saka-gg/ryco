import "./tasks.css";

import type { ProjectId } from "@ryco/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { TaskAddRow } from "./TaskAddRow";
import { TaskRow } from "./TaskRow";
import {
  type SettlingTask,
  type TaskListEntry,
  TASK_COMPLETE_SETTLE_MS,
  settleTaskLists,
} from "./taskListSettle.logic";
import type { TaskProjectOption, TasksViewHandlers, TasksViewModel } from "./tasksViewModel";
import { useEnteringTaskIds } from "./useEnteringTaskIds";

const NO_SETTLING: ReadonlyMap<string, SettlingTask> = new Map();

/** Popups handle their own Escape; it must not also close the row they opened from. */
const POPUP_SELECTOR = '[data-slot="menu-popup"], [data-slot="popover-popup"], [role="dialog"]';

/**
 * The Tasks page's content: the header with the open count and the project
 * filter, the add row, the open tasks, and the "Completed" group. Everything
 * comes from `model` and goes out through `handlers`; the view only keeps
 * what is about motion: a checked row keeps its place for a moment before
 * it moves, and rows added after the list first showed settle in.
 */
export function TasksView(props: {
  readonly model: TasksViewModel;
  readonly handlers: TasksViewHandlers;
}) {
  const { model, handlers } = props;
  const doneListId = useId();
  const latestRef = useRef({ model, handlers });
  useLayoutEffect(() => {
    latestRef.current = { model, handlers };
  });

  // ── Settling: a toggled row stays put, showing its new state ─────────
  const [settling, setSettling] = useState(NO_SETTLING);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const lists = useMemo(
    () => settleTaskLists(model.openTasks, model.doneTasks, settling),
    [model.doneTasks, model.openTasks, settling],
  );
  const listsRef = useRef(lists);
  useLayoutEffect(() => {
    listsRef.current = lists;
  });

  const toggleDone = useCallback((taskId: string, done: boolean) => {
    const shown = listsRef.current;
    const openIndex = shown.open.findIndex((entry) => entry.task.id === taskId);
    const list = openIndex === -1 ? "done" : "open";
    const index =
      openIndex === -1 ? shown.done.findIndex((entry) => entry.task.id === taskId) : openIndex;
    const entry = (list === "open" ? shown.open : shown.done)[index];
    if (!entry) return;
    setSettling((previous) =>
      new Map(previous).set(taskId, { list, index, checked: done, snapshot: entry.task }),
    );
    latestRef.current.handlers.onToggleDone(taskId, done);

    const timers = timersRef.current;
    const pending = timers.get(taskId);
    if (pending !== undefined) clearTimeout(pending);
    timers.set(
      taskId,
      setTimeout(() => {
        timers.delete(taskId);
        setSettling((previous) => {
          if (!previous.has(taskId)) return previous;
          const next = new Map(previous);
          next.delete(taskId);
          return next.size === 0 ? NO_SETTLING : next;
        });
        // A row that moves to the other list closes on the way.
        const current = latestRef.current;
        if (done !== (list === "done") && current.model.expandedTaskId === taskId) {
          current.handlers.onToggleExpanded(taskId);
        }
      }, TASK_COMPLETE_SETTLE_MS),
    );
  }, []);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // ── Entrance: only rows that appear after the list first showed ─────
  const allIds = useMemo(
    () => [...model.openTasks, ...model.doneTasks].map((task) => task.id),
    [model.doneTasks, model.openTasks],
  );
  const entering = useEnteringTaskIds(
    allIds,
    model.loading ? null : (model.filterProjectId ?? "all"),
  );

  // ── Escape closes the open row (after any popup above it) ───────────
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const { model: current, handlers: currentHandlers } = latestRef.current;
      if (current.expandedTaskId === null) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(POPUP_SELECTOR)) return;
      currentHandlers.onToggleExpanded(current.expandedTaskId);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const projectsById = useMemo(
    () => new Map<ProjectId, TaskProjectOption>(model.projects.map((p) => [p.projectId, p])),
    [model.projects],
  );

  const renderRows = (entries: ReadonlyArray<TaskListEntry>) =>
    entries.map(({ task, checked }) => (
      <TaskRow
        key={task.id}
        task={task}
        checked={checked}
        project={task.projectId !== null ? (projectsById.get(task.projectId) ?? null) : null}
        projects={model.projects}
        expanded={model.expandedTaskId === task.id}
        entering={entering.has(task.id)}
        now={model.now}
        handlers={handlers}
        onToggleDone={toggleDone}
      />
    ));

  return (
    <div className="tsk @container/tasks relative text-[13px] text-foreground">
      <header className="mt-[4px] mb-[14px] flex items-baseline gap-[10px]">
        <h1 className="m-0 text-[20px] font-semibold tracking-[-0.02em]">Tasks</h1>
        {model.loading ? null : (
          <span className="shrink-0 text-[13px] text-(--task-faint)">{lists.open.length} open</span>
        )}
        <div
          role="group"
          aria-label="Filter by project"
          className="ml-auto flex min-w-0 flex-wrap justify-end gap-[2px]"
        >
          <FilterButton
            label="All"
            pressed={model.filterProjectId === null}
            onClick={() => handlers.onFilterChange(null)}
          />
          {model.filterProjects.map((project) => (
            <FilterButton
              key={project.projectId}
              label={project.name}
              pressed={model.filterProjectId === project.projectId}
              onClick={() => handlers.onFilterChange(project.projectId)}
            />
          ))}
        </div>
      </header>
      <TaskAddRow
        projects={model.projects}
        filterProjectId={model.filterProjectId}
        now={model.now}
        onAdd={handlers.onAdd}
      />
      <div className="flex flex-col" data-task-list="open">
        {renderRows(lists.open)}
      </div>
      {model.loading ? null : (
        <>
          <button
            type="button"
            className="tsk-group mt-[14px] mb-[2px] flex cursor-pointer items-center gap-[6px] border-0 bg-transparent px-[10px] py-[4px] text-[12px] text-(--task-faint)"
            aria-expanded={model.showDone}
            aria-controls={doneListId}
            onClick={handlers.onToggleShowDone}
          >
            <ChevronRightIcon className="size-3 shrink-0" aria-hidden />
            <span>Completed · {lists.done.length}</span>
          </button>
          <div
            id={doneListId}
            className="flex flex-col"
            data-task-list="done"
            hidden={!model.showDone}
          >
            {model.showDone ? renderRows(lists.done) : null}
          </div>
        </>
      )}
    </div>
  );
}

function FilterButton(props: {
  readonly label: string;
  readonly pressed: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="tsk-filter max-w-[180px] cursor-pointer truncate rounded-[6px] border-0 bg-transparent px-[7px] py-[3px] text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-pressed={props.pressed}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}
