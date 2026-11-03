import type { EnvironmentId, ServerConfig } from "@ryco/contracts";
import { isProviderDefinitelyUnusable } from "@ryco/shared/providerCapabilities";
import { MonitorIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useEnvironmentServerConfigSelector } from "../../hooks/useChatsAvailability";
import { cn } from "../../lib/utils";
import { useUpdateEverythingPlan } from "../../updates/useUpdateEverything";
import { DeviceIcon } from "../DeviceIcon";
import { relativeTime } from "../hostedHub/HostedNodeDisplay.logic";
import { AddDeviceCard } from "./AddDeviceEntry";
import {
  readSettingsDeviceVersion,
  SETTINGS_DEVICE_KIND_LABELS,
  settingsDeviceStatusLine,
  type SettingsDeviceVersion,
  type SettingsNodeStatus,
} from "./settingsDevices.logic";
import { SETTINGS_CARD_RADIUS_CLASS, SettingsCard, SettingsEmpty } from "./settingsLayout";
import type { SettingsDeviceChoice } from "./useSettingsDevices";

const STATUS_DOT_CLASS: Record<"online" | SettingsNodeStatus, string> = {
  online: "bg-success",
  connecting: "bg-warning",
  offline: "bg-muted-foreground/50",
};

export function DeviceStatusDot({ status }: { readonly status: SettingsNodeStatus | null }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT_CLASS[status ?? "online"])}
    />
  );
}

/** Providers set up on a device: enabled, available, installed and signed in as far as known. */
const selectProvidersSetUp = (config: ServerConfig | null): number | null =>
  config === null
    ? null
    : config.providers.filter((provider) => !isProviderDefinitelyUnusable(provider)).length;

/**
 * What this app already knows about a device, for its card and its Overview:
 * how Ryco is installed there and its version (the Updates plan), and how many
 * providers it has set up (its last config). No request of its own; a fact
 * nothing has reported is null.
 */
export interface SettingsDeviceFacts {
  readonly installationLabel: string | null;
  readonly version: SettingsDeviceVersion | null;
  readonly providers: number | null;
}

export function useSettingsDeviceFacts(environmentId: EnvironmentId | null): SettingsDeviceFacts {
  const plan = useUpdateEverythingPlan();
  const providers = useEnvironmentServerConfigSelector(environmentId, selectProvidersSetUp);
  const device = plan.devices.find((entry) => entry.environmentId === environmentId);
  return {
    installationLabel: device?.installationLabel ?? null,
    version: readSettingsDeviceVersion(device?.node),
    providers,
  };
}

/** "This computer · Desktop app": how this app reaches the device, and how Ryco runs there. */
export function settingsDeviceRoleLine(
  device: Pick<SettingsDeviceChoice, "kind">,
  installationLabel: string | null,
): string {
  const kind = SETTINGS_DEVICE_KIND_LABELS[device.kind];
  // "This app" repeats "This computer"; the plan says it for the desktop app's own backend.
  return installationLabel && installationLabel !== "This app"
    ? `${kind} · ${installationLabel}`
    : kind;
}

/** "Online", or "Offline · Last seen 2 h ago". */
export function settingsDeviceStatusText(
  device: Pick<SettingsDeviceChoice, "status" | "lastSeenAt"> | null,
  nowMs: number,
): string {
  if (!device) return settingsDeviceStatusLine(null, null);
  const lastSeen =
    device.status === "offline" && device.lastSeenAt !== null
      ? `Last seen ${relativeTime(device.lastSeenAt, nowMs)}`
      : null;
  return settingsDeviceStatusLine(device.status, lastSeen);
}

function VersionText({ version }: { readonly version: SettingsDeviceVersion }) {
  return (
    <>
      {version.version ? `v${version.version}` : "Version unknown"}
      {version.updateTo ? (
        <>
          {" · "}
          <span className="text-info">update ready</span>
        </>
      ) : null}
    </>
  );
}

const DEVICE_CARD_CLASS = cn(
  "flex min-h-32 min-w-0 flex-col gap-3 border border-border/70 bg-card p-3.5 text-left text-card-foreground shadow-xs/5 outline-hidden transition-colors dark:border-border/60",
  SETTINGS_CARD_RADIUS_CLASS,
);

