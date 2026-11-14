/**
 * The composer banner stack's connection and status items: hosted delivery and
 * dispatch state, an unavailable environment, a client/server version skew,
 * and the restart, prompt-link checkout and failed-turn items. Pure: ChatView
 * memoizes it.
 */
import type { HostedRpcCapability } from "@ryco/client-runtime/authorization/capabilities";
import type { EnvironmentId } from "@ryco/contracts";
import { LoaderCircleIcon, PowerOffIcon, TriangleAlertIcon, WifiOffIcon } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";

import type { HostedDeliveryNoticeBinding } from "../hostedHub/capabilities";
import {
  hostedQueuedCopy,
  hostedSyncingCopy,
  type HostedSwitchTarget,
} from "../hostedHub/switchTarget";
import type { useSettingsDialogStore } from "../settingsDialogStore";
import { dismissVersionMismatch, type VersionMismatch } from "../versionSkew";
import type { ComposerBannerStackItem } from "./chat/ComposerBannerStack";
import type { EnvironmentUnavailableState } from "./ChatView.logic";
import { Button } from "./ui/button";

type SettingsDialogStore = ReturnType<typeof useSettingsDialogStore.getState>;

export interface ComposerBannerItemsInput {
  readonly dispatchCapability: HostedRpcCapability;
  readonly hostedSwitchTarget: HostedSwitchTarget;
  readonly dispatchEstablishing: boolean;
  readonly hostedDeliveryNotice: HostedDeliveryNoticeBinding | null;
  readonly openSettings: SettingsDialogStore["openSettings"];
  readonly activeEnvironmentUnavailableState: EnvironmentUnavailableState | null;
  readonly reconnectingEnvironmentId: EnvironmentId | null;
  readonly handleReconnectActiveEnvironment: (
    environmentId: EnvironmentId,
    label: string,
  ) => Promise<void>;
  readonly handleSwitchOnActiveEnvironment: (environmentId: EnvironmentId) => Promise<void>;
  readonly versionMismatch: VersionMismatch | null;
  readonly versionMismatchDismissKey: string | null;
  readonly setDismissedVersionMismatchKey: Dispatch<SetStateAction<string | null>>;
  readonly showVersionMismatchBanner: boolean;
  readonly versionMismatchServerLabel: string;
  readonly restartInterruptionBannerItem: ComposerBannerStackItem | null;
  readonly promptLinkCheckoutBannerItem: ComposerBannerStackItem | null;
  readonly failedTurnBanner: { readonly item: ComposerBannerStackItem | null };
}

