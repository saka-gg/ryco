import { updateInstanceModelFavorites } from "@ryco/client-runtime/state/composer";
import { LoaderIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  WS_METHODS,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from "@ryco/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@ryco/contracts/settings";
import { createModelSelection } from "@ryco/shared/model";
import { Equal } from "effect";

import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { ensureLocalApi } from "../../localApi";
import { applyProvidersUpdated } from "../../rpc/serverState";
import { readEnvironmentApi } from "../../environmentApi";
import { useSavedEnvironmentRuntimeStore } from "../../environments/runtime";
import { useSettingsTarget } from "../../settingsTarget";
import { formatRelativeTime } from "../../timestampFormat";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import {
  canOneClickUpdateProviderCandidate,
  isProviderUpdateCandidate,
  isProviderUpdateActive,
  type ProviderUpdateCandidate,
} from "../ProviderUpdateLaunchNotification.logic";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { ProviderInstanceListItem } from "./ProviderInstanceListItem";
import { getDriverOption } from "./providerDriverMeta";
import {
  deriveProviderSettingsInstanceRows,
  resolveProviderSettingsListNavigationIndex,
  resolveSelectedProviderSettingsInstance,
} from "./providerSettingsInstances";
import { buildProviderInstanceUpdatePatch } from "./SettingsPanels.logic";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { useServerProviders } from "../../rpc/serverState";

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");

type PendingProviderDestructiveAction =
  | {
      readonly kind: "delete";
      readonly instanceId: ProviderInstanceId;
      readonly displayName: string;
    }
  | {
      readonly kind: "reset";
      readonly driver: ProviderDriverKind;
      readonly displayName: string;
    };

function withoutProviderInstanceKey<V>(
  record: Readonly<Record<ProviderInstanceId, V>> | undefined,
  key: ProviderInstanceId,
): Record<ProviderInstanceId, V> {
  const next = { ...record } as Record<ProviderInstanceId, V>;
  delete next[key];
  return next;
}

function withoutProviderInstanceFavorites(
  favorites: ReadonlyArray<{
    readonly provider: ProviderInstanceId;
    readonly model: string;
  }>,
  instanceId: ProviderInstanceId,
) {
  return favorites.filter((favorite) => favorite.provider !== instanceId);
}

function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  useRelativeTimeTick();
  const lastCheckedRelative = lastCheckedAt ? formatRelativeTime(lastCheckedAt) : null;

  if (!lastCheckedRelative) {
    return null;
  }

  return (
    <span className="text-[11px] text-muted-foreground/60">
      {lastCheckedRelative.suffix ? (
        <>
          Checked <span className="font-mono tabular-nums">{lastCheckedRelative.value}</span>{" "}
          {lastCheckedRelative.suffix}
        </>
      ) : (
        <>Checked {lastCheckedRelative.value}</>
      )}
    </span>
  );
}

