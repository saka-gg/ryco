import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { readEnvironmentApi } from "../../../environmentApi";
import { useEvent } from "../../../hooks/useEvent";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import {
  createAutomationCountsLoader,
  projectAutomationCounts,
  type AutomationCheckoutRef,
  type AutomationProjectCounts,
} from "./automationProjectCounts.logic";

export type { AutomationProjectCounts };

function readCheckoutSnapshot(checkout: AutomationCheckoutRef) {
  // Never throws: a switcher opens during reconnects too.
  try {
    return (
      readEnvironmentApi(checkout.environmentId)?.automationCentre?.snapshot({
        projectId: checkout.projectId,
      }) ?? null
    );
  } catch {
    return null;
  }
}

const checkoutsOf = (snapshots: readonly SidebarProjectSnapshot[]): AutomationCheckoutRef[] =>
  snapshots.flatMap((snapshot) =>
    snapshot.memberProjects.map((member) => ({
      environmentId: member.environmentId,
      projectId: member.id,
    })),
  );

export interface AutomationProjectCountsResult {
  /**
   * By `projectKey`: the sum over the project's checkouts that answered.
   * Absent until one has (or when none could be read).
   */
  readonly counts: ReadonlyMap<string, AutomationProjectCounts>;
  /** A read is in flight. */
  readonly loading: boolean;
  /** Read every listed project's checkouts once; recent answers are reused. Stable identity. */
  readonly request: () => void;
  /** Ignore the reads in flight (the menu closed). Stable identity. */
  readonly cancel: () => void;
}

/**
 * Schedule and waiting counts for the project switcher. Not live: each
 * project's checkouts are read once when the switcher asks (`request`), and
 * the answers are cached while this hook stays mounted. Unmounting cancels
 * the reads in flight.
 */
export function useAutomationProjectCounts(
  snapshots: readonly SidebarProjectSnapshot[],
): AutomationProjectCountsResult {
  const [loader] = useState(() =>
    createAutomationCountsLoader({ readSnapshot: readCheckoutSnapshot }),
  );
  const state = useSyncExternalStore(loader.subscribe, loader.getState, loader.getState);
  useEffect(() => () => loader.cancel(), [loader]);

  const request = useEvent(() => loader.request(checkoutsOf(snapshots)));
  const cancel = useCallback(() => loader.cancel(), [loader]);
  const counts = useMemo(() => {
    const byProject = new Map<string, AutomationProjectCounts>();
    for (const snapshot of snapshots) {
      const counts = projectAutomationCounts(checkoutsOf([snapshot]), state.entries);
      if (counts) byProject.set(snapshot.projectKey, counts);
    }
    return byProject;
  }, [snapshots, state.entries]);
  return { counts, loading: state.loading, request, cancel };
}
