import { hasTaskLink } from "@ryco/client-runtime/state/tasks";
import type { LocalTaskLink, ThreadId } from "@ryco/contracts";
import { LOCAL_TASK_MAX_LINKS } from "@ryco/contracts/local-tasks";
import {
  ChevronLeftIcon,
  CircleDotIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  LinkIcon,
  MessageSquareIcon,
} from "lucide-react";
import { type KeyboardEvent, useId, useMemo, useState } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { type TaskLinkInputKind, describeTaskLink, parseTaskLinkInput } from "./taskLinks.logic";
import {
  TASK_CHIP_CLASS,
  TASK_MENU_DETAIL_CLASS,
  TASK_MENU_POPUP_CLASS,
  TASK_POPOVER_INPUT_CLASS,
  TASK_POPOVER_ITEM_CLASS,
} from "./tasksUi";
import type { TaskChatOption, TaskView, TasksViewHandlers } from "./tasksViewModel";

type LinkStep =
  | { readonly kind: "pick" }
  | { readonly kind: "input"; readonly input: TaskLinkInputKind }
  | { readonly kind: "chat" };

const KINDS = [
  {
    id: "pr",
    Icon: GitPullRequestIcon,
    label: "Pull request",
    detail: "Paste a URL or #number",
    placeholder: "https://github.com/…/pull/42 or #42",
  },
  {
    id: "issue",
    Icon: CircleDotIcon,
    label: "Issue",
    detail: "GitHub issue or Jira key",
    placeholder: "#42, ABC-123 or a URL",
  },
  {
    id: "branch",
    Icon: GitBranchIcon,
    label: "Branch",
    detail: "Start chats on it",
    placeholder: "feature/login-loop",
  },
] as const;

const CHAT_KIND = {
  label: "Existing chat",
  detail: "Attach a chat you already had",
} as const;

/** Why the typed text adds nothing yet, in the field's own terms. */
const UNREAD_HINT: Readonly<Record<TaskLinkInputKind, string>> = {
  pr: "Not a pull request URL or number",
  issue: "Not an issue number, Jira key or URL",
  branch: "Not a valid branch name",
};

/**
 * The dashed "Link" chip and its two steps: what to link (pull request,
 * issue, branch, an existing chat), then a field that reads what was typed
 * or pasted, or a filterable list of the project's chats. Enter adds.
 */
export function TaskLinkPopover(props: {
  readonly task: TaskView;
  readonly handlers: Pick<TasksViewHandlers, "onAddLink" | "getChatOptions">;
}) {
  const { task, handlers } = props;
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<LinkStep>({ kind: "pick" });
  const full = task.links.length >= LOCAL_TASK_MAX_LINKS;

  const add = (link: LocalTaskLink) => {
    handlers.onAddLink(task.id, link);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // A fresh open starts at the first step; closing keeps the step so the exit doesn't swap content.
        if (next) setStep({ kind: "pick" });
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
        className={`${TASK_MENU_POPUP_CLASS} w-[280px]`}
        viewportClassName="p-1"
        aria-label="Link"
      >
        {step.kind === "pick" ? (
          <div className="flex flex-col">
            {KINDS.map((kind) => (
              <button
                key={kind.id}
                type="button"
                className={TASK_POPOVER_ITEM_CLASS}
                onClick={() => setStep({ kind: "input", input: kind.id })}
              >
                <kind.Icon className="mt-[2px] size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0">
                  <span className="block">{kind.label}</span>
                  <small className={TASK_MENU_DETAIL_CLASS}>{kind.detail}</small>
                </span>
              </button>
            ))}
            <button
              type="button"
              className={TASK_POPOVER_ITEM_CLASS}
              onClick={() => setStep({ kind: "chat" })}
            >
              <MessageSquareIcon className="mt-[2px] size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0">
                <span className="block">{CHAT_KIND.label}</span>
                <small className={TASK_MENU_DETAIL_CLASS}>{CHAT_KIND.detail}</small>
              </span>
            </button>
          </div>
        ) : step.kind === "input" ? (
          <LinkInputStep
            kind={step.input}
            links={task.links}
            onBack={() => setStep({ kind: "pick" })}
            onAdd={add}
          />
        ) : (
          <LinkChatStep
            task={task}
            getChatOptions={handlers.getChatOptions}
            onBack={() => setStep({ kind: "pick" })}
            onAdd={(threadId) => add({ kind: "thread", threadId })}
          />
        )}
      </PopoverPopup>
    </Popover>
  );
}

function StepHeader(props: { readonly label: string; readonly onBack: () => void }) {
  return (
    <div className="flex items-center gap-[4px] pb-[4px] text-[12px] text-muted-foreground">
      <button
        type="button"
        aria-label="Back"
        className="tsk-pop-item grid size-[22px] place-items-center rounded-[6px] border-0 bg-transparent text-muted-foreground"
        onClick={props.onBack}
      >
        <ChevronLeftIcon className="size-3.5" aria-hidden />
      </button>
      {props.label}
    </div>
  );
}

function LinkInputStep(props: {
  readonly kind: TaskLinkInputKind;
  readonly links: ReadonlyArray<LocalTaskLink>;
  readonly onBack: () => void;
  readonly onAdd: (link: LocalTaskLink) => void;
}) {
  const kind = KINDS.find((entry) => entry.id === props.kind) ?? KINDS[0];
  const [text, setText] = useState("");
  const link = parseTaskLinkInput(props.kind, text);
  const duplicate = link !== null && hasTaskLink(props.links, link);
  const hint =
    text.trim().length === 0
      ? kind.detail
      : link === null
        ? UNREAD_HINT[props.kind]
        : duplicate
          ? `${describeTaskLink(link)} is already linked`
          : `Adds ${describeTaskLink(link)}`;
  return (
    <div className="flex flex-col p-[4px]">
      <StepHeader label={kind.label} onBack={props.onBack} />
      <input
        autoFocus
        className={TASK_POPOVER_INPUT_CLASS}
        value={text}
        placeholder={kind.placeholder}
        aria-label={kind.label}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (link !== null && !duplicate) props.onAdd(link);
        }}
      />
      <p
        className="m-0 min-h-[18px] truncate px-[2px] pt-[5px] text-[11.5px] text-(--task-faint)"
        aria-live="polite"
      >
        {hint}
      </p>
    </div>
  );
}

function LinkChatStep(props: {
  readonly task: TaskView;
  readonly getChatOptions: (taskId: string) => ReadonlyArray<TaskChatOption>;
  readonly onBack: () => void;
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
    <div className="flex flex-col p-[4px]">
      <StepHeader label={CHAT_KIND.label} onBack={props.onBack} />
      <input
        autoFocus
        className={TASK_POPOVER_INPUT_CLASS}
        value={query}
        placeholder="Search chats"
        aria-label="Search chats"
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={activeOption ? `${listId}-${activeIndex}` : undefined}
        autoComplete="off"
        onChange={(event) => {
          setQuery(event.currentTarget.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      <div
        id={listId}
        role="listbox"
        aria-label="Chats"
        className="-mx-[4px] mt-[4px] max-h-[240px] overflow-y-auto"
      >
        {filtered.length === 0 ? (
          <p className="m-0 px-[8px] py-[7px] text-[12px] text-(--task-faint)">
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
