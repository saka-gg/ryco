import { isHostedHubMode } from "../../env";
import { isHostedStaticApp } from "../../hostedPairing";
import {
  isLoopbackHostname,
  readPrimaryEnvironmentTarget,
} from "../../environments/primary/target";

/** Presentation eligibility only. Authentication and mutation policy stay with their owners. */
export function isLocalOnboardingClient(): boolean {
  if (typeof window === "undefined" || isHostedHubMode() || isHostedStaticApp()) return false;
  try {
    const target = readPrimaryEnvironmentTarget();
    return target !== null && isLoopbackHostname(new URL(target.target.httpBaseUrl).hostname);
  } catch {
    return false;
  }
}
