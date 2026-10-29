/**
 * Custom model prices and model mappings for usage cost (`ServerSettings.usagePriceOverrides`),
 * shared by the node's usage pricing and the settings editor.
 *
 * Entries match model IDs case-insensitively, and a context variant such as `claude-x[1m]`
 * falls back to the entry of its base model `claude-x`. A mapping is followed to the end of
 * its chain; a chain that loops maps nothing. Placeholder models of responses no model
 * produced (`<synthetic>`) are never priced or mapped.
 *
 * @module usagePriceOverrides
 */
import type { UsagePriceOverride } from "@ryco/contracts/settings";

export type UsagePriceOverrideEntries = Iterable<
  readonly [model: string, override: UsagePriceOverride]
>;

export type UsagePriceOverrideIssueKind = "duplicate" | "self-map" | "loop" | "synthetic";

export interface UsagePriceOverrideIssue {
  /** The entry's model ID as given. */
  readonly key: string;
  readonly issue: UsagePriceOverrideIssueKind;
}

/** The key under which a model ID matches entries. */
export function normalizeUsageModelKey(model: string): string {
  return model.trim().toLowerCase();
}

const CONTEXT_VARIANT = /\[[^\]]*\]$/;

/** {@link normalizeUsageModelKey} without a context variant suffix such as `[1m]`. */
export function usageModelBaseKey(model: string): string {
  return normalizeUsageModelKey(model).replace(CONTEXT_VARIANT, "");
}

const SYNTHETIC_MODEL_NAMES = new Set(["<synthetic>", "synthetic"]);

/** Whether a model ID names responses that no model produced (never priced). */
export function isSyntheticUsageModel(model: string): boolean {
  const key = usageModelBaseKey(model);
  return SYNTHETIC_MODEL_NAMES.has(key.slice(key.lastIndexOf("/") + 1));
}

/** The key of a model ID's own entry, else of its base model's entry. */
export function matchUsageModelKey(
  entries: ReadonlyMap<string, unknown> | ReadonlySet<string>,
  model: string,
): string | undefined {
  const key = normalizeUsageModelKey(model);
  if (entries.has(key)) return key;
  const base = key.replace(CONTEXT_VARIANT, "");
  return base !== key && entries.has(base) ? base : undefined;
}

/**
 * Entries by normalized key. Of entries whose model IDs differ only in case, the first counts;
 * the editor reports the others ({@link validateUsagePriceOverrides}).
 */
export function indexUsagePriceOverrides(
  entries: UsagePriceOverrideEntries,
): Map<string, UsagePriceOverride> {
  const index = new Map<string, UsagePriceOverride>();
  for (const [model, override] of entries) {
    const key = normalizeUsageModelKey(model);
    if (!index.has(key)) index.set(key, override);
  }
  return index;
}

/** The model a mapping chain ends at (as typed in its last entry), or null when it loops. */
function followMapping(
  index: ReadonlyMap<string, UsagePriceOverride>,
  key: string,
  mapTo: string,
): string | null {
  const visited = new Set([key]);
  let target = mapTo;
  for (;;) {
    const next = matchUsageModelKey(index, target);
    const mapsOn = next === undefined ? undefined : index.get(next)?.mapTo;
    if (next === undefined || mapsOn === undefined) return target;
    if (visited.has(next)) return null;
    visited.add(next);
    target = mapsOn;
  }
}

/** Each mapped model's final target by normalized key; mappings whose chain loops are left out. */
export function resolveUsageModelMappings(
  entries: UsagePriceOverrideEntries,
): ReadonlyMap<string, string> {
  const index = indexUsagePriceOverrides(entries);
  const mappings = new Map<string, string>();
  for (const [key, override] of index) {
    if (override.mapTo === undefined) continue;
    const target = followMapping(index, key, override.mapTo);
    if (target !== null) mappings.set(key, target);
  }
  return mappings;
}

/**
 * Entries that would not take effect, in the given order: a model ID repeated in another case
 * (each one after the first), a mapping to itself or into a loop, and synthetic placeholders.
 * A mapping to a model with a custom price is fine.
 */
export function validateUsagePriceOverrides(
  entries: UsagePriceOverrideEntries,
): UsagePriceOverrideIssue[] {
  const list = [...entries];
  const mappings = resolveUsageModelMappings(list);
  const seen = new Set<string>();
  const issues: UsagePriceOverrideIssue[] = [];
  for (const [model, override] of list) {
    const key = normalizeUsageModelKey(model);
    if (seen.has(key)) {
      issues.push({ key: model, issue: "duplicate" });
      continue;
    }
    seen.add(key);
    if (isSyntheticUsageModel(model)) issues.push({ key: model, issue: "synthetic" });
    else if (override.mapTo !== undefined && !mappings.has(key))
      issues.push({
        key: model,
        issue: normalizeUsageModelKey(override.mapTo) === key ? "self-map" : "loop",
      });
  }
  return issues;
}
