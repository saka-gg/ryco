import type { EnvironmentId } from "@ryco/contracts";

import type { EnvironmentConnection } from "../../connection/connection.ts";
import { appAtomRegistry } from "../../rpc/atomRegistry.ts";
import {
  getWsConnectionStatusForEnvironment,
  wsConnectionStatusForEnvironmentAtom,
} from "../../rpc/wsConnectionState.ts";

/** A generation is authority only while it is still returned by read(). */
export interface ChatFileUploadReadiness {
  readonly read: () => object | null;
  readonly dispose: () => void;
}

/**
 * Direct HTTP uploads only. Hosted adapters must fail closed here: their relay
 * lifecycle owns authorization and streaming HTTP uploads are not supported.
 * The current authenticated socket and its shell bootstrap must both be ready.
 */
export function watchDirectChatFileUploadReadiness(input: {
  readonly environmentId: EnvironmentId;
  readonly readConnection: () => EnvironmentConnection | null;
  readonly canUpload: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
  readonly onChange: () => void;
}): ChatFileUploadReadiness {
  let disposed = false;
  let current: {
    connection: EnvironmentConnection;
    bootstrap: Promise<void>;
    attempt: number;
    ready: boolean;
  } | null = null;

  const read = (): object | null => {
    if (disposed) return null;
    const status = getWsConnectionStatusForEnvironment(input.environmentId);
    const connection = input.readConnection();
    if (
      !input.canUpload() ||
      status.phase !== "connected" ||
      !connection ||
      connection.knownEnvironment.source === "hub-hosted"
    ) {
      current = null;
      return null;
    }
    const bootstrap = connection.ensureBootstrapped();
    if (
      current?.connection !== connection ||
      current.bootstrap !== bootstrap ||
      current.attempt !== status.attemptCount
    ) {
      const generation = { connection, bootstrap, attempt: status.attemptCount, ready: false };
      current = generation;
      void bootstrap.then(
        () => {
          if (disposed || current !== generation) return;
          generation.ready = true;
          input.onChange();
        },
        () => {
          // A failed bootstrap waits for a new connection/subscription, never polls.
        },
      );
    }
    return current.ready ? current : null;
  };
  const stopStatus = appAtomRegistry.subscribe(
    wsConnectionStatusForEnvironmentAtom(input.environmentId),
    input.onChange,
  );
  const stopConnections = input.subscribe(input.onChange);
  return {
    read,
    dispose: () => {
      disposed = true;
      current = null;
      stopStatus();
      stopConnections();
    },
  };
}
