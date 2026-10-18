import {
  selectLocalTasksEnvironment,
  selectTaskView,
  useLocalTasksStore,
} from "@ryco/client-runtime/state/tasks";
import type { EnvironmentId } from "@ryco/contracts";
import { ListTodoIcon, PaperclipIcon, XIcon } from "lucide-react";

import { useComposerDraftStore, type DraftId } from "~/composerDraftStore";
import { cn } from "~/lib/utils";

import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useTaskFileUploadsStore } from "./taskFiles";
import { useLocalTasksSync } from "./useLocalTasks";

/**
 * The task a draft starts a chat for, above its prompt: the task's title and
 * the files its first message carries, and × to send the draft as a plain
 * chat instead. It keeps the node's tasks read while it shows, so the send
 * finds its task.
 */
export function ComposerTaskChip(props: {
  readonly environmentId: EnvironmentId;
  readonly draftId: DraftId;
  readonly taskId: string;
}) {
  const { environmentId, draftId, taskId } = props;
  useLocalTasksSync(environmentId, true);
  const task = useLocalTasksStore((state) => selectTaskView(state, environmentId, taskId));
  const read = useLocalTasksStore(
    (state) => selectLocalTasksEnvironment(state, environmentId).readAt !== null,
  );
  const uploading = useTaskFileUploadsStore((state) => state.byTask[taskId]?.length ?? 0);
  const files = (task?.files.length ?? 0) + uploading;
  const gone = read && !task;
  const unlink = () =>
    useComposerDraftStore.getState().setDraftThreadContext(draftId, { localTaskId: null });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={COMPOSER_INLINE_CHIP_CLASS_NAME} data-testid="composer-task-chip">
            <ListTodoIcon
              className={cn(COMPOSER_INLINE_CHIP_ICON_CLASS_NAME, gone && "text-destructive")}
              aria-hidden="true"
            />
            <span className="shrink-0 text-muted-foreground">Task</span>
            <span
              className={cn(
                COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
                "max-w-48",
                gone && "text-destructive",
              )}
            >
              {gone ? "Deleted" : (task?.title ?? "…")}
            </span>
            {files > 0 ? (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground">
                <PaperclipIcon className="size-3" aria-hidden="true" />
                {files}
                <span className="sr-only">{files === 1 ? " file" : " files"}</span>
              </span>
            ) : null}
            <button
              type="button"
              aria-label="Unlink from the task"
              className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
              onClick={unlink}
            >
              <XIcon className="size-3" aria-hidden="true" />
            </button>
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-72 leading-snug">
        {gone
          ? "The task was deleted. Unlink it to send this as a plain chat."
          : files > 0
            ? `Sending starts the task’s chat. Its ${files === 1 ? "file goes" : `${files} files go`} with the first message.`
            : "Sending starts the task’s chat; it shows on the task."}
      </TooltipPopup>
    </Tooltip>
  );
}