function DeviceCard({
  device,
  primary,
  nowMs,
  onOpen,
}: {
  readonly device: SettingsDeviceChoice;
  readonly primary: boolean;
  readonly nowMs: number;
  readonly onOpen: (environmentId: EnvironmentId) => void;
}) {
  const facts = useSettingsDeviceFacts(device.environmentId);
  const statusLine = settingsDeviceStatusText(device, nowMs);
  return (
    <button
      type="button"
      disabled={device.disabled}
      data-device-card={device.label}
      onClick={() => onOpen(device.environmentId)}
      className={cn(
        DEVICE_CARD_CLASS,
        "hover:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:hover:border-border/70",
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[min(var(--radius-lg),0.625rem)] bg-muted text-muted-foreground">
          <DeviceIcon
            environmentId={device.environmentId}
            label={device.label}
            className="size-4"
          />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-semibold text-foreground">
            {device.label}
            {primary ? <span className="sr-only"> (this computer)</span> : null}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {settingsDeviceRoleLine(device, facts.installationLabel)}
          </span>
        </span>
      </span>
      <span className="flex flex-col gap-0.5 text-xs leading-relaxed text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <DeviceStatusDot status={device.status} />
          {statusLine}
        </span>
        {facts.version ? (
          <span>
            <VersionText version={facts.version} />
          </span>
        ) : null}
        {facts.providers !== null ? (
          <span>{facts.providers === 1 ? "1 provider" : `${facts.providers} providers`}</span>
        ) : null}
      </span>
    </button>
  );
}

/** All devices: one card per device the nav lists, opening its page, and "Add a device". */
export function SettingsDeviceCards({
  devices,
  primaryEnvironmentId,
  nowMs,
  onOpen,
}: {
  readonly devices: ReadonlyArray<SettingsDeviceChoice>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly nowMs: number;
  readonly onOpen: (environmentId: EnvironmentId) => void;
}) {
  const addCard = (
    <AddDeviceCard
      className={cn(
        DEVICE_CARD_CLASS,
        "items-center justify-center gap-1 border-dashed bg-transparent text-muted-foreground shadow-none hover:border-ring/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
      )}
    />
  );
  if (devices.length === 0) {
    return (
      <div className="flex flex-col gap-2.5">
        <SettingsCard>
          <SettingsEmpty
            icon={<MonitorIcon />}
            title="No devices yet"
            description="Devices this app connects to show up here."
          />
        </SettingsCard>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2.5">
          {addCard}
        </div>
      </div>
    );
  }
  return (
    <div
      role="list"
      aria-label="Devices"
      className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2.5"
    >
      {devices.map((device) => (
        <div key={device.environmentId} role="listitem" className="flex min-w-0 flex-col">
          <DeviceCard
            device={device}
            primary={device.environmentId === primaryEnvironmentId}
            nowMs={nowMs}
            onOpen={onOpen}
          />
        </div>
      ))}
      {addCard}
    </div>
  );
}

function FactTile({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className={cn(DEVICE_CARD_CLASS, "min-h-0 gap-1 p-3")}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-[13px] font-semibold text-foreground">{children}</span>
    </div>
  );
}

/** A device page's Overview facts: version and update, providers, how Ryco runs there. */
export function SettingsDeviceFactTiles({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const facts = useSettingsDeviceFacts(environmentId);
  const tiles: ReactNode[] = [];
  if (facts.version) {
    tiles.push(
      <FactTile key="version" label="Version">
        <VersionText version={facts.version} />
      </FactTile>,
    );
  }
  if (facts.providers !== null) {
    tiles.push(
      <FactTile key="providers" label="Providers">
        {facts.providers} set up
      </FactTile>,
    );
  }
  if (facts.installationLabel) {
    tiles.push(
      <FactTile key="install" label="Ryco runs as">
        {facts.installationLabel}
      </FactTile>,
    );
  }
  if (tiles.length === 0) return null;
  return (
    <div
      data-testid="settings-device-facts"
      className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2.5"
    >
      {tiles}
    </div>
  );
}
