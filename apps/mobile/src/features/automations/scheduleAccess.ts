import type { EnvironmentId } from "@ryco/contracts";
import { useMemo } from "react";

import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { scheduleAccessOf, type ScheduleAccess } from "./scheduleAccessModel";

/** Every listed machine's schedule access; an unlisted one reads as not editable. */
export function useScheduleAccess(): (environmentId: EnvironmentId) => ScheduleAccess {
  const nodes = useHomeEnvironments();
  return useMemo(() => {
    const byId = new Map(nodes.map((node) => [node.environmentId, node] as const));
    return (environmentId) => scheduleAccessOf(byId.get(environmentId));
  }, [nodes]);
}
