import type { PendingApproval } from "./session-logic.ts";

/** The disclosure on an approval card that shows the provider's own reason for asking. */
export const APPROVAL_REASON_LABEL = "Why am I being asked?";

/**
 * The provider's reason for asking, or null when it has none worth a disclosure: missing, blank,
 * or only the request itself again.
 */
export function pendingApprovalReason(
  approval: Pick<PendingApproval, "reason" | "detail">,
): string | null {
  const reason = approval.reason?.trim() ?? "";
  if (reason === "" || reason === approval.detail?.trim()) return null;
  return reason;
}

/** Whether the approval may offer "Always allow this session". */
export function pendingApprovalOffersAcceptForSession(
  approval: Pick<PendingApproval, "acceptForSessionOffered">,
): boolean {
  return approval.acceptForSessionOffered !== false;
}
