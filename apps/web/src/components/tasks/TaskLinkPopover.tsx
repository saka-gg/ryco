import { hasTaskLink } from "@ryco/client-runtime/state/tasks";
import type { LocalTaskLink, ThreadId } from "@ryco/contracts";
import { LOCAL_TASK_MAX_LINKS } from "@ryco/contracts/local-tasks";
import { LinkIcon, MessageSquareIcon, SearchIcon } from "lucide-react";
import { type KeyboardEvent, useId, useMemo, useState } from "react";

import {
  preloadSourceItemTabs,
  SourcePickerPanel,
  useSourcePickerState,
  type NewThreadSource,
} from "../chat/SourcePickerPanel";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { describeTaskLink, parseTaskLinkPaste, taskLinkFromSource } from "./taskLinks.logic";
import { TASK_CHIP_CLASS, TASK_MENU_DETAIL_CLASS, TASK_POPOVER_ITEM_CLASS } from "./tasksUi";
import type {
  TaskChatOption,
  TaskProjectOption,
  TaskView,
  TasksViewHandlers,
} from "./tasksViewModel";

/**
 * The dashed "Link" chip: the picker a new worktree's source is picked from
 * (a branch, pull request, issue or Jira item of the task's project), plus
 * the project's chats and a field for any pasted link. Picking adds the link
 * and closes it; one the task has already is not added twice.
 */
export function TaskLinkPopover(props: {
  readonly task: TaskView;
  readonly project: TaskProjectOption | null;
  readonly handlers: Pick<TasksViewHandlers, "onAddLink" | "getChatOptions">;
}) {
  const { task, project, handlers } = props;
  const [open, setOpen] = useState(false);
  const pickerState = useSourcePickerState(project ? "branches" : "chats");
  const full = task.links.length >= LOCAL_TASK_MAX_LINKS;

  const add = (link: LocalTaskLink) => {
    setOpen(false);
    if (hasTaskLink(task.links, link)) {
      toastManager.add({ type: "info", title: `${describeTaskLink(link)} is already linked` });
      return;
    }
    handlers.onAddLink(task.id, link);
  };
  const pick = (source: NewThreadSource) => {
    const link = taskLinkFromSource(source);
    if (link) add(link);
    else toastManager.add({ type: "error", title: "That can’t be linked to a task" });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next && project) preloadSourceItemTabs();
        setOpen(next);
      }}
    >
      <PopoverTrigger
        className={TASK_CHIP_CLASS}
        data-ghost=""
        disabled={full}
        aria-disabled={full || undefined}
        title={full ? `A task holds up to ${LOCAL_TASK_MAX_LINKS} links` : undefined}
      >
        <LinkIcon className="size-3 shrink-0" aria-hidden />
        Link
      </PopoverTrigger>
      <PopoverPopup
        side="bottom"
        align="start"
        className="tsk-pop w-[30rem] overflow-hidden rounded-[10px] p-0"
        viewportClassName="p-0 [--viewport-inline-padding:0px]"
        aria-label="Link"
      >
        <SourcePickerPanel
          state={pickerState}
          repository={
            project
              ? {
                  environmentId: project.environmentId,
                  projectId: project.projectId,
                  cwd: project.cwd,
                }
              : null
          }
          onSelect={pick}
          extraTabs={[
            {
              id: "chats",
              label: "Chats",
              render: () => (
                <LinkChatList
                  task={task}
                  getChatOptions={handlers.getChatOptions}
                  onAdd={(threadId) => add({ kind: "thread", threadId })}
                />
              ),
            },
            {
              id: "url",
              label: "URL",
              render: () => <LinkPasteField links={task.links} onAdd={add} />,
            },
          ]}
        />
      </PopoverPopup>
    </Popover>
  );
}

/** The project's recent chats the task doesn't have yet, filterable; Enter links the highlighted one. */
function LinkChatList(props: {
  readonly task: TaskView;
  readonly getChatOptions: (taskId: string) => ReadonlyArray<TaskChatOption>;
  readonly onAdd: (threadId: ThreadId) => void;
}) {
  const { task, getChatOptions } = props;
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // Chats the task already has (started or linked) aren't offered again.
  const options = useMemo(() => {
    const taken = new Set<string>(task.chats.map((chat) => chat.threadId));
    for (const link of task.links) if (link.kind === "thread") taken.add(link.threadId);
    return getChatOptions(task.id).filter((option) => !taken.has(option.threadId));
  }, [getChatOptions, task.chats, task.id, task.links]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return options;
    return options.filter(
      (option) =>
        option.title.toLowerCase().includes(needle) ||
        option.subtitle.toLowerCase().includes(needle),
    );
  }, [options, query]);
  const activeIndex = Math.min(active, Math.max(filtered.length - 1, 0));
  const activeOption = filtered[activeIndex] ?? null;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (filtered.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + step + filtered.length) % filtered.length);
      return;
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (activeOption) props.onAdd(activeOption.threadId);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border/40 border-b px-2 py-1.5">
        <div className="relative">
          <SearchIcon className="-translate-y-1/2 absolute top-1/2 left-2 size-3.5 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            placeholder="Search chats..."
            aria-label="Search chats"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={activeOption ? `${listId}-${activeIndex}` : undefined}
            autoComplete="off"
            className="h-8 pl-7 text-sm"
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label="Chats"
        className="min-h-0 flex-1 overflow-y-auto p-1"
      >
        {filtered.length === 0 ? (
          <p className="m-0 px-[8px] py-[7px] text-sm text-muted-foreground">
            {options.length === 0 ? "No other chats in this project" : "No chats match"}
          </p>
        ) : (
          filtered.map((option, index) => (
            <div
              key={option.threadId}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={TASK_POPOVER_ITEM_CLASS}
              onPointerMove={() => {
                if (index !== activeIndex) setActive(index);
              }}
              onClick={() => props.onAdd(option.threadId)}
            >
              <MessageSquareIcon className="mt-[2px] size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0">
                <span className="block truncate">{option.title}</span>
                <small className={`${TASK_MENU_DETAIL_CLASS} truncate`}>{option.subtitle}</small>
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** A field for a pasted link: a pull request, issue or Jira URL (or key), or any web page. */
function LinkPasteField(props: {
  readonly links: ReadonlyArray<LocalTaskLink>;
  readonly onAdd: (link: LocalTaskLink) => void;
}) {
  const [text, setText] = useState("");
  const link = parseTaskLinkPaste(text);
  const duplicate = link !== null && hasTaskLink(props.links, link);
  const hint =
    text.trim().length === 0
      ? "A pull request, issue or Jira URL is linked as one; any other URL as a page."
      : link === null
        ? "Not a URL or a Jira key"
        : duplicate
          ? `${describeTaskLink(link)} is already linked`
          : `Enter links ${describeTaskLink(link)}`;
  return (
    <div className="flex flex-col gap-1.5 p-2">
      <div className="relative">
        <LinkIcon className="-translate-y-1/2 absolute top-1/2 left-2 size-3.5 text-muted-foreground" />
        <Input
          autoFocus
          value={text}
          placeholder="https://… or ABC-123"
          aria-label="Link URL"
          spellCheck={false}
          autoComplete="off"
          className="h-8 pl-7 text-sm"
          onChange={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (link !== null && !duplicate) props.onAdd(link);
          }}
        />
      </div>
      <p className="m-0 truncate px-[2px] text-xs text-muted-foreground" aria-live="polite">
        {hint}
      </p>
    </div>
  );
}
