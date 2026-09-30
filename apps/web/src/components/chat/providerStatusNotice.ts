import type { ServerProvider } from "@ryco/contracts";
import { formatProviderDriverKindLabel } from "../../providerModels";

export interface ProviderStatusNotice {
  /** Changes whenever the instance, state, or message changes, so a dismissal
   * only hides the exact notice the user saw. */
  readonly key: string;
  readonly variant: "error" | "warning";
  readonly title: string;
  readonly description: string;
}

export function resolveProviderStatusNotice(
  status: ServerProvider | null,
): ProviderStatusNotice | null {
  if (!status || status.status === "ready" || status.status === "disabled") {
    return null;
  }
  const providerLabel = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const description =
    status.message ??
    (status.status === "error"
      ? `${providerLabel} provider is unavailable.`
      : `${providerLabel} provider has limited availability.`);
  return {
    key: `${status.instanceId}:${status.status}:${description}`,
    variant: status.status === "error" ? "error" : "warning",
    title: `${providerLabel} provider status`,
    description,
  };
}

// Session-scoped: a dismissed notice stays hidden across thread switches until
// the provider reports a different status or message, and returns on reload.
const dismissedProviderStatusNoticeKeys = new Set<string>();

export function isProviderStatusNoticeDismissed(key: string): boolean {
  return dismissedProviderStatusNoticeKeys.has(key);
}

export function dismissProviderStatusNotice(key: string): void {
  dismissedProviderStatusNoticeKeys.add(key);
}
