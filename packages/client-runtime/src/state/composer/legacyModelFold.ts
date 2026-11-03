export interface LegacyFoldable {
  readonly isLegacy?: boolean | undefined;
  readonly isCustom?: boolean | undefined;
}

export interface LegacyModelSplit<T> {
  readonly current: ReadonlyArray<T>;
  readonly legacy: ReadonlyArray<T>;
}

/**
 * Whether a row belongs in the collapsed "Legacy models" section: the server
 * marked it legacy, it is not a custom model, and it is not pinned (a favorite
 * or the active selection).
 */
export function foldsAsLegacy<T extends LegacyFoldable>(
  model: T,
  isPinned: (model: T) => boolean,
): boolean {
  return model.isLegacy === true && model.isCustom !== true && !isPinned(model);
}

/**
 * Splits one instance's ordered model rows into the ones a picker lists and
 * the ones it folds into a collapsed "Legacy models" section (see
 * `foldsAsLegacy`). Both parts keep the input order. When every row would
 * fold, nothing does: an instance never opens on a lone section row.
 */
export function splitLegacyModels<T extends LegacyFoldable>(
  models: ReadonlyArray<T>,
  isPinned: (model: T) => boolean,
): LegacyModelSplit<T> {
  const current: T[] = [];
  const legacy: T[] = [];
  for (const model of models) {
    (foldsAsLegacy(model, isPinned) ? legacy : current).push(model);
  }
  return current.length === 0 ? { current: models, legacy: [] } : { current, legacy };
}
