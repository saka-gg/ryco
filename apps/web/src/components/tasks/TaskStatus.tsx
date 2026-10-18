import { cn } from "~/lib/utils";

import type { TaskStatusWord } from "./tasksViewModel";

/** What a task or chat's status reads as. */
export const TASK_STATUS_WORDS: Readonly<Record<TaskStatusWord, string>> = {
  starting: "Starting",
  running: "Working",
  "needs-you": "Needs you",
  review: "Ready to review",
  failed: "Failed to start",
  error: "Error",
  unavailable: "Chat deleted",
};

/**
 * A status dot and its word: a spinner while starting, a pulse while
 * working, amber when the chat waits on the user. `dotOnly` drops the word
 * (the chats list says it beside the model) and hides the dot from
 * assistive tech, which reads the word there instead.
 */
export function TaskStatus(props: {
  readonly status: TaskStatusWord;
  readonly dotOnly?: boolean;
  readonly className?: string;
}) {
  return (
    <span
      className={cn("tsk-st inline-flex items-center gap-[6px] text-[12px]", props.className)}
      data-status={props.status}
      aria-hidden={props.dotOnly ? true : undefined}
    >
      <span className="tsk-st-dot shrink-0" />
      {props.dotOnly ? null : TASK_STATUS_WORDS[props.status]}
    </span>
  );
}
