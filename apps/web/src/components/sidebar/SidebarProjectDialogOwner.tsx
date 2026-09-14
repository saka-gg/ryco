import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { SidebarProjectGroupingMode, ScopedThreadRef } from "@ryco/contracts";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import type { useUpdateSettings } from "~/hooks/useSettings";
import {
  ProjectExplorerDialog,
  type ProjectExplorerTabId,
} from "../projectExplorer/ProjectExplorerDialog";
import { NewWorktreeDialog, type NewWorktreeDialogTab } from "../worktrees/NewWorktreeDialog";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";
import { SidebarProjectGroupingDialog } from "./SidebarProjectGroupingDialog";
import { SidebarProjectRenameDialog } from "./SidebarProjectRenameDialog";
import { useSidebarProjectGroupingDialog } from "./hooks/useSidebarProjectGroupingDialog";
import { useSidebarProjectRenameDialog } from "./hooks/useSidebarProjectRenameDialog";
import { useSidebarProjectSettingsDialog } from "./hooks/useSidebarProjectSettingsDialog";

interface SidebarProjectDialogActions {
  readonly openExplorer: (
    project: SidebarProjectSnapshot,
    initialTab: ProjectExplorerTabId,
  ) => void;
  readonly openNewWorktree: (
    project: SidebarProjectSnapshot,
    initialTab: NewWorktreeDialogTab,
  ) => void;
  readonly openSettings: (member: SidebarProjectGroupMember) => void;
  readonly openRename: (member: SidebarProjectGroupMember) => void;
  readonly openGrouping: (member: SidebarProjectGroupMember) => void;
}

const SidebarProjectDialogContext = createContext<SidebarProjectDialogActions | null>(null);

export function useSidebarProjectDialogs(): SidebarProjectDialogActions {
  const actions = useContext(SidebarProjectDialogContext);
  if (!actions) throw new Error("useSidebarProjectDialogs requires SidebarProjectDialogProvider");
  return actions;
}

