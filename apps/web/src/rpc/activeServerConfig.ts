import type { EnvironmentId } from "@ryco/contracts";

import { isHostedHubMode } from "../env";
import {
  readPrimaryEnvironmentDescriptor,
  subscribePrimaryEnvironmentDescriptor,
} from "../environments/primary";
import { useStore } from "../store";
import { startActiveEnvironmentServerConfigProjection } from "./serverState";

/**
 * The environment whose config the global server state shows. A hosted session
 * follows the active node (the primary until one is active); a standard session
 * keeps its primary node's config there, since its other connections (saved
 * environments, desktop workspaces) are read through their own config entries,
 * and the shell writes the primary descriptor from the config shown here.
 */
function readConfigEnvironmentId(): EnvironmentId | null {
  const primaryEnvironmentId = readPrimaryEnvironmentDescriptor()?.environmentId ?? null;
  if (!isHostedHubMode()) return primaryEnvironmentId;
  return useStore.getState().activeEnvironmentId ?? primaryEnvironmentId;
}

function subscribeConfigEnvironmentId(listener: () => void): () => void {
  let current = readConfigEnvironmentId();
  const notifyIfChanged = () => {
    const next = readConfigEnvironmentId();
    if (next === current) return;
    current = next;
    listener();
  };
  const unsubscribePrimary = subscribePrimaryEnvironmentDescriptor(notifyIfChanged);
  // Only a hosted session follows the active environment; the thread store
  // changes far more often than that does, so a standard one never listens.
  const unsubscribeActive = isHostedHubMode()
    ? useStore.subscribe(notifyIfChanged)
    : () => undefined;
  return () => {
    unsubscribePrimary();
    unsubscribeActive();
  };
}

interface ProjectionHold {
  count: number;
  readonly stop: () => void;
}

let projectionHold: ProjectionHold | null = null;

/**
 * Keeps the global server config atoms following the environment the UI shows
 * (see {@link startActiveEnvironmentServerConfigProjection}). Reference-counted:
 * the boot path holds it while the shell loads, so a config that arrives first
 * is already shown at the shell's first render, and the shell takes its own hold
 * before the boot path lets go, so one projection runs throughout and the
 * handover announces nothing twice. The last returned stop ends it.
 */
export function retainActiveServerConfigProjection(): () => void {
  if (projectionHold === null) {
    projectionHold = {
      count: 0,
      stop: startActiveEnvironmentServerConfigProjection({
        readActive: readConfigEnvironmentId,
        subscribeActive: subscribeConfigEnvironmentId,
      }),
    };
  }
  const hold = projectionHold;
  hold.count += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    hold.count -= 1;
    if (hold.count > 0) return;
    if (projectionHold === hold) projectionHold = null;
    hold.stop();
  };
}
