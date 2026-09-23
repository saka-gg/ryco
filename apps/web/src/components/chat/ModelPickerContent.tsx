import {
  applyModelFavorite,
  createModelFavorite,
  modelFavoriteKey,
  toggleModelFavorite,
  indexModelFavorites,
  resolveModelFavoriteForRow,
  getModelFavoriteEffortLabel,
} from "@ryco/client-runtime/state/composer";
import type { ModelFavorite } from "@ryco/contracts/settings";
import type { ModelCapabilities, ProviderOptionSelection } from "@ryco/contracts";
import { usePaneEffect, usePaneFocus } from "./PaneFocus";
import {
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@ryco/contracts";
import { resolveSelectableModel } from "@ryco/shared/model";
import { memo, useMemo, useState, useCallback, useLayoutEffect, useRef } from "react";
import { SearchIcon } from "lucide-react";
import { ModelListRow } from "./ModelListRow";
import { ModelPickerSidebar } from "./ModelPickerSidebar";
import { buildModelPickerSearchText, scoreModelPickerSearch } from "./modelPickerSearch";
import { Combobox, ComboboxEmpty, ComboboxInput, ComboboxList } from "../ui/combobox";
import { ModelEsque, PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import { useSettings, updateClientModelFavorites } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { TooltipProvider } from "../ui/tooltip";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { providerModelKey, sortProviderModelItems } from "../../modelOrdering";

type ModelPickerItem = {
  favorite?: ModelFavorite | undefined;
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  instanceDisplayName: string;
  instanceAccentColor?: string | undefined;
  continuationGroupKey?: string | undefined;
};

const EMPTY_MODEL_JUMP_LABELS = new Map<string, string>();

function itemKey(model: ModelPickerItem): string {
  return model.favorite
    ? modelFavoriteKey(model.favorite)
    : providerModelKey(model.instanceId, model.slug);
}

export const ModelPickerContent = memo(function ModelPickerContent(props: {
  /** The instance currently selected in the composer (combobox "value"). */
  activeInstanceId: ProviderInstanceId;
  model: string;
  modelOptions?: ReadonlyArray<ProviderOptionSelection> | undefined;
  savedModelOptionsByInstance?:
    | Readonly<Partial<Record<string, ReadonlyArray<ProviderOptionSelection>>>>
    | undefined;
  /**
   * When set, the picker is locked to the given driver kind — typically
   * because the user is editing a previously-sent message and can't change
   * which driver served the turn. Multiple instances of the same kind
   * remain selectable (e.g. locked to `codex` still lets the user switch
   * between the default Codex and a custom Codex Personal).
   */
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  /**
   * All configured provider instances in display order. Used to render
   * the sidebar (one button per instance) and to resolve display names
   * for the locked-mode header.
   */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  /**
   * Model options per instance. Keyed by `ProviderInstanceId` so the
   * default Codex instance and any custom Codex instances each have their
   * own list (custom instances typically start with the same built-in
   * model set but are free to diverge via customModels).
   */
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  terminalOpen: boolean;
  onRequestClose?: () => void;
  onInstanceModelChange: (
    instanceId: ProviderInstanceId,
    model: string,
    options?: ReadonlyArray<ProviderOptionSelection>,
  ) => void;
}) {
  const {
    keybindings: providedKeybindings,
    modelOptionsByInstance,
    instanceEntries,
    onInstanceModelChange,
  } = props;
  const [searchQuery, setSearchQuery] = useState("");
  const paneFocused = usePaneFocus();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRegionRef = useRef<HTMLDivElement>(null);
  const highlightedModelKeyRef = useRef<string | null>(null);
  const favorites = useSettings((s) => s.favorites ?? []);
  const [selectedInstanceId, setSelectedInstanceId] = useState<ProviderInstanceId | "favorites">(
    () => {
      if (props.lockedProvider !== null) {
        // When locked, prime the sidebar to the currently-active instance
        // so jumping into the picker keeps the focused instance visible.
        return props.activeInstanceId;
      }
      return favorites.length > 0 ? "favorites" : props.activeInstanceId;
    },
  );
  const keybindings = useMemo<ResolvedKeybindingsConfig>(
    () => providedKeybindings ?? [],
    [providedKeybindings],
  );

  const focusSearchInput = useCallback(() => {
    searchInputRef.current?.focus({ preventScroll: true });
  }, []);

  const handleSelectInstance = useCallback(
    (instanceId: ProviderInstanceId | "favorites") => {
      setSelectedInstanceId(instanceId);
      window.requestAnimationFrame(() => {
        focusSearchInput();
      });
    },
    [focusSearchInput],
  );

  usePaneEffect(() => {
    focusSearchInput();
    const frame = window.requestAnimationFrame(() => {
      focusSearchInput();
    });
    const timeout = window.setTimeout(() => {
      focusSearchInput();
    }, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [focusSearchInput]);

  // Create a Set for efficient lookup. Favorites are keyed by
  // `${instanceId}:${slug}`; the storage schema widened from ProviderDriverKind
  // to ProviderInstanceId so pre-migration favorites keyed by driver slugs
  // (e.g. `"codex:gpt-5"`) still resolve — the default instance id equals
  // the driver slug.
  const favoriteIndex = useMemo(() => indexModelFavorites(favorites), [favorites]);
  const favoritesSet = useMemo(() => new Set(favoriteIndex.byModel.keys()), [favoriteIndex]);

  /**
   * Lookup table keyed by `instanceId`. Used for display name + driver
   * kind enrichment and for `ready`/enabled filtering before flattening
   * models into the search list.
   */
  const entryByInstanceId = useMemo(
    () => new Map(instanceEntries.map((entry) => [entry.instanceId, entry])),
    [instanceEntries],
  );
  const capabilitiesByModelKey = useMemo(() => {
    const index = new Map<string, ModelCapabilities | null>();
    for (const entry of instanceEntries) {
      for (const model of entry.models)
        index.set(providerModelKey(entry.instanceId, model.slug), model.capabilities);
    }
    return index;
  }, [instanceEntries]);
  const currentModelKey = providerModelKey(props.activeInstanceId, props.model);
  const currentFavorite = useMemo(
    () =>
      createModelFavorite(
        {
          instanceId: props.activeInstanceId,
          model: props.model,
          ...(props.modelOptions ? { options: props.modelOptions } : {}),
        },
        capabilitiesByModelKey.get(currentModelKey),
      ),
    [
      props.activeInstanceId,
      props.model,
      props.modelOptions,
      capabilitiesByModelKey,
      currentModelKey,
    ],
  );

  const matchesLockedProvider = useCallback(
    (entry: Pick<ProviderInstanceEntry, "driverKind" | "continuationGroupKey">): boolean => {
      if (props.lockedProvider === null) return true;
      if (entry.driverKind !== props.lockedProvider) return false;
      if (!props.lockedContinuationGroupKey) return true;
      return entry.continuationGroupKey === props.lockedContinuationGroupKey;
    },
    [props.lockedContinuationGroupKey, props.lockedProvider],
  );

  const readyInstanceSet = useMemo(() => {
    const ready = new Set<ProviderInstanceId>();
    for (const entry of instanceEntries) {
      if (entry.status === "ready") {
        ready.add(entry.instanceId);
      }
    }
    return ready;
  }, [instanceEntries]);

  // Flatten models into a searchable array. One pass over the
  // instance-keyed map; each model carries its instance id + driver kind
  // so the list row can render the right icon and display name without
  // another lookup.
  const flatModels = useMemo(() => {
    const out: ModelPickerItem[] = [];
    for (const [instanceId, models] of modelOptionsByInstance) {
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) {
        // Instance disappeared between renders (configuration change). Skip
        // its models — stale options shouldn't appear in the picker.
        continue;
      }
      if (!readyInstanceSet.has(instanceId)) {
        continue;
      }
      for (const model of models) {
        out.push({
          slug: model.slug,
          name: model.name,
          ...(model.shortName ? { shortName: model.shortName } : {}),
          ...(model.subProvider ? { subProvider: model.subProvider } : {}),
          instanceId,
          driverKind: entry.driverKind,
          instanceDisplayName: entry.displayName,
          ...(entry.accentColor ? { instanceAccentColor: entry.accentColor } : {}),
          ...(entry.continuationGroupKey
            ? { continuationGroupKey: entry.continuationGroupKey }
            : {}),
        });
      }
    }
    return out;
  }, [modelOptionsByInstance, entryByInstanceId, readyInstanceSet]);

  // Index row presentation independently of search. Each model and preset is
  // visited once; typing only scores/filter rows and performs map lookups.
  const rowStateByKey = useMemo(() => {
    const index = new Map<
      string,
      { favorite: ModelFavorite; isFavorite: boolean; effortLabel: string | undefined }
    >();
    for (const model of flatModels) {
      const key = providerModelKey(model.instanceId, model.slug);
      const candidate =
        key === currentModelKey
          ? currentFavorite
          : { provider: model.instanceId, model: model.slug };
      const favorite = resolveModelFavoriteForRow(candidate, favoriteIndex);
      index.set(key, {
        favorite,
        isFavorite: favoriteIndex.byKey.has(modelFavoriteKey(favorite)),
        // Only the active model has a current effort on a provider tab.
        effortLabel:
          key === currentModelKey
            ? getModelFavoriteEffortLabel(currentFavorite, capabilitiesByModelKey.get(key))
            : undefined,
      });
    }
    for (const [key, favorite] of favoriteIndex.byKey) {
      index.set(key, {
        favorite,
        isFavorite: true,
        effortLabel: getModelFavoriteEffortLabel(
          favorite,
          capabilitiesByModelKey.get(providerModelKey(favorite.provider, favorite.model)),
        ),
      });
    }
    return index;
  }, [flatModels, currentModelKey, currentFavorite, favoriteIndex, capabilitiesByModelKey]);

  const isLocked = props.lockedProvider !== null;
  const isSearching = searchQuery.trim().length > 0;
  const lockedInstanceEntries = useMemo(
    () =>
      props.lockedProvider ? instanceEntries.filter((entry) => matchesLockedProvider(entry)) : [],
    [instanceEntries, matchesLockedProvider, props.lockedProvider],
  );
  const showLockedInstanceSidebar = isLocked && lockedInstanceEntries.length > 1;
  const showSidebar = !isSearching && (!isLocked || showLockedInstanceSidebar);
  const sidebarInstanceEntries = showLockedInstanceSidebar
    ? lockedInstanceEntries
    : instanceEntries;
  const instanceOrder = useMemo(
    () => instanceEntries.map((entry) => entry.instanceId),
    [instanceEntries],
  );

  // Filter models based on search query and selected instance
  const filteredModels = useMemo(() => {
    let result = flatModels;

    // Apply tokenized fuzzy search across the combined provider/model search fields.
    if (searchQuery.trim()) {
      const rankedMatches = result
        .map((model) => ({
          model,
          score: scoreModelPickerSearch(
            {
              name: model.name,
              ...(model.shortName ? { shortName: model.shortName } : {}),
              ...(model.subProvider ? { subProvider: model.subProvider } : {}),
              driverKind: model.driverKind,
              providerDisplayName: model.instanceDisplayName,
              isFavorite: favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
            },
            searchQuery,
          ),
          isFavorite: favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
          tieBreaker: buildModelPickerSearchText({
            name: model.name,
            ...(model.shortName ? { shortName: model.shortName } : {}),
            ...(model.subProvider ? { subProvider: model.subProvider } : {}),
            driverKind: model.driverKind,
            providerDisplayName: model.instanceDisplayName,
          }),
        }))
        .filter(
          (
            rankedModel,
          ): rankedModel is {
            model: ModelPickerItem;
            score: number;
            isFavorite: boolean;
            tieBreaker: string;
          } => rankedModel.score !== null,
        );

      // When searching, we only respect locked provider (by driver kind),
      // ignoring sidebar selection so account-scoped searches can find a
      // model before the user chooses a specific instance rail item.
      if (props.lockedProvider !== null) {
        return rankedMatches
          .filter((rankedModel) => matchesLockedProvider(rankedModel.model))
          .toSorted((a, b) => {
            const scoreDelta = a.score - b.score;
            if (scoreDelta !== 0) {
              return scoreDelta;
            }
            if (a.isFavorite !== b.isFavorite) {
              return a.isFavorite ? -1 : 1;
            }
            return a.tieBreaker.localeCompare(b.tieBreaker);
          })
          .map((rankedModel) => rankedModel.model);
      }

      return rankedMatches
        .toSorted((a, b) => {
          const scoreDelta = a.score - b.score;
          if (scoreDelta !== 0) {
            return scoreDelta;
          }
          if (a.isFavorite !== b.isFavorite) {
            return a.isFavorite ? -1 : 1;
          }
          return a.tieBreaker.localeCompare(b.tieBreaker);
        })
        .map((rankedModel) => rankedModel.model);
    }

    if (props.lockedProvider !== null) {
      result = result.filter((m) => matchesLockedProvider(m));
      if (showLockedInstanceSidebar) {
        result = result.filter((m) => m.instanceId === selectedInstanceId);
      }
    } else if (selectedInstanceId === "favorites") {
      result = result.flatMap((m) =>
        (favoriteIndex.byModel.get(providerModelKey(m.instanceId, m.slug)) ?? []).map((favorite) =>
          Object.assign({}, m, { favorite }),
        ),
      );
    } else {
      result = result.filter((m) => m.instanceId === selectedInstanceId);
    }

    return sortProviderModelItems(result, {
      favoriteModelKeys: favoritesSet,
      groupFavorites: selectedInstanceId !== "favorites",
      instanceOrder: selectedInstanceId === "favorites" ? instanceOrder : [],
    });
  }, [
    favoriteIndex,
    favoritesSet,
    flatModels,
    instanceOrder,
    matchesLockedProvider,
    props.lockedProvider,
    searchQuery,
    showLockedInstanceSidebar,
    selectedInstanceId,
  ]);

  const handleModelSelect = useCallback(
    (modelSlug: string, instanceId: ProviderInstanceId, favorite?: ModelFavorite) => {
      const options = modelOptionsByInstance.get(instanceId);
      if (!options) {
        return;
      }
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) {
        return;
      }
      // `resolveSelectableModel` uses the driver kind for normalization
      // (slug casing etc.). Custom instances share their driver's
      // normalization rules, so pass the driver kind here.
      const resolvedModel = resolveSelectableModel(entry.driverKind, modelSlug, options);
      if (resolvedModel) {
        if (favorite?.reasoningEffort !== undefined) {
          const selection = applyModelFavorite(
            favorite,
            {
              instanceId,
              model: resolvedModel,
              options:
                instanceId === props.activeInstanceId
                  ? (props.modelOptions ?? [])
                  : (props.savedModelOptionsByInstance?.[instanceId] ?? []),
            },
            capabilitiesByModelKey.get(providerModelKey(instanceId, resolvedModel)),
          );
          onInstanceModelChange(instanceId, resolvedModel, selection.options ?? []);
        } else {
          onInstanceModelChange(instanceId, resolvedModel);
        }
      }
    },
    [
      entryByInstanceId,
      modelOptionsByInstance,
      onInstanceModelChange,
      props.activeInstanceId,
      props.modelOptions,
      props.savedModelOptionsByInstance,
      capabilitiesByModelKey,
    ],
  );

  const LockedProviderIcon =
    isLocked && props.lockedProvider ? PROVIDER_ICON_BY_PROVIDER[props.lockedProvider] : null;
  // Header label for locked mode. Use the active instance's displayName
  // when the lock narrows to exactly one instance (so "Codex Personal"
  // shows instead of the generic driver label); fall back to the first
  // matching entry otherwise.
  const lockedHeaderLabel = useMemo(() => {
    if (!isLocked || !props.lockedProvider) return null;
    const matches = instanceEntries.filter((entry) => matchesLockedProvider(entry));
    if (matches.length === 0) return null;
    const active = matches.find((entry) => entry.instanceId === props.activeInstanceId);
    return (active ?? matches[0])?.displayName ?? null;
  }, [
    isLocked,
    matchesLockedProvider,
    props.lockedProvider,
    props.activeInstanceId,
    instanceEntries,
  ]);
  const modelJumpCommandByKey = useMemo(() => {
    const mapping = new Map<
      string,
      NonNullable<ReturnType<typeof modelPickerJumpCommandForIndex>>
    >();
    for (const [visibleModelIndex, model] of filteredModels.entries()) {
      const jumpCommand = modelPickerJumpCommandForIndex(visibleModelIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(itemKey(model), jumpCommand);
    }
    return mapping;
  }, [filteredModels]);
  const modelJumpModelKeys = useMemo(
    () => [...modelJumpCommandByKey.keys()],
    [modelJumpCommandByKey],
  );
  const allModelKeys = useMemo(
    (): string[] => [...new Set([...flatModels, ...filteredModels].map(itemKey))],
    [flatModels, filteredModels],
  );
  const filteredModelKeys = useMemo((): string[] => filteredModels.map(itemKey), [filteredModels]);
  const filteredModelByKey = useMemo(
    (): ReadonlyMap<string, ModelPickerItem> =>
      new Map(filteredModels.map((model) => [itemKey(model), model] as const)),
    [filteredModels],
  );
  const modelJumpShortcutContext = useMemo(
    () =>
      ({
        terminalFocus: false,
        terminalOpen: props.terminalOpen,
        modelPickerOpen: true,
      }) as const,
    [props.terminalOpen],
  );
  const modelJumpLabelByKey = useMemo((): ReadonlyMap<string, string> => {
    if (modelJumpCommandByKey.size === 0) {
      return EMPTY_MODEL_JUMP_LABELS;
    }
    const shortcutLabelOptions = {
      platform: navigator.platform,
      context: modelJumpShortcutContext,
    };
    const mapping = new Map<string, string>();
    for (const [modelKey, command] of modelJumpCommandByKey) {
      const label = shortcutLabelForCommand(keybindings, command, shortcutLabelOptions);
      if (label) {
        mapping.set(modelKey, label);
      }
    }
    return mapping.size > 0 ? mapping : EMPTY_MODEL_JUMP_LABELS;
  }, [keybindings, modelJumpCommandByKey, modelJumpShortcutContext]);

  usePaneEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: modelJumpShortcutContext,
      });
      const jumpIndex = modelPickerJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }

      const targetModelKey = modelJumpModelKeys[jumpIndex];
      if (!targetModelKey) {
        return;
      }
      const target = filteredModelByKey.get(targetModelKey);
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      handleModelSelect(target.slug, target.instanceId, target.favorite);
    };

    window.addEventListener("keydown", onWindowKeyDown, true);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
    };
  }, [
    filteredModelByKey,
    handleModelSelect,
    keybindings,
    modelJumpModelKeys,
    modelJumpShortcutContext,
  ]);

  useLayoutEffect(() => {
    const listRegion = listRegionRef.current;
    if (!listRegion) {
      return;
    }

    let cancelled = false;
    let frame = 0;
    let nestedFrame = 0;
    let timeout = 0;

    const measureScrollArea = () => {
      if (cancelled) {
        return;
      }
      const viewport = listRegion.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
      if (!viewport || viewport.scrollHeight <= viewport.clientHeight) {
        return;
      }
      const originalScrollTop = viewport.scrollTop;
      const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
      if (maxScrollTop <= 0) {
        return;
      }
      viewport.scrollTop = Math.min(originalScrollTop + 1, maxScrollTop);
      viewport.scrollTop = originalScrollTop;
    };

    queueMicrotask(measureScrollArea);
    frame = window.requestAnimationFrame(() => {
      measureScrollArea();
      nestedFrame = window.requestAnimationFrame(measureScrollArea);
    });
    timeout = window.setTimeout(measureScrollArea, 0);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(nestedFrame);
      window.clearTimeout(timeout);
    };
  }, [filteredModelKeys]);

  const selectedRow = filteredModels.find(
    (model) =>
      model.instanceId === props.activeInstanceId &&
      model.slug === props.model &&
      (!model.favorite ||
        model.favorite.reasoningEffort === undefined ||
        model.favorite.reasoningEffort === currentFavorite.reasoningEffort),
  );

  if (!paneFocused) return null;

  return (
    <TooltipProvider delay={0}>
      <div
        className={cn(
          "selection-glass-surface relative flex h-screen max-h-96 w-screen max-w-100 overflow-hidden rounded-lg border text-popover-foreground",
          isLocked && !showLockedInstanceSidebar ? "flex-col" : "flex-row",
        )}
      >
        {/* Locked provider header (only shown in locked mode) */}
        {isLocked && !showLockedInstanceSidebar && LockedProviderIcon && lockedHeaderLabel && (
          <div className="flex items-center gap-2 px-4 py-3 border-b">
            <LockedProviderIcon className="size-5 shrink-0" />
            <span className="font-medium text-sm">{lockedHeaderLabel}</span>
          </div>
        )}

        {/* Sidebar (only in unlocked mode) */}
        {showSidebar && (
          <ModelPickerSidebar
            selectedInstanceId={selectedInstanceId}
            onSelectInstance={handleSelectInstance}
            instanceEntries={sidebarInstanceEntries}
            showFavorites={!isLocked}
            showComingSoon={!isLocked}
          />
        )}

        {/* Main content area */}
        <Combobox
          inline
          items={allModelKeys}
          filteredItems={filteredModelKeys}
          filter={null}
          autoHighlight
          open
          value={selectedRow ? itemKey(selectedRow) : null}
          onItemHighlighted={(modelKey) => {
            highlightedModelKeyRef.current = typeof modelKey === "string" ? modelKey : null;
          }}
          onValueChange={(modelKey) => {
            if (typeof modelKey !== "string") {
              return;
            }
            const target = filteredModelByKey.get(modelKey);
            if (target) handleModelSelect(target.slug, target.instanceId, target.favorite);
          }}
        >
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-hidden",
              isLocked && !showLockedInstanceSidebar ? "min-w-0" : showSidebar && "border-l",
            )}
          >
            {/* Search bar */}
            <div className="border-b px-3 py-2">
              <ComboboxInput
                ref={searchInputRef}
                className="[&_input]:font-sans rounded-md"
                inputClassName="border-0 shadow-none ring-0 focus-visible:ring-0"
                placeholder="Search models..."
                showTrigger={false}
                startAddon={<SearchIcon className="size-4 shrink-0 text-muted-foreground/50" />}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    props.onRequestClose?.();
                    return;
                  }
                  if (e.key === "Enter" && highlightedModelKeyRef.current) {
                    (
                      e as typeof e & { preventBaseUIHandler?: () => void }
                    ).preventBaseUIHandler?.();
                    e.preventDefault();
                    e.stopPropagation();
                    const target = filteredModelByKey.get(highlightedModelKeyRef.current);
                    if (target) handleModelSelect(target.slug, target.instanceId, target.favorite);
                    return;
                  }
                  e.stopPropagation();
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
                size="sm"
              />
            </div>

            {/* Model list */}
            <div
              ref={listRegionRef}
              className="relative min-h-0 flex-1 before:pointer-events-none before:absolute before:inset-0 before:bg-muted/40"
            >
              <ComboboxList className="model-picker-list size-full divide-y px-2 py-1">
                {filteredModelKeys.map((modelKey, index) => {
                  const model = filteredModelByKey.get(modelKey);
                  const row = rowStateByKey.get(modelKey);
                  if (!model || !row) {
                    return null;
                  }
                  return (
                    <ModelListRow
                      key={modelKey}
                      index={index}
                      model={model}
                      instanceId={model.instanceId}
                      driverKind={model.driverKind}
                      providerDisplayName={model.instanceDisplayName}
                      providerAccentColor={model.instanceAccentColor}
                      value={modelKey}
                      effortLabel={row.effortLabel}
                      isFavorite={row.isFavorite}
                      showProvider={!isLocked || showLockedInstanceSidebar}
                      preferShortName={!isLocked}
                      useTriggerLabel={isLocked && !showLockedInstanceSidebar}
                      jumpLabel={modelJumpLabelByKey.get(modelKey) ?? null}
                      onToggleFavorite={() =>
                        updateClientModelFavorites((current) =>
                          toggleModelFavorite(current, row.favorite),
                        )
                      }
                    />
                  );
                })}
              </ComboboxList>
            </div>
            <ComboboxEmpty className="not-empty:py-6 empty:h-0 text-xs font-normal leading-snug">
              No models found
            </ComboboxEmpty>
          </div>
        </Combobox>
      </div>
    </TooltipProvider>
  );
});
