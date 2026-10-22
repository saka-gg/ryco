import type { AuthSessionRole } from "@ryco/contracts";

/**
 * Desktop SSH nodes pair as owner: on direct transport a client session acts as
 * a viewer, so only an owner bearer can add projects there or receive a copied
 * project. Nodes added before owner SSH pairing hold a client bearer and re-pair
 * as owner once, over their own tunnel.
 */
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
  /** An owner re-pair already ran for this environment since the app started. */
  readonly ownerRepairAttempted: boolean;
}

export function shouldRepairDesktopSshAsOwner(input: DesktopSshOwnerRepairInput): boolean {
  return (
    input.desktopSsh &&
    input.sessionRole === "client" &&
    !input.bearerIssuedThisConnect &&
    !input.ownerRepairAttempted
  );
}

/**
 * Why a Desktop SSH node cannot take projects, or null. A connected SSH node
 * still on a client session has a remote CLI that cannot mint owner
 * credentials: the owner re-pair ran during the connect, before the role was
 * published. Node catalogs read `SavedEnvironmentRecord.desktopSsh` and
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