export function SidebarProjectDialogProvider(props: {
  readonly children: React.ReactNode;
  readonly projectGroupingSettings: {
    readonly sidebarProjectGroupingMode: SidebarProjectGroupingMode;
    readonly sidebarProjectGroupingOverrides:
      | Record<string, SidebarProjectGroupingMode>
      | undefined;
  };
  readonly updateSettings: ReturnType<typeof useUpdateSettings>["updateSettings"];
  readonly navigateToThread: (threadRef: ScopedThreadRef) => void;
}) {
  const [newWorktreeTarget, setNewWorktreeTarget] = useState<{
    readonly project: SidebarProjectSnapshot;
    readonly initialTab: NewWorktreeDialogTab;
  } | null>(null);
  const [newWorktreeOpen, setNewWorktreeOpen] = useState(false);
  const [explorerTarget, setExplorerTarget] = useState<{
    readonly project: SidebarProjectSnapshot;
    readonly initialTab: ProjectExplorerTabId;
  } | null>(null);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const settingsDialog = useSidebarProjectSettingsDialog();
  const renameDialog = useSidebarProjectRenameDialog();
  const groupingDialog = useSidebarProjectGroupingDialog({
    projectGroupingSettings: props.projectGroupingSettings,
    updateSettings: props.updateSettings,
  });
  const openExplorer = useCallback(
    (project: SidebarProjectSnapshot, initialTab: ProjectExplorerTabId) => {
      setExplorerTarget({ project, initialTab });
      setExplorerOpen(true);
    },
    [],
  );
  const openNewWorktree = useCallback(
    (project: SidebarProjectSnapshot, initialTab: NewWorktreeDialogTab) => {
      setNewWorktreeTarget({ project, initialTab });
      setNewWorktreeOpen(true);
    },
    [],
  );
  const actions = useMemo<SidebarProjectDialogActions>(
    () => ({
      openExplorer,
      openNewWorktree,
      openSettings: settingsDialog.openProjectSettingsDialog,
      openRename: renameDialog.openProjectRenameDialog,
      openGrouping: groupingDialog.openProjectGroupingDialog,
    }),
    [
      groupingDialog.openProjectGroupingDialog,
      openExplorer,
      openNewWorktree,
      renameDialog.openProjectRenameDialog,
      settingsDialog.openProjectSettingsDialog,
    ],
  );

  return (
    <SidebarProjectDialogContext.Provider value={actions}>
      {props.children}

      {newWorktreeTarget ? (
        <NewWorktreeDialog
          open={newWorktreeOpen}
          environmentId={newWorktreeTarget.project.environmentId}
          projectId={newWorktreeTarget.project.id}
          cwd={newWorktreeTarget.project.cwd}
          initialTab={newWorktreeTarget.initialTab}
          onCreated={(result) => {
            props.navigateToThread(
              scopeThreadRef(newWorktreeTarget.project.environmentId, result.sessionId),
            );
          }}
          onOpenChange={(open) => {
            setNewWorktreeOpen(open);
          }}
        />
      ) : null}

      {explorerTarget ? (
        <ProjectExplorerDialog
          open={explorerOpen}
          projectName={explorerTarget.project.displayName}
          memberProjects={explorerTarget.project.memberProjects}
          initialTab={explorerTarget.initialTab}
          onOpenChange={(open) => {
            setExplorerOpen(open);
          }}
        />
      ) : null}

      <ProjectSettingsDialog
        open={settingsDialog.projectSettingsOpen}
        target={settingsDialog.projectSettingsTarget}
        title={settingsDialog.projectSettingsTitle}
        customAvatarContentHash={settingsDialog.projectSettingsCustomAvatarContentHash}
        projectAvatarUploadUnavailableReason={settingsDialog.projectAvatarUploadUnavailableReason}
        preferredRemoteName={settingsDialog.projectSettingsPreferredRemoteName}
        workspaceRoot={settingsDialog.projectSettingsWorkspaceRoot}
        customSystemPrompt={settingsDialog.projectSettingsCustomSystemPrompt}
        saving={settingsDialog.projectSettingsSaving}
        onClose={settingsDialog.closeProjectSettingsDialog}
        onSave={() => void settingsDialog.submitProjectSettings()}
        onTitleChange={settingsDialog.setProjectSettingsTitle}
        onWorkspaceRootChange={settingsDialog.setProjectSettingsWorkspaceRoot}
        onCustomSystemPromptChange={settingsDialog.setProjectSettingsCustomSystemPrompt}
        onPreferredRemoteChange={settingsDialog.setProjectSettingsPreferredRemoteName}
        onPickWorkspaceRoot={() => void settingsDialog.pickProjectSettingsWorkspaceRoot()}
        onOpenRemote={settingsDialog.openProjectRemoteByName}
        onUploadAvatar={settingsDialog.uploadProjectAvatar}
        onRemoveAvatar={settingsDialog.removeProjectAvatar}
      />

      <SidebarProjectRenameDialog
        target={renameDialog.projectRenameTarget}
        title={renameDialog.projectRenameTitle}
        onTitleChange={renameDialog.setProjectRenameTitle}
        onClose={renameDialog.closeProjectRenameDialog}
        onSubmit={() => void renameDialog.submitProjectRename()}
      />

      <SidebarProjectGroupingDialog
        target={groupingDialog.projectGroupingTarget}
        selection={groupingDialog.projectGroupingSelection}
        globalGroupingMode={props.projectGroupingSettings.sidebarProjectGroupingMode}
        onSelectionChange={groupingDialog.setProjectGroupingSelection}
        onClose={groupingDialog.closeProjectGroupingDialog}
        onSave={groupingDialog.saveProjectGroupingPreference}
      />
    </SidebarProjectDialogContext.Provider>
  );
}
