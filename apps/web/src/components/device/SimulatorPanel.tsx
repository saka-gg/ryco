// The interaction model is adapted from Synara v0.7.2 (MIT); see THIRD_PARTY_NOTICES.md.
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { useDeviceStateStore } from "@ryco/client-runtime/state/device";
import { useDeviceRuntime } from "./useDeviceRuntime";
import { DEVICE_WS_METHODS } from "@ryco/contracts";
import type {
  DeviceDescriptor,
  DeviceHardwareButton,
  DeviceOrientation,
  DeviceUdid,
  EnvironmentId,
  ThreadId,
} from "@ryco/contracts";
import { ROTATE_LEFT, ROTATE_RIGHT } from "@ryco/shared/deviceOrientation";
import {
  ArrowLeftIcon,
  PanelsTopLeftIcon,
  CameraIcon,
  CircleStopIcon,
  Disc3Icon,
  HomeIcon,
  LoaderCircleIcon,
  LockIcon,
  MonitorOffIcon,
  PlayIcon,
  PowerIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  RotateCwIcon,
  SmartphoneIcon,
  UnplugIcon,
  Volume1Icon,
  Volume2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isHostedHubMode } from "../../env";
import { readEnvironmentApi } from "../../environmentApi";
import { readEnvironmentConnection } from "../../environments/runtime";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { canvasPointToDevicePoint, type DevicePoint } from "./deviceFrameGate";
import { clientPointToLayoutPoint, DEVICE_ORIENTATION_ROTATION } from "./deviceTouchGeometry";
import { deviceVideoDecodingSupported, useDeviceVideoStream } from "./useDeviceVideoStream";
import { useDeviceScreenshotStream } from "./useDeviceScreenshotStream";
import { useDeviceTouchInput, type DeviceTouchFallback } from "./useDeviceTouchInput";
import { useDeviceKeyboardInput } from "./useDeviceKeyboardInput";
import { devicePointSize } from "@ryco/client-runtime/state/device/devicePoint";

import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useHostedWorkspaceState } from "../../hostedHub/hostedConnectionCoordinator";

import { SimulatorTestingDrawer } from "./SimulatorTestingDrawer";
import { DeviceScreen, deviceKindFor, RESOLUTION_SCALE } from "./DeviceFrame";

const SETUP_POLL_MS = 5_000;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function stateLabel(state: DeviceDescriptor["state"]): string {
  if (state === "booted") return "Booted";
  if (state === "booting") return "Booting";
  if (state === "shutting-down") return "Shutting down";
  return "Shut down";
}

function attachLabel(device: DeviceDescriptor, phase: string | null | undefined): string {
  if (phase === "waiting-for-display") return "Waiting for the display…";
  if (phase === "connecting") return "Connecting the live screen…";
  if (phase === "booting" || device.state === "booting") return "Starting the simulator…";
  return "Connecting…";
}

/**
 * The chassis angle for an orientation, continued from the previous angle so
 * a quarter turn animates as a quarter turn (landscape-left to upside-down is
 * -90° to -180°, not -90° back round to +180°).
 */
function useContinuousRotation(orientation: DeviceOrientation): number {
  const [rotation, setRotation] = useState(() => ({
    orientation,
    angle: DEVICE_ORIENTATION_ROTATION[orientation],
  }));
  if (rotation.orientation === orientation) return rotation.angle;
  const target = DEVICE_ORIENTATION_ROTATION[orientation];
  const delta = ((((target - rotation.angle) % 360) + 540) % 360) - 180;
  const next = { orientation, angle: rotation.angle + delta };
  // Derived from the orientation during render, not in an effect.
  setRotation(next);
  return next.angle;
}

/** Shows one toast per burst of live-input failures rather than one per event. */
const INPUT_ERROR_TOAST_INTERVAL_MS = 3_000;

