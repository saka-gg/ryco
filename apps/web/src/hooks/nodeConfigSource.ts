import type { EnvironmentApi, EnvironmentId, ServerConfig } from "@ryco/contracts";

import { readEnvironmentConnection } from "../environments/runtime";
import { readEnvironmentServerConfig } from "./useChatsAvailability";

/** Where a new draft or a first send takes the owning node's config from. */
export interface NodeConfigSource {
  /** The config to use as-is unless `requireFreshConfig`; otherwise only a hint. */
  readonly cachedConfig: ServerConfig | null;
  /** No config is known to be current: read the node's config before using it. */
  readonly requireFreshConfig: boolean;
}

/**
 * Resolves the config a new draft or a first send may trust.
 *
 * - Direct targets: the environment's cached config, which its config stream
 *   keeps current.
 * - Hosted targets (`currentOnly`): only the connection's live config, which
 *   it returns solely for the current socket attempt and hosted lifecycle
 *   generation while connected. The primary cache can still hold the previous
 *   node's settings while switching targets, so it is never trusted here. With
 *   no current live config (a node switch, a reconnect, a generation that just
 *   ended) the caller reads the config fresh, and the cache stays a hint only.
 */
export function resolveNodeConfigSource(
  environmentId: EnvironmentId,
  options: { readonly currentOnly: boolean },
): NodeConfigSource {
  if (options.currentOnly) {
    const live = readEnvironmentConnection(environmentId)?.config.read() ?? null;
    if (live) return { cachedConfig: live, requireFreshConfig: false };
    return { cachedConfig: readEnvironmentServerConfig(environmentId), requireFreshConfig: true };
  }
  return { cachedConfig: readEnvironmentServerConfig(environmentId), requireFreshConfig: false };
}

/** The source's config, read from the node when it requires a fresh one or has none. */
export async function readNodeConfig(
  source: NodeConfigSource,
  api: EnvironmentApi,
): Promise<ServerConfig | null> {
  if (!source.requireFreshConfig && source.cachedConfig) return source.cachedConfig;
  return (await api.server?.getConfig?.()) ?? null;
}
