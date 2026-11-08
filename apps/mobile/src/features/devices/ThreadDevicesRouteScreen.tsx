import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  nodeDeviceSettingsGate,
  startingBannerText,
} from "@ryco/client-runtime/state/device/picker";
import type {
  DeviceDescriptor,
  DeviceStartRecordingResult,
  DeviceStopRecordingResult,
  DeviceUdid,
  EnvironmentId,
  ServerSettingsPatch,
  ThreadId,
} from "@ryco/contracts";
import { DEVICE_WS_METHODS } from "@ryco/contracts/device";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { OptionRow } from "../../components/OptionRow";
import { StatusPill } from "../../components/StatusPill";
import { updateEnvironmentServerSettings } from "../../connection/environmentApi";
import { mobileHostedConnectionScopes } from "../../connection/hostedConnectionScopes";
import { useThemeColor } from "../../lib/useThemeColor";
import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { canChangeNodeSettings } from "../settings/nodeSettingsTargets";
import { parseTerminalRouteParams } from "../terminal/terminalRouteParams";
import {
  attachedDeviceCards,
  bootAndAttachDevice,
  bootLimitText,
  deviceErrorMessage,
  deviceListSections,
  devicePlatformLines,
  deviceRecordings,
  deviceToolsTarget,
  freeSlotThenAttach,
  installAppRequest,
  launchAppRequest,
  recordingStarted,
  recordingStatusText,
  recordingStopping,
  rememberBundleId,
  threadDevicesNotice,
  type AttachedDeviceCard,
  type BootAttachOutcome,
  type DevicesNotice,
} from "./devicePickerModel";
import { deviceMethodAllowed } from "./deviceViewerModel";
import { useThreadDeviceInventory } from "./useThreadDeviceInventory";

type ThreadDevicesRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

/**
 * `threads/:environmentId/:threadId/devices`: the node's simulators and emulators for one
 * thread, presented as a sheet. Pick one to start it (when stopped) and attach it to the
 * thread, detach or shut one down, install and launch apps on the attached device, and record
 * its screen. The live picture is the Device route (`ThreadDevice`).
 *
 * Every action is the web panel's: the same boot-then-attach sequence, the same boot-limit
 * choice, the node's own owner-only rule for lifecycle, app and recording calls, and the same
 * setup gate (`@ryco/client-runtime/state/device/picker`).
 */
export function ThreadDevicesRouteScreen(props: ThreadDevicesRouteScreenProps) {
  const params = parseTerminalRouteParams(props.route.params);
  if (params === null) return null;
  return (
    <ThreadDevices
      key={`${params.environmentId}\u0000${params.threadId}`}
      environmentId={params.environmentId}
      threadId={params.threadId}
    />
  );
}

type BootLimit = Extract<BootAttachOutcome, { kind: "boot-limit" }>;

const CARD_TONES: Record<
  AttachedDeviceCard["tone"],
  { readonly pillClassName: string; readonly textClassName: string }
> = {
  running: {
    pillClassName: "bg-success-bg border border-success-border",
    textClassName: "text-success",
  },
  busy: {
    pillClassName: "bg-accent-bg border border-accent-border",
    textClassName: "text-accent-strong",
  },
  error: {
    pillClassName: "bg-danger border border-danger-border",
    textClassName: "text-danger-foreground",
  },
  stopped: { pillClassName: "bg-subtle", textClassName: "text-foreground-muted" },
};

const PLATFORM_DOT: Record<"ready" | "warn" | "off", string> = {
  ready: "bg-success",
  warn: "bg-warning",
  off: "bg-foreground-muted",
};

function deviceSymbol(device: Pick<DeviceDescriptor, "family" | "name"> | null) {
  return device !== null && (device.family === "tablet" || /ipad/i.test(device.name))
    ? "ipad"
    : "iphone";
}

