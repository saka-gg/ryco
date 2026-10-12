import { useEffect, useState } from "react";

import type { AppState } from "../../../store";
import { useStore } from "../../../store";

function selectAnyShellSnapshotApplied(state: AppState): boolean {
  for (const environmentState of Object.values(state.environmentStateById)) {
    if (environmentState.bootstrapComplete) return true;
  }
  return false;
}

let motionReadyLatched = false;

/**
 * Sidebar list motion (auto-animate, FLIP) stays off while the lists populate
 * at boot: the initial rows need no entrance animation, and observing them
 * forces a layout per mutation batch. Motion turns on one animation frame
 * after the first shell snapshot has been applied, and stays on for the rest
 * of the session (later reconnect snapshots animate as before).
 */
export function useSidebarListMotionReady(): boolean {
  const shellApplied = useStore(selectAnyShellSnapshotApplied);
  const [ready, setReady] = useState(motionReadyLatched);
  useEffect(() => {
    if (ready || !shellApplied) return;
    let cancelled = false;
    const enable = () => {
      if (cancelled) return;
      motionReadyLatched = true;
      setReady(true);
    };
    if (typeof requestAnimationFrame !== "function") {
      const timer = setTimeout(enable, 0);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }
    const frame = requestAnimationFrame(enable);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [ready, shellApplied]);
  return ready;
}
