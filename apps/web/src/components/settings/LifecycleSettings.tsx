import { LIFECYCLE_RETENTION_COPY } from "@ryco/client-runtime/state/lifecycle";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import { type EnvironmentId, type TrashedThreadSummary } from "@ryco/contracts";
import { ArchiveRestoreIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { readLifecycleApi } from "../../workspaceLifecycle";
import { useThreadActions } from "../../hooks/useThreadActions";
import { deleteChatFolderWithFeedback } from "../../lib/chatFolderActions";
import { selectEnvironmentState, useStore } from "../../store";
import { Checkbox } from "../ui/checkbox";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  LIFECYCLE_SUGGESTION_COPY,
  parseSuggestionDays,
  suggestionDayOptions,
  suggestionDaysValue,
  useLifecycleSuggestionPolicyEditor,
} from "./lifecycleSuggestionPolicy";
import { SettingsEmpty, SettingsNotice, SettingsRow, SettingsSection } from "./settingsLayout";
import { SettingsSelect } from "./SettingsSelect";
import { describeTrashedThreadPlace } from "./archivedSettings";

type TrashState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly threads: ReadonlyArray<TrashedThreadSummary>;
      readonly truncated: boolean;
    }
  | { readonly status: "error"; readonly message: string };

/**
 * Trash is recoverable: items keep their history, attachments and terminal history
 * and are never purged automatically. Permanent deletion is a separate, explicitly
 * confirmed step that only exists here.
 */
