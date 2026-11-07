// The interaction model is adapted from Synara v0.7.2 (MIT); see THIRD_PARTY_NOTICES.md.
import type {
  DeviceDescriptor,
  DeviceHardwareButton,
  DeviceOrientation,
  EnvironmentId,
  ThreadDeviceAttachment,
} from "@ryco/contracts";
import { ROTATE_LEFT, ROTATE_RIGHT } from "@ryco/shared/deviceOrientation";
import { devicePointSize } from "@ryco/client-runtime/state/device/devicePoint";
import { deviceVideoStreamAvailable, useDeviceStateStore } from "@ryco/client-runtime/state/device";
import {
  ArrowLeftIcon,
  CameraIcon,
  CircleStopIcon,
  Disc3Icon,
  HomeIcon,
  LoaderCircleIcon,
  LockIcon,
  PanelsTopLeftIcon,
  PlayIcon,
  RotateCcwIcon,
  RotateCwIcon,
  Volume1Icon,
  Volume2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
import { DeviceScreen } from "./DeviceFrame";
import { Control, errorMessage } from "./deviceControls";
import { deviceFrameMetrics } from "./deviceFrameMetrics";

/*
 * One live, interactive device: the chassis with its streamed screen, touch,
 * keyboard and paste, the hardware buttons, and a control rail. The workspace
 * panel's device tabs and the floating window over the chat both render it.
 *
 * Each mounted viewer opens its own frame socket and decoder, so a device is
 * only ever mounted in one place: the panel shows a placeholder for a device
 * that floats.
 *
 * Slots keep later work out of this file: `rail` adds controls to the rail
 * (the Tools drawer's toggle, a 3D view switch), `overlay` draws over the
 * screen area, and `children` renders below the rail (a drawer).
 */

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

export interface DeviceViewerProps {
  readonly environmentId: EnvironmentId;
  /** Scopes held keys and the keyboard's focus memory to the thread. */
  readonly threadKey: string;
  readonly device: DeviceDescriptor;
  /** The thread's attachment of this device, for its startup phase. */
  readonly attachment: ThreadDeviceAttachment | null;
  /** The floating window draws a smaller device with fewer controls. */
  readonly variant: "panel" | "floating";
  /** Connection generation; a new one resets keyboard state. */
  readonly generation: number;
  /** Extra controls at the end of the rail. */
  readonly rail?: ReactNode;
  /** Drawn over the screen area. */
  readonly overlay?: ReactNode;
  /** Rendered under the rail. */
  readonly children?: ReactNode;
}

export function DeviceViewer(props: DeviceViewerProps) {
  const { device, environmentId, threadKey, generation, variant } = props;
  const floating = variant === "floating";
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState<
    | { readonly kind: "idle" }
    | { readonly kind: "starting" }
    | { readonly kind: "recording"; readonly path: string }
    | { readonly kind: "stopping" }
  >({ kind: "idle" });
  const api = readEnvironmentApi(environmentId)?.device;
  const client = readEnvironmentConnection(environmentId)?.client.device;

  const run = useCallback((action: () => Promise<void>, title: string): Promise<void> => {
    setBusy(true);
    return action()
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title,
          description: errorMessage(error, "The simulator did not respond."),
        });
      })
      .then(() => setBusy(false));
  }, []);

  // Without WebCodecs (a plain-HTTP origin, an old browser) the viewer samples
  // screenshots instead of streaming H.264, the way the hosted relay does.
  // Android streams video once its backend says scrcpy runs (`preview`); until
  // then, and on a node without it, the viewer polls screenshots as before.
  // A hosted client streams through the relay frame tunnel once the node
  // advertises it (`deviceVideoStreamAvailable`).
  // A connection that turns out unable to stream (a hosted relay channel that
  // fell back to the legacy format) falls back to screenshots for that device.
  const [videoUnavailableUdid, setVideoUnavailableUdid] = useState<string | null>(null);
  const relayFrameTunnel = useDeviceStateStore(
    (state) => state.threadByKey[threadKey]?.relayFrameTunnel,
  );
  const useNativeVideo =
    deviceVideoStreamAvailable(client, { relayFrameTunnel }, device) &&
    deviceVideoDecodingSupported() &&
    videoUnavailableUdid !== device.udid;
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
  const booted = device.state === "booted";
  const nativeVideo = useDeviceVideoStream({
    canvasRef,
    udid: useNativeVideo && booted ? device.udid : null,
    ...(client?.openFrameSource ? { openFrameSource: client.openFrameSource } : {}),
    onInputError,
  });
  useEffect(() => {
    if (nativeVideo.status === "unsupported") setVideoUnavailableUdid(device.udid);
  }, [device.udid, nativeVideo.status]);
  const orientation: DeviceOrientation = device.orientation ?? "portrait";
  const rotationDegrees = useContinuousRotation(orientation);
  const hostedVideo = useDeviceScreenshotStream({
    canvasRef,
    udid: booted ? device.udid : null,
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
          ...devicePointSize(device, dimensions.width, dimensions.height),
        },
        local.x,
        local.y,
      );
    },
    [device, dimensions, rotationDegrees],
  );
  const touchFallback = useMemo<DeviceTouchFallback | null>(() => {
    if (!api) return null;
    const report = (error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Simulator input failed",
        description: errorMessage(error, "The input could not be delivered."),
      });
    return {
      tap: (point) => void api.tap({ udid: device.udid, ...point }).catch(report),
      swipe: (from, to, durationMs) =>
        void api
          .swipe({
            udid: device.udid,
            fromX: from.x,
            fromY: from.y,
            toX: to.x,
            toY: to.y,
            durationMs,
          })
          .catch(report),
    };
  }, [api, device.udid]);
  const liveInput = useNativeVideo ? nativeVideo.input : null;
  const touch = useDeviceTouchInput({
    toDevicePoint,
    live: liveInput,
    fallback: touchFallback,
  });
  const keyboard = useDeviceKeyboardInput({
    api,
    // Typed text targets the thread's attachment: input queued for an
    // attachment that ended is dropped, and keys wait for the next one.
    attached: props.attachment ? device : null,
    environmentId,
    threadKey,
    generation,
    live: liveInput,
    previewPaused,
    noteInteraction,
  });

  const rotate = useCallback(
    (direction: "left" | "right") => {
      if (!api?.setOrientation) return;
      const next = (direction === "left" ? ROTATE_LEFT : ROTATE_RIGHT)[orientation];
      const setOrientation = api.setOrientation;
      void run(
        () => setOrientation({ udid: device.udid, orientation: next }),
        "Could not rotate the simulator",
      );
    },
    [api, device.udid, orientation, run],
  );

  const pressButton = useCallback(
    (button: DeviceHardwareButton) => {
      if (!api) return;
      void run(() => api.pressButton({ udid: device.udid, button }), "Simulator button failed");
    },
    [api, device.udid, run],
  );

  const screenshot = useCallback(() => {
    if (!api) return;
    void run(async () => {
      const result = await api.screenshot({ udid: device.udid, save: true });
      toastManager.add({
        type: "success",
        title: "Screenshot saved",
        description: result.path ?? result.name,
      });
    }, "Could not save the screenshot");
  }, [api, device.udid, run]);

  const toggleRecording = useCallback(() => {
    if (!api || recording.kind === "starting" || recording.kind === "stopping") return;
    if (recording.kind === "idle") {
      setRecording({ kind: "starting" });
      void api.startRecording({ udid: device.udid }).then(
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
    void api.stopRecording({ udid: device.udid }).then(
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
  }, [api, device.udid, recording]);

  const frame = deviceFrameMetrics(device, dimensions);
  const disabled = !api || busy || !booted;
  const iosRotation = device.platform === "ios-simulator" && api?.setOrientation !== undefined;

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      data-device-viewer={variant}
      onPointerDownCapture={() => noteInteraction()}
      onKeyDownCapture={keyboard.noteKeyInteraction}
    >
      <div className="relative flex min-h-0 flex-1">
        <DeviceScreen
          className={cn("min-h-0 w-full flex-1", floating && "p-2")}
          kind={frame.kind}
          pixelWidth={frame.pixelWidth}
          pixelHeight={frame.pixelHeight}
          buttonsDisabled={disabled}
          rotationDegrees={rotationDegrees}
          onPressButton={floating ? undefined : pressButton}
        >
          <canvas
            ref={canvasRef}
            tabIndex={0}
            aria-label={`${device.name} screen`}
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
          {previewPaused ? (
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
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-black/75 p-4 text-center text-white">
              <LoaderCircleIcon className="size-5 animate-spin text-white/60" />
              <p className="mt-3 text-xs font-medium">
                {videoStatus === "unsupported"
                  ? "This browser does not support WebCodecs."
                  : videoStatus === "recovering"
                    ? "Reconnecting the live screen…"
                    : attachLabel(device, props.attachment?.attachPhase)}
              </p>
              {videoError || props.attachment?.lastError ? (
                <p className="mt-2 max-w-52 text-[10px] text-white/60">
                  {videoError ?? props.attachment?.lastError}
                </p>
              ) : null}
            </div>
          ) : null}
        </DeviceScreen>
        {props.overlay}
      </div>

      <div
        role="toolbar"
        aria-label={`${device.name} controls`}
        className={cn(
          "relative z-10 flex shrink-0 items-center justify-center gap-0.5 px-2",
          floating ? "min-h-9" : "min-h-12 bg-muted/25",
        )}
      >
        {device.platform === "android-emulator" ? (
          <>
            <Control
              icon={ArrowLeftIcon}
              label="Back"
              compact={floating}
              disabled={disabled}
              onClick={() => pressButton("back")}
            />
            <Control
              icon={PanelsTopLeftIcon}
              label="Recents"
              compact={floating}
              disabled={disabled}
              onClick={() => pressButton("recents")}
            />
          </>
        ) : null}
        <Control
          icon={HomeIcon}
          label="Home"
          compact={floating}
          disabled={disabled}
          onClick={() => pressButton("home")}
        />
        {floating ? null : (
          <>
            <Control
              icon={LockIcon}
              label="Lock"
              disabled={disabled}
              onClick={() => pressButton("lock")}
            />
            <Control
              icon={Volume1Icon}
              label="Volume down"
              disabled={disabled}
              onClick={() => pressButton("volume-down")}
            />
            <Control
              icon={Volume2Icon}
              label="Volume up"
              disabled={disabled}
              onClick={() => pressButton("volume-up")}
            />
          </>
        )}
        {iosRotation ? (
          <>
            <Control
              icon={RotateCcwIcon}
              label="Rotate left"
              compact={floating}
              disabled={disabled}
              onClick={() => rotate("left")}
            />
            <Control
              icon={RotateCwIcon}
              label="Rotate right"
              compact={floating}
              disabled={disabled}
              onClick={() => rotate("right")}
            />
          </>
        ) : null}
        <span className="mx-1 h-5 w-px bg-border" />
        <Control
          icon={CameraIcon}
          label="Screenshot"
          compact={floating}
          disabled={disabled}
          onClick={screenshot}
        />
        {floating ? null : (
          <Control
            icon={
              recording.kind === "recording" || recording.kind === "stopping"
                ? CircleStopIcon
                : Disc3Icon
            }
            label={recording.kind === "recording" ? "Stop recording" : "Record screen"}
            active={recording.kind !== "idle"}
            disabled={
              !api ||
              !booted ||
              device.host?.transport === "ssh" ||
              recording.kind === "starting" ||
              recording.kind === "stopping"
            }
            onClick={toggleRecording}
          />
        )}
        {props.rail ? (
          <>
            <span className="mx-1 h-5 w-px bg-border" />
            {props.rail}
          </>
        ) : null}
      </div>
      {props.children}
    </div>
  );
}
