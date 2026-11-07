import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { deviceVideoStreamAvailable } from "@ryco/client-runtime/state/device";
import {
  createHostedPreviewSampler,
  type HostedPreviewSampler,
  type HostedPreviewStatus,
} from "@ryco/client-runtime/state/device/previewSampler";
import type {
  DeviceDescriptor,
  DeviceHardwareButton,
  DeviceScreenshotResult,
  DeviceUdid,
  EnvironmentId,
  ThreadId,
} from "@ryco/contracts";
import { ROTATE_LEFT } from "@ryco/shared/deviceOrientation";
import { Image } from "expo-image";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AppState,
  Pressable,
  ScrollView,
  View,
  type AppStateStatus,
  type GestureResponderEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { mobileHostedConnectionScopes } from "../../connection/hostedConnectionScopes";
import { useDeviceRpcClient } from "../../connection/useEnvironmentApi";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { parseTerminalRouteParams } from "../terminal/terminalRouteParams";
import { ThreadDetailScreen } from "../threads/ThreadDetailScreen";
import {
  useRegisterThreadWorkspaceInspector,
  useThreadWorkspaceLayout,
} from "../workspace/ThreadWorkspaceLayout";
import {
  deviceDriveAllowed,
  devicePressInput,
  devicePreviewStatusText,
  viewPointToDevicePoint,
} from "./deviceViewerModel";
import { DeviceStreamWebView } from "./stream/DeviceStreamWebView";
import { useDeviceLiveStream } from "./stream/useDeviceLiveStream";
import { useThreadDevice } from "./useThreadDevice";

type ThreadDeviceRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

/**
 * `threads/:environmentId/:threadId/device`: the simulator or emulator the thread's agent uses.
 * A phone shows it full screen; a regular-width window shows the thread with the device in the
 * workspace inspector beside it (as Files and Terminal do).
 *
 * The picture is live H.264 video with live touch wherever the connection can stream it — the
 * node's frame socket on a direct connection, the relay channel's frame tunnel on a hosted one —
 * and paced screenshots (JPEG over the relay) otherwise. The owner drives; everyone else watches.
 */
export function ThreadDeviceRouteScreen(props: ThreadDeviceRouteScreenProps) {
  const params = parseTerminalRouteParams(props.route.params);
  if (params === null) return null;
  return (
    <ResolvedThreadDeviceRoute
      key={`${params.environmentId}\u0000${params.threadId}`}
      environmentId={params.environmentId}
      threadId={params.threadId}
    />
  );
}

function ResolvedThreadDeviceRoute(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const navigation = useNavigation();
  const { inspector } = useThreadWorkspaceLayout();
  const renderInspector = useCallback(
    () => (
      <ThreadDeviceViewer
        environmentId={environmentId}
        threadId={threadId}
        onClose={() => navigation.goBack()}
        embedded
      />
    ),
    [environmentId, navigation, threadId],
  );
  useRegisterThreadWorkspaceInspector(
    "device",
    inspector.supported ? renderInspector : undefined,
    "Device",
  );
  if (inspector.supported) {
    return <ThreadDetailScreen environmentId={environmentId} threadId={threadId} />;
  }
  return (
    <ThreadDeviceViewer
      environmentId={environmentId}
      threadId={threadId}
      onClose={() => navigation.goBack()}
      embedded={false}
    />
  );
}

/** The app is in front: a backgrounded app or a locked screen streams nothing. */
function useAppActive(): boolean {
  const [state, setState] = useState<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", setState);
    return () => subscription.remove();
  }, []);
  return state === "active";
}

function deviceButtons(device: DeviceDescriptor | null): readonly DeviceHardwareButton[] {
  return device?.platform === "android-emulator" ? ["back", "home", "recents"] : ["home"];
}

const BUTTON_LABELS: Partial<Record<DeviceHardwareButton, string>> = {
  back: "Back",
  home: "Home",
  recents: "Recents",
};

