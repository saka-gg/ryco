import { USAGE_CONTRACT_VERSION, WS_METHODS } from "@ryco/contracts";
export const USAGE_UPDATE_MESSAGE =
  "Update Ryco on this device and the connected node to use the current usage format.";
export class UsageContractMismatchError extends Error {
  constructor() {
    super(USAGE_UPDATE_MESSAGE);
    this.name = "UsageContractMismatchError";
  }
}
export function assertUsageContractVersion(version: number | undefined): void {
  // A request built for another contract would only fail on the node; say so here.
  if (version !== USAGE_CONTRACT_VERSION) throw new UsageContractMismatchError();
}
export function isUsageContractMismatch(error: unknown): boolean {
  return (
    error instanceof UsageContractMismatchError ||
    (error instanceof Error && error.name === "UsageContractMismatchError")
  );
}

/**
 * Whether a failed summary request means the node speaks another usage
 * contract. The request is sent without a capability round trip, so the
 * mismatch shows up in the answer instead: this client's schema rejects the
 * summary's `contractVersion`, the node's schema rejects the request's (an RPC
 * defect, which arrives as a bare string), the node predates the method, or it
 * answers with the shared update message.
 */
export function isUsageContractRejection(error: unknown): boolean {
  if (isUsageContractMismatch(error)) return true;
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  if (message === undefined) return false;
  return (
    message === USAGE_UPDATE_MESSAGE ||
    message.includes("contractVersion") ||
    message.includes(`Unknown request tag: ${WS_METHODS.serverGetUsageSummary}`)
  );
}
