import { useCallback, useLayoutEffect, useRef } from "react";
import { WS_METHODS } from "@ryco/contracts";
import type { WsRpcClient } from "@ryco/client-runtime/rpc";

import { readEnvironmentConnection } from "../../environments/runtime";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import type { SettingsTarget } from "../../settingsTarget";

export interface SessionImportAccess {
  /** This client may read the node's local history and import it now. */
  readonly allowed: boolean;
  /**
   * The node's import calls. Throws once owner access to that node is lost,
   * so an import already running cannot outlive it.
   */
  readonly client: () => WsRpcClient["sessionImport"];
}

/**
 * Who may import local Codex and Claude Code history on `target`'s node: a
 * connected owner whose hosted capability is current. Settings' conversation
 * import and the project import dialog share this one definition.
 */
export function useSessionImportAccess(target: SettingsTarget | null): SessionImportAccess {
  const environmentId = target?.environmentId ?? null;
  const capability = useHostedRpcCapability(WS_METHODS.sessionImportRun, environmentId);
  const allowed =
    !!target?.connected &&
    target.canManage === true &&
    target.canMutate !== false &&
    capability.allowed;
  const current = useRef({ allowed: false, environmentId });
  useLayoutEffect(() => {
    current.current = { allowed, environmentId };
  }, [allowed, environmentId]);
  const client = useCallback(() => {
    const connection = environmentId ? readEnvironmentConnection(environmentId) : null;
    if (!connection || !current.current.allowed || current.current.environmentId !== environmentId)
      throw new Error("Reconnect with owner access before importing.");
    return connection.client.sessionImport;
  }, [environmentId]);
  return { allowed, client };
}