export function ThreadDeviceViewer(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onClose: () => void;
  /** In the regular-width inspector: no safe-area padding of its own, no Done. */
  readonly embedded: boolean;
}) {
  const { environmentId, threadId, embedded } = props;
  const focused = useIsFocused();
  const appActive = useAppActive();
  const insets = useSafeAreaInsets();
  const { api, preview, threadState } = useThreadDevice(environmentId, threadId);
  const client = useDeviceRpcClient(environmentId);
  const environment = useHomeEnvironments().find((row) => row.environmentId === environmentId);
  const canDrive = deviceDriveAllowed(environment);

  // Several booted devices: the picker chooses which one to watch (the agent's by default).
  const bootedDevices = (threadState?.devices ?? []).filter((device) => device.state === "booted");
  const [selectedUdid, setSelectedUdid] = useState<DeviceUdid | null>(null);
  const device =
    bootedDevices.find((entry) => entry.udid === selectedUdid) ??
    preview?.device ??
    bootedDevices.find((entry) => entry.udid === preview?.udid) ??
    null;
  const udid = device?.udid ?? preview?.udid ?? null;

  const [inputError, setInputError] = useState<string | null>(null);
  const [controlsShown, setControlsShown] = useState(true);
  const [videoFailed, setVideoFailed] = useState(false);
  const onInputError = useCallback((message: string) => setInputError(message), []);

  // Thread work, demanded like the thread itself while this screen is up.
  useEffect(
    () => mobileHostedConnectionScopes.retain(environmentId, { type: "thread-detail", threadId }),
    [environmentId, threadId],
  );
  useEffect(() => setVideoFailed(false), [udid]);

  const video =
    !videoFailed && udid !== null && deviceVideoStreamAvailable(client, threadState, device);
  const live = useDeviceLiveStream({
    client: video ? client : null,
    udid: video ? udid : null,
    device,
    active: focused && appActive,
    canDrive,
    onInputError,
  });
  useEffect(() => {
    if (live.status === "unsupported") setVideoFailed(true);
  }, [live.status]);

  const press = (button: DeviceHardwareButton) => {
    if (!api || udid === null) return;
    setInputError(null);
    void api.pressButton({ udid, button }).catch((cause: unknown) => {
      setInputError(cause instanceof Error ? cause.message : "The device did not take the input.");
    });
  };
  const rotate = () => {
    if (!api?.setOrientation || udid === null || device === null) return;
    setInputError(null);
    void api
      .setOrientation({ udid, orientation: ROTATE_LEFT[device.orientation ?? "portrait"] })
      .catch((cause: unknown) => {
        setInputError(cause instanceof Error ? cause.message : "The device did not rotate.");
      });
  };

  const liveStatusText =
    live.status === "streaming" || live.status === "paused"
      ? null
      : live.status === "connecting"
        ? "Connecting…"
        : (live.error ?? (live.status === "recovering" ? "Reconnecting…" : null));
  const [screenshotStatus, setScreenshotStatus] = useState<string | null>(null);
  const statusText =
    inputError ??
    (video ? liveStatusText : screenshotStatus) ??
    (canDrive ? null : "Watching only") ??
    null;

  return (
    <View
      className="flex-1 bg-black"
      style={embedded ? undefined : { paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <View
        className="flex-1"
        accessibilityLabel={device ? `${device.name} screen` : "Device screen"}
      >
        {udid === null ? (
          <View className="flex-1 items-center justify-center">
            <Text className="text-[15px] text-white/70">No device attached to this thread</Text>
          </View>
        ) : video ? (
          <DeviceStreamWebView
            key={udid}
            background="#000000"
            onSender={live.webView.onSender}
            onMessage={live.webView.onMessage}
            onFailure={live.webView.onFailure}
          />
        ) : (
          <DeviceScreenshotView
            key={udid}
            udid={udid}
            device={device}
            screenshot={api ? (input) => api.screenshot(input) : null}
            tap={api ? (input) => api.tap(input) : null}
            swipe={api ? (input) => api.swipe(input) : null}
            active={focused}
            canDrive={canDrive}
            onStatus={setScreenshotStatus}
            onInputError={onInputError}
          />
        )}
      </View>

      {embedded ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={controlsShown ? "Hide controls" : "Show controls"}
          onPress={() => setControlsShown((shown) => !shown)}
          className="absolute left-0 right-0 items-center py-2"
          style={{ top: insets.top }}
        >
          <View className="h-1.5 w-10 rounded-full bg-white/50" />
        </Pressable>
      )}

      {controlsShown || embedded ? (
        <View
          className="absolute left-3 right-3 gap-2 rounded-2xl bg-black/60 px-3 py-2"
          style={{ bottom: (embedded ? 0 : insets.bottom) + 12 }}
        >
          {bootedDevices.length > 1 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View className="flex-row gap-1.5" accessibilityRole="tablist">
                {bootedDevices.map((entry) => {
                  const selected = entry.udid === udid;
                  return (
                    <Pressable
                      key={entry.udid}
                      accessibilityRole="tab"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`Watch ${entry.name}`}
                      onPress={() => setSelectedUdid(entry.udid)}
                      className={`rounded-full px-3 py-1 ${selected ? "bg-white/30" : "bg-white/10"}`}
                    >
                      <Text className="text-[12px] font-medium text-white" numberOfLines={1}>
                        {entry.name}
                        {entry.udid === preview?.udid ? " · agent" : ""}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          ) : null}
          <View className="flex-row items-center gap-2">
            <View className="min-w-0 flex-1">
              <Text className="text-[14px] font-semibold text-white" numberOfLines={1}>
                {device?.name ?? preview?.name ?? "Device"}
                {preview?.agentActive && udid === preview.udid ? " · agent is using it" : ""}
              </Text>
              {statusText ? (
                <Text className="text-[12px] text-white/70" numberOfLines={2}>
                  {statusText}
                </Text>
              ) : live.stats && video && __DEV__ ? (
                <Text className="text-[11px] text-white/50" numberOfLines={1}>
                  {live.stats.fps} fps
                  {live.stats.bridgeToPaintMs === null
                    ? ""
                    : ` · ${live.stats.bridgeToPaintMs} ms to paint`}
                </Text>
              ) : null}
            </View>
            {canDrive && api && udid !== null ? (
              <>
                {deviceButtons(device).map((button) => (
                  <ControlButton
                    key={button}
                    label={BUTTON_LABELS[button] ?? button}
                    accessibilityLabel={`Press ${BUTTON_LABELS[button] ?? button}`}
                    onPress={() => press(button)}
                  />
                ))}
                {device?.platform === "ios-simulator" ? (
                  <ControlButton label="Rotate" accessibilityLabel="Rotate left" onPress={rotate} />
                ) : null}
              </>
            ) : null}
            {embedded ? null : (
              <ControlButton label="Done" accessibilityLabel="Close" onPress={props.onClose} />
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function ControlButton(props: {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      onPress={props.onPress}
      className="rounded-full bg-white/15 px-3 py-1.5 active:opacity-70"
    >
      <Text className="text-[13px] font-medium text-white">{props.label}</Text>
    </Pressable>
  );
}

/**
 * The fallback picture: paced screenshots through the sampler and one-preview lease web's
 * hosted preview uses, JPEG where the node encodes it. A press becomes a tap or a swipe on
 * release.
 */
function DeviceScreenshotView(props: {
  readonly udid: DeviceUdid;
  readonly device: DeviceDescriptor | null;
  readonly screenshot:
    | ((input: { udid: DeviceUdid; format?: "png" | "jpeg" }) => Promise<DeviceScreenshotResult>)
    | null;
  readonly tap: ((input: { udid: DeviceUdid; x?: number; y?: number }) => Promise<void>) | null;
  readonly swipe:
    | ((input: {
        udid: DeviceUdid;
        fromX: number;
        fromY: number;
        toX: number;
        toY: number;
        durationMs: number;
      }) => Promise<void>)
    | null;
  readonly active: boolean;
  readonly canDrive: boolean;
  readonly onStatus: (text: string | null) => void;
  readonly onInputError: (message: string) => void;
}) {
  const { udid, device, screenshot, active, canDrive, onStatus } = props;
  const ownerId = useId();
  const [frame, setFrame] = useState<DeviceScreenshotResult | null>(null);
  const [status, setStatus] = useState<HostedPreviewStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<{ readonly width: number; readonly height: number } | null>(
    null,
  );
  const sampler = useRef<HostedPreviewSampler | null>(null);
  const activeRef = useRef(active);
  const press = useRef<{
    readonly point: ReturnType<typeof viewPointToDevicePoint>;
    readonly at: number;
  } | null>(null);

  useEffect(() => onStatus(devicePreviewStatusText(status, error)), [error, onStatus, status]);

  // The sampler outlives re-renders; it reads the newest capture function.
  const screenshotRef = useRef(screenshot);
  useEffect(() => {
    screenshotRef.current = screenshot;
  }, [screenshot]);
  const canCapture = screenshot !== null;

  useEffect(() => {
    if (!canCapture) return;
    const created = createHostedPreviewSampler({
      ownerId,
      // Frames cost data on a phone whatever the route: always paced, one preview at a time.
      hosted: true,
      screenshot: () => {
        const capture = screenshotRef.current;
        return capture
          ? capture({ udid, format: "jpeg" })
          : Promise.reject(new Error("The device preview is unavailable."));
      },
      paint: async (shot, isCurrent) => {
        if (!isCurrent()) return false;
        setFrame(shot);
        return true;
      },
      onStatus: setStatus,
      onError: setError,
      pageVisible: AppState.currentState === "active",
      panelVisible: activeRef.current,
    });
    sampler.current = created;
    const subscription = AppState.addEventListener("change", (state) =>
      created.setPageVisible(state === "active"),
    );
    return () => {
      subscription.remove();
      sampler.current = null;
      created.dispose();
    };
  }, [canCapture, ownerId, udid]);

  useEffect(() => {
    activeRef.current = active;
    sampler.current?.setPanelVisible(active);
  }, [active]);

  const pointAt = (event: GestureResponderEvent) =>
    frame === null || view === null
      ? null
      : viewPointToDevicePoint(
          device,
          {
            viewWidth: view.width,
            viewHeight: view.height,
            frameWidth: frame.width,
            frameHeight: frame.height,
          },
          event.nativeEvent.locationX,
          event.nativeEvent.locationY,
        );

  const onRelease = (event: GestureResponderEvent) => {
    const started = press.current;
    press.current = null;
    if (!started || !canDrive) return;
    const sent = devicePressInput({
      udid,
      from: started.point,
      to: pointAt(event),
      durationMs: Date.now() - started.at,
    });
    if (sent === null) return;
    const request = sent.kind === "tap" ? props.tap?.(sent.input) : props.swipe?.(sent.input);
    void request?.catch((cause: unknown) =>
      props.onInputError(
        cause instanceof Error ? cause.message : "The device did not take the input.",
      ),
    );
  };

  return (
    <View
      className="flex-1"
      onLayout={(event) => setView(event.nativeEvent.layout)}
      onStartShouldSetResponder={() => true}
      onResponderGrant={(event) => {
        sampler.current?.noteInteraction();
        press.current = { point: pointAt(event), at: Date.now() };
      }}
      onResponderRelease={onRelease}
    >
      {frame ? (
        <Image
          source={{ uri: `data:${frame.mimeType};base64,${frame.bytesBase64}` }}
          contentFit="contain"
          transition={0}
          cachePolicy="none"
          style={{ flex: 1 }}
        />
      ) : (
        <View className="flex-1 items-center justify-center">
          <Text className="text-[15px] text-white/70">Waiting for the screen…</Text>
        </View>
      )}
    </View>
  );
}
