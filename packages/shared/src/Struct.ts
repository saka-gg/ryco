import * as P from "effect/Predicate";

export type DeepPartial<T> = T extends readonly (infer U)[]
  ? readonly DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/**
 * A parsed patch can carry `__proto__` as an own key, and assigning it would replace the result's
 * prototype. Every other key, `constructor` and `prototype` included, is assigned as data.
 */
const PROTOTYPE_KEY = "__proto__";

export function deepMerge<T extends Record<string, unknown>>(current: T, patch: DeepPartial<T>): T {
  if (!P.isObject(current) || !P.isObject(patch)) {
    return patch as T;
  }

  const next = { ...current } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || key === PROTOTYPE_KEY) continue;

    // Only own values merge: an inherited `constructor` or `toString` is not current data.
    const existing = Object.hasOwn(next, key) ? next[key] : undefined;
    next[key] = P.isObject(existing) && P.isObject(value) ? deepMerge(existing, value) : value;
  }

  return next as T;
}
