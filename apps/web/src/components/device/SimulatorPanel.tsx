// The interaction model is adapted from Synara v0.7.2 (MIT); see THIRD_PARTY_NOTICES.md.
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { useDeviceStateStore } from "@ryco/client-runtime/state/device";
import type {
  DeviceDescriptor,
  DeviceHardwareButton,
  DeviceKeyModifier,
  DeviceUdid,
  EnvironmentId,
  ThreadId,
} from "@ryco/contracts";
import {
  CameraIcon,
  CircleStopIcon,
  Disc3Icon,
  HomeIcon,
  LoaderCircleIcon,
  LockIcon,
  MonitorOffIcon,
  PowerIcon,
  RefreshCwIcon,
  SmartphoneIcon,
  UnplugIcon,
  Volume1Icon,
  Volume2Icon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { readEnvironmentConnection } from "../../environments/runtime";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  canvasPointToDevicePoint,
  deviceHidUsageForKey,
  type DevicePoint,
} from "./deviceFrameGate";
import { useDeviceVideoStream } from "./useDeviceVideoStream";
import { useDeviceScreenshotStream } from "./useDeviceScreenshotStream";

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

function modifiers(event: KeyboardEvent): DeviceKeyModifier[] {
  const result: DeviceKeyModifier[] = [];
  if (event.metaKey) result.push("command");
  if (event.shiftKey) result.push("shift");
  if (event.altKey) result.push("option");
  if (event.ctrlKey) result.push("control");
  return result;
}

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
        <p className="mt-4 text-sm font-medium">iOS Simulator needs a Mac</p>
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
          This environment runs on {availability.platform}. Connect Ryco to a macOS environment with
          Xcode to use the simulator workspace.
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
        <p className="text-sm font-medium">Set up the iOS Simulator</p>
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

  const nativeVideo = useDeviceVideoStream({
    canvasRef,
    udid: attached?.state === "booted" ? attached.udid : null,
    ...(client?.openFrameSource ? { openFrameSource: client.openFrameSource } : {}),
  });
  const hostedVideo = useDeviceScreenshotStream({
    canvasRef,
    udid: attached?.state === "booted" ? attached.udid : null,
    enabled: !client?.openFrameSource,
    screenshot: api ? (input) => api.screenshot(input) : null,
  });
  const videoStatus = client?.openFrameSource ? nativeVideo.status : hostedVideo.status;
  const videoError = client?.openFrameSource ? nativeVideo.error : hostedVideo.error;
  const dimensions = client?.openFrameSource ? nativeVideo.dimensions : hostedVideo.dimensions;

  const pressRef = useRef<{ readonly point: DevicePoint | null; readonly at: number } | null>(null);
  const pointFromEvent = useCallback(
    (event: PointerEvent<HTMLCanvasElement>): DevicePoint | null => {
      const canvas = canvasRef.current;
      if (!canvas || !dimensions) return null;
      const rect = canvas.getBoundingClientRect();
      const scale = attached?.geometry?.scale ?? (dimensions.width > 1_400 ? 2 : 3);
      return canvasPointToDevicePoint(
        {
          frameWidth: dimensions.width,
          frameHeight: dimensions.height,
          displayWidth: rect.width,
          displayHeight: rect.height,
          pointWidth: attached?.geometry?.pointWidth ?? dimensions.width / scale,
          pointHeight: attached?.geometry?.pointHeight ?? dimensions.height / scale,
        },
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
    },
    [attached?.geometry, dimensions],
  );
  const pointerDown = useCallback(
    (event: PointerEvent<HTMLCanvasElement>) => {
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      pressRef.current = { point: pointFromEvent(event), at: performance.now() };
    },
    [pointFromEvent],
  );
  const pointerUp = useCallback(
    (event: PointerEvent<HTMLCanvasElement>) => {
      const press = pressRef.current;
      pressRef.current = null;
      if (!press || !attached || !api) return;
      const to = pointFromEvent(event);
      if (!press.point || !to) return;
      const distance = Math.hypot(to.x - press.point.x, to.y - press.point.y);
      const request =
        distance <= 8
          ? api.tap({ udid: attached.udid, x: to.x, y: to.y })
          : api.swipe({
              udid: attached.udid,
              fromX: press.point.x,
              fromY: press.point.y,
              toX: to.x,
              toY: to.y,
              durationMs: Math.max(16, Math.round(performance.now() - press.at)),
            });
      void request.catch((error) =>
        toastManager.add({
          type: "error",
          title: "Simulator input failed",
          description: errorMessage(error, "The input could not be delivered."),
        }),
      );
    },
    [api, attached, pointFromEvent],
  );

  const keyEvent = useCallback(
    (event: KeyboardEvent<HTMLCanvasElement>, direction: "down" | "up") => {
      if (!attached || !api) return;
      if (event.metaKey || event.ctrlKey) return;
      const keyCode = deviceHidUsageForKey(event.key);
      if (keyCode === null) return;
      event.preventDefault();
      void api
        .keyEvent({ udid: attached.udid, keyCode, modifiers: modifiers(event), direction })
        .catch(() => undefined);
    },
    [api, attached],
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

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <SmartphoneIcon className="size-4 text-muted-foreground" />
        <select
          aria-label="Choose an iOS Simulator"
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

      {degraded.length > 0 ? (
        <div className="border-b border-amber-500/20 bg-amber-500/8 px-3 py-1.5 text-[10px] text-amber-700 dark:text-amber-300">
          Limited by this Xcode: {degraded.map((item) => item.id).join(", ")}.
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/25 p-4 sm:p-6">
        {!attached ? (
          <div className="max-w-xs text-center">
            <SmartphoneIcon className="mx-auto size-8 text-muted-foreground/60" />
            <p className="mt-4 text-sm font-medium">Choose a simulator</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Boot a device or attach one that is already running. Its screen will stay beside your
              conversation.
            </p>
          </div>
        ) : (
          <div
            className={cn(
              "relative flex max-h-full max-w-full overflow-hidden border-[7px] border-zinc-900 bg-black shadow-xl",
              attached.family === "tablet" || attached.name.toLowerCase().includes("ipad")
                ? "aspect-[4/3] w-[min(88%,52rem)] rounded-[1.8rem]"
                : "aspect-[9/19.5] h-full max-h-[min(100%,58rem)] rounded-[2.4rem]",
            )}
          >
            <canvas
              ref={canvasRef}
              tabIndex={0}
              aria-label={`${attached.name} screen`}
              className="h-full w-full touch-none object-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400"
              onPointerDown={pointerDown}
              onPointerUp={pointerUp}
              onPointerCancel={() => {
                pressRef.current = null;
              }}
              onKeyDown={(event) => keyEvent(event, "down")}
              onKeyUp={(event) => keyEvent(event, "up")}
            />
            {videoStatus !== "streaming" ? (
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
          </div>
        )}
      </div>

      <div className="flex min-h-12 shrink-0 items-center justify-center gap-0.5 border-t border-border/60 bg-card/40 px-2">
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
          disabled={!attached || recording.kind === "starting" || recording.kind === "stopping"}
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
