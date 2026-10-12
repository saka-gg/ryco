import { useLayoutEffect } from "react";

import { usePrimaryEnvironmentId } from "../environments/primary";
import { selectEnvironmentState, useStore } from "../store";
import {
  hasReachedStartupPhase,
  markStartupPhase,
  markStartupPhaseAfterPaint,
  measureStartupPhasesEndingAt,
} from "./startupInstrumentation";

/**
 * Closes the startup timeline at what the user sees: `primary-sidebar-committed`
 * when React commits the shell with the primary environment's bootstrapped
 * snapshot (a layout effect in the same commit as the sidebar), then
 * `primary-shell-painted` once that frame is presented. `primary-shell-usable`
 * fires earlier, right after the store write and before render and paint.
 * Renders nothing; marks once per document.
 */
export function PrimaryShellPaintMarker(): null {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const bootstrapComplete = useStore(
    (store) =>
      primaryEnvironmentId !== null &&
      selectEnvironmentState(store, primaryEnvironmentId).bootstrapComplete,
  );

  useLayoutEffect(() => {
    if (!bootstrapComplete || hasReachedStartupPhase("primary-sidebar-committed")) return;
    markStartupPhase("primary-sidebar-committed");
    measureStartupPhasesEndingAt("primary-sidebar-committed");
    markStartupPhaseAfterPaint("primary-shell-painted");
  }, [bootstrapComplete]);

  return null;
}
