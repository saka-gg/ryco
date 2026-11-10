/**
 * Config sections a client can hold by digest (`ServerConfigSectionName`), like provider
 * catalogs (providerCatalogs.ts): settings and keybindings are about 10 KB of every config
 * snapshot and rarely change between a client's reconnects. A client names the digests it holds;
 * the snapshot sends those sections as placeholders and says which, and every section's digest,
 * so the client restores them from what it holds.
 *
 * @module configSections
 */
import { createHash } from "node:crypto";
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerConfig,
  type ServerConfigSectionName,
  type ServerConfigSections,
  type ServerProviderCatalogDigest,
} from "@ryco/contracts";

const digestCache = new WeakMap<object, ServerProviderCatalogDigest>();

/** Content digest of one section's value; equal values share a digest across restarts. */
export function configSectionDigest(
  name: ServerConfigSectionName,
  value: object,
): ServerProviderCatalogDigest {
  let digest = digestCache.get(value);
  if (digest === undefined) {
    digest = createHash("sha256")
      .update(JSON.stringify([name, value]), "utf8")
      .digest("base64url") as ServerProviderCatalogDigest;
    digestCache.set(value, digest);
  }
  return digest;
}

/**
 * The config snapshot for a client that holds the sections `known` names: those go out as
 * placeholders, and `configSections` says which and every section's digest.
 */
export function omitKnownConfigSections(
  config: ServerConfig,
  known: ReadonlyArray<string>,
): { readonly config: ServerConfig; readonly configSections: ServerConfigSections } {
  const knownDigests = new Set(known);
  const digests = {
    settings: configSectionDigest("settings", config.settings),
    keybindings: configSectionDigest("keybindings", config.keybindings),
  };
  const omitted: Array<ServerConfigSectionName> = [];
  let next = config;
  if (knownDigests.has(digests.settings)) {
    omitted.push("settings");
    next = { ...next, settings: DEFAULT_SERVER_SETTINGS };
  }
  if (knownDigests.has(digests.keybindings)) {
    omitted.push("keybindings");
    next = { ...next, keybindings: [] };
  }
  return { config: next, configSections: { digests, omitted } };
}
