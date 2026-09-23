import type { ModelCapabilities, ModelSelection, ProviderOptionSelection } from "@ryco/contracts";
import type { ModelFavorite } from "@ryco/contracts/settings";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@ryco/shared/model";

// Driver-declared effort controls. Do not infer from the first select: it may
// be an OpenCode agent or a Cursor context-window control.
const EFFORT_OPTION_IDS = new Set(["reasoningEffort", "effort", "reasoning", "variant"]);

/** Identity uses stored intent, never a runtime fallback or a provider display name. */
export function modelFavoriteKey(favorite: ModelFavorite): string {
  return JSON.stringify([favorite.provider, favorite.model, favorite.reasoningEffort ?? null]);
}

export function uniqueModelFavorites(favorites: ReadonlyArray<ModelFavorite>): ModelFavorite[] {
  const seen = new Set<string>();
  return favorites.filter((favorite) => {
    const key = modelFavoriteKey(favorite);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function toggleModelFavorite(
  favorites: ReadonlyArray<ModelFavorite>,
  favorite: ModelFavorite,
): ModelFavorite[] {
  const key = modelFavoriteKey(favorite);
  const unique = uniqueModelFavorites(favorites);
  return unique.some((item) => modelFavoriteKey(item) === key)
    ? unique.filter((item) => modelFavoriteKey(item) !== key)
    : [...unique, favorite];
}

/** Model-level settings edits retain all presets for models that remain starred. */
export function updateInstanceModelFavorites(
  favorites: ReadonlyArray<ModelFavorite>,
  provider: ModelFavorite["provider"],
  models: ReadonlyArray<string>,
): ModelFavorite[] {
  const wanted = new Set(models.map((model) => model.trim()).filter(Boolean));
  const retained = uniqueModelFavorites(favorites).filter(
    (favorite) => favorite.provider !== provider || wanted.has(favorite.model),
  );
  for (const model of wanted) {
    if (!retained.some((favorite) => favorite.provider === provider && favorite.model === model))
      retained.push({ provider, model });
  }
  return retained;
}

export function getFavoriteEffort(
  caps: ModelCapabilities | null | undefined,
  options?: ReadonlyArray<ProviderOptionSelection>,
) {
  if (!caps) return undefined;
  const descriptor = getProviderOptionDescriptors({ caps, selections: options }).find(
    (option) => option.type === "select" && EFFORT_OPTION_IDS.has(option.id),
  );
  if (!descriptor || descriptor.type !== "select") return undefined;
  const value = getProviderOptionCurrentValue(descriptor);
  // Empty/stale descriptors and prompt-only modes cannot be restored by a model preset.
  const choice = descriptor.options.find(
    (choice) => choice.id === value && !descriptor.promptInjectedValues?.includes(choice.id),
  );
  return choice ? { id: descriptor.id, value: choice.id, label: choice.label } : undefined;
}

export function createModelFavorite(
  selection: ModelSelection,
  caps: ModelCapabilities | null | undefined,
): ModelFavorite {
  const effort = getFavoriteEffort(caps, selection.options);
  return {
    provider: selection.instanceId,
    model: selection.model,
    ...(effort ? { reasoningEffort: effort.value } : {}),
  };
}

/** Apply only model + effort, retaining supported destination options. No runtime/permission state enters this API. */
export function applyModelFavorite(
  favorite: ModelFavorite,
  current: ModelSelection,
  caps: ModelCapabilities | null | undefined,
): ModelSelection {
  const base = { instanceId: favorite.provider, model: favorite.model };
  if (!caps) return base;
  const descriptors = getProviderOptionDescriptors({ caps, selections: current.options });
  const next = descriptors.map((descriptor) => {
    if (
      favorite.reasoningEffort === undefined ||
      descriptor.type !== "select" ||
      !EFFORT_OPTION_IDS.has(descriptor.id)
    )
      return descriptor;
    const choice = descriptor.options.find(
      (choice) =>
        choice.id === favorite.reasoningEffort &&
        !descriptor.promptInjectedValues?.includes(choice.id),
    );
    return choice ? Object.assign({}, descriptor, { currentValue: choice.id }) : descriptor;
  });
  const options = buildProviderOptionSelectionsFromDescriptors(next)?.filter((option) => {
    const descriptor = next.find((descriptor) => descriptor.id === option.id)!;
    return (
      descriptor.type === "boolean" ||
      descriptor.options.some(
        (choice) =>
          choice.id === option.value && !descriptor.promptInjectedValues?.includes(choice.id),
      )
    );
  });
  return options?.length ? { ...base, options } : base;
}
