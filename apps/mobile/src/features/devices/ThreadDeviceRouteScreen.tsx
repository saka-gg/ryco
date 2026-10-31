import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  createHostedPreviewSampler,
  type HostedPreviewSampler,
  type HostedPreviewStatus,
} from "@ryco/client-runtime/state/device/previewSampler";
import type { DeviceScreenshotResult, EnvironmentId, ThreadId } from "@ryco/contracts";
import { Image } from "expo-image";
import { useEffect, useId, useRef, useState } from "react";
import { AppState, Pressable, View, type GestureResponderEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { mobileHostedConnectionScopes } from "../../connection/hostedConnectionScopes";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { parseTerminalRouteParams } from "../terminal/terminalRouteParams";
import {
  deviceDriveAllowed,
  devicePressInput,
  devicePreviewStatusText,
  viewPointToDevicePoint,
} from "./deviceViewerModel";
import { useThreadDevice } from "./useThreadDevice";

type ThreadDeviceRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

/**
 * `threads/:environmentId/:threadId/device`: the simulator or emulator the thread's agent uses,
 * full screen. Frames are paced screenshots (the same sampler and lease web's hosted preview
 * uses); the owner can tap, swipe and press Home, everyone else watches.
 */
export function ThreadDeviceRouteScreen(props: ThreadDeviceRouteScreenProps) {
  const params = parseTerminalRouteParams(props.route.params);
  if (params === null) return null;
  return (
    <ThreadDeviceViewer
      key={`${params.environmentId}\u0000${params.threadId}`}
      environmentId={params.environmentId}
      threadId={params.threadId}
    />
  );
}

function ThreadDeviceViewer(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const navigation = useNavigation();
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { api, preview } = useThreadDevice(environmentId, threadId);
  const environment = useHomeEnvironments().find((row) => row.environmentId === environmentId);
  const canDrive = deviceDriveAllowed(environment);
  const ownerId = useId();
  const udid = preview?.udid ?? null;

  const [frame, setFrame] = useState<DeviceScreenshotResult | null>(null);
  const [status, setStatus] = useState<HostedPreviewStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [view, setView] = useState<{ readonly width: number; readonly height: number } | null>(
    null,
  );
  const [controlsShown, setControlsShown] = useState(true);
  const sampler = useRef<HostedPreviewSampler | null>(null);
  // Read when a sampler is created, so a new one starts with the screen's current focus.
  const focusedRef = useRef(focused);
  const press = useRef<{
    readonly point: ReturnType<typeof viewPointToDevicePoint>;
    readonly at: number;
  } | null>(null);

  // Thread work, demanded like the thread itself while this screen is up.
  useEffect(
    () => mobileHostedConnectionScopes.retain(environmentId, { type: "thread-detail", threadId }),
    [environmentId, threadId],
  );

  useEffect(() => {
    if (!api || udid === null) return;
    const created = createHostedPreviewSampler({
      ownerId,
      // Frames cost data on a phone whatever the route: always paced, one preview at a time.
      hosted: true,
      screenshot: () => api.screenshot({ udid }),
      paint: async (shot, isCurrent) => {
        if (!isCurrent()) return false;
        setFrame(shot);
        return true;
      },
      onStatus: setStatus,
      onError: setError,
      pageVisible: AppState.currentState === "active",
      panelVisible: focusedRef.current,
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
  }, [api, ownerId, udid]);

  useEffect(() => {
    focusedRef.current = focused;
    sampler.current?.setPanelVisible(focused);
  }, [focused]);

  const pointAt = (event: GestureResponderEvent) =>
    frame === null || view === null || preview === null
      ? null
      : viewPointToDevicePoint(
          preview.device,
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
    if (!started || !api || udid === null || !canDrive) return;
    const sent = devicePressInput({
      udid,
      from: started.point,
      to: pointAt(event),
      durationMs: Date.now() - started.at,
    });
    if (sent === null) return;
    setInputError(null);
    const request = sent.kind === "tap" ? api.tap(sent.input) : api.swipe(sent.input);
    void request.catch((cause: unknown) =>
      setInputError(cause instanceof Error ? cause.message : "The device did not take the input."),
    );
  };

  const statusText =
    inputError ?? devicePreviewStatusText(status, error) ?? (canDrive ? null : "Watching only");

  return (
    <View
      className="flex-1 bg-black"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <View
        className="flex-1"
        onLayout={(event) => setView(event.nativeEvent.layout)}
        onStartShouldSetResponder={() => true}
        onResponderGrant={(event) => {
          sampler.current?.noteInteraction();
          press.current = { point: pointAt(event), at: Date.now() };
        }}
        onResponderRelease={onRelease}
        accessibilityLabel={preview ? `${preview.name} screen` : "Device screen"}
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
            <Text className="text-[15px] text-white/70">
              {preview === null ? "No device attached to this thread" : "Waiting for the screen…"}
            </Text>
          </View>
        )}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={controlsShown ? "Hide controls" : "Show controls"}
        onPress={() => setControlsShown((shown) => !shown)}
        className="absolute left-0 right-0 items-center py-2"
        style={{ top: insets.top }}
      >
        <View className="h-1.5 w-10 rounded-full bg-white/50" />
      </Pressable>

      {controlsShown ? (
        <View
          className="absolute left-3 right-3 flex-row items-center gap-2 rounded-2xl bg-black/60 px-3 py-2"
          style={{ bottom: insets.bottom + 12 }}
        >
          <View className="min-w-0 flex-1">
            <Text className="text-[14px] font-semibold text-white" numberOfLines={1}>
              {preview?.name ?? "Device"}
              {preview?.agentActive ? " · agent is using it" : ""}
            </Text>
            {statusText ? (
              <Text className="text-[12px] text-white/70" numberOfLines={2}>
                {statusText}
              </Text>
            ) : null}
          </View>
          {canDrive && api && udid !== null ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Press Home"
              onPress={() => {
                sampler.current?.noteInteraction();
                void api.pressButton({ udid, button: "home" }).catch((cause: unknown) => {
                  setInputError(
                    cause instanceof Error ? cause.message : "The device did not take the input.",
                  );
                });
              }}
              className="rounded-full bg-white/15 px-3 py-1.5 active:opacity-70"
            >
              <Text className="text-[13px] font-medium text-white">Home</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={() => navigation.goBack()}
            className="rounded-full bg-white/15 px-3 py-1.5 active:opacity-70"
          >
            <Text className="text-[13px] font-medium text-white">Done</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
