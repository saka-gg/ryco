import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";

import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../environments/runtime";
import { getPrimaryKnownEnvironment } from "../environments/primary";
import { retainActiveServerConfigProjection } from "../rpc/activeServerConfig";
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

  // Config is written per environment by each connection as it arrives (from
  // connect time, before this shell mounts); the global atoms follow the one
  // environment the UI is showing. Shares the projection the boot path may have
  // started, so a config that arrived while the shell loaded is already shown.
  useLayoutEffect(() => retainActiveServerConfigProjection(), []);

  useEffect(() => {
    if (!connection) return;
    // Shares the stream the boot path may have started on this connection
    // (reference-counted), then ends the boot path's hold on it. The primary
    // connection's lifecycle stream is the one source of `welcome`.
    const stop = startServerStateSync(connection);
    releaseEarlyPrimaryServerStateSync();
    return stop;
  }, [connection]);

  return null;
}
