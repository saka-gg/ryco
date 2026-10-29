import type {
  ProviderDriverKind,
  ServerProvider,
  ServerProviderCompatibilityStatus,
} from "@ryco/contracts";

/**
 * Every driver now accepts general file attachments. Providers without a
 * native arbitrary-file channel (Codex, Claude, Cursor, Grok) degrade them
 * into on-disk path lines appended to the turn prompt, while Copilot and
 * OpenCode ingest the bytes natively. Per-adapter native gating lives in
 * each adapter.
 */
export function providerSupportsGeneralFileAttachments(_provider: ProviderDriverKind): boolean {
  return true;
}

/** Ratings for which Ryco refuses to install a version and stops offering it as an update. */
export function isBlockingProviderCompatibilityStatus(
  status: ServerProviderCompatibilityStatus | null | undefined,
): boolean {
  return status === "unsupported" || status === "broken";
}

type ProviderReadinessFields = Pick<ServerProvider, "enabled" | "status" | "availability" | "auth">;

/**
 * The provider's last status probe says it cannot run work: it is disabled, its
 * driver is unavailable, the probe failed, or it is signed out. A provider not
 * probed yet is not counted (its pending snapshot reports `warning` with an
 * unknown sign-in), so callers keep their usual behaviour until a probe answers.
 */
export function isProviderKnownUnusable(provider: ProviderReadinessFields): boolean {
  return (
    !provider.enabled ||
    provider.availability === "unavailable" ||
    provider.status === "error" ||
    provider.status === "disabled" ||
    provider.auth.status === "unauthenticated"
  );
}

/**
 * The provider cannot run work until the user acts: it is disabled, its driver
 * is unavailable, its CLI is not installed, or it is signed out. Unlike
 * {@link isProviderKnownUnusable}, a probe that failed or timed out without
 * finding one of those is not counted, since the next probe may pass.
 */
export function isProviderDefinitelyUnusable(
  provider: ProviderReadinessFields & Pick<ServerProvider, "installed">,
): boolean {
  return (
    !provider.enabled ||
    provider.availability === "unavailable" ||
    provider.status === "disabled" ||
    provider.auth.status === "unauthenticated" ||
    (provider.status === "error" && !provider.installed)
  );
}

/** The provider is set up and its last probe found it ready to run work. */
export function isProviderReady(provider: ProviderReadinessFields): boolean {
  return provider.status === "ready" && !isProviderKnownUnusable(provider);
}
