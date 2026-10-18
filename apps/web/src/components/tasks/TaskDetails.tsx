import { type DragEvent, type Ref, useState } from "react";

import { TaskChatList } from "./TaskChatList";
import { TaskChips } from "./TaskChips";
import { TaskNotes } from "./TaskNotes";
import { TaskStartButton } from "./TaskStartButton";
import type { TaskProjectOption, TaskView, TasksViewHandlers } from "./tasksViewModel";

function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

/**
 * A row's details, opening in place: the grid row grows from 0fr to 1fr, so
 * the rows below make room as it opens, and nothing fades. The content
 * mounts on first open and stays, so closing animates the real content; a
 * closed row's details are inert. Files dropped anywhere on it are added.
 */
export function TaskDetails({
  ref,
  ...props
}: {
  readonly id: string;
  readonly ref?: Ref<HTMLDivElement>;
  readonly task: TaskView;
  readonly open: boolean;
  readonly project: TaskProjectOption | null;
  readonly projects: ReadonlyArray<TaskProjectOption>;
  readonly now: number;
  readonly handlers: TasksViewHandlers;
}) {
  const { task, open, handlers } = props;
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const [dropping, setDropping] = useState(false);

  return (
    <div
      id={props.id}
      ref={ref}
      className="tsk-more grid"
      inert={!open}
      aria-hidden={open ? undefined : true}
    >
      <div className="min-h-0 overflow-hidden">
        {mounted ? (
          <div
            className="tsk-inner flex flex-col gap-[10px] pt-0 pr-[12px] pb-[12px] pl-[40px]"
            data-drop={dropping ? "" : undefined}
            onDragOver={(event) => {
              if (!carriesFiles(event)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              if (!dropping) setDropping(true);
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setDropping(false);
            }}
            onDrop={(event) => {
              if (!carriesFiles(event)) return;
              event.preventDefault();
              setDropping(false);
              const files = Array.from(event.dataTransfer.files);
              if (files.length > 0) handlers.onAddFiles(task.id, files);
            }}
          >
            <TaskNotes
              taskId={task.id}
              notes={task.notes}
              open={open}
              onNotesChange={handlers.onNotesChange}
            />
            <TaskChips
              task={task}
              project={props.project}
              projects={props.projects}
              now={props.now}
              handlers={handlers}
            />
            {task.chats.length > 0 ? (
              <TaskChatList taskId={task.id} chats={task.chats} onOpenChat={handlers.onOpenChat} />
            ) : null}
            {task.done ? null : <TaskStartButton task={task} handlers={handlers} />}
          </div>
        ) : null}
      </div>
    </div>
  );
}
