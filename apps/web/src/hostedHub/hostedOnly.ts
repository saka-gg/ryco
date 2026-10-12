/**
 * Raised by a standard-build seam (`src/clientModeSeams.ts`) when code reaches a
 * hosted-only entry point — a relay attempt, a hosted coordinator, a PWA
 * runtime. Standard builds never start the hosted lifecycle, so reaching one is
 * a missing `isHostedHubMode()` guard; failing loudly surfaces it in the dev
 * server instead of letting a silent stand-in mask it.
 */
export class HostedOnlyEntryPointError extends Error {
  constructor(entryPoint: string) {
    super(`${entryPoint} is only available in hosted-hub builds.`);
    this.name = "HostedOnlyEntryPointError";
  }
}

export function hostedOnly(entryPoint: string): never {
  throw new HostedOnlyEntryPointError(entryPoint);
}
