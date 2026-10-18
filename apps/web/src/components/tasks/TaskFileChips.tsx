import { LOCAL_TASK_MAX_FILES } from "@ryco/contracts/local-tasks";
import { PaperclipIcon, XIcon } from "lucide-react";
import { type CSSProperties, useRef } from "react";

import { cn } from "~/lib/utils";

import { TASK_CHIP_CLASS, TASK_CHIP_LABEL_CLASS, TASK_CHIP_REMOVE_CLASS } from "./tasksUi";
import type { TaskFileView } from "./tasksViewModel";

/**
 * A task's files as chips. One still uploading fills from the left as it
 * goes; one that failed reads red and says why on hover. Hovering shows the
 * × that removes it (and cancels an upload).
 */
export function TaskFileChips(props: {
  readonly taskId: string;
  readonly files: ReadonlyArray<TaskFileView>;
  readonly onRemoveFile: (taskId: string, fileKey: string) => void;
}) {
  const { taskId, files, onRemoveFile } = props;
  return files.map((file) => {
    const uploading = file.progress !== null && file.error === null;
    return (
      <span
        key={file.key}
        className={TASK_CHIP_CLASS}
        data-removable=""
        data-uploading={uploading ? "" : undefined}
        data-error={file.error !== null ? "" : undefined}
        aria-busy={uploading || undefined}
        title={file.error ?? file.name}
        style={
          uploading
            ? ({ "--tsk-progress": Math.min(Math.max(file.progress ?? 0, 0), 1) } as CSSProperties)
            : undefined
        }
      >
        <PaperclipIcon className="relative size-3 shrink-0" aria-hidden />
        <span className={cn(TASK_CHIP_LABEL_CLASS, "relative")}>{file.name}</span>
        <button
          type="button"
          className={TASK_CHIP_REMOVE_CLASS}
          aria-label={`Remove ${file.name}`}
          onClick={() => onRemoveFile(taskId, file.key)}
        >
          <XIcon className="size-3" aria-hidden />
        </button>
      </span>
    );
  });
}

/**
 * The dashed "File" chip: opens the file picker (several files at once).
 * Full once the task holds as many files as a chat message can carry.
 */
export function TaskFileAddChip(props: {
  readonly taskId: string;
  readonly fileCount: number;
  readonly onAddFiles: (taskId: string, files: ReadonlyArray<File>) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const full = props.fileCount >= LOCAL_TASK_MAX_FILES;
  return (
    <>
      <button
        type="button"
        className={TASK_CHIP_CLASS}
        data-ghost=""
        disabled={full}
        aria-disabled={full || undefined}
        title={full ? `A task holds up to ${LOCAL_TASK_MAX_FILES} files` : undefined}
        onClick={() => inputRef.current?.click()}
      >
        <PaperclipIcon className="size-3 shrink-0" aria-hidden />
        File
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        data-task-file-input
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          // Clear it so picking the same file again still reports a change.
          event.currentTarget.value = "";
          if (files.length > 0) props.onAddFiles(props.taskId, files);
        }}
      />
    </>
  );
}
