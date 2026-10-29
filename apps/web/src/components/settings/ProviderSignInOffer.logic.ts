import type { ProviderInstanceConfig } from "@ryco/contracts";
import { claudeInstanceSkipsLogin, PROVIDER_SIGN_IN_DRIVERS } from "@ryco/shared/providerSignIn";

/**
 * Whether a surface offers to sign the instance in at all: its driver signs in from Ryco, and it
 * is not a Claude instance whose settings route it past the login. A proxied Claude instance
 * shows no sign-in, not even the node's refusal: its account lives on the proxy.
 */
export function instanceOffersSignIn(
  driver: string,
  instance: ProviderInstanceConfig | undefined,
): boolean {
  return (
    PROVIDER_SIGN_IN_DRIVERS.has(driver) &&
    !(driver === "claudeAgent" && claudeInstanceSkipsLogin(instance))
  );
}
