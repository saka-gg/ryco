import {
  applyModelFavorite,
  createModelFavorite,
  getModelFavoriteEffortLabel,
  indexModelFavorites,
  modelFavoriteKey,
  resolveModelFavoriteForRow,
} from "@ryco/client-runtime/state/composer";
import type { ModelSelection } from "@ryco/contracts";
import type { ModelFavorite } from "@ryco/contracts/settings";

import type { ModelPickerEntry, ModelPickerGroup, ModelPickerModel } from "./modelPickerModel";

// The desktop model picker's structure (apps/web ModelPickerContent + ModelPickerTabs), as a pure
// model for the phone: source tabs on top (favorites, then one per provider instance), one list
// for the open tab, a search that spans every instance, a star per row and a folded "Legacy
// models" row. Rows carry what the desktop row shows; the .tsx only lays them out.

export type ModelPickerTabId = "favorites" | (string & {});

export interface ModelPickerTab {
  readonly id: ModelPickerTabId;
  readonly label: string;
  /** Null for the favorites tab (a star). */
  readonly providerDriver: string | null;
}

export interface ModelPickerModelRow {
  readonly kind: "model";
  /** Unique within the list: a model twice in favorites (two efforts) differs by preset. */
  readonly key: string;
  readonly entry: ModelPickerEntry;
  /** Muted text after the name: the favorite's effort, or the active model's current effort. */
  readonly detail: string | null;
  /** The star's state and what pressing it toggles. */
  readonly favorite: ModelFavorite;
  readonly isFavorite: boolean;
  /** Mixed lists (favorites, search) mark each row with its provider. */
  readonly showProvider: boolean;
  /** This row is the composer's current model (and, for a preset, its effort). */
  readonly active: boolean;
}

export interface ModelPickerLegacyRow {
  readonly kind: "legacy";
  readonly key: string;
  readonly countLabel: string;
  readonly expanded: boolean;
}

export type ModelPickerRow = ModelPickerModelRow | ModelPickerLegacyRow;

export interface ModelPickerList {
  /** Null while a search spans every instance: no tab reads as open. */
  readonly openTab: ModelPickerTabId | null;
  readonly rows: ReadonlyArray<ModelPickerRow>;
  /** Which CLI update unlocks models the open instance (or a search) can't run yet. */
  readonly notices: ReadonlyArray<string>;
  /** Shown instead of rows: "No models found", or why favorites are empty. */
  readonly emptyMessage: string | null;
}

const LEGACY_PREFIX = "#legacy:";

export function legacyRowKey(providerKey: string): string {
  return `${LEGACY_PREFIX}${providerKey}`;
}

/**
 * Favorites first, then each instance. A thread pinned to its provider offers only that
 * instance's tab, as the desktop picker hides the rail while locked.
 */
export function buildModelPickerTabs(
  model: Pick<ModelPickerModel, "groups" | "lockedProviderKey">,
): ReadonlyArray<ModelPickerTab> {
  const locked = model.lockedProviderKey;
  const groups =
    locked === null ? model.groups : model.groups.filter((group) => group.providerKey === locked);
  return [
    ...(locked === null
      ? [{ id: "favorites", label: "Favorites", providerDriver: null } satisfies ModelPickerTab]
      : []),
    ...groups.map((group): ModelPickerTab => ({
      id: group.providerKey,
      label: group.providerLabel,
      providerDriver: group.providerDriver,
    })),
  ];
}

/**
 * A search over every instance: model and provider names, legacy models listed inline, and an
 * update notice kept when it names what was searched for.
 */
export function searchModelPickerGroups(
  groups: ReadonlyArray<ModelPickerGroup>,
  query: string,
  lockedProviderKey: string | null,
): ReadonlyArray<ModelPickerGroup> {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return groups;
  return groups.flatMap((group) => {
    if (lockedProviderKey !== null && group.providerKey !== lockedProviderKey) return [];
    const entries = [...group.entries, ...group.legacyEntries].filter((entry) =>
      `${entry.label} ${group.providerLabel}`.toLocaleLowerCase().includes(normalized),
    );
    const notice =
      group.updateRequiredNotice?.toLocaleLowerCase().includes(normalized) === true
        ? group.updateRequiredNotice
        : null;
    if (entries.length === 0 && notice === null) return [];
    return [{ ...group, entries, legacyEntries: [], updateRequiredNotice: notice }];
  });
}

/**
 * The tab the picker opens on: favorites when there are any (and no provider lock), else the
 * selection's own instance; a tab that is not offered falls back to the first instance, as the
 * desktop rail does.
 */
export function initialModelPickerTab(input: {
  readonly tabs: ReadonlyArray<ModelPickerTab>;
  readonly favoritesCount: number;
  readonly selection: ModelSelection | null;
}): ModelPickerTabId | null {
  const hasFavorites = input.tabs.some((tab) => tab.id === "favorites");
  if (hasFavorites && input.favoritesCount > 0) return "favorites";
  const own = input.selection?.instanceId;
  if (own && input.tabs.some((tab) => tab.id === own)) return own;
  return input.tabs.find((tab) => tab.id !== "favorites")?.id ?? input.tabs[0]?.id ?? null;
}

function entryModelKey(entry: Pick<ModelPickerEntry, "selection">): string {
  return `${entry.selection.instanceId}:${entry.selection.model}`;
}

