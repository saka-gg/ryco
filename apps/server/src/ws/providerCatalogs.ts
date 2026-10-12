import { createHash } from "node:crypto";
import type {
  ServerConfig,
  ServerConfigProviderCatalogs,
  ServerProvider,
  ServerProviderCatalogDigest,
} from "@ryco/contracts";

const digestCache = new WeakMap<ServerProvider, ServerProviderCatalogDigest>();

/**
 * Content digest of a provider's catalogs (models, skills, slash commands):
 * equal catalogs share a digest across providers, servers and restarts, so a
 * client can keep catalogs it was sent once and name them on its next
 * subscription instead of downloading them again.
 */
export function providerCatalogDigest(provider: ServerProvider): ServerProviderCatalogDigest {
  let digest = digestCache.get(provider);
  if (digest === undefined) {
    digest = createHash("sha256")
      .update(JSON.stringify([provider.models, provider.skills, provider.slashCommands]), "utf8")
      .digest("base64url") as ServerProviderCatalogDigest;
    digestCache.set(provider, digest);
  }
  return digest;
}

/**
 * The config snapshot for a client that holds the catalogs `known` names:
 * those providers go out with empty catalogs, and `providerCatalogs` says
 * which and every provider's digest so the client can restore and keep them.
 */
export function omitKnownProviderCatalogs(
  config: ServerConfig,
  known: ReadonlyArray<string>,
): { readonly config: ServerConfig; readonly providerCatalogs: ServerConfigProviderCatalogs } {
  const knownDigests = new Set(known);
  const digests: Record<string, ServerProviderCatalogDigest> = {};
  const omitted: Array<ServerProvider["instanceId"]> = [];
  const providers = config.providers.map((provider) => {
    const digest = providerCatalogDigest(provider);
    digests[provider.instanceId] = digest;
    if (!knownDigests.has(digest)) return provider;
    omitted.push(provider.instanceId);
    return { ...provider, models: [], skills: [], slashCommands: [] };
  });
  return {
    config: omitted.length === 0 ? config : { ...config, providers },
    providerCatalogs: { digests: digests as ServerConfigProviderCatalogs["digests"], omitted },
  };
}
