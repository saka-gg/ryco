import type { ProviderInstanceConfig } from "@ryco/contracts";
import {
  CLAUDE_NON_LOGIN_CREDENTIAL_VARIABLES,
  CLAUDE_THIRD_PARTY_PROVIDER_FLAGS,
} from "@ryco/shared/claudeCredentialVariables";
import { PROVIDER_SIGN_IN_DRIVERS } from "@ryco/shared/providerSignIn";

const CLAUDE_NON_LOGIN_VARIABLES: ReadonlySet<string> = new Set([
  ...CLAUDE_NON_LOGIN_CREDENTIAL_VARIABLES,
  ...CLAUDE_THIRD_PARTY_PROVIDER_FLAGS,
]);

/**
 * Whether the instance's own settings name a variable that keeps Claude Code off the local
 * login, such as a CLIProxyAPI hub's `ANTHROPIC_BASE_URL`. By name alone: a client never sees
 * the values, so a flag set to "0" counts too. The node checks the values, and its own ambient
 * environment, before it starts a sign-in.
 */
export function claudeInstanceSkipsLogin(instance: ProviderInstanceConfig | undefined): boolean {
  return (
    instance?.environment?.some((variable) => CLAUDE_NON_LOGIN_VARIABLES.has(variable.name)) ??
    false
  );
}

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
