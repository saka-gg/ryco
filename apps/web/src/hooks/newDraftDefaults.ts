import { readEffectiveProjectPreferences } from "@ryco/client-runtime/state/settings";
import type {
  EffectiveProjectPreferences,
  EnvironmentApi,
  ProjectId,
  ServerConfig,
} from "@ryco/contracts";

export interface NewDraftDefaults {
  readonly config: ServerConfig;
  readonly effective: EffectiveProjectPreferences | null;
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
 *   ~100 KB `getConfig` and its decode are skipped entirely.
 * - Hosted targets pass `requireFreshConfig`: the primary cache can still hold
 *   the previous node's settings while switching targets, so the config is
 *   read from the scoped connection. When the cache already shows the
 *   preferences capability, the preferences read starts in parallel with it;
 *   its result is used only if the fresh config confirms the capability (a
 *   cached value never decides support).
 */
export async function readNewDraftDefaults(input: {
  readonly api: EnvironmentApi;
  readonly cachedConfig: ServerConfig | null;
  readonly requireFreshConfig: boolean;
  readonly projectId?: ProjectId | undefined;
}): Promise<NewDraftDefaults> {
  const preferences = (config: ServerConfig) =>
    readEffectiveProjectPreferences({
      api: input.api,
      config,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    });

  if (!input.requireFreshConfig && input.cachedConfig) {
    const config = input.cachedConfig;
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
