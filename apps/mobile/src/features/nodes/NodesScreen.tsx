import { StackActions, useNavigation } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { BackHandler, Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import type { EnvironmentId } from "@ryco/contracts";
import { describeHostFreeze } from "@ryco/client-runtime/connection";

import { AppText as Text } from "../../components/AppText";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { NavigationHeaderButton } from "../../components/NavigationHeaderButton";
import { useThemeColor } from "../../lib/useThemeColor";
import { useStore } from "../../state/threadsRuntime";
import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import { useHostFreezeNowMs } from "../../state/useHostFreezeNowMs";
import {
  type ConnectionRow,
  useConnectionActions,
  useSavedEnvironments,
} from "../connection/useConnectionController";
import { HOME_LIST_PADDING_BOTTOM } from "../home/homeChromeModel";
import {
  HubNodeRenameSheet,
  HubNodeSectionView,
  type HubNodeRowModel,
  useHubNodeSection,
} from "../hostedHub/HubNodeSection";
import { DeviceIconPickerSheet } from "./DeviceIconPicker";
import { MachineDetailPage } from "./MachineDetailPage";
import { MachineListRow } from "./MachineListRow";
import { useMachinesLook } from "./machinesSheetLook";
import { MACHINE_PAGE_SLIDE } from "./machinePageMotion";
import {
  type DirectMachineFacts,
  forgetMachineConfirm,
  MACHINES_SHEET_FOOTER,
  type MachineActionId,
} from "./machinesSheetModel";
import { directTransportLabel } from "./nodesModel";

interface RenameTarget {
  readonly environmentId: EnvironmentId;
}

/** The machine whose page is open: a plane and its id, or any plane for a link. */
export interface MachinePageKey {
  readonly plane: "direct" | "hub" | "any";
  readonly environmentId: string;
}

function endpointLabel(httpBaseUrl: string): string {
  try {
    return new URL(httpBaseUrl).host;
  } catch {
    return "Saved endpoint";
  }
}

function transportWord(httpBaseUrl: string): DirectMachineFacts["transport"] {
  const label = directTransportLabel(httpBaseUrl);
  return label === "Direct" ? "Direct" : label === "LAN · Direct" ? "LAN" : "Tailscale";
}

/** What the Machines sheet knows about a machine paired directly. */
export function directMachineFacts(input: {
  readonly row: ConnectionRow;
  readonly selected: boolean;
  readonly freezeNotice: string | null;
}): DirectMachineFacts {
  const { row } = input;
  return {
    plane: "direct",
    label: row.record.label,
    host: endpointLabel(row.record.httpBaseUrl),
    transport: transportWord(row.record.httpBaseUrl),
    role: row.runtime.role,
    connectionState: row.runtime.connectionState,
    statusLabel: row.statusLabel,
    needsRepair: row.runtime.authState === "requires-auth",
    switchedOff: row.switchedOff,
    selected: input.selected,
    freezeNotice: input.freezeNotice,
  };
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

/**
 * The Machines sheet (mockup "Machines sheet · per-machine rows", layout C): Hub nodes and the
 * machines paired directly as calm rows, and per machine one page that slides in over the list
 * with its actions, connection, settings, access and appearance.
 */
export function NodesScreen(props: {
  readonly query?: string;
  readonly initialScrollOffset?: number;
  readonly onScrollOffset?: (offset: number) => void;
  /** Opens this machine's page at once, as a link to it does. */
  readonly initialEnvironmentId?: string | null;
}) {
  const navigation = useNavigation();
  const look = useMachinesLook();
  const reduceMotion = useReducedMotion();
  const { rows } = useSavedEnvironments();
  const serverConfigs = useEnvironmentServerConfigs();
  const freezeNowMs = useHostFreezeNowMs(
    Array.from(serverConfigs.values(), (config) => config.lastEventLoopStall),
  );
  const actions = useConnectionActions();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const [busy, setBusy] = useState<EnvironmentId | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [page, setPage] = useState<MachinePageKey | null>(
    props.initialEnvironmentId ? { plane: "any", environmentId: props.initialEnvironmentId } : null,
  );
  const [width, setWidth] = useState(0);
  // 1 while a machine's page covers the list; it slides from the right edge (`.detail`).
  const progress = useSharedValue(props.initialEnvironmentId ? 1 : 0);
  const query = props.query?.trim().toLocaleLowerCase() ?? "";
  const hub = useHubNodeSection({ query });
  const visibleRows = query
    ? rows.filter((row) =>
        `${row.record.label} ${row.record.httpBaseUrl} ${directTransportLabel(row.record.httpBaseUrl)}`
          .toLocaleLowerCase()
          .includes(query),
      )
    : rows;

  const factsOf = (row: ConnectionRow) =>
    directMachineFacts({
      row,
      selected: activeEnvironmentId === row.record.environmentId,
      freezeNotice: describeHostFreeze(
        serverConfigs.get(row.record.environmentId)?.lastEventLoopStall,
        { nowMs: freezeNowMs },
      ),
    });

  const directPage =
    page && page.plane !== "hub"
      ? (rows.find((row) => row.record.environmentId === page.environmentId) ?? null)
      : null;
  const hubPage =
    page && page.plane !== "direct" && directPage === null
      ? (hub.model.rows.find((row) => row.environmentId === page.environmentId) ?? null)
      : null;
  const pageOpen = directPage !== null || hubPage !== null;

  const openPage = (key: MachinePageKey) => {
    setActionError(null);
    setIconPickerOpen(false);
    setPage(key);
    progress.set(reduceMotion ? 1 : withTiming(1, MACHINE_PAGE_SLIDE));
  };
  const closePage = () => {
    setIconPickerOpen(false);
    if (reduceMotion) {
      progress.set(0);
      setPage(null);
      return;
    }
    progress.set(
      withTiming(0, MACHINE_PAGE_SLIDE, (finished) => {
        if (finished) runOnJS(setPage)(null);
      }),
    );
  };

  // A link to one machine while the sheet is already up (`connections?environmentId=…`).
  const linkedEnvironmentId = props.initialEnvironmentId ?? null;
  useEffect(() => {
    if (linkedEnvironmentId === null) return;
    setPage({ plane: "any", environmentId: linkedEnvironmentId });
    progress.set(1);
  }, [linkedEnvironmentId, progress]);

  useEffect(() => {
    if (!pageOpen) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      closePage();
      return true;
    });
    return () => subscription.remove();
  });

  const pageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (1 - progress.get()) * width }],
  }));

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

  const runDirect = (row: ConnectionRow, action: MachineActionId) => {
    const id = row.record.environmentId;
    switch (action) {
      case "use":
      case "connect":
      case "retry":
        void withBusy(id, async () => {
          useStore.getState().setActiveEnvironmentId(id);
          if (row.runtime.connectionState !== "connected") {
            await actions.reconnectSavedEnvironment(id);
          }
        });
        return;
      case "re-pair":
        // The machine no longer accepts the saved pairing: pairing it again
        // from its saved address replaces the credential in place.
        navigation.navigate("ConnectionsNew", { repairEnvironmentId: id });
        return;
      case "disconnect":
        void withBusy(id, () => actions.disconnectSavedEnvironment(id));
        return;
      case "switch-off":
      case "switch-on":
        void withBusy(id, () => actions.setSavedEnvironmentEnabled(id, action === "switch-on"));
        return;
      case "rename":
        setRenameTarget({ environmentId: id });
        setRenameValue(row.record.label);
        return;
      case "access":
        navigation.navigate("MachineAccess", { environmentId: id });
        return;
      default:
        return;
    }
  };

  const forgetDirect = (row: ConnectionRow) => {
    const id = row.record.environmentId;
    showConfirmDialog({
      ...forgetMachineConfirm(row.record.label),
      destructive: true,
      onConfirm: () =>
        void withBusy(id, async () => {
          await actions.removeSavedEnvironment(id);
          closePage();
        }),
    });
  };

  const runHub = (row: HubNodeRowModel, action: MachineActionId) => {
    switch (action) {
      case "use":
      case "verify":
        // Selecting a node, or its verification first: the section's own fail-closed guard.
        row.onPress?.();
        return;
      case "add-direct":
      case "remove-direct":
        row.directAccess?.onPress();
        return;
      case "rename":
        row.rename?.();
        return;
      case "access":
        row.access?.();
        return;
      default:
        return;
    }
  };

  const saveRename = () => {
    if (!renameTarget || !renameValue.trim()) return;
    actions.renameSavedEnvironment(renameTarget.environmentId, renameValue.trim());
    setRenameTarget(null);
  };

  const openSettings = (
    environmentId: EnvironmentId,
    route:
      | "SettingsMachineProviders"
      | "SettingsMachineAgents"
      | "SettingsMachineWork"
      | "SettingsMachineSystem"
      | "SettingsMachineImport",
  ) => navigation.navigate(route, { environmentId });

  const pageEnvironmentId = directPage?.record.environmentId ?? hubPage?.environmentId ?? null;
  const pageLabel = directPage?.record.label ?? hubPage?.label ?? "";
  const pageCanEditIcon = directPage
    ? directPage.runtime.connectionState === "connected" && directPage.runtime.role === "owner"
    : hubPage?.canEditIcon === true;

  return (
    <View
      style={{ flex: 1, backgroundColor: look.sheet }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="never"
        className="flex-1"
        contentContainerStyle={{ paddingBottom: HOME_LIST_PADDING_BOTTOM }}
        contentOffset={{ x: 0, y: props.initialScrollOffset ?? 0 }}
        onScroll={(event) => props.onScrollOffset?.(event.nativeEvent.contentOffset.y)}
        scrollEventThrottle={32}
        accessibilityElementsHidden={pageOpen}
        importantForAccessibility={pageOpen ? "no-hide-descendants" : "auto"}
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

        {actionError && !pageOpen ? <ErrorBanner message={actionError} /> : null}

        <HubNodeSectionView
          model={hub.model}
          onOpen={(row) => openPage({ plane: "hub", environmentId: row.environmentId })}
        />

        <Text className="px-5 pt-[26px] pb-2 text-sm font-ryco-medium text-foreground-muted">
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
          <>
            <View className="mx-4 overflow-hidden rounded-2xl bg-card">
              {visibleRows.map((row, index) => (
                <MachineListRow
                  key={row.record.environmentId}
                  environmentId={row.record.environmentId}
                  label={row.record.label}
                  facts={factsOf(row)}
                  showDivider={index > 0}
                  onPress={() =>
                    openPage({ plane: "direct", environmentId: row.record.environmentId })
                  }
                />
              ))}
            </View>
            <Text
              style={{
                fontSize: 12.5,
                lineHeight: 17.5,
                color: look.muted,
                paddingTop: 8,
                paddingHorizontal: 20,
              }}
            >
              {MACHINES_SHEET_FOOTER}
            </Text>
          </>
        )}
      </ScrollView>

      {pageOpen && pageEnvironmentId ? (
        <Animated.View
          style={[{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }, pageStyle]}
        >
          {actionError ? <ErrorBanner message={actionError} /> : null}
          <MachineDetailPage
            environmentId={pageEnvironmentId as EnvironmentId}
            platformOs={hubPage?.platformOs}
            facts={directPage ? factsOf(directPage) : hubPage!.facts}
            canEditIcon={pageCanEditIcon}
            busy={directPage !== null && busy !== null}
            onBack={closePage}
            onAction={(action) => {
              if (directPage) runDirect(directPage, action);
              else if (hubPage) runHub(hubPage, action);
            }}
            onRename={() => {
              if (directPage) runDirect(directPage, "rename");
              else if (hubPage) runHub(hubPage, "rename");
            }}
            onIcon={() => setIconPickerOpen(true)}
            onForget={() => {
              if (directPage) forgetDirect(directPage);
            }}
            onSecurity={() => hubPage?.openSecurity?.()}
            onSettings={(route) => openSettings(pageEnvironmentId as EnvironmentId, route)}
          />
        </Animated.View>
      ) : null}

      {pageOpen && pageEnvironmentId ? (
        <DeviceIconPickerSheet
          environmentId={pageEnvironmentId as EnvironmentId}
          label={pageLabel}
          canEdit={pageCanEditIcon}
          visible={iconPickerOpen}
          onClose={() => setIconPickerOpen(false)}
        />
      ) : null}

      <RenameNodeSheet
        target={renameTarget}
        value={renameValue}
        onChange={setRenameValue}
        onClose={() => setRenameTarget(null)}
        onSave={saveRename}
      />
      {hub.renameTarget ? (
        <HubNodeRenameSheet target={hub.renameTarget} onClose={hub.closeRename} />
      ) : null}
    </View>
  );
}
