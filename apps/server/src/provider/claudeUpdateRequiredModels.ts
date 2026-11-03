/**
 * Current Claude catalog models the installed Claude Code is too old to run, so
 * pickers can say which update unlocks them. Only `ClaudeProvider.ts` imports
 * this module, which keeps it in the lazy Claude chunk off the server boot.
 */
import type { ServerProviderUpdateRequiredModel } from "@ryco/contracts";

import type { ClaudeModelCatalog } from "./ClaudeModelCatalog.ts";
import { compareCliVersions } from "./cliVersion.ts";

/**
 * Sorted by `minVersion` ascending (then name), so the last entry names the
 * update that unlocks every listed model. Legacy models are left out: an
 * update notice should never advertise a model the picker folds away. So is a
 * model blocked only by `maxVersionExclusive`, which an update cannot fix.
 * Without a parsed version nothing is listed: the probe could not tell.
 */
export function resolveClaudeUpdateRequiredModels(
  catalog: ClaudeModelCatalog,
  version: string | null,
): ReadonlyArray<ServerProviderUpdateRequiredModel> {
  if (!version) return [];
  const models: Array<ServerProviderUpdateRequiredModel> = [];
  for (const { model, compatibility } of catalog.models) {
    const minVersion = compatibility.minVersion;
    if (model.isLegacy || !minVersion || compareCliVersions(version, minVersion) >= 0) continue;
    models.push({ slug: model.slug, name: model.name, minVersion });
  }
  return models.toSorted(
    (left, right) =>
      compareCliVersions(left.minVersion, right.minVersion) || left.name.localeCompare(right.name),
  );
}
