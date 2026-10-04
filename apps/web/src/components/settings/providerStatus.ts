import type {
  ServerProvider,
  ServerProviderCompatibilityAdvisory,
  ServerProviderVersionAdvisory,
} from "@ryco/contracts";
import { isBlockingProviderCompatibilityStatus } from "@ryco/shared/providerCapabilities";

/**
 * Visual treatment for each server-reported provider status. Centralized so
 * the default-driver card and per-instance cards share the same language.
 */
export const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-warning",
  },
  error: {
    dot: "bg-destructive",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

export type ProviderStatusKey = keyof typeof PROVIDER_STATUS_STYLES;

/**
 * Derive the headline + detail copy shown under a provider's name in the
 * settings page. Prefers `provider.message` for server-supplied detail and
 * falls back to generic phrasing when the server has not yet reported any
 * state — which happens before the first probe or when an instance names a
 * driver this build does not ship.
 */
export function getProviderSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return {
      headline: "Checking provider status",
      detail: "Waiting for the server to report installation and authentication details.",
    };
  }
  if (!provider.enabled) {
    return {
      headline: "Disabled",
      detail:
        provider.message ?? "This provider is installed but disabled for new sessions in Ryco.",
    };
  }
  if (!provider.installed) {
    return {
      headline: "Not found",
      detail: provider.message ?? "CLI not detected on PATH.",
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `Authenticated · ${authLabel}` : "Authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      headline: "Not authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: "Needs attention",
      detail:
        provider.message ?? "The provider is installed, but the server could not fully verify it.",
    };
  }
  if (provider.status === "error") {
    return {
      headline: "Unavailable",
      detail: provider.message ?? "The provider failed its startup checks.",
    };
  }
  return {
    headline: "Available",
    detail: provider.message ?? "Installed and ready, but authentication could not be verified.",
  };
}

/**
 * Normalize a version string for display. Adds the `v` prefix when the
 * driver reported a bare version (e.g. `1.2.3`) so cards render
 * consistently regardless of driver.
 */
export function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  return version.startsWith("v") ? version : `v${version}`;
}

/**
 * The update offer for a provider card. `null` when the provider is current or its latest version
 * is rated unsupported/broken for this Ryco release (the server refuses to install it, so the card
 * stops offering it; `getProviderCompatibilityNotice` explains why).
 */
export function getProviderVersionAdvisoryPresentation(
  advisory: ServerProviderVersionAdvisory | undefined,
  compatibility?: ServerProviderCompatibilityAdvisory | undefined,
): {
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly emphasis: "normal" | "strong";
} | null {
  if (!advisory || advisory.status === "current" || advisory.status === "unknown") {
    return null;
  }
  if (isBlockingProviderCompatibilityStatus(compatibility?.latestVersionStatus)) {
    return null;
  }

  const label = "Update available";
  const version = advisory.latestVersion;
  const versionLabel = getProviderVersionLabel(version);

  return {
    detail:
      advisory.message ??
      (versionLabel
        ? `${label}: install ${versionLabel}.`
        : `${label}: install the latest provider version.`),
    updateCommand: advisory.updateCommand,
    emphasis: "normal" as const,
  };
}

/**
 * One plain line of compatibility copy for a provider card, or `null`. Silent for disabled
 * providers and for `error` status: the summary already carries the gate message there, and the
 * card never repeats a fact.
 */
export function getProviderCompatibilityNotice(provider: ServerProvider | undefined): {
  readonly tone: "muted" | "warning";
  readonly text: string;
} | null {
  const compatibility = provider?.compatibilityAdvisory;
  if (!provider || !compatibility || !provider.enabled || provider.status === "error") {
    return null;
  }
  if (isBlockingProviderCompatibilityStatus(compatibility.status) && compatibility.message) {
    return { tone: "warning", text: compatibility.message };
  }
  if (compatibility.status === "graceful" && compatibility.message) {
    return { tone: "muted", text: compatibility.message };
  }
  const versionAdvisory = provider.versionAdvisory;
  if (
    versionAdvisory?.status === "behind_latest" &&
    versionAdvisory.latestVersion &&
    isBlockingProviderCompatibilityStatus(compatibility.latestVersionStatus)
  ) {
    return {
      tone: "muted",
      text: `${getProviderVersionLabel(versionAdvisory.latestVersion)} is available, but it is not compatible with this Ryco release, so Ryco won't offer it.`,
    };
  }
  return null;
}
