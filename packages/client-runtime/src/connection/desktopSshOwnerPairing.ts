import type { AuthSessionRole } from "@ryco/contracts";

/**
 * Desktop SSH nodes pair as owner: on direct transport a client session acts as
 * a viewer, so only an owner bearer can add projects there or receive a copied
 * project. Nodes added before owner SSH pairing hold a client bearer and re-pair
 * as owner over their own tunnel.
 */

/**
 * What the last owner pairing of a Desktop SSH environment found, kept while
 * the app runs. `unsupported`: the remote CLI could not mint owner credentials
 * while the node reported `serverVersion` (null when it could not be read).
 * `failed`: the attempt itself failed (an SSH hiccup, a busy node, a refused
 * redeem) at `at`, which says nothing about the remote CLI.
 */
export type DesktopSshOwnerRepairOutcome =
  | { readonly kind: "unsupported"; readonly serverVersion: string | null }
  | { readonly kind: "failed"; readonly at: number };

/** How long after a failed owner re-pair the next one may run. */
export const DESKTOP_SSH_OWNER_REPAIR_RETRY_MS = 10 * 60_000;

export interface DesktopSshOwnerRepairInput {
  /** The saved environment is reached through a Desktop SSH tunnel. */
  readonly desktopSsh: boolean;
  /** The role the node reported for the bearer this connect presented. */
  readonly sessionRole: AuthSessionRole | null | undefined;
  /**
   * This connect already minted that bearer through the tunnel. The pairing
   * script asks for owner first, so a fresh client bearer means the remote CLI
   * cannot mint owner credentials yet.
   */
  readonly bearerIssuedThisConnect: boolean;
  /** The environment's last owner pairing outcome, if one was recorded. */
  readonly lastOutcome: DesktopSshOwnerRepairOutcome | undefined;
  /** The Ryco version the node reports now, or null when it is not known. */
  readonly serverVersion: string | null;
  readonly now: number;
}

export function shouldRepairDesktopSshAsOwner(input: DesktopSshOwnerRepairInput): boolean {
  if (!input.desktopSsh || input.sessionRole !== "client" || input.bearerIssuedThisConnect) {
    return false;
  }
  const last = input.lastOutcome;
  if (last === undefined) return true;
  if (last.kind === "failed") return input.now - last.at >= DESKTOP_SSH_OWNER_REPAIR_RETRY_MS;
  // Updating Ryco on the node is what lets its CLI mint owner credentials: a
  // node that now reports another version than the one that could not is
  // asked again.
  return input.serverVersion !== null && input.serverVersion !== last.serverVersion;
}

/**
 * Why a Desktop SSH node cannot take projects, or null. A connected SSH node
 * still on a client session has a remote CLI that cannot mint owner
 * credentials: the owner re-pair ran during the connect, before the role was
 * published, and runs again once the node reports another Ryco version. Node
 * catalogs read `SavedEnvironmentRecord.desktopSsh` and
 * `SavedEnvironmentRuntimeState.role` for it.
 */
export function desktopSshMutateBlockedReason(input: {
  readonly desktopSsh: boolean;
  readonly role: AuthSessionRole | null;
  readonly label: string;
}): string | null {
  return input.desktopSsh && input.role === "client"
    ? `Update Ryco on ${input.label} to copy projects here`
    : null;
}
