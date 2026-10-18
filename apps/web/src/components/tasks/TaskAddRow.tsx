import type { ProjectId } from "@ryco/contracts";
import { CalendarIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { TaskProjectDot } from "./TaskRowMeta";
import { dueLabel } from "./taskDue.logic";
import { parseTaskQuickAdd, splitPastedTaskLines } from "./taskQuickAdd.logic";
import { TASK_CHIP_CLASS, TASK_CHIP_LABEL_CLASS, TASK_TITLE_MAX_LENGTH } from "./tasksUi";
import type { TaskProjectOption, TaskQuickAddInput, TasksViewHandlers } from "./tasksViewModel";

/**
 * The add row at the top of the list. Enter adds the task, ⌘/Ctrl+Enter adds
 * it and starts its chat; `#project` and `due:fri` (or `@fri`) are read as
 * typed and shown as chips. A pasted list adds one task per line. A task
 * that names no project joins the project the list is filtered to.
 */
export function TaskAddRow(props: {
  readonly projects: ReadonlyArray<TaskProjectOption>;
  readonly filterProjectId: ProjectId | null;
  readonly now: number;
  readonly onAdd: TasksViewHandlers["onAdd"];
}) {
  const { projects, filterProjectId, now, onAdd } = props;
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const parsed = useMemo(() => parseTaskQuickAdd(value, projects, now), [now, projects, value]);

  const toInput = (raw: string): TaskQuickAddInput | null => {
    const task = parseTaskQuickAdd(raw, projects, now);
    if (task.title.length === 0) return null;
    return {
      title: task.title.slice(0, TASK_TITLE_MAX_LENGTH),
      projectId: task.projectId ?? filterProjectId,
      dueAt: task.dueAt,
    };
  };

  return (
    <label className="tsk-add flex items-center gap-[12px] rounded-[10px] px-[10px] py-[9px] text-(--task-faint)">
      <span className="grid size-[18px] shrink-0 place-items-center">
        <PlusIcon className="size-3.5" aria-hidden />
      </span>
      <input
        className="tsk-add-input min-w-0 flex-1 border-0 bg-transparent px-[2px] py-px text-[14px] text-foreground outline-none"
        value={value}
        placeholder={focused ? "Add a task…   #project  due:fri" : "Add a task…"}
        aria-label="Add a task"
        autoComplete="off"
        spellCheck={false}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          const input = toInput(value);
          if (input === null) return;
          onAdd([input], { start: event.metaKey || event.ctrlKey });
          setValue("");
        }}
        onPaste={(event) => {
          const lines = splitPastedTaskLines(event.clipboardData.getData("text"));
          // A single line pastes into the field like any text.
          if (lines.length < 2) return;
          event.preventDefault();
          const inputs = lines.flatMap((line) => toInput(line) ?? []);
          if (inputs.length > 0) onAdd(inputs, { start: false });
        }}
      />
      {parsed.chips.length > 0 ? (
        <span className="flex shrink-0 gap-[4px]">
          {parsed.chips.map((chip) =>
            chip.kind === "project" ? (
              <span key="project" className={TASK_CHIP_CLASS}>
                <TaskProjectDot color={chip.project.color} />
                <span className={TASK_CHIP_LABEL_CLASS}>{chip.project.name}</span>
              </span>
            ) : (
              <span key="due" className={TASK_CHIP_CLASS}>
                <CalendarIcon className="size-3 shrink-0" aria-hidden />
                {dueLabel(chip.dueAt, now)}
              </span>
            ),
          )}
        </span>
      ) : null}
    </label>
  );
}
