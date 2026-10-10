import type { ProviderDriverKind, ProviderInstanceId } from "@ryco/contracts";

import { providerModelKey, sortProviderModelItems } from "../../modelOrdering";
import { isSetupProviderInstance, type ProviderInstanceEntry } from "../../providerInstances";
import { buildModelPickerSearchText, scoreModelPickerSearch } from "./modelPickerSearch";
import { getDisplayModelName, type ModelEsque } from "./providerIconUtils";

/**
 * Derives the phone model sheet's grouped option list.
 *
 * This is the phone translation of the desktop picker's two-pane layout, not a
 * second search or ordering implementation: the ranking, the tie-breaking, the
 * favourite grouping, and the "new model" highlight all come from the same
 * shared modules the desktop picker uses. What differs is only the shape —
 * a sidebar rail of instances becomes a set of sections in one scrollable list,
 * because a phone sheet has no room for a rail.
 *
 * Nothing reachable on desktop becomes unreachable here: every ready instance
 * gets a section (desktop shows one at a time), the favourites rail becomes the
 * leading section, and locked-provider filtering is applied by the same rule.
 * A favourited model appears in the Favourites section only, so one list never
 * shows the same model twice.
 */

export interface PhoneModelSheetItem {
  /** `${instanceId}:${slug}` — the same key the desktop picker uses. */
  readonly key: string;
  readonly instanceId: ProviderInstanceId;
  readonly slug: string;
  readonly label: string;
  readonly providerLabel: string;
  readonly isFavorite: boolean;
  readonly isSelected: boolean;
}

export interface PhoneModelSheetGroup {
  readonly id: string;
  readonly label: string;
  readonly items: ReadonlyArray<PhoneModelSheetItem>;
}

export interface PhoneModelSheetInput {
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly searchQuery: string;
  readonly lockedProvider: ProviderDriverKind | null;
  readonly lockedContinuationGroupKey: string | null;
  readonly activeInstanceId: ProviderInstanceId;
  readonly model: string;
}

interface FlatModel extends ModelEsque {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly providerDisplayName: string;
}

export const PHONE_MODEL_SHEET_FAVORITES_GROUP_ID = "favorites";

function matchesLockedProvider(
  entry: Pick<ProviderInstanceEntry, "driverKind" | "continuationGroupKey">,
  lockedProvider: ProviderDriverKind | null,
  lockedContinuationGroupKey: string | null,
): boolean {
  if (lockedProvider === null) return true;
  if (entry.driverKind !== lockedProvider) return false;
  if (!lockedContinuationGroupKey) return true;
  return entry.continuationGroupKey === lockedContinuationGroupKey;
}

export function buildPhoneModelSheetGroups(
  input: PhoneModelSheetInput,
): ReadonlyArray<PhoneModelSheetGroup> {
  const entryByInstanceId = new Map(
    input.instanceEntries.map((entry) => [entry.instanceId, entry] as const),
  );
  const selectedKey = providerModelKey(input.activeInstanceId, input.model);

  const toItem = (model: FlatModel): PhoneModelSheetItem => {
    const key = providerModelKey(model.instanceId, model.slug);
    return {
      key,
      instanceId: model.instanceId,
      slug: model.slug,
      label: getDisplayModelName(model, { preferShortName: input.lockedProvider === null }),
      providerLabel: model.subProvider
        ? `${model.providerDisplayName} · ${model.subProvider}`
        : model.providerDisplayName,
      isFavorite: input.favoriteKeys.has(key),
      isSelected: key === selectedKey,
    };
  };

  const flat: FlatModel[] = [];
  for (const [instanceId, models] of input.modelOptionsByInstance) {
    const entry = entryByInstanceId.get(instanceId);
    // Instance disappeared between renders, or is not set up: the desktop
    // picker drops both, and so does this.
    if (!entry || !isSetupProviderInstance(entry)) continue;
    if (!matchesLockedProvider(entry, input.lockedProvider, input.lockedContinuationGroupKey)) {
      continue;
    }
    for (const model of models) {
      flat.push({
        ...model,
        instanceId,
        driverKind: entry.driverKind,
        providerDisplayName: entry.displayName,
      });
    }
  }

  const query = input.searchQuery.trim();
  if (query.length > 0) {
    const ranked = flat
      .map((model) => ({
        model,
        score: scoreModelPickerSearch(
          {
            name: model.name,
            ...(model.shortName ? { shortName: model.shortName } : {}),
            ...(model.subProvider ? { subProvider: model.subProvider } : {}),
            driverKind: model.driverKind,
            providerDisplayName: model.providerDisplayName,
            isFavorite: input.favoriteKeys.has(providerModelKey(model.instanceId, model.slug)),
          },
          query,
        ),
        isFavorite: input.favoriteKeys.has(providerModelKey(model.instanceId, model.slug)),
        tieBreaker: buildModelPickerSearchText({
          name: model.name,
          ...(model.shortName ? { shortName: model.shortName } : {}),
          ...(model.subProvider ? { subProvider: model.subProvider } : {}),
          driverKind: model.driverKind,
          providerDisplayName: model.providerDisplayName,
        }),
      }))
      .filter(
        (
          candidate,
        ): candidate is {
          model: FlatModel;
          score: number;
          isFavorite: boolean;
          tieBreaker: string;
        } => candidate.score !== null,
      )
      .toSorted((a, b) => {
        const scoreDelta = a.score - b.score;
        if (scoreDelta !== 0) return scoreDelta;
        if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
        return a.tieBreaker.localeCompare(b.tieBreaker);
      })
      .map((candidate) => toItem(candidate.model));

    return ranked.length === 0 ? [] : [{ id: "results", label: "Results", items: ranked }];
  }

  const groups: PhoneModelSheetGroup[] = [];
  const favorites = flat.filter((model) =>
    input.favoriteKeys.has(providerModelKey(model.instanceId, model.slug)),
  );
  if (favorites.length > 0) {
    groups.push({
      id: PHONE_MODEL_SHEET_FAVORITES_GROUP_ID,
      label: "Favorites",
      items: sortProviderModelItems(favorites, {
        instanceOrder: input.instanceEntries.map((entry) => entry.instanceId),
      }).map(toItem),
    });
  }

  for (const entry of input.instanceEntries) {
    const items = flat.filter(
      (model) =>
        model.instanceId === entry.instanceId &&
        !input.favoriteKeys.has(providerModelKey(model.instanceId, model.slug)),
    );
    if (items.length === 0) continue;
    groups.push({ id: entry.instanceId, label: entry.displayName, items: items.map(toItem) });
  }

  return groups;
}