function ThreadDevices(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const navigation = useNavigation();
  const iconColor = String(useThemeColor("--color-icon"));
  const inventory = useThreadDeviceInventory(environmentId, threadId);
  const { api, threadState } = inventory;
  const environment = useHomeEnvironments().find((row) => row.environmentId === environmentId);
  const config = useEnvironmentServerConfigs().get(environmentId);

  // Thread work, demanded like the thread itself while the sheet is up.
  useEffect(
    () => mobileHostedConnectionScopes.retain(environmentId, { type: "thread-detail", threadId }),
    [environmentId, threadId],
  );

  const canLifecycle = deviceMethodAllowed(environment, DEVICE_WS_METHODS.lifecycle);
  const canApps = deviceMethodAllowed(environment, DEVICE_WS_METHODS.app);
  const canRecord = deviceMethodAllowed(environment, DEVICE_WS_METHODS.recording);
  const canManage = environment !== undefined && canChangeNodeSettings(environment);

  const [setupDismissed, setSetupDismissed] = useState(false);
  const [pendingUdid, setPendingUdid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bootLimit, setBootLimit] = useState<BootLimit | null>(null);
  const [chosenUdid, setChosenUdid] = useState<DeviceUdid | null>(null);

  const devices = inventory.environmentState?.devices ?? threadState?.devices ?? [];
  const cards = attachedDeviceCards(threadState, devices);
  const target = deviceToolsTarget(cards, chosenUdid);
  const sections = deviceListSections({ devices, hosts: threadState?.hosts, threadState });
  const notice = threadDevicesNotice({
    connected: api !== undefined,
    availability: inventory.availability,
    platforms: devicePlatformLines(inventory.platforms),
    gate: nodeDeviceSettingsGate(config, setupDismissed),
    hasAttachment: cards.length > 0,
    attachedRunning: cards.some((card) => card.booted),
    canManage,
  });
  const banner = startingBannerText(
    (threadState?.startingDeviceUdids ?? []).map(
      (udid) => devices.find((device) => device.udid === udid)?.name ?? "the device",
    ),
  );

  /** One action at a time; its failure is shown above the list. */
  const run = (action: () => Promise<void>, fallback: string, udid: string | null = null) => {
    setBusy(true);
    setPendingUdid(udid);
    setError(null);
    void action()
      .catch((cause: unknown) => setError(deviceErrorMessage(cause, fallback)))
      .finally(() => {
        setBusy(false);
        setPendingUdid(null);
      });
  };

  const settle = (outcome: BootAttachOutcome) => {
    if (outcome.kind === "boot-limit") {
      setBootLimit(outcome);
      return;
    }
    setBootLimit(null);
    inventory.apply(outcome.state);
  };

  const pick = (device: DeviceDescriptor) => {
    if (!api) return;
    run(
      () => bootAndAttachDevice(api, threadId, device).then(settle),
      "Could not open that device.",
      device.udid,
    );
  };

  const freeSlot = (candidate: DeviceDescriptor) => {
    if (!api || bootLimit === null) return;
    const requested = bootLimit.requested;
    setBootLimit(null);
    run(
      () => freeSlotThenAttach(api, threadId, candidate, requested).then(settle),
      "Could not free a simulator slot.",
      requested.udid,
    );
  };

  const detach = (udid: DeviceUdid) => {
    if (!api) return;
    run(
      () => api.detach({ threadId, udid }).then(inventory.apply),
      "Could not detach the device.",
      udid,
    );
  };

  const shutdown = (udid: DeviceUdid) => {
    if (!api) return;
    run(() => api.shutdown({ udid }), "Could not shut down the device.", udid);
  };

  const writeSettings = (patch: ServerSettingsPatch, dismissSetup: boolean) => {
    run(
      () =>
        updateEnvironmentServerSettings(environmentId, patch).then(() => {
          if (dismissSetup) setSetupDismissed(true);
        }),
      "Could not change the node's settings.",
    );
  };

  const openViewer = () => navigation.navigate("ThreadDevice", { environmentId, threadId });

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      automaticallyAdjustKeyboardInsets
      className="flex-1 bg-screen"
      contentContainerStyle={{ padding: 20, gap: 20, paddingBottom: 44 }}
    >
      {error ? <ErrorBanner message={error} /> : null}
      {inventory.loadError && !error ? <ErrorBanner message={inventory.loadError} /> : null}
      {banner ? (
        <View accessibilityRole="text" className="flex-row items-center gap-2.5 px-1">
          <ActivityIndicator size="small" />
          <Text className="flex-1 text-sm text-foreground-muted">{banner}</Text>
        </View>
      ) : null}
      {threadState?.agentActive ? (
        <Text className="px-1 text-sm text-foreground-muted">The agent is using a device.</Text>
      ) : null}

      {notice ? (
        <DevicesNoticeCard
          notice={notice}
          busy={busy}
          onAction={(kind) =>
            kind === "finish-setup"
              ? writeSettings({ deviceOnboardingCompleted: true }, true)
              : writeSettings({ devicesEnabled: true }, false)
          }
        />
      ) : (
        <>
          {cards.length > 0 ? (
            <Section title="This thread">
              {cards.map((card) => (
                <AttachedCard
                  key={card.udid}
                  card={card}
                  iconColor={iconColor}
                  selected={cards.length > 1 && target?.udid === card.udid}
                  pending={pendingUdid === card.udid}
                  disabled={busy || !canLifecycle}
                  onChoose={() => setChosenUdid(card.udid)}
                  onOpen={openViewer}
                  onDetach={() => detach(card.udid)}
                  onShutdown={() => shutdown(card.udid)}
                />
              ))}
            </Section>
          ) : null}

          {target !== null && canApps && api ? (
            <AppTools
              key={target.udid}
              target={target}
              disabled={busy}
              install={(input) => api.installApp(input)}
              launch={(input) => api.launchApp(input)}
            />
          ) : null}

          {target !== null && canRecord && api ? (
            <RecordingRow
              environmentId={environmentId}
              udid={target.udid}
              name={target.name}
              start={(input) => api.startRecording(input)}
              stop={(input) => api.stopRecording(input)}
            />
          ) : null}

          {bootLimit ? (
            <View className="gap-3 rounded-2xl border border-border bg-card p-4">
              <Text className="text-base font-ryco-bold text-foreground">
                Simulator boot limit reached
              </Text>
              <Text className="text-sm leading-normal text-foreground-muted">
                {bootLimitText(bootLimit.limit, bootLimit.requested.name)}
              </Text>
              {bootLimit.candidates.map((candidate) => (
                <SheetButton
                  key={candidate.udid}
                  label={`Shut down ${candidate.name}`}
                  variant="secondary"
                  disabled={busy}
                  onPress={() => freeSlot(candidate)}
                />
              ))}
              <SheetButton label="Cancel" variant="plain" onPress={() => setBootLimit(null)} />
            </View>
          ) : null}

          {sections.length === 0 ? (
            <EmptyState
              title="No simulators or emulators"
              detail="Add a simulator in Xcode's Devices and Simulators window, or an Android virtual device in Android Studio, then refresh."
              actionLabel="Refresh"
              onAction={() => void inventory.refresh()}
            />
          ) : (
            sections.map((section, index) => (
              <Section
                key={section.key}
                title={section.label}
                onRefresh={index === 0 ? () => void inventory.refresh() : undefined}
              >
                {section.rows.map((row) => {
                  const pending = pendingUdid === row.device.udid;
                  const opens = row.action === null && row.attached && row.status === "running";
                  return (
                    <OptionRow
                      key={row.device.udid}
                      icon={
                        <SymbolView
                          name={deviceSymbol(row.device)}
                          size={22}
                          tintColor={iconColor}
                          type="monochrome"
                        />
                      }
                      label={row.device.name}
                      detail={
                        pending ? (row.action === "start" ? "Starting…" : "Attaching…") : row.detail
                      }
                      selected={row.attached}
                      disabled={busy || (row.action !== null ? !canLifecycle : !opens)}
                      onPress={() => (row.action !== null ? pick(row.device) : openViewer())}
                    />
                  );
                })}
              </Section>
            ))
          )}

          {canLifecycle ? null : (
            <Text className="px-1 text-xs leading-normal text-foreground-muted">
              Only the node's owner can start, attach or shut down devices.
            </Text>
          )}
        </>
      )}
    </ScrollView>
  );
}

