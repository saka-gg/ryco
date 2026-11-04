import {
  type DesktopWorkspaceMachineProjection,
  type EnvironmentId as EnvironmentIdType,
} from "@ryco/contracts";
import { isSavedEnvironmentSwitchedOff } from "@ryco/client-runtime/connection";

import { useDeviceName } from "../../deviceName";
import { isHostedHubMode } from "../../env";
import { usePrimaryEnvironmentDescriptor } from "../../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { useHostedHubStore } from "../../hostedHub/state";
import { useDesktopWorkspaceState } from "../../platform/desktopWorkspace";
import { useSettingsDialogStore } from "../../settingsDialogStore";
import { useHostedConnectionActions } from "../hostedHub/HostedConnectionControls";
import { nodeSelectionBlocked, selectableNodes } from "../hostedHub/HostedNodeDisplay.logic";
import {
  settingsNodeStatus,
  type SettingsDeviceKind,
  type SettingsNodeStatus,
} from "./settingsDevices.logic";

/** A device the settings page can show: a nav item, and a choice of the device bar. */
export interface SettingsDeviceChoice {
  readonly environmentId: EnvironmentIdType;
  readonly label: string;
  /** Hosted: the directory's own rule for opening a node does not allow it now. */
  readonly disabled: boolean;
  readonly status: SettingsNodeStatus | null;
  /** How this app reaches it. */
  readonly kind: SettingsDeviceKind;
  /** When it was last seen (ms), where the Hub directory or the saved record says; else null. */
  readonly lastSeenAt: number | null;
}

/** The devices settings can show, the one shown, and how to switch. */
export interface SettingsDevicesModel {
  readonly choices: ReadonlyArray<SettingsDeviceChoice>;
  readonly value: EnvironmentIdType | null;
  readonly select: (environmentId: EnvironmentIdType) => void;
}

type SavedConnectionState = "connected" | "connecting" | "disconnected" | "error";

/**
 * Each saved environment's connection state, as one string that stays equal
 * while they do: the runtime map also changes with every config push.
 */
const selectSavedConnectionStates = (state: {
  readonly byId: Readonly<Record<string, { readonly connectionState: SavedConnectionState }>>;
}): string =>
  Object.entries(state.byId)
    .map(([environmentId, runtime]) => `${environmentId}\t${runtime.connectionState}`)
    .join("\n");

function readSavedConnectionStates(key: string): ReadonlyMap<string, SavedConnectionState> {
  return new Map(
    key
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t") as [string, SavedConnectionState]),
  );
}

export const SETTINGS_NODE_STATUS_LABELS: Record<SettingsNodeStatus, string> = {
  offline: "Offline",
  connecting: "Connecting",
};

/**
 * The one list of devices the settings page offers, for the nav's device items
 * and the device bar: the primary, then every
 * node a hosted browser may open, or the saved environments and the Desktop
 * workspace's machines, and the device shown. Choosing one moves the settings
 * target; in hosted mode it moves the selection cursor the rest of the hosted
 * app uses, and the page follows it, so a choice never opens a second write
 * target. A hosted choice waits for a current directory and a revalidated
 * browser, as the directory's rows do.
 */
