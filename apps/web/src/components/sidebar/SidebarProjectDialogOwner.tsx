import { useNavigate } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useMemo } from "react";
import type { SidebarProjectGroupingMode } from "@ryco/contracts";

import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import type { useUpdateSettings } from "~/hooks/useSettings";
import { buildProjectsPageLocation } from "../../projectsRoute";
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
}) {
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
  const actions = useMemo<SidebarProjectDialogActions>(
    () => ({
      openOverview: (checkout) => openProjectPage(checkout, "map"),
      openSettings: (checkout) => openProjectPage(checkout, "settings"),
      openRename: renameDialog.openProjectRenameDialog,
      openGrouping: groupingDialog.openProjectGroupingDialog,
    }),
    [
      groupingDialog.openProjectGroupingDialog,
      openProjectPage,
      renameDialog.openProjectRenameDialog,
    ],
  );

  return (
    <SidebarProjectDialogContext.Provider value={actions}>
      {props.children}

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
