import type { ServerProvider, SessionImportSource, SessionImportStore } from "@ryco/contracts";

/** What choosing who continues an imported conversation reads of a provider. */
export type SessionImportContinuationProvider = Pick<
  ServerProvider,
  "instanceId" | "driver" | "enabled" | "installed" | "availability" | "displayName" | "models"
>;

/**
 * The provider instances that can continue conversations read from `store`:
 * enabled, installed and available instances of the source's own driver that
 * use that store. Empty without a store.
 */
export function sessionImportContinuationProviders<P extends SessionImportContinuationProvider>(
  providers: readonly P[],
  source: SessionImportSource,
  store: SessionImportStore | undefined,
): P[] {
  if (!store) return [];
  return providers.filter(
    (provider) =>
      provider.driver === source &&
      provider.enabled &&
      provider.installed &&
      provider.availability !== "unavailable" &&
      store.instanceIds.includes(provider.instanceId),
  );
}

/**
 * The instance and model an import continues with: the chosen ones while
 * they are still offered, else the first instance and its default (or first)
 * model. Both are undefined when nothing can continue.
 */
export function resolveSessionImportContinuation<P extends SessionImportContinuationProvider>(
  providers: readonly P[],
  choice: { readonly instanceId: string; readonly model: string },
): { readonly provider: P | undefined; readonly model: P["models"][number] | undefined } {
  const provider =
    providers.find((entry) => entry.instanceId === choice.instanceId) ?? providers[0];
  const model =
    provider?.models.find((entry) => entry.slug === choice.model) ??
    provider?.models.find((entry) => entry.isDefault) ??
    provider?.models[0];
  return { provider, model };
}
