import { DownloadIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@ryco/contracts";

import { ensureEnvironmentApi } from "../environmentApi";
import { usePrimaryEnvironmentDescriptor } from "../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { useDismissedProviderUpdateNotificationKeys } from "../providerUpdateDismissal";
import { useServerProviders } from "../rpc/serverState";
import { useSettingsDialogStore } from "../settingsDialogStore";
import { PROVIDER_ICON_BY_PROVIDER } from "./chat/providerIconUtils";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  collectUpdatedProviderSnapshots,
  firstRejectedProviderUpdateMessage,
  getProviderUpdateInitialToastView,
  getProviderUpdateProgressToastView,
  getProviderUpdateRejectedToastView,
  getProviderUpdateRunningToastView,
  providerUpdateDismissalKeys,
  providerUpdateNotificationKey,
  undismissedProviderUpdateCandidates,
  withProviderUpdateOrigin,
  type ProviderUpdateToastView,
} from "./ProviderUpdateLaunchNotification.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

const seenProviderUpdateNotificationKeys = new Set<string>();
type ProviderUpdateToastId = ReturnType<typeof toastManager.add>;

type ActiveProviderUpdateToast =
  | {
      readonly kind: "prompt";
      readonly key: string;
      readonly toastId: ProviderUpdateToastId;
    }
  | {
      readonly kind: "update";
      readonly key: string;
      readonly toastId: ProviderUpdateToastId;
      readonly providerInstanceIds: ReadonlySet<ProviderInstanceId>;
      readonly providerCount: number;
    };

function ProviderUpdateToastIcon({ provider }: { provider: ProviderDriverKind }) {
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[provider];

  if (!ProviderIcon) {
    return (
      <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
        <DownloadIcon aria-hidden="true" className="size-4 text-success" strokeWidth={2.5} />
      </span>
    );
  }

  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
      <ProviderIcon aria-hidden="true" className="size-4" />
      <span className="absolute -right-1 -bottom-1 inline-flex size-3 items-center justify-center rounded-full bg-popover">
        <DownloadIcon aria-hidden="true" className="size-2.5 text-success" strokeWidth={2.5} />
      </span>
    </span>
  );
}

function updateProviderUpdateToast(input: {
  readonly toastId: ProviderUpdateToastId;
  readonly view: ProviderUpdateToastView;
  readonly openSettings: () => void;
}) {
  if (input.view.type === "loading" || input.view.type === "success") {
    toastManager.update(input.toastId, {
      type: input.view.type,
      title: input.view.title,
      description: input.view.description,
      timeout: 0,
      // `update` is a shallow merge over the prompt toast, so the "Update"
      // action must be cleared explicitly once the run starts; the fresh
      // `data` object already drops the "Settings" secondary action.
      actionProps: undefined,
      data: {
        hideCopyButton: true,
        ...(input.view.dismissAfterVisibleMs !== undefined
          ? { dismissAfterVisibleMs: input.view.dismissAfterVisibleMs }
          : {}),
      },
    });
    return;
  }

  toastManager.update(
    input.toastId,
    stackedThreadToast({
      type: input.view.type,
      title: input.view.title,
      description: input.view.description,
      timeout: 0,
      actionProps: {
        children: "Settings",
        onClick: input.openSettings,
      },
      actionVariant: "outline",
      data: {
        hideCopyButton: true,
      },
    }),
  );
}

function isTerminalProviderUpdateToastView(view: ProviderUpdateToastView) {
  return view.phase === "failed" || view.phase === "unchanged" || view.phase === "succeeded";
}

