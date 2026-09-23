import type { EnvironmentId } from "@ryco/contracts";

import type { EnvironmentConnection } from "../../connection/connection.ts";
import { appAtomRegistry } from "../../rpc/atomRegistry.ts";
import {
  getWsConnectionStatusForEnvironment,
  wsConnectionStatusForEnvironmentAtom,
} from "../../rpc/wsConnectionState.ts";

export interface ChatFileUploadUnavailable {
  readonly label: string;
  readonly message: string;
  /** Transient socket loss can leave an independent HTTP transfer running. */
  readonly cancelInFlight: boolean;
}

/** A generation is authority only while it is still returned by read(). */
export interface ChatFileUploadReadiness {
  readonly read: () => object | null;
  readonly unavailable?: () => ChatFileUploadUnavailable;
  readonly dispose: () => void;
}

/**
 * Direct HTTP uploads only. Hosted relay lifecycle authority stays with its
 * owner; a resolved bootstrap promise from a previous socket is never evidence.
 */
export function watchDirectChatFileUploadReadiness(input: {
  readonly environmentId: EnvironmentId;
  readonly readConnection: () => EnvironmentConnection | null;
  readonly canUpload: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
  readonly onChange: () => void;
}): ChatFileUploadReadiness {
  let disposed = false;
  let observedConnection: EnvironmentConnection | null = null;
  let stopShell = () => {};
  const readConnection = () => {
    const connection = input.readConnection();
    if (connection !== observedConnection) {
      stopShell();
      observedConnection = connection;
      stopShell = connection?.shellSnapshotReadiness.subscribe(input.onChange) ?? (() => {});
    }
    return connection;
  };
  const unavailable = (): ChatFileUploadUnavailable => {
    const connection = readConnection();
    const status = getWsConnectionStatusForEnvironment(input.environmentId);
    if (!connection)
      return {
        label: "Reconnect",
        message: "Environment unavailable. Reconnect it or remove this attachment.",
        cancelInFlight: true,
      };
    if (!input.canUpload() || connection.knownEnvironment.source === "hub-hosted") {
      return {
        label: "Authorize",
        message:
          "Upload unavailable. Reconnect and authorize this environment, or remove this attachment.",
        cancelInFlight: true,
      };
    }
    if (status.reconnectPhase === "exhausted" || status.phase === "idle") {
      return {
        label: "Reconnect",
        message: "Environment disconnected. Reconnect it to retry, or remove this attachment.",
        cancelInFlight: true,
      };
    }
    return {
      label: status.phase === "connected" ? "Syncing" : "Reconnecting",
      message:
        status.phase === "connected"
          ? "Waiting for the current environment snapshot. Reconnect or remove this attachment if it does not recover."
          : "Waiting for the environment to reconnect. The upload will retry automatically; you can also remove it.",
      cancelInFlight: false,
    };
  };
  const stopStatus = appAtomRegistry.subscribe(
    wsConnectionStatusForEnvironmentAtom(input.environmentId),
    input.onChange,
  );
  const stopConnections = input.subscribe(input.onChange);
  return {
    read: () => {
      if (disposed) return null;
      const connection = readConnection();
      if (
        !input.canUpload() ||
        !connection ||
        connection.knownEnvironment.source === "hub-hosted" ||
        getWsConnectionStatusForEnvironment(input.environmentId).phase !== "connected"
      )
        return null;
      return connection.shellSnapshotReadiness.read();
    },
    unavailable,
    dispose: () => {
      disposed = true;
      stopStatus();
      stopConnections();
      stopShell();
      observedConnection = null;
    },
  };
}
