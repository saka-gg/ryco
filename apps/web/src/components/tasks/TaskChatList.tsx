import type { ThreadId } from "@ryco/contracts";
import { ArrowUpRightIcon, GitBranchIcon, LinkIcon, MessageSquareIcon } from "lucide-react";

import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { TASK_STATUS_WORDS, TaskStatus } from "./TaskStatus";
import type { TaskChatView } from "./tasksViewModel";

/**
 * The chats a task started or links to, oldest first: the provider's icon
 * and model, the status, the branch, and "Open". A chat that was deleted is
 * not listed. A failed start says why on hover.
 */
export function TaskChatList(props: {
  readonly taskId: string;
  readonly chats: ReadonlyArray<TaskChatView>;
  readonly onOpenChat: (taskId: string, threadId: ThreadId) => void;
}) {
  const { taskId, chats, onOpenChat } = props;
  return (
    <div className="flex flex-col gap-[2px]">
      {chats.map((chat) => {
        const ProviderIcon = chat.providerDriver
          ? (PROVIDER_ICON_BY_PROVIDER[chat.providerDriver] ?? MessageSquareIcon)
          : MessageSquareIcon;
        return (
          <button
            key={chat.key}
            type="button"
            className="tsk-chat -mx-[8px] flex cursor-pointer items-center gap-[8px] rounded-[7px] border-0 bg-transparent px-[8px] py-[5px] text-left text-[12.5px] text-foreground outline-none"
            title={chat.error ?? chat.title ?? undefined}
            onClick={() => onOpenChat(taskId, chat.threadId)}
          >
            <ProviderIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="shrink-0">{chat.modelLabel}</span>
            <TaskStatus status={chat.status} dotOnly className="ml-[2px]" />
            <span className="shrink-0 text-muted-foreground">{TASK_STATUS_WORDS[chat.status]}</span>
            {chat.linked ? (
              <span className="inline-flex shrink-0 items-center gap-[3px] text-(--task-faint)">
                <LinkIcon className="size-3" aria-hidden />
                linked
              </span>
            ) : null}
            {chat.branch ? (
              <span className="inline-flex min-w-0 items-center gap-[3px] text-(--task-faint)">
                <GitBranchIcon className="size-3 shrink-0" aria-hidden />
                <span className="min-w-0 truncate font-mono text-[11.5px]">{chat.branch}</span>
              </span>
            ) : null}
            <span className="tsk-chat-open ml-auto inline-flex shrink-0 items-center gap-[2px] text-[12px] text-(--task-faint)">
              Open
              <ArrowUpRightIcon className="size-3" aria-hidden />
            </span>
          </button>
        );
      })}
    </div>
  );
}