export function TrashSection(props: {
  readonly environmentId: EnvironmentId | null;
  readonly mutationAllowed: boolean;
  readonly mutationReason: string | null;
}) {
  const { environmentId } = props;
  const { untrashThread, deleteThreadPermanently } = useThreadActions();
  const [state, setState] = useState<TrashState>({ status: "loading" });
  const [pendingDelete, setPendingDelete] = useState<TrashedThreadSummary | null>(null);
  const [busyThreadId, setBusyThreadId] = useState<string | null>(null);
  // "Also delete the chat's folder": off by default, and re-armed per dialog.
  const [deleteChatFolder, setDeleteChatFolder] = useState(false);
  // Chats are listed as "No project", never under their folder's title, and only chats offer
  // their folder for deletion. The node says which rows are chats; the store knows the folder.
  const projectById = useStore((store) => selectEnvironmentState(store, environmentId).projectById);
  const placeOf = (thread: TrashedThreadSummary) =>
    describeTrashedThreadPlace(thread, environmentId ? projectById[thread.projectId] : null);
  const pendingDeleteChatFolder = pendingDelete ? placeOf(pendingDelete).chatFolder : null;
  const requestPermanentDelete = (thread: TrashedThreadSummary) => {
    setDeleteChatFolder(false);
    setPendingDelete(thread);
  };

  const available = readLifecycleApi(environmentId) !== undefined;
  const load = useCallback(async () => {
    const lifecycle = readLifecycleApi(environmentId);
    if (!lifecycle) return;
    try {
      const result = await lifecycle.listTrash({});
      setState({ status: "ready", threads: result.threads, truncated: result.truncated });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Trash could not be loaded.",
      });
    }
  }, [environmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (
    thread: TrashedThreadSummary,
    action: (ref: ReturnType<typeof scopeThreadRef>) => Promise<void>,
    failureTitle: string,
  ) => {
    if (!environmentId) return;
    setBusyThreadId(thread.threadId);
    try {
      await action(scopeThreadRef(environmentId, thread.threadId));
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: failureTitle,
          description: error instanceof Error ? error.message : "An error occurred.",
          actionProps: { children: "Retry", onClick: () => void run(thread, action, failureTitle) },
        }),
      );
    } finally {
      setBusyThreadId(null);
      await load();
    }
  };

  const view: TrashState = available
    ? state
    : { status: "error", message: "Trash is unavailable for this environment." };

  return (
    <SettingsSection
      title="Trash"
      owner="node"
      description={LIFECYCLE_RETENTION_COPY.trash}
      icon={<Trash2Icon className="size-4" />}
    >
      {view.status === "loading" ? (
        <SettingsEmpty title="Loading Trash…" className="py-6" />
      ) : view.status === "error" ? (
        <SettingsNotice
          tone="warning"
          title={view.message}
          action={
            <Button size="xs" variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      ) : view.threads.length === 0 ? (
        <SettingsEmpty
          icon={<Trash2Icon />}
          title="Trash is empty"
          description="Conversations you move to Trash appear here until you restore or permanently delete them."
          className="py-8"
        />
      ) : (
        <>
          {view.threads.map((thread) => (
            <div
              key={thread.threadId}
              data-testid={`trash-row-${thread.threadId}`}
              className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5"
            >
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-[13px] font-medium text-foreground">{thread.title}</h3>
                <p
                  className="mt-0.5 text-xs text-muted-foreground"
                  data-testid={`trash-row-place-${thread.threadId}`}
                >
                  {placeOf(thread).label}
                  {" · Moved to Trash "}
                  {formatRelativeTimeLabel(thread.trashedAt)}
                  {thread.archivedAt ? " · Restores to Archive" : ""}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0"
                disabled={
                  !props.mutationAllowed || !thread.projectAvailable || busyThreadId !== null
                }
                title={
                  !thread.projectAvailable
                    ? "Its project was removed. Add the project again to restore this conversation."
                    : (props.mutationReason ?? undefined)
                }
                onClick={() => void run(thread, untrashThread, "Failed to restore conversation")}
              >
                <ArchiveRestoreIcon className="size-3.5" />
                <span>Restore</span>
              </Button>
              <Button
                type="button"
                variant="destructive-outline"
                size="xs"
                className="shrink-0"
                disabled={!props.mutationAllowed || busyThreadId !== null}
                onClick={() => requestPermanentDelete(thread)}
              >
                <span>Delete permanently</span>
              </Button>
            </div>
          ))}
          {view.truncated ? (
            <p className="px-4 py-3 text-xs text-muted-foreground sm:px-5">
              Showing the 500 most recently trashed conversations.
            </p>
          ) : null}
        </>
      )}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{pendingDelete?.title}” permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              {LIFECYCLE_RETENTION_COPY.permanentDelete}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingDeleteChatFolder ? (
            <label
              data-testid="trash-delete-chat-folder"
              className="mx-6 mb-2 flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/70 bg-muted/30 px-3 py-2.5 text-sm"
            >
              <Checkbox
                className="mt-0.5"
                checked={deleteChatFolder}
                onCheckedChange={(checked) => setDeleteChatFolder(checked === true)}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-foreground">Also delete the chat's folder</span>
                <span className="break-all text-muted-foreground text-xs">
                  {pendingDeleteChatFolder}
                </span>
                <span className="text-muted-foreground text-xs">
                  Off by default: the files the agent wrote stay on disk unless you choose this.
                </span>
              </span>
            </label>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep in Trash</AlertDialogClose>
            <Button
              variant="destructive"
              data-testid="trash-delete-permanently"
              onClick={() => {
                const thread = pendingDelete;
                const chatFolder = deleteChatFolder ? pendingDeleteChatFolder : null;
                setPendingDelete(null);
                if (!thread) return;
                void run(
                  thread,
                  async (ref) => {
                    await deleteThreadPermanently(ref);
                    // Only after the conversation is gone; a folder failure is reported
                    // on its own and never undoes or retries the delete.
                    if (chatFolder && environmentId)
                      void deleteChatFolderWithFeedback({
                        environmentId,
                        projectId: thread.projectId,
                        folderPath: chatFolder,
                      });
                  },
                  "Failed to delete conversation",
                );
              }}
            >
              Delete permanently
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

/**
 * The device default for approval-only cleanup suggestions; "Off" disables one.
 * Each project can override it on its page, under Workspaces. Nothing is
 * archived or removed without a confirmed action.
 */
export function LifecycleSuggestionSettings(props: {
  readonly environmentId: EnvironmentId | null;
  readonly disabled: boolean;
}) {
  const editor = useLifecycleSuggestionPolicyEditor({
    environmentId: props.environmentId,
    projectId: null,
  });
  const busy = props.disabled || editor.saving || editor.policy === null;
  return (
    <SettingsSection
      title="Cleanup suggestions"
      owner="node"
      description="Suggestions appear on each project's page under Workspaces, where a project can also change these. They always need your approval: running work, background tasks, open terminals, pinned threads and unfinished goals are never suggested, and nothing is removed because a pull request merged."
    >
      {(["archiveInactiveThreadsDays", "removeArchivedCheckoutsDays"] as const).map((field) => {
        const copy = LIFECYCLE_SUGGESTION_COPY[field];
        const days = editor.policy?.[field] ?? null;
        return (
          <SettingsRow
            key={field}
            title={copy.title}
            description={copy.description}
            control={
              <SettingsSelect
                ariaLabel={copy.ariaLabel}
                width="sm"
                disabled={busy}
                value={suggestionDaysValue(days)}
                onValueChange={(value) => void editor.setField(field, parseSuggestionDays(value))}
                options={suggestionDayOptions(days)}
              />
            }
          />
        );
      })}
    </SettingsSection>
  );
}