/**
 * The open tab's rows. `groups` comes from a model built WITH the search query (so it already
 * filters and lists matching legacy models inline); a non-empty query lists every instance's
 * matches with their provider marked, and no tab is open.
 */
export function buildModelPickerList(input: {
  readonly groups: ReadonlyArray<ModelPickerGroup>;
  /** Every model, unfiltered: favorites resolve against it. */
  readonly allEntries: ReadonlyArray<ModelPickerEntry>;
  readonly tab: ModelPickerTabId | null;
  readonly query: string;
  readonly favorites: ReadonlyArray<ModelFavorite>;
  readonly selection: ModelSelection;
  /** Providers whose legacy fold is open. */
  readonly expandedLegacy: ReadonlySet<string>;
}): ModelPickerList {
  const index = indexModelFavorites(input.favorites);
  const selectedKey = `${input.selection.instanceId}:${input.selection.model}`;
  const selectedEntry = input.allEntries.find((entry) => entry.key === selectedKey);
  const currentFavorite = createModelFavorite(input.selection, selectedEntry?.capabilities);
  const currentFavoriteKey = modelFavoriteKey(resolveModelFavoriteForRow(currentFavorite, index));

  const modelRow = (entry: ModelPickerEntry, showProvider: boolean): ModelPickerModelRow => {
    const isCurrent = entry.key === selectedKey;
    const favorite = resolveModelFavoriteForRow(
      isCurrent
        ? currentFavorite
        : { provider: entry.selection.instanceId, model: entry.selection.model },
      index,
    );
    return {
      kind: "model",
      key: entry.key,
      entry,
      // Only the active model has a current effort on a provider tab.
      detail: isCurrent
        ? (getModelFavoriteEffortLabel(currentFavorite, entry.capabilities) ?? null)
        : null,
      favorite,
      isFavorite: index.byKey.has(modelFavoriteKey(favorite)),
      showProvider,
      active: isCurrent,
    };
  };

  const query = input.query.trim();
  if (query.length > 0) {
    const entries = input.groups.flatMap((group) => group.entries);
    // Favorites lead a search's ties, as on desktop.
    const favored = entries.filter((entry) => index.byModel.has(entryModelKey(entry)));
    const rest = entries.filter((entry) => !index.byModel.has(entryModelKey(entry)));
    const rows = [...favored, ...rest].map((entry) => modelRow(entry, true));
    return {
      openTab: null,
      rows,
      notices: input.groups.flatMap((group) =>
        group.updateRequiredNotice ? [group.updateRequiredNotice] : [],
      ),
      emptyMessage: rows.length === 0 ? "No models found" : null,
    };
  }

  if (input.tab === "favorites") {
    const entryByModel = new Map(input.allEntries.map((entry) => [entryModelKey(entry), entry]));
    const rows = [...index.byKey].flatMap(([key, favorite]): ModelPickerModelRow[] => {
      const entry = entryByModel.get(`${favorite.provider}:${favorite.model}`);
      if (!entry) return [];
      return [
        {
          kind: "model",
          key: `favorite:${key}`,
          entry,
          detail: getModelFavoriteEffortLabel(favorite, entry.capabilities) ?? null,
          favorite,
          isFavorite: true,
          showProvider: true,
          active: key === currentFavoriteKey && entry.key === selectedKey,
        },
      ];
    });
    return {
      openTab: "favorites",
      rows,
      notices: [],
      emptyMessage: rows.length === 0 ? "Star a model to keep it here." : null,
    };
  }

  const group = input.groups.find((candidate) => candidate.providerKey === input.tab);
  if (!group) return { openTab: input.tab, rows: [], notices: [], emptyMessage: "No models found" };
  const rows: ModelPickerRow[] = group.entries.map((entry) => modelRow(entry, false));
  if (group.legacyEntries.length > 0) {
    const expanded = input.expandedLegacy.has(group.providerKey);
    rows.push({
      kind: "legacy",
      key: legacyRowKey(group.providerKey),
      countLabel:
        group.legacyEntries.length === 1 ? "1 model" : `${group.legacyEntries.length} models`,
      expanded,
    });
    if (expanded) rows.push(...group.legacyEntries.map((entry) => modelRow(entry, false)));
  }
  return {
    openTab: group.providerKey,
    rows,
    notices: group.updateRequiredNotice ? [group.updateRequiredNotice] : [],
    emptyMessage: rows.length === 0 ? "No models found" : null,
  };
}

/**
 * What tapping a row selects, or null when the tap must be ignored (disabled, locked, already
 * active). A favorite applies its effort over the destination: the current options when it is
 * the same instance, the model's own otherwise.
 */
export function resolveModelPickerRowSelection(input: {
  readonly row: ModelPickerModelRow;
  readonly selection: ModelSelection;
  readonly disabled: boolean;
}): ModelSelection | null {
  const { row, selection } = input;
  if (input.disabled || row.entry.disabled) return null;
  if (row.key.startsWith("favorite:")) {
    return applyModelFavorite(
      row.favorite,
      row.favorite.provider === selection.instanceId ? selection : row.entry.selection,
      row.entry.capabilities,
    );
  }
  return row.entry.selected ? null : row.entry.selection;
}
