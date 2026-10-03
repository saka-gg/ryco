import { PencilIcon } from "lucide-react";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  fetchSourceControlChangeRequestDetail,
  useUpdateChangeRequestMutation,
  writeChangeRequestDetail,
  type ChangeRequestMutationTarget,
} from "../../../rpc/useSourceControl";
import { MarkdownView } from "../../projectExplorer/MarkdownView";
import { usePullRequestSelection, usePullRequestsPage } from "../PullRequestsPageContext";
import {
  createDescriptionTaskQueue,
  type DescriptionTaskHost,
  type DescriptionTaskState,
} from "./descriptionTaskQueue";
import { errorText, MarkdownEditor } from "./MarkdownEditor";
import { applyTaskToggles } from "./markdownTasks";

/** Prose in Conversation: 14px/1.6, at most 68ch per line. */
export const PROSE_CLASS = "pr-prose max-w-[68ch] text-[14px] leading-[1.6]";

/** One queue per page load, keyed by pull request, so remounts share it. */
const descriptionTasks = createDescriptionTaskQueue((error) =>
  errorText(error, "Could not update the task."),
);

function taskQueueKey(target: ChangeRequestMutationTarget): string | null {
  if (!target.environmentId || !target.cwd || !target.reference) return null;
  return JSON.stringify([target.environmentId, target.cwd, target.reference]);
}

const NO_TASKS: DescriptionTaskState = { pending: [], error: null };
const subscribeNowhere = () => () => {};

function useDescriptionTasks(key: string | null): DescriptionTaskState {
  const subscribe = useCallback(
    (listener: () => void) =>
      key === null ? subscribeNowhere() : descriptionTasks.subscribe(key, listener),
    [key],
  );
  const snapshot = useCallback(
    () => (key === null ? NO_TASKS : descriptionTasks.snapshot(key)),
    [key],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * The pull request body, with no header of its own (the masthead already
 * names the author and date). Hovering offers ✎ to edit it in place. Task
 * checkboxes toggle immediately: the click shows at once, and the save
 * re-reads the body from the host and rewrites only that box, so an edit made
 * elsewhere since the last poll is never overwritten (see `descriptionTaskQueue`).
 */
export function DescriptionBlock() {
  const { model } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  const detail = selection.detail.data;
  const canUpdate =
    model.capabilities.lifecycle.has("edit") &&
    (selection.activity.data?.viewer?.canUpdate ?? false);
  const target = selection.mutationTarget;
  const update = useUpdateChangeRequestMutation(target);
  const [editing, setEditing] = useState(false);
  const savedBody = detail?.body ?? "";
  const mutateAsync = update.mutateAsync;

  const queueKey = taskQueueKey(target);
  const tasks = useDescriptionTasks(queueKey);
  // Unsaved toggles show over the cached body; offsets are stable across toggles.
  const body = useMemo(
    () => applyTaskToggles(savedBody, tasks.pending).body,
    [savedBody, tasks.pending],
  );

  // Read at click time, so the handler (and the parsed Markdown) stays stable.
  const latestRef = useRef({ savedBody, target, mutateAsync });
  useLayoutEffect(() => {
    latestRef.current = { savedBody, target, mutateAsync };
  });

  const toggleTask = useCallback(
    (offset: number, checked: boolean) => {
      if (queueKey === null) return;
      const { savedBody: base, target: clickedTarget, mutateAsync: save } = latestRef.current;
      const host: DescriptionTaskHost = {
        readFresh: async () => {
          const fresh = await fetchSourceControlChangeRequestDetail({
            environmentId: clickedTarget.environmentId,
            cwd: clickedTarget.cwd,
            reference: clickedTarget.reference ?? "",
            fullContent: true,
            fresh: true,
          });
          // Show what the host has, so a conflicting edit is visible at once.
          if (fresh.body !== latestRef.current.savedBody) {
            writeChangeRequestDetail(clickedTarget, fresh);
          }
          return fresh.body;
        },
        save: async (next) => {
          await save({ kind: "edit", body: next });
        },
      };
      descriptionTasks.toggle(queueKey, { base, offset, checked }, host);
    },
    [queueKey],
  );

  if (!detail) return null;

  if (editing) {
    return (
      <MarkdownEditor
        initialValue={savedBody}
        label="Pull request description"
        placeholder="Describe the change"
        allowEmpty
        onCancel={() => setEditing(false)}
        onSubmit={async (next) => {
          await mutateAsync({ kind: "edit", body: next });
          setEditing(false);
        }}
      />
    );
  }

  return (
    <section aria-label="Description" className="group/description relative max-w-[68ch]">
      <MarkdownView
        text={body}
        className={PROSE_CLASS}
        onToggleTask={canUpdate && queueKey !== null ? toggleTask : undefined}
      />
      {tasks.error ? (
        <p className="mt-2 text-xs text-destructive" role="status">
          {tasks.error}
        </p>
      ) : null}
      {canUpdate ? (
        <button
          type="button"
          aria-label="Edit description"
          title="Edit description"
          onClick={() => setEditing(true)}
          className="absolute top-0 -right-8 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-hidden transition-[opacity,background-color,color] duration-(--app-motion-duration-chip) group-hover/description:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:opacity-100"
        >
          <PencilIcon className="size-3.5" />
        </button>
      ) : null}
    </section>
  );
}
