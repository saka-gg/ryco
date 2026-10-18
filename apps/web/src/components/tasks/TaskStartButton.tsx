import { MessageSquareDashedIcon, PlayIcon, Trash2Icon } from "lucide-react";

import type { TaskView, TasksViewHandlers } from "./tasksViewModel";

/** What Start says: its unsent draft when it has one, else a first or another chat. */
export function taskStartLabel(task: Pick<TaskView, "hasDraft" | "chats">): string {
  if (task.hasDraft) return "Open draft";
  return task.chats.length > 0 ? "Another chat" : "Start chat";
}

/**
 * The open task's footer: Start, which opens the chat's draft prefilled with
 * the task (the model, modes and worktree are picked there), the hint naming
 * where that draft's worktree comes from, and Delete. Delete waits while a
 * chat's first message is on its way (deleting then would leave its chat
 * behind); pointing at Start warms the start path.
 */
export function TaskStartButton(props: {
  readonly task: TaskView;
  readonly handlers: Pick<TasksViewHandlers, "onStart" | "onDelete" | "onPrepareStart">;
}) {
  const { task, handlers } = props;
  const hint = task.startHint;
  const prepare = () => handlers.onPrepareStart(task.id);
  const StartIcon = task.hasDraft ? MessageSquareDashedIcon : PlayIcon;
  return (
    <div className="flex min-w-0 items-center gap-[8px]">
      <button
        type="button"
        className="tsk-start inline-flex h-[28px] shrink-0 items-center gap-[6px] rounded-[8px] border-0 bg-primary px-[11px] text-[12.5px] font-medium text-primary-foreground outline-none"
        onPointerEnter={prepare}
        onFocus={prepare}
        onClick={() => handlers.onStart(task.id)}
      >
        <StartIcon className="size-3.5 shrink-0" aria-hidden />
        {taskStartLabel(task)}
      </button>
      {task.hasDraft ? (
        <span className="min-w-0 truncate text-[12px] text-(--task-faint)">
          Not sent yet · pick up where you left off
        </span>
      ) : hint ? (
        <span className="min-w-0 truncate text-[12px] text-(--task-faint)">
          in {hint.prefix}
          {hint.ref !== null ? (
            <>
              {" · "}
              <b className="font-mono text-[11.5px] font-medium text-muted-foreground">
                {hint.ref}
              </b>
            </>
          ) : null}
        </span>
      ) : null}
      <button
        type="button"
        className="tsk-del ml-auto inline-flex shrink-0 items-center gap-[5px] rounded-[6px] border-0 bg-transparent px-[7px] py-[4px] text-[12px] text-(--task-faint) outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
        disabled={task.starting}
        title={task.starting ? "Wait for the chat to start" : undefined}
        onClick={() => handlers.onDelete(task.id)}
      >
        <Trash2Icon className="size-3.5 shrink-0" aria-hidden />
        Delete
      </button>
    </div>
  );
}