function ProviderUpdateLaunchNotificationForEnvironment({
  environment,
  providers,
}: {
  readonly environment: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
  };
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const openSettingsDialog = useSettingsDialogStore((s) => s.openSettings);
  const activeToastRef = useRef<ActiveProviderUpdateToast | null>(null);
  const { dismissedNotificationKeys, dismissNotificationKeys } =
    useDismissedProviderUpdateNotificationKeys();

  const updateProviders = useMemo(
    () =>
      undismissedProviderUpdateCandidates(
        collectProviderUpdateCandidates(providers),
        dismissedNotificationKeys,
        { environmentId: environment.environmentId },
      ),
    [dismissedNotificationKeys, environment.environmentId, providers],
  );
  const notificationKey = useMemo(
    () =>
      providerUpdateNotificationKey(updateProviders, {
        environmentId: environment.environmentId,
      }),
    [environment, updateProviders],
  );
  const origin = useMemo(
    () => ({
      environmentId: environment.environmentId,
      nodeLabel: environment.label,
    }),
    [environment],
  );
  const oneClickProviders = useMemo(
    () =>
      updateProviders.filter((provider) => canOneClickUpdateProviderCandidate(provider, providers)),
    [providers, updateProviders],
  );

  const openProviderSettings = useCallback(
    (toastId?: ProviderUpdateToastId) => {
      const activeToast = activeToastRef.current;
      if (toastId !== undefined) {
        toastManager.close(toastId);
      } else if (activeToast) {
        toastManager.close(activeToast.toastId);
      }
      if (activeToast && (toastId === undefined || activeToast.toastId === toastId)) {
        activeToastRef.current = null;
      }
      openSettingsDialog("providers", environment.environmentId);
    },
    [environment.environmentId, openSettingsDialog],
  );

  useEffect(() => {
    const activeToast = activeToastRef.current;
    if (activeToast?.kind !== "update") {
      return;
    }

    const activeProviders = providers.filter((provider) =>
      activeToast.providerInstanceIds.has(provider.instanceId),
    );
    if (!origin) return;
    const view = withProviderUpdateOrigin(
      getProviderUpdateProgressToastView({
        providers: activeProviders,
        providerCount: activeToast.providerCount,
      }),
      origin,
    );
    updateProviderUpdateToast({
      toastId: activeToast.toastId,
      view,
      openSettings: () => openProviderSettings(activeToast.toastId),
    });

    if (isTerminalProviderUpdateToastView(view)) {
      activeToastRef.current = null;
    }
  }, [openProviderSettings, origin, providers]);

  useEffect(() => {
    const activeToast = activeToastRef.current;
    if (activeToast?.kind === "prompt" && activeToast.key !== notificationKey) {
      toastManager.close(activeToast.toastId);
      activeToastRef.current = null;
    }

    if (
      !notificationKey ||
      !origin ||
      dismissedNotificationKeys.has(notificationKey) ||
      seenProviderUpdateNotificationKeys.has(notificationKey) ||
      activeToastRef.current
    ) {
      return;
    }

    seenProviderUpdateNotificationKeys.add(notificationKey);

    const initialView = withProviderUpdateOrigin(
      getProviderUpdateInitialToastView({ updateProviders, oneClickProviders }),
      origin,
    );

    let toastId!: ProviderUpdateToastId;
    let updateStarted = false;
    const openSettings = () => openProviderSettings(toastId);
    const dismissPrompt = () => {
      dismissNotificationKeys(providerUpdateDismissalKeys(updateProviders, origin));
    };

    const runUpdates = () => {
      if (updateStarted || oneClickProviders.length === 0) {
        return;
      }
      updateStarted = true;

      const providerCount = oneClickProviders.length;
      const providerInstanceIds = new Set(oneClickProviders.map((provider) => provider.instanceId));
      activeToastRef.current = {
        kind: "update",
        key: notificationKey,
        toastId,
        providerInstanceIds,
        providerCount,
      };

      updateProviderUpdateToast({
        toastId,
        view: withProviderUpdateOrigin(getProviderUpdateRunningToastView(providerCount), origin),
        openSettings,
      });

      void Promise.allSettled(
        oneClickProviders.map(async (provider) => {
          const api = ensureEnvironmentApi(origin.environmentId);
          if (!api.server) throw new Error("Node provider settings are unavailable.");
          return api.server.updateProvider({
            provider: provider.driver,
            instanceId: provider.instanceId,
          });
        }),
      ).then((results) => {
        const activeUpdateToast = activeToastRef.current;
        if (activeUpdateToast?.kind !== "update" || activeUpdateToast.toastId !== toastId) {
          return;
        }

        const rejectedMessage = firstRejectedProviderUpdateMessage(results);
        if (rejectedMessage) {
          updateProviderUpdateToast({
            toastId,
            view: withProviderUpdateOrigin(
              getProviderUpdateRejectedToastView(providerCount, rejectedMessage),
              origin,
            ),
            openSettings,
          });
          activeToastRef.current = null;
          return;
        }

        const updatedProviderSnapshots = collectUpdatedProviderSnapshots({
          results,
          providerInstanceIds,
        });
        const view = withProviderUpdateOrigin(
          getProviderUpdateProgressToastView({
            providers: updatedProviderSnapshots,
            providerCount,
          }),
          origin,
        );
        updateProviderUpdateToast({
          toastId,
          view,
          openSettings,
        });

        if (isTerminalProviderUpdateToastView(view)) {
          activeToastRef.current = null;
        }
      });
    };

    toastId = toastManager.add(
      stackedThreadToast({
        type: initialView.type,
        title: initialView.title,
        description: initialView.description,
        timeout: 0,
        actionProps:
          oneClickProviders.length > 0
            ? {
                children: "Update",
                onClick: runUpdates,
              }
            : {
                children: "Settings",
                onClick: openSettings,
              },
        actionVariant: oneClickProviders.length > 0 ? "default" : "outline",
        data: {
          leadingIcon:
            updateProviders.length === 1 ? (
              <ProviderUpdateToastIcon provider={updateProviders[0]!.driver} />
            ) : undefined,
          hideCopyButton: true,
          onClose: dismissPrompt,
          ...(oneClickProviders.length > 0
            ? {
                secondaryActionProps: {
                  children: "Settings",
                  onClick: openSettings,
                },
                secondaryActionVariant: "outline" as const,
              }
            : {}),
        },
      }),
    );
    activeToastRef.current = { kind: "prompt", key: notificationKey, toastId };
  }, [
    dismissNotificationKeys,
    dismissedNotificationKeys,
    notificationKey,
    oneClickProviders,
    openProviderSettings,
    origin,
    updateProviders,
  ]);

  return null;
}

export function ProviderUpdateLaunchNotification() {
  const primaryEnvironment = usePrimaryEnvironmentDescriptor();
  const primaryProviders = useServerProviders();
  const savedRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const remoteEnvironments = Object.entries(savedRuntimeById).flatMap(
    ([rawEnvironmentId, runtime]) => {
      if (
        runtime.connectionState !== "connected" ||
        !runtime.serverConfig ||
        rawEnvironmentId === primaryEnvironment?.environmentId
      ) {
        return [];
      }
      const environmentId = EnvironmentId.make(rawEnvironmentId);
      return [
        {
          environmentId,
          label:
            runtime.descriptor?.label ?? runtime.serverConfig.environment.label ?? "Connected node",
          providers: runtime.serverConfig.providers,
        },
      ];
    },
  );

  return (
    <>
      {primaryEnvironment ? (
        <ProviderUpdateLaunchNotificationForEnvironment
          key={primaryEnvironment.environmentId}
          environment={primaryEnvironment}
          providers={primaryProviders}
        />
      ) : null}
      {remoteEnvironments.map((environment) => (
        <ProviderUpdateLaunchNotificationForEnvironment
          key={environment.environmentId}
          environment={environment}
          providers={environment.providers}
        />
      ))}
    </>
  );
}
