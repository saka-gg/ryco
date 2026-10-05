import { WORKSPACE_LIFECYCLE_ACTION_LABELS } from "@ryco/client-runtime/state/lifecycle";
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  type EnvironmentId,
  type LifecycleSuggestions,
  ProjectId,
  ThreadId,
  type WorkspaceLifecycleAction,
  type WorkspaceLifecycleSummary,
} from "@ryco/contracts";
import { useRouter } from "@tanstack/react-router";
import { ArrowLeftIcon, FolderGit2Icon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { APP_DISPLAY_NAME } from "~/branding";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useThreadActions } from "../../hooks/useThreadActions";
import { selectProjectsForEnvironment, selectThreadsForEnvironment, useStore } from "../../store";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useUiStateStore } from "../../uiStateStore";
import { excludePinnedSuggestions } from "./workspacesPage.logic";
import {
  readLifecycleApi,
  runWorkspaceLifecycleAction,
  useWorkspaceLifecycleDialogStore,
} from "../../workspaceLifecycle";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  SettingsEmpty,
  SettingsNotice,
  SettingsPageContainer,
  SettingsSection,
} from "../settings/settingsLayout";
import { SettingsSelect } from "../settings/SettingsSelect";

export interface WorkspacesSearch {
  readonly environmentId?: string | undefined;
  readonly projectId?: string | undefined;
}

type Loadable<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: T }
  | { readonly status: "error"; readonly message: string };

const ACTION_ORDER: ReadonlyArray<WorkspaceLifecycleAction> = [
  "archive",
  "restore",
  "recreate-checkout",
  "remove-stale-record",
  "remove-checkout",
];

function checkoutLabel(workspace: WorkspaceLifecycleSummary): string {
  switch (workspace.checkout) {
    case "present":
      return workspace.main ? "Project root" : "Checkout present";
    case "missing":
      return "Checkout missing";
    case "removed":
      return "Checkout removed";
    case "unavailable":
      return "Not verifiable";
  }
}

/**
 * Workspace management: every action routes through the server lifecycle service,
 * and anything touching a checkout opens the shared exact-effects review.
 */
