import type {
  EffectiveProjectPreferences,
  EnvironmentApi,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ServerConfig,
  ServerProvider,
} from "@ryco/contracts";
import {
  isProviderDefinitelyUnusable,
  isProviderKnownUnusable,
  isProviderReady,
} from "@ryco/shared/providerCapabilities";

import { getDefaultProviderModel } from "../composer/providerModels.ts";

/** Fresh drafts replace traits exactly; omission is not a request to retain sticky traits. */
export function initialDraftModelSelection(input: {
  readonly effective: EffectiveProjectPreferences | null;
  readonly fallback: ModelSelection;
  readonly explicit?: ModelSelection | undefined;
}): ModelSelection {
  const selection =
    input.explicit ?? input.effective?.initialModelSelection.value ?? input.fallback;
  return { ...selection, options: selection.options ?? [] };
}

/** The composer's last-used model selection (what `applyStickyState` seeds a draft with). */
export interface StickyModelSelectionState {
  readonly stickyActiveProvider: ProviderInstanceId | null;
  readonly stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
}

/**
 * The model a fresh draft opens on, or null to keep what `applyStickyState`
 * seeded. A caller's explicit choice wins as-is. A project or node preference
 * wins over the last-used selection; Ryco's built-in default only stands in
 * when there is none. A choice on a provider the node reports signed out,
 * failing, disabled or missing moves to the last-used selection, then the
 * built-in default, else to the first ready provider, when one of those can
 * run; a provider not probed yet keeps it. A configured project or node model
 * moves only when its provider is missing, signed out, off or not installed,
 * not when a probe failed or timed out.
 */
export function resolveNewDraftModelSelection(input: {
  readonly effective: EffectiveProjectPreferences | null;
  readonly explicit?: ModelSelection | undefined;
  readonly sticky: StickyModelSelectionState;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ModelSelection | null {
  const { effective, explicit, sticky, providers } = input;
  if (explicit) return initialDraftModelSelection({ effective, fallback: explicit, explicit });
  const stickyOf = (instanceId: ProviderInstanceId) => {
    const selection = sticky.stickyModelSelectionByProvider[instanceId];
    return selection ? { ...selection, options: selection.options ?? [] } : null;
  };
  const lastUsed = sticky.stickyActiveProvider ? stickyOf(sticky.stickyActiveProvider) : null;
  const preference = effective?.initialModelSelection;
  const preferred = preference
    ? preference.source === "builtin" && lastUsed
      ? lastUsed
      : initialDraftModelSelection({ effective, fallback: preference.value })
    : lastUsed;
  if (!preferred || providers.length === 0) return preferred;
  const builtin =
    preference?.source === "builtin"
      ? initialDraftModelSelection({ effective, fallback: preference.value })
      : null;
  const snapshotOf = (selection: ModelSelection | null) =>
    selection
      ? providers.find((provider) => provider.instanceId === selection.instanceId)
      : undefined;
  // A provider the node doesn't list (deleted, or another node's) cannot run the draft; one it
  // hasn't probed yet reports a pending snapshot, which is no reason to move.
  const canRun = (
    selection: ModelSelection | null,
    unusable: (provider: ServerProvider) => boolean = isProviderKnownUnusable,
  ): selection is ModelSelection => {
    const snapshot = snapshotOf(selection);
    return snapshot !== undefined && !unusable(snapshot);
  };
  const configured = preference !== undefined && preference.source !== "builtin";
  if (canRun(preferred, configured ? isProviderDefinitelyUnusable : isProviderKnownUnusable))
    return preferred;
  if (canRun(lastUsed)) return lastUsed;
  if (canRun(builtin)) return builtin;
  const ready = providers.find(isProviderReady);
  // Nothing else can run: keep the choice, unless the node doesn't list it.
  if (!ready) return snapshotOf(preferred) || !builtin ? preferred : builtin;
  return (
    stickyOf(ready.instanceId) ?? {
      instanceId: ready.instanceId,
      model: getDefaultProviderModel(ready.models, ready.driver),
      options: [],
    }
  );
}

/** Never infer support from cached values or fall back after a capable node fails. */
export async function readEffectiveProjectPreferences(input: {
  readonly api: EnvironmentApi;
  readonly config: ServerConfig | null | undefined;
  readonly projectId?: ProjectId;
}): Promise<EffectiveProjectPreferences | null> {
  if (input.config?.environment.capabilities.projectPreferences !== true) return null;
  const read = input.api.server?.getProjectPreferences;
  if (!read) throw new Error("Project preferences are unavailable on this connection.");
  return read(input.projectId === undefined ? {} : { projectId: input.projectId });
}
