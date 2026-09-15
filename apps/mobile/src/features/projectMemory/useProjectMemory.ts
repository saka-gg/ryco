import { hostedHubStore } from "@ryco/client-runtime/authorization";
import { mobileHostedConnectionsStore } from "../../connection/hostedConnectionCoordinator";
import { getMobileE2eeSessionState, subscribeMobileE2eeSession } from "../../hostedHub/e2eeSession";
import {
  authoritativeNodeTrustSourceRevision,
  subscribeAuthoritativeNodeTrustSource,
} from "../home/authoritativeNodeTrustSource";
import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import {
  createProjectMemoryController,
  captureProjectMemoryConnection,
} from "@ryco/client-runtime/state/project-memory";
import { readProjectMemoryConnection } from "./readProjectMemoryConnection";

/** Binds the existing native readiness projection; owns no connections or authorization policy. */
export function useProjectMemory(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  ready: boolean,
  scopeKey: string,
) {
  const hub = useSyncExternalStore(hostedHubStore.subscribe, hostedHubStore.getState);
  const connections = useSyncExternalStore(
    mobileHostedConnectionsStore.subscribe,
    mobileHostedConnectionsStore.getState,
  );
  const e2ee = useSyncExternalStore(
    subscribeMobileE2eeSession,
    useCallback(() => getMobileE2eeSessionState(environmentId), [environmentId]),
  );
  const trustRevision = useSyncExternalStore(
    subscribeAuthoritativeNodeTrustSource,
    authoritativeNodeTrustSourceRevision,
  );
  const controller = useMemo(
    () =>
      projectId && scopeKey
        ? createProjectMemoryController({
            environmentId,
            projectId,
            readConnection: captureProjectMemoryConnection(() => {
              const connection = readProjectMemoryConnection(environmentId);
              return connection
                ? {
                    ...connection,
                    ready:
                      ready &&
                      connection.ready &&
                      hostedHubStore.getState() === hub &&
                      mobileHostedConnectionsStore.getState() === connections &&
                      getMobileE2eeSessionState(environmentId) === e2ee &&
                      authoritativeNodeTrustSourceRevision() === trustRevision,
                  }
                : null;
            }),
          })
        : null,
    [environmentId, projectId, ready, scopeKey, hub, connections, e2ee, trustRevision],
  );
  useLayoutEffect(() => {
    if (!ready) controller?.invalidate();
  }, [controller, ready]);
  useLayoutEffect(() => () => controller?.invalidate(), [controller]);
  return controller;
}
