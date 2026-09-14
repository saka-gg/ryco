import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";

import type {
  SidebarThreadSummary,
  SidebarWorktreeSummary,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { SymbolView } from "../../components/AppSymbol";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { newCommandId, newWorktreeId } from "../../lib/ids";
import { useThemeColor } from "../../lib/useThemeColor";
import { useHomeWorkspaceData } from "../../state/homeData";
import { useStore } from "../../state/threadsRuntime";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import {
  buildProjectRenameCommand,
  buildWorktreeCreateCommand,
  buildWorktreeRenameCommand,
  dispatchWorkspaceCommand,
  pendingWorktreeFromCommand,
  reconcilePendingWorktree,
  runWorkspaceMutation,
  workspaceActionErrorMessage,
  type PendingWorktreeRow,
  type WorkspaceMutationReadiness,
} from "./projectActions";
import { buildProjectDetail } from "./projectsModel";
import { WorktreeEditorSheet } from "./WorktreeEditorSheet";
import { WorktreeRow } from "./WorktreeRow";

type Editor =
  | { readonly kind: "project"; readonly initialValue: string }
  | { readonly kind: "create-worktree"; readonly initialValue: string }
  | {
      readonly kind: "worktree";
      readonly worktree: SidebarWorktreeSummary;
      readonly initialValue: string;
    }
  | null;

function readinessFor(
  connectionState: "connected" | "reconnecting" | "offline" | "read-only" | undefined,
): WorkspaceMutationReadiness {
  if (connectionState === "connected") return "ready";
  return connectionState ?? "offline";
}

function ThreadRow(props: { readonly thread: SidebarThreadSummary; readonly onPress: () => void }) {
  const iconColor = useThemeColor("--color-icon-subtle");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open task ${props.thread.title}`}
      onPress={props.onPress}
      className="min-h-12 flex-row items-center gap-3 rounded-xl bg-subtle px-4 py-3 active:bg-subtle-strong"
    >
      <Text className="min-w-0 flex-1 text-sm font-ryco-medium text-foreground" numberOfLines={1}>
        {props.thread.title}
      </Text>
      <SymbolView
        name="chevron.right"
        size={14}
        tintColor={iconColor as string}
        type="monochrome"
      />
    </Pressable>
  );
}

export function ProjectDetailScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const navigation = useNavigation();
  const primaryForeground = useThemeColor("--color-primary-foreground");
  const { projects, worktrees, threads } = useHomeWorkspaceData();
  const environments = useHomeEnvironments();
  const detail = useMemo(
    () =>
      buildProjectDetail({
        environmentId: props.environmentId,
        projectId: props.projectId,
        projects,
        worktrees,
        threads,
        environments,
      }),
    [environments, projects, props.environmentId, props.projectId, threads, worktrees],
  );
  const [editor, setEditor] = useState<Editor>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [pendingWorktree, setPendingWorktree] = useState<PendingWorktreeRow | null>(null);
  const visiblePendingWorktree = useMemo(
    () => reconcilePendingWorktree(pendingWorktree, worktrees),
    [pendingWorktree, worktrees],
  );
  const readiness = readinessFor(detail?.environment?.connectionState);

  useEffect(() => {
    useStore.getState().setActiveEnvironmentId(props.environmentId);
  }, [props.environmentId]);

  useEffect(() => {
    if (!visiblePendingWorktree) return;
    const timeout = setTimeout(() => {
      setPendingWorktree(null);
      setActionError("The machine did not confirm the worktree. Check Machines, then try again.");
    }, 15_000);
    return () => clearTimeout(timeout);
  }, [visiblePendingWorktree]);

  useLayoutEffect(() => {
    navigation.setOptions({ title: detail?.project.name ?? "Project" });
  }, [detail?.project.name, navigation]);

  if (!detail) {
    return (
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1 bg-screen"
        contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 48 }}
      >
        <EmptyState
          variant="plain"
          title="Loading project"
          detail="Waiting for the node to publish this workspace."
        />
      </ScrollView>
    );
  }

  const dispatch = (command: Parameters<typeof dispatchWorkspaceCommand>[0]["command"]) =>
    dispatchWorkspaceCommand({
      readiness,
      command,
      dispatch: (nextCommand) =>
        ensureEnvironmentApi(props.environmentId).orchestration.dispatchCommand(nextCommand),
    });

  const submitEditor = async (value: string) => {
    if (!editor) return;
    setEditorError(null);
    setBusy(true);
    try {
      if (editor.kind === "project") {
        await dispatch(
          buildProjectRenameCommand({
            commandId: newCommandId(),
            projectId: props.projectId,
            title: value,
          }),
        );
      } else if (editor.kind === "create-worktree") {
        const optimisticWorktreeId = newWorktreeId();
        const command = buildWorktreeCreateCommand({
          commandId: newCommandId(),
          worktreeId: optimisticWorktreeId,
          projectId: props.projectId,
          branch: value,
          createdAt: new Date().toISOString(),
        });
        setPendingWorktree(pendingWorktreeFromCommand(props.environmentId, command));
        const result = await runWorkspaceMutation({
          readiness,
          mutation: async () => {
            const createWorktree = ensureEnvironmentApi(props.environmentId).git
              .createWorktreeForProject;
            if (!createWorktree) throw new Error("Worktree creation unavailable");
            return createWorktree({
              projectId: props.projectId,
              intent: { kind: "newBranch", branchName: command.branch },
            });
          },
        });
        setPendingWorktree((pending) =>
          pending ? { ...pending, worktreeId: result.worktreeId } : null,
        );
      } else {
        const changedAt = new Date().toISOString();
        await dispatch(
          buildWorktreeRenameCommand({
            commandId: newCommandId(),
            worktreeId: editor.worktree.id,
            title: value,
            changedAt,
          }),
        );
        useStore
          .getState()
          .setSidebarWorktreeTitle(
            props.environmentId,
            editor.worktree.id,
            value.trim(),
            changedAt,
          );
      }
      setEditor(null);
    } catch (error) {
      if (editor.kind === "create-worktree") setPendingWorktree(null);
      const action =
        editor.kind === "project"
          ? "rename-project"
          : editor.kind === "create-worktree"
            ? "create-worktree"
            : "rename-worktree";
      setEditorError(workspaceActionErrorMessage(action, error));
    } finally {
      setBusy(false);
    }
  };

  const archiveWorktree = (worktree: SidebarWorktreeSummary) => {
    Alert.alert(
      "Archive worktree?",
      `${worktree.title?.trim() || worktree.branch} will move to Archived. Its branch is kept.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Archive",
          style: "destructive",
          onPress: () => {
            setActionError(null);
            void runWorkspaceMutation({
              readiness,
              mutation: async () => {
                const archive = ensureEnvironmentApi(props.environmentId).git.archiveWorktree;
                if (!archive) throw new Error("Worktree archiving unavailable");
                await archive({ worktreeId: worktree.id, deleteBranch: false });
              },
            }).catch((error) =>
              setActionError(workspaceActionErrorMessage("archive-worktree", error)),
            );
          },
        },
      ],
    );
  };

  const restoreWorktree = (worktree: SidebarWorktreeSummary) => {
    setActionError(null);
    void runWorkspaceMutation({
      readiness,
      mutation: async () => {
        const restore = ensureEnvironmentApi(props.environmentId).git.restoreWorktree;
        if (!restore) throw new Error("Worktree restore unavailable");
        await restore({ worktreeId: worktree.id });
      },
    }).catch((error) => setActionError(workspaceActionErrorMessage("restore-worktree", error)));
  };

  const openThread = (thread: SidebarThreadSummary) => {
    navigation.navigate("Thread", {
      environmentId: props.environmentId,
      threadId: thread.id,
    });
  };

  const readOnly = readiness !== "ready";
  const editorTitle =
    editor?.kind === "project"
      ? "Rename project"
      : editor?.kind === "create-worktree"
        ? "Add worktree"
        : "Rename worktree";

  return (
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1 bg-screen"
        contentContainerStyle={{ padding: 16, gap: 20, paddingBottom: 48 }}
      >
        {actionError ? <ErrorBanner message={actionError} /> : null}
        {readOnly ? (
          <ErrorBanner message="This node is not ready for changes. Existing workspace data remains available." />
        ) : null}

        <View className="rounded-[22px] bg-card p-5">
          <View className="flex-row items-start gap-3">
            <View className="min-w-0 flex-1 gap-1">
              <View className="flex-row items-center gap-2">
                <ProjectFavicon
                  environmentId={detail.project.environmentId}
                  projectId={detail.project.id}
                  customAvatarContentHash={detail.project.customAvatarContentHash}
                  projectTitle={detail.project.name}
                  size={24}
                />
                <Text
                  className="min-w-0 flex-1 text-xl font-ryco-medium text-foreground"
                  numberOfLines={2}
                >
                  {detail.project.name}
                </Text>
              </View>
              <Text className="font-mono text-xs leading-normal text-foreground-muted">
                {detail.project.cwd}
              </Text>
              <Text className="mt-1 text-sm font-ryco-medium text-foreground-tertiary">
                {detail.environment?.label ?? "Node"} · Local workspace
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Rename project"
              disabled={readOnly}
              onPress={() => setEditor({ kind: "project", initialValue: detail.project.name })}
              className="h-11 items-center justify-center rounded-full bg-subtle px-4 active:bg-subtle-strong disabled:opacity-40"
            >
              <Text className="text-sm font-ryco-bold text-foreground">Rename</Text>
            </Pressable>
          </View>
        </View>

        <View className="flex-row gap-2">
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              navigation.navigate("NewTask", {
                environmentId: props.environmentId,
                projectId: props.projectId,
              })
            }
            className="h-12 flex-1 items-center justify-center rounded-full bg-card px-4 active:bg-card-alt"
          >
            <Text className="text-sm font-ryco-bold text-foreground">New task</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={readOnly || visiblePendingWorktree !== null}
            onPress={() => setEditor({ kind: "create-worktree", initialValue: "" })}
            className="h-12 flex-1 flex-row items-center justify-center gap-2 rounded-full bg-primary px-4 active:opacity-80 disabled:opacity-40"
          >
            <SymbolView
              name="plus"
              size={17}
              tintColor={primaryForeground as string}
              type="monochrome"
            />
            <Text className="text-sm font-ryco-bold text-primary-foreground">Add worktree</Text>
          </Pressable>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open project Source Control"
          onPress={() =>
            navigation.navigate("ProjectSourceControl", {
              environmentId: props.environmentId,
              projectId: props.projectId,
            })
          }
          className="h-12 items-center justify-center rounded-full bg-card px-4 active:bg-card-alt"
        >
          <Text className="text-sm font-ryco-bold text-foreground">Source Control</Text>
        </Pressable>

        <View className="gap-3">
          <Text className="px-1 text-sm font-ryco-bold text-foreground-muted">Worktrees</Text>
          {visiblePendingWorktree ? (
            <View className="rounded-2xl border border-border bg-card px-4 py-4">
              <Text className="text-base font-ryco-bold text-foreground">Creating worktree…</Text>
              <Text className="mt-1 font-mono text-xs text-foreground-muted">
                {visiblePendingWorktree.branch}
              </Text>
            </View>
          ) : null}
          {detail.activeWorktrees.map((group) => (
            <View key={group.worktree.id} className="gap-2">
              <WorktreeRow
                worktree={group.worktree}
                threadCount={group.threads.length}
                onNewTask={() =>
                  navigation.navigate("NewTask", {
                    environmentId: props.environmentId,
                    projectId: props.projectId,
                    worktreeId: group.worktree.id,
                  })
                }
                onRename={
                  readOnly
                    ? undefined
                    : () =>
                        setEditor({
                          kind: "worktree",
                          worktree: group.worktree,
                          initialValue: group.worktree.title?.trim() || group.worktree.branch,
                        })
                }
                onArchive={readOnly ? undefined : () => archiveWorktree(group.worktree)}
                onSourceControl={() =>
                  navigation.navigate("ProjectSourceControl", {
                    environmentId: props.environmentId,
                    projectId: props.projectId,
                    worktreeId: group.worktree.id,
                  })
                }
              />
              {group.threads.map((thread) => (
                <View key={thread.id} className="pl-4">
                  <ThreadRow thread={thread} onPress={() => openThread(thread)} />
                </View>
              ))}
            </View>
          ))}
          {detail.activeWorktrees.length === 0 && !visiblePendingWorktree ? (
            <EmptyState
              variant="card"
              title="No worktrees"
              detail="Use the local workspace, or add a branch worktree when you need isolation."
            />
          ) : null}
        </View>

        {detail.projectThreads.length > 0 ? (
          <View className="gap-2">
            <Text className="px-1 text-sm font-ryco-bold text-foreground-muted">
              Local workspace tasks
            </Text>
            {detail.projectThreads.map((thread) => (
              <ThreadRow key={thread.id} thread={thread} onPress={() => openThread(thread)} />
            ))}
          </View>
        ) : null}

        {detail.archivedWorktrees.length > 0 ? (
          <View className="gap-3">
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: showArchived }}
              onPress={() => setShowArchived((visible) => !visible)}
              className="h-11 flex-row items-center justify-between rounded-xl px-1 active:bg-subtle"
            >
              <Text className="text-sm font-ryco-bold text-foreground-muted">
                Archived ({detail.archivedWorktrees.length})
              </Text>
              <Text className="text-sm font-ryco-medium text-foreground-muted">
                {showArchived ? "Hide" : "Show"}
              </Text>
            </Pressable>
            {showArchived
              ? detail.archivedWorktrees.map((group) => (
                  <WorktreeRow
                    key={group.worktree.id}
                    worktree={group.worktree}
                    threadCount={group.threads.length}
                    onRestore={readOnly ? undefined : () => restoreWorktree(group.worktree)}
                  />
                ))
              : null}
          </View>
        ) : null}
      </ScrollView>

      <WorktreeEditorSheet
        visible={editor !== null}
        title={editorTitle}
        detail={
          editor?.kind === "create-worktree"
            ? "Enter a branch. The selected node prepares and owns the worktree path."
            : "Choose a short name that is easy to recognize on mobile."
        }
        label={editor?.kind === "create-worktree" ? "Branch" : "Title"}
        initialValue={editor?.initialValue}
        placeholder={editor?.kind === "create-worktree" ? "feat/mobile" : "Workspace name"}
        actionLabel={editor?.kind === "create-worktree" ? "Create worktree" : "Save"}
        busy={busy}
        error={editorError}
        onClose={() => {
          if (!busy) {
            setEditor(null);
            setEditorError(null);
          }
        }}
        onSubmit={(value) => void submitEditor(value)}
      />
    </>
  );
}
