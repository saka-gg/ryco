import type { UnifiedSettings } from "@ryco/contracts/settings";
import { useMemo } from "react";

import type { ProjectGroupingSettings } from "../logicalProject";
import { useSettings } from "./useSettings";

const selectProjectGroupingMode = (settings: UnifiedSettings) =>
  settings.sidebarProjectGroupingMode;
const selectProjectGroupingOverrides = (settings: UnifiedSettings) =>
  settings.sidebarProjectGroupingOverrides;

/**
 * The project grouping settings as one object whose identity changes only
 * when a grouping setting does. The two fields are selected separately: an
 * inline object-returning selector builds a new object on every render of an
 * uncompiled caller, which invalidates every memo and callback built on it.
 */
export function useProjectGroupingSettings(): ProjectGroupingSettings {
  const sidebarProjectGroupingMode = useSettings(selectProjectGroupingMode);
  const sidebarProjectGroupingOverrides = useSettings(selectProjectGroupingOverrides);
  return useMemo(
    () => ({ sidebarProjectGroupingMode, sidebarProjectGroupingOverrides }),
    [sidebarProjectGroupingMode, sidebarProjectGroupingOverrides],
  );
}
