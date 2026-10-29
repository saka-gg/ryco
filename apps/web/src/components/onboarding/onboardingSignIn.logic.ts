import type { ProviderInstanceConfig, ServerProvider } from "@ryco/contracts";
import {
  CLAUDE_NON_LOGIN_CREDENTIAL_VARIABLES,
  CLAUDE_THIRD_PARTY_PROVIDER_FLAGS,
} from "@ryco/shared/claudeCredentialVariables";
import { providerNeedsSignIn } from "@ryco/shared/providerSignIn";

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
    !(input.provider.driver === "claudeAgent" && claudeInstanceSkipsLogin(input.instance))
  );
}
