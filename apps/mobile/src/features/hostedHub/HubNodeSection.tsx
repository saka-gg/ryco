import { useState } from "react";
import { DeviceRenameSheet } from "../nodes/DeviceRenameSheet";
import { useNavigation } from "@react-navigation/native";
import { Pressable, View } from "react-native";

import { WS_METHODS, type RelayEffectiveRole } from "@ryco/contracts";
import type { WorkspaceNativeTrustState } from "@ryco/client-runtime/state/workspace";
import {
  getHostedHubApi,
  resolveHostedRpcCapability,
  deriveHostedConnectionStatusIndicator,
  deriveHostedConnectionStatusText,
  type HostedE2eeChannelStatus,
  type HostedHubNode,
  type HostedHubState,
  type HostedNativeDeviceSecurityStatus,
} from "@ryco/client-runtime/authorization";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { StatusPill, type StatusTone } from "../../components/StatusPill";
import { acquireMobileHostedNode } from "../../hostedHub/acquireNode";
import type { MobileHostedConnectionState } from "../../connection/hostedConnectionCoordinator";
import {
  hostedHubController,
  useHostedHubStore,
  useMobileHostedConnectionsStore,
} from "../../hostedHub/state";
import { useMobileE2eeChannelStatus } from "../e2ee/useMobileE2eeSession";
import { useMobileNativeE2eeEnrollmentStatus } from "../e2ee/useMobileNativeE2eeEnrollment";
import { acquireBeforeNodeSecurity } from "../e2ee/acquireBeforeNodeSecurity";
import { exactNodeRouteParams } from "../e2ee/exactNodeRouteModel";
import { useAuthoritativeNodeTrust } from "../home/useAuthoritativeNodeTrust";
import { NodeRow } from "../nodes/NodeRow";
import { hostedStatusTone } from "./hostedAuthModel";
import { hostedSelectionKey, type SettledHostedStatus } from "./settledHostedStatus";
import { useHostedModeAvailable } from "./useHostedMode";
import { useSettledHostedStatus } from "./useSettledHostedStatus";

/**
 * The hosted plane's half of the environment switcher (plan Task 8).
 *
 * Deliberately a *separate* section from the direct saved devices: the two
 * planes have different selection models (single hosted selection vs. direct
 * multi-connect), different guards, and different refresh cadence (the hosted
 * directory re-polls every 20s from the runtime; the direct catalog does not).
 * Merging them into one list would hide all three.
 *
 * This module touches the hosted plane only — never the direct catalog, the
 * direct registry store, or the direct bearer-token storage. Selection is the
 * controller's `selectNode`; no hosted state is re-derived here, and no status
 * string is hand-written (they come from `deriveHostedConnectionStatus*`).
 */

const ROLE_LABELS: Record<RelayEffectiveRole, string> = {
  viewer: "Viewer",
  operator: "Operator",
  owner: "Owner",
};

const ONLINE_TONE: StatusTone = {
  label: "Online",
  pillClassName: "bg-success-bg border border-success-border",
  textClassName: "text-success",
};
const OFFLINE_TONE: StatusTone = {
  label: "Offline",
  pillClassName: "bg-subtle",
  textClassName: "text-foreground-muted",
};
const REVOKED_TONE: StatusTone = {
  label: "Revoked",
  pillClassName: "bg-danger border border-danger-border",
  textClassName: "text-danger-foreground",
};

/** Actions the section drives. Structural so tests can pass a fake controller. */
export interface HubNodeSectionActions {
  readonly selectNode: (nodeId: string) => unknown;
  readonly returnToDirectory: () => unknown;
  readonly refreshDirectory: () => unknown;
  readonly retrySelectedNode: () => unknown;
  readonly renameNode?: (node: HostedHubNode) => void;
  readonly openNodeSecurity?: (node: HostedHubNode) => unknown;
}

export interface HubNodeRowModel {
  readonly canEditIcon?: boolean;
  readonly environmentId?: HostedHubNode["environmentId"];
  readonly platformOs?: string;
  readonly nodeId: string;
  readonly rename?: (() => void) | undefined;
  readonly label: string;
  /** Bounded presence/role summary. Never an id, token, ticket, or raw error. */
  readonly detail: string;
  readonly transportLabel: "Hub relay";
  readonly tone: StatusTone;
  readonly selected: boolean;
  readonly disabled: boolean;
  /** `undefined` whenever the row must not be tappable — never a broken handler. */
  readonly onPress: (() => void) | undefined;
}

export type HubNodeSectionKind = "unavailable" | "signed-out" | "busy" | "ready";

