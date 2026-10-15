import { readEffectiveProjectPreferences } from "@ryco/client-runtime/state/settings";
import * as Equal from "effect/Equal";
import type { ComposerThreadDraftState, DraftThreadState } from "../composerDraftStore";
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
 *
 * Each answer keeps the node settings it was read under: once the node's
 * settings differ (project or device defaults saved here or on another
 * client), the answer is no longer trusted and the next draft waits for the
 * node instead of opening with the old defaults.
 */
interface RememberedProjectPreferences {
  readonly settings: ServerConfig["settings"] | undefined;
  readonly effective: EffectiveProjectPreferences;
}

const effectivePreferencesCache = new Map<string, RememberedProjectPreferences>();

const preferencesCacheKey = (environmentId: EnvironmentId, projectId: ProjectId | undefined) =>
  `${environmentId}\u0000${projectId ?? ""}`;

const sameSettings = (
  left: ServerConfig["settings"] | undefined,
  right: ServerConfig["settings"] | undefined,
) => left === right || (left !== undefined && right !== undefined && Equal.equals(left, right));

/** Whether this session has an answer for the project, before it can be checked against a config. */
export function hasRememberedProjectPreferences(
  environmentId: EnvironmentId,
  projectId: ProjectId | undefined,
): boolean {
  return effectivePreferencesCache.has(preferencesCacheKey(environmentId, projectId));
}

/**
 * This session's last answer for a project's effective preferences, if any,
 * and only while `config` (the node's live config) still carries the settings
 * it was read under.
 */
export function readRememberedProjectPreferences(
  environmentId: EnvironmentId,
  projectId: ProjectId | undefined,
  config: ServerConfig | null,
): EffectiveProjectPreferences | null {
  if (!config) return null;
  const cacheKey = preferencesCacheKey(environmentId, projectId);
  const remembered = effectivePreferencesCache.get(cacheKey);
  if (!remembered) return null;
  if (!sameSettings(remembered.settings, config.settings)) {
    effectivePreferencesCache.delete(cacheKey);
    return null;
  }
  return remembered.effective;
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
  const settings = input.config?.settings;
  const effective = await readEffectiveProjectPreferences({
    api: input.api,
    config: input.config,
    ...(input.projectId ? { projectId: input.projectId } : {}),
  });
  if (effective) effectivePreferencesCache.set(cacheKey, { settings, effective });
  else effectivePreferencesCache.delete(cacheKey);
  return effective;
}

/** Forgets every remembered answer (account teardown). */
export function forgetRememberedProjectPreferences(): void {
  effectivePreferencesCache.clear();
}

export function resetNewDraftDefaultsCacheForTests(): void {
  forgetRememberedProjectPreferences();
}

/**
 * The draft fields a new draft's defaults seed: model, modes and work
 * location. A later difference in any of them is the user's own choice;
 * anything else (typing, attachments, the composer mounting) is not, so it
 * never stops the node's newer answer from replacing the remembered one. A
 * promoted (sent) or removed draft never matches.
 */
export function seededDraftDefaultsOf(
  composer: ComposerThreadDraftState | null | undefined,
  session: DraftThreadState | null | undefined,
): ReadonlyArray<unknown> {
  return [
    composer?.modelSelectionByProvider ?? {},
    composer?.activeProvider ?? null,
    composer?.runtimeMode ?? null,
    composer?.interactionMode ?? null,
    composer?.tokenMode ?? null,
    session === undefined || session === null,
    session?.environmentId ?? null,
    session?.projectId ?? null,
    session?.runtimeMode ?? null,
    session?.interactionMode ?? null,
    session?.tokenMode ?? null,
    session?.envMode ?? null,
    session?.branch ?? null,
    session?.worktreePath ?? null,
    session?.worktreeSource ?? null,
    session?.worktreeBranchName ?? null,
    session?.fetchOrigin ?? null,
    session?.promotedTo ?? null,
  ];
}

export function sameSeededDraftDefaults(
  left: ReadonlyArray<unknown>,
  right: ReadonlyArray<unknown>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, position) => value === right[position] || Equal.equals(value, right[position]),
    )
  );
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
    const remembered = readRememberedProjectPreferences(
      input.environmentId,
      input.projectId,
      config,
    );
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
