// The grouped Start/Open list follows t3code's device panel (pingdotgg/t3code, MIT); see
// THIRD_PARTY_NOTICES.md.
import type { DeviceDescriptor, DeviceHostSummary } from "@ryco/contracts";
import { LoaderCircleIcon, RefreshCwIcon, SmartphoneIcon, TabletIcon } from "lucide-react";
import { useMemo } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { deviceKindFor } from "./DeviceFrame";
import {
  devicePickerStatus,
  groupPickerDevices,
  type DevicePickerStatus,
} from "./devicePicker.logic";

const STATUS_LABEL: Record<DevicePickerStatus, string> = {
  running: "Running",
  starting: "Starting",
  stopping: "Shutting down",
  stopped: "Stopped",
};

/**
 * Every device the node can run, grouped per platform (and per host once SSH
 * hosts exist), each with what it is doing and the one action that opens it:
 * Open for a running device, Start for a stopped one.
 */
export function DevicePicker(props: {
  readonly devices: readonly DeviceDescriptor[];
  readonly hosts?: readonly DeviceHostSummary[] | undefined;
  /** Devices booting for this thread, whoever started them. */
  readonly starting: ReadonlySet<string>;
  /** Devices other tabs of this thread already show. */
  readonly openUdids: ReadonlySet<string>;
  /** The device whose Start or Open is in flight. */
  readonly pendingUdid: string | null;
  readonly disabled: boolean;
  readonly onOpen: (device: DeviceDescriptor) => void;
  readonly onRefresh: () => void;
}) {
  const groups = useMemo(
    () => groupPickerDevices(props.devices, { hosts: props.hosts, starting: props.starting }),
    [props.devices, props.hosts, props.starting],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-slot="device-picker">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <p className="min-w-0 flex-1 truncate text-xs font-medium">Choose a device</p>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh devices"
          title="Refresh devices"
          onClick={props.onRefresh}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      {groups.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
          <SmartphoneIcon className="size-6 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">No simulators or emulators</p>
          <p className="mt-1 max-w-xs text-xs text-muted-foreground">
            Add a simulator in Xcode&apos;s Devices and Simulators window, or an Android virtual
            device in Android Studio, then refresh.
          </p>
        </div>
      ) : (
        <div className="space-y-4 p-3">
          {groups.map((group) => (
            <section key={group.key} aria-label={group.label}>
              <h3 className="px-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
                {group.label}
              </h3>
              <ul className="overflow-hidden rounded-lg border border-border/60">
                {group.devices.map((device) => {
                  const status = devicePickerStatus(device, props.starting);
                  const pending = props.pendingUdid === device.udid;
                  const Icon = deviceKindFor(device) === "iPad" ? TabletIcon : SmartphoneIcon;
                  const action = status === "stopped" ? "Start" : "Open";
                  return (
                    <li
                      key={device.udid}
                      className="flex items-center gap-3 border-b border-border/50 px-3 py-2 last:border-b-0"
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium">{device.name}</p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {device.runtime}
                          <span aria-hidden> · </span>
                          <span
                            className={cn(
                              status === "running" && "text-emerald-600 dark:text-emerald-400",
                              status === "starting" && "text-sky-600 dark:text-sky-400",
                            )}
                          >
                            {STATUS_LABEL[status]}
                          </span>
                          {props.openUdids.has(device.udid) ? (
                            <>
                              <span aria-hidden> · </span>
                              Open in another tab
                            </>
                          ) : null}
                        </p>
                      </div>
                      <Button
                        size="xs"
                        variant={status === "running" ? "default" : "outline"}
                        aria-label={`${action} ${device.name}`}
                        disabled={props.disabled || pending || status === "stopping"}
                        onClick={() => props.onOpen(device)}
                      >
                        {pending || status === "starting" ? (
                          <LoaderCircleIcon className="animate-spin" />
                        ) : null}
                        {action}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