export function WorkspacesPage(props: {
  readonly search: WorkspacesSearch;
  readonly onSearchChange: (next: WorkspacesSearch) => void;
}) {
  const router = useRouter();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = (props.search.environmentId ??
    primaryEnvironmentId) as EnvironmentId | null;
  const projects = useStore(
    useShallow((state) =>
      environmentId ? selectProjectsForEnvironment(state, environmentId) : [],
    ),
  );
  const projectId = props.search.projectId ?? projects[0]?.id ?? null;
  const [workspaces, setWorkspaces] = useState<Loadable<ReadonlyArray<WorkspaceLifecycleSummary>>>({
    status: "loading",
  });
  const [suggestions, setSuggestions] = useState<Loadable<LifecycleSuggestions>>({
    status: "loading",
  });
  const { archiveThread } = useThreadActions();

  const lifecycle = readLifecycleApi(environmentId);

  // Inspection runs Git per workspace: load on demand (open, project change, explicit
  // refresh, or after any lifecycle action) rather than on every store change.
  const reload = useCallback(async () => {
    if (!lifecycle || !projectId) return;
    const [listed, suggested] = await Promise.allSettled([
      lifecycle.listWorkspaces({ projectId: ProjectId.make(projectId) }),
      lifecycle.suggestions({}),
    ]);
    setWorkspaces(
      listed.status === "fulfilled"
        ? { status: "ready", value: listed.value }
        : {
            status: "error",
            message:
              listed.reason instanceof Error
                ? listed.reason.message
                : "Workspaces could not be inspected.",
          },
    );
    setSuggestions(
      suggested.status === "fulfilled"
        ? { status: "ready", value: suggested.value }
        : {
            status: "error",
            message:
              suggested.reason instanceof Error
                ? suggested.reason.message
                : "Suggestions are unavailable.",
          },
    );
  }, [lifecycle, projectId]);

  const workspacesView: Loadable<ReadonlyArray<WorkspaceLifecycleSummary>> =
    !lifecycle || !projectId
      ? { status: "error", message: "Workspace management is unavailable here." }
      : workspaces;

  useEffect(() => {
    void reload();
    return useWorkspaceLifecycleDialogStore.subscribe((state, previous) => {
      if (state.revision !== previous.revision) void reload();
    });
  }, [reload]);

  // Pinning is client-side, so the server cannot exclude pinned threads itself.
  const pinnedThreadKeys = useUiStateStore((state) => state.pinnedThreadKeys);
  const environmentThreads = useStore(
    useShallow((state) => (environmentId ? selectThreadsForEnvironment(state, environmentId) : [])),
  );
  const visibleSuggestions = useMemo(() => {
    if (suggestions.status !== "ready" || !environmentId) return null;
    const isPinned = (threadId: string) =>
      Boolean(
        pinnedThreadKeys[scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(threadId)))],
      );
    const pinnedWorktreeIds = new Set(
      environmentThreads.flatMap((thread) =>
        isPinned(thread.id) && thread.worktreeId ? [thread.worktreeId] : [],
      ),
    );
    return excludePinnedSuggestions(suggestions.value, isPinned, pinnedWorktreeIds);
  }, [environmentId, environmentThreads, pinnedThreadKeys, suggestions]);

  const archiveSuggested = useCallback(
    async (threadId: string, title: string) => {
      if (!environmentId) return;
      try {
        await archiveThread(scopeThreadRef(environmentId, ThreadId.make(threadId)));
        await reload();
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Failed to archive "${title}"`,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [archiveThread, environmentId, reload],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              if (router.history.canGoBack()) {
                router.history.back();
                return;
              }
              void router.navigate({ to: "/" });
            }}
          >
            <ArrowLeftIcon className="size-3.5" />
            Back
          </Button>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {APP_DISPLAY_NAME} · Workspaces
          </span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setWorkspaces({ status: "loading" });
              void reload();
            }}
          >
            <RefreshCwIcon className="size-3.5" />
            Refresh
          </Button>
        </header>
        <ScrollArea className="min-h-0 flex-1">
          <SettingsPageContainer>
            {visibleSuggestions &&
            (visibleSuggestions.threads.length > 0 || visibleSuggestions.checkouts.length > 0) ? (
              <SettingsSection
                title="Suggestions"
                description="Nothing happens until you choose an action. Pinned threads, running or queued work, open terminals and unfinished goals are never suggested."
              >
                {visibleSuggestions.checkouts.map((checkout) => (
                  <div
                    key={checkout.worktreeId}
                    className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-3 first:border-t-0 sm:px-5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{checkout.title}</p>
                      <p className="text-xs text-muted-foreground">
                        All {checkout.conversations} conversation
                        {checkout.conversations === 1 ? "" : "s"} archived{" "}
                        {formatRelativeTimeLabel(checkout.archivedSince)} · checkout is clean and
                        merged
                      </p>
                    </div>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        environmentId &&
                        void runWorkspaceLifecycleAction({
                          environmentId,
                          worktreeId: checkout.worktreeId,
                          action: "remove-checkout",
                          title: checkout.title,
                        })
                      }
                    >
                      Remove checkout…
                    </Button>
                  </div>
                ))}
                {visibleSuggestions.threads.map((thread) => (
                  <div
                    key={thread.threadId}
                    className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-3 first:border-t-0 sm:px-5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{thread.title}</p>
                      <p className="text-xs text-muted-foreground">
                        Inactive since {formatRelativeTimeLabel(thread.lastActivityAt)}
                      </p>
                    </div>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => void archiveSuggested(thread.threadId, thread.title)}
                    >
                      Archive thread
                    </Button>
                  </div>
                ))}
              </SettingsSection>
            ) : null}

            <SettingsSection
              title="Workspaces"
              icon={<FolderGit2Icon className="size-4" />}
              description="Archiving hides a workspace. Removing a checkout deletes only the directory after safety checks; conversation history, attachments, terminal history and the branch are kept."
              headerAction={
                projects.length > 0 ? (
                  <SettingsSelect
                    ariaLabel="Project"
                    value={projectId ?? ""}
                    onValueChange={(value) =>
                      props.onSearchChange({ ...props.search, projectId: value })
                    }
                    options={projects.map((project) => ({
                      value: project.id,
                      label: project.name,
                    }))}
                  />
                ) : null
              }
            >
              {workspacesView.status === "loading" ? (
                <SettingsEmpty title="Inspecting workspaces…" className="py-8" />
              ) : workspacesView.status === "error" ? (
                <SettingsNotice
                  tone="warning"
                  title={workspacesView.message}
                  action={
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        setWorkspaces({ status: "loading" });
                        void reload();
                      }}
                    >
                      Retry
                    </Button>
                  }
                />
              ) : workspacesView.value.length === 0 ? (
                <SettingsEmpty title="No registered workspaces" className="py-8" />
              ) : (
                workspacesView.value.map((workspace) => (
                  <WorkspaceRow
                    key={workspace.worktreeId}
                    workspace={workspace}
                    onAction={(action) =>
                      environmentId &&
                      void runWorkspaceLifecycleAction({
                        environmentId,
                        worktreeId: workspace.worktreeId,
                        action,
                        title: workspace.title,
                      })
                    }
                  />
                ))
              )}
            </SettingsSection>
          </SettingsPageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function WorkspaceRow(props: {
  readonly workspace: WorkspaceLifecycleSummary;
  readonly onAction: (action: WorkspaceLifecycleAction) => void;
}) {
  const { workspace } = props;
  const available = ACTION_ORDER.flatMap((action) => {
    const availability = workspace.actions.find((entry) => entry.action === action);
    return availability?.available ? [action] : [];
  });
  const changes = workspace.changes;
  return (
    <div
      data-testid={`workspace-row-${workspace.worktreeId}`}
      className="flex flex-col gap-2 border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{workspace.title}</span>
        {workspace.main ? <Badge variant="outline">Main</Badge> : null}
        {workspace.archivedAt ? <Badge variant="outline">Archived</Badge> : null}
        <Badge variant="outline">{checkoutLabel(workspace)}</Badge>
      </div>
      <p className="truncate text-xs text-muted-foreground">
        {workspace.branch}
        {workspace.path ? ` · ${workspace.path}` : ""}
      </p>
      <p className="text-xs text-muted-foreground">
        {workspace.conversations.active} active · {workspace.conversations.archived} archived ·{" "}
        {workspace.conversations.trashed} in Trash
        {workspace.unmerged === true ? " · branch has unmerged commits" : ""}
        {changes && (changes.modified > 0 || changes.untracked > 0 || changes.protectedIgnored > 0)
          ? ` · ${changes.modified} modified, ${changes.untracked} untracked, ${changes.protectedIgnored} protected ignored`
          : ""}
      </p>
      {workspace.activeWork.length > 0 ? (
        <p className="text-xs text-warning-foreground">Active: {workspace.activeWork.join("; ")}</p>
      ) : null}
      {available.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {available.map((action) => (
            <Button
              key={action}
              size="xs"
              variant={
                action === "remove-checkout" || action === "remove-stale-record"
                  ? "destructive-outline"
                  : "outline"
              }
              onClick={() => props.onAction(action)}
            >
              {WORKSPACE_LIFECYCLE_ACTION_LABELS[action]}
              {action === "archive" || action === "restore" ? "" : "…"}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
