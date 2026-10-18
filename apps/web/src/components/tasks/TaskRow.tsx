import { CheckIcon, PlayIcon } from "lucide-react";
import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { TaskDetails } from "./TaskDetails";
import { TaskRowMeta } from "./TaskRowMeta";
import { TASK_TITLE_MAX_LENGTH } from "./tasksUi";
import type { TaskProjectOption, TaskView, TasksViewHandlers } from "./tasksViewModel";

export interface TaskRowProps {
  readonly task: TaskView;
  /** What the checkbox shows; differs from `task.done` while a toggle settles. */
  readonly checked: boolean;
  readonly project: TaskProjectOption | null;
  readonly projects: ReadonlyArray<TaskProjectOption>;
  readonly expanded: boolean;
  /** The row just appeared: it settles in from above. */
  readonly entering: boolean;
  readonly now: number;
  readonly handlers: TasksViewHandlers;
  /** Checks or unchecks the task; the page holds the row in place while it settles. */
  readonly onToggleDone: (taskId: string, done: boolean) => void;
}

/**
 * One task: the checkbox, the title, a hover-revealed "▶ Start" while it
 * has no chats, and the meta line; clicking anywhere on the line opens the
 * details beneath it. The title is a button laid over the whole line (the
 * checkbox, Start and, while open, the title field sit above it), so the
 * line is one keyboard stop with `aria-expanded` and no button nests in
 * another.
 */
export const TaskRow = memo(function TaskRow(props: TaskRowProps) {
  const { task, checked, expanded, handlers } = props;
  const detailsId = useId();
  const hitRef = useRef<HTMLButtonElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const focusInsideRef = useRef(false);
  const showStart = task.status === null && !task.done;

  // Opening a row warms the start path, so Start answers at once.
  useEffect(() => {
    if (expanded && !task.done) handlers.onPrepareStart(task.id);
  }, [expanded, handlers, task.done, task.id]);

  // Closing a row while focus is inside it hands focus back to its line:
  // the details are turning inert and the title field is going away, and
  // either would drop focus to the page.
  useLayoutEffect(() => {
    if (expanded || !focusInsideRef.current) return;
    const active = document.activeElement;
    const dropped =
      active === null ||
      active === document.body ||
      (detailsRef.current?.contains(active) ?? false);
    if (dropped) hitRef.current?.focus({ preventScroll: true });
  }, [expanded]);

  return (
    <div
      className="tsk-row rounded-[10px]"
      data-task-id={task.id}
      data-open={expanded ? "" : undefined}
      data-done={checked ? "" : undefined}
      data-enter={props.entering ? "" : undefined}
      onFocus={() => {
        focusInsideRef.current = true;
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          focusInsideRef.current = false;
        }
      }}
    >
      <div className="tsk-line relative flex min-h-[40px] cursor-pointer items-center gap-[12px] px-[10px] py-[9px]">
        <button
          type="button"
          className="tsk-box relative z-[1] grid size-[18px] shrink-0 cursor-pointer place-items-center rounded-full bg-transparent p-0"
          aria-label={`Done: ${task.title}`}
          aria-pressed={checked}
          onClick={() => props.onToggleDone(task.id, !checked)}
        >
          <CheckIcon className="size-[11px]" strokeWidth={3.2} aria-hidden />
        </button>
        <button
          ref={hitRef}
          type="button"
          className="tsk-hit absolute inset-0 cursor-pointer rounded-[10px] border-0 bg-transparent p-0"
          aria-label={task.title}
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => handlers.onToggleExpanded(task.id)}
        />
        {expanded ? (
          <span className="flex min-w-0 flex-1">
            <TaskTitleField
              taskId={task.id}
              title={task.title}
              onTitleChange={handlers.onTitleChange}
            />
          </span>
        ) : (
          <span
            aria-hidden
            className="tsk-title min-w-0 flex-1 truncate text-[14px] leading-[1.35]"
          >
            {task.title}
          </span>
        )}
        {showStart ? (
          <button
            type="button"
            className="tsk-go relative z-[1] inline-flex shrink-0 cursor-pointer items-center gap-[5px] rounded-[6px] border-0 bg-transparent px-[7px] py-[3px] text-[12px] text-muted-foreground"
            title={
              task.whereOptions[0]
                ? `Start a chat in ${task.whereOptions[0].hintPrefix}`
                : "Start a chat"
            }
            disabled={task.starting}
            onPointerEnter={() => handlers.onPrepareStart(task.id)}
            onFocus={() => handlers.onPrepareStart(task.id)}
            onClick={() => handlers.onStart(task.id)}
          >
            <PlayIcon className="size-3.5 shrink-0" aria-hidden />
            Start
          </button>
        ) : null}
        <TaskRowMeta task={task} project={props.project} now={props.now} />
      </div>
      <TaskDetails
        id={detailsId}
        ref={detailsRef}
        task={task}
        open={expanded}
        project={props.project}
        projects={props.projects}
        now={props.now}
        handlers={handlers}
      />
    </div>
  );
});

/**
 * The title while its row is open: an input that looks like the title.
 * Enter or leaving the field saves a changed, non-empty title; Escape puts
 * the saved one back (and stops there, so the row stays open). It sizes to
 * its text, so the rest of the line still opens and closes the row.
 */
function TaskTitleField(props: {
  readonly taskId: string;
  readonly title: string;
  readonly onTitleChange: (taskId: string, title: string) => void;
}) {
  const { taskId, title, onTitleChange } = props;
  const [value, setValue] = useState(title);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setValue(title);
  }, [title]);

  const commit = () => {
    const next = value.replace(/\s+/g, " ").trim();
    if (next.length === 0 || next === title) {
      setValue(title);
      return;
    }
    setValue(next);
    onTitleChange(taskId, next);
  };

  return (
    <input
      className="tsk-title relative z-[1] max-w-full min-w-[4ch] border-0 bg-transparent p-0 text-[14px] leading-[1.35] text-inherit outline-none field-sizing-content"
      value={value}
      maxLength={TASK_TITLE_MAX_LENGTH}
      aria-label="Title"
      spellCheck={false}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
        commit();
      }}
      onChange={(event) => setValue(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape" && value !== title) {
          // Only an edit is undone here; with nothing to undo, Escape closes the row.
          event.preventDefault();
          setValue(title);
        }
      }}
    />
  );
}
