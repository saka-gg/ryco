/**
 * What a provider snapshot says about its sign-in, read the same way by the node that verifies a
 * login and by the clients that offer one.
 *
 * @module providerSignIn
 */
import type { ServerProvider } from "@ryco/contracts";

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