export interface HubNodeSectionModel {
  readonly kind: HubNodeSectionKind;
  /** From `deriveHostedConnectionStatusIndicator` — never hand-written. */
  readonly statusLabel: string;
  readonly statusTone: StatusTone;
  /** The full bounded status text, used as the pill's accessible name. */
  readonly statusText: string;
  readonly rows: ReadonlyArray<HubNodeRowModel>;
  readonly empty: { readonly title: string; readonly detail: string } | null;
  readonly signIn: (() => void) | undefined;
  readonly refresh: (() => void) | undefined;
  readonly allNodes: (() => void) | undefined;
  readonly retry: (() => void) | undefined;
}

/**
 * The controller's own fail-closed selection guard, mirrored so a row that
 * `selectNode` would silently drop is never presented as tappable
 * (`authorization/state.ts` `selectNode`: directory ready, browser current,
 * not revoked). `revokedAt` is compared against `null` rather than tested for
 * truthiness so an epoch-zero revocation still disables the row.
 */
export function canSelectHubNode(state: HostedHubState, node: HostedHubNode): boolean {
  return (
    state.accountStatus === "authenticated" &&
    state.directoryStatus === "ready" &&
    state.browserStatus === "current" &&
    node.revokedAt === null
  );
}

function rowDetail(node: HostedHubNode): string {
  const role = ROLE_LABELS[node.effectiveRole];
  if (node.revokedAt !== null) return `Revoked · ${role}`;
  return `${node.presence.online ? "Online" : "Offline"} · ${role}`;
}

function rowTone(node: HostedHubNode): StatusTone {
  if (node.revokedAt !== null) return REVOKED_TONE;
  return node.presence.online ? ONLINE_TONE : OFFLINE_TONE;
}

