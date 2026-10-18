import type { ThreadId } from "@ryco/contracts";

import { TASK_STATUS_WORDS, TaskStatus } from "./TaskStatus";
import type { TaskChatView } from "./tasksViewModel";

/**
 * The chats a task started or links to, oldest first: status dot, model,
 * status, branch, and "Open chat →". A failed start says why on hover.
 */
export function TaskChatList(props: {
  readonly taskId: string;
  readonly chats: ReadonlyArray<TaskChatView>;
  readonly onOpenChat: (taskId: string, threadId: ThreadId) => void;
}) {
  const { taskId, chats, onOpenChat } = props;
  return (
    <div className="flex flex-col gap-[2px]">
      {chats.map((chat) => (
        <button
          key={chat.key}
          type="button"
          className="tsk-chat -mx-[8px] flex cursor-pointer items-center gap-[8px] rounded-[7px] border-0 bg-transparent px-[8px] py-[5px] text-left text-[12.5px] text-foreground outline-none"
          title={chat.error ?? undefined}
          onClick={() => onOpenChat(taskId, chat.threadId)}
        >
          <TaskStatus status={chat.status} dotOnly />
          <span className="shrink-0">{chat.modelLabel}</span>
          <span className="shrink-0 text-muted-foreground">
            · {TASK_STATUS_WORDS[chat.status]}
            {chat.linked ? " · linked" : ""}
          </span>
          {chat.branch ? (
            <span className="min-w-0 truncate font-mono text-[11.5px] text-(--task-faint)">
              {chat.branch}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 text-[12px] text-(--task-faint)">Open chat →</span>
        </button>
      ))}
    </div>
  );
}
