import type { ProviderInstanceConfig, ServerProvider } from "@ryco/contracts";
import { providerNeedsSignIn } from "@ryco/shared/providerSignIn";

import { instanceOffersSignIn } from "../settings/ProviderSignInOffer.logic";

/**
 * Whether setup offers Sign in for a detected provider: it runs, its driver signs in from Ryco,
 * it reports no sign-in, a proxied Claude instance is left alone, and this session may start one.
 */
export function canOfferOnboardingSignIn(input: {
  /** The node's snapshot of the instance (`config.providers`). */
  readonly provider: ServerProvider;
  /** Its settings (`settings.providerInstances`); absent for a default instance never edited. */
  readonly instance: ProviderInstanceConfig | undefined;
  readonly capabilityAllowed: boolean;
}): boolean {
  return (
    input.capabilityAllowed &&
    providerNeedsSignIn(input.provider) &&
    instanceOffersSignIn(input.provider.driver, input.instance)
  );
}
