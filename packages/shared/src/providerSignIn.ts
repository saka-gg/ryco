/**
 * What a provider snapshot says about its sign-in, read the same way by the node that verifies a
 * login and by the clients that offer one.
 *
 * @module providerSignIn
 */
import type { ProviderInstanceConfig, ServerProvider } from "@ryco/contracts";

import {
  CLAUDE_NON_LOGIN_CREDENTIAL_VARIABLES,
  CLAUDE_THIRD_PARTY_PROVIDER_FLAGS,
} from "./claudeCredentialVariables.ts";

/**
 * Drivers a node can sign in from Ryco: Codex by device code, the others by their own login in a
 * terminal. The node decides per instance (`provider.signIn.subscribe` reports why one is
 * unavailable); clients use this only to know where to offer it.
 */
export const PROVIDER_SIGN_IN_DRIVERS: ReadonlySet<string> = new Set([
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "opencode",
]);

/**
 * Whether the snapshot reports a sign-in. Claude reports "authenticated" whenever it starts, so
 * for Claude only an account (an email, or a subscription or API key label) shows a login took.
 */
export function providerReportsSignIn(provider: Pick<ServerProvider, "driver" | "auth">): boolean {
  return (
    provider.auth.status === "authenticated" &&
    (provider.driver !== "claudeAgent" ||
      provider.auth.email !== undefined ||
      provider.auth.label !== undefined)
  );
}

/**
 * Whether the snapshot shows the instance needs no sign-in: it reports one, or it is ready without
 * knowing of an account: a Codex on a custom model provider (a CLIProxy-routed Codex) works without
 * one, and Grok never reports its account, so a Grok that starts is signed in. One whose check
 * failed may still need a sign-in.
 */
export function providerSignInSettled(
  provider: Pick<ServerProvider, "driver" | "auth" | "status">,
): boolean {
  return (
    providerReportsSignIn(provider) ||
    (provider.status === "ready" && provider.auth.status === "unknown")
  );
}

/**
 * Whether to offer signing the instance in: it runs (enabled, installed, available), its driver
 * signs in from Ryco, and the sign-in is not settled ({@link providerSignInSettled}).
 */
export function providerNeedsSignIn(
  provider: Pick<
    ServerProvider,
    "driver" | "auth" | "enabled" | "installed" | "availability" | "status"
  >,
): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.availability !== "unavailable" &&
    PROVIDER_SIGN_IN_DRIVERS.has(provider.driver) &&
    !providerSignInSettled(provider)
  );
}

/** Looked up in the lists themselves: a module-level set would stay in bundles that never ask. */
function isClaudeNonLoginVariable(name: string): boolean {
  return (
    (CLAUDE_NON_LOGIN_CREDENTIAL_VARIABLES as readonly string[]).includes(name) ||
    (CLAUDE_THIRD_PARTY_PROVIDER_FLAGS as readonly string[]).includes(name)
  );
}

/**
 * Whether the instance's own settings name a variable that keeps Claude Code off the local
 * login, such as a CLIProxyAPI hub's `ANTHROPIC_BASE_URL`. By name alone: a client never sees
 * the values, so a flag set to "0" counts too. The node checks the values, and its own ambient
 * environment, before it starts a sign-in.
 */
export function claudeInstanceSkipsLogin(instance: ProviderInstanceConfig | undefined): boolean {
  return (
    instance?.environment?.some((variable) => isClaudeNonLoginVariable(variable.name)) ?? false
  );
}

/**
 * Whether a client offers Sign in for an instance: it needs a sign-in (`providerNeedsSignIn`), a
 * proxied Claude instance is left alone, and this session may start one.
 */
export function canOfferProviderSignIn(input: {
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
