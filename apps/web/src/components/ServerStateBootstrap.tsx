import { useEffect, useSyncExternalStore } from "react";

import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../environments/runtime";
import { getPrimaryKnownEnvironment } from "../environments/primary";
import { releaseEarlyPrimaryServerStateSync } from "../rpc/earlyServerStateSync";
import { startServerStateSync } from "../rpc/serverState";

function readPrimaryEnvironmentConnection() {
  const environmentId = getPrimaryKnownEnvironment()?.environmentId;
  return environmentId ? readEnvironmentConnection(environmentId) : null;
}

export function ServerStateBootstrap() {
  const connection = useSyncExternalStore(
    subscribeEnvironmentConnections,
    readPrimaryEnvironmentConnection,
    readPrimaryEnvironmentConnection,
  );

  useEffect(() => {
    if (!connection) return;
    // Shares the streams the boot path may have started on this connection
    // (reference-counted), then ends the boot path's hold on them.
    const stop = startServerStateSync(connection);
    releaseEarlyPrimaryServerStateSync();
    return stop;
  }, [connection]);

  return null;
}
