/**
 * Config sections (`ServerConfigSectionName`: settings, keybindings) a client was sent, by
 * content digest, like provider catalogs (providerCatalogCache.ts). A config subscription names
 * the digests it holds (`knownConfigSections`) and the server sends those sections as
 * placeholders; `restoreSnapshotSections` puts the held ones back before anyone sees the
 * snapshot. Kept in memory only: it spares reconnects of a running app, not cold starts.
 *
 * @module configSectionCache
 */
import type {
  ServerConfig,
  ServerConfigSectionName,
  ServerConfigStreamSnapshotEvent,
} from "@ryco/contracts";

export type ConfigSectionValue =
  | { readonly name: "settings"; readonly value: ServerConfig["settings"] }
  | { readonly name: "keybindings"; readonly value: ServerConfig["keybindings"] };

export const CONFIG_SECTION_CACHE_MAX_ENTRIES = 8;

export interface ConfigSectionCache {
  /** What a subscription about to start can claim, kept for that subscription alone. */
  readonly pin: () => ReadonlyMap<string, ConfigSectionValue>;
  readonly put: (digest: string, section: ConfigSectionValue) => void;
  readonly clear: () => void;
}

export function createConfigSectionCache(
  maxEntries: number = CONFIG_SECTION_CACHE_MAX_ENTRIES,
): ConfigSectionCache {
  const entries = new Map<string, ConfigSectionValue>();
  return {
    pin: () => new Map(entries),
    put: (digest, section) => {
      entries.delete(digest);
      entries.set(digest, section);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    clear: () => entries.clear(),
  };
}

/** The page's config section cache. */
export const configSectionCache = createConfigSectionCache();

/**
 * The snapshot with every section the server left out restored from `pinned` (what the
 * subscription claimed to hold), after keeping each section it did send. `null` when the server
 * left out a section the subscription never claimed: that snapshot cannot be completed.
 */
export function restoreSnapshotSections(
  event: ServerConfigStreamSnapshotEvent,
  pinned: ReadonlyMap<string, ConfigSectionValue>,
  cache: ConfigSectionCache,
): ServerConfigStreamSnapshotEvent | null {
  const sections = event.configSections;
  if (sections === undefined) return event;
  const omitted = new Set<ServerConfigSectionName>(sections.omitted);
  let config = event.config;
  for (const name of ["settings", "keybindings"] as const) {
    const digest = sections.digests[name];
    if (!omitted.has(name)) {
      cache.put(
        digest,
        name === "settings"
          ? { name, value: event.config.settings }
          : { name, value: event.config.keybindings },
      );
      continue;
    }
    const held = pinned.get(digest);
    if (held === undefined || held.name !== name) return null;
    cache.put(digest, held);
    config =
      held.name === "settings"
        ? { ...config, settings: held.value }
        : { ...config, keybindings: held.value };
  }
  const { configSections: _configSections, ...rest } = event;
  return { ...rest, config };
}