export function ProvidersSettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const settingsTarget = useSettingsTarget();
  // The read-only mutation capability again, not a connectivity probe: the
  // text-generation model and its traits are settings writes, so they are
  // gated by the settings-update method rather than by sensing the transport.
  const settingsCapability = useHostedRpcCapability(WS_METHODS.serverUpdateSettings);
  const settingsBlocked = !settingsCapability.allowed;
  const settingsBlockedReason = settingsCapability.reason;
  const serverProviders = useServerProviders();
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [isAddInstanceDialogOpen, setIsAddInstanceDialogOpen] = useState(false);
  const [selectedInstanceId, setSelectedInstanceId] = useState<ProviderInstanceId | null>(null);
  const [pendingDestructiveAction, setPendingDestructiveAction] =
    useState<PendingProviderDestructiveAction | null>(null);
  const [updatingProviderInstanceIds, setUpdatingProviderInstanceIds] = useState<
    ReadonlySet<ProviderInstanceId>
  >(new Set());
  const refreshingRef = useRef(false);
  const applyProviderSnapshot = useCallback(
    (providers: typeof serverProviders) => {
      if (!settingsTarget || settingsTarget.primary) {
        applyProvidersUpdated({ providers });
        return;
      }
      const current =
        useSavedEnvironmentRuntimeStore.getState().byId[settingsTarget.environmentId]?.serverConfig;
      if (current) {
        useSavedEnvironmentRuntimeStore.getState().patch(settingsTarget.environmentId, {
          serverConfig: { ...current, providers },
        });
      }
    },
    [settingsTarget],
  );
  const readTargetServer = useCallback(() => {
    if (!settingsTarget) return ensureLocalApi().server;
    const server = readEnvironmentApi(settingsTarget.environmentId)?.server;
    if (!server)
      throw new Error(`Provider settings are unavailable on ${settingsTarget.nodeLabel}.`);
    return server;
  }, [settingsTarget]);
  const refreshProviders = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void readTargetServer()
      .refreshProviders()
      .then((payload) => applyProviderSnapshot(payload.providers))
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to refresh providers",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      })
      .finally(() => {
        refreshingRef.current = false;
        setIsRefreshingProviders(false);
      });
  }, [applyProviderSnapshot, readTargetServer]);

  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const gitModelInstanceEntries = sortProviderInstanceEntries(
    deriveProviderInstanceEntries(serverProviders),
  );
  const textGenInstanceEntry = gitModelInstanceEntries.find(
    (entry) => entry.instanceId === textGenInstanceId,
  );
  const textGenProvider: ProviderDriverKind =
    textGenInstanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const gitModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    textGenInstanceId,
    textGenModel,
  );
  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );

  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;

  const rows = deriveProviderSettingsInstanceRows(settings, serverProviders);
  const selectedRow = resolveSelectedProviderSettingsInstance(rows, selectedInstanceId);
  const effectiveSelectedInstanceId = selectedRow?.instanceId ?? null;

  const updateProviderInstance = (
    row: NonNullable<typeof selectedRow>,
    next: ProviderInstanceConfig,
    options?: {
      readonly textGenerationModelSelection?: Parameters<
        typeof buildProviderInstanceUpdatePatch
      >[0]["textGenerationModelSelection"];
    },
  ) => {
    updateSettings(
      buildProviderInstanceUpdatePatch({
        settings,
        instanceId: row.instanceId,
        instance: next,
        driver: row.driver,
        isDefault: row.isDefault,
        textGenerationModelSelection: options?.textGenerationModelSelection,
      }),
    );
  };

  const deleteProviderInstance = (id: ProviderInstanceId) => {
    updateSettings({
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, id),
      providerModelPreferences: withoutProviderInstanceKey(settings.providerModelPreferences, id),
      favorites: withoutProviderInstanceFavorites(settings.favorites ?? [], id),
      ...(textGenInstanceId === id
        ? {
            textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
          }
        : {}),
    });
  };

  const updateProviderModelPreferences = (
    instanceId: ProviderInstanceId,
    next: {
      readonly hiddenModels: ReadonlyArray<string>;
      readonly modelOrder: ReadonlyArray<string>;
    },
  ) => {
    const hiddenModels = [...new Set(next.hiddenModels.filter((slug) => slug.trim().length > 0))];
    const modelOrder = [...new Set(next.modelOrder.filter((slug) => slug.trim().length > 0))];
    const rest = withoutProviderInstanceKey(settings.providerModelPreferences, instanceId);
    updateSettings({
      providerModelPreferences:
        hiddenModels.length === 0 && modelOrder.length === 0
          ? rest
          : {
              ...rest,
              [instanceId]: {
                hiddenModels,
                modelOrder,
              },
            },
    });
  };

  const updateProviderFavoriteModels = (
    instanceId: ProviderInstanceId,
    nextFavoriteModels: ReadonlyArray<string>,
  ) => {
    const favoriteModels = [
      ...new Set(nextFavoriteModels.map((slug) => slug.trim()).filter((slug) => slug.length > 0)),
    ];
    updateSettings({
      favorites: updateInstanceModelFavorites(settings.favorites ?? [], instanceId, favoriteModels),
    });
  };

  const runProviderUpdate = useCallback(
    (provider: ProviderUpdateCandidate) => {
      setUpdatingProviderInstanceIds((existing) => new Set(existing).add(provider.instanceId));
      void readTargetServer()
        .updateProvider({
          provider: provider.driver,
          instanceId: provider.instanceId,
        })
        .then((payload) => {
          applyProviderSnapshot(payload.providers);
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Provider update failed",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        })
        .finally(() => {
          setUpdatingProviderInstanceIds((existing) => {
            const next = new Set(existing);
            next.delete(provider.instanceId);
            return next;
          });
        });
    },
    [applyProviderSnapshot, readTargetServer],
  );

  /**
   * Reset a built-in default slot back to factory defaults. Clears both
   * the legacy `settings.providers[kind]` struct and any explicit
   * `providerInstances[defaultId]` entry that has promoted legacy into
   * the new map, so hydration re-synthesizes a clean envelope on next
   * load. Safe to call on drivers that have never been edited.
   */
  const resetDefaultInstance = (driverKind: ProviderDriverKind) => {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings | undefined
    >;
    const defaultInstanceId = defaultInstanceIdForDriver(driverKind);
    const defaultLegacyProvider = defaultLegacyProviders[driverKind];
    if (defaultLegacyProvider === undefined) return;
    updateSettings({
      providers: {
        ...settings.providers,
        [driverKind]: defaultLegacyProvider,
      } as typeof settings.providers,
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, defaultInstanceId),
      providerModelPreferences: withoutProviderInstanceKey(
        settings.providerModelPreferences,
        defaultInstanceId,
      ),
      favorites: withoutProviderInstanceFavorites(settings.favorites ?? [], defaultInstanceId),
      ...(textGenInstanceId === defaultInstanceId
        ? {
            textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
          }
        : {}),
    });
  };

  const liveProvidersByInstance = new Map(
    serverProviders.map((provider) => [provider.instanceId, provider] as const),
  );
  const selectedDriverOption = selectedRow ? getDriverOption(selectedRow.driver) : undefined;
  const selectedLiveProvider = selectedRow
    ? liveProvidersByInstance.get(selectedRow.instanceId)
    : undefined;
  const selectedDisplayName = selectedRow
    ? selectedRow.instance.displayName?.trim() ||
      selectedDriverOption?.label ||
      String(selectedRow.driver)
    : null;
  const selectedUpdateCandidate =
    selectedLiveProvider && isProviderUpdateCandidate(selectedLiveProvider)
      ? selectedLiveProvider
      : null;
  const canRunSelectedUpdate =
    selectedUpdateCandidate !== null &&
    canOneClickUpdateProviderCandidate(selectedUpdateCandidate, serverProviders);
  const isUpdatingSelected =
    Boolean(selectedLiveProvider && isProviderUpdateActive(selectedLiveProvider)) ||
    (selectedRow ? updatingProviderInstanceIds.has(selectedRow.instanceId) : false);
  const selectedModelPreferences = selectedRow
    ? (settings.providerModelPreferences?.[selectedRow.instanceId] ?? {
        hiddenModels: [],
        modelOrder: [],
      })
    : { hiddenModels: [], modelOrder: [] };
  const selectedFavoriteModels = selectedRow
    ? (settings.favorites ?? [])
        .filter((favorite) => favorite.provider === selectedRow.instanceId)
        .map((favorite) => favorite.model)
    : [];
  const providerEditorId = "provider-instance-editor";

  const handleProviderListKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    const navigationKey = event.key;
    if (
      navigationKey !== "ArrowDown" &&
      navigationKey !== "ArrowUp" &&
      navigationKey !== "Home" &&
      navigationKey !== "End"
    ) {
      return;
    }
    const nextIndex = resolveProviderSettingsListNavigationIndex(
      currentIndex,
      navigationKey,
      rows.length,
    );
    if (nextIndex === null) return;
    event.preventDefault();
    const nextRow = rows[nextIndex];
    if (!nextRow) return;
    setSelectedInstanceId(nextRow.instanceId);
    const list = event.currentTarget.closest<HTMLElement>("[data-provider-instance-list]");
    const buttons = list?.querySelectorAll<HTMLButtonElement>("[data-provider-instance-row]");
    buttons?.[nextIndex]?.focus();
  };

  const confirmPendingDestructiveAction = () => {
    const action = pendingDestructiveAction;
    if (!action) return;
    setPendingDestructiveAction(null);
    if (action.kind === "delete") {
      deleteProviderInstance(action.instanceId);
      return;
    }
    resetDefaultInstance(action.driver);
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="Text generation">
        <SettingsRow
          title="Text generation model"
          description="Configure the model used for generated commit messages, PR titles, and similar Git text."
          resetAction={
            isGitWritingModelDirty ? (
              <SettingResetButton
                label="text generation model"
                onClick={() =>
                  updateSettings({
                    textGenerationModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <ProviderModelPicker
                activeInstanceId={textGenInstanceId}
                model={textGenModel}
                modelOptions={textGenModelOptions}
                lockedProvider={null}
                instanceEntries={gitModelInstanceEntries}
                modelOptionsByInstance={gitModelOptionsByInstance}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                disabled={settingsBlocked}
                {...(settingsBlockedReason ? { disabledReason: settingsBlockedReason } : {})}
                onInstanceModelChange={(instanceId, model, options) => {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: createModelSelection(
                          instanceId,
                          model,
                          options,
                        ),
                      },
                      serverProviders,
                    ),
                  });
                }}
              />
              <TraitsPicker
                provider={textGenProvider}
                models={
                  // Use the exact instance's models (rather than the
                  // first-kind-match) so a custom text-gen instance like
                  // `codex_personal` gets its own model list, not the
                  // default Codex one.
                  textGenInstanceEntry?.models ?? []
                }
                model={textGenModel}
                prompt=""
                onPromptChange={() => {}}
                modelOptions={textGenModelOptions}
                allowPromptInjectedEffort={false}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                disabled={settingsBlocked}
                {...(settingsBlockedReason ? { disabledReason: settingsBlockedReason } : {})}
                onModelOptionsChange={(nextOptions) => {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: createModelSelection(
                          textGenInstanceId,
                          textGenModel,
                          nextOptions,
                        ),
                      },
                      serverProviders,
                    ),
                  });
                }}
              />
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Providers"
        headerAction={
          <div className="flex items-center gap-1.5">
            <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    disabled={isRefreshingProviders}
                    onClick={() => void refreshProviders()}
                    aria-label="Refresh provider status"
                  >
                    {isRefreshingProviders ? (
                      <LoaderIcon className="size-3 animate-spin" />
                    ) : (
                      <RefreshCwIcon className="size-3" />
                    )}
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh provider status</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        <div className="grid min-h-[34rem] md:grid-cols-[minmax(13.5rem,0.75fr)_minmax(0,1.55fr)]">
          <aside className="app-muted-surface min-w-0 border-b border-border/70 md:border-r md:border-b-0">
            <div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-3">
              <div className="min-w-0">
                <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
                  Instances
                </h3>
                <p className="text-[11px] text-muted-foreground">{rows.length} configured</p>
              </div>
              <Button
                size="xs"
                variant="outline"
                className="h-7 shrink-0 gap-1.5 px-2 text-xs"
                onClick={() => setIsAddInstanceDialogOpen(true)}
                aria-label="Add provider instance"
              >
                <PlusIcon className="size-3" />
                Add
              </Button>
            </div>

            <nav
              aria-label="Provider instances"
              data-provider-instance-list
              className="grid max-h-64 gap-1 overflow-y-auto p-2 md:max-h-[min(44rem,calc(100dvh-15rem))]"
            >
              {rows.map((row, index) => (
                <ProviderInstanceListItem
                  key={row.instanceId}
                  instanceId={row.instanceId}
                  instance={row.instance}
                  driverOption={getDriverOption(row.driver)}
                  liveProvider={liveProvidersByInstance.get(row.instanceId)}
                  isDefault={row.isDefault}
                  selected={row.instanceId === effectiveSelectedInstanceId}
                  editorId={providerEditorId}
                  onSelect={() => setSelectedInstanceId(row.instanceId)}
                  onKeyDown={(event) => handleProviderListKeyDown(event, index)}
                />
              ))}
            </nav>
          </aside>

          <section
            id={providerEditorId}
            aria-label={selectedDisplayName ? `Edit ${selectedDisplayName}` : "Provider editor"}
            className="min-w-0 bg-card"
          >
            {selectedRow ? (
              <ProviderInstanceCard
                usageAvailable={settingsTarget?.connected === true}
                key={selectedRow.instanceId}
                instanceId={selectedRow.instanceId}
                instance={selectedRow.instance}
                driverOption={selectedDriverOption}
                liveProvider={selectedLiveProvider}
                isDefault={selectedRow.isDefault}
                onUpdate={(next) => {
                  // When the user disables the exact instance the text-gen
                  // selection points at, fall back to the global default so we
                  // don't leave the selection dangling on a disabled instance.
                  // Prior kind-level behavior cleared on any kind-matching
                  // disable; instance-level addressing makes this narrower and
                  // more accurate (other instances of the same kind stay
                  // untouched).
                  const wasEnabled = selectedRow.instance.enabled ?? true;
                  const isDisabling = next.enabled === false && wasEnabled;
                  const shouldClearTextGen =
                    isDisabling && textGenInstanceId === selectedRow.instanceId;
                  if (shouldClearTextGen) {
                    updateProviderInstance(selectedRow, next, {
                      textGenerationModelSelection:
                        DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                    });
                  } else {
                    updateProviderInstance(selectedRow, next);
                  }
                }}
                onDelete={
                  selectedRow.isDefault
                    ? undefined
                    : () =>
                        setPendingDestructiveAction({
                          kind: "delete",
                          instanceId: selectedRow.instanceId,
                          displayName: selectedDisplayName ?? String(selectedRow.instanceId),
                        })
                }
                headerAction={
                  selectedRow.isDefault && selectedRow.isDirty ? (
                    <SettingResetButton
                      label={`${selectedDisplayName ?? String(selectedRow.driver)} provider settings`}
                      onClick={() =>
                        setPendingDestructiveAction({
                          kind: "reset",
                          driver: selectedRow.driver,
                          displayName: selectedDisplayName ?? String(selectedRow.driver),
                        })
                      }
                    />
                  ) : null
                }
                hiddenModels={selectedModelPreferences.hiddenModels}
                favoriteModels={selectedFavoriteModels}
                modelOrder={selectedModelPreferences.modelOrder}
                onHiddenModelsChange={(hiddenModels) =>
                  updateProviderModelPreferences(selectedRow.instanceId, {
                    ...selectedModelPreferences,
                    hiddenModels,
                  })
                }
                onFavoriteModelsChange={(favoriteModels) =>
                  updateProviderFavoriteModels(selectedRow.instanceId, favoriteModels)
                }
                onModelOrderChange={(modelOrder) =>
                  updateProviderModelPreferences(selectedRow.instanceId, {
                    ...selectedModelPreferences,
                    modelOrder,
                  })
                }
                onRunUpdate={
                  canRunSelectedUpdate
                    ? () => runProviderUpdate(selectedUpdateCandidate)
                    : undefined
                }
                isUpdating={isUpdatingSelected}
              />
            ) : (
              <div className="grid min-h-64 place-items-center px-6 py-12 text-center">
                <div className="max-w-xs space-y-1">
                  <h3 className="text-sm font-semibold text-foreground">No provider instances</h3>
                  <p className="text-xs text-muted-foreground">
                    Add an instance to configure a provider for this environment.
                  </p>
                </div>
              </div>
            )}
          </section>
        </div>
      </SettingsSection>

      <AddProviderInstanceDialog
        open={isAddInstanceDialogOpen}
        onOpenChange={setIsAddInstanceDialogOpen}
        onCreated={setSelectedInstanceId}
      />

      <AlertDialog
        open={pendingDestructiveAction !== null}
        onOpenChange={(open) => !open && setPendingDestructiveAction(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDestructiveAction?.kind === "delete"
                ? `Delete ${pendingDestructiveAction.displayName}?`
                : `Reset ${pendingDestructiveAction?.displayName ?? "provider"}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDestructiveAction?.kind === "delete"
                ? "This removes the instance, its model preferences, and its favorites. Existing threads that reference it may no longer start; text generation returns to its default if needed."
                : "This restores the built-in instance configuration, removes its model preferences and favorites, and resets text generation if it uses this instance."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingDestructiveAction?.kind === "delete" ? (
            <div className="px-6 pb-4">
              <code className="block rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-xs text-foreground">
                {pendingDestructiveAction.instanceId}
              </code>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant={pendingDestructiveAction?.kind === "delete" ? "destructive" : "default"}
              onClick={confirmPendingDestructiveAction}
            >
              {pendingDestructiveAction?.kind === "delete" ? "Delete instance" : "Reset settings"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}
