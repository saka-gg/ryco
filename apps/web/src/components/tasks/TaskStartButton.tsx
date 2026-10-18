import {
  ChevronDownIcon,
  GitBranchIcon,
  GitForkIcon,
  GitPullRequestIcon,
  LaptopIcon,
  PlayIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { TASK_MENU_DETAIL_CLASS, TASK_MENU_ITEM_CLASS, TASK_MENU_POPUP_CLASS } from "./tasksUi";
import type { TaskView, TaskWhereKind, TasksViewHandlers } from "./tasksViewModel";

const SPLIT_BUTTON_CLASS =
  "inline-flex h-[28px] items-center gap-[6px] border-0 bg-primary text-[12.5px] font-medium text-primary-foreground outline-none disabled:cursor-default disabled:opacity-60";

function WhereIcon(props: { readonly kind: TaskWhereKind }) {
  const className = "size-3.5 shrink-0";
  switch (props.kind) {
    case "pr":
      return <GitPullRequestIcon className={className} aria-hidden />;
    case "branch":
      return <GitBranchIcon className={className} aria-hidden />;
    case "worktree":
      return <GitForkIcon className={className} aria-hidden />;
    case "project":
      return <LaptopIcon className={className} aria-hidden />;
  }
}

/**
 * The open task's footer: "▶ Start chat" (or "Another chat" once it has
 * one) in the default place, ▾ for the other places, the hint naming where
 * the default goes, and a quiet Delete. Start and Delete wait while a start
 * is in flight (deleting then would leave its worktree and chat behind);
 * pointing at Start warms the start path.
 */
export function TaskStartButton(props: {
  readonly task: TaskView;
  readonly handlers: Pick<TasksViewHandlers, "onStart" | "onDelete" | "onPrepareStart">;
}) {
  const { task, handlers } = props;
  const fallback = task.whereOptions[0] ?? null;
  const prepare = () => handlers.onPrepareStart(task.id);
  return (
    <div className="flex min-w-0 items-center gap-[8px]">
      <span
        className="tsk-split inline-flex shrink-0 overflow-hidden rounded-[8px]"
        onPointerEnter={prepare}
      >
        <button
          type="button"
          className={cn(SPLIT_BUTTON_CLASS, "px-[11px]")}
          disabled={task.starting}
          onFocus={prepare}
          onClick={() => handlers.onStart(task.id)}
        >
          <PlayIcon className="size-3.5 shrink-0" aria-hidden />
          {task.chats.length > 0 ? "Another chat" : "Start chat"}
        </button>
        <Menu>
          <MenuTrigger
            className={cn(
              SPLIT_BUTTON_CLASS,
              "border-l border-l-[color:color-mix(in_srgb,var(--primary-foreground)_18%,transparent)] px-[7px]",
            )}
            aria-label="Where"
            disabled={task.starting || task.whereOptions.length === 0}
          >
            <ChevronDownIcon className="size-3.5 shrink-0" aria-hidden />
          </MenuTrigger>
          <MenuPopup align="start" className={TASK_MENU_POPUP_CLASS}>
            {task.whereOptions.map((option) => (
              <MenuItem
                key={option.id}
                className={TASK_MENU_ITEM_CLASS}
                onClick={() => handlers.onStart(task.id, option.id)}
              >
                <WhereIcon kind={option.kind} />
                <span className="min-w-0">
                  <span className="block">{option.label}</span>
                  <small className={TASK_MENU_DETAIL_CLASS}>{option.detail}</small>
                </span>
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      </span>
      {fallback ? (
        <span className="min-w-0 truncate text-[12px] text-(--task-faint)">
          in {fallback.hintPrefix}
          {fallback.hintRef !== null ? (
            <>
              {" · "}
              <b className="font-mono text-[11.5px] font-medium text-muted-foreground">
                {fallback.hintRef}
              </b>
            </>
          ) : null}
        </span>
      ) : null}
      <button
        type="button"
        className="tsk-del ml-auto shrink-0 rounded-[6px] border-0 bg-transparent px-[6px] py-[4px] text-[12px] text-(--task-faint) outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
        disabled={task.starting}
        onClick={() => handlers.onDelete(task.id)}
      >
        Delete
      </button>
    </div>
  );
}
