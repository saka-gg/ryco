import { USAGE_CONTRACT_VERSION } from "@ryco/contracts";
export const USAGE_UPDATE_MESSAGE =
  "Update Ryco on this device and the connected node to use the current usage format.";
export class UsageContractMismatchError extends Error {
  constructor() {
    super(USAGE_UPDATE_MESSAGE);
    this.name = "UsageContractMismatchError";
  }
}
export function assertUsageContractVersion(version: number | undefined): void {
  // Older nodes do not advertise this capability. Never send a v2 literal
  // request to a v1 endpoint, or try to decode its response with v2 schemas.
  if (version !== USAGE_CONTRACT_VERSION) throw new UsageContractMismatchError();
}
export function isUsageContractMismatch(error: unknown): boolean {
  return (
    error instanceof UsageContractMismatchError ||
    (error instanceof Error && error.name === "UsageContractMismatchError")
  );
}
