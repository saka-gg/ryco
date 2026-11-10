import { useEffect } from "react";
import type { EnvironmentId } from "@ryco/contracts";

import { readEnvironmentApi, subscribeEnvironmentApis } from "../connection/environmentApi";
import { useWsConnectionStatusForEnvironment } from "../rpc/wsConnectionState";
import { createAgentControlSyncRegistry } from "./agentControlRuntime";

/**
 * The phone's Agent Control queue subscriptions: the same shared, reference
 * counted registry the web app uses, so every screen of one machine shares one
 * stream (and one opening snapshot). The api is cached per live client, so the
 * agentControl object itself identifies the connection.
 */
const agentControlSyncs = createAgentControlSyncRegistry({
  readSource: (environmentId) => {
    const source = readEnvironmentApi(environmentId)?.agentControl;
    return source ? { source } : null;
  },
  subscribeSourceChanges: subscribeEnvironmentApis,
});

/**
 * Keep one environment's Agent Control queue synced into the shared store
 * while mounted and the server-side Agent Control setting is enabled. The
 * same shared runtime the web app uses — mobile adds no policy or
 * transport of its own.
 */
export function useAgentControlSync(environmentId: EnvironmentId, enabled: boolean): void {
  // Wave 3a: a thread opened from cache has no connection yet — the retarget
  // lands one a moment later. The environment's own socket phase is the
  // arrival signal (it flips to "connected" exactly when there is an api to
  // read): re-running the effect re-retains, and the registry binds the
  // stream to whatever connection the environment has now.
  const connectionPhase = useWsConnectionStatusForEnvironment(environmentId).phase;

  useEffect(() => {
    if (!enabled) return undefined;
    return agentControlSyncs.retain(environmentId);
  }, [connectionPhase, enabled, environmentId]);
}
