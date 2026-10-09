import type { UnifiedSettings } from "@ryco/contracts/settings";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { excludeChatProjects } from "@ryco/shared/projectKind";
import { getProjectOrderKey } from "../logicalProject";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { selectProjectsAcrossEnvironments, useStore } from "../store";
import type { Project } from "../types";
import { useUiStateStore } from "../uiStateStore";
import { useSettings } from "./useSettings";

const selectProjectGroupingMode = (settings: UnifiedSettings) =>
  settings.sidebarProjectGroupingMode;
const selectProjectGroupingOverrides = (settings: UnifiedSettings) =>
  settings.sidebarProjectGroupingOverrides;

export interface LogicalProjectSnapshots {
  /**
   * Every project across environments, in the user's sidebar order. "No
   * project" chats are not projects here: they live in the sidebar's Chats
   * section and never appear in project trees or pickers.
   */
  readonly orderedProjects: readonly Project[];
  /** Projects grouped into logical repositories (one per repository identity). */
  readonly snapshots: readonly SidebarProjectSnapshot[];
}

/**
 * The sidebar's project model — user ordering plus cross-environment grouping —
 * shared so other surfaces (the pull requests page) list repositories exactly
 * the way the sidebar does.
 */
export function useLogicalProjectSnapshots(): LogicalProjectSnapshots {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  // Select the two fields separately: an object-returning selector is a new
  // object every render, which would rebuild every snapshot (and re-render
  // every consumer) on each render.
  const sidebarProjectGroupingMode = useSettings(selectProjectGroupingMode);
  const sidebarProjectGroupingOverrides = useSettings(selectProjectGroupingOverrides);
  const projectGroupingSettings = useMemo(
    () => ({ sidebarProjectGroupingMode, sidebarProjectGroupingOverrides }),
    [sidebarProjectGroupingMode, sidebarProjectGroupingOverrides],
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((s) => s.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((s) => s.byId);

  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: excludeChatProjects(projects),
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
      }),
    [projectOrder, projects],
  );

  const snapshots = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects: orderedProjects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => {
          const runtime = savedEnvironmentRuntimeById[environmentId];
          const saved = savedEnvironmentRegistry[environmentId];
          return runtime?.descriptor?.label ?? saved?.label ?? null;
        },
      }),
    [
      orderedProjects,
      projectGroupingSettings,
      primaryEnvironmentId,
      savedEnvironmentRegistry,
      savedEnvironmentRuntimeById,
    ],
  );

  return { orderedProjects, snapshots };
}