export function buildComposerBannerItems(
  input: ComposerBannerItemsInput,
): ComposerBannerStackItem[] {
  const {
    dispatchCapability,
    hostedSwitchTarget,
    dispatchEstablishing,
    hostedDeliveryNotice,
    openSettings,
    activeEnvironmentUnavailableState,
    reconnectingEnvironmentId,
    handleReconnectActiveEnvironment,
    handleSwitchOnActiveEnvironment,
    versionMismatch,
    versionMismatchDismissKey,
    setDismissedVersionMismatchKey,
    showVersionMismatchBanner,
    versionMismatchServerLabel,
    restartInterruptionBannerItem,
    promptLinkCheckoutBannerItem,
    failedTurnBanner,
  } = input;
  const items: ComposerBannerStackItem[] = [];
  if (hostedDeliveryNotice) {
    // Shown where the user would retry, not in the connection menu. It also
    // explains why sending is paused, so it replaces the read-only banner.
    items.push({
      id: "hosted-delivery-unconfirmed",
      variant: "warning",
      icon: <TriangleAlertIcon />,
      title: hostedDeliveryNotice.title,
      description: hostedDeliveryNotice.description,
      actions: (
        <Button
          size="xs"
          disabled={!hostedDeliveryNotice.canAcknowledge}
          onClick={hostedDeliveryNotice.acknowledge}
        >
          {hostedDeliveryNotice.actionLabel}
        </Button>
      ),
    });
  } else if (dispatchCapability.hosted && dispatchEstablishing) {
    // A connection on its way is not a problem: a quiet note instead of a
    // warning, while sends wait in the queue.
    items.push({
      id: "hosted-dispatch-syncing",
      variant: "info",
      icon: <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />,
      title: hostedSwitchTarget.queued
        ? hostedQueuedCopy(hostedSwitchTarget.label)
        : hostedSyncingCopy(hostedSwitchTarget.label),
    });
  } else if (dispatchCapability.hosted && !dispatchCapability.allowed) {
    items.push({
      id: "hosted-dispatch-unavailable",
      variant: "warning",
      icon: <TriangleAlertIcon />,
      title: "Read-only hosted session",
      description: dispatchCapability.reason ?? "Commands are unavailable on this connection.",
    });
  }
  if (activeEnvironmentUnavailableState?.connectionState === "switched-off") {
    const switchingOn =
      reconnectingEnvironmentId === activeEnvironmentUnavailableState.environmentId;
    items.push({
      id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
      variant: "warning",
      icon: <PowerOffIcon />,
      title: <>{activeEnvironmentUnavailableState.label} is switched off</>,
      description: "Switch it on to send messages or run actions.",
      actions: (
        <>
          <Button
            size="xs"
            disabled={switchingOn}
            onClick={() =>
              void handleSwitchOnActiveEnvironment(activeEnvironmentUnavailableState.environmentId)
            }
          >
            {switchingOn ? "Switching on..." : "Switch on"}
          </Button>
          <Button size="xs" variant="outline" onClick={() => openSettings("devices")}>
            Connections
          </Button>
        </>
      ),
    });
  } else if (activeEnvironmentUnavailableState) {
    items.push({
      id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
      variant: activeEnvironmentUnavailableState.connectionState === "error" ? "error" : "warning",
      icon: <WifiOffIcon />,
      title: (
        <>
          {activeEnvironmentUnavailableState.label} is{" "}
          {activeEnvironmentUnavailableState.connectionState === "connecting"
            ? "connecting"
            : "disconnected"}
        </>
      ),
      description: "Reconnect this environment before sending messages or running actions.",
      actions: (
        <>
          <Button
            size="xs"
            disabled={
              activeEnvironmentUnavailableState.connectionState === "connecting" ||
              reconnectingEnvironmentId === activeEnvironmentUnavailableState.environmentId
            }
            onClick={() =>
              void handleReconnectActiveEnvironment(
                activeEnvironmentUnavailableState.environmentId,
                activeEnvironmentUnavailableState.label,
              )
            }
          >
            {activeEnvironmentUnavailableState.connectionState === "connecting" ||
            reconnectingEnvironmentId === activeEnvironmentUnavailableState.environmentId
              ? "Reconnecting..."
              : "Reconnect"}
          </Button>
          <Button size="xs" variant="outline" onClick={() => openSettings("devices")}>
            Connections
          </Button>
        </>
      ),
    });
  }
  if (showVersionMismatchBanner && versionMismatch && versionMismatchDismissKey) {
    items.push({
      id: `version-mismatch:${versionMismatchDismissKey}`,
      variant: "warning",
      icon: <TriangleAlertIcon />,
      title: "Client and server versions differ",
      description: (
        <>
          Client {versionMismatch.clientVersion} is connected to {versionMismatchServerLabel}{" "}
          {versionMismatch.serverVersion}. Sync them if RPC calls or reconnects fail.
        </>
      ),
      dismissLabel: "Dismiss version mismatch warning",
      onDismiss: () => {
        dismissVersionMismatch(versionMismatchDismissKey);
        setDismissedVersionMismatchKey(versionMismatchDismissKey);
      },
    });
  }
  if (restartInterruptionBannerItem) {
    items.push(restartInterruptionBannerItem);
  }
  if (promptLinkCheckoutBannerItem) {
    items.push(promptLinkCheckoutBannerItem);
  }
  if (failedTurnBanner.item) {
    items.push(failedTurnBanner.item);
  }
  return items;
}
