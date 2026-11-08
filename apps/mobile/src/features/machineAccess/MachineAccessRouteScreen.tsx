import type { StaticScreenProps } from "@react-navigation/native";
import { getHostedHubApi, type HostedHubNode } from "@ryco/client-runtime/authorization";
import {
  HOSTED_NODE_REVOKE_REASON_CODE,
  hostedNodeRevokedNotice,
} from "@ryco/client-runtime/machineAccess/hostedNodeRevoke";
import { EnvironmentId } from "@ryco/contracts/base-schemas";
import { useState } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { hostedHubController, useHostedHubStore } from "../../hostedHub/state";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import { useSavedEnvironments } from "../connection/useConnectionController";
import { AddDeviceSheet, sharePairingLink } from "./AddDeviceSheet";
import { HubNodeRevokeSheet } from "./HubNodeRevokeSheet";
import {
  AccessPrimaryRow,
  AccessQuietRow,
  AccessRow,
  AccessSection,
  AccessUnavailable,
  ActionChip,
  DANGER_TONE,
  LIVE_TONE,
  QUIET_TONE,
} from "./MachineAccessParts";
import {
  clientSessionRows,
  deriveDirectAccessAvailability,
  deriveHubRevokeAvailability,
  deriveNetworkExposure,
  hasOtherClientSessions,
  hubNodePlatformLabel,
  machineAccessHeader,
  pairingLinkRows,
  pairingLinkShareUrl,
  revokeClientSessionConfirm,
  revokedOthersNotice,
  revokeOtherClientSessionsConfirm,
  revokePairingLinkConfirm,
  type ConfirmCopy,
} from "./machineAccessModel";
import { directAccessErrorMessage, runDirectAccessAction } from "./machineAccessOperations";
import {
  useAdvertisedEndpoints,
  useAuthAccessList,
  useDirectAccessOperations,
  useNowMs,
} from "./useMachineAccess";

type MachineAccessRouteProps = StaticScreenProps<{
  readonly environmentId: string | string[];
}>;

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function confirmThen(copy: ConfirmCopy, run: () => void): void {
  showConfirmDialog({
    title: copy.title,
    message: copy.message,
    confirmText: copy.confirmText,
    destructive: true,
    onConfirm: run,
  });
}

/**
 * One machine's access, for an owner: who may pair (pairing links, and a new
 * one-time code), who has paired (clients, this phone marked), where the
 * machine can be reached, and, for a Hub node, revoking it from the Hub.
 * Everything this phone may not do is explained in place.
 */
