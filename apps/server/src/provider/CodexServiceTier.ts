// Codex speed tiers, in both directions: the catalog's advertised tiers become
// model options, and a model selection becomes the `serviceTier` a turn asks
// for. Fast and Ultrafast are separate boolean options so a saved Fast
// preference keeps working; Ultrafast wins if both are ever set.

import type { ModelSelection, ProviderOptionDescriptor } from "@ryco/contracts";
import { getModelSelectionBooleanOptionValue } from "@ryco/shared/model";
import type * as CodexSchema from "effect-codex-app-server/schema";

export const CODEX_FAST_MODE_OPTION_ID = "fastMode";
export const CODEX_ULTRAFAST_MODE_OPTION_ID = "ultrafastMode";

export type CodexRequestedServiceTier = "fast" | "ultrafast";

/**
 * Tier ids a model advertises. `serviceTiers` is current (Fast is listed as
 * `priority`); `additionalSpeedTiers` is its deprecated predecessor, still
 * read for older CLIs.
 */
function advertisedTierIds(model: CodexSchema.V2ModelListResponse__Model): ReadonlySet<string> {
  return new Set([
    ...(model.serviceTiers ?? []).map((tier) => tier.id),
    ...(model.additionalSpeedTiers ?? []),
  ]);
}

export function codexSpeedOptionDescriptors(
  model: CodexSchema.V2ModelListResponse__Model,
): ReadonlyArray<ProviderOptionDescriptor> {
  const tiers = advertisedTierIds(model);
  const descriptors: ProviderOptionDescriptor[] = [];
  if (tiers.has("fast") || tiers.has("priority")) {
    descriptors.push({ id: CODEX_FAST_MODE_OPTION_ID, label: "Fast Mode", type: "boolean" });
  }
  if (tiers.has("ultrafast")) {
    descriptors.push({ id: CODEX_ULTRAFAST_MODE_OPTION_ID, label: "Ultrafast", type: "boolean" });
  }
  return descriptors;
}

export function codexServiceTierForSelection(
  selection: ModelSelection | null | undefined,
): CodexRequestedServiceTier | undefined {
  if (!selection) return undefined;
  if (getModelSelectionBooleanOptionValue(selection, CODEX_ULTRAFAST_MODE_OPTION_ID) === true) {
    return "ultrafast";
  }
  if (getModelSelectionBooleanOptionValue(selection, CODEX_FAST_MODE_OPTION_ID) === true) {
    return "fast";
  }
  return undefined;
}
