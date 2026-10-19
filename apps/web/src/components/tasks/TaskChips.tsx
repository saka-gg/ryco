import { taskLinkKey } from "@ryco/client-runtime/state/tasks";
import { XIcon } from "lucide-react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TaskDuePopover } from "./TaskDuePopover";
import { TaskFileAddChip, TaskFileChips } from "./TaskFileChips";
import { TaskLinkIcon } from "./TaskLinkIcon";
import { TaskLinkPopover } from "./TaskLinkPopover";
import { TaskProjectIcon } from "./TaskRowMeta";
import { describeTaskLink, taskLinkLabelIn } from "./taskLinks.logic";
import {
  TASK_CHIP_CLASS,
  TASK_CHIP_LABEL_CLASS,
  TASK_CHIP_REMOVE_CLASS,
  TASK_MENU_ITEM_CLASS,
  TASK_MENU_POPUP_CLASS,
} from "./tasksUi";
import type { TaskProjectOption, TaskView, TasksViewHandlers } from "./tasksViewModel";

/**
 * An open task's properties as one wrapping row of chips: project, due day,
 * its links and files, then the dashed "Link" and "File" chips that add more.
 */
export function TaskChips(props: {
  readonly task: TaskView;
  readonly project: TaskProjectOption | null;
  readonly projects: ReadonlyArray<TaskProjectOption>;
  readonly now: number;
  readonly handlers: TasksViewHandlers;
}) {
  const { task, project, projects, now, handlers } = props;
  return (
    <div className="flex flex-wrap items-center gap-[5px]">
      <TaskProjectChip
        task={task}
        project={project}
        projects={projects}
        onProjectChange={handlers.onProjectChange}
      />
      <TaskDuePopover
        taskId={task.id}
        dueAt={task.dueAt}
        now={now}
        onDueChange={handlers.onDueChange}
      />
      <TaskLinkChips task={task} handlers={handlers} />
      <TaskFileChips taskId={task.id} files={task.files} onRemoveFile={handlers.onRemoveFile} />
      <TaskLinkPopover task={task} project={project} handlers={handlers} />
      <TaskFileAddChip
        taskId={task.id}
        fileCount={task.files.length}
        onAddFiles={handlers.onAddFiles}
      />
    </div>
  );
}

function ProjectChipContent(props: { readonly project: TaskProjectOption | null }) {
  return props.project ? (
    <>
      <TaskProjectIcon project={props.project} />
      <span className={TASK_CHIP_LABEL_CLASS}>{props.project.name}</span>
    </>
  ) : (
    "No project"
  );
}

/** The project chip: a menu of projects, fixed (with a reason on hover) once the task has chats. */
function TaskProjectChip(props: {
  readonly task: TaskView;
  readonly project: TaskProjectOption | null;
  readonly projects: ReadonlyArray<TaskProjectOption>;
  readonly onProjectChange: TasksViewHandlers["onProjectChange"];
}) {
  const { task, project, projects } = props;
  if (task.projectLocked) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={TASK_CHIP_CLASS}
              aria-disabled="true"
              aria-label={project ? `Project: ${project.name}` : "No project"}
            >
              <ProjectChipContent project={project} />
            </button>
          }
        />
        <TooltipPopup side="top">The project is fixed once the task has chats</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        className={TASK_CHIP_CLASS}
        disabled={projects.length === 0}
        aria-label={project ? `Project: ${project.name}` : "No project"}
      >
        <ProjectChipContent project={project} />
      </MenuTrigger>
      <MenuPopup align="start" className={TASK_MENU_POPUP_CLASS}>
        {projects.map((option) => (
          <MenuItem
            key={option.projectId}
            className={TASK_MENU_ITEM_CLASS}
            onClick={() => props.onProjectChange(task.id, option.projectId)}
          >
            <TaskProjectIcon project={option} className="mt-px size-4" />
            <span className="min-w-0 truncate">{option.name}</span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

/**
 * Each link as a chip, a pull request, issue or Jira item with the title it
 * was linked with and a linked chat by its title (which follows the chat);
 * hovering shows the × that unlinks it.
 */
function TaskLinkChips(props: {
  readonly task: TaskView;
  readonly handlers: Pick<TasksViewHandlers, "onRemoveLink">;
}) {
  const { task, handlers } = props;
  return task.links.map((link, index) => (
    <span
      key={taskLinkKey(link)}
      className={TASK_CHIP_CLASS}
      data-removable=""
      title={"title" in link ? link.title : undefined}
    >
      <TaskLinkIcon kind={link.kind} className="size-3 shrink-0" />
      <span className={TASK_CHIP_LABEL_CLASS}>
        {taskLinkLabelIn(link, task.chats)}
        {"title" in link && link.title ? (
          <span className="text-(--task-faint)"> {link.title}</span>
        ) : null}
      </span>
      <button
        type="button"
        className={TASK_CHIP_REMOVE_CLASS}
        aria-label={`Unlink ${describeTaskLink(link)}`}
        onClick={() => handlers.onRemoveLink(task.id, index)}
      >
        <XIcon className="size-3" aria-hidden />
      </button>
    </span>
  ));
}