export function MachineAccessRouteScreen(props: MachineAccessRouteProps) {
  const environmentIdRaw = firstParam(props.route.params.environmentId);
  const environmentId = EnvironmentId.make(environmentIdRaw ?? "");
  const nowMs = useNowMs();
  const { rows } = useSavedEnvironments();
  const hub = useHostedHubStore((state) => state);
  const serverConfigs = useEnvironmentServerConfigs();
  const operations = useDirectAccessOperations(environmentId);

  const direct = rows.find((row) => row.record.environmentId === environmentId) ?? null;
  const hubNode = hub.nodes.find((node) => node.environmentId === environmentId) ?? null;
  const header = machineAccessHeader({
    directLabel: direct === null ? null : direct.record.label,
    directRole: direct === null ? null : direct.runtime.role,
    hubNode,
  });
  const availability = deriveDirectAccessAvailability(
    direct === null
      ? null
      : {
          label: direct.record.label,
          role: direct.runtime.role,
          connected: direct.runtime.connectionState === "connected",
          switchedOff: direct.switchedOff,
          requiresAuth: direct.runtime.authState === "requires-auth",
        },
    header.title,
  );
  const managed = availability.kind === "available";
  const access = useAuthAccessList(managed ? environmentId : null);
  const endpoints = useAdvertisedEndpoints(environmentId);
  const authPolicy = serverConfigs.get(environmentId)?.auth.policy ?? null;
  const network = deriveNetworkExposure({ endpoints: endpoints.endpoints, authPolicy });
  const links = pairingLinkRows(access.list.pairingLinks, nowMs);
  const clients = clientSessionRows(access.list.clientSessions, nowMs);
  const hubRevoke =
    hubNode === null
      ? null
      : deriveHubRevokeAvailability({
          node: hubNode,
          signedIn: hub.accountStatus === "authenticated",
          accountRole: hub.account === null ? null : hub.account.role,
        });

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addDeviceOpening, setAddDeviceOpening] = useState<number | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<HostedHubNode | null>(null);

  const run = async <T,>(key: string, action: string, call: () => Promise<T>) => {
    setBusyKey(key);
    setActionError(null);
    setNotice(null);
    const outcome = await runDirectAccessAction(call, (error) =>
      directAccessErrorMessage(error, action, header.title),
    );
    setBusyKey(null);
    if (!outcome.ok) setActionError(outcome.message);
    return outcome;
  };

  const revokeOthers = async () => {
    const outcome = await run("others", "remove other clients", () =>
      operations.revokeOtherClientSessions(),
    );
    if (outcome.ok) setNotice(revokedOthersNotice(outcome.value));
  };

  const revokeHubNode = async (node: HostedHubNode) => {
    // Resolves only once the Hub answered: the row leaving the directory is not
    // the receipt, because the re-read below can fail and leave the list as it was.
    await getHostedHubApi().revokeNode(node.id, HOSTED_NODE_REVOKE_REASON_CODE);
    setNotice(hostedNodeRevokedNotice(node.label));
    await hostedHubController.refreshDirectory();
  };

  return (
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1 bg-screen"
        contentContainerStyle={{ paddingTop: 12, paddingBottom: 48 }}
      >
        <View className="px-5 pt-2">
          <Text className="text-2xl font-ryco-bold text-foreground">{header.title}</Text>
          <Text className="mt-1.5 font-sans text-sm text-foreground-muted">{header.subtitle}</Text>
        </View>

        {notice !== null ? (
          <View className="mx-5 mt-4 rounded-2xl border border-border bg-card px-4 py-3">
            <Text className="font-sans text-sm leading-relaxed text-foreground">{notice}</Text>
          </View>
        ) : null}
        {actionError !== null ? (
          <View className="mx-5 mt-4">
            <ErrorBanner message={actionError} />
          </View>
        ) : null}

        {!header.known ? (
          <View className="px-5 py-12">
            <EmptyState
              variant="plain"
              title="Machine not found"
              detail="This phone has no direct pairing for this machine and your Hub does not list it."
            />
          </View>
        ) : availability.kind === "unavailable" ? (
          <AccessSection title="Pairing and clients">
            <AccessUnavailable title={availability.title} detail={availability.detail} />
          </AccessSection>
        ) : (
          <>
            <AccessSection
              title="Pairing links"
              footnote="A new code pairs one device as a client. It works once and expires in a few minutes."
            >
              <AccessPrimaryRow
                label="Add a device"
                detail="Show a QR code, link and code to pair a phone or computer"
                onPress={() => setAddDeviceOpening((opening) => (opening ?? 0) + 1)}
              />
              {access.status === "loading" && links.length === 0 ? (
                <View className="border-t border-border-subtle">
                  <AccessQuietRow label="Loading pairing links…" loading />
                </View>
              ) : null}
              {access.status === "failed" ? (
                <View className="border-t border-border-subtle">
                  <AccessQuietRow label="The machine stopped sending its access list. Reopen this screen to retry." />
                </View>
              ) : null}
              {links.map((row) => {
                const shareUrl =
                  row.credential === null
                    ? null
                    : pairingLinkShareUrl(endpoints.endpoints, row.credential);
                return (
                  <AccessRow
                    key={row.id}
                    first={false}
                    title={row.title}
                    detail={row.detail}
                    note={row.note}
                    actions={[
                      ...(shareUrl !== null
                        ? [
                            { label: "Share", onPress: () => sharePairingLink(shareUrl) },
                            { label: "Copy link", onPress: () => copyTextWithHaptic(shareUrl) },
                          ]
                        : []),
                      {
                        label: busyKey === row.id ? "Revoking…" : "Revoke",
                        destructive: true,
                        disabled: busyKey !== null,
                        onPress: () =>
                          confirmThen(
                            revokePairingLinkConfirm(row),
                            () =>
                              void run(row.id, "revoke this pairing link", () =>
                                operations.revokeCode(row.id),
                              ),
                          ),
                      },
                    ]}
                  />
                );
              })}
            </AccessSection>

            <AccessSection
              title="Clients"
              trailing={
                hasOtherClientSessions(access.list.clientSessions) ? (
                  <ActionChip
                    label={busyKey === "others" ? "Removing…" : "Remove others"}
                    destructive
                    disabled={busyKey !== null}
                    onPress={() =>
                      confirmThen(
                        revokeOtherClientSessionsConfirm(header.title),
                        () => void revokeOthers(),
                      )
                    }
                  />
                ) : null
              }
            >
              {clients.length === 0 ? (
                <AccessQuietRow
                  label={
                    access.status === "loading" ? "Loading clients…" : "No clients paired yet."
                  }
                  loading={access.status === "loading"}
                />
              ) : null}
              {clients.map((row, index) => (
                <AccessRow
                  key={row.sessionId}
                  first={index === 0}
                  title={row.title}
                  detail={row.detail}
                  status={{ ...(row.live ? LIVE_TONE : QUIET_TONE), label: row.status }}
                  actions={
                    row.canRevoke
                      ? [
                          {
                            label: busyKey === row.sessionId ? "Removing…" : "Remove",
                            destructive: true,
                            disabled: busyKey !== null,
                            onPress: () =>
                              confirmThen(
                                revokeClientSessionConfirm(row, header.title),
                                () =>
                                  void run(row.sessionId, "remove this client", () =>
                                    operations.revokeClientSession(row.sessionId),
                                  ),
                              ),
                          },
                        ]
                      : []
                  }
                />
              ))}
            </AccessSection>
          </>
        )}

        {!header.known ? null : (
          <AccessSection title="Network" footnote={network.footnote}>
            {network.summary !== null ? (
              <AccessRow first title="Network access" detail={network.summary} />
            ) : null}
            {network.tailscaleHttps !== null ? (
              <AccessRow
                first={network.summary === null}
                title="Tailscale HTTPS"
                status={{
                  ...(network.tailscaleHttps === "on" ? LIVE_TONE : QUIET_TONE),
                  label: network.tailscaleHttps === "on" ? "On" : "Off",
                }}
              />
            ) : null}
            {endpoints.status === "idle" ? (
              <AccessQuietRow
                label={`Connect to ${header.title} to see where it can be reached.`}
              />
            ) : endpoints.status === "loading" ? (
              <AccessQuietRow label="Reading reachable addresses…" loading />
            ) : endpoints.status === "failed" ? (
              <AccessQuietRow label="The machine did not list its addresses." />
            ) : network.endpoints.length === 0 ? (
              <AccessQuietRow label="The machine advertises no addresses." />
            ) : null}
            {network.endpoints.map((row, index) => (
              <AccessRow
                key={row.id}
                first={index === 0 && network.summary === null && network.tailscaleHttps === null}
                title={row.isDefault ? `${row.label} · used for links` : row.label}
                detail={row.hint}
                mono={row.url}
                status={{
                  ...(row.status === "Available"
                    ? LIVE_TONE
                    : row.status === "Unavailable"
                      ? DANGER_TONE
                      : QUIET_TONE),
                  label: row.status,
                }}
              />
            ))}
          </AccessSection>
        )}

        {hubNode !== null && hubRevoke !== null ? (
          <AccessSection title="Hub">
            <AccessRow
              first
              title="Node ID"
              mono={hubNode.id}
              detail={hubNodePlatformLabel(hubNode)}
              actions={[{ label: "Copy ID", onPress: () => copyTextWithHaptic(hubNode.id) }]}
            />
            {hubRevoke.kind === "available" ? (
              <View className="border-t border-border-subtle">
                <AccessPrimaryRow
                  destructive
                  label="Revoke from Hub…"
                  detail="Removes this node from the Hub for every account. It cannot be undone."
                  onPress={() => setRevokeTarget(hubNode)}
                />
              </View>
            ) : (
              <AccessRow first={false} title="Revoke from Hub" detail={hubRevoke.detail} />
            )}
          </AccessSection>
        ) : null}
      </ScrollView>

      {addDeviceOpening !== null ? (
        <AddDeviceSheet
          key={addDeviceOpening}
          machineLabel={header.title}
          operations={operations}
          access={access.list}
          endpoints={endpoints.endpoints}
          onClose={() => setAddDeviceOpening(null)}
        />
      ) : null}

      {revokeTarget !== null ? (
        <HubNodeRevokeSheet
          node={revokeTarget}
          onClose={() => setRevokeTarget(null)}
          onRevoke={() => revokeHubNode(revokeTarget)}
        />
      ) : null}
    </>
  );
}