export function deriveHubNodeSectionModel(input: {
  readonly state: HostedHubState;
  /** `useHostedModeAvailable()` — hosted config plus a usable hardware key. */
  readonly available: boolean;
  /**
   * `useMobileE2eeChannelStatus()` — §4.4's locked mode for the selected node's
   * channel. Required for the reason `HostedSignInViewInput` documents: §12.2's
   * legacy label is mandatory on every surface, and this is one of them.
   */
  readonly e2eeStatus: HostedE2eeChannelStatus;
  readonly nativeDeviceSecurityStatus?: HostedNativeDeviceSecurityStatus;
  /**
   * The settled presentation of the pair derived below (`settledHostedStatus`),
   * when the caller runs one. PRESENTATION ONLY: it never changes which status
   * this model derives, only which one is on screen, so a re-target cannot
   * strobe the chip through seven step labels. Absent — every existing caller
   * and every test — the derived pair is displayed directly.
   */
  readonly settledStatus?: SettledHostedStatus;
  readonly actions: HubNodeSectionActions;
  readonly onSignIn: () => void;
  readonly query?: string;
  readonly connections?: ReadonlyArray<MobileHostedConnectionState>;
  readonly trustByEnvironmentId?: ReadonlyMap<string, WorkspaceNativeTrustState>;
}): HubNodeSectionModel {
  const { state, available, actions, onSignIn } = input;
  const statusInput = {
    browserStatus: state.browserStatus,
    sessionStatus: state.sessionStatus,
    selectionStatus: state.selectionStatus,
    transportStatus: state.transportStatus,
    e2eeStatus: input.e2eeStatus,
    nativeDeviceSecurityStatus: input.nativeDeviceSecurityStatus,
  };
  const indicator =
    input.settledStatus?.indicator ?? deriveHostedConnectionStatusIndicator(statusInput);
  const statusText =
    input.settledStatus?.statusText ?? deriveHostedConnectionStatusText(statusInput);
  const base = {
    statusLabel: indicator.shortLabel,
    statusText,
    // Shared with every other hosted surface so a pill here can never contradict
    // the same state rendered on the sign-in or account screen.
    statusTone: hostedStatusTone(indicator),
    rows: [] as ReadonlyArray<HubNodeRowModel>,
    signIn: undefined,
    refresh: undefined,
    allNodes: undefined,
    retry: undefined,
  } as const;

  if (!available || state.accountStatus === "unavailable") {
    return {
      ...base,
      kind: "unavailable",
      empty: {
        title: "Hub nodes unavailable",
        detail:
          "This build has no Hub configured, or this device has no hardware key for a Hub session. Pair a device directly to keep working.",
      },
    };
  }

  if (state.accountStatus === "signed-out" || state.accountStatus === "session-expired") {
    return {
      ...base,
      kind: "signed-out",
      empty: {
        title: state.accountStatus === "session-expired" ? "Hub session expired" : "Not signed in",
        detail: "Continue in your browser, then approve this device to reach your Hub nodes.",
      },
      signIn: onSignIn,
    };
  }

  if (state.accountStatus !== "authenticated") {
    return {
      ...base,
      kind: "busy",
      empty: {
        title: state.accountStatus === "signing-out" ? "Signing out" : "Signing in",
        detail: "Finish signing in and approving this device in your browser.",
      },
    };
  }

  const query = input.query?.trim().toLocaleLowerCase() ?? "";
  const rows = state.nodes
    .filter(
      (node) => !query || `${node.label} ${rowDetail(node)}`.toLocaleLowerCase().includes(query),
    )
    .map((node): HubNodeRowModel => {
      const trust = input.trustByEnvironmentId?.get(node.environmentId);
      const trusted =
        trust === undefined ||
        trust === "verified" ||
        trust === "account-trusted" ||
        trust === "not-required";
      const selectable = canSelectHubNode(state, node) && trusted;
      const canVerify = node.revokedAt === null && !trusted && actions.openNodeSecurity;
      const trustDetail =
        trust === "identity-conflict"
          ? "Identity changed"
          : trust === "unknown"
            ? "Verification unavailable"
            : trust === "unverified"
              ? "Not verified"
              : trust === "account-trusted"
                ? "Encrypted · Account trusted"
                : null;
      const connection = input.connections?.find(
        (current) => current.environmentId === node.environmentId && current.nodeId === node.id,
      );
      return {
        nodeId: node.id,
        environmentId: node.environmentId,
        platformOs: node.platformOs,
        canEditIcon:
          trusted &&
          node.revokedAt === null &&
          node.effectiveRole === "owner" &&
          state.accountStatus === "authenticated" &&
          state.selectedNode?.id === node.id &&
          resolveHostedRpcCapability({
            hosted: true,
            role: connection?.effectiveRole ?? null,
            fresh: state.directoryStatus === "ready" && connection?.transportStatus === "online",
            browserCurrent: state.browserStatus === "current",
            sessionReady: connection?.sessionStatus === "ready",
            method: WS_METHODS.serverUpdateSettings,
          }).allowed,

        rename:
          state.directoryStatus === "ready" &&
          state.accountStatus === "authenticated" &&
          node.effectiveRole === "owner" &&
          node.revokedAt === null &&
          actions.renameNode
            ? () => actions.renameNode?.(node)
            : undefined,
        label: node.label,
        detail: trustDetail ? `${trustDetail} · ${rowDetail(node)}` : rowDetail(node),
        transportLabel: "Hub relay",
        // The selected node's row shows the live connection status; every other
        // row shows directory presence, which is all the directory knows.
        tone:
          state.selectedNode?.id === node.id && node.revokedAt === null
            ? base.statusTone
            : rowTone(node),
        selected: state.selectedNode?.id === node.id,
        disabled: !selectable && !canVerify,
        onPress: selectable
          ? () => void actions.selectNode(node.id)
          : canVerify
            ? () => void actions.openNodeSecurity?.(node)
            : undefined,
      };
    });

  return {
    ...base,
    kind: "ready",
    rows,
    empty:
      rows.length === 0
        ? {
            title: query && state.nodes.length > 0 ? "No matching Hub nodes" : "No Hub nodes",
            detail:
              query && state.nodes.length > 0
                ? "Change the search to see other Hub nodes."
                : state.directoryStatus === "ready"
                  ? "Enroll a Ryco node with your Hub to reach it from anywhere."
                  : "Loading the node directory.",
          }
        : null,
    refresh: () => void actions.refreshDirectory(),
    allNodes: state.selectedNode ? () => void actions.returnToDirectory() : undefined,
    retry:
      state.selectedNode && state.transportStatus === "terminal-failure"
        ? () => void actions.retrySelectedNode()
        : undefined,
  };
}

function ActionPill(props: { readonly label: string; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      className="h-11 items-center justify-center rounded-full border border-border px-3 active:opacity-70"
    >
      <Text className="text-xs font-ryco-bold text-foreground">{props.label}</Text>
    </Pressable>
  );
}

/** Presentation only — every decision above lives in `deriveHubNodeSectionModel`. */
export function HubNodeSectionView(props: { readonly model: HubNodeSectionModel }) {
  const { model } = props;
  return (
    <View className="mt-6">
      <View className="flex-row items-center gap-3 px-5 pb-2.5">
        <Text className="flex-1 text-sm font-ryco-medium text-foreground-muted">Hub nodes</Text>
        {model.kind === "ready" ? (
          <StatusPill
            size="compact"
            label={model.statusLabel}
            pillClassName={model.statusTone.pillClassName}
            textClassName={model.statusTone.textClassName}
          />
        ) : null}
      </View>

      {model.rows.length > 0 ? (
        <View className="mx-5 overflow-hidden rounded-2xl border border-border bg-card">
          {model.rows.map((row, index) => (
            <NodeRow
              key={row.nodeId}
              environmentId={row.environmentId}
              platformOs={row.platformOs}
              canEditIcon={row.canEditIcon}
              label={row.label}
              detail={row.detail}
              transportLabel={row.transportLabel}
              statusTone={row.tone}
              selected={row.selected}
              selectable
              disabled={row.disabled}
              showDivider={index > 0}
              onPress={row.onPress}
              actions={row.rename ? [{ label: "Rename", onPress: row.rename }] : []}
            />
          ))}
        </View>
      ) : null}

      {model.empty ? (
        <View className="px-5 py-8">
          <EmptyState
            variant="plain"
            title={model.empty.title}
            detail={model.empty.detail}
            actionLabel={model.signIn ? "Continue in browser" : undefined}
            onAction={model.signIn}
          />
        </View>
      ) : null}

      {model.allNodes || model.refresh || model.retry ? (
        <View className="mx-5 mt-3 flex-row gap-2">
          {model.allNodes ? <ActionPill label="All nodes" onPress={model.allNodes} /> : null}
          {model.refresh ? <ActionPill label="Refresh" onPress={model.refresh} /> : null}
          {model.retry ? <ActionPill label="Retry" onPress={model.retry} /> : null}
        </View>
      ) : null}
    </View>
  );
}

