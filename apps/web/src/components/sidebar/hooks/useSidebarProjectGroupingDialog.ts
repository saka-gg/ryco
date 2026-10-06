import { useCallback, useState } from "react";
import { type SidebarProjectGroupingMode } from "@ryco/contracts";
import type { SidebarProjectGroupMember } from "../../../sidebarProjectGrouping";
import { readProjectGroupingChoice, withProjectGroupingChoice } from "../../../projectMutations";
import { useUpdateSettings } from "~/hooks/useSettings";

interface ProjectGroupingSettings {
  sidebarProjectGroupingMode: SidebarProjectGroupingMode;
  sidebarProjectGroupingOverrides: Record<string, SidebarProjectGroupingMode> | undefined;
}

export function useSidebarProjectGroupingDialog(params: {
  projectGroupingSettings: ProjectGroupingSettings;
  updateSettings: ReturnType<typeof useUpdateSettings>["updateSettings"];
}) {
  const { projectGroupingSettings, updateSettings } = params;
  const [projectGroupingTarget, setProjectGroupingTarget] =
    useState<SidebarProjectGroupMember | null>(null);
  const [projectGroupingSelection, setProjectGroupingSelection] = useState<
    SidebarProjectGroupingMode | "inherit"
  >("inherit");

  const openProjectGroupingDialog = useCallback(
    (member: SidebarProjectGroupMember) => {
      setProjectGroupingTarget(member);
      setProjectGroupingSelection(
        readProjectGroupingChoice(projectGroupingSettings.sidebarProjectGroupingOverrides, member),
      );
    },
    [projectGroupingSettings.sidebarProjectGroupingOverrides],
  );

  const closeProjectGroupingDialog = useCallback(() => {
    setProjectGroupingTarget(null);
    setProjectGroupingSelection("inherit");
  }, []);

  const saveProjectGroupingPreference = useCallback(() => {
    if (!projectGroupingTarget) {
      return;
    }

    updateSettings({
      sidebarProjectGroupingOverrides: withProjectGroupingChoice(
        projectGroupingSettings.sidebarProjectGroupingOverrides,
        projectGroupingTarget,
        projectGroupingSelection,
      ),
    });
    closeProjectGroupingDialog();
  }, [
    closeProjectGroupingDialog,
    projectGroupingSelection,
    projectGroupingSettings.sidebarProjectGroupingOverrides,
    projectGroupingTarget,
    updateSettings,
  ]);

  return {
    projectGroupingTarget,
    projectGroupingSelection,
    setProjectGroupingSelection,
    openProjectGroupingDialog,
    closeProjectGroupingDialog,
    saveProjectGroupingPreference,
  };
}
