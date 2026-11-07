// The interaction model is adapted from Synara v0.7.2 (MIT); see THIRD_PARTY_NOTICES.md.
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { useDeviceStateStore } from "@ryco/client-runtime/state/device";
import { DEVICE_WS_METHODS } from "@ryco/contracts";
import type {
  DeviceAvailability,
  DeviceDescriptor,
  EnvironmentId,
  ThreadId,
} from "@ryco/contracts";
import {
  LoaderCircleIcon,
  MonitorOffIcon,
  PictureInPicture2Icon,
  PlayIcon,
  PowerIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { activeDeviceTab } from "../../deviceWorkspace/deviceTabs.logic";
import { selectThreadDeviceTabs, useDeviceTabsStore } from "../../deviceWorkspace/deviceTabsStore";
import {
  adoptableUdids,
  floatWorkspaceDevice,
  forgetReleasedDevice,
} from "../../deviceWorkspace/deviceWorkspaceActions";
import {
  floatingDeviceUdid,
  useWorkspaceMiniPlayerStore,
} from "../../deviceWorkspace/workspaceMiniPlayerStore";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useHostedWorkspaceState } from "../../hostedHub/hostedConnectionCoordinator";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { DevicePicker } from "./DevicePicker";
import { startingBannerText } from "./devicePicker.logic";
import { Control, errorMessage } from "./deviceControls";
import { DeviceViewer } from "./DeviceViewer";
import { SimulatorTestingDrawer } from "./SimulatorTestingDrawer";
import { threadAttachments } from "./threadAttachments";
import { useDeviceRuntime } from "./useDeviceRuntime";

const SETUP_POLL_MS = 5_000;

