import type { HostedAccountEmail } from "./types.ts";

/**
 * The verification an account's outstanding mail would complete, as every
 * surface presents it.
 *
 * `change` is `true` for a requested change of the account's address: the
 * current address stays the one in use until `address` is confirmed. It is
 * `false` when the mail confirms the account's own, never-verified address.
 */
export interface HostedPendingEmailVerification {
  readonly address: string;
  readonly expiresAt: number;
  readonly change: boolean;
}

/**
 * Project the account-email read onto the pending verification a surface shows,
 * or `null` when there is none to show: nothing pending, an unknown read
 * (`null`, including a Hub too old to serve it), or a mail that has expired
 * since it was read. Shared so web and phone present the same state.
 */
export function pendingEmailVerification(
  accountEmail: HostedAccountEmail | null | undefined,
  now: number,
): HostedPendingEmailVerification | null {
  if (!accountEmail) return null;
  const { pendingAddress, pendingExpiresAt } = accountEmail;
  if (pendingAddress === null || pendingExpiresAt === null || pendingExpiresAt <= now) return null;
  return {
    address: pendingAddress,
    expiresAt: pendingExpiresAt,
    change: pendingAddress !== accountEmail.email?.address,
  };
}
