import { StackActions, useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";

import type { EnvironmentId } from "@ryco/contracts";

import { AppText as Text } from "../../components/AppText";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { NavigationHeaderButton } from "../../components/NavigationHeaderButton";
import { useThemeColor } from "../../lib/useThemeColor";
import { useStore } from "../../state/threadsRuntime";
import {
  type ConnectionRow,
  useConnectionActions,
  useSavedEnvironments,
} from "../connection/useConnectionController";
import { HOME_LIST_PADDING_BOTTOM } from "../home/homeChromeModel";
import { HubNodeSection } from "../hostedHub/HubNodeSection";
import { NodeRow, type NodeRowAction } from "./NodeRow";
import { directRoleLabel, directTransportLabel } from "./nodesModel";

interface RenameTarget {
  readonly environmentId: EnvironmentId;
}

function endpointLabel(httpBaseUrl: string): string {
  try {
    return new URL(httpBaseUrl).host;
  } catch {
    return "Saved endpoint";
  }
}

function RenameNodeSheet(props: {
  readonly target: RenameTarget | null;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onClose: () => void;
  readonly onSave: () => void;
}) {
  const placeholderColor = useThemeColor("--color-placeholder");
  const textColor = useThemeColor("--color-foreground");
  if (!props.target) return null;
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <View className="flex-1 gap-5 bg-screen px-5 pt-5">
        <View className="flex-row items-center">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel rename"
            onPress={props.onClose}
            className="h-11 min-w-16 items-center justify-center rounded-full active:bg-subtle"
          >
            <Text className="text-base font-ryco-medium text-foreground">Cancel</Text>
          </Pressable>
          <Text className="flex-1 text-center text-lg font-ryco-bold text-foreground">
            Rename machine
          </Text>
          <View className="h-11 min-w-16" />
        </View>
        <Text className="font-sans text-base text-foreground-muted">
          Choose the name shown on this device. The machine and its credentials do not change.
        </Text>
        <TextInput
          autoFocus
          value={props.value}
          onChangeText={props.onChange}
          placeholder="Machine name"
          placeholderTextColor={placeholderColor as string}
          className="min-h-14 rounded-2xl border border-border bg-card px-4 py-3 font-sans text-base"
          style={{ color: textColor as string }}
          returnKeyType="done"
          onSubmitEditing={props.onSave}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save machine name"
          disabled={!props.value.trim()}
          onPress={props.onSave}
          className="h-12 items-center justify-center rounded-full bg-primary px-5 active:opacity-80 disabled:opacity-40"
        >
          <Text className="text-base font-ryco-bold text-primary-foreground">Save</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

export function NodesScreen(props: {
  readonly query?: string;
  readonly initialScrollOffset?: number;
  readonly onScrollOffset?: (offset: number) => void;
}) {
  const navigation = useNavigation();
  const { rows } = useSavedEnvironments();
  const actions = useConnectionActions();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const [busy, setBusy] = useState<EnvironmentId | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const query = props.query?.trim().toLocaleLowerCase() ?? "";
  const visibleRows = query
    ? rows.filter((row) =>
        `${row.record.label} ${row.record.httpBaseUrl} ${directTransportLabel(row.record.httpBaseUrl)}`
          .toLocaleLowerCase()
          .includes(query),
      )
    : rows;

  const withBusy = async (id: EnvironmentId, run: () => Promise<void>) => {
    setBusy(id);
    setActionError(null);
    try {
      await run();
    } catch {
      setActionError("The direct pairing could not be updated. Check the machine and try again.");
    } finally {
      setBusy(null);
    }
  };

  const directActionsFor = (row: ConnectionRow): ReadonlyArray<NodeRowAction> => {
    const id = row.record.environmentId;
    const isConnected = row.runtime.connectionState === "connected";
    const isConnecting = row.runtime.connectionState === "connecting";
    const isSelected = activeEnvironmentId === id;
    const disabled = busy !== null;
    const rowActions: NodeRowAction[] = [];

    if (!isSelected || !isConnected) {
      rowActions.push({
        label: isConnected ? "Use" : row.runtime.connectionState === "error" ? "Retry" : "Connect",
        disabled,
        onPress: () =>
          void withBusy(id, async () => {
            useStore.getState().setActiveEnvironmentId(id);
            if (!isConnected) await actions.reconnectSavedEnvironment(id);
          }),
      });
    }
    if (isConnected || isConnecting) {
      rowActions.push({
        label: "Disconnect",
        disabled,
        onPress: () => void withBusy(id, () => actions.disconnectSavedEnvironment(id)),
      });
    }
    rowActions.push(
      {
        label: "Rename",
        disabled,
        onPress: () => {
          setRenameTarget({ environmentId: id });
          setRenameValue(row.record.label);
        },
      },
      {
        label: "Forget",
        destructive: true,
        disabled,
        onPress: () =>
          showConfirmDialog({
            title: `Forget ${row.record.label}?`,
            message:
              "This removes the saved direct pairing and its local credential. You can pair the machine again later.",
            confirmText: "Forget",
            destructive: true,
            onConfirm: () =>
              void withBusy(id, () => actions.removeSavedEnvironment(row.record.environmentId)),
          }),
      },
    );
    return rowActions;
  };

  const saveRename = () => {
    if (!renameTarget || !renameValue.trim()) return;
    actions.renameSavedEnvironment(renameTarget.environmentId, renameValue.trim());
    setRenameTarget(null);
  };

  return (
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="never"
        className="flex-1"
        contentContainerStyle={{ paddingBottom: HOME_LIST_PADDING_BOTTOM }}
        contentOffset={{ x: 0, y: props.initialScrollOffset ?? 0 }}
        onScroll={(event) => props.onScrollOffset?.(event.nativeEvent.contentOffset.y)}
        scrollEventThrottle={32}
      >
        {/* Settings moved to the Home header gear. This headerless sheet keeps
            its dismissal action visible beside its primary machine action. */}
        <View className="mx-4 mt-5 flex-row items-center gap-2">
          <NavigationHeaderButton
            action="close"
            accessibilityLabel="Close Machines"
            onPress={() => {
              if (navigation.canGoBack()) navigation.goBack();
              else navigation.dispatch(StackActions.replace("Home"));
            }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Pair a machine directly"
            onPress={() => navigation.navigate("ConnectionsNew")}
            className="h-12 flex-1 flex-row items-center justify-center rounded-2xl bg-primary px-5 active:opacity-80"
          >
            <Text className="text-base font-ryco-bold text-primary-foreground">Pair directly</Text>
          </Pressable>
        </View>

        {actionError ? <ErrorBanner message={actionError} /> : null}

        <HubNodeSection query={query} />

        <Text className="px-5 pt-7 pb-2.5 text-sm font-ryco-medium text-foreground-muted">
          Paired directly
        </Text>

        {visibleRows.length === 0 ? (
          <View className="px-5 py-6">
            <EmptyState
              variant="plain"
              title={query ? "No matching machines" : "No machines paired directly"}
              detail={
                query
                  ? "Change the search to see other machines."
                  : "Pair with a QR code, pairing URL, LAN address, or Tailscale address."
              }
            />
          </View>
        ) : (
          <View className="mx-4 overflow-hidden rounded-2xl border border-border bg-card">
            {visibleRows.map((row, index) => (
              <NodeRow
                key={row.record.environmentId}
                environmentId={row.record.environmentId}
                canEditIcon={
                  row.runtime.connectionState === "connected" && row.runtime.role === "owner"
                }
                label={row.record.label}
                detail={`${directRoleLabel(row.runtime.role)} · ${endpointLabel(row.record.httpBaseUrl)}`}
                transportLabel={directTransportLabel(row.record.httpBaseUrl)}
                statusTone={{ ...row.tone, label: row.statusLabel }}
                selected={activeEnvironmentId === row.record.environmentId}
                showDivider={index > 0}
                actions={directActionsFor(row)}
              />
            ))}
          </View>
        )}
      </ScrollView>

      <RenameNodeSheet
        target={renameTarget}
        value={renameValue}
        onChange={setRenameValue}
        onClose={() => setRenameTarget(null)}
        onSave={saveRename}
      />
    </>
  );
}
