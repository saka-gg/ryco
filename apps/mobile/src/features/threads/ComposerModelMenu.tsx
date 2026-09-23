import {
  applyModelFavorite,
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
  const currentFavorite = createModelFavorite(props.selection, selectedOption?.capabilities);
  const currentFavoriteSaved = favorites.some(
    (favorite) => modelFavoriteKey(favorite) === modelFavoriteKey(currentFavorite),
  );
  const favoriteEntries = favorites.flatMap((favorite) => {
    const entry = entries.find(
      (entry) =>
        entry.selection.instanceId === favorite.provider &&
        entry.selection.model === favorite.model,
    );
    return entry ? [{ favorite, entry, key: `favorite:${modelFavoriteKey(favorite)}` }] : [];
  });
  if (favoriteEntries.length)
    actions.unshift({
      id: "favorites",
      title: "Favorites",
      subactions: favoriteEntries.map(({ favorite, entry, key }) => ({
        id: key,
        title: `${entry.label}${favorite.reasoningEffort ? ` · ${favorite.reasoningEffort}` : ""}`,
        subtitle: groups.find((group) => group.providerKey === entry.providerKey)?.providerLabel,
        attributes: { disabled: props.disabled || entry.disabled },
      })),
    });
  if (favorites.length)
    actions.push({
      id: "remove-favorite",
      title: "Remove favorite",
      subactions: favorites.map((favorite) => ({
        id: `remove:${modelFavoriteKey(favorite)}`,
        title: `${favoriteEntries.find((item) => modelFavoriteKey(item.favorite) === modelFavoriteKey(favorite))?.entry.label ?? favorite.model}${favorite.reasoningEffort ? ` · ${favorite.reasoningEffort}` : ""}`,
        subtitle:
          groups.find((group) => group.providerKey === favorite.provider)?.providerLabel ??
          favorite.provider,
        attributes: { disabled: props.disabled },
      })),
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
            applyModelFavorite(preset.favorite, props.selection, preset.entry.capabilities),
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
