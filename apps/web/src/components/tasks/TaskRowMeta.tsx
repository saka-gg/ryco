import { taskLinkKey } from "@ryco/client-runtime/state/tasks";
import { PaperclipIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { ProjectFavicon } from "../ProjectFavicon";
import { TaskLinkIcon } from "./TaskLinkIcon";
import { TaskStatus } from "./TaskStatus";
import { dueLabel, isDueSoon } from "./taskDue.logic";
import { taskLinkLabelIn } from "./taskLinks.logic";
import type { TaskProjectOption, TaskView } from "./tasksViewModel";

/** A project's logo (its coloured initials without one), as the sidebar shows it. */
export function TaskProjectIcon(props: {
  readonly project: TaskProjectOption;
  readonly className?: string;
}) {
  const { project } = props;
  return (
    <ProjectFavicon
      environmentId={project.environmentId}
      cwd={project.cwd}
      projectId={project.projectId}
      customAvatarContentHash={project.avatarHash}
      fallbackName={project.name}
      className={cn("size-3.5 shrink-0", props.className)}
    />
  );
}

const META_ITEM_CLASS = "inline-flex items-center gap-[4px]";

/**
 * The quiet line at a row's end: chat status, every link (a linked chat by
 * its title), the file count, the due day (amber when close or overdue) and
 * the project. A done task drops its status and due day. The project name
 * gives way first when the column narrows.
 */
export function TaskRowMeta(props: {
  readonly task: TaskView;
  readonly project: TaskProjectOption | null;
  readonly now: number;
}) {
  const { task, project, now } = props;
  const due = task.dueAt !== null && !task.done ? dueLabel(task.dueAt, now) : null;
  return (
    <span className="flex items-center gap-[10px] whitespace-nowrap text-[12px] text-(--task-faint)">
      {task.status !== null && !task.done ? <TaskStatus status={task.status} /> : null}
      {task.links.map((link) => (
        <span key={taskLinkKey(link)} className={META_ITEM_CLASS}>
          <TaskLinkIcon kind={link.kind} className="size-3.5 shrink-0" />
          {taskLinkLabelIn(link, task.chats)}
        </span>
      ))}
      {task.files.length > 0 ? (
        <span className={META_ITEM_CLASS}>
          <PaperclipIcon className="size-3.5 shrink-0" aria-hidden />
          {task.files.length}
          <span className="sr-only">{task.files.length === 1 ? " file" : " files"}</span>
        </span>
      ) : null}
      {due !== null && task.dueAt !== null ? (
        <span
          className={cn(META_ITEM_CLASS, isDueSoon(task.dueAt, now) && "text-(--task-soon)")}
          data-task-due
        >
          {due}
        </span>
      ) : null}
      {project ? (
        <span className={cn(META_ITEM_CLASS, "@max-[560px]/tasks:hidden")}>
          <TaskProjectIcon project={project} className="size-3" />
          {project.name}
        </span>
      ) : null}
    </span>
  );
}