export function HubNodeSection(props: { readonly query?: string } = {}) {
  const navigation = useNavigation();
  const [renameTarget, setRenameTarget] = useState<HostedHubNode | null>(null);
  const state = useHostedHubStore((current) => current);
  const connections = useMobileHostedConnectionsStore((current) => current.selectedNodes);
  // Shared with the other hosted surfaces: it drives the single memoized
  // `ensureMobileHostedSession()` and reports the runtime's own availability
  // flag, so a direct-only build (or a device with no usable hardware key)
  // renders the disabled state instead of a tappable-but-broken row.
  const available = useHostedModeAvailable();
  // docs/relay-e2ee-protocol.md §12.2: the pill beside a node says what §4.4
  // locked, so a fallen-back channel reads `Legacy` here and not `Online`.
  const e2eeStatus = useMobileE2eeChannelStatus(state.selectedNode?.environmentId ?? null);
  const nativeDeviceSecurityStatus = useMobileNativeE2eeEnrollmentStatus();
  const trustByEnvironmentId = useAuthoritativeNodeTrust(
    state.nodes.map((node) => ({ environmentId: node.environmentId, nodeId: node.id })),
  );

  // Settling is applied to the DERIVED pair, not to any input of the
  // derivation: re-targeting the hosted connection walks the chip through up to
  // seven step labels in a few hundred milliseconds, and this collapses that
  // walk without ever changing, delaying, or softening a mandatory claim
  // (§12.2 `Legacy`, §13.1 `Not verified` are settled states and display at
  // once). The selected row's tone reads the same settled pair through
  // `base.statusTone`, so the row and the pill cannot disagree.
  const statusInput = {
    browserStatus: state.browserStatus,
    sessionStatus: state.sessionStatus,
    selectionStatus: state.selectionStatus,
    transportStatus: state.transportStatus,
    e2eeStatus,
    nativeDeviceSecurityStatus,
  };
  const settledStatus = useSettledHostedStatus({
    indicator: deriveHostedConnectionStatusIndicator(statusInput),
    statusText: deriveHostedConnectionStatusText(statusInput),
    selectionKey: hostedSelectionKey(state.selectedNode),
  });

  const model = deriveHubNodeSectionModel({
    state,
    connections,
    available,
    e2eeStatus,
    nativeDeviceSecurityStatus,
    settledStatus,
    actions: {
      renameNode: setRenameTarget,
      selectNode: acquireMobileHostedNode,
      returnToDirectory: () => hostedHubController.returnToDirectory(),
      refreshDirectory: () => hostedHubController.refreshDirectory(),
      retrySelectedNode: () => hostedHubController.retrySelectedNode(),
      openNodeSecurity: (node) =>
        acquireBeforeNodeSecurity({
          nodeId: node.id,
          acquireNode: acquireMobileHostedNode,
          openSecurity: () =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsNodeSecurity",
              params: exactNodeRouteParams(node),
            }),
        }),
    },
    // Sign-in uses the same full-screen native identity surface as the root gate.
    onSignIn: () => navigation.navigate("Access"),
    query: props.query,
    trustByEnvironmentId,
  });

  return (
    <>
      <HubNodeSectionView model={model} />
      {renameTarget &&
        state.accountStatus === "authenticated" &&
        state.nodes.some(
          (node) =>
            node.id === renameTarget.id &&
            node.effectiveRole === "owner" &&
            node.revokedAt === null,
        ) && (
          <DeviceRenameSheet
            key={renameTarget.id}
            label={renameTarget.label}
            onClose={() => setRenameTarget(null)}
            onSave={async (label) => {
              await getHostedHubApi().renameNode(renameTarget.id, label);
              await hostedHubController.refreshDirectory();
            }}
          />
        )}
    </>
  );
}
