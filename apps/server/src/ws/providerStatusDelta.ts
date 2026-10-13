import type {
  ServerConfigProviderStatusesDeltaPayload,
  ServerProvider,
  ServerProviderStatusUpdate,
} from "@ryco/contracts";

/**
 * The catalog fields of a provider status: large (models, skills and slash
 * commands are ~95% of a provider list's bytes) and rarely changing.
 */
const CATALOG_KEYS = ["models", "skills", "slashCommands"] as const;
type CatalogKey = (typeof CATALOG_KEYS)[number];

// Every subscriber receives the same provider objects from the registry, so a
// value's JSON is measured once however many streams compare it.
const jsonCache = new WeakMap<object, string>();
const jsonOf = (value: object): string => {
  let json = jsonCache.get(value);
  if (json === undefined) {
    json = JSON.stringify(value);
    jsonCache.set(value, json);
  }
  return json;
};

const statusJsonCache = new WeakMap<ServerProvider, string>();
/** The provider without its catalogs, as JSON. */
const statusJsonOf = (provider: ServerProvider): string => {
  let json = statusJsonCache.get(provider);
  if (json === undefined) {
    const { models: _models, skills: _skills, slashCommands: _slashCommands, ...status } = provider;
    json = JSON.stringify(status);
    statusJsonCache.set(provider, json);
  }
  return json;
};

const sameValue = (left: object, right: object): boolean =>
  left === right || jsonOf(left) === jsonOf(right);

/**
 * What one config subscription has sent of the provider list, so each later
 * change goes out as a `providerStatusesDelta`: only the instances that
 * changed, and of those only the catalogs that changed. The stream that owns
 * a tracker must send every payload it returns, in order: the client applies
 * a delta to exactly what this stream sent before.
 */
export interface ProviderStatusDeltaTracker {
  /** The delta from what was last sent to `providers`; `null` when nothing changed. */
  readonly next: (
    providers: ReadonlyArray<ServerProvider>,
  ) => ServerConfigProviderStatusesDeltaPayload | null;
}

export function makeProviderStatusDeltaTracker(
  sent: ReadonlyArray<ServerProvider>,
): ProviderStatusDeltaTracker {
  let sentById = new Map(sent.map((provider) => [provider.instanceId, provider] as const));
  let sentOrder = sent.map((provider) => provider.instanceId);
  return {
    next: (providers) => {
      const changed: Array<ServerProviderStatusUpdate> = [];
      for (const provider of providers) {
        const previous = sentById.get(provider.instanceId);
        if (previous === provider) continue;
        if (previous === undefined) {
          changed.push(provider);
          continue;
        }
        const catalogsChanged = CATALOG_KEYS.filter(
          (key) => !sameValue(previous[key], provider[key]),
        );
        if (catalogsChanged.length === 0 && statusJsonOf(previous) === statusJsonOf(provider)) {
          continue;
        }
        changed.push(withCatalogs(provider, catalogsChanged));
      }
      const order = providers.map((provider) => provider.instanceId);
      const reordered =
        order.length !== sentOrder.length || order.some((id, index) => id !== sentOrder[index]);
      sentById = new Map(providers.map((provider) => [provider.instanceId, provider] as const));
      sentOrder = order;
      if (changed.length === 0 && !reordered) return null;
      return { instanceIds: order, providers: changed };
    },
  };
}

function withCatalogs(
  provider: ServerProvider,
  keep: ReadonlyArray<CatalogKey>,
): ServerProviderStatusUpdate {
  const { models, skills, slashCommands, ...status } = provider;
  const catalogs = { models, skills, slashCommands };
  const update: Record<string, unknown> = { ...status };
  for (const key of keep) update[key] = catalogs[key];
  return update as ServerProviderStatusUpdate;
}
