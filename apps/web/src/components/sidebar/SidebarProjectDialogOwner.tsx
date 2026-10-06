import { useNavigate } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { SidebarProjectGroupingMode, ScopedThreadRef } from "@ryco/contracts";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import type { useUpdateSettings } from "~/hooks/useSettings";
import { buildProjectsPageLocation } from "../../projectsRoute";
import { NewWorktreeDialog, type NewWorktreeDialogTab } from "../worktrees/NewWorktreeDialog";
import { SidebarProjectGroupingDialog } from "./SidebarProjectGroupingDialog";
import { SidebarProjectRenameDialog } from "./SidebarProjectRenameDialog";
import { useSidebarProjectGroupingDialog } from "./hooks/useSidebarProjectGroupingDialog";
import { useSidebarProjectRenameDialog } from "./hooks/useSidebarProjectRenameDialog";

/**
 * Project actions the desktop sidebar offers. Overview and settings live on
 * the projects page (the frozen phone tier keeps its own dialogs); the rest
 * are small dialogs owned here.
 */
interface SidebarProjectDialogActions {
  /**
   * The project's page through one checkout: a sidebar project row passes its
   * representative checkout, a thread its own.
   */
  readonly openOverview: (
    checkout: Pick<SidebarProjectGroupMember, "environmentId" | "id">,
  ) => void;
  readonly openNewWorktree: (
    project: SidebarProjectSnapshot,
    initialTab: NewWorktreeDialogTab,
  ) => void;
  /** The page for one checkout (the project on one device). */
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
  const navigate = useNavigate();
  const renameDialog = useSidebarProjectRenameDialog();
  const groupingDialog = useSidebarProjectGroupingDialog({
    projectGroupingSettings: props.projectGroupingSettings,
    updateSettings: props.updateSettings,
  });
  // Overview and settings are one page: the overview opens its map, settings
  // its editor; a checkout picks the device.
  const openProjectPage = useCallback(
    (
      checkout: Pick<SidebarProjectGroupMember, "environmentId" | "id">,
      view: "map" | "settings",
    ) => {
      void navigate(
        buildProjectsPageLocation({
          environmentId: checkout.environmentId,
          projectId: checkout.id,
          view,
        }),
      );
    },
    [navigate],
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
      openOverview: (checkout) => openProjectPage(checkout, "map"),
      openNewWorktree,
      openSettings: (checkout) => openProjectPage(checkout, "settings"),
      openRename: renameDialog.openProjectRenameDialog,
      openGrouping: groupingDialog.openProjectGroupingDialog,
    }),
    [
      groupingDialog.openProjectGroupingDialog,
      openNewWorktree,
      openProjectPage,
      renameDialog.openProjectRenameDialog,
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
