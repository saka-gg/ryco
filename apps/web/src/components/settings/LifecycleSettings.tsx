import { LIFECYCLE_RETENTION_COPY } from "@ryco/client-runtime/state/lifecycle";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  type EnvironmentId,
  type LifecycleSuggestionPolicy,
  type ServerSettingsPatch,
  type TrashedThreadSummary,
} from "@ryco/contracts";
import { resolveLifecycleSuggestionPolicy } from "@ryco/shared/workspaceLifecycle";
import { ArchiveRestoreIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { readLifecycleApi } from "../../workspaceLifecycle";
import { updateEnvironmentServerSettings } from "../../environments/runtime";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useServerConfig } from "../../rpc/serverState";
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
  SettingResetButton,
  SettingsEmpty,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { SettingsSelect } from "./SettingsSelect";

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
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {thread.projectTitle ?? "Removed project"}
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
                onClick={() => setPendingDelete(thread)}
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
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep in Trash</AlertDialogClose>
            <Button
              variant="destructive"
              data-testid="trash-delete-permanently"
              onClick={() => {
                const thread = pendingDelete;
                setPendingDelete(null);
                if (thread)
                  void run(thread, deleteThreadPermanently, "Failed to delete conversation");
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

const DAY_OPTIONS = [7, 14, 30, 60, 90];

/**
 * Approval-only suggestions. A per-project override follows the same pattern as
 * storage retention; "Off" disables a suggestion. Nothing is archived or removed
 * without a confirmed action.
 */
export function LifecycleSuggestionSettings(props: {
  readonly environmentId: EnvironmentId | null;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly disabled: boolean;
}) {
  const config = useServerConfig();
  const settings = config?.settings;
  const [projectId, setProjectId] = useState("");
  const [saving, setSaving] = useState(false);
  const policy = settings ? resolveLifecycleSuggestionPolicy(settings, projectId || null) : null;
  const overridden = Boolean(projectId && settings?.projectLifecycleSuggestions[projectId]);

  const save = async (next: LifecycleSuggestionPolicy | null) => {
    if (!props.environmentId || (!projectId && !next)) return;
    setSaving(true);
    const patch: ServerSettingsPatch = projectId
      ? { projectLifecycleSuggestions: { [projectId]: next } }
      : { lifecycleSuggestions: next! };
    try {
      await updateEnvironmentServerSettings(props.environmentId, patch);
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not save suggestion settings",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    } finally {
      setSaving(false);
    }
  };
  const options = (current: number | null) => {
    const days =
      current !== null && !DAY_OPTIONS.includes(current) ? [...DAY_OPTIONS, current] : DAY_OPTIONS;
    return [
      { value: "off", label: "Off" },
      ...days
        .toSorted((a, b) => a - b)
        .map((value) => ({ value: String(value), label: `${value} days` })),
    ];
  };
  const busy = props.disabled || saving || policy === null;

  return (
    <SettingsSection
      title="Cleanup suggestions"
      owner="node"
      description="Suggestions appear on the Workspaces page and always need your approval. Running work, background tasks, open terminals, pinned threads and unfinished goals are never suggested, and nothing is removed because a pull request merged."
    >
      <SettingsRow
        title="Scope"
        status={
          projectId
            ? overridden
              ? "Project setting"
              : "Inherits the device setting"
            : "Device setting"
        }
        resetAction={
          overridden ? (
            <SettingResetButton
              label="project suggestion settings"
              tooltip="Use device setting"
              disabled={busy}
              onClick={() => void save(null)}
            />
          ) : null
        }
        control={
          <SettingsSelect
            ariaLabel="Suggestion settings scope"
            value={projectId || "device"}
            disabled={props.disabled}
            onValueChange={(value) => setProjectId(value === "device" ? "" : value)}
            options={[
              { value: "device", label: "All projects" },
              ...props.projects.map((project) => ({ value: project.id, label: project.name })),
            ]}
          />
        }
      />
      <SettingsRow
        title="Suggest archiving inactive conversations"
        description="After this many days without activity."
        control={
          <SettingsSelect
            ariaLabel="Inactive conversation suggestion"
            width="sm"
            disabled={busy}
            value={
              policy?.archiveInactiveThreadsDays == null
                ? "off"
                : String(policy.archiveInactiveThreadsDays)
            }
            onValueChange={(value) =>
              policy &&
              void save({
                ...policy,
                archiveInactiveThreadsDays: value === "off" ? null : Number(value),
              })
            }
            options={options(policy?.archiveInactiveThreadsDays ?? null)}
          />
        }
      />
      <SettingsRow
        title="Suggest removing finished checkouts"
        description="Once every conversation of a workspace has been archived this long. History and the branch are always kept."
        control={
          <SettingsSelect
            ariaLabel="Finished checkout suggestion"
            width="sm"
            disabled={busy}
            value={
              policy?.removeArchivedCheckoutsDays == null
                ? "off"
                : String(policy.removeArchivedCheckoutsDays)
            }
            onValueChange={(value) =>
              policy &&
              void save({
                ...policy,
                removeArchivedCheckoutsDays: value === "off" ? null : Number(value),
              })
            }
            options={options(policy?.removeArchivedCheckoutsDays ?? null)}
          />
        }
      />
    </SettingsSection>
  );
}
