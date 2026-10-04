import type { ProviderDriverKind, ServerProviderCompatibilityStatus } from "@ryco/contracts";

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