function Section(props: {
  readonly title: string;
  readonly onRefresh?: (() => void) | undefined;
  readonly children: ReactNode;
}) {
  const iconColor = String(useThemeColor("--color-icon"));
  return (
    <View className="gap-2">
      <View className="flex-row items-center px-1">
        <Text className="flex-1 text-sm font-ryco-medium text-foreground-muted">{props.title}</Text>
        {props.onRefresh ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh devices"
            hitSlop={8}
            onPress={props.onRefresh}
            className="h-7 w-7 items-center justify-center rounded-full active:bg-subtle"
          >
            <SymbolView name="arrow.clockwise" size={15} tintColor={iconColor} type="monochrome" />
          </Pressable>
        ) : null}
      </View>
      {props.children}
    </View>
  );
}

function SheetButton(props: {
  readonly label: string;
  readonly variant: "primary" | "secondary" | "plain";
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const container =
    props.variant === "primary"
      ? "bg-primary"
      : props.variant === "secondary"
        ? "border border-border bg-card-alt"
        : "";
  const text = props.variant === "primary" ? "text-primary-foreground" : "text-foreground";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={`min-h-10 items-center justify-center rounded-full px-4 py-2 active:opacity-70 ${container} ${
        props.disabled ? "opacity-40" : ""
      }`}
    >
      <Text className={`text-sm font-ryco-bold ${text}`} numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
  );
}