function SetupState(props: {
  readonly availability: NonNullable<
    ReturnType<typeof useDeviceStateStore.getState>["environmentById"][string]
  >["availability"];
}) {
  const availability = props.availability;
  if (!availability) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Checking simulator support…</p>
      </div>
    );
  }
  if (availability.kind === "unsupported-platform") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
        <MonitorOffIcon className="size-7 text-muted-foreground" />
        <p className="mt-4 text-sm font-medium">Device emulation is unavailable</p>
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
          This environment runs on {availability.platform}. Connect Ryco to a macOS environment with
          Xcode, or a macOS, Linux or Windows environment with the Android SDK.
        </p>
      </div>
    );
  }
  if (availability.kind === "helper-unavailable") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
        <MonitorOffIcon className="size-7 text-amber-500" />
        <p className="mt-4 text-sm font-medium">Simulator helper could not start</p>
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
          {availability.message}
        </p>
      </div>
    );
  }
  if (availability.kind !== "setup-required") return null;
  const remaining = availability.steps.filter((step) => !step.done);
  if (remaining.every((step) => step.id === "build-device-helper")) return null;
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8">
      <div className="w-full max-w-md">
        <p className="text-sm font-medium">Set up simulators and emulators</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Ryco checks these steps automatically every few seconds.
        </p>
        <div className="mt-5 space-y-2">
          {availability.steps.map((step) => (
            <div key={step.id} className="flex gap-3 rounded-md border border-border/60 p-3">
              <span
                className={cn(
                  "mt-0.5 size-2 shrink-0 rounded-full",
                  step.done ? "bg-emerald-500" : "bg-amber-500",
                )}
              />
              <div className="min-w-0">
                <p className="text-xs font-medium">{step.label}</p>
                {step.detail ? (
                  <p className="mt-1 break-words font-mono text-[10px] text-muted-foreground">
                    {step.detail}
                  </p>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function SimulatorPanel(props: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}) {
  const { environmentId, threadId } = props;
  useDeviceRuntime(environmentId);
  const testingCapability = useHostedRpcCapability(DEVICE_WS_METHODS.app, environmentId);
  const hostedWorkspace = useHostedWorkspaceState();
  const testingMutationReady =
    testingCapability.allowed &&
    (!testingCapability.hosted ||
      hostedWorkspace.machines.some(
        (machine) => machine.environmentId === environmentId && machine.canMutate,
      ));
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const threadKey = useMemo(
    () =>
      environmentId && threadId ? scopedThreadKey(scopeThreadRef(environmentId, threadId)) : null,
    [environmentId, threadId],
  );
  const environmentState = useDeviceStateStore((state) =>
    environmentId ? state.environmentById[environmentId] : undefined,
  );
  const threadState = useDeviceStateStore((state) =>
    threadKey ? state.threadByKey[threadKey] : undefined,
  );
  const [busy, setBusy] = useState(false);
  const [pendingUdid, setPendingUdid] = useState<DeviceUdid | null>(null);
  const [recording, setRecording] = useState<
    | { readonly kind: "idle" }
    | { readonly kind: "starting" }
    | { readonly kind: "recording"; readonly path: string }
    | { readonly kind: "stopping" }
  >({ kind: "idle" });
  const [bootLimit, setBootLimit] = useState<{
    readonly requested: DeviceDescriptor;
    readonly candidates: readonly DeviceDescriptor[];
    readonly limit: number;
  } | null>(null);

  const api = environmentId ? readEnvironmentApi(environmentId)?.device : undefined;
  const client = environmentId
    ? readEnvironmentConnection(environmentId)?.client.device
    : undefined;
  const generation = environmentState?.generation ?? 0;
  const applySnapshot = useDeviceStateStore((state) => state.applyThreadSnapshot);
  const applyInventory = useDeviceStateStore((state) => state.applyInventory);

  const refresh = useCallback(async () => {
    if (!environmentId || !threadId || !api) return;
    const [inventory, snapshot] = await Promise.all([
      api.list({ includeShutdown: true }),
      api.getThreadState({ threadId }),
    ]);
    applyInventory(environmentId, generation, inventory.devices, inventory.availability);
    applySnapshot(environmentId, generation, snapshot);
  }, [api, applyInventory, applySnapshot, environmentId, generation, threadId]);

  const needsSetupPoll =
    environmentState?.availability?.kind === "setup-required" ||
    environmentState?.availability?.kind === "helper-unavailable";
  useEffect(() => {
    void refresh().catch(() => undefined);
    if (!needsSetupPoll) return;
    const timer = setInterval(() => void refresh().catch(() => undefined), SETUP_POLL_MS);
    return () => clearInterval(timer);
  }, [needsSetupPoll, refresh]);

  const devices = environmentState?.devices ?? threadState?.devices ?? [];
  const attached =
    devices.find((device) => device.udid === threadState?.attachedDeviceUdid) ??
    devices.find((device) => device.udid === pendingUdid) ??
    null;

  useEffect(() => {
    if (pendingUdid && threadState?.attachedDeviceUdid === pendingUdid) setPendingUdid(null);
  }, [pendingUdid, threadState?.attachedDeviceUdid]);

  const run = useCallback(async (action: () => Promise<void>, title: string) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toastManager.add({
        type: "error",
        title,
        description: errorMessage(error, "The simulator did not respond."),
      });
    } finally {
      setBusy(false);
    }
  }, []);

  const attach = useCallback(
    (device: DeviceDescriptor) => {
      if (!api || !threadId) return;
      setPendingUdid(device.udid);
      void run(async () => {
        if (device.state === "shutdown") {
          const result = await api.boot({ udid: device.udid });
          if (result.kind === "boot-limit-reached") {
            setPendingUdid(null);
            setBootLimit({ requested: device, candidates: result.rycoBooted, limit: result.limit });
            return;
          }
        }
        applySnapshot(
          environmentId!,
          generation,
          await api.attach({ threadId, udid: device.udid }),
        );
      }, "Could not open that simulator");
    },
    [api, applySnapshot, environmentId, generation, run, threadId],
  );

  const freeSlot = useCallback(
    (candidate: DeviceDescriptor) => {
      if (!bootLimit || !api || !threadId || !environmentId) return;
      const pending = bootLimit;
      setBootLimit(null);
      setPendingUdid(pending.requested.udid);
      void run(async () => {
        await api.shutdown({ udid: candidate.udid });
        const result = await api.boot({ udid: pending.requested.udid });
        if (result.kind === "boot-limit-reached") {
          setPendingUdid(null);
          setBootLimit({ ...pending, candidates: result.rycoBooted, limit: result.limit });
          return;
        }
        applySnapshot(
          environmentId,
          generation,
          await api.attach({ threadId, udid: pending.requested.udid }),
        );
      }, "Could not free a simulator slot");
    },
    [api, applySnapshot, bootLimit, environmentId, generation, run, threadId],
  );

  // Without WebCodecs (a plain-HTTP origin, an old browser) the panel samples
  // screenshots instead of streaming H.264, the way the hosted relay does.
  const useNativeVideo =
    Boolean(client?.openFrameSource) &&
    attached?.platform !== "android-emulator" &&
    deviceVideoDecodingSupported();
  const lastInputErrorAt = useRef(0);
  const onInputError = useCallback((inputError: { readonly message: string }) => {
    const now = performance.now();
    if (now - lastInputErrorAt.current < INPUT_ERROR_TOAST_INTERVAL_MS) return;
    lastInputErrorAt.current = now;
    toastManager.add({
      type: "error",
      title: "Simulator input failed",
      description: inputError.message || "The input could not be delivered.",
    });
  }, []);
  const nativeVideo = useDeviceVideoStream({
    canvasRef,
    udid: useNativeVideo && attached?.state === "booted" ? attached.udid : null,
    ...(client?.openFrameSource ? { openFrameSource: client.openFrameSource } : {}),
    onInputError,
  });
  const orientation: DeviceOrientation = attached?.orientation ?? "portrait";
  const rotationDegrees = useContinuousRotation(orientation);
  const hostedVideo = useDeviceScreenshotStream({
    canvasRef,
    udid: attached?.state === "booted" ? attached.udid : null,
    enabled: !useNativeVideo,
    hosted: isHostedHubMode(),
    screenshot: api ? (input) => api.screenshot(input) : null,
    orientation,
  });
  const videoStatus = useNativeVideo ? nativeVideo.status : hostedVideo.status;
  const videoError = useNativeVideo ? nativeVideo.error : hostedVideo.error;
  const dimensions = useNativeVideo ? nativeVideo.dimensions : hostedVideo.dimensions;
  const { noteInteraction } = hostedVideo;
  const previewPaused = videoStatus === "paused-by-other-preview" || videoStatus === "paused-idle";

  const toDevicePoint = useCallback(
    (clientX: number, clientY: number): DevicePoint | null => {
      const canvas = canvasRef.current;
      if (!canvas || !dimensions) return null;
      const local = clientPointToLayoutPoint(
        {
          rect: canvas.getBoundingClientRect(),
          layoutWidth: canvas.clientWidth,
          layoutHeight: canvas.clientHeight,
          rotationDegrees,
        },
        clientX,
        clientY,
      );
      if (!local) return null;
      return canvasPointToDevicePoint(
        {
          frameWidth: dimensions.width,
          frameHeight: dimensions.height,
          displayWidth: canvas.clientWidth,
          displayHeight: canvas.clientHeight,
          ...devicePointSize(attached, dimensions.width, dimensions.height),
        },
        local.x,
        local.y,
      );
    },
    [attached, dimensions, rotationDegrees],
  );
  const touchFallback = useMemo<DeviceTouchFallback | null>(() => {
    if (!attached || !api) return null;
    const report = (error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Simulator input failed",
        description: errorMessage(error, "The input could not be delivered."),
      });
    return {
      tap: (point) => void api.tap({ udid: attached.udid, ...point }).catch(report),
      swipe: (from, to, durationMs) =>
        void api
          .swipe({
            udid: attached.udid,
            fromX: from.x,
            fromY: from.y,
            toX: to.x,
            toY: to.y,
            durationMs,
          })
          .catch(report),
    };
  }, [api, attached]);
  const liveInput = useNativeVideo ? nativeVideo.input : null;
  const touch = useDeviceTouchInput({
    toDevicePoint,
    live: liveInput,
    fallback: touchFallback,
  });
  const keyboard = useDeviceKeyboardInput({
    api,
    attached,
    environmentId,
    threadKey,
    generation,
    live: liveInput,
    previewPaused,
    noteInteraction,
  });

  const rotate = useCallback(
    (direction: "left" | "right") => {
      if (!attached || !api?.setOrientation) return;
      const next = (direction === "left" ? ROTATE_LEFT : ROTATE_RIGHT)[orientation];
      const setOrientation = api.setOrientation;
      void run(
        () => setOrientation({ udid: attached.udid, orientation: next }),
        "Could not rotate the simulator",
      );
    },
    [api, attached, orientation, run],
  );

  const pressButton = useCallback(
    (button: DeviceHardwareButton) => {
      if (!attached || !api) return;
      void run(() => api.pressButton({ udid: attached.udid, button }), "Simulator button failed");
    },
    [api, attached, run],
  );

  const screenshot = useCallback(() => {
    if (!attached || !api) return;
    void run(async () => {
      const result = await api.screenshot({ udid: attached.udid, save: true });
      toastManager.add({
        type: "success",
        title: "Screenshot saved",
        description: result.path ?? result.name,
      });
    }, "Could not save the screenshot");
  }, [api, attached, run]);

  const toggleRecording = useCallback(() => {
    if (!attached || !api || recording.kind === "starting" || recording.kind === "stopping") return;
    if (recording.kind === "idle") {
      setRecording({ kind: "starting" });
      void api.startRecording({ udid: attached.udid }).then(
        (result) => setRecording({ kind: "recording", path: result.path }),
        (error) => {
          setRecording({ kind: "idle" });
          toastManager.add({
            type: "error",
            title: "Could not start recording",
            description: errorMessage(error, "Recording failed."),
          });
        },
      );
      return;
    }
    setRecording({ kind: "stopping" });
    void api.stopRecording({ udid: attached.udid }).then(
      (result) => {
        setRecording({ kind: "idle" });
        toastManager.add({ type: "success", title: "Recording saved", description: result.path });
      },
      (error) => {
        setRecording({ kind: "idle" });
        toastManager.add({
          type: "error",
          title: "Could not stop recording",
          description: errorMessage(error, "The recording may be incomplete."),
        });
      },
    );
  }, [api, attached, recording]);

  if (!environmentId || !threadId || !api) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
        <MonitorOffIcon className="size-7 text-muted-foreground" />
        <p className="mt-4 text-sm font-medium">Simulator unavailable</p>
        <p className="mt-1 text-xs text-muted-foreground">This thread has no device connection.</p>
      </div>
    );
  }

  const setup = <SetupState availability={environmentState?.availability ?? null} />;
  const setupBlocked =
    !environmentState?.availability ||
    environmentState.availability.kind === "unsupported-platform" ||
    environmentState.availability.kind === "helper-unavailable" ||
    (environmentState.availability.kind === "setup-required" &&
      environmentState.availability.steps.some(
        (step) => !step.done && step.id !== "build-device-helper",
      ));
  if (setupBlocked) return setup;

  const degraded =
    environmentState.availability?.kind === "degraded"
      ? environmentState.availability.capabilities.filter((capability) => !capability.ok)
      : [];
  const frameDevice =
    attached ?? devices.find((device) => device.state === "booted") ?? devices[0] ?? null;
  const deviceKind = frameDevice ? deviceKindFor(frameDevice) : "iPhone";
  const frameScale = frameDevice?.geometry?.scale ?? RESOLUTION_SCALE[deviceKind];
  const frameWidth = frameDevice?.geometry
    ? Math.round(frameDevice.geometry.pointWidth * frameScale)
    : attached
      ? dimensions?.width
      : undefined;
  const frameHeight = frameDevice?.geometry
    ? Math.round(frameDevice.geometry.pointHeight * frameScale)
    : attached
      ? dimensions?.height
      : undefined;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      onPointerDownCapture={() => noteInteraction()}
      onKeyDownCapture={keyboard.noteKeyInteraction}
    >
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <SmartphoneIcon className="size-4 text-muted-foreground" />
        <select
          aria-label="Choose a simulator or emulator"
          className="min-w-0 max-w-72 flex-1 bg-transparent text-xs font-medium outline-none"
          disabled={busy}
          value={attached?.udid ?? ""}
          onChange={(event) => {
            const device = devices.find((candidate) => candidate.udid === event.target.value);
            if (device) attach(device);
          }}
        >
          <option value="" disabled>
            Choose a simulator
          </option>
          {devices
            .toSorted(
              (a, b) =>
                Number(b.state === "booted") - Number(a.state === "booted") ||
                a.name.localeCompare(b.name),
            )
            .map((device) => (
              <option
                key={device.udid}
                value={device.udid}
                disabled={device.state === "booting" || device.state === "shutting-down"}
              >
                {device.name} — {device.runtime} · {stateLabel(device.state)}
              </option>
            ))}
        </select>
        {threadState?.agentActive ? (
          <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-500">
            Agent controlling
          </span>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh simulators"
          onClick={() => void refresh()}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>

      {threadState?.hosts
        ?.filter((host) => host.transport === "ssh" && host.status !== "available")
        .map((host) => (
          <div
            key={host.id}
            role="status"
            className="border-b border-border/60 px-3 py-2 text-xs text-muted-foreground"
          >
            {host.name}: {host.availability ?? "Checking device host…"}
          </div>
        ))}
      {attached?.host?.transport === "ssh" ? (
        <div
          role="status"
          className="border-b border-border/60 px-3 py-2 text-xs text-muted-foreground"
        >
          Simulator testing controls are unavailable on SSH hosts.
        </div>
      ) : attached?.platform === "ios-simulator" ? (
        <SimulatorTestingDrawer
          key={`${environmentId}:${threadId}:${attached.udid}:${generation}`}
          udid={attached.udid}
          disabled={
            busy ||
            environmentState?.status !== "connected" ||
            !testingMutationReady ||
            attached.state !== "booted" ||
            threadState?.attachedDeviceUdid !== attached.udid ||
            threadState?.attachPhase != null
          }
          testing={(input) => api.testing(input)}
        />
      ) : null}

      {degraded.length > 0 ? (
        <div className="border-b border-amber-500/20 bg-amber-500/8 px-3 py-1.5 text-[10px] text-amber-700 dark:text-amber-300">
          Limited by this Xcode: {degraded.map((item) => item.id).join(", ")}.
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 bg-muted/25">
        <DeviceScreen
          className="min-h-0 w-full flex-1"
          kind={deviceKind}
          pixelWidth={frameWidth}
          pixelHeight={frameHeight}
          buttonsDisabled={!attached || busy}
          rotationDegrees={rotationDegrees}
          onPressButton={pressButton}
        >
          {attached ? (
            <>
              <canvas
                ref={canvasRef}
                tabIndex={0}
                aria-label={`${attached.name} screen`}
                className="h-full w-full touch-none object-cover outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400"
                onPointerDown={touch.onPointerDown}
                onPointerMove={touch.onPointerMove}
                onPointerUp={touch.onPointerUp}
                onPointerCancel={touch.onPointerCancel}
                onLostPointerCapture={touch.onLostPointerCapture}
                onKeyDown={keyboard.onKeyDown}
                onKeyUp={keyboard.onKeyUp}
                onPaste={keyboard.onPaste}
              />
              {videoStatus === "paused-by-other-preview" || videoStatus === "paused-idle" ? (
                // Covers the frozen frame so a tap cannot land on a screen that has moved on.
                // Key presses are held back separately; see `resumingKeys`.
                <div
                  role="status"
                  className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/75 p-6 text-center text-white"
                >
                  <p className="text-xs font-medium">
                    {videoStatus === "paused-idle"
                      ? "Preview paused — click to resume"
                      : "Preview paused — another preview is active"}
                  </p>
                  <Button size="xs" variant="outline" onClick={() => noteInteraction()}>
                    <PlayIcon />
                    Resume
                  </Button>
                </div>
              ) : videoStatus !== "streaming" ? (
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-black/75 p-6 text-center text-white">
                  <LoaderCircleIcon className="size-5 animate-spin text-white/60" />
                  <p className="mt-3 text-xs font-medium">
                    {videoStatus === "unsupported"
                      ? "This browser does not support WebCodecs."
                      : videoStatus === "recovering"
                        ? "Reconnecting the live screen…"
                        : attachLabel(attached, threadState?.attachPhase)}
                  </p>
                  {videoError ? (
                    <p className="mt-2 max-w-52 text-[10px] text-white/60">{videoError}</p>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-1 px-[12%] text-center">
              <p className="text-balance text-[11px] leading-snug text-white/45">
                Choose a simulator to start streaming it here.
              </p>
            </div>
          )}
        </DeviceScreen>
      </div>

      <div className="relative z-10 flex min-h-12 shrink-0 items-center justify-center gap-0.5 bg-muted/25 px-2">
        {attached?.platform === "android-emulator" ? (
          <>
            <Control
              icon={ArrowLeftIcon}
              label="Back"
              disabled={busy}
              onClick={() => pressButton("back")}
            />
            <Control
              icon={PanelsTopLeftIcon}
              label="Recents"
              disabled={busy}
              onClick={() => pressButton("recents")}
            />
          </>
        ) : null}
        <Control
          icon={HomeIcon}
          label="Home"
          disabled={!attached || busy}
          onClick={() => pressButton("home")}
        />
        <Control
          icon={LockIcon}
          label="Lock"
          disabled={!attached || busy}
          onClick={() => pressButton("lock")}
        />
        <Control
          icon={Volume1Icon}
          label="Volume down"
          disabled={!attached || busy}
          onClick={() => pressButton("volume-down")}
        />
        <Control
          icon={Volume2Icon}
          label="Volume up"
          disabled={!attached || busy}
          onClick={() => pressButton("volume-up")}
        />
        {attached?.platform === "ios-simulator" && api.setOrientation ? (
          <>
            <Control
              icon={RotateCcwIcon}
              label="Rotate left"
              disabled={busy || attached.state !== "booted"}
              onClick={() => rotate("left")}
            />
            <Control
              icon={RotateCwIcon}
              label="Rotate right"
              disabled={busy || attached.state !== "booted"}
              onClick={() => rotate("right")}
            />
          </>
        ) : null}
        <span className="mx-1 h-5 w-px bg-border" />
        <Control
          icon={CameraIcon}
          label="Screenshot"
          disabled={!attached || busy}
          onClick={screenshot}
        />
        <Control
          icon={
            recording.kind === "recording" || recording.kind === "stopping"
              ? CircleStopIcon
              : Disc3Icon
          }
          label={recording.kind === "recording" ? "Stop recording" : "Record screen"}
          active={recording.kind !== "idle"}
          disabled={
            !attached ||
            attached.platform === "android-emulator" ||
            recording.kind === "starting" ||
            recording.kind === "stopping"
          }
          onClick={toggleRecording}
        />
        <span className="mx-1 h-5 w-px bg-border" />
        <Control
          icon={UnplugIcon}
          label="Detach"
          disabled={!attached || busy}
          onClick={() =>
            void run(
              async () => applySnapshot(environmentId, generation, await api.detach({ threadId })),
              "Could not detach the simulator",
            )
          }
        />
        <Control
          icon={PowerIcon}
          label="Shut down"
          disabled={!attached || busy}
          onClick={() => {
            if (!attached) return;
            void run(
              () => api.shutdown({ udid: attached.udid }),
              "Could not shut down the simulator",
            );
          }}
        />
      </div>

      {bootLimit ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/75 p-6 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-xl">
            <p className="text-sm font-semibold">Simulator boot limit reached</p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Ryco keeps at most {bootLimit.limit} simulators it booted running. Shut down one to
              open {bootLimit.requested.name}.
            </p>
            <div className="mt-4 space-y-2">
              {bootLimit.candidates.map((candidate) => (
                <Button
                  key={candidate.udid}
                  variant="outline"
                  className="w-full justify-between"
                  onClick={() => freeSlot(candidate)}
                >
                  <span className="truncate">Shut down {candidate.name}</span>
                  <PowerIcon className="size-3.5" />
                </Button>
              ))}
            </div>
            <Button variant="ghost" className="mt-3 w-full" onClick={() => setBootLimit(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Control(props: {
  readonly icon: typeof HomeIcon;
  readonly label: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      disabled={props.disabled}
      className={cn(props.active && "text-red-500")}
      onClick={props.onClick}
    >
      <Icon className="size-4" />
    </Button>
  );
}