export function useSettingsDevices(input: {
  readonly targetEnvironmentId: EnvironmentIdType | null;
  readonly targetLabel: string;
  readonly targetConnected: boolean;
  readonly targetMachine: DesktopWorkspaceMachineProjection | null;
  /** Runs before every switch, e.g. to clear a search. */
  readonly onSelect?: () => void;
}): SettingsDevicesModel {
  const hosted = isHostedHubMode();
  const primaryEnvironment = usePrimaryEnvironmentDescriptor();
  const primaryDeviceName = useDeviceName();
  const savedEnvironments = useSavedEnvironmentRegistryStore((state) => state.byId);
  const savedConnections = readSavedConnectionStates(
    useSavedEnvironmentRuntimeStore(selectSavedConnectionStates),
  );
  const desktopWorkspace = useDesktopWorkspaceState();
  const hostedNodes = useHostedHubStore((state) => state.nodes);
  const hostedDirectoryStatus = useHostedHubStore((state) => state.directoryStatus);
  const hostedBrowserStatus = useHostedHubStore((state) => state.browserStatus);
  const setTargetEnvironmentId = useSettingsDialogStore((state) => state.setTargetEnvironmentId);
  const { switchNodeInPlace } = useHostedConnectionActions();
  const { targetEnvironmentId } = input;

  const labels = new Map<EnvironmentIdType, string>();
  if (primaryEnvironment) labels.set(primaryEnvironment.environmentId, primaryDeviceName);
  if (hosted) {
    // Every node this browser may open is a choice, also before the cursor is
    // on any node, as in a tab opened on settings.
    for (const node of selectableNodes(hostedNodes)) labels.set(node.environmentId, node.label);
  } else {
    for (const entry of Object.values(savedEnvironments)) {
      if (primaryEnvironment && entry.environmentId === desktopWorkspace.localEnvironmentId)
        continue;
      // A machine switched off has no settings to edit until it is on again.
      if (isSavedEnvironmentSwitchedOff(entry)) continue;
      labels.set(entry.environmentId, entry.label);
    }
    for (const machine of desktopWorkspace.machines) {
      if (primaryEnvironment && machine.environmentId === desktopWorkspace.localEnvironmentId)
        continue;
      labels.set(machine.environmentId, machine.label);
    }
  }
  if (targetEnvironmentId) labels.set(targetEnvironmentId, input.targetLabel);

  const hostedNode = (environmentId: EnvironmentIdType) =>
    hostedNodes.find((candidate) => candidate.environmentId === environmentId);
  const blocked = (environmentId: EnvironmentIdType): boolean => {
    if (!hosted || environmentId === targetEnvironmentId) return false;
    const node = hostedNode(environmentId);
    return (
      !node ||
      nodeSelectionBlocked({
        directoryStatus: hostedDirectoryStatus,
        browserStatus: hostedBrowserStatus,
        node,
      })
    );
  };
  const status = (environmentId: EnvironmentIdType): SettingsNodeStatus | null => {
    const machine =
      environmentId === targetEnvironmentId
        ? input.targetMachine
        : (desktopWorkspace.machines.find((entry) => entry.environmentId === environmentId) ??
          null);
    const online = machine?.online ?? (hosted ? hostedNode(environmentId)?.presence.online : null);
    const reported = savedConnections.get(environmentId) ?? machine?.connectionState;
    if (environmentId === targetEnvironmentId) {
      // Connected only with its config; a socket still waiting for it is connecting.
      const connection = input.targetConnected
        ? "connected"
        : reported === "connected"
          ? "connecting"
          : (reported ?? "disconnected");
      return settingsNodeStatus({
        connection,
        online: online ?? undefined,
        canConnect: machine?.canConnect,
      });
    }
    return settingsNodeStatus({
      // The primary is this app's own connection; a hosted node holds none until chosen.
      connection:
        hosted || environmentId === primaryEnvironment?.environmentId
          ? undefined
          : (reported ?? "disconnected"),
      online: online ?? undefined,
      canConnect: machine?.canConnect,
    });
  };

  const kind = (environmentId: EnvironmentIdType): SettingsDeviceKind => {
    if (hosted) return "hub";
    if (environmentId === primaryEnvironment?.environmentId) return "this-computer";
    const saved = savedEnvironments[environmentId];
    if (saved?.desktopSsh) return "ssh";
    return saved && !saved.hubLink ? "remote" : "hub";
  };
  const lastSeenAt = (environmentId: EnvironmentIdType): number | null => {
    const at = hosted
      ? (hostedNode(environmentId)?.presence.lastHeartbeatAt ??
        hostedNode(environmentId)?.lastAuthenticatedAt ??
        null)
      : savedEnvironments[environmentId]?.lastConnectedAt
        ? Date.parse(savedEnvironments[environmentId].lastConnectedAt)
        : null;
    return typeof at === "number" && Number.isFinite(at) ? at : null;
  };

  return {
    choices: [...labels].map(([environmentId, label]) => ({
      environmentId,
      label,
      disabled: blocked(environmentId),
      status: status(environmentId),
      kind: kind(environmentId),
      lastSeenAt: lastSeenAt(environmentId),
    })),
    value: targetEnvironmentId,
    select: (environmentId) => {
      // Only a listed device, and never one the list shows as unavailable.
      if (
        environmentId === targetEnvironmentId ||
        !labels.has(environmentId) ||
        blocked(environmentId)
      )
        return;
      input.onSelect?.();
      setTargetEnvironmentId(environmentId);
      if (!hosted) return;
      // Through the same selection cursor the rest of the hosted app uses,
      // staying on this page, whose address names no node: the settings
      // target follows once the selection has moved.
      const node = hostedNode(environmentId);
      if (node) void switchNodeInPlace(node);
    },
  };
}
