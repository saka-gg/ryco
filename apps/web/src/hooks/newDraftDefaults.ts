import { readEffectiveProjectPreferences } from "@ryco/client-runtime/state/settings";
import type {
  EffectiveProjectPreferences,
  EnvironmentApi,
  EnvironmentId,
  ProjectId,
  ServerConfig,
} from "@ryco/contracts";

export interface NewDraftDefaults {
  readonly config: ServerConfig;
  readonly effective: EffectiveProjectPreferences | null;
  /**
   * Present when `effective` came from this session's last answer for the same
   * project: the node's current answer, read in the background. The caller
   * applies it if it differs and the draft is still untouched.
   */
  readonly fresh?: Promise<EffectiveProjectPreferences | null>;
}

/**
 * The last effective preferences each node gave for each project (or for its
 * defaults), so the next new draft opens at once with them while the node is
 * asked again. Preferences change rarely, and a change is corrected by the
 * background read before the user acts on the draft in almost every case.
 */
const effectivePreferencesCache = new Map<string, EffectiveProjectPreferences>();

const preferencesCacheKey = (environmentId: EnvironmentId, projectId: ProjectId | undefined) =>
  `${environmentId}\u0000${projectId ?? ""}`;

/** This session's last answer for a project's effective preferences, if any. */
export function readRememberedProjectPreferences(
  environmentId: EnvironmentId,
  projectId: ProjectId | undefined,
): EffectiveProjectPreferences | null {
  return effectivePreferencesCache.get(preferencesCacheKey(environmentId, projectId)) ?? null;
}

/**
 * Asks the node for a project's effective preferences and remembers the
 * answer. `null` when the node does not support project preferences.
 */
export async function readAndRememberProjectPreferences(input: {
  readonly api: EnvironmentApi;
  readonly environmentId: EnvironmentId;
  readonly config: ServerConfig | null;
  readonly projectId?: ProjectId | undefined;
}): Promise<EffectiveProjectPreferences | null> {
  const cacheKey = preferencesCacheKey(input.environmentId, input.projectId);
  const effective = await readEffectiveProjectPreferences({
    api: input.api,
    config: input.config,
    ...(input.projectId ? { projectId: input.projectId } : {}),
  });
  if (effective) effectivePreferencesCache.set(cacheKey, effective);
  else effectivePreferencesCache.delete(cacheKey);
  return effective;
}

export function resetNewDraftDefaultsCacheForTests(): void {
  effectivePreferencesCache.clear();
}

type SettledRead<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: unknown };

function settle<A>(promise: Promise<A>): Promise<SettledRead<A>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
}

function unwrap<A>(read: SettledRead<A>): A {
  if (read.ok) return read.value;
  throw read.error;
}

/**
 * Reads the owning node's defaults for a fresh draft (its server config and,
 * when supported, the effective project preferences).
 *
 * - `cachedConfig` is the environment's live config, kept current by its
 *   `subscribeConfig` stream. When `requireFreshConfig` is false it is used
 *   as-is, so the only round trip left is the (small) preferences read: the
 *   ~100 KB `getConfig` and its decode are skipped entirely. When this session
 *   already has the node's answer for the project, that read moves off the
 *   path too (`fresh`), and the draft opens with no round trip at all.
 * - Hosted targets pass `requireFreshConfig`: the primary cache can still hold
 *   the previous node's settings while switching targets, so the config is
 *   read from the scoped connection. When the cache already shows the
 *   preferences capability, the preferences read starts in parallel with it;
 *   its result is used only if the fresh config confirms the capability (a
 *   cached value never decides support).
 */
export async function readNewDraftDefaults(input: {
  readonly api: EnvironmentApi;
  readonly environmentId: EnvironmentId;
  readonly cachedConfig: ServerConfig | null;
  readonly requireFreshConfig: boolean;
  readonly projectId?: ProjectId | undefined;
}): Promise<NewDraftDefaults> {
  const preferences = (config: ServerConfig) =>
    readAndRememberProjectPreferences({
      api: input.api,
      environmentId: input.environmentId,
      config,
      projectId: input.projectId,
    });

  if (!input.requireFreshConfig && input.cachedConfig) {
    const config = input.cachedConfig;
    const remembered = readRememberedProjectPreferences(input.environmentId, input.projectId);
    // Support is decided by the live config, never by a remembered answer.
    if (remembered && config.environment.capabilities.projectPreferences === true) {
      const fresh = preferences(config);
      fresh.catch(() => undefined);
      return { config, effective: remembered, fresh };
    }
    return { config, effective: await preferences(config) };
  }

  const getConfig = input.api.server?.getConfig;
  if (!getConfig) throw new Error("Node settings are still loading. Try creating the draft again.");
  const speculative =
    input.cachedConfig?.environment.capabilities.projectPreferences === true
      ? settle(preferences(input.cachedConfig))
      : null;
  const config = await getConfig();
  if (config.environment.capabilities.projectPreferences !== true) {
    return { config, effective: null };
  }
  return { config, effective: speculative ? unwrap(await speculative) : await preferences(config) };
}
