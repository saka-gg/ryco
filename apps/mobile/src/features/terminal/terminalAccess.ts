import { WS_METHODS } from "@ryco/contracts/rpc";
import { hostedRoleAllows } from "@ryco/shared/rpcAccessPolicy";

import type { InboxEnvironment } from "../inbox/inboxModel";
import type { TerminalConnectionState } from "./terminalScreenModel";

/**
 * Whether the session's role may run a terminal, by the node's own access
 * rule for the terminal methods. A direct pairing that is not the node's owner
 * is a viewer to it; an unknown role is not assumed to be enough.
 */
export function terminalRoleAllowed(role: InboxEnvironment["role"]): boolean {
  if (role === undefined) return false;
  return hostedRoleAllows(role === "client" ? "viewer" : role, WS_METHODS.terminalWrite);
}

export interface TerminalEnvironmentAccess {
  readonly connectionState: TerminalConnectionState;
  readonly mutationReady: boolean;
}

/**
 * The terminal's access from the environment row's shared mutation readiness
 * (connection, hosted session and shell currency) and the role. Nothing here
 * re-derives readiness; a row that is not mutation-ready stays read-only.
 */
export function terminalEnvironmentAccess(
  environment: Pick<InboxEnvironment, "connectionState" | "mutationReady" | "role"> | undefined,
): TerminalEnvironmentAccess {
  if (environment === undefined) return { connectionState: "offline", mutationReady: false };
  const roleAllowed = terminalRoleAllowed(environment.role);
  return {
    connectionState:
      environment.connectionState === "connected" && !roleAllowed
        ? "read-only"
        : environment.connectionState,
    mutationReady: environment.mutationReady === true && roleAllowed,
  };
}