function SetupState(props: { readonly availability: DeviceAvailability | null }) {
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

function isSetupBlocked(availability: DeviceAvailability | null | undefined): boolean {
  return (
    !availability ||
    availability.kind === "unsupported-platform" ||
    availability.kind === "helper-unavailable" ||
    (availability.kind === "setup-required" &&
      availability.steps.some((step) => !step.done && step.id !== "build-device-helper"))
  );
}

/**
 * The workspace panel's device tabs: the picker, or the device the active tab
 * shows. Only the active tab is mounted, so only it streams; the others keep
 * their devices running.
 */
/*
 * Every device surface loads from this one chunk: the panel, the floating
 * window and the device tab menu. Split into chunks of their own, the icons
 * they share became a small shared group the bundler folded into chunks the
 * chat route loads at once.
 */
export { default as WorkspaceMiniPlayer } from "../../deviceWorkspace/WorkspaceMiniPlayer";
export { default as DeviceTabMenu } from "../../deviceWorkspace/DeviceTabMenu";

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
  const deviceTabs = useDeviceTabsStore((state) =>
    selectThreadDeviceTabs(state.byThreadKey, threadKey),
  );
  const floatingUdid = useWorkspaceMiniPlayerStore((state) =>
    floatingDeviceUdid(state.byThreadKey, threadKey),
  );
  const [busy, setBusy] = useState(false);
  const [pendingUdid, setPendingUdid] = useState<string | null>(null);
  const [bootLimit, setBootLimit] = useState<{
    readonly requested: DeviceDescriptor;
    readonly candidates: readonly DeviceDescriptor[];
    readonly limit: number;
  } | null>(null);

  const api = environmentId ? readEnvironmentApi(environmentId)?.device : undefined;
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
  const attachments = threadAttachments(threadState);
  const activeTab = activeDeviceTab(deviceTabs);
  const tabDevice = activeTab?.udid
    ? (devices.find((device) => device.udid === activeTab.udid) ?? null)
    : null;
  const tabAttachment = tabDevice
    ? (attachments.find((entry) => entry.udid === tabDevice.udid) ?? null)
    : null;
  const starting = useMemo(
    () => new Set(threadState?.startingDeviceUdids ?? []),
    [threadState?.startingDeviceUdids],
  );
  const openUdids = useMemo(
    () =>
      new Set(
        deviceTabs.tabs.flatMap((tab) =>
          tab.udid !== null && tab.id !== activeTab?.id ? [tab.udid] : [],
        ),
      ),
    [activeTab?.id, deviceTabs.tabs],
  );

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

  /** Boot when needed, then attach, as the user's choice. */
  const bootAndAttach = useCallback(
    async (device: DeviceDescriptor): Promise<boolean> => {
      if (!api || !threadId || !environmentId) return false;
      if (device.state === "shutdown") {
        const result = await api.boot({ udid: device.udid, threadId });
        if (result.kind === "boot-limit-reached") {
          setBootLimit({ requested: device, candidates: result.rycoBooted, limit: result.limit });
          return false;
        }
      }
      applySnapshot(environmentId, generation, await api.attach({ threadId, udid: device.udid }));
      return true;
    },
    [api, applySnapshot, environmentId, generation, threadId],
  );

  const open = (device: DeviceDescriptor) => {
    if (!threadKey) return;
    // The tab the choice was made in, even if another comes forward meanwhile.
    const tabId =
      activeDeviceTab(selectThreadDeviceTabs(useDeviceTabsStore.getState().byThreadKey, threadKey))
        ?.id ?? null;
    setPendingUdid(device.udid);
    void run(async () => {
      try {
        if (!(await bootAndAttach(device))) return;
        forgetReleasedDevice(threadKey, device.udid);
        const store = useDeviceTabsStore.getState();
        if (tabId === null) store.openDevice(threadKey, device.udid);
        else store.chooseDevice(threadKey, tabId, device.udid);
      } finally {
        setPendingUdid(null);
      }
    }, "Could not open that device");
  };

  const freeSlot = (candidate: DeviceDescriptor) => {
    if (!bootLimit || !api) return;
    const pending = bootLimit;
    setBootLimit(null);
    void run(async () => {
      await api.shutdown({ udid: candidate.udid });
      open(pending.requested);
    }, "Could not free a simulator slot");
  };

  // A thread with no device tabs yet adopts the devices a person attached to it
  // (a client from before device tabs, another client of the same thread), so
  // opening the panel shows them instead of the picker. An agent's devices
  // arrive as their own requests; closing a tab detaches it, so a closed tab
  // never comes back this way.
  const adoptUdids =
    deviceTabs.tabs.length === 0 && threadKey ? adoptableUdids(threadKey, attachments) : [];
  const adoptKey = adoptUdids.join("\n");
  useEffect(() => {
    if (!threadKey || adoptKey === "") return;
    const store = useDeviceTabsStore.getState();
    for (const udid of adoptKey.split("\n")) store.openDevice(threadKey, udid);
  }, [adoptKey, threadKey]);

  // A tab restored after a reload, or one whose attachment ended (a server
  // restart, another client's detach), attaches again while it is in view. An
  // agent's device a person watches in a tab becomes theirs, which keeps it
  // running while the tab is open.
  const needsAttach =
    tabDevice !== null &&
    tabDevice.state === "booted" &&
    (tabAttachment === null || tabAttachment.source === "agent") &&
    floatingUdid !== tabDevice.udid &&
    environmentState?.status === "connected";
  const attachUdid = needsAttach ? tabDevice.udid : null;
  useEffect(() => {
    if (!attachUdid || !api || !threadId || !environmentId) return;
    void api
      .attach({ threadId, udid: attachUdid })
      .then((state) => applySnapshot(environmentId, generation, state))
      .catch(() => undefined);
  }, [api, applySnapshot, attachUdid, environmentId, generation, threadId]);

  if (!environmentId || !threadId || !api || !threadKey) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
        <MonitorOffIcon className="size-7 text-muted-foreground" />
        <p className="mt-4 text-sm font-medium">Simulator unavailable</p>
        <p className="mt-1 text-xs text-muted-foreground">This thread has no device connection.</p>
      </div>
    );
  }

  const availability = environmentState?.availability ?? null;
  // A helper that stops answering for a moment (the host probe times out while
  // a simulator boots) must not blank a device that is already on screen.
  const transientHelperOutage =
    availability?.kind === "helper-unavailable" && tabDevice?.state === "booted";
  if (isSetupBlocked(availability) && !transientHelperOutage) {
    return <SetupState availability={availability} />;
  }

  const startingNames = (threadState?.startingDeviceUdids ?? []).map(
    (udid) => devices.find((device) => device.udid === udid)?.name ?? "the device",
  );
  const banner = startingBannerText(startingNames);
  const degraded =
    availability?.kind === "degraded"
      ? availability.capabilities.filter((capability) => !capability.ok)
      : [];

  let body;
  if (!activeTab || activeTab.udid === null) {
    body = (
      <DevicePicker
        devices={devices}
        hosts={threadState?.hosts}
        starting={starting}
        openUdids={openUdids}
        pendingUdid={pendingUdid}
        disabled={busy}
        onOpen={open}
        onRefresh={() => void refresh().catch(() => undefined)}
      />
    );
  } else if (!tabDevice) {
    body = (
      <PanelMessage
        title="This device is no longer available"
        detail="It may have been deleted, or its device host disconnected."
      />
    );
  } else if (floatingUdid === tabDevice.udid) {
    body = (
      <PanelMessage
        title={`${tabDevice.name} is floating over the chat`}
        detail="It streams in one place at a time."
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => useWorkspaceMiniPlayerStore.getState().close(threadKey)}
          >
            Show it here
          </Button>
        }
      />
    );
  } else if (tabDevice.state === "shutdown" && pendingUdid !== tabDevice.udid) {
    body = (
      <PanelMessage
        title={`${tabDevice.name} is stopped`}
        detail={tabDevice.runtime}
        action={
          <Button size="sm" disabled={busy} onClick={() => open(tabDevice)}>
            <PlayIcon />
            Start
          </Button>
        }
      />
    );
  } else {
    const thread = { environmentId, threadId };
    body = (
      <>
        {tabDevice.host?.transport === "ssh" ? (
          <div
            role="status"
            className="border-b border-border/60 px-3 py-2 text-xs text-muted-foreground"
          >
            Simulator testing controls are unavailable on SSH hosts.
          </div>
        ) : tabDevice.platform === "ios-simulator" ? (
          <SimulatorTestingDrawer
            key={`${threadKey}:${tabDevice.udid}:${generation}`}
            udid={tabDevice.udid}
            disabled={
              busy ||
              environmentState?.status !== "connected" ||
              !testingMutationReady ||
              tabDevice.state !== "booted" ||
              tabAttachment === null ||
              tabAttachment.attachPhase !== null
            }
            testing={(input) => api.testing(input)}
          />
        ) : null}
        <DeviceViewer
          key={tabDevice.udid}
          environmentId={environmentId}
          threadKey={threadKey}
          device={tabDevice}
          attachment={tabAttachment}
          variant="panel"
          generation={generation}
          rail={
            <>
              <Control
                icon={PictureInPicture2Icon}
                label="Float device over chat"
                onClick={() => floatWorkspaceDevice(thread, tabDevice.udid)}
              />
              <Control
                icon={PowerIcon}
                label="Shut down"
                disabled={busy || tabDevice.state !== "booted"}
                onClick={() =>
                  void run(
                    () => api.shutdown({ udid: tabDevice.udid }),
                    "Could not shut down the simulator",
                  )
                }
              />
            </>
          }
        />
      </>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-background">
      {banner ? (
        <div
          role="status"
          className="flex items-center gap-2 border-b border-sky-500/20 bg-sky-500/8 px-3 py-1.5 text-xs text-sky-700 dark:text-sky-300"
        >
          <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
          <span className="min-w-0 truncate">{banner}</span>
        </div>
      ) : null}
      {threadState?.agentActive ? (
        <div className="flex items-center border-b border-border/60 px-3 py-1">
          <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-500">
            Agent controlling
          </span>
        </div>
      ) : null}
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
      {transientHelperOutage && availability?.kind === "helper-unavailable" ? (
        <div
          role="status"
          className="border-b border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground"
        >
          {availability.message}
        </div>
      ) : null}
      {degraded.length > 0 ? (
        <div className="border-b border-amber-500/20 bg-amber-500/8 px-3 py-1.5 text-[10px] text-amber-700 dark:text-amber-300">
          Limited by this Xcode: {degraded.map((item) => item.id).join(", ")}.
        </div>
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col bg-muted/25">{body}</div>

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

function PanelMessage(props: {
  readonly title: string;
  readonly detail?: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 p-8 text-center">
      <p className="text-sm font-medium">{props.title}</p>
      {props.detail ? <p className="text-xs text-muted-foreground">{props.detail}</p> : null}
      {props.action ? <div className="mt-3">{props.action}</div> : null}
    </div>
  );
}