function AttachedCard(props: {
  readonly card: AttachedDeviceCard;
  readonly iconColor: string;
  readonly selected: boolean;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly onChoose: () => void;
  readonly onOpen: () => void;
  readonly onDetach: () => void;
  readonly onShutdown: () => void;
}) {
  const { card } = props;
  const tone = CARD_TONES[card.tone];
  const detail = [card.runtime, card.source === "agent" ? "Agent's device" : null]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <Pressable
      accessibilityLabel={`${card.name}, ${card.statusLabel}`}
      accessibilityState={{ selected: props.selected }}
      onPress={props.onChoose}
      className={`gap-3 rounded-2xl border px-4 py-3 ${
        props.selected ? "border-foreground bg-card-alt" : "border-border bg-card"
      }`}
    >
      <View className="flex-row items-center gap-3">
        <SymbolView
          name={deviceSymbol({ name: card.name })}
          size={22}
          tintColor={props.iconColor}
          type="monochrome"
        />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-base font-ryco-bold text-foreground" numberOfLines={1}>
            {card.name}
          </Text>
          {detail ? (
            <Text className="text-xs font-ryco-medium text-foreground-muted" numberOfLines={1}>
              {detail}
            </Text>
          ) : null}
        </View>
        {props.pending ? (
          <ActivityIndicator size="small" />
        ) : (
          <StatusPill
            size="compact"
            label={card.statusLabel}
            pillClassName={tone.pillClassName}
            textClassName={tone.textClassName}
          />
        )}
      </View>
      {card.error ? (
        <Text className="text-xs leading-normal text-danger-foreground" numberOfLines={3}>
          {card.error}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        <SheetButton
          label="Open"
          variant="primary"
          disabled={!card.booted}
          onPress={props.onOpen}
        />
        <SheetButton
          label="Detach"
          variant="secondary"
          disabled={props.disabled}
          onPress={props.onDetach}
        />
        <SheetButton
          label="Shut down"
          variant="secondary"
          disabled={props.disabled || !card.booted}
          onPress={props.onShutdown}
        />
      </View>
    </Pressable>
  );
}

function DevicesNoticeCard(props: {
  readonly notice: DevicesNotice;
  readonly busy: boolean;
  readonly onAction: (kind: NonNullable<DevicesNotice["action"]>["kind"]) => void;
}) {
  const { notice } = props;
  if (notice.kind === "loading") {
    return (
      <View className="items-center gap-3 py-10">
        <ActivityIndicator />
        <Text className="text-sm text-foreground-muted">{notice.title}</Text>
      </View>
    );
  }
  const action = notice.action;
  return (
    <View className="gap-3 rounded-[22px] border border-border bg-card p-5">
      <Text className="font-ryco-bold text-lg text-foreground">{notice.title}</Text>
      {notice.detail ? (
        <Text className="font-sans text-sm leading-relaxed text-foreground-muted">
          {notice.detail}
        </Text>
      ) : null}
      {notice.steps.map((step) => (
        <View key={step.label} className="gap-0.5">
          <Text className="text-sm font-ryco-medium text-foreground">{step.label}</Text>
          {step.detail ? (
            <Text selectable className="font-mono text-xs text-foreground-muted">
              {step.detail}
            </Text>
          ) : null}
        </View>
      ))}
      {notice.platforms.map((line) => (
        <View key={line.platform} className="flex-row items-center gap-2">
          <View className={`h-2 w-2 rounded-full ${PLATFORM_DOT[line.tone]}`} />
          <Text className="text-sm font-ryco-medium text-foreground">{line.label}</Text>
          <Text className="min-w-0 flex-1 text-sm text-foreground-muted" numberOfLines={2}>
            {line.summary}
          </Text>
        </View>
      ))}
      {action ? (
        <View className="flex-row">
          <SheetButton
            label={action.label}
            variant="primary"
            disabled={props.busy}
            onPress={() => props.onAction(action.kind)}
          />
        </View>
      ) : notice.kind === "setup-due" || notice.kind === "off" ? (
        <Text className="text-xs text-foreground-muted">
          Only the node's owner can change these settings.
        </Text>
      ) : null}
    </View>
  );
}

function AppTools(props: {
  readonly target: AttachedDeviceCard;
  readonly disabled: boolean;
  readonly install: (input: {
    udid: DeviceUdid;
    appPath: string;
  }) => Promise<{ readonly bundleId: string }>;
  readonly launch: (input: { udid: DeviceUdid; bundleId: string }) => Promise<unknown>;
}) {
  const { target } = props;
  const placeholderColor = String(useThemeColor("--color-placeholder"));
  const textColor = String(useThemeColor("--color-foreground"));
  const [appPath, setAppPath] = useState("");
  const [bundleId, setBundleId] = useState("");
  const [recent, setRecent] = useState<readonly string[]>([]);
  const [working, setWorking] = useState<"install" | "launch" | null>(null);
  const [status, setStatus] = useState<{ readonly text: string; readonly failed: boolean } | null>(
    null,
  );
  const installRequest = installAppRequest(target.udid, target.platform, appPath);
  const launchRequest = launchAppRequest(target.udid, bundleId);
  const locked = props.disabled || working !== null;

  const install = () => {
    if (!installRequest.ok || locked) return;
    setWorking("install");
    setStatus(null);
    void props
      .install(installRequest.input)
      .then(
        (result) => {
          setRecent((current) => rememberBundleId(current, result.bundleId));
          setBundleId(result.bundleId);
          setStatus({ text: `Installed ${result.bundleId}.`, failed: false });
        },
        (cause: unknown) =>
          setStatus({ text: deviceErrorMessage(cause, "The app did not install."), failed: true }),
      )
      .finally(() => setWorking(null));
  };

  const launch = () => {
    if (!launchRequest.ok || locked) return;
    setWorking("launch");
    setStatus(null);
    void props
      .launch(launchRequest.input)
      .then(
        () => setStatus({ text: `Launched ${launchRequest.input.bundleId}.`, failed: false }),
        (cause: unknown) =>
          setStatus({ text: deviceErrorMessage(cause, "The app did not launch."), failed: true }),
      )
      .finally(() => setWorking(null));
  };

  const fieldClass =
    "min-h-12 flex-1 rounded-2xl border border-border bg-card px-4 py-3 font-mono text-sm";
  const hint =
    (installRequest.ok ? null : installRequest.reason) ??
    (launchRequest.ok ? null : launchRequest.reason);

  return (
    <Section title={`Apps on ${target.name}`}>
      <View className="flex-row items-center gap-2">
        <TextInput
          accessibilityLabel="App path on the node"
          value={appPath}
          onChangeText={setAppPath}
          editable={!locked}
          placeholder={
            target.platform === "android-emulator" ? "/path/to/app.apk" : "/path/to/App.app"
          }
          placeholderTextColor={placeholderColor}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          onSubmitEditing={install}
          className={fieldClass}
          style={{ color: textColor }}
        />
        {working === "install" ? (
          <ActivityIndicator size="small" />
        ) : (
          <SheetButton
            label="Install"
            variant="secondary"
            disabled={locked || !installRequest.ok}
            onPress={install}
          />
        )}
      </View>
      <View className="flex-row items-center gap-2">
        <TextInput
          accessibilityLabel="Bundle id to launch"
          value={bundleId}
          onChangeText={setBundleId}
          editable={!locked}
          placeholder={
            target.platform === "android-emulator" ? "com.example.app" : "com.example.App"
          }
          placeholderTextColor={placeholderColor}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          onSubmitEditing={launch}
          className={fieldClass}
          style={{ color: textColor }}
        />
        {working === "launch" ? (
          <ActivityIndicator size="small" />
        ) : (
          <SheetButton
            label="Launch"
            variant="secondary"
            disabled={locked || !launchRequest.ok}
            onPress={launch}
          />
        )}
      </View>
      {recent.length > 0 ? (
        <View className="flex-row flex-wrap gap-1.5">
          {recent.map((entry) => (
            <Pressable
              key={entry}
              accessibilityRole="button"
              accessibilityLabel={`Use ${entry}`}
              onPress={() => setBundleId(entry)}
              className="rounded-full bg-subtle px-3 py-1 active:opacity-70"
            >
              <Text className="font-mono text-xs text-foreground" numberOfLines={1}>
                {entry}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {status ? (
        <Text
          className={`px-1 text-xs leading-normal ${
            status.failed ? "text-danger-foreground" : "text-foreground-muted"
          }`}
          numberOfLines={4}
        >
          {status.text}
        </Text>
      ) : hint ? (
        <Text className="px-1 text-xs leading-normal text-foreground-muted">{hint}</Text>
      ) : null}
    </Section>
  );
}

function RecordingRow(props: {
  readonly environmentId: EnvironmentId;
  readonly udid: DeviceUdid;
  readonly name: string;
  readonly start: (input: { udid: DeviceUdid }) => Promise<DeviceStartRecordingResult>;
  readonly stop: (input: { udid: DeviceUdid }) => Promise<DeviceStopRecordingResult>;
}) {
  const key = deviceRecordings.key(props.environmentId, props.udid);
  const state = useSyncExternalStore(
    deviceRecordings.subscribe,
    () => deviceRecordings.get(key),
    () => deviceRecordings.get(key),
  );
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const recording = state.kind === "recording";
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [recording]);

  const toggle = () => {
    setError(null);
    if (state.kind === "idle") {
      deviceRecordings.set(key, { kind: "starting" });
      void props.start({ udid: props.udid }).then(
        (result) => deviceRecordings.set(key, recordingStarted(result)),
        (cause: unknown) => {
          deviceRecordings.set(key, { kind: "idle", saved: null });
          setError(deviceErrorMessage(cause, "Could not start recording."));
        },
      );
      return;
    }
    if (state.kind !== "recording") return;
    deviceRecordings.set(key, recordingStopping(state));
    void props.stop({ udid: props.udid }).then(
      (saved) => deviceRecordings.set(key, { kind: "idle", saved }),
      (cause: unknown) => {
        deviceRecordings.set(key, { kind: "idle", saved: null });
        setError(deviceErrorMessage(cause, "The recording may be incomplete."));
      },
    );
  };

  return (
    <Section title="Screen recording">
      <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3">
        <View
          className={`h-2.5 w-2.5 rounded-full ${recording ? "bg-danger-foreground" : "bg-subtle"}`}
        />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-sm font-ryco-bold text-foreground" numberOfLines={1}>
            {props.name}
          </Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={2}>
            {recordingStatusText(state, now)}
          </Text>
        </View>
        <SheetButton
          label={state.kind === "idle" ? "Record" : "Stop"}
          variant={recording ? "primary" : "secondary"}
          disabled={state.kind === "starting" || state.kind === "stopping"}
          onPress={toggle}
        />
      </View>
      {error ? <Text className="px-1 text-xs text-danger-foreground">{error}</Text> : null}
    </Section>
  );
}
