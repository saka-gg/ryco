import {
  applyModelFavorite,
  indexModelFavorites,
  resolveModelFavoriteForRow,
  getModelFavoriteEffortLabel,
  createModelFavorite,
  modelFavoriteKey,
  toggleModelFavorite,
} from "@ryco/client-runtime/state/composer";
import { usePreferences, updatePreferences } from "../../state/preferencesStore";
import type { MenuAction } from "@react-native-menu/menu";
import type { ModelSelection } from "@ryco/contracts";
import { applyModelOption, type ModelPickerModel } from "./modelPickerModel";
import { ComposerModelOptions } from "./ComposerModelOptions";
import type { ReactNode } from "react";
import { AnchoredMenu } from "../../components/AnchoredMenu";
import { ProviderIcon } from "../../components/ProviderIcon";

export function ComposerModelMenu(props: {
  readonly model: ModelPickerModel;
  readonly selection: ModelSelection;
  readonly disabled: boolean;
  readonly onSelect: (selection: ModelSelection) => void;
  readonly onClose: () => void;
  readonly children: (
    open: () => void,
    settings: {
      readonly reasoningLabel: string | null;
      readonly fastEnabled: boolean;
      readonly accessibilitySuffix: string;
    },
  ) => ReactNode;
}) {
  const favorites = usePreferences().favorites ?? [];
  const groups = props.model.groups;
  const entries = groups.flatMap((group) => group.entries);
  const selectedKey = `${props.selection.instanceId}:${props.selection.model}`;
  const selectedOption = entries.find((option) => option.key === selectedKey);
  const controls = props.model.options;
  const reasoning = controls.find((option) => option.kind === "select");
  const selectedReasoning = reasoning?.choices.find((choice) => choice.selected);
  const fast = controls.find((option) => option.kind === "boolean");
  const settings = {
    reasoningLabel: selectedReasoning?.shortLabel ?? null,
    fastEnabled: fast?.enabled === true,
    accessibilitySuffix: [
      selectedReasoning ? `${reasoning?.label}: ${selectedReasoning.label}` : null,
      fast?.enabled ? `${fast.label} on` : null,
    ]
      .filter(Boolean)
      .join(", "),
  };
  const actions: MenuAction[] = groups.map((group) => ({
    id: `provider:${group.providerKey}`,
    title: group.providerLabel,
    subtitle: group.entries.find((model) => model.key === selectedKey)?.label,
    subactions: group.entries.map((model) => ({
      id: model.key,
      title: model.label,
      state: model.key === selectedKey ? "on" : "off",
      attributes: { disabled: props.disabled || model.disabled },
      subtitle: model.disabledReason ?? undefined,
    })),
  }));
  const favoriteIndex = indexModelFavorites(favorites);
  const currentFavorite = resolveModelFavoriteForRow(
    createModelFavorite(props.selection, selectedOption?.capabilities),
    favoriteIndex,
  );
  const currentFavoriteSaved = favoriteIndex.byKey.has(modelFavoriteKey(currentFavorite));
  const entryByModel = new Map(
    entries.map((entry) => [
      JSON.stringify([entry.selection.instanceId, entry.selection.model]),
      entry,
    ]),
  );
  const favoriteEntries = [...favoriteIndex.byKey.values()].flatMap((favorite) => {
    const entry = entryByModel.get(JSON.stringify([favorite.provider, favorite.model]));
    return entry
      ? [
          {
            favorite,
            entry,
            effortLabel: getModelFavoriteEffortLabel(favorite, entry.capabilities),
            key: `favorite:${modelFavoriteKey(favorite)}`,
          },
        ]
      : [];
  });
  const favoriteEntryByKey = new Map(
    favoriteEntries.map((item) => [modelFavoriteKey(item.favorite), item]),
  );
  const providerLabels = new Map(groups.map((group) => [group.providerKey, group.providerLabel]));
  if (favoriteEntries.length)
    actions.unshift({
      id: "favorites",
      title: "Favorites",
      subactions: favoriteEntries.map(({ effortLabel, entry, key }) => ({
        id: key,
        title: `${entry.label}${effortLabel ? ` · ${effortLabel}` : ""}`,
        subtitle: providerLabels.get(entry.providerKey),
        attributes: { disabled: props.disabled || entry.disabled },
      })),
    });
  if (favorites.length)
    actions.push({
      id: "remove-favorite",
      title: "Remove favorite",
      subactions: [...favoriteIndex.byKey].map(([key, favorite]) => {
        const item = favoriteEntryByKey.get(key);
        const effort = item?.effortLabel ?? getModelFavoriteEffortLabel(favorite, null);
        return {
          id: `remove:${key}`,
          title: `${item?.entry.label ?? favorite.model}${effort ? ` · ${effort}` : ""}`,
          subtitle: providerLabels.get(favorite.provider) ?? favorite.provider,
          attributes: { disabled: props.disabled },
        };
      }),
    });
  actions.push({
    id: "toggle-favorite",
    title: currentFavoriteSaved
      ? "Remove current preset from favorites"
      : "Favorite current model and effort",
    attributes: { disabled: props.disabled || !selectedOption || selectedOption.disabled },
  });
  return (
    <AnchoredMenu
      title="Provider"
      actions={actions}
      initialSubmenuId={`provider:${props.selection.instanceId}`}
      menuWidth={288}
      submenuWidth={320}
      searchable
      closeOnSelect={false}
      footer={
        <ComposerModelOptions
          modelLabel={selectedOption?.label ?? props.selection.model}
          options={controls}
          disabled={props.disabled}
          onSelect={(id, value) => {
            if (!props.disabled)
              props.onSelect(
                applyModelOption(props.selection, selectedOption?.capabilities, id, value),
              );
          }}
        />
      }
      className="min-w-0 flex-1"
      onClose={props.onClose}
      renderIcon={(action) => {
        const group = groups.find((candidate) => `provider:${candidate.providerKey}` === action.id);
        const driver =
          group?.providerDriver ??
          entries.find((option) => option.key === action.id)?.providerDriver;
        return <ProviderIcon provider={driver} size={16} />;
      }}
      onPressAction={({ nativeEvent }) => {
        if (props.disabled) return;
        const removed = favorites.find(
          (favorite) => `remove:${modelFavoriteKey(favorite)}` === nativeEvent.event,
        );
        if (removed) {
          updatePreferences({ favorites: toggleModelFavorite(favorites, removed) });
          return;
        }
        if (nativeEvent.event === "toggle-favorite" && selectedOption && !selectedOption.disabled) {
          updatePreferences({ favorites: toggleModelFavorite(favorites, currentFavorite) });
          return;
        }
        const preset = favoriteEntries.find((entry) => entry.key === nativeEvent.event);
        if (preset && !preset.entry.disabled) {
          props.onSelect(
            applyModelFavorite(
              preset.favorite,
              preset.favorite.provider === props.selection.instanceId
                ? props.selection
                : preset.entry.selection,
              preset.entry.capabilities,
            ),
          );
          return;
        }
        const option = entries.find((candidate) => candidate.key === nativeEvent.event);
        if (option && !props.disabled && !option.disabled && !option.selected)
          props.onSelect(option.selection);
      }}
    >
      {(open) => props.children(open, settings)}
    </AnchoredMenu>
  );
}
