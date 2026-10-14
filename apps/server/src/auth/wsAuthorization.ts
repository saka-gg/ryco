import { AuthRpcError } from "@ryco/contracts";
import { Effect } from "effect";

import type { AuthenticatedSession } from "./Services/ServerAuth.ts";
import {
  directRpcPrincipal,
  type RpcPrincipal,
  type RpcPrincipalRole,
} from "../ws/RpcPrincipal.ts";

export type WsRpcAccess = RpcPrincipalRole | "authenticated" | "direct_owner" | "relay_native";

const accessRank: Readonly<Record<RpcPrincipalRole, number>> = {
  viewer: 0,
  operator: 1,
  owner: 2,
};

export function authorizeRpcPrincipal(
  principal: RpcPrincipal,
  access: WsRpcAccess,
  method: string,
): Effect.Effect<void, AuthRpcError> {
  const required = access === "authenticated" ? "viewer" : access;
  const allowed =
    required === "direct_owner"
      ? principal.role === "owner" && principal.canManageLocalAccess
      : required === "relay_native"
        ? principal.transport === "relay" &&
          principal.relayAuthority !== undefined &&
          principal.relayAuthority().trustSource !== "none"
        : accessRank[principal.role] >= accessRank[required];
  if (!allowed) {
    const message =
      required === "relay_native"
        ? `Only a native app connected through the Hub can call ${method}.`
        : required === "owner"
          ? `Only owner sessions can call ${method}.`
          : required === "operator" && principal.transport === "direct"
            ? `Only owner sessions can call ${method}.`
            : required === "direct_owner"
              ? `Only direct owner sessions can call ${method}.`
              : `${required[0]!.toUpperCase()}${required.slice(1)} sessions are required to call ${method}.`;
    return Effect.fail(
      new AuthRpcError({
        message,
        status: 403,
      }),
    );
  }
  return Effect.void;
}

export function authorizeWsRpc(
  session: AuthenticatedSession,
  access: WsRpcAccess,
  method: string,
): Effect.Effect<void, AuthRpcError> {
  return authorizeRpcPrincipal(directRpcPrincipal(session), access, method);
}
