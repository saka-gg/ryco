/**
 * What a provider snapshot says about its sign-in, read the same way by the node that verifies a
 * login and by the clients that offer one.
 *
 * @module providerSignIn
 */
import type { ServerProvider } from "@ryco/contracts";

/**
 * Drivers a node can sign in from Ryco. The node decides per instance (`provider.signIn.subscribe`
 * reports why one is unavailable); clients use this only to know where to offer it.
 */
export const PROVIDER_SIGN_IN_DRIVERS: ReadonlySet<string> = new Set(["codex"]);

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
 * Whether to offer signing the instance in: it runs (enabled, installed, available), its driver
 * signs in from Ryco, and it reports no sign-in. An instance that is ready without knowing of an
 * account works without one, such as a Codex on a custom model provider (a CLIProxy-routed
 * Codex), whose sign-in could only fail; one whose check failed may still need it.
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
    !providerReportsSignIn(provider) &&
    !(provider.status === "ready" && provider.auth.status === "unknown")
  );
}
